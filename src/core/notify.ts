import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { getItem, itemEvents } from "../items/store.ts";
import { validateItemRefs } from "../items/evidence.ts";
import { canWrite } from "./users.ts";
import { HttpError, json, newId, now } from "./util.ts";

export type NotifyAction = { label: string; action: string; style?: "primary" | "danger" | "default" };

/** normal: respect quiet hours and read state; urgent: pushes even at night; silent: in-app only. */
export type NotifyUrgency = "normal" | "urgent" | "silent";

export type NotifyTone = "warning" | "done";

/**
 * Channel delivery policy, registered per channel. Returning false keeps the
 * notification in the in-app list but skips the push (e.g. the owner already
 * read the triggering Feishu message, or it is night for a non-urgent nudge).
 */
export type ChannelGate = (n: Notification) => Promise<boolean> | boolean;
const gates = new Map<string, ChannelGate>();
export function registerNotificationGate(channel: string, gate: ChannelGate) {
  gates.set(channel, gate);
}
export async function channelAllows(channel: string, n: Notification) {
  const g = gates.get(channel);
  return g ? g(n) : true;
}

export function inQuietHours(app: App, at = new Date()) {
  const h = at.getHours();
  const { quietStart, quietEnd } = app.config.notify;
  return quietStart > quietEnd ? h >= quietStart || h < quietEnd : h >= quietStart && h < quietEnd;
}

export type Notification = {
  id: string;
  at: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  userId: string;
  /** Entity the notification is about (currently "item"); lets channels render action buttons. */
  entity?: string;
  entityId?: string;
  sourceRefs?: string[];
  eventId?: number;
  runId?: string | null;
  actions?: NotifyAction[];
  urgency?: NotifyUrgency;
  /** An explicitly scheduled reminder (item remind_at): fires at its time even in quiet hours. */
  scheduled?: boolean;
  /** Deliver into this Feishu conversation id instead of the owner's private chat (a work topic). */
  larkConversationId?: string;
  /** The daily item digest: items that closed by themselves (can be reopened) and that close soon (can be kept); `effects`: nightly replay suggestions to adopt or ignore. */
  digest?: { closed: string[]; soon: string[]; effects?: string[] };
  /** How the card reads: `warning` waits on the owner (an authorization, an approval: orange like approval cards), `done` is that settled (green). */
  tone?: NotifyTone;
  /** This is the newer state of an earlier notification (a pending authorization now done): channels edit the card they sent for it instead of sending another. */
  replaces?: string;
  /** Set by the Feishu channel: the card it sent (or edited) for this notification, so a later one can replace it. */
  larkMessageId?: string;
  larkBot?: string | null;
  /** A channel delivered it (the Feishu card, or a list of what waited the night): the web does not count it as unread. */
  pushed?: { channel: string; at: string; messageId?: string | null };
  /** A channel took it and chose not to ping (an ignore rule, the owner already on it): not unread on the web either. */
  quiet?: string;
};

type Sink = (n: Notification) => Promise<void> | void;
const sinks: Sink[] = [];
/** External channels (Feishu bot, Telegram…) register here to receive notifications. */
export function addNotificationSink(sink: Sink) {
  sinks.push(sink);
}

