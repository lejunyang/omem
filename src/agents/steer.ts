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
