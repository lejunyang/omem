import type { App } from "../core/app.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { HttpError, now } from "../core/util.ts";
import { addMessage, getThread } from "./threads.ts";
import { followAiLabel, getLongTask, startLongTask, type FollowKind, type LongTask } from "./long-tasks.ts";

/** `explicit`: the owner asked for it, so neither the auto switches nor an earlier "不用跟进" stop it, and errors surface. */
type Source = { sourceId: string; userId: string; spaceId: string; threadId?: string | null; goal: string; explicit?: boolean }
  & ({ kind: "study"; startingRound?: boolean } | { kind: Exclude<FollowKind, "study"> });

function sourceTask(app: App, kind: FollowKind, id: string) {
  const row = one<{ id: string }>(app.db, "select id from long_tasks where source_kind=? and source_id=? order by source_generation desc limit 1", kind, id);
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
    // A new research round can follow a completed one. An owner opt-out stays attached as "ended" until the owner asks again.
    if (source.explicit ? open(existing) : existing && !(source.kind === "study" && source.startingRound && existing.status === "done")) return open(existing);
    if (!source.explicit && !app.config.longTasks.auto[source.kind === "study" ? "studies" : source.kind]) return null;
    const threadId = source.threadId ?? (existing && getThread(app, existing.threadId).parentId);
    let task: LongTask;
    try {
      task = startLongTask(app, { userId: source.userId, spaceId: source.spaceId, threadId: threadId ?? undefined,
        goal: source.goal }, { kind: source.kind, id: source.sourceId, generation: (existing?.sourceGeneration ?? 0) + 1 });
    } catch (error) {
      // Invalid or missing AI settings must leave the original work available.
      if (!(error instanceof HttpError) || source.explicit) throw error;
      console.warn(`[omem] ${source.kind} ${source.sourceId} 沿用原方式：${error.message}`);
      return null;
    }
    const text = source.explicit ? `已按你的要求交给 ${followAiLabel(task.ai)} 跟进；说“不用跟进”就回到原来的方式。`
      : `这件事较长，由 ${followAiLabel(task.ai)} 跟进；说“不用跟进”就回到原来的方式。`;
    const notice = queueThreadNotice(app, threadId ?? task.threadId, text, { autoFollowId: task.id });
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

/** Adopt active work once at service start, before its ordinary handoff cards are reconciled. */
export async function backfillAutoFollow(app: App) {
  const { backfillCodeFollow } = await import("./code-auto-follow.ts");
  const { backfillStudyFollow } = await import("../studies/auto-follow.ts");
  backfillCodeFollow(app);
  await backfillStudyFollow(app);
}