/** Notify a person (the owner by default): stored in-app and pushed to the channels that know them. */
export function notify(
  app: App,
  input: { title: string; body?: string; link?: string | null; userId?: string; entity?: string; entityId?: string; actions?: NotifyAction[]; sourceRefs?: string[]; eventId?: number; runId?: string | null; urgency?: NotifyUrgency; scheduled?: boolean; digest?: { closed: string[]; soon: string[]; effects?: string[] }; replaces?: string; tone?: NotifyTone;
    /** The host already gave the owner their time before this run started (mentions/mentions.ts): no first-nudge grace. */
    graceDone?: boolean },
) {
  const userId = input.userId ?? "owner";
  const replaced = input.replaces ? one<{ id: string; user_id: string }>(app.db, "select id, user_id from notifications where id = ?", input.replaces) : undefined;
  if (input.replaces && (!replaced || replaced.user_id !== userId)) throw new HttpError(404, `没有可以更新的通知 ${input.replaces}`);
  let sourceRefs = input.sourceRefs ?? [];
  if (input.entityId) {
    const item = getItem(app, input.entityId);
    if (item.userId !== userId || !canWrite(app, userId, item.spaceId)) throw new HttpError(403, "不能为此用户通知该事项");
    const event = input.eventId === undefined
      ? (input.sourceRefs === undefined ? itemEvents(app, item.id).at(-1) : undefined)
      : itemEvents(app, item.id).find((e) => e.id === input.eventId);
    if (input.eventId !== undefined && !event) throw new HttpError(400, "事件不属于该事项");
    if (input.eventId !== undefined && input.sourceRefs?.some((r) => !event!.sourceRefs.includes(r))) throw new HttpError(400, "通知来源不属于指定事件");
    // Legacy callers get the latest event, never all of the item's historical refs.
    sourceRefs = input.sourceRefs ?? event?.sourceRefs.filter((r) => item.sourceRefs.includes(r)) ?? [];
    if (input.sourceRefs && input.sourceRefs.some((r) => !item.sourceRefs.includes(r))) throw new HttpError(400, "通知来源不在事项当前有效来源中，请先记录本次事件");
    input = { ...input, eventId: event?.id };
  } else if (input.eventId !== undefined) throw new HttpError(400, "eventId 需要事项");
  validateItemRefs(app, sourceRefs, userId);
  // The same chat messages already told the owner about a moment ago (two runs reading the same
  // new lines, a later run repeating an earlier one): not again. A new state of it goes with `replaces`.
  if (!input.scheduled && !input.replaces && !input.digest) {
    const repeat = repeatOf(app, userId, sourceRefs);
    if (repeat) throw new HttpError(409, `这几条消息 ${REPEAT_HOURS} 小时内已经提醒过本人（通知 ${repeat.id}「${repeat.title}」），不再重复提醒；这件事有了新状态就传 replaces=${repeat.id} 更新那条，没有就不用通知`);
  }
  // Grace period for a normal, non-scheduled, non-urgent item's FIRST nudge:
  // give the owner time to handle it (read / reply / react) before pinging.
  // Enforced centrally so an over-eager ingest run cannot bypass it.
  if (
    input.entityId &&
    !input.graceDone &&
    (input.urgency ?? "normal") !== "urgent" &&
    !input.scheduled &&
    !one(app.db, "select 1 from notifications where json_extract(context,'$.entityId') = ?", input.entityId)
  ) {
    const item = getItem(app, input.entityId);
    const delayMin = app.config.notify.firstNudgeDelayMinutes;
    const createdMs = Date.parse(item.createdAt);
    if (Number.isFinite(createdMs) && Date.now() - createdMs < delayMin * 60_000) {
      throw new HttpError(425, `首次提醒宽限期：事项建立未满 ${delayMin} 分钟，先不打扰本人`);
    }
  }
  const n: Notification = {
    id: newId("n"),
    sourceRefs: [...new Set(sourceRefs)],
    eventId: input.eventId,
    runId: input.runId,
    at: now(),
    title: input.title,
    body: input.body ?? "",
    link: input.link ?? null,
    readAt: null,
    userId: input.userId ?? "owner",
    urgency: input.urgency ?? "normal",
    ...(input.scheduled ? { scheduled: true } : {}),
    ...(input.digest ? { digest: input.digest } : {}),
    ...(replaced ? { replaces: replaced.id } : {}),
    // Updating a card that waited on the owner without saying how it reads now: it is settled (green).
    ...(input.tone ? { tone: input.tone } : replaced && one<{ t: string | null }>(app.db, "select json_extract(context, '$.tone') t from notifications where id = ?", replaced.id)?.t === "warning" ? { tone: "done" as const } : {}),
    ...(input.entityId ? { entity: input.entity ?? "item", entityId: input.entityId, actions: input.actions ?? [] } : {}),
  };
  run(app.db, "insert into notifications(id,at,title,body,link,user_id,context) values(?,?,?,?,?,?,?)", n.id, n.at, n.title, n.body, n.link, n.userId, JSON.stringify({ entity: n.entity, entityId: n.entityId, actions: n.actions, sourceRefs: n.sourceRefs, eventId: n.eventId, runId: n.runId, urgency: n.urgency, scheduled: n.scheduled, digest: n.digest, replaces: n.replaces, tone: n.tone }));
  // The earlier one is now history: read, and no longer waiting for the morning.
  if (replaced) run(app.db, "update notifications set read_at = coalesce(read_at, ?), context = json_remove(json_set(coalesce(context, '{}'), '$.replacedBy', ?), '$.deferred') where id = ?", n.at, n.id, replaced.id);
  app.emit({ type: "notification", id: n.id, title: n.title, body: n.body, link: n.link });
  for (const sink of sinks) Promise.resolve(sink(n)).catch((e) => console.warn("[omem] 通知发送失败", e));
  return n;
}

/** How long the same chat messages are not notified about again. */
export const REPEAT_HOURS = 6;

/** The Feishu messages behind `src:<chat source>#La-Lb` references (other references have none). */
export function chatMessagesOf(app: App, refs: string[]): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    const m = /^src:([A-Za-z0-9_-]+)#L(\d+)(?:-L?(\d+))?$/.exec(ref);
    if (!m) continue;
    for (const r of all<{ message_id: string }>(app.db, "select message_id from lark_message_lines where source_id = ? and line between ? and ?", m[1], Number(m[2]), Number(m[3] ?? m[2])))
      ids.add(r.message_id);
  }
  return [...ids];
}

