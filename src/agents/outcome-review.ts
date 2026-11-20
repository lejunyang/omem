import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { json, localStamp, truncate } from "../core/util.ts";
import { casesText, nearCases } from "../channels/listen-cases.ts";
import { CORRECTION } from "../memory/gaps.ts";
import { exchange, reactions, REPLY_LABELS, replyLine, reviewable, type OutcomeRow, type ReplyLabel } from "./reply-outcomes.ts";
import { chatName } from "./run-scope.ts";
import { createRun, registerHandler, type RunContext } from "./runs.ts";

/**
 * The nightly second reading of reply outcomes (docs/v2/reply-outcomes.md “夜里复查”).
 *
 * The first label is a small model's guess a few hours after the answer, from the few lines said next;
 * most of them nobody looks at again. Every night the answers one to `days` days old whose label came
 * from the model (never the owner's, never one an emoji set) are read again by the role
 * outcome-reviewer, with a whole day of what followed, the owner's own moves there, the reactions and
 * related cases. It hands in a label for each (`review_reply_outcomes`): the same one is recorded as
 * agreement, another one revises the label (reply-outcomes.ts checkReply). How often it agrees is how
 * far the first pass can be trusted.
 *
 * Which ones: first those a cheap signal contradicts (the asker asked again, the owner answered it
 * themselves, a negative reaction, a correction), then unsure labels, then 看不出; and a few confident
 * ones at random, so the agreement rate is not only measured on doubtful labels. At most `max` a night,
 * `batch` to a run.
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** In a busy group, what comes this soon after a reply may be about it even outside its thread. */
const NEARBY_MS = 2 * HOUR;
/** A later message from the asker that shares this much of the question (character pairs) is the question again. */
const SAME = 0.4;

export type ReviewPick = "signal" | "unsure" | "unclear" | "sample";
export type Signal = "asked-again" | "owner-answered" | "negative" | "correction";

export const PICK_TEXT: Record<ReviewPick, string> = {
  signal: "后来的动静和第一遍的标注对不上",
  unsure: "第一遍的把握不够",
  unclear: "第一遍标的是看不出",
  sample: "随机抽的（第一遍有把握的，用来看第一遍准不准）",
};
export const SIGNAL_TEXT: Record<Signal, string> = {
  "asked-again": "提问的人之后又问了差不多的话",
  "owner-answered": "本人之后在那里自己答了",
  negative: "有人对这条回答点了负面表情",
  correction: "之后有人说了“不对”“错了”这类话",
};
/** The labels a signal is consistent with; a signal outside them says the first label may be wrong. */
const FITS: Record<Signal, ReplyLabel[]> = {
  "asked-again": ["followup", "corrected"],
  "owner-answered": ["taken_over", "corrected"],
  negative: ["corrected", "followup"],
  correction: ["corrected"],
};

export type ReviewCandidate = { runId: string; at: string; label: ReplyLabel; confidence: number | null; pick: ReviewPick; signals: Signal[] };
export type BatchPick = { runId: string; pick: ReviewPick; signals: Signal[] };

type Line = { who: string; text: string; at: string; owner: boolean; asker: boolean; bot: boolean; close: boolean };
type After = { question: string; questionAt: string | null; asker: { name: string; owner: boolean } | null; lines: Line[] };

