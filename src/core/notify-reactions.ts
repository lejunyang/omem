import type { App } from "./app.ts";
import { one, run, tx } from "./db.ts";
import { notify, type Notification } from "./notify.ts";
import { json, now } from "./util.ts";
import { resetApprovalStreak, setRung } from "../agents/approval-ladder.ts";

// A reaction event, a repeated delivery and the two-day outcome pass may meet while the model is
// still working. Keep one call in flight; completed work is recorded on the notification itself.
const learning = new WeakMap<App, Map<string, Promise<void>>>();

/** The current owner notification that went out as this card (same id precedence as outcomes). */
export function notificationForReaction(app: App, messageId: string) {
  return one<{ id: string }>(app.db, `select id from notifications where user_id = 'owner'
    and coalesce(json_extract(context, '$.larkMessageId'), json_extract(context, '$.pushed.messageId')) = ?
    and json_extract(context, '$.replacedBy') is null order by at desc limit 1`, messageId)?.id;
}

/** Apply the owner's negative feedback once. Explicit ignore clicks share the existing model path. */
export function handleNegativeNotification(app: App, id: string, via: "reaction" | "ignore" = "reaction"): Promise<void> {
  let pending = learning.get(app);
  if (!pending) learning.set(app, pending = new Map());
  const existing = pending.get(id);
  if (existing) return existing;
  const work = applyNegative(app, id, via).finally(() => pending.delete(id));
  pending.set(id, work);
  return work;
}

async function applyNegative(app: App, id: string, via: "reaction" | "ignore") {
  const row = one<{ title: string; body: string; context: string | null }>(app.db, "select title, body, context from notifications where id = ? and user_id = 'owner'", id);
  if (!row) return;
  const c = json<Partial<Notification>>(row.context, {});
  if (c.negativeHandledAt) return;
  const at = now();
  if (c.reportTool) {
    // Do this before any model work: the very next call must wait for the owner again.
    setRung(app, c.reportTool, "ask");
    tx(app.db, () => {
      resetApprovalStreak(app, c.reportTool!);
      run(app.db, "update notifications set context = json_set(coalesce(context, '{}'), '$.negativeHandledAt', ?) where id = ?", at, id);
      notify(app, { title: "工具已改回每次先问你", body: `你对「${c.reportTool}」做完后的汇报表示了不满意，这个工具改回每次先问你。在 设置 → 安全 可以改回去。`, link: "#/settings?tab=security", urgency: "later" });
    });
    return;
  }
  if (via === "reaction" && (c.urgency === "urgent" || !app.config.notify.learnFromReactions)) return;
  const { learnIgnoreFromNotification } = await import("./notify-ai-gate.ts");
  const rule = await learnIgnoreFromNotification(app, row);
  tx(app.db, () => {
    run(app.db, "update notifications set context = json_set(coalesce(context, '{}'), '$.negativeHandledAt', ?, '$.ignoreRule', json(?)) where id = ?", at, JSON.stringify(rule ? { id: rule.id, rule: rule.rule } : null), id);
    if (rule && via === "reaction") notify(app, { title: "已记下这类不再提醒", body: `你对「${row.title}」这条提醒表示了不满意，以后这类不再提醒：${rule.rule}。不对的话在通知页的忽略规则里删掉。`, link: "#/notifications", urgency: "later" });
  });
}

/** Event callbacks and the synchronous outcome pass leave model work in the background. */
export function queueNegativeNotification(app: App, id: string) {
  void handleNegativeNotification(app, id).catch((e) => console.warn(`[omem] 通知负反馈处理失败：${(e as Error).message}`));
}
