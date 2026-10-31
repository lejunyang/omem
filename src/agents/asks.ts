import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, newId, now, truncate } from "../core/util.ts";
import { OWNER } from "../core/users.ts";

/**
 * Choices put in front of the owner while agents work, answered with one click (Feishu card, web)
 * or a reply in the same chat (a number picks an option):
 *
 * - question: an agent needs to know something to go on (`ask_owner`). It can wait for the answer
 *   inside its turn (`wait_answer`, a short wait per call so no client times out); an answer nobody
 *   waited for reaches the conversation as a message once the asking run has ended.
 * - suggestion: next steps offered with a reply (`suggest_next`). Clicking one says its message in
 *   the conversation for the owner, so the work moves on without retyping it.
 * - approval: a tool call held for the owner's OK (`approvals.tools`, empty by default). Approved
 *   calls run with the context they were made in; a refusal's reason goes back to the agent.
 */
export type AskKind = "question" | "suggestion" | "approval";
export type AskOption = { label: string; message?: string };
export type Ask = {
  id: string;
  runId: string | null;
  conversationId: string | null;
  userId: string;
  kind: AskKind;
  question: string;
  options: AskOption[];
  allowText: boolean;
  tool: string | null;
  args: Record<string, unknown> | null;
  status: "pending" | "answered" | "cancelled";
  answer: string | null;
  choice: number | null;
  approved: boolean | null;
  /** What running the approved tool returned (approvals only). */
  result: string | null;
  /** The agent already has the answer (waited for it, or the owner's message carried it). */
  consumed: boolean;
  /** Put in front of the owner (suggestions wait for the reply to be delivered first). */
  shownAt: string | null;
  createdAt: string;
  answeredAt: string | null;
  answeredBy: string | null;
  /** The host acts on the answer (review and coding decisions); free text in the chat does not answer it. */
  handler: string | null;
};

type Row = {
  id: string;
  run_id: string | null;
  conversation_id: string | null;
  user_id: string;
  kind: AskKind;
  question: string;
  options: string;
  allow_text: number;
  tool: string | null;
  args: string | null;
  context: string | null;
  status: Ask["status"];
  answer: string | null;
  choice: number | null;
  approved: number | null;
  result: string | null;
  consumed: number;
  shown_at: string | null;
  created_at: string;
  answered_at: string | null;
  answered_by: string | null;
};

const toAsk = (r: Row): Ask => ({
  id: r.id,
  runId: r.run_id,
  conversationId: r.conversation_id,
  userId: r.user_id,
  kind: r.kind,
  question: r.question,
  options: JSON.parse(r.options),
  allowText: !!r.allow_text,
  tool: r.tool,
  args: r.args ? JSON.parse(r.args) : null,
  status: r.status,
  answer: r.answer,
  choice: r.choice,
  approved: r.approved === null ? null : !!r.approved,
  result: r.result,
  consumed: !!r.consumed,
  shownAt: r.shown_at,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
  answeredBy: r.answered_by,
  handler: ((JSON.parse(r.context ?? "{}") as { handler?: unknown }).handler as string | undefined) ?? null,
});

export function getAsk(app: App, id: string): Ask {
  const r = one<Row>(app.db, "select * from asks where id = ?", id);
  if (!r) throw new HttpError(404, `没有这个提问：${id}`);
  return toAsk(r);
}

export function listAsks(app: App, opts: { status?: Ask["status"]; conversationId?: string; userId?: string; runId?: string; limit?: number } = {}): Ask[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.status) where.push("status = ?") && params.push(opts.status);
  if (opts.conversationId) where.push("conversation_id = ?") && params.push(opts.conversationId);
  if (opts.userId) where.push("user_id = ?") && params.push(opts.userId);
  if (opts.runId) where.push("run_id = ?") && params.push(opts.runId);
  return all<Row>(app.db, `select * from asks ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc limit ${opts.limit ?? 50}`, ...params).map(toAsk);
}

/** Channels that show asks (the Feishu bot registers one); `closed` updates what was shown once it is settled. */
type Sink = { show(app: App, ask: Ask): Promise<boolean>; closed?(app: App, ask: Ask): Promise<void> };
const sinks: Sink[] = [];
export function addAskSink(s: Sink) {
  sinks.push(s);
}

