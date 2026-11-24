import type { App } from "../core/app.ts";
import { all, one, run as sql } from "../core/db.ts";
import { noteHandling, noteYield } from "../core/handling.ts";
import { OWNER } from "../core/users.ts";
import { now, truncate } from "../core/util.ts";
import { cancelRun, createRun, queuedInLane, updateQueuedRun, type Run, type RunContext } from "../agents/runs.ts";
import { addMessage } from "../agents/threads.ts";
import { probesText, type ProbeResult } from "../rules/probes.ts";
import { DEST_TEXT, type Delivered, type FirstLookInput, type LookMessage, type Outcome } from "../rules/first-look.ts";
import { getContext, LISTEN_CHANNEL, type ListenContext } from "./listen.ts";
import { briefText } from "./watch-trial.ts";

/**
 * A 「关注」 with the fast path on (knob `firstLook`, docs/v2/first-look.md). Its messages still join the
 * batch as before (lark-watch.ts routeWatchedMessages), and each also queues a first look that does not
 * wait for the batch window: messages of the same group arriving within LISTEN_MERGE_MS are looked at
 * together (one queued first look per 关注 and group takes the newcomers; one already running is not
 * joined — what comes meanwhile waits for the next). The first look screens them first (prefilterBatch,
 * skipped without a decision model), then the probes, then the fast model:
 *
 * - answered / owner: the messages leave the batch (a batch left empty is cancelled), and a note in the
 *   关注's conversation says what was answered and where;
 * - escalate: what the probes and the first look found joins the batch as a message of its own, and the
 *   batch runs now (its own handling and reply mode, unchanged).
 *
 * Only one answers: while the first look works its batch is held back (HOLD_MS at most); a batch that
 * started on these messages anyway (a restart, a 关注 with a window shorter than the look) has them, and
 * the first look steps aside (core/handling.ts noteYield) instead of answering too.
 */
export const LISTEN_MERGE_MS = 20_000;
const HOLD_MS = 5 * 60_000;

const laneOf = (contextId: string, chatId: string) => `firstlook:listen:${contextId}:${chatId}`;

/** First looks a 关注 started today: its `perDay` counts these too. */
function looksToday(app: App, contextId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'first-look' and lane like ? and created_at >= ?", `firstlook:listen:${contextId}:%`, start.toISOString())?.n ?? 0;
}

/** A message routed to a 关注 with the fast path on: into the queued first look of its group, or a new one. */
export function queueListenLook(app: App, c: ListenContext, chat: { id: string; name: string }, m: LookMessage): string | null {
  if (!c.knobs.firstLook || !c.conversationId) return null;
  const lane = laneOf(c.id, chat.id);
  const waiting = queuedInLane(app, lane, "first-look");
  if (waiting) {
    const messages = [...((waiting.input.messages as LookMessage[] | undefined) ?? []), m].slice(-20);
    if (updateQueuedRun(app, waiting.id, { input: { ...waiting.input, messages } })) return waiting.id;
  }
  if (looksToday(app, c.id) >= c.knobs.perDay) return null;
  const input: FirstLookInput = {
    source: "listen",
    userId: OWNER,
    chat: { id: chat.id, name: chat.name, kind: "group" },
    messages: [m],
    brief: [c.note ? `关注的目的：${c.note}` : "", briefText(c)].filter(Boolean).join("\n"),
    probes: c.knobs.probes ?? [],
    to: c.knobs.firstTo ?? app.config.firstLook.to,
    direct: c.knobs.reply === "auto" && c.chats.includes(chat.id),
    listen: { contextId: c.id, conversationId: c.conversationId, name: c.name },
  };
  return createRun(app, {
    kind: "first-look",
    spaceId: c.spaceId ?? "personal",
    title: truncate(`先看一眼（关注「${c.name}」）：${m.text.replace(/\s+/g, " ")}`, 80),
    input,
    lane,
    notBefore: new Date(Date.now() + LISTEN_MERGE_MS).toISOString(),
    userId: OWNER,
  }).id;
}

