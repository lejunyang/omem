import type { App } from "./app.ts";
import { all, one } from "./db.ts";
import { OWNER, personalSpaceId } from "./users.ts";
import { can } from "../auth/permissions.ts";
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
/**
 * Where a chat's capture goes. `userId`: whose capture it is (docs/v2/multi-user.md, “采集进哪个空间”):
 * a binding or an existing copy of the chat counts only in a space that person may capture into
 * (`capture.route`), otherwise their own personal space — someone else's capture of a shared private
 * chat never lands in the owner's personal space.
 */
export function captureSpace(app: App, chatId?: string, userId: string = OWNER): string {
  const mayRoute = (space: string) => userId === OWNER || can(app, userId, "capture.route", space);
  if (chatId) {
    const bound = chatBinding(app, chatId);
    if (bound && mayRoute(bound)) return bound;
    const existing = all<{ space_id: string }>(app.db, "select space_id from sources where uri=? and deleted_at is null order by captured_at", `lark:${chatId}`);
    const usable = existing.find((r) => findSpace(app, r.space_id) && mayRoute(r.space_id));
    if (usable) return usable.space_id;
  }
  if (userId !== OWNER) return personalSpaceId(userId);
  const def = app.config.lark.capture.space;
  return findSpace(app, def) ? def : "personal";
}