/** The conversation a run belongs to (answers come back there). */
export function conversationOfRun(app: App, runId: string | null): string | null {
  if (!runId) return null;
  const r = one<{ input: string }>(app.db, "select input from runs where id = ?", runId);
  const input = r ? (JSON.parse(r.input) as { conversationId?: string; threadId?: string }) : {};
  return input.conversationId ?? input.threadId ?? null;
}

export function createAsk(
  app: App,
  input: { runId: string | null; conversationId?: string | null; userId?: string; kind?: AskKind; question: string; options?: AskOption[]; allowText?: boolean; tool?: string; args?: Record<string, unknown>; context?: Record<string, unknown> },
): Ask {
  const id = newId("ask");
  const kind = input.kind ?? "question";
  const options = (input.options ?? []).filter((o) => o.label.trim()).slice(0, 6).map((o) => ({ label: o.label.trim().slice(0, 40), ...(o.message?.trim() ? { message: o.message.trim().slice(0, 2000) } : {}) }));
  // An agent's newer suggestions replace its older ones in the same conversation.
  const conversationId = input.conversationId !== undefined ? input.conversationId : conversationOfRun(app, input.runId);
  if (kind === "suggestion" && conversationId) cancelOpen(app, conversationId, "suggestion");
  run(
    app.db,
    "insert into asks(id,run_id,conversation_id,user_id,kind,question,options,allow_text,tool,args,context,status,consumed,created_at) values(?,?,?,?,?,?,?,?,?,?,?,'pending',0,?)",
    id,
    input.runId,
    conversationId,
    input.userId ?? OWNER,
    kind,
    input.question,
    JSON.stringify(options),
    input.allowText ?? kind !== "suggestion" ? 1 : 0,
    input.tool ?? null,
    input.args ? JSON.stringify(input.args) : null,
    input.context ? JSON.stringify(input.context) : null,
    now(),
  );
  const ask = getAsk(app, id);
  app.emit({ type: "ask", id, status: "pending", conversationId: ask.conversationId });
  // Suggestions belong under the reply: shown once the run has delivered it (settleAsks / showSuggestions).
  if (kind !== "suggestion") void show(app, ask);
  return ask;
}

async function show(app: App, ask: Ask) {
  run(app.db, "update asks set shown_at = coalesce(shown_at, ?) where id = ?", now(), ask.id);
  for (const s of sinks) {
    try {
      if (await s.show(app, ask)) return;
    } catch (e) {
      console.warn(`[omem] 提问 ${ask.id} 发送失败：${(e as Error).message}`);
    }
  }
  // No card for it: the web shows asks itself; text chats get a numbered list (a number picks);
  // an ask with no conversation is a notification pointing to the web.
  const channel = ask.conversationId ? one<{ channel: string }>(app.db, "select channel from conversations where id = ?", ask.conversationId)?.channel : null;
  if (channel && channel !== "web" && channel !== "cli") {
    const { deliverToThread } = await import("./inbox.ts");
    await deliverToThread(app, ask.conversationId!, askText(ask), { ask: ask.id });
  } else if (!ask.conversationId && ask.kind !== "suggestion") {
    const { notify } = await import("../core/notify.ts");
    notify(app, { userId: ask.userId, title: ask.kind === "approval" ? "有操作等你批准" : "有问题等你回答", body: askText(ask), link: "#/" });
  }
}

/** An ask as plain text, for chats without buttons. */
export function askText(ask: Ask) {
  const opts = ask.kind === "approval" ? ["批准", "拒绝"] : ask.options.map((o) => o.label);
  const head = ask.kind === "approval" ? "需要你批准：" : ask.kind === "question" ? "需要你回答：" : ask.question ? "" : "下一步可以：";
  const how = ask.kind === "approval" ? "回复“批准”或“拒绝 + 理由”。" : opts.length ? `回复编号选择${ask.handler ? (ask.allowText ? "，要补充就以选项开头接着写（如“" + opts[0] + "，另外……”）" : "") : ask.allowText ? "，或直接写你的回答" : ""}。` : "直接回复即可。";
  return `${head}${ask.question}\n${ask.kind === "approval" ? "" : opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n${how}`.replace(/\n{2,}/g, "\n").trim();
}

