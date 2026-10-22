import type { App } from "../core/app.ts";
import { all, one, run as exec } from "../core/db.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { addMessage, findThread } from "./threads.ts";
import { cancelRun, createRun, getRun, queuedInLane, registerHandler, updateQueuedRun } from "./runs.ts";

/**
 * Wake-ups an agent sets for itself or for another agent: "look again in 20 minutes", "when someone
 * in this chat mentions the release, pick this up". A timed wake is a queued run (kind "wake") that
 * waits for its time; an event wake is a temporary rule (rules.temporary) whose only action is to
 * wake. Either way, waking means: the conversation's agent gets a turn with the note (its own
 * session continues), or an agent profile gets a run with the note as its task.
 */
export type WakeTarget = { conversationId?: string; spec?: string; resumeRunId?: string };
export type WakeInput = { note: string; target: WakeTarget; setBy: { runId: string | null; agent: string }; setAt: string; skipIfOwnerSpoke?: boolean };

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
  const timed = all<{ id: string; input: string; not_before: string }>(app.db, "select id, input, not_before from runs where kind = 'wake' and status = 'queued' order by not_before").map((r) => {
    const w = JSON.parse(r.input) as WakeInput;
    return { id: r.id, kind: "timed" as const, note: w.note, at: r.not_before, expiresAt: null, target: w.target, setBy: w.setBy, detail: `${r.not_before.slice(0, 16)} 唤醒` };
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
  const { target } = w;
  if (target.conversationId && w.skipIfOwnerSpoke && ownerSpokeSince(app, target.conversationId, w.setAt)) return { skipped: "本人之后已经说过话" };
  const stamp = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const body = `${w.setBy.agent} 在 ${stamp(w.setAt)} 设的唤醒，现在（${stamp(now())}）到了${trigger ? `；触发它的事件：${trigger}` : ""}。备注：${w.note}`;
  if (!target.spec) {
    const conversationId = target.conversationId!;
    if (!findThread(app, conversationId)) return { skipped: "会话已不存在" };
    const messageId = addMessage(app, conversationId, "assistant", body, null, { wake: { note: w.note, setAt: w.setAt, trigger: trigger ?? null }, record: true });
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
  const prev = target.resumeRunId ? (getRun(app, target.resumeRunId).output as { sessionId?: string }).sessionId : undefined;
  const r = createRun(app, {
    kind: "agent",
    spaceId: "personal",
    title: truncate(`${target.spec}（唤醒）：${w.note.replace(/\s+/g, " ")}`, 80),
    input: {
      spec: target.spec,
      task: `# 唤醒\n\n${body}\n\n${target.resumeRunId ? "这是你自己之前设的，接着当时的工作做。" : `这是 ${w.setBy.agent} 交给你的。`}没有需要告诉本人的就只回 QUIET。`,
      ...(target.conversationId ? { threadId: target.conversationId } : {}),
      ...(prev ? { resumeSessionId: prev } : {}),
    },
    parentId: w.setBy.runId,
  });
  return { runId: r.id };
}

registerHandler("wake", async (ctx) => {
  const w = ctx.run.input as WakeInput;
  const r = fireWake(ctx.app, w);
  return { quiet: false, summary: r.skipped ? `没有唤醒：${r.skipped}` : `已唤醒，运行 ${r.runId}`, runId: r.runId };
});

/** The turn's framing when a conversation's agent is woken (sessions.ts). */
export const WAKE_NOTE =
  "这是你（或别的 Agent）之前设的唤醒，不是本人发的消息。按备注接着做：查看进展、继续未完成的步骤。有需要本人知道或决定的再写给本人；没有新东西要说就只回 QUIET，本人不会收到任何消息。";

/** Temporary rules past their time (heartbeat). */
export async function expireTemporaryRules(app: App, at = now()) {
  const due = all<{ id: string }>(app.db, "select id from rules where temporary is not null and json_extract(temporary, '$.expiresAt') < ?", at);
  const { deleteRule } = await import("../rules/store.ts");
  for (const r of due) deleteRule(app, r.id);
  return due.length;
}
