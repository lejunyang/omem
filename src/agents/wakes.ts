import type { App } from "../core/app.ts";
import { all, one, run as exec, withinTx } from "../core/db.ts";
import { HttpError, now, truncate, localStamp } from "../core/util.ts";
import { addMessage, findThread } from "./threads.ts";
import { homeFor } from "./home.ts";
import { cancelRun, createRun, getRun, queuedInLane, registerHandler, updateQueuedRun } from "./runs.ts";

/**
 * Wake-ups an agent sets for itself or for another agent: "look again in 20 minutes", "when someone
 * in this chat mentions the release, pick this up". A timed wake is a queued run (kind "wake") that
 * waits for its time; an event wake is a temporary rule (rules.temporary) whose only action is to
 * wake. Either way, waking means: the conversation's agent gets a turn with the note (its own
 * session continues), or an agent profile gets a run with the note as its task.
 */
export type WakeTarget = { conversationId?: string; spec?: string; resumeRunId?: string };
export type WakeInput = {
  note: string; target: WakeTarget; setBy: { runId: string | null; agent: string }; setAt: string; skipIfOwnerSpoke?: boolean; onRunEnd?: { runId: string; purpose: string; expiresAt: string };
  /** A run_agent report handed back to the conversation's assistant (returnChildReport): skipped when the turn that handed it out read it. */
  childReport?: { runId: string; parentId: string | null; agent?: string; head?: string; report?: string };
};

export const MAX_PENDING = 5;
export const MAX_DAYS = 7;

/** "20m", "2h", "1d", an ISO time; must be between a minute and MAX_DAYS away. */
export function wakeTime(when: string, from = Date.now()) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d)$/i.exec(when.trim());
  const t = m ? from + Number(m[1]) * { s: 1000, m: 60_000, min: 60_000, h: 3600_000, d: 86400_000 }[m[2].toLowerCase() as "s"] : Date.parse(when);
  if (Number.isNaN(t)) throw new HttpError(400, `看不懂时间：${when}（用 20m、2h、1d 或带时区的 ISO 时间）`);
  if (t < from + 55_000) throw new HttpError(400, "至少一分钟以后");
  if (t > from + MAX_DAYS * 86400_000) throw new HttpError(400, `最多 ${MAX_DAYS} 天以后；更久的事建提醒事项（upsert_item 的 remind_at）`);
  return new Date(t).toISOString();
}

/** Who set it, to count the pending ones: a conversation, else an agent profile. */
const ownerKey = (t: WakeTarget, setBy: WakeInput["setBy"]) => t.conversationId ?? `${t.spec ?? setBy.agent}`;

export type PendingWake = { id: string; kind: "timed" | "event"; note: string; at: string | null; expiresAt: string | null; target: WakeTarget; setBy: WakeInput["setBy"]; detail: string };

export function pendingWakes(app: App, opts: { conversationId?: string; spec?: string } = {}): PendingWake[] {
  const timed = all<{ id: string; input: string; not_before: string | null }>(app.db, "select id, input, not_before from runs where kind = 'wake' and status = 'queued' and json_extract(input,'$.supervisorTimer') is null order by not_before").map((r) => {
    const w = JSON.parse(r.input) as WakeInput;
    return w.onRunEnd
      ? { id: r.id, kind: "event" as const, note: w.note, at: null, expiresAt: w.onRunEnd.expiresAt, target: w.target, setBy: w.setBy, detail: `编码轮次 ${w.onRunEnd.runId} 结束` }
      : { id: r.id, kind: "timed" as const, note: w.note, at: r.not_before, expiresAt: null, target: w.target, setBy: w.setBy, detail: r.not_before ? `${localStamp(r.not_before, app.config.timezone)} 唤醒` : "等待唤醒" };
  });
  const events = all<{ id: string; description: string; temporary: string; actions: string }>(app.db, "select id, description, temporary, actions from rules where temporary is not null and enabled = 1 order by created_at").map((r) => {
    const t = JSON.parse(r.temporary) as { expiresAt: string; setBy: WakeInput["setBy"]; watch: string };
    const a = (JSON.parse(r.actions) as { type: string; target?: WakeTarget; note?: string }[]).find((x) => x.type === "wake");
    return { id: r.id, kind: "event" as const, note: a?.note ?? r.description, at: null, expiresAt: t.expiresAt, target: a?.target ?? {}, setBy: t.setBy, detail: t.watch };
  });
  return [...timed, ...events].filter((w) => (!opts.conversationId || w.target.conversationId === opts.conversationId) && (!opts.spec || w.target.spec === opts.spec));
}

