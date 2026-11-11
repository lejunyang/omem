import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { markPushed, markReadIds } from "../core/notify.ts";
import { readMessageIds } from "./lark-read.ts";
import { ownerReactionsSeen } from "./lark-feedback.ts";

/**
 * The web's notifications follow Feishu (core/notify.ts countsAsUnread): what went out as a card is
 * not an unread reminder on the web, and becomes read once the owner has read, answered or acted on
 * that card in Feishu. Read state comes in batches (lark-read.ts, up to 50 messages a call) during
 * the heartbeat, never a request per notification.
 */

/** How far back read state is looked up: past it, an unread card is left as it is. */
const LOOKBACK_DAYS = 7;
const BATCH = 200;

/** The Feishu message each still-unread, pushed notification went out as (recent ones). */
function pushedUnread(app: App, limit = BATCH) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  return all<{ id: string; m: string | null }>(app.db, `select id, coalesce(json_extract(context, '$.pushed.messageId'), json_extract(context, '$.larkMessageId')) m
    from notifications where read_at is null and at > ? order by at desc limit ?`, since, limit).filter((r): r is { id: string; m: string } => !!r.m);
}

/** The notifications that went out as this Feishu message (several when a night's list went as one). */
export function notificationsOfCard(app: App, messageId: string) {
  return all<{ id: string }>(app.db, "select id from notifications where json_extract(context, '$.pushed.messageId') = ? or json_extract(context, '$.larkMessageId') = ?", messageId, messageId).map((r) => r.id);
}

/** The owner replied to or clicked a notification's card: read. */
export function markCardRead(app: App, messageId: string | null | undefined) {
  return messageId ? markReadIds(app, notificationsOfCard(app, messageId)) : 0;
}

/**
 * Heartbeat: pushed notifications the owner has dealt with in Feishu become read — a reaction on the
 * card, a reply quoting it, or the card read (when lark-cli can tell; unknown stays unread).
 */
export async function syncNotificationReads(app: App) {
  const rows = pushedUnread(app);
  if (!rows.length) return 0;
  const done = new Set<string>();
  for (const r of rows) {
    if (ownerReactionsSeen(app, r.m)) done.add(r.id);
    else if (one(app.db, "select 1 from messages where role = 'user' and json_extract(meta, '$.quote.messageId') = ? limit 1", r.m)) done.add(r.id);
  }
  const rest = rows.filter((r) => !done.has(r.id));
  const read = rest.length && app.config.lark.enabled ? await readMessageIds(app, [...new Set(rest.map((r) => r.m))]) : new Set<string>();
  for (const r of rest) if (read.has(r.m)) done.add(r.id);
  return markReadIds(app, [...done]);
}

/**
 * Once: notifications pushed before `pushed` was recorded — a card id kept for `replaces`, or the
 * interaction of an item or digest card — are marked pushed, so the web stops counting them.
 */
export function backfillPushed(app: App) {
  if (one(app.db, "select 1 from kv where key = 'notify_pushed_backfill'")) return 0;
  let n = 0;
  for (const r of all<{ id: string; m: string }>(app.db, "select id, json_extract(context, '$.larkMessageId') m from notifications where json_extract(context, '$.larkMessageId') is not null and json_extract(context, '$.pushed') is null")) {
    markPushed(app, r.id, "lark", r.m);
    n++;
  }
  for (const r of all<{ id: string; m: string }>(app.db, `select json_extract(c.payload, '$.notificationId') id, c.message_id m from card_interactions c
      join notifications n on n.id = json_extract(c.payload, '$.notificationId')
      where c.message_id is not null and json_extract(n.context, '$.pushed') is null`)) {
    markPushed(app, r.id, "lark", r.m);
    n++;
  }
  run(app.db, "insert into kv(key, value) values('notify_pushed_backfill', ?) on conflict(key) do update set value = excluded.value", new Date().toISOString());
  return n;
}
