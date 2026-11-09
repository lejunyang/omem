import type { App } from "./app.ts";
import { baseOf, categoryStatus, defaultFor, keyOf } from "./ai-keys.ts";
import { all, one, run } from "./db.ts";
import { accessibleSpaces, OWNER } from "./users.ts";
import { HttpError, json, newId, now } from "./util.ts";

/**
 * Voice (settings → AI → 语音, docs/v2/ai-models.md): the browser talks to OpenAI over WebRTC;
 * omem gives it the session and runs the tools it asks for. Two APIs, one shape for the page:
 *
 * - Realtime (`gpt-realtime-*`): one speech model that calls tools itself. omem mints a short-lived
 *   client secret (`POST /realtime/client_secrets`, with the whole session config), the browser posts
 *   its SDP to `/realtime/calls` with it. Tool calls come as `response.function_call_arguments.done`.
 * - GPT-Live (`gpt-live-1`): a full-duplex voice layer that hands reasoning and tools to a Responses
 *   model (`delegation`). There is no client secret: the browser gives omem its SDP and omem opens the
 *   session (`POST /live/sessions`, transport webrtc) with the key. Tool calls come wrapped in
 *   `response.event`.
 *
 * Either way the tools are omem's read tools (search, read_source…), run here in the user's scope.
 * Speech to text for the input box is a plain `/audio/transcriptions` call.
 */
export type VoicePurpose = "chat" | "practice";

/** What a voice conversation may look up: reading only, in the spaces the user can read. */
export const VOICE_TOOLS = ["list_spaces", "search", "read_source", "recall", "list_items", "read_page"];

type Fetch = typeof fetch;
let fetcher: Fetch = (...a) => fetch(...a);
export function setVoiceFetchForTests(f: Fetch | null) {
  fetcher = f ?? ((...a) => fetch(...a));
}

function provider(app: App) {
  const st = categoryStatus(app.config, "voice", app.home);
  if (!st.ready) throw new HttpError(409, `语音模型不可用：${st.detail}（设置 → AI → 语音）`);
  const p = app.config.ai.providers.find((x) => x.id === st.provider)!;
  return { base: baseOf(p), key: keyOf(p.id, app.home), model: st.model!, api: app.config.ai.voice.api, voice: app.config.ai.voice.voice || "marin" };
}

export function voiceStatus(app: App) {
  const st = categoryStatus(app.config, "voice", app.home);
  return { ready: st.ready, detail: st.detail, api: app.config.ai.voice.api, model: st.model ?? null };
}

/**
 * What the voice model is told. Kept short: it speaks, it is not an agent. Practice: a scene partner
 * who stays in English, helps in the learner's language when asked, and leaves the assessment to the
 * review after the call (the speaking-coach role with the speaking-assessment skill).
 */
export function voiceInstructions(purpose: VoicePurpose, scenario = "") {
  if (purpose === "practice") {
    return [
      "You are an English conversation partner for a Chinese-speaking learner practising speaking.",
      scenario ? `Scene: ${scenario}. Play the other person in this scene naturally and keep it going; start by greeting the learner in character.` : "Have a natural conversation on a topic the learner picks; start by asking what they want to talk about.",
      "Speak natural, everyday English at the learner's level; keep each turn short so they speak more than you.",
      "If the learner asks in Chinese (or another language) how to say something or what a word means, answer briefly in that language, give the English, then return to the scene in English.",
      "Do not correct every mistake while talking. Only if a mistake blocks understanding, rephrase it naturally (\"Oh, you mean …?\") and go on. A detailed assessment comes after the call.",
    ].join("\n");
  }
  return [
    "你是本人的语音助理（omem）。用自然、简短的口语回答，一次说清一件事；本人用什么语言你就用什么语言。",
    "问到本人的资料、文档、事项、记忆时，先用工具查（search 找原件，read_source 读原文，recall 查记忆，list_items 查事项），再按查到的说，说出依据的文档名；查不到就直说。",
    "不要念网址、代码和长列表；要细看的内容告诉本人去网页上看。",
  ].join("\n");
}

/** omem's read tools as function tools for the voice model. */
async function functionTools() {
  const { toolSchemas } = await import("../agents/tools.ts");
  return toolSchemas(new Set(VOICE_TOOLS)).map((t) => ({ type: "function", name: t.name, description: t.description.slice(0, 1000), parameters: t.inputSchema }));
}

