import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { decidedBlocks, type CardBlock } from "./lark-send.ts";

/**
 * Answering in a meeting (a meeting rule's `answer`, docs/v2/rules.md): someone in the meeting chat
 * names one of omem's bots in a question, and the bot answers there in a few sentences. Unlike the
 * listening agent, which works for the owner, the answer is read by everyone in the meeting, so it is
 * held the way a guest's question is (lark-guest.ts): the gatekeeper decides first, and the guest
 * role reads only the meeting's space and the spaces the owner opened to guests — never the
 * personal space, memory or preferences. On top of that the rule says:
 *
 * - `answerFrom`: anyone in the meeting, or only the owner;
 * - `answerMode`: `draft` (the default) sends the answer to the owner on a card and only their
 *   “发到会里” posts it; `auto` posts it at once, with a “稍等” reaction while it looks;
 * - `answerMax`: answers per meeting; and in auto mode at least `GAP_MS` between two;
 * - `answerSpoken`: a spoken sentence naming the bot counts as a question too (off by default:
 *   recognition errs, and a sentence is revised while it is recognised, so it waits `SETTLE_MS`).
 *
 * The owner stops it for the meeting by writing `/ai 停` in the meeting chat (`/ai 继续` resumes) or
 * with the card's “这场会不再回答”. Every answer posted is written to audit_events, and the
 * meeting's summary lists what was answered and what was not.
 */

export const ANSWER_MAX_CHARS = 200;
const GAP_MS = 60_000;
const SETTLE_MS = 15_000;

export type AnswerLine = { key: string; at: number; kind: string; speaker: string; speakerId?: string; text: string };
type Sent = { at: string; asker: string; question: string; answer: string; runId: string; via: "auto" | "draft" };
type Skipped = { at: string; asker: string; question: string; why: string };
export type AnswerState = { paused?: { by: string; at: string } | null; handled: string[]; sent: Sent[]; skipped: Skipped[]; inFlight?: string | null; drafts: number };
export type AnswerPlan = { answer: boolean; answerFrom?: "all" | "owner"; answerMode?: "draft" | "auto"; answerMax?: number; answerSpoken?: boolean };
type Bot = { bot: string; ok: boolean; name?: string; left?: boolean };
type Meeting = { meeting_id: string; topic: string; status: string; space_id: string | null; answers?: string | null };

export const answerSettings = (p: AnswerPlan) => ({ from: p.answerFrom ?? "all", mode: p.answerMode ?? "draft", max: p.answerMax ?? 5, spoken: !!p.answerSpoken });

export function answerState(row: Pick<Meeting, "answers">): AnswerState {
  const s = json<Partial<AnswerState>>(row.answers ?? "{}", {});
  return { paused: s.paused ?? null, handled: s.handled ?? [], sent: s.sent ?? [], skipped: s.skipped ?? [], inFlight: s.inFlight ?? null, drafts: s.drafts ?? 0 };
}

async function meetings() {
  return import("./lark-meetings.ts");
}

async function save(app: App, id: string, change: (s: AnswerState) => void) {
  const m = await meetings();
  const row = m.meetingRow(app, id);
  if (!row) return null;
  const s = answerState(row);
  change(s);
  s.handled = s.handled.slice(-500);
  m.setMeetingAnswers(app, id, JSON.stringify(s));
  return s;
}

/** Spoken questions waiting for their sentence to settle: meeting → line key → first seen. */
const spoken = new Map<string, Map<string, number>>();
export function resetMeetingAnswersForTests() {
  spoken.clear();
}

const PAUSE = /^\s*\/ai\s*(停|暂停|停止|stop|pause)\s*$/i;
const RESUME = /^\s*\/ai\s*(继续|恢复|resume|go)\s*$/i;

/**
 * New lines of a meeting being listened to (lark-meetings.ts listen): the owner's `/ai 停` and
 * `/ai 继续`, and questions naming one of the bots.
 */
