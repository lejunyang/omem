import type { App } from "../core/app.ts";
import { notify } from "../core/notify.ts";
import { plainCitations } from "../channels/common.ts";
import { validateItemRefs } from "./evidence.ts";
import { addItemEvent, dueReminders, itemEvents, reminderSourceRefs, upsertItem, type Item } from "./store.ts";

/** A stale source or disabled recipient must not prevent the other reminders from being delivered. */
export function deliverDueReminders(app: App) {
  const delivered: Item[] = [];
  for (const item of dueReminders(app)) {
    const valid: string[] = [], invalid: string[] = [];
    for (const ref of reminderSourceRefs(app, item)) {
      try { validateItemRefs(app, [ref], item.userId); valid.push(ref); }
      catch { invalid.push(ref); }
    }
    try {
      notify(app, { title: `提醒：${item.title}`, body: invalid.length ? plainCitations(item.detail) : item.detail, link: `#/items/${item.id}`, entity: "item", entityId: item.id, userId: item.userId, sourceRefs: valid });
      addItemEvent(app, item.id, "reminded", invalid.length ? "已按时提醒；部分来源已删除、行号失效或无访问权限，未作为通知链接" : "已按时提醒（含飞书操作卡片）", "agent", invalid);
      upsertItem(app, item.id, { remindAt: null, status: item.status === "snoozed" ? "open" : item.status }, "agent");
      delivered.push(item);
    } catch (error) {
      // Keep its due time for retry when access recovers, but do not duplicate failure history.
      const text = `提醒未送达：${(error as Error).message}`;
      if (itemEvents(app, item.id).at(-1)?.text !== text) addItemEvent(app, item.id, "reminder-failed", text, "agent");
      console.warn(`[omem] ${item.id} ${text}`);
    }
  }
  return delivered;
}