async function post(url: string, key: string, body: unknown, what: string) {
  const r = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `${what}失败：${r.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `${what}返回的不是 JSON：${text.slice(0, 200)}`);
  }
}

/** Realtime: a client secret carrying the whole session; the browser connects with it. */
export async function realtimeSecret(app: App, o: { purpose: VoicePurpose; scenario?: string }) {
  const p = provider(app);
  if (p.api !== "realtime") throw new HttpError(409, "语音设置的接口是 GPT-Live，不是 Realtime");
  const session = {
    type: "realtime",
    model: p.model,
    instructions: voiceInstructions(o.purpose, o.scenario),
    audio: {
      input: { transcription: { model: "gpt-live-transcribe" }, turn_detection: { type: "semantic_vad" } },
      output: { voice: p.voice },
    },
    ...(o.purpose === "chat" ? { tools: await functionTools(), tool_choice: "auto" } : {}),
  };
  const r = await post(`${p.base}/realtime/client_secrets`, p.key, { expires_after: { anchor: "created_at", seconds: 600 }, session }, "创建 Realtime 临时凭证");
  const value = r.value ?? r.client_secret?.value;
  if (!value) throw new HttpError(502, "Realtime 没有返回临时凭证");
  return { api: "realtime" as const, model: p.model, secret: String(value), expiresAt: r.expires_at ?? null, callsUrl: `${p.base}/realtime/calls` };
}

/** GPT-Live: omem opens the session with the browser's SDP offer and returns the answer. */
export async function liveConnect(app: App, o: { purpose: VoicePurpose; scenario?: string; sdp: string }) {
  const p = provider(app);
  if (p.api !== "live") throw new HttpError(409, "语音设置的接口是 Realtime，不是 GPT-Live");
  const tools = o.purpose === "chat" ? await functionTools() : [];
  const session = {
    model: p.model,
    instructions: voiceInstructions(o.purpose, o.scenario),
    audio: { output: { voice: p.voice } },
    delegation: { type: "responses", responses: { model: app.config.ai.voice.delegateModel || defaultFor(app.config, app.home, "voice.delegate"), ...(tools.length ? { tools, tool_choice: "auto" } : {}) } },
  };
  const r = await post(`${p.base}/live/sessions`, p.key, { session, transport: { type: "webrtc", sdp: o.sdp } }, "打开 GPT-Live 会话");
  const sdp = r.transport?.sdp;
  if (!sdp) throw new HttpError(502, "GPT-Live 没有返回 SDP 应答");
  return { api: "live" as const, model: p.model, sessionId: r.session?.id ?? null, sdp: String(sdp) };
}

/** Speech to text for the voice input box. */
export async function transcribe(app: App, audio: Buffer, mime: string) {
  const p = provider(app);
  const ext = /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : /mpeg|mp3/.test(mime) ? "mp3" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), `speech.${ext}`);
  form.append("model", app.config.ai.voice.transcribeModel || defaultFor(app.config, app.home, "voice.transcribe"));
  const r = await fetcher(`${p.base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${p.key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  const text = await r.text();
  if (!r.ok) throw new HttpError(502, `语音转文字失败：${r.status} ${text.slice(0, 300)}`);
  try {
    return String(JSON.parse(text).text ?? "").trim();
  } catch {
    return text.trim();
  }
}

/** A tool the voice model asked for, run as the user in the spaces they can read. */
export async function voiceTool(app: App, userId: string, spaceId: string, name: string, args: unknown) {
  if (!VOICE_TOOLS.includes(name)) return { text: `语音对话里不能用工具 ${name}`, isError: true };
  const { callTool } = await import("../agents/tools.ts");
  const spaces = accessibleSpaces(app, userId);
  const space = !spaces || spaces.includes(spaceId) ? spaceId : spaces[0];
  if (!space) return { text: "没有可读的空间", isError: true };
  return callTool({ app, runId: null, spaceId: space, spaces, tools: new Set(VOICE_TOOLS), actor: "agent", userId }, name, args);
}

// ---- conversations kept after the call -------------------------------------------------------

export type VoiceTurn = { role: "user" | "assistant"; text: string };
export type VoiceSession = { id: string; userId: string; purpose: VoicePurpose; scenario: string; api: string; model: string; transcript: VoiceTurn[]; startedAt: string; endedAt: string; reviewRunId: string | null };
type Row = { id: string; user_id: string; purpose: string; scenario: string; api: string; model: string; transcript: string; started_at: string; ended_at: string; review_run_id: string | null };
const toSession = (r: Row): VoiceSession => ({ id: r.id, userId: r.user_id, purpose: r.purpose as VoicePurpose, scenario: r.scenario, api: r.api, model: r.model, transcript: json(r.transcript, []), startedAt: r.started_at, endedAt: r.ended_at, reviewRunId: r.review_run_id });

/**
 * Keep a finished conversation. A practice with something said by the learner gets a review run
 * (speaking-review: the speaking-coach role reads the transcript and assesses the learner's level).
 */
export async function saveVoiceSession(app: App, userId: string, o: { purpose: VoicePurpose; scenario?: string; api: string; model: string; transcript: VoiceTurn[]; startedAt: string; spaceId: string }) {
  const id = newId("voice");
  const transcript = o.transcript.filter((t) => t.text.trim()).map((t) => ({ role: t.role, text: t.text.trim().slice(0, 4000) })).slice(0, 400);
  run(app.db, "insert into voice_sessions(id, user_id, purpose, scenario, api, model, transcript, started_at, ended_at) values(?,?,?,?,?,?,?,?,?)", id, userId, o.purpose, o.scenario ?? "", o.api, o.model, JSON.stringify(transcript), o.startedAt, now());
  let reviewRunId: string | null = null;
  if (o.purpose === "practice" && transcript.some((t) => t.role === "user")) {
    const { createRun } = await import("../agents/runs.ts");
    reviewRunId = createRun(app, { kind: "speaking-review", spaceId: o.spaceId, title: `口语练习评价${o.scenario ? `：${o.scenario.slice(0, 40)}` : ""}`, input: { sessionId: id }, userId }).id;
    run(app.db, "update voice_sessions set review_run_id = ? where id = ?", reviewRunId, id);
  }
  return { id, reviewRunId };
}

export function listVoiceSessions(app: App, userId: string, purpose?: VoicePurpose, limit = 30): (VoiceSession & { review: string | null; reviewStatus: string | null })[] {
  const rows = all<Row & { review_output: string | null; review_status: string | null }>(
    app.db,
    `select v.*, r.output as review_output, r.status as review_status from voice_sessions v left join runs r on r.id = v.review_run_id
     where v.user_id = ? ${purpose ? "and v.purpose = ?" : ""} order by v.started_at desc limit ?`,
    ...[userId, ...(purpose ? [purpose] : []), limit],
  );
  return rows.map((r) => ({ ...toSession(r), review: r.review_output ? (json<{ review?: string }>(r.review_output, {}).review ?? null) : null, reviewStatus: r.review_status }));
}

export function getVoiceSession(app: App, id: string) {
  const r = one<Row>(app.db, "select * from voice_sessions where id = ?", id);
  return r ? toSession(r) : null;
}

/** The review run: the speaking-coach role reads the transcript. */
export async function speakingReview(ctx: import("../agents/runs.ts").RunContext) {
  const s = getVoiceSession(ctx.app, (ctx.run.input as { sessionId: string }).sessionId);
  if (!s) throw new Error("找不到这次练习的记录");
  const { runRole } = await import("../agents/runner.ts");
  const task = [
    "评价这次英语口语练习。",
    s.scenario ? `场景：${s.scenario}` : "场景：自由对话",
    `用时：${Math.max(1, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60_000))} 分钟`,
    "",
    "对话记录（learner 是学习者，partner 是语音模型；学习者的话是语音转写，个别词可能转错）：",
    ...s.transcript.map((t) => `${t.role === "user" ? "learner" : "partner"}: ${t.text}`),
  ].join("\n");
  const r = await runRole(ctx.app, { role: "speaking-coach", spaceId: ctx.run.spaceId!, spaces: [ctx.run.spaceId!], task, runId: ctx.run.id, signal: ctx.signal, userId: s.userId === OWNER ? undefined : s.userId });
  const { replyOf } = await import("../agents/types.ts");
  return { review: replyOf(r).trim() };
}
