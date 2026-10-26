import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { captureSpace } from "../core/capture-space.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { createThread, getThread } from "../agents/threads.ts";

/** Captured groups need not have had a conversation with the assistant yet. */
export function ruleGroups(app: App) {
  return all<{ chat_id: string; name: string }>(app.db, "select chat_id, name from lark_cursors where chat_id like 'oc_%' and chat_mode in ('group', 'topic') order by name, chat_id");
}

/** Selecting a destination creates no message and never takes over a guest's thread. */
export function ruleGroupConversation(app: App, chatId: string) {
  const chat = ruleGroups(app).find(c => c.chat_id === chatId);
  if (!chat) throw new HttpError(400, "请选择已采集的飞书群");
  const existing = one<{ id: string }>(app.db, "select id from conversations where channel = 'lark' and external_id = ? and user_id = ? and status = 'active' order by updated_at desc limit 1", chatId, OWNER);
  return existing ? getThread(app, existing.id) : createThread(app, { channel: "lark", key: chatId, title: chat.name || chatId, spaceId: captureSpace(app, chatId), userId: OWNER });
}