type Row = { id: string; text: string; meta: string; run_id: string | null; status: string | null; kind: string | null };
/** The 关注 conversation's row of each Feishu message, with the batch it is in. */
function rowsOf(app: App, conversationId: string, messages: LookMessage[]) {
  return messages.map((m) => ({
    m,
    row: one<Row>(app.db, "select x.id, x.text, x.meta, x.run_id, r.status, r.kind from messages x left join runs r on r.id = x.run_id where x.conversation_id = ? and json_extract(x.meta, '$.externalId') = ? order by x.created_at desc limit 1", conversationId, m.id) ?? null,
  }));
}

/** Batches held back while a first look works, with when each was due. */
export type Held = { id: string; notBefore: string | null }[];

export async function prepareListen(ctx: RunContext, input: FirstLookInput): Promise<{ done: Record<string, unknown> } | { messages: LookMessage[]; held: Held; prefilter?: string }> {
  const { app } = ctx;
  const l = input.listen!;
  const c = getContext(app, l.contextId);
  if (!c || c.status !== "active" || !c.knobs.firstLook) return { done: { skipped: "关注已经停下，或关掉了先看一眼：交回这一批照常处理" } };
  const rows = rowsOf(app, l.conversationId, input.messages);
  const taken = rows.filter((x) => x.row?.kind === "ask" && (x.row.status === "running" || x.row.status === "done"));
  for (const x of taken) noteYield(app, { event: x.m.id, actor: "watch", to: "关注的这一批", reason: "这一批已经开始处理这条，先看一眼让开", runId: ctx.run.id });
  const left = rows.filter((x) => !taken.includes(x));
  if (!left.length) return { done: { skipped: "这几条已经由关注的这一批在处理" } };
  // Screened like a batch (lark-watch.ts prefilterBatch: only with a decision model, the day's limit always).
  const { prefilterBatch } = await import("./lark-watch.ts");
  const batch = left.filter((x) => x.row).map((x) => ({ id: x.row!.id, text: x.row!.text, meta: JSON.parse(x.row!.meta) as Record<string, unknown> }));
  const skipped = batch.length ? await prefilterBatch(app, l.conversationId, batch, ctx.signal, { ref: ctx.run.id, reason: (text) => ctx.event("status", { text }) }) : null;
  if (skipped) {
    ctx.event("status", { text: `预筛：不用看（${skipped}），这一批照常` });
    return { done: { prefiltered: skipped, skipped: `预筛：${skipped}` } };
  }
  // The batch waits until this look is done (at most HOLD_MS, in case this run dies).
  const held: Held = [];
  for (const id of new Set(left.map((x) => x.row?.run_id).filter((x): x is string => !!x))) {
    const r = one<{ status: string; not_before: string | null }>(app.db, "select status, not_before from runs where id = ?", id);
    if (r?.status !== "queued") continue;
    if (updateQueuedRun(app, id, { notBefore: new Date(Date.now() + HOLD_MS).toISOString() })) held.push({ id, notBefore: r.not_before });
  }
  return { messages: left.map((x) => x.m), held, ...(batch.length ? { prefilter: "看过，要看" } : {}) };
}

/** Held batches go back to when they were due. */
export function release(app: App, held: Held) {
  for (const h of held) updateQueuedRun(app, h.id, { notBefore: h.notBefore ?? now() });
}

/** A batch that started on these messages meanwhile: its id, or null. */
export function batchTook(app: App, input: FirstLookInput, messages: LookMessage[]): string | null {
  const hit = rowsOf(app, input.listen!.conversationId, messages).find((x) => x.row?.kind === "ask" && (x.row.status === "running" || x.row.status === "done"));
  return hit?.row?.run_id ?? null;
}

export function yieldToBatch(app: App, runId: string, messages: LookMessage[], batchId: string) {
  for (const m of messages) noteYield(app, { event: m.id, actor: "watch", to: `关注的这一批（${batchId}）`, reason: "先看一眼还没发，这一批已经开始处理这条，先看一眼让开", runId });
}

