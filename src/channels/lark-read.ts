import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { larkCli } from "./lark-cli.ts";

/**
 * Whether the owner has read Feishu messages, via the personal (user) lark-cli
 * token and `im +messages-read-status`. Batched (up to 50 ids) and cached
 * briefly so a notification decision never waits on more than one call.
 *
 * Returns a set of ids known to be UNREAD. Unknown ids (deleted, chats the
 * token can no longer see, API unavailable) are NOT in the set: callers treat
 * "unknown" as unread rather than suppressing a possibly important reminder.
 */
const cache = new Map<string, { at: number; unread: boolean }>();
const TTL = 60_000;

export async function unreadMessageIds(app: App, ids: string[]): Promise<Set<string>> {
  const now = Date.now();
  const fresh = ids.filter((id) => {
    const c = cache.get(id);
    return !c || now - c.at > TTL;
  });
  for (let i = 0; i < fresh.length; i += 50) {
    const batch = fresh.slice(i, i + 50);
    try {
      const v = await larkCli(["im", "+messages-read-status", "--message-ids", batch.join(","), "--as", "user", "--format", "json"], 30_000);
      // Shape: { data: { items?: { message_id, read }[] } } across CLI versions; tolerate either casing.
      const items: any[] = v?.data?.items ?? v?.data?.readable_items ?? v?.items ?? [];
      const readable = new Map<string, boolean>();
      for (const it of items) readable.set(String(it.message_id ?? it.messageId ?? ""), !!(it.read ?? it.is_read));
      for (const id of batch) cache.set(id, { at: now, unread: !readable.get(id) });
    } catch {
      // No permission / CLI logged out / network: unknown stays out of the unread set
      // (we do not claim the owner read it), and is not cached long.
      for (const id of batch) cache.set(id, { at: now - TTL + 5_000, unread: false });
    }
  }
  return new Set(ids.filter((id) => cache.get(id)?.unread));
}

/** Read status of a single source message, e.g. for a notification decision. */
export async function isUnread(app: App, messageId: string | null | undefined): Promise<boolean> {
  if (!messageId || !messageId.startsWith("om_")) return false;
  // Only chats captured through the personal token can be queried; the bot is not a reader.
  const exists = one<{ n: number }>(app.db, "select 1 n from lark_messages where message_id = ?", messageId);
  if (!exists) return false;
  return (await unreadMessageIds(app, [messageId])).has(messageId);
}