/** Show a finished run's suggestions now (a channel that has just posted the reply calls this). */
export async function showSuggestions(app: App, runId: string) {
  for (const r of all<Row>(app.db, "select * from asks where run_id = ? and kind = 'suggestion' and status = 'pending' and shown_at is null order by created_at", runId)) await show(app, toAsk(r));
}

/** The host's cards about one round of a coding delegation or branch review (review-chain.ts): a newer round, an apply or a discard answers them all. */
export const ROUND_ASKS = ["review-done", "review-plan", "review-escalation", "review-retry"];

/** Host asks of a run settled some other way (the owner acted on the web page): their cards stop taking answers. */
export function cancelHostAsks(app: App, runId: string, handler: string | string[]) {
  const names = Array.isArray(handler) ? handler : [handler];
  const open = all<Row>(app.db, `select * from asks where run_id = ? and status = 'pending' and json_extract(context, '$.handler') in (${names.map(() => "?").join(",")})`, runId, ...names).map(toAsk);
  if (!open.length) return;
  run(app.db, `update asks set status = 'cancelled', answered_at = ? where id in (${open.map(() => "?").join(",")})`, now(), ...open.map((a) => a.id));
  for (const a of open) closed(app, { ...a, status: "cancelled" });
}

/** One ask settled some other way (its task was decided on the web): the card stops taking answers. */
export function cancelAsk(app: App, id: string) {
  const r = one<Row>(app.db, "select * from asks where id = ? and status = 'pending'", id);
  if (!r) return;
  run(app.db, "update asks set status = 'cancelled', answered_at = ? where id = ?", now(), id);
  closed(app, { ...toAsk(r), status: "cancelled" });
}

function cancelOpen(app: App, conversationId: string, kind: AskKind) {
  const open = all<Row>(app.db, "select * from asks where conversation_id = ? and kind = ? and status = 'pending'", conversationId, kind).map(toAsk);
  if (!open.length) return;
  run(app.db, `update asks set status = 'cancelled', answered_at = ? where id in (${open.map(() => "?").join(",")})`, now(), ...open.map((a) => a.id));
  for (const a of open) closed(app, { ...a, status: "cancelled" });
}

function closed(app: App, ask: Ask) {
  app.emit({ type: "ask", id: ask.id, status: ask.status, conversationId: ask.conversationId });
  for (const s of sinks) s.closed?.(app, ask).catch(() => {});
}

const waiters = new Map<string, Set<(a: Ask) => void>>();

/** Wait up to `ms` for an answer; marks it consumed when it arrives while waiting. */
export function waitForAnswer(app: App, id: string, ms: number): Promise<Ask> {
  const first = getAsk(app, id);
  if (first.status !== "pending") return Promise.resolve(consume(app, first));
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set();
    waiters.set(id, set);
    const done = (a: Ask) => {
      clearTimeout(timer);
      set.delete(done);
      if (!set.size) waiters.delete(id);
      resolve(a.status === "pending" ? a : consume(app, a));
    };
    const timer = setTimeout(() => done(getAsk(app, id)), ms);
    set.add(done);
  });
}

function consume(app: App, a: Ask): Ask {
  if (!a.consumed) run(app.db, "update asks set consumed = 1 where id = ?", a.id);
  return { ...a, consumed: true };
}

/** An agent is inside `wait_answer` for this ask right now. */
export function isAwaited(id: string) {
  return (waiters.get(id)?.size ?? 0) > 0;
}