const grams = (s: string) => {
  const t = s.replace(/\s+/g, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
function overlap(a: string, b: string) {
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return n / Math.min(x.size, y.size);
}

const row = (app: App, runId: string) => one<OutcomeRow>(app.db, "select * from reply_outcomes where run_id = ?", runId);

/**
 * What followed a reply for a day (or until `until`): the conversation's later turns and the chat's
 * later messages — replies to it and its thread, anything within two hours, and whatever the asker or
 * the owner said there later. Also the question, and who asked it.
 */
function readAfter(app: App, o: OutcomeRow, until: number): After {
  const from = Date.parse(o.at);
  const lines: Line[] = [];
  const seen = new Set<string>();
  const add = (l: Line) => {
    const text = l.text.replace(/\s+/g, " ").trim();
    const key = text.slice(0, 60);
    if (!text || seen.has(key)) return;
    seen.add(key);
    lines.push({ ...l, text: truncate(text, l.bot ? 240 : 500) });
  };
  let question = "", questionAt: string | null = null;
  let asker: After["asker"] = null;
  if (o.chat_id) {
    const created = one<{ created_at: string }>(app.db, "select created_at from runs where id = ?", o.run_id)?.created_at;
    const asked = Math.min(from, created ? Date.parse(created) : from);
    const q = one<{ message_id: string; thread_id: string | null; sender_id: string | null; sender_name: string; sender_kind: string; content: string; create_ms: number }>(
      app.db,
      "select message_id, thread_id, sender_id, sender_name, sender_kind, content, create_ms from lark_messages where chat_id = ? and create_ms <= ? and sender_kind in ('user','owner') and trim(content) != '' order by create_ms desc limit 1",
      o.chat_id, asked,
    );
    if (q) {
      question = q.content;
      questionAt = new Date(q.create_ms).toISOString();
      asker = { name: q.sender_kind === "owner" ? "本人" : q.sender_name || "有人", owner: q.sender_kind === "owner" };
    }
    const thread = o.message_id ? one<{ thread_id: string | null }>(app.db, "select thread_id from lark_messages where message_id = ?", o.message_id)?.thread_id : null;
    const rows = all<{ message_id: string; thread_id: string | null; parent_id: string | null; sender_id: string | null; sender_name: string; sender_kind: string; content: string; create_ms: number }>(
      app.db,
      `select message_id, thread_id, parent_id, sender_id, sender_name, sender_kind, content, create_ms from lark_messages
       where chat_id = ? and create_ms > ? and create_ms <= ? and sender_kind in ('user','owner','app') and msg_type in ('text','post') and trim(content) != ''
       order by create_ms limit 200`,
      o.chat_id, from, until,
    );
    for (const m of rows) {
      const close = (!!o.message_id && m.parent_id === o.message_id) || (!!q && m.parent_id === q.message_id) || (!!thread && m.thread_id === thread) || (!!q?.thread_id && m.thread_id === q.thread_id);
      const owner = m.sender_kind === "owner";
      const fromAsker = !!q && (q.sender_id ? m.sender_id === q.sender_id : owner && q.sender_kind === "owner");
      const near = m.create_ms - from <= NEARBY_MS;
      if (!close && !near && !owner && !fromAsker) continue;
      if (m.sender_kind === "app" && !close && !near) continue;
      add({ who: owner ? "本人" : m.sender_kind === "app" ? `机器人 ${m.sender_name}`.trim() : m.sender_name || "群里的人", text: m.content, at: new Date(m.create_ms).toISOString(), owner, asker: fromAsker, bot: m.sender_kind === "app", close });
    }
  }
  if (o.conversation_id) {
    if (!asker) {
      const q = one<{ text: string; meta: string; created_at: string }>(app.db, "select text, meta, created_at from messages where conversation_id = ? and role = 'user' and created_at <= ? and json_extract(meta, '$.command') is null order by created_at desc limit 1", o.conversation_id, o.at);
      if (q) {
        const speaker = json<{ speaker?: unknown }>(q.meta, {}).speaker;
        question = q.text;
        questionAt = q.created_at;
        asker = typeof speaker === "string" && speaker ? { name: speaker, owner: false } : { name: "本人", owner: true };
      }
    }
    for (const m of all<{ role: string; text: string; meta: string; created_at: string }>(
      app.db,
      "select role, text, meta, created_at from messages where conversation_id = ? and created_at > ? and created_at <= ? and json_extract(meta, '$.command') is null order by created_at limit 30",
      o.conversation_id, o.at, new Date(until).toISOString(),
    )) {
      const meta = json<{ speaker?: unknown; wake?: unknown }>(m.meta, {});
      if (meta.wake) continue;
      if (m.role === "assistant") { add({ who: "助手", text: m.text, at: m.created_at, owner: false, asker: false, bot: true, close: true }); continue; }
      if (m.role !== "user") continue;
      const speaker = typeof meta.speaker === "string" && meta.speaker ? meta.speaker : null;
      add({ who: speaker ?? "本人", text: m.text, at: m.created_at, owner: !speaker, asker: !!asker && (speaker ? speaker === asker.name : asker.owner), bot: false, close: true });
    }
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  return { question, questionAt, asker, lines: lines.slice(0, 40) };
}

/** The owner's own replies to the same question (「有人找你」's cases in that chat), after the bot answered. */
function ownerReplies(app: App, o: OutcomeRow, after: After, until: number) {
  if (!o.chat_id) return [];
  const since = new Date(Date.parse(after.questionAt ?? o.at) - HOUR).toISOString();
  return all<{ owner_reply: string; owner_reply_at: string }>(
    app.db,
    "select owner_reply, owner_reply_at from reply_samples indexed by reply_samples_chat where chat_id = ? and created_at >= ? and created_at <= ? and owner_reply is not null and owner_reply_at > ? and owner_reply_at <= ? order by created_at desc limit 3",
    o.chat_id, since, o.at, o.at, new Date(until).toISOString(),
  );
}

/** Signals that cost a few queries: what they say about a reply, before any model reads it. */
function signalsOf(app: App, o: OutcomeRow, after: After, until: number): Signal[] {
  const out: Signal[] = [];
  const from = Date.parse(o.at);
  const human = after.lines.filter((l) => !l.bot);
  if (after.question && human.some((l) => l.asker && l.text.replace(/\s+/g, "").length >= 6 && overlap(after.question, l.text) >= SAME)) out.push("asked-again");
  if (after.asker && !after.asker.owner && (human.some((l) => l.owner && (l.close || Date.parse(l.at) - from <= NEARBY_MS) && l.text.replace(/\s+/g, "").length >= 6) || ownerReplies(app, o, after, until).length)) out.push("owner-answered");
  if (reactions(app, o.run_id).negative) out.push("negative");
  if (human.some((l) => (l.close || Date.parse(l.at) - from <= NEARBY_MS) && CORRECTION.test(l.text))) out.push("correction");
  return out;
}

/**
 * Tonight's candidates: answers sent between `days` days and one day ago (so a whole day after each is
 * there to read) whose label the second reading may look at (reviewable), with why each would be read.
 * A host's “没人接话” is a candidate only when something later contradicts it.
 */
export function reviewCandidates(app: App, at = Date.now()): ReviewCandidate[] {
  const cfg = app.config.replies.outcome;
  const rows = all<OutcomeRow>(
    app.db,
    "select * from reply_outcomes indexed by reply_outcomes_at where at >= ? and at <= ? and label is not null and checked is null and revised_label is null",
    new Date(at - cfg.review.days * DAY).toISOString(), new Date(at - DAY).toISOString(),
  ).filter(reviewable);
  const out: ReviewCandidate[] = [];
  for (const o of rows) {
    const until = Math.min(at, Date.parse(o.at) + DAY);
    const signals = signalsOf(app, o, readAfter(app, o, until), until);
    const label = o.label!;
    const against = signals.filter((s) => !FITS[s].includes(label));
    const pick: ReviewPick | null = against.length ? "signal"
      : label === "silent" ? null
      : o.confidence === null || o.confidence < cfg.threshold ? "unsure"
      : label === "unrelated" ? "unclear"
      : "sample";
    if (pick) out.push({ runId: o.run_id, at: o.at, label, confidence: o.confidence, pick, signals });
  }
  return out;
}

const ORDER: Record<ReviewPick, number> = { signal: 0, unsure: 1, unclear: 2, sample: 3 };

/** The night's share: the doubtful ones in order, and `sample` confident ones at random (inside `max`). */
export function pickForReview(cands: ReviewCandidate[], opts: { max: number; sample: number }, rand: () => number = Math.random): ReviewCandidate[] {
  const doubtful = cands.filter((c) => c.pick !== "sample").sort((a, b) => ORDER[a.pick] - ORDER[b.pick] || b.signals.length - a.signals.length || (a.confidence ?? 0) - (b.confidence ?? 0) || b.at.localeCompare(a.at));
  const confident = cands.filter((c) => c.pick === "sample").map((c) => ({ c, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.c);
  const sample = Math.min(opts.sample, confident.length, opts.max);
  return [...doubtful.slice(0, opts.max - sample), ...confident.slice(0, sample)];
}

/** Queue tonight's second reading, `batch` answers to a run; nothing while an earlier one is still waiting or running. */
export function scheduleOutcomeReview(app: App, at = Date.now()) {
  const cfg = app.config.replies.outcome;
  if (!cfg.enabled || !cfg.review.enabled) return [];
  if (one(app.db, "select 1 from runs where kind = 'outcome-review' and status in ('queued','running') limit 1")) return [];
  const picks = pickForReview(reviewCandidates(app, at), cfg.review);
  const runs = [];
  for (let i = 0; i < picks.length; i += cfg.review.batch) {
    const batch = picks.slice(i, i + cfg.review.batch).map((c): BatchPick => ({ runId: c.runId, pick: c.pick, signals: c.signals }));
    runs.push(createRun(app, { kind: "outcome-review", spaceId: "personal", userId: OWNER, title: `复查回复结果（${batch.length} 条）`, input: { picks: batch } }));
  }
  return runs;
}

/** The answers a review run was given (its input). */
export function batchOf(input: Record<string, unknown> | string | null | undefined): BatchPick[] {
  const v = typeof input === "string" ? json<Record<string, unknown>>(input, {}) : input ?? {};
  return Array.isArray(v.picks) ? (v.picks as BatchPick[]).filter((p) => p && typeof p.runId === "string") : [];
}

/** One answer's material for the reviewer: the exchange, a day of what followed, the owner's moves, reactions, cases. */
export function reviewMaterial(app: App, p: BatchPick, n: number, at = Date.now()): string {
  const o = row(app, p.runId);
  if (!o?.label) return "";
  const tz = app.config.timezone;
  const until = Math.min(at, Date.parse(o.at) + DAY);
  const after = readAfter(app, o, until);
  const { asked, answer } = exchange(app, o);
  const kind = one<{ kind: string }>(app.db, "select kind from runs where id = ?", o.run_id)?.kind ?? "";
  const where = o.chat_id ? `飞书群「${truncate(chatName(app, o.chat_id), 40)}」` : o.conversation_id ? `会话 ${o.conversation_id}` : "（没有记录到在哪）";
  const unsure = o.confidence !== null && o.confidence < app.config.replies.outcome.threshold && o.label !== "silent";
  const first = json<{ who: string; text: string }[]>(o.evidence, []);
  const emoji = reactions(app, o.run_id);
  const owner = after.lines.filter((l) => l.owner && !(after.asker?.owner));
  const replies = ownerReplies(app, o, after, until);
  const cases = o.chat_id ? nearCases(app, { chatId: o.chat_id, text: after.question || asked }, 4) : [];
  const line = o.chat_id ? replyLine(app, o.chat_id) : "";
  const stamp = (iso: string) => localStamp(iso, tz, { short: true });
  return [
    `## ${n}. 回答 ${o.run_id}`,
    `- 在哪：${where}；运行类型 ${kind || "未知"}；发出 ${localStamp(o.at, tz)}${after.asker ? `；提问的是${after.asker.name}` : ""}`,
    `- 为什么挑它：${PICK_TEXT[p.pick]}${p.signals.length ? `（${p.signals.map((s) => SIGNAL_TEXT[s]).join("；")}）` : ""}`,
    `- 第一遍标的：${REPLY_LABELS[o.label]}（${o.by ?? ""}${o.confidence !== null ? `，把握 ${o.confidence.toFixed(2)}` : ""}）${unsure ? "，把握低于门槛，现在按看不出算" : ""}`,
    `- 第一遍看到的后续：${first.length ? first.map((l) => `${l.who}：${truncate(l.text, 120)}`).join(" / ") : "没有"}`,
    "",
    "### 问的",
    asked || "（没有记录到提问）",
    "",
    "### 助手的回答",
    answer || "（没有记录到回答）",
    "",
    `### 之后一天里的消息（${after.lines.length} 条；“相关”= 回复它、在同一话题里或会话里的下一轮）`,
    after.lines.length ? after.lines.map((l) => `- [${stamp(l.at)}] ${l.who}${l.asker && !l.owner ? "（提问的人）" : ""}${l.close ? "（相关）" : ""}：${l.text}`).join("\n") : "（一天里没有人说话）",
    ...(emoji.lines.length ? ["", "### 表情", emoji.lines.map((l) => `- ${l.who}${l.text}`).join("\n")] : []),
    ...(owner.length || replies.length ? ["", "### 本人之后的动作", [...owner.map((l) => `- [${stamp(l.at)}] 本人在那里说：${truncate(l.text, 300)}`), ...replies.map((r) => `- [${stamp(r.owner_reply_at)}] 本人自己回了有人找他的消息：${truncate(r.owner_reply, 300)}`)].join("\n")] : []),
    ...(cases.length ? ["", "### 同一个群里相近的案例（本人当时怎么处理的）", casesText(cases)] : []),
    ...(line ? ["", `### 这个群以往的回答\n${line}`] : []),
  ].join("\n");
}

export function reviewTask(app: App, picks: BatchPick[], at = Date.now()): string {
  const blocks = picks.map((p, i) => reviewMaterial(app, p, i + 1, at)).filter(Boolean);
  return [
    `下面 ${blocks.length} 条回答，第一遍的结果是回答发出几小时后，决策模型只按之后的几句话标的。你手里有每条发出后一整天的材料。逐条判断它的结果，用 review_reply_outcomes 一次交全部结论（run_id 用标题里的那个）。`,
    "",
    ...blocks.flatMap((b) => [b, ""]),
  ].join("\n").trim();
}

registerHandler("outcome-review", async (ctx: RunContext) => {
  const app = ctx.app;
  const live = batchOf(ctx.run.input).filter((p) => { const o = row(app, p.runId); return !!o && reviewable(o); });
  if (!live.length) return { quiet: true, summary: "要复查的回答都已经有了结论" };
  const spaces = [...new Set(["personal", ...live.map((p) => one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", p.runId)?.space_id).filter((s): s is string => !!s)])];
  const { runRole } = await import("./runner.ts");
  const r = await runRole(app, { role: "outcome-reviewer", spaceId: "personal", spaces, ownAI: true, task: reviewTask(app, live), runId: ctx.run.id, userId: OWNER, signal: ctx.signal, onEvent: (e) => ctx.event(e.type, e) });
  run(app.db, "update runs set profile_id = ? where id = ?", r.profileId, ctx.run.id);
  const done = live.map((p) => row(app, p.runId)).filter((o): o is OutcomeRow => !!o?.checked);
  const agreed = done.filter((o) => o.checked === "confirmed").length;
  const left = live.length - done.length;
  return {
    quiet: true, reviewed: done.length, confirmed: agreed, revised: done.length - agreed,
    summary: [`复查了 ${done.length} 条回答：同意第一遍 ${agreed} 条，改判 ${done.length - agreed} 条${left ? `；${left} 条没交结论，下一晚还在范围里的会再挑` : ""}。`, truncate(r.text.trim(), 1500)].filter(Boolean).join("\n"),
  };
});