export function checkPending(app: App, target: WakeTarget, setBy: WakeInput["setBy"]) {
  const key = ownerKey(target, setBy);
  const n = pendingWakes(app).filter((w) => ownerKey(w.target, w.setBy) === key).length;
  if (n >= MAX_PENDING) throw new HttpError(400, `已经有 ${n} 个没触发的唤醒了（上限 ${MAX_PENDING}）：先用 cancel_wake 取消不需要的`);
}

export function scheduleWake(app: App, input: Omit<WakeInput, "setAt"> & { at: string }) {
  checkPending(app, input.target, input.setBy);
  const w: WakeInput = { note: input.note, target: input.target, setBy: input.setBy, setAt: now(), ...(input.skipIfOwnerSpoke ? { skipIfOwnerSpoke: true } : {}) };
  return createRun(app, { kind: "wake", title: truncate(`唤醒：${input.note.replace(/\s+/g, " ")}`, 80), input: w, notBefore: input.at, parentId: input.setBy.runId });
}

export function scheduleRoundWake(app: App, input: Omit<WakeInput, "setAt" | "onRunEnd">, runId: string, purpose?: string) {
  return withinTx(app.db, () => {
    const code = getRun(app, runId);
    if (code.kind !== "code") throw new HttpError(400, "on_run_end.run_id 要写这一次编码轮次的运行 id，不写交办会话 id");
    const key = (purpose ?? input.note).trim().replace(/\s+/g, " ");
    if (!key) throw new HttpError(400, "要写清醒来后做什么");
    const existing = one<{ id: string }>(app.db, `select id from runs where kind = 'wake' and status = 'queued'
      and json_extract(input, '$.onRunEnd.runId') = ? and json_extract(input, '$.onRunEnd.purpose') = ?
      and coalesce(json_extract(input, '$.target.conversationId'), '') = ? and coalesce(json_extract(input, '$.target.spec'), '') = ?
      and json_extract(input, '$.onRunEnd.expiresAt') > ? limit 1`, runId, key, input.target.conversationId ?? "", input.target.spec ?? "", now());
    if (existing) return { id: existing.id, existing: true };
    checkPending(app, input.target, input.setBy);
    const w: WakeInput = { ...input, setAt: now(), onRunEnd: { runId, purpose: key, expiresAt: new Date(Date.now() + MAX_DAYS * 86400_000).toISOString() } };
    const r = createRun(app, { kind: "wake", title: truncate(`唤醒：${input.note.replace(/\s+/g, " ")}`, 80), input: w, parentId: input.setBy.runId });
    return { id: r.id, existing: false };
  });
}

export function cancelWake(app: App, id: string) {
  if (id.startsWith("rule")) {
    const r = one<{ temporary: string | null }>(app.db, "select temporary from rules where id = ?", id);
    if (!r?.temporary) throw new HttpError(404, "没有这个唤醒");
    void import("../rules/store.ts").then((m) => m.deleteRule(app, id));
    return;
  }
  const r = getRun(app, id);
  if (r.kind !== "wake") throw new HttpError(404, "没有这个唤醒");
  if (r.status === "queued") cancelRun(app, id);
}

function ownerSpokeSince(app: App, conversationId: string, since: string) {
  return !!one(app.db, "select 1 from messages where conversation_id = ? and role = 'user' and created_at > ? and json_extract(meta, '$.speaker') is null and json_extract(meta, '$.asker') is null", conversationId, since);
}

/**
 * Wake now. In a conversation: a note in it and a turn for its agent (merged into a turn already
 * waiting there). An agent profile: a run with the note as its task, continuing its session when
 * it set the wake for itself, reporting to the conversation it was set from.
 */
