import type { App } from "./app.ts";
import { one } from "./db.ts";
import { findSpace } from "./spaces.ts";
import { json } from "./util.ts";
import { chatSettings } from "../agents/threads.ts";

/** Shared by conversations, collection and rules. Explicit settings precede inferred locations. */
export function chatBinding(app: App, chatId: string): string | undefined {
  const settings = chatSettings(app, "lark", chatId);
  const watched = chatSettings(app, "lark-watch", chatId);
  const subscriptions = json<{ chatId: string; spaceId: string }[]>(one<{ value: string }>(app.db, "select value from kv where key='lark_subscriptions'")?.value, []);
  const mapped = (findSpace(app, "personal")?.settings.larkGroups ?? {}) as Record<string, string>;
  return [settings.spaceId, watched.spaceId, watched.watch?.spaceId, subscriptions.find(s => s.chatId === chatId)?.spaceId, mapped[chatId]].find(id => id && findSpace(app, id));
}
export function captureSpace(app: App, chatId?: string): string {
  if (chatId) {
    const bound = chatBinding(app, chatId);
    if (bound) return bound;
    const existing = one<{ space_id: string }>(app.db, "select space_id from sources where uri=? and deleted_at is null order by captured_at limit 1", `lark:${chatId}`);
    if (existing && findSpace(app, existing.space_id)) return existing.space_id;
  }
  const def = app.config.lark.capture.space;
  return findSpace(app, def) ? def : "personal";
}