export async function considerLines(app: App, row: Meeting, plan: AnswerPlan, bots: Bot[], lines: AnswerLine[], added: Set<string>, owner: { ids: Set<string>; name: string | null }) {
  if (!plan.answer) return;
  const inMeeting = bots.filter((b) => b.ok && !b.left && b.name);
  if (!inMeeting.length) return;
  const names = inMeeting.map((b) => b.name!);
  const isOwner = (l: AnswerLine) => (!!l.speakerId && owner.ids.has(l.speakerId)) || (!!owner.name && l.speaker === owner.name);
  const set = answerSettings(plan);
  for (const l of lines) {
    if (!added.has(l.key) || l.kind !== "chat" || names.includes(l.speaker)) continue;
    if (isOwner(l) && (PAUSE.test(l.text) || RESUME.test(l.text))) {
      const pause = PAUSE.test(l.text);
      await save(app, row.meeting_id, (s) => void (s.paused = pause ? { by: "本人（会中聊天）", at: now() } : null));
      await (await meetings()).sendMeetingReaction(app, row.meeting_id, inMeeting[0].bot, "OK").catch(() => {});
      continue;
    }
    if (names.some((n) => l.text.includes(n))) await ask(app, row, set, inMeeting[0], l, isOwner(l));
  }
  if (!set.spoken) return;
  const waiting = spoken.get(row.meeting_id) ?? new Map<string, number>();
  spoken.set(row.meeting_id, waiting);
  for (const l of lines) if (l.kind === "transcript" && !names.includes(l.speaker) && names.some((n) => l.text.includes(n)) && !waiting.has(l.key)) waiting.set(l.key, Date.now());
  for (const [key, seen] of waiting) {
    if (Date.now() - seen < SETTLE_MS) continue;
    waiting.delete(key);
    const l = (await meetings()).meetingLine(app, row.meeting_id, key);
    if (l) await ask(app, row, set, inMeeting[0], l, isOwner(l), "spoken");
  }
}

/** Why a question will not be answered now; null when it may go ahead. */
function holdReason(s: AnswerState, set: ReturnType<typeof answerSettings>, fromOwner: boolean) {
  if (s.paused) return `本人暂停了回答（${s.paused.by}）`;
  if (set.from === "owner" && !fromOwner) return "规则只回答本人的提问";
  if (s.sent.length + s.drafts + (s.inFlight ? 1 : 0) >= set.max) return `这场会已经回答到上限（${set.max} 次）`;
  if (s.inFlight) return "上一个问题还在查";
  const last = s.sent.at(-1);
  if (set.mode === "auto" && last && Date.now() - Date.parse(last.at) < GAP_MS) return "离上次回答不到一分钟";
  return null;
}