export function fireWake(app: App, w: WakeInput, trigger?: string): { runId?: string; skipped?: string } {
  const situation = w.target.conversationId && one<{ status: string; window_until: string; closing_run: string | null }>(app.db, "select status,window_until,closing_run from situation_instances where conversation_id=?", w.target.conversationId);
  if (situation && (situation.status !== "active" || situation.closing_run || situation.window_until <= now())) return { skipped: "这一次跟进的窗口已结束" };
  // Set where the work was then; the owner may have carried it on elsewhere since (agents/home.ts).
  const target = w.target.conversationId && !situation ? { ...w.target, conversationId: homeFor(app, w.setBy.runId, w.target.conversationId, w.setAt) } : w.target;
  if (target.conversationId && w.skipIfOwnerSpoke && ownerSpokeSince(app, target.conversationId, w.setAt)) return { skipped: "本人之后已经说过话" };
  const stamp = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const body = w.childReport ? w.note : `${w.setBy.agent} 在 ${stamp(w.setAt)} 设的唤醒，现在（${stamp(now())}）到了${trigger ? `；触发它的事件：${trigger}` : ""}。备注：${w.note}`;
  if (!target.spec) {
    const conversationId = target.conversationId!;
    if (!findThread(app, conversationId)) return { skipped: "会话已不存在" };
    const handed = w.childReport?.report !== undefined ? w.childReport : null;
    const messageId = handed
      ? addMessage(app, conversationId, "assistant", handed.report!, null, { wake: { note: handed.head ?? "", setAt: w.setAt, trigger: trigger ?? null, report: { agent: handed.agent ?? w.setBy.agent, runId: handed.runId } }, record: true })
      : addMessage(app, conversationId, "assistant", body, null, { wake: { note: w.note, setAt: w.setAt, trigger: trigger ?? null }, record: true });
    const waiting = queuedInLane(app, conversationId, "ask");
    if (waiting) {
      const ids = [...((waiting.input.messageIds as string[] | undefined) ?? []), messageId];
      if (updateQueuedRun(app, waiting.id, { input: { ...waiting.input, messageIds: ids, wake: true } })) return { runId: waiting.id };
    }
    const r = createRun(app, {
      kind: "ask",
      spaceId: findThread(app, conversationId)!.spaceId,
      title: truncate(`唤醒：${w.note.replace(/\s+/g, " ")}`, 60),
      input: { conversationId, messageIds: [messageId], wake: true },
      lane: conversationId,
      parentId: w.setBy.runId,
    });
    exec(app.db, "update messages set run_id = ? where id = ?", r.id, messageId);
    return { runId: r.id };
  }
  const origin = target.resumeRunId ? getRun(app, target.resumeRunId) : null;
  const originInput = (origin?.input ?? {}) as { spec?: string; lark?: unknown; replyAt?: unknown; silent?: unknown; rule?: unknown; assistantScope?: unknown; denyTools?: unknown; execution?: unknown; fullAccess?: unknown };
  // Only a profile continuing its own run inherits that run's delivery scope.
  // Delegating a wake to another profile does not grant it the caller's channel permissions.
  const ownRun = originInput.spec === target.spec;
  const userId = ownRun && origin ? one<{ user_id: string | null }>(app.db, "select user_id from runs where id = ?", origin.id)?.user_id : null;
  const prev = ownRun ? (origin?.output as { sessionId?: string } | undefined)?.sessionId : undefined;
  const delivery = ownRun ? Object.fromEntries(["lark", "replyAt", "silent", "rule", "assistantScope", "denyTools", "execution", "fullAccess"].filter(k => k in originInput).map(k => [k, originInput[k as keyof typeof originInput]])) : {};
  const r = createRun(app, {
    kind: "agent",
    spaceId: ownRun ? origin?.spaceId ?? "personal" : "personal",
    title: truncate(`${target.spec}（唤醒）：${w.note.replace(/\s+/g, " ")}`, 80),
    input: {
      spec: target.spec,
      wake: true,
      ...delivery,
      task: `# 唤醒\n\n${body}\n\n${ownRun ? "这是你自己之前设的，接着当时的工作做。" : `这是 ${w.setBy.agent} 交给你的。`}没有需要告诉本人的就调用 stay_quiet 结束这一轮。`,
      ...(target.conversationId ? { threadId: target.conversationId } : {}),
      ...(prev ? { resumeSessionId: prev } : {}),
    },
    parentId: w.setBy.runId,
    ...(userId ? { userId } : {}),
  });
  return { runId: r.id };
}

/**
 * A plain run_agent (no own topic) finished: its report goes back to the assistant of the conversation
 * it was handed out from, never straight to the chat — the full report of an investigation is material
 * for a reply, not the reply. While the turn that handed it out is still going, this waits for that
 * turn to end (it may be reading the report with read_run); then the assistant gets one turn with the
 * report, unless that turn already read it after it was done.
 */
