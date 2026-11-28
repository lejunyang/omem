import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { HttpError, now } from "../core/util.ts";
import { addMessage, getThread } from "./threads.ts";
import { followAiLabel, getLongTask, startLongTask, type FollowKind, type LongTask } from "./long-tasks.ts";

type Source = { kind: FollowKind; sourceId: string; userId: string; spaceId: string; threadId?: string | null; goal: string };

function sourceTask(app: App, kind: FollowKind, id: string) {
  const row = one<{ id: string }>(app.db, "select id from long_tasks where source_kind=? and source_id=?", kind, id);
  return row ? getLongTask(app, row.id) : null;
}

function open(task: LongTask | null) {
  return task && task.status !== "ended" && task.status !== "done" ? task : null;
}

export function autoFollowFor(app: App, kind: FollowKind, id: string) {
  return open(sourceTask(app, kind, id));
}

export function ensureAutoFollow(app: App, source: Source): LongTask | null {
  return withinTx(app.db, () => {
    const existing = sourceTask(app, source.kind, source.sourceId);
    // Ended attachments retain the owner's choice across later rounds and service restarts.
    if (existing) return open(existing);
    if (!app.config.longTasks.auto[source.kind === "study" ? "studies" : source.kind]) return null;
    let task: LongTask;
    try {
      task = startLongTask(app, { userId: source.userId, spaceId: source.spaceId, threadId: source.threadId ?? undefined,
        goal: source.goal }, { kind: source.kind, id: source.sourceId });
    } catch (error) {
      // Invalid or missing AI settings must leave the original work available.
      if (!(error instanceof HttpError)) throw error;
      console.warn(`[omem] ${source.kind} ${source.sourceId} 沿用原方式：${error.message}`);
      return null;
    }
    const text = `这件事较长，由 ${followAiLabel(task.ai)} 跟进；说“不用跟进”就回到原来的方式。`;
    const notice = queueThreadNotice(app, source.threadId ?? task.threadId, text, { autoFollowId: task.id });
    run(app.db, "update long_tasks set state=json_set(state,'$.notice',?) where id=?", notice, task.id);
    return task;
  });
}

/** Save a host notice with the work that caused it. Channel delivery starts after the transaction. */
function queueThreadNotice(app: App, threadId: string, text: string, meta: Record<string, unknown>) {
  const thread = getThread(app, threadId);
  const messageId = addMessage(app, thread.id, "assistant", text, null, { ...meta, command: true });
  app.emit({ type: "conversation", conversationId: threadId });
  if (thread.channel !== "web" && thread.channel !== "cli") {
    run(app.db, "insert into kv(key,value) values(?,?)", `recovered-reply:${messageId}`, JSON.stringify({ threadId, messageId, at: now() }));
    void import("./inbox.ts").then(m => m.flushRecoveredReplies(app)).catch(e => console.warn("[omem] 发送跟进提示失败", e));
  }
  return messageId;
}

/** A bare opt-out in a parent conversation is only actionable when it identifies a single task. */
export function autoFollowInOrigin(app: App, threadId: string, userId: string) {
  const rows = all<{ id: string }>(app.db, `select t.id from conversations c
    join long_tasks t on t.thread_id=c.id where c.parent_id=? and t.user_id=?
    and t.source_kind is not null and t.status in ('active','paused','draft') limit 2`, threadId, userId);
  return rows.length === 1 ? getLongTask(app, rows[0].id) : null;
}