/** answered / owner: the messages are done with; they leave the batch, and the conversation says what came of them. */
export function settle(app: App, r: Run, input: FirstLookInput, messages: LookMessage[], o: Outcome, d: Delivered, held: Held) {
  const l = input.listen!;
  const rows = rowsOf(app, l.conversationId, messages).filter((x) => x.row);
  const ids = new Set(rows.map((x) => x.row!.id));
  for (const batchId of new Set(rows.map((x) => x.row!.run_id).filter((x): x is string => !!x))) {
    const b = one<{ status: string; input: string }>(app.db, "select status, input from runs where id = ?", batchId);
    if (b?.status !== "queued") continue;
    const bi = JSON.parse(b.input) as { messageIds?: string[] };
    const rest = (bi.messageIds ?? []).filter((id) => !ids.has(id));
    if (!rest.length) cancelRun(app, batchId);
    else {
      const was = held.find((h) => h.id === batchId);
      updateQueuedRun(app, batchId, { input: { ...bi, messageIds: rest }, notBefore: was?.notBefore ?? now() });
    }
  }
  for (const id of ids) sql(app.db, "update messages set run_id = ? where id = ?", r.id, id);
  const where = d.to === "none" ? "没有发出去" : `发到${DEST_TEXT[d.to]}`;
  addMessage(app, l.conversationId, "assistant", `（先看一眼${o.outcome === "owner" ? "把这几条交给本人定" : "已经答了这几条"}，${where}：${truncate(o.text || o.reason || "", 600)}）`, r.id, { replyTo: [...ids], firstLook: r.id });
  if (o.outcome === "owner") for (const m of messages) noteHandling(app, { event: m.id, actor: "watch", decision: "handed", by: l.contextId, runId: r.id, reason: "先看一眼：要本人定" });
}

/**
 * escalate: what the probes and the first look found joins the batch (a message of its own, not the
 * owner's words), and the batch runs now — or a batch of its own when none is waiting.
 */
export function escalate(app: App, r: Run, input: FirstLookInput, messages: LookMessage[], o: Outcome, results: ProbeResult[], d: Delivered, held: Held): Promise<{ runId: string | null; detail: string }> {
  const l = input.listen!;
  const text = [
    `先看一眼看了这 ${messages.length} 条（${messages.map((m) => `飞书消息 ${m.id}`).join("、")}），要接着查。`,
    results.length ? `预查结果：\n${probesText(results, 2500)}` : "",
    o.by === "model" ? `已经知道的：${o.text || "（没写）"}${o.evidence ? `\n依据：${o.evidence}` : ""}\n还要查：${o.next || "（没写）"}${o.reason ? `\n为什么还要查：${o.reason}` : ""}` : `先看一眼没有结论：${o.reason ?? ""}`,
    d.to === "none" ? "第一条消息没有发出去。" : `第一条消息已经发到${DEST_TEXT[d.to]}，告诉了还在查什么；你的结论照这个关注的回复方式发。`,
  ].filter(Boolean).join("\n\n");
  return import("../agents/inbox.ts").then(async ({ receive }) => {
    const res = await receive(app, { conversationId: l.conversationId, channel: LISTEN_CHANNEL, speaker: "先看一眼", text, meta: { firstLook: r.id, addressed: true, chatId: input.chat.id }, mergeMs: 0, fixedWindow: true });
    // The batch it joined runs now (a fixed window is not brought forward by receive); other held batches go back to their time.
    if (res.runId) updateQueuedRun(app, res.runId, { notBefore: now() });
    release(app, held.filter((h) => h.id !== res.runId));
    return { runId: res.runId, detail: res.runId ? `交给关注的这一批，马上处理（${res.runId}）` : "没有交出去" };
  });
}

/** For the 关注 page: its recent first looks and how each went. */
export function recentLooks(app: App, contextId: string, limit = 20) {
  return all<{ id: string; status: string; created_at: string; output: string | null }>(app.db, "select id, status, created_at, output from runs where kind = 'first-look' and lane like ? order by created_at desc limit ?", `firstlook:listen:${contextId}:%`, limit)
    .map((x) => ({ id: x.id, status: x.status, at: x.created_at, outcome: (JSON.parse(x.output ?? "{}") as { outcome?: string }).outcome ?? null }));
}