export function returnChildReport(app: App, child: { id: string; parentId: string | null }, conversationId: string, agent: string, task: string, answer: string) {
  const parentId = child.parentId;
  const parentLive = !!parentId && !!one(app.db, "select 1 from runs where id = ? and status in ('queued','running')", parentId);
  // The conversation keeps the report itself (folded on the page); the instructions only go into
  // the assistant's turn (sessions.ts renderMessages).
  const head = [
    `${agent} 交回了「${truncate(task.replace(/\s+/g, " "), 60)}」的报告（运行 ${child.id}）。这是交给你的材料，本人和提问的人都还没看到。`,
    "按报告给本会话写回复：给结论和要紧的依据，不复述它的过程，不整段转贴；交办它的那一轮已经说过的不重复。报告里没有新东西、或已经回答过了，调用 stay_quiet。",
  ].join("\n");
  const report = [truncate(answer, 8000), ...(answer.length > 8000 ? ["", `（报告较长，全文用 read_run ${child.id} 看）`] : [])].join("\n");
  const note = `${head}\n\n${report}`;
  const w: WakeInput = {
    note, target: { conversationId }, setBy: { runId: parentId, agent }, setAt: now(),
    childReport: { runId: child.id, parentId, agent, head, report },
    ...(parentLive ? { onRunEnd: { runId: parentId!, purpose: `report:${child.id}`, expiresAt: new Date(Date.now() + 86400_000).toISOString() } } : {}),
  };
  return createRun(app, { kind: "wake", title: truncate(`交回报告：${agent}`, 80), input: w, parentId: child.id });
}

/** The turn that handed a run_agent out read its report (read_run, directly or through omem_call) after it was done. */
function reportReadBy(app: App, parentId: string, childId: string) {
  const done = one<{ finished_at: string | null }>(app.db, "select finished_at from runs where id = ?", childId)?.finished_at;
  if (!done) return false;
  return !!one(app.db, `select 1 from run_events where run_id = ? and type = 'tool' and at >= ? and instr(data, ?) > 0 and instr(data, 'read_run') > 0
    and json_extract(data, '$.status') = 'completed' limit 1`, parentId, done, childId);
}

registerHandler("wake", async (ctx) => {
  if (typeof ctx.run.input.supervisorTimer === "string")
    return (await import("./supervisor.ts")).checkSupervisorTimer(ctx.app, ctx.run.input.supervisorTimer, ctx.run.input.purpose as string);
  const w = ctx.run.input as WakeInput;
  if (w.childReport?.parentId && reportReadBy(ctx.app, w.childReport.parentId, w.childReport.runId))
    return { quiet: true, summary: `没有唤醒：交办它的那一轮（${w.childReport.parentId}）已经读过这份报告` };
  const code = w.onRunEnd && one<{ id: string; status: string }>(ctx.app.db, "select id, status from runs where id = ? and finished_at <= ? and status in ('done','failed','cancelled')", w.onRunEnd.runId, w.onRunEnd.expiresAt);
  const r = w.onRunEnd && !code ? { skipped: "等待编码轮次结束已到期" } : fireWake(ctx.app, w, code && !w.childReport ? `编码轮次 ${code.id} 已结束（${code.status}）` : undefined);
  // Bookkeeping: the turn it starts is listed on its own.
  return { quiet: true, summary: r.skipped ? `没有唤醒：${r.skipped}` : `已唤醒，运行 ${r.runId}`, runId: r.runId };
});

/** The turn's framing when a conversation's agent is woken (sessions.ts). */
export const WAKE_NOTE =
  "这是你（或别的 Agent）之前设的唤醒，不是本人发的消息。按备注接着做：查看进展、继续未完成的步骤。只有要本人做或决定的事，或者事情有了结果（办成、办不成、对方不用了），才写给本人；别人还在跟、你又排了下次复查这类进展，记进事项就够了，调用 stay_quiet（写一句原因）结束这一轮，本人不会收到任何消息。写给本人时不要重复之前已经告诉过本人的内容。";

/** Temporary rules past their time (heartbeat). */
export async function expireTemporaryRules(app: App, at = now()) {
  const due = all<{ id: string }>(app.db, "select id from rules where temporary is not null and json_extract(temporary, '$.expiresAt') < ?", at);
  const { deleteRule } = await import("../rules/store.ts");
  for (const r of due) deleteRule(app, r.id);
  return due.length;
}