async function ask(app: App, row: Meeting, set: ReturnType<typeof answerSettings>, bot: Bot, l: AnswerLine, fromOwner: boolean, via: "chat" | "spoken" = "chat") {
  const m = await meetings();
  const current = m.meetingRow(app, row.meeting_id);
  if (!current) return;
  const s = answerState(current);
  if (s.handled.includes(l.key)) return;
  // A run that ended without its waiter (the service restarted while it looked) no longer holds the next question.
  if (s.inFlight && !one<{ id: string }>(app.db, "select id from runs where id = ? and status in ('queued', 'running')", s.inFlight)) s.inFlight = null;
  const asked = { at: now(), asker: l.speaker, question: truncate(l.text, 300) };
  const why = holdReason(s, set, fromOwner);
  if (why) return void (await save(app, row.meeting_id, (x) => { x.handled.push(l.key); x.skipped.push({ ...asked, why }); }));
  const { askAsGuest, waitGuest } = await import("./lark-guest.ts");
  const r = askAsGuest(app, {
    chatId: `meeting:${row.meeting_id}`,
    chatType: "group",
    chatName: `会议「${row.topic || "无标题"}」`,
    messageId: l.key,
    senderId: l.speakerId ?? l.speaker,
    senderName: l.speaker,
    fromApp: false,
    text: l.text,
    context: m.meetingLinesText(app, row.meeting_id, 30),
    groupSpace: row.space_id ?? undefined,
    note: [
      `这是飞书视频会议里${via === "spoken" ? "有人口头" : "会中聊天里有人"}问机器人的问题${via === "spoken" ? "（语音转写，可能有错字；听不出在问什么就不回答）" : ""}。`,
      `你最后写的文字会显示在会中聊天里，所有参会人都看得到：只写答案本身，两三句、${ANSWER_MAX_CHARS} 字以内，说出依据的文档名；不贴链接、代码和长列表，要细看的说“会后看《文档名》”。查不到就直说查不到，不要猜。`,
    ].join("\n"),
  });
  if (!r) return void (await save(app, row.meeting_id, (x) => { x.handled.push(l.key); x.skipped.push({ ...asked, why: "这个人一小时内问得太多" }); }));
  await save(app, row.meeting_id, (x) => { x.handled.push(l.key); x.inFlight = r.id; });
  if (set.mode === "auto") await m.sendMeetingReaction(app, row.meeting_id, bot.bot, "OneSecond").catch(() => {});
  const done = (async () => {
    const v = await waitGuest(app, r.id).catch(() => null);
    const answer = v?.verdict === "answer" ? clip(v.answer ?? "") : "";
    const after = m.meetingRow(app, row.meeting_id);
    const gone = !after || after.status !== "listening";
    const skip = !answer ? (v ? `门卫：${v.verdict === "refuse" ? "拒绝" : "不理"}${v.reason ? `（${v.reason}）` : ""}` : "没有查出答案") : gone ? "会议已经结束" : answerState(after!).paused ? "本人暂停了回答" : null;
    if (skip) return void (await save(app, row.meeting_id, (x) => { x.inFlight = null; x.skipped.push({ ...asked, why: skip }); }));
    if (set.mode === "auto") {
      await postAnswer(app, row.meeting_id, bot.bot, { ...asked, answer, runId: r.id }, "auto").catch(async (e) => {
        await save(app, row.meeting_id, (x) => void x.skipped.push({ ...asked, why: `发到会里失败：${(e as Error).message.slice(0, 120)}` }));
      });
      return void (await save(app, row.meeting_id, (x) => void (x.inFlight = null)));
    }
    await save(app, row.meeting_id, (x) => { x.inFlight = null; x.drafts += 1; });
    await draftCard(app, { meetingId: row.meeting_id, topic: row.topic, bot: bot.bot, botName: bot.name ?? "机器人", runId: r.id, asker: l.speaker, question: asked.question, answer }).catch(async (e) => {
      await save(app, row.meeting_id, (x) => { x.drafts = Math.max(0, x.drafts - 1); x.skipped.push({ ...asked, why: `草稿卡片没发出去：${(e as Error).message.slice(0, 120)}` }); });
    });
  })();
  pending.add(done);
  void done.finally(() => pending.delete(done));
}

/** Answers being looked up (tests wait for them). */
const pending = new Set<Promise<void>>();
export async function settleMeetingAnswersForTests() {
  while (pending.size) await Promise.all([...pending]);
}

/** At most ANSWER_MAX_CHARS, cut at a sentence end when there is one in the second half. */
export function clip(text: string) {
  const t = text.trim().replace(/\n{2,}/g, "\n");
  if (t.length <= ANSWER_MAX_CHARS) return t;
  const head = t.slice(0, ANSWER_MAX_CHARS);
  const cut = Math.max(...["。", "！", "？", "；", ". ", "\n"].map((p) => head.lastIndexOf(p)));
  return cut > ANSWER_MAX_CHARS / 2 ? head.slice(0, cut + 1).trim() : `${head.slice(0, ANSWER_MAX_CHARS - 1)}…`;
}

async function postAnswer(app: App, meetingId: string, bot: string, a: Omit<Sent, "via">, via: Sent["via"]) {
  const m = await meetings();
  await m.sendMeetingMessage(app, meetingId, bot, a.answer);
  await save(app, meetingId, (x) => void x.sent.push({ ...a, at: now(), via }));
  const { audit } = await import("../auth/permissions.ts");
  audit(app, OWNER, "lark.meeting-answer", meetingId, { via, bot, asker: a.asker, question: a.question, answer: a.answer, run: a.runId });
}

// ---- the owner's draft card ---------------------------------------------------------------------

export type DraftPayload = { meetingId: string; topic: string; bot: string; botName: string; runId: string; asker: string; question: string; answer: string };
type DraftState = "sent" | "skipped" | "paused" | "gone" | "held";

