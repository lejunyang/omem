import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";

/**
 * Which captured Feishu messages link which document (`lark_doc_links`), so “which chats posted this
 * document” is an index lookup and not a `like '%token%'` over every message. New messages are
 * noted as they are stored (lark-messages.ts storeMessages); messages captured before this table
 * existed are filled in a batch at a time by the nightly check (homing.ts), cursor in kv.
 */
const LINK = /\/(?:docx|docs|wiki|sheets|base|mindnotes|slides|file)\/([A-Za-z0-9]{10,})/g;

export function docTokens(text: string): string[] {
  return [...new Set([...text.matchAll(LINK)].map((m) => m[1]))];
}

/** Note the documents one message links (caller may hold a transaction). */
export function noteDocLinks(app: App, messageId: string, chatId: string, content: string) {
  if (!content || !content.includes("/")) return;
  for (const t of docTokens(content)) run(app.db, "insert or ignore into lark_doc_links(token, message_id, chat_id) values(?,?,?)", t, messageId, chatId);
}

// The last message rowid looked at. Messages that arrive another way (pulled from another device)
// get later rowids and are picked up by the next batch; noting one twice is harmless.
const CURSOR = "lark_doc_links_backfill";
const cursor = (app: App) => Number(one<{ value: string }>(app.db, "select value from kv where key = ?", CURSOR)?.value ?? 0) || 0;
/** Whether every stored message has been looked at. */
export function docLinksComplete(app: App) {
  return !one(app.db, "select 1 from lark_messages where rowid > ? limit 1", cursor(app));
}

/** One batch of older messages (by rowid); returns how many were read, 0 when none are left. */
export function backfillDocLinks(app: App, batch = 2000): number {
  const rows = all<{ rowid: number; message_id: string; chat_id: string; content: string }>(app.db,
    "select rowid, message_id, chat_id, content from lark_messages where rowid > ? order by rowid limit ?", cursor(app), batch);
  if (!rows.length) return 0;
  tx(app.db, () => {
    for (const r of rows) noteDocLinks(app, r.message_id, r.chat_id, r.content);
    run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", CURSOR, String(rows.at(-1)!.rowid));
  });
  return rows.length;
}

/** The chats whose messages link this document token, most messages first. */
export function chatsLinking(app: App, token: string, limit = 5) {
  return all<{ chat_id: string; n: number }>(app.db, "select chat_id, count(*) n from lark_doc_links where token = ? group by chat_id order by n desc limit ?", token, limit);
}
