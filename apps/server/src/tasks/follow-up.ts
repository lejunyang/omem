import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { taskFollowUpSchema, type TaskFollowUp } from "../../../../packages/contracts/src/task-flow.js";

/** Current owner words authorize timing; a waiting party is copied, not inferred. */
export function validateFollowUp(value: TaskFollowUp, userText: string): TaskFollowUp {
  const followUp = taskFollowUpSchema.parse(value);
  if (followUp.waiting_on && !userText.includes(followUp.waiting_on)) throw Error("等待对象需要来自当前指令");
  if ((followUp.next_check_at || followUp.snoozed_until) &&
      (!followUp.time_expression?.trim() || !userText.includes(followUp.time_expression.trim())))
    throw Error("跟进时间需要保留当前指令中的原始表达");
  return { ...followUp,
    next_check_at: followUp.next_check_at ? new Date(followUp.next_check_at).toISOString() : null,
    snoozed_until: followUp.snoozed_until ? new Date(followUp.snoozed_until).toISOString() : null };
}

/** Called inside Store's transaction. No model, outbound messages or new daemon.
 * A receipt is committed together with its notification, so offline catch-up and
 * repeated polling cannot replay the same task version/occurrence. */
export function dispatchTaskReminders(db: DatabaseSync, instant: string) {
  const tasks = db.prepare("SELECT * FROM tasks WHERE status IN ('open','waiting')").all();
  let delivered = 0;
  for (const task of tasks) {
    const followUp = task.follow_up ? taskFollowUpSchema.parse(JSON.parse(String(task.follow_up))) : null;
    if (followUp?.snoozed_until && followUp.snoozed_until > instant) continue;
    const triggers: { kind: "due" | "follow_up"; occurrence: string }[] = [];
    if (task.due_at && String(task.due_at) <= instant &&
        !db.prepare("SELECT id FROM notifications WHERE dedupe_key=?").get(`due:${task.id}:${task.version}`))
      triggers.push({ kind: "due", occurrence: String(task.due_at) });
    if (followUp?.next_check_at && followUp.next_check_at <= instant)
      triggers.push({ kind: "follow_up", occurrence: followUp.next_check_at });
    const fresh = triggers.filter(t => !db.prepare(`SELECT 1 FROM task_reminder_receipts
      WHERE task_id=? AND task_version=? AND kind=? AND occurrence=?`).get(task.id!, task.version!, t.kind, t.occurrence));
    if (!fresh.length) continue;
    const notificationId = randomUUID();
    const following = fresh.some(t => t.kind === "follow_up");
    const title = `${following ? "事项待跟进" : "待办到期"}：${task.title}`;
    const timezone = followUp?.timezone ?? "Asia/Shanghai";
    const currentTime = (value: string) => `${new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone, dateStyle: "full", timeStyle: "short",
    }).format(new Date(value))}（${timezone}）`;
    // Free-text detail/next_step can still contain the original reminder time.
    // Keep those on the task; the alert describes its current persisted state.
    const body = [following ? `当前检查时间：${currentTime(followUp!.next_check_at!)}` : "",
      fresh.some(t => t.kind === "due") ? `当前截止时间：${currentTime(String(task.due_at))}` : "",
      followUp?.waiting_on ? `等待：${followUp.waiting_on}。尚未确认收到回复。` : "",
      `下一步：检查「${task.title}」的进展。`,
      "可标记完成、稍后提醒或取消；不会自动联系他人。"].filter(Boolean).join("\n");
    db.prepare("INSERT INTO notifications VALUES(?,?,?,?,?,?,?)").run(notificationId, null, title, body, instant, null,
      following ? `follow-up:${task.id}:${task.version}:${followUp!.next_check_at}` : `due:${task.id}:${task.version}`);
    for (const trigger of fresh) db.prepare(`INSERT INTO task_reminder_receipts
      (task_id,task_version,kind,occurrence,notification_id,created_at) VALUES(?,?,?,?,?,?)`)
      .run(task.id!, task.version!, trigger.kind, trigger.occurrence, notificationId, instant);
    delivered++;
  }
  return delivered;
}
