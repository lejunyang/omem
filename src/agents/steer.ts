import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { addRunEvent, cancelRun, queuedInLane, setRunOutput, updateQueuedRun } from "./runs.ts";
import { renderMessages } from "./sessions.ts";
import { threadMessages } from "./threads.ts";

/**
 * Messages sent to a conversation while its turn is running reach that turn at its next tool call
 * (after the tool's result), the way one adds a note to a coding agent mid-task: the turn takes
 * them into account without being interrupted or redone. Until a tool call picks them up they wait
 * in the conversation's next queued turn, which runs as before when the turn ends first (or calls
 * no more tools). Messages picked up leave that turn; an emptied turn is dropped.
 */
export function takeSteering(app: App, runId: string): string | null {
  const r = one<{ kind: string; status: string; lane: string | null; input: string }>(app.db, "select kind, status, lane, input from runs where id = ?", runId);
  if (r?.kind === "agent" && r.status === "running" && r.lane?.startsWith("rule:")) return takeTriggers(app, runId, r.lane, JSON.parse(r.input));
  if (!r || r.kind !== "ask" || r.status !== "running" || !r.lane) return null;
  const input = JSON.parse(r.input) as { conversationId?: string; userId?: string };
  if (!input.conversationId) return null;
  const next = queuedInLane(app, r.lane, "ask");
  // Only the same sender's words: each turn runs with its sender's permissions.
  if (!next || ((next.input.userId as string | undefined) ?? OWNER) !== (input.userId ?? OWNER)) return null;
  const ids = (next.input.messageIds as string[] | undefined) ?? [];
  const msgs = threadMessages(app, input.conversationId, { limit: 400 }).filter((m) => ids.includes(m.id) && m.role === "user" && !m.meta.answer);
  if (!msgs.length) return null;
  const taken = new Set(msgs.map((m) => m.id));
  const rest = ids.filter((id) => !taken.has(id));
  if (rest.length) {
    if (!updateQueuedRun(app, next.id, { input: { ...next.input, messageIds: rest } })) return null;
  } else {
    // Whoever waits for that turn's answer (a chat channel) learns it was taken by this one.
    setRunOutput(app, next.id, { steeredInto: runId });
    cancelRun(app, next.id);
    if (one<{ status: string }>(app.db, "select status from runs where id = ?", next.id)?.status !== "cancelled") return null;
  }
  for (const id of taken) run(app.db, "update messages set run_id = ? where id = ?", runId, id);
  const before = (one<{ s: string | null }>(app.db, "select json_extract(output, '$.steered') s from runs where id = ?", runId)?.s);
  setRunOutput(app, runId, { steered: [...(before ? (JSON.parse(before) as string[]) : []), ...taken] });
  addRunEvent(app, runId, "status", { text: `收到 ${taken.size} 条补充消息，交给正在进行的这一轮` });
  return [
    "",
    "---",
    "# 你工作期间收到的新消息",
    "",
    renderMessages(msgs, app),
    "",
    "结合它们继续当前的工作，不用停下重来；和正在做的事冲突时以新消息为准。最后的回复要一并回应它们。",
  ].join("\n");
}

type Trigger = { messageId: string | null; topicId: string | null; at: string; summary: string };

/**
 * The same rule fired again in this chat while this run works on it (rules/actions.ts joinLane): the
 * triggers waiting in the lane's next run come to this one, which drops that run.
 */
function takeTriggers(app: App, runId: string, lane: string, input: { rule?: { id?: string }; lark?: { chats?: string[] | null } }): string | null {
  const next = queuedInLane(app, lane, "agent");
  if (!next || (next.input.rule as { id?: string } | undefined)?.id !== input.rule?.id) return null;
  const triggers = (next.input.triggers as Trigger[] | undefined) ?? [];
  if (!triggers.length) return null;
  setRunOutput(app, next.id, { steeredInto: runId });
  cancelRun(app, next.id);
  if (one<{ status: string }>(app.db, "select status from runs where id = ?", next.id)?.status !== "cancelled") return null;
  const more = (next.input.moreTriggers as number | undefined) ?? 0;
  const before = one<{ s: string | null }>(app.db, "select json_extract(output, '$.joinedTriggers') s from runs where id = ?", runId)?.s;
  setRunOutput(app, runId, { joinedTriggers: (before ? Number(before) : 0) + triggers.length + more });
  addRunEvent(app, runId, "status", { text: `规则又触发了 ${triggers.length + more} 次，并入正在进行的这一轮` });
  return ["", "---", triggerNote(triggers, more, !!input.lark?.chats?.length, "你处理期间")].join("\n");
}

/** The joined triggers as the agent reads them, and how to answer them (also for a run that starts with several, jobs.ts). */
export function triggerNote(triggers: Trigger[], more: number, canPost: boolean, when: string) {
  return [
    `# ${when}同一条规则又触发了 ${triggers.length + more} 次`,
    "",
    ...triggers.map((t) => `- ${t.summary.replace(/\n+/g, " ")}${t.messageId ? `（飞书消息 ${t.messageId}${t.topicId ? `，话题 ${t.topicId}` : ""}）` : ""}`),
    more ? `- ……另有 ${more} 条，没有列出` : "",
    "",
    "它们并进了你这一轮：不用重新开始，结合它们接着处理。原因相同的一起下结论，不要逐条重复同样的话；",
    canPost
      ? "要分别答复的，用 lark_send 回复对应的消息（reply_to 填它的消息 id，in_thread=true），或在最后的回答里写明结论覆盖了哪几条。"
      : "最后的回答里写明结论覆盖了哪几条。",
  ].filter((x) => x !== "").join("\n");
}