export function draftAnswerCard(d: DraftPayload, state?: DraftState, decided?: { at?: string; timeZone?: string; result?: string }) {
  const blocks: CardBlock[] = [
    { fields: [{ label: "会议", value: d.topic || "无标题" }, { label: "谁问的", value: d.asker }] },
    { markdown: `**问题**\n${truncate(d.question, 600)}` },
    { markdown: `**拟回答**（以「${d.botName}」发到会中聊天，所有参会人可见）\n${d.answer}` },
  ];
  if (!state) {
    blocks.push({ buttons: [{ text: "发到会里", value: "send", style: "primary" }, { text: "不发", value: "skip" }, { text: "这场会不再回答", value: "pause", style: "danger" }] });
    blocks.push({ note: `只读了会议所在的空间和你对访客开放的空间 · 运行 ${d.runId}` });
    return { title: "会里有人问机器人，要发这个回答吗？", color: "blue", blocks };
  }
  const verdict = { sent: "已发到会里", skipped: "没有发", paused: "没有发，这场会不再回答", gone: "会议已经结束，没有发", held: "没有发" }[state];
  blocks.push(...decidedBlocks({ verdict, ...(state === "gone" ? {} : { by: "本人", at: decided?.at, timeZone: decided?.timeZone }), result: decided?.result, plain: true }));
  return { title: `会议「${d.topic || "无标题"}」的回答`, color: state === "sent" ? "green" : "grey", blocks };
}

async function draftCard(app: App, d: DraftPayload) {
  const send = await import("./lark-send.ts");
  const owner = send.larkOwnerOpenId(app, "main");
  const dm = one<{ value: string }>(app.db, "select value from kv where key = 'lark_owner_chat'")?.value;
  if (!owner && !dm) throw new HttpError(400, "主机器人还不知道你是谁，没法发草稿卡片");
  const sent = await send.sendLark(dm ? { chatId: dm, bot: "main" } : { userId: owner!, bot: "main" }, { card: send.buildCard(draftAnswerCard(d)) });
  send.recordInteraction(app, { messageId: sent.messageId, chatId: dm ?? null, conversationId: null, runId: d.runId, purpose: "meeting-answer", allowed: owner ? [owner] : [], payload: d, bot: "main" });
}

/** The owner pressed a button on the draft card (lark-actions.ts). Returns the card to show instead. */
export async function decideMeetingAnswer(app: App, d: DraftPayload, action: string) {
  const m = await meetings();
  const at = now();
  const tz = app.config.timezone;
  const row = m.meetingRow(app, d.meetingId);
  await save(app, d.meetingId, (x) => void (x.drafts = Math.max(0, x.drafts - 1)));
  const asked = { at, asker: d.asker, question: d.question };
  if (!row || row.status !== "listening") {
    await save(app, d.meetingId, (x) => void x.skipped.push({ ...asked, why: "会议已经结束" }));
    return draftAnswerCard(d, "gone");
  }
  if (action === "pause") {
    await save(app, d.meetingId, (x) => { x.paused = { by: "本人（草稿卡片）", at }; x.skipped.push({ ...asked, why: "本人暂停了回答" }); });
    return draftAnswerCard(d, "paused", { at, timeZone: tz });
  }
  if (action !== "send") {
    await save(app, d.meetingId, (x) => void x.skipped.push({ ...asked, why: "本人选了不发" }));
    return draftAnswerCard(d, "skipped", { at, timeZone: tz });
  }
  const s = answerState(row);
  if (s.paused) return draftAnswerCard(d, "held", { at, timeZone: tz, result: "这场会已经暂停回答" });
  await postAnswer(app, d.meetingId, d.bot, { at, asker: d.asker, question: d.question, answer: d.answer, runId: d.runId }, "draft");
  return draftAnswerCard(d, "sent", { at, timeZone: tz });
}

/** For the meeting's summary: what the bot answered in the meeting and what it left. */
export function answersText(row: Pick<Meeting, "answers">) {
  const s = answerState(row);
  if (!s.sent.length && !s.skipped.length) return "";
  const time = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
  return [
    ...s.sent.map((a) => `- ${time(a.at)} ${a.asker} 问：${a.question}\n  机器人${a.via === "draft" ? "（你点了发送）" : ""}答：${a.answer}`),
    ...s.skipped.map((a) => `- ${time(a.at)} ${a.asker} 问：${a.question}\n  没有回答：${a.why}`),
    s.paused ? `- 回答在 ${time(s.paused.at)} 被暂停（${s.paused.by}）` : "",
  ].filter(Boolean).join("\n");
}
