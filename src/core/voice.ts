import type { App } from "./app.ts";
import { baseOf, categoryStatus, defaultFor, keyOf } from "./ai-keys.ts";
import { all, one, run } from "./db.ts";
import { accessibleSpaces } from "./users.ts";
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
 * A conversation from the question page gets omem's read tools (search, read_source…), run here in
 * the user's scope. A plugin page's conversation (docs/v2/plugins.md, “语音”) gets the plugin's own
 * instructions and no tools: what to talk about is the plugin's business, omem only connects.
 * Speech to text for the input box is a plain `/audio/transcriptions` call.
 */
export type VoiceSpec = { kind: "chat" } | { kind: "plugin"; plugin: string; instructions: string };
/** The longest instructions a plugin may give the voice model. */
export const PLUGIN_INSTRUCTIONS_MAX = 6000;

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

/** What the voice model is told: on the question page a short brief (it speaks, it is not an agent); in a plugin, the plugin's own. */
export function voiceInstructions(spec: VoiceSpec) {
  if (spec.kind === "plugin") return spec.instructions;
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
export async function realtimeSecret(app: App, spec: VoiceSpec) {
  const p = provider(app);
  if (p.api !== "realtime") throw new HttpError(409, "语音设置的接口是 GPT-Live，不是 Realtime");
  const session = {
    type: "realtime",
    model: p.model,
    instructions: voiceInstructions(spec),
    audio: {
      input: { transcription: { model: "gpt-live-transcribe" }, turn_detection: { type: "semantic_vad" } },
      output: { voice: p.voice },
    },
    ...(spec.kind === "chat" ? { tools: await functionTools(), tool_choice: "auto" } : {}),
  };
  const r = await post(`${p.base}/realtime/client_secrets`, p.key, { expires_after: { anchor: "created_at", seconds: 600 }, session }, "创建 Realtime 临时凭证");
  const value = r.value ?? r.client_secret?.value;
  if (!value) throw new HttpError(502, "Realtime 没有返回临时凭证");
  return { api: "realtime" as const, model: p.model, secret: String(value), expiresAt: r.expires_at ?? null, callsUrl: `${p.base}/realtime/calls` };
}

/** GPT-Live: omem opens the session with the browser's SDP offer and returns the answer. */
export async function liveConnect(app: App, spec: VoiceSpec, sdp: string) {
  const p = provider(app);
  if (p.api !== "live") throw new HttpError(409, "语音设置的接口是 Realtime，不是 GPT-Live");
  const tools = spec.kind === "chat" ? await functionTools() : [];
  const session = {
    model: p.model,
    instructions: voiceInstructions(spec),
    audio: { output: { voice: p.voice } },
    delegation: { type: "responses", responses: { model: app.config.ai.voice.delegateModel || defaultFor(app.config, app.home, "voice.delegate"), ...(tools.length ? { tools, tool_choice: "auto" } : {}) } },
  };
  const r = await post(`${p.base}/live/sessions`, p.key, { session, transport: { type: "webrtc", sdp } }, "打开 GPT-Live 会话");
  const answer = r.transport?.sdp;
  if (!answer) throw new HttpError(502, "GPT-Live 没有返回 SDP 应答");
  return { api: "live" as const, model: p.model, sessionId: r.session?.id ?? null, sdp: String(answer) };
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

/**
 * Conversations from the question page are kept here (`purpose` "chat"). Rows from before
 * 2026-11-11 may say "practice": speaking practice has since moved into the English plugin, which
 * keeps its own records in its plugin store. omem does not keep a plugin's conversations.
 */
export type VoiceTurn = { role: "user" | "assistant"; text: string };
export type VoiceSession = { id: string; userId: string; purpose: string; api: string; model: string; transcript: VoiceTurn[]; startedAt: string; endedAt: string };
type Row = { id: string; user_id: string; purpose: string; api: string; model: string; transcript: string; started_at: string; ended_at: string };
const toSession = (r: Row): VoiceSession => ({ id: r.id, userId: r.user_id, purpose: r.purpose, api: r.api, model: r.model, transcript: json(r.transcript, []), startedAt: r.started_at, endedAt: r.ended_at });

export function saveVoiceSession(app: App, userId: string, o: { api: string; model: string; transcript: VoiceTurn[]; startedAt: string }) {
  const id = newId("voice");
  const transcript = o.transcript.filter((t) => t.text.trim()).map((t) => ({ role: t.role, text: t.text.trim().slice(0, 4000) })).slice(0, 400);
  run(app.db, "insert into voice_sessions(id, user_id, purpose, scenario, api, model, transcript, started_at, ended_at) values(?,?,?,?,?,?,?,?,?)", id, userId, "chat", "", o.api, o.model, JSON.stringify(transcript), o.startedAt, now());
  return { id };
}

export function listVoiceSessions(app: App, userId: string, limit = 30): VoiceSession[] {
  return all<Row>(app.db, "select * from voice_sessions where user_id = ? and purpose = 'chat' order by started_at desc limit ?", userId, limit).map(toSession);
}

export function getVoiceSession(app: App, id: string) {
  const r = one<Row>(app.db, "select * from voice_sessions where id = ?", id);
  return r ? toSession(r) : null;
}