/** An earlier notification (within REPEAT_HOURS) that already cited every chat message these references cite. */
function repeatOf(app: App, userId: string, refs: string[]) {
  const ids = chatMessagesOf(app, refs);
  if (!ids.length) return null;
  const since = new Date(Date.now() - REPEAT_HOURS * 3600_000).toISOString();
  const told = new Set<string>();
  for (const n of all<{ id: string; title: string; refs: string | null }>(app.db, "select id, title, json_extract(context, '$.sourceRefs') refs from notifications where user_id = ? and at > ? order by at desc", userId, since)) {
    for (const id of chatMessagesOf(app, json<string[]>(n.refs, []))) told.add(id);
    if (ids.every((id) => told.has(id))) return n;
  }
  return null;
}

/** One person's notifications, newest first (the owner's by default). */
export function listNotifications(app: App, limit = 50, userId = "owner") {
  return all<{ id: string; at: string; title: string; body: string; link: string | null; read_at: string | null; context: string }>(
    app.db,
    "select * from notifications where user_id = ? order by at desc limit ?",
    userId,
    limit,
  ).map((r) => {
    const n = { ...json<Partial<Notification>>(r.context, {}), id: r.id, at: r.at, title: r.title, body: r.body, link: r.link, readAt: r.read_at };
    return { ...n, unread: countsAsUnread(n) };
  });
}

/**
 * What the web counts as unread (the bell's number, the dot): only what reached the person nowhere
 * else. A notification pushed to Feishu was seen there, or will be; one a channel deliberately kept
 * quiet, or sent as in-app only (`silent`), is not a reminder either. The list still shows them all.
 */
export function countsAsUnread(n: Pick<Notification, "readAt" | "pushed" | "larkMessageId" | "quiet" | "urgency">) {
  return !n.readAt && !n.pushed && !n.larkMessageId && !n.quiet && n.urgency !== "silent";
}

/** A channel delivered the notification (`messageId`: the Feishu message it went out as). */
export function markPushed(app: App, id: string, channel = "lark", messageId?: string | null) {
  run(app.db, "update notifications set context = json_set(coalesce(context, '{}'), '$.pushed', json_object('channel', ?, 'at', ?, 'messageId', ?)) where id = ?", channel, now(), messageId ?? null, id);
}

/** A channel took the notification and chose not to ping (`why`, shown on the web). */
export function markQuiet(app: App, id: string, why: string) {
  run(app.db, "update notifications set context = json_set(coalesce(context, '{}'), '$.quiet', ?) where id = ?", why, id);
}

/** Notifications read some other way (in Feishu, by dealing with what they were about). */
export function markReadIds(app: App, ids: string[]) {
  if (!ids.length) return 0;
  return Number(run(app.db, `update notifications set read_at = ? where read_at is null and id in (${ids.map(() => "?").join(",")})`, now(), ...ids).changes);
}

/** A push held back by quiet hours: sent after them if still unread (takeDeferred). */
export function deferNotification(app: App, id: string) {
  run(app.db, "update notifications set context = json_set(coalesce(context, '{}'), '$.deferred', 1) where id = ?", id);
}

/** The pushes quiet hours held back, taken once: those still unread and less than a day old come back to send. */
export function takeDeferred(app: App): Notification[] {
  const rows = all<{ id: string; at: string; title: string; body: string; link: string | null; user_id: string; read_at: string | null; context: string | null }>(app.db, "select * from notifications where json_extract(context, '$.deferred') = 1 order by at");
  if (!rows.length) return [];
  run(app.db, `update notifications set context = json_remove(context, '$.deferred') where id in (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.id));
  return rows
    .filter((r) => !r.read_at && Date.now() - Date.parse(r.at) < 24 * 3600_000)
    .map((r) => ({ ...json<Partial<Notification>>(r.context, {}), id: r.id, at: r.at, title: r.title, body: r.body, link: r.link, readAt: null, userId: r.user_id }));
}

/** Remember the Feishu card a notification went out as (see `replaces`). */
export function setNotificationCard(app: App, id: string, messageId: string, bot?: string | null) {
  run(app.db, "update notifications set context = json_set(coalesce(context, '{}'), '$.larkMessageId', ?, '$.larkBot', ?) where id = ?", messageId, bot ?? null, id);
  markPushed(app, id, "lark", messageId);
}
/** The Feishu card sent for a notification, if any. */
export function notificationCardOf(app: App, id: string) {
  const r = one<{ m: string | null; b: string | null }>(app.db, "select json_extract(context, '$.larkMessageId') m, json_extract(context, '$.larkBot') b from notifications where id = ?", id);
  return r?.m ? { messageId: r.m, bot: r.b } : null;
}

export function markRead(app: App, id?: string, userId = "owner") {
  if (id) run(app.db, "update notifications set read_at = ? where id = ? and user_id = ?", now(), id, userId);
  else run(app.db, "update notifications set read_at = ? where read_at is null and user_id = ?", now(), userId);
}