type Executor = (app: App, ask: Ask, context: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
let executor: Executor | null = null;
/** tools.ts registers how an approved call runs (kept apart to avoid an import cycle). */
/**
 * Asks the host itself put to the owner (a review plan to confirm, a stopped review to decide):
 * the answer runs a registered handler instead of going back to an agent as a message.
 */
type AskHandler = (app: App, ask: Ask, context: Record<string, unknown>) => Promise<void>;
const askHandlers = new Map<string, AskHandler>();
export function registerAskHandler(name: string, h: AskHandler) {
  askHandlers.set(name, h);
}

export function setApprovalExecutor(e: Executor) {
  executor = e;
}

/**
 * Record an answer: a choice (index into the options), free text, or approve/refuse. Then an
 * agent waiting gets it; a suggestion says its message in the conversation; anything else goes
 * to the conversation as a message once the asking run has ended (`viaMessage`: the owner's own
 * chat message already carried it).
 */
export async function answerAsk(app: App, id: string, input: { choice?: number | null; text?: string; approved?: boolean; by: string; viaMessage?: boolean }): Promise<Ask> {
  const before = getAsk(app, id);
  if (before.status !== "pending") throw new HttpError(409, before.status === "cancelled" ? "这个提问已经失效了" : "这个提问已经回答过了");
  const option = input.choice !== undefined && input.choice !== null ? before.options[input.choice] : undefined;
  if (input.choice !== undefined && input.choice !== null && !option) throw new HttpError(400, "没有这个选项");
  const text = input.text?.trim() || null;
  if (before.kind === "question" && !option && !text) throw new HttpError(400, "回答不能为空");
  const approved = before.kind === "approval" ? !!input.approved : null;
  const answer = [option?.label, text].filter(Boolean).join("：") || null;
  const changed = run(
    app.db,
    "update asks set status = 'answered', answer = ?, choice = ?, approved = ?, answered_at = ?, answered_by = ?, consumed = ? where id = ? and status = 'pending'",
    answer,
    option ? input.choice! : null,
    approved === null ? null : approved ? 1 : 0,
    now(),
    input.by,
    input.viaMessage || before.kind === "suggestion" ? 1 : 0,
    id,
  ).changes;
  if (!changed) throw new HttpError(409, "这个提问已经回答过了");
  if (before.kind === "approval" && approved && executor) {
    const ctx = JSON.parse(one<{ context: string | null }>(app.db, "select context from asks where id = ?", id)?.context ?? "{}");
    const r = await executor(app, getAsk(app, id), ctx).catch((e: Error) => ({ text: e.message, isError: true }));
    run(app.db, "update asks set result = ? where id = ?", `${r.isError ? "失败：" : ""}${truncate(r.text, 4000)}`, id);
  }
  const ask = getAsk(app, id);
  closed(app, ask);
  const context = JSON.parse(one<{ context: string | null }>(app.db, "select context from asks where id = ?", id)?.context ?? "{}") as Record<string, unknown>;
  const handler = typeof context.handler === "string" ? askHandlers.get(context.handler) : undefined;
  if (handler) {
    run(app.db, "update asks set consumed = 1 where id = ?", id);
    await handler(app, ask, context);
    return getAsk(app, id);
  }
  if (ask.kind === "suggestion") {
    if (ask.conversationId && !input.viaMessage) {
      const { receive } = await import("./inbox.ts");
      await receive(app, { conversationId: ask.conversationId, text: option?.message ?? answer ?? "", userId: ask.userId, fromAsk: true });
    }
    return ask;
  }
  const set = waiters.get(id);
  if (set?.size) for (const w of [...set]) w(ask);
  else if (!ask.consumed && !runActive(app, ask.runId)) await deliverAnswer(app, ask);
  return getAsk(app, id);
}

function runActive(app: App, runId: string | null) {
  if (!runId) return false;
  const s = one<{ status: string }>(app.db, "select status from runs where id = ?", runId)?.status;
  return s === "running" || s === "queued";
}

/** How an answer reads for the agent. */
export function describeAnswer(a: Ask): string {
  if (a.status === "pending") return `本人还没回答（${a.id}）。`;
  if (a.status === "cancelled") return `提问 ${a.id} 已失效（本人已经在对话里接着说了）。`;
  if (a.kind === "approval")
    return a.approved
      ? `本人批准了 ${a.tool}${a.answer ? `（附言：${a.answer}）` : ""}。执行结果：${a.result ?? "（无）"}`
      : `本人拒绝了 ${a.tool}${a.answer ? `，理由：${a.answer}` : "（没有说理由）"}。按理由调整做法，不要换个方式绕过。`;
  return `本人回答了「${truncate(a.question, 80)}」：${a.answer ?? "（空）"}`;
}

/** An answer nobody waited for: a message in the conversation, so the next turn has it. */
async function deliverAnswer(app: App, ask: Ask) {
  run(app.db, "update asks set consumed = 1 where id = ?", ask.id);
  if (!ask.conversationId) {
    const { notify } = await import("../core/notify.ts");
    notify(app, { userId: ask.userId, title: "已记下你的回答", body: `${describeAnswer(ask)}\n提问的任务已经结束；需要接着做时在对话里说一声。`, entity: "run", entityId: ask.runId ?? undefined });
    return;
  }
  const { receive } = await import("./inbox.ts");
  await receive(app, { conversationId: ask.conversationId, text: `[回答] ${describeAnswer(ask)}`, userId: ask.userId, fromAsk: true });
}

/**
 * A run ended: answers that came in while it was working go to its conversation, and its
 * suggestions are shown — after a moment, so a channel posting the reply itself goes first.
 */
export async function settleAsks(app: App, runId: string) {
  for (const r of all<Row>(app.db, "select * from asks where run_id = ? and kind != 'suggestion' and status = 'answered' and consumed = 0", runId)) await deliverAnswer(app, toAsk(r));
  const t = setTimeout(() => void showSuggestions(app, runId).catch(() => {}), 4000);
  t.unref();
}

/**
 * The owner wrote in a conversation with open asks. A bare number picks that option of the
 * newest one with options; an approval needs a clear 批准/拒绝; otherwise the message answers an
 * open question, and open suggestions lapse (the owner went another way). Returns true when the
 * message was taken as an answer by an agent waiting for it, so it must not start another turn.
 *
 * Questions the host acts on (`context.handler`: start a round, apply, confirm a plan) are not
 * answered by whatever the owner writes next — that is usually meant for the assistant. They take
 * a bare number or a message that starts with one of their options (“按评审修改，另外……”).
 */
export async function answerFromMessage(app: App, conversationId: string, text: string, userId: string): Promise<boolean> {
  const open = all<Row>(app.db, "select * from asks where conversation_id = ? and user_id = ? and status = 'pending' and shown_at is not null order by created_at desc", conversationId, userId).map(toAsk);
  if (!open.length) return false;
  const pick = /^\s*(\d{1,2})\s*[.。、)）]?\s*$/.exec(text);
  if (pick) {
    const a = open.find((x) => x.options.length && x.kind !== "approval");
    const i = Number(pick[1]) - 1;
    // A bare number means nothing to an agent: the picked option itself is what gets delivered.
    if (a && a.options[i]) {
      await answerAsk(app, a.id, { choice: i, by: userId });
      return true;
    }
  }
  let taken = false;
  for (const a of open) {
    if (a.kind === "approval") {
      const m = /^\s*(批准|同意|可以|允许|拒绝|不行|不同意|不要)[，,。:：\s]*([\s\S]*)$/.exec(text);
      if (!m || taken) continue;
      taken = isAwaited(a.id);
      await answerAsk(app, a.id, { approved: /^(批准|同意|可以|允许)$/.test(m[1]), text: m[2], by: userId, viaMessage: !taken });
      if (taken) return true;
      taken = true;
    } else if (a.kind === "question" && !taken && a.handler) {
      const t = text.trim();
      const i = a.options.findIndex((o) => t === o.label || (t.startsWith(o.label) && /^[，,。:：\s]/.test(t.slice(o.label.length))));
      if (i < 0) continue;
      await answerAsk(app, a.id, { choice: i, text: t.slice(a.options[i].label.length).replace(/^[，,。:：\s]+/, ""), by: userId });
      return true;
    } else if (a.kind === "question" && !taken) {
      const awaited = isAwaited(a.id);
      await answerAsk(app, a.id, { text, by: userId, viaMessage: !awaited });
      if (awaited) return true;
      taken = true;
    }
  }
  cancelOpen(app, conversationId, "suggestion");
  return false;
}
