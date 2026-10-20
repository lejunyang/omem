import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { getItem, itemEvents } from "../items/store.ts";
import { validateItemRefs } from "../items/evidence.ts";
import { canWrite } from "./users.ts";
import { HttpError, json, newId, now } from "./util.ts";

export type NotifyAction = { label: string; action: string; style?: "primary" | "danger" | "default" };

/** normal: respect quiet hours and read state; urgent: pushes even at night; silent: in-app only. */
export type NotifyUrgency = "normal" | "urgent" | "silent";

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

/** Item nudge policy shared by roles and reminder delivery. */
export function notifyPolicy(app: App) {
  return app.config.notify;
}
export function isUrgent(n: Notification) {
  return n.urgency === "urgent";
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
  input: { title: string; body?: string; link?: string | null; userId?: string; entity?: string; entityId?: string; actions?: NotifyAction[]; sourceRefs?: string[]; eventId?: number; runId?: string | null; urgency?: NotifyUrgency; scheduled?: boolean },
) {
  const userId = input.userId ?? "owner";
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
  // Grace period for a normal, non-scheduled, non-urgent item's FIRST nudge:
  // give the owner time to handle it (read / reply / react) before pinging.
  // Enforced centrally so an over-eager ingest run cannot bypass it.
  if (
    input.entityId &&
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
    ...(input.entityId ? { entity: input.entity ?? "item", entityId: input.entityId, actions: input.actions ?? [] } : {}),
  };
  run(app.db, "insert into notifications(id,at,title,body,link,user_id,context) values(?,?,?,?,?,?,?)", n.id, n.at, n.title, n.body, n.link, n.userId, JSON.stringify({ entity: n.entity, entityId: n.entityId, actions: n.actions, sourceRefs: n.sourceRefs, eventId: n.eventId, runId: n.runId, urgency: n.urgency, scheduled: n.scheduled }));
  app.emit({ type: "notification", id: n.id, title: n.title, body: n.body, link: n.link });
  for (const sink of sinks) Promise.resolve(sink(n)).catch((e) => console.warn("[omem] 通知发送失败", e));
  return n;
}

export function listNotifications(app: App, limit = 50) {
  return all<{ id: string; at: string; title: string; body: string; link: string | null; read_at: string | null; context: string }>(
    app.db,
    "select * from notifications order by at desc limit ?",
    limit,
  ).map((r) => ({ ...json<Partial<Notification>>(r.context, {}), id: r.id, at: r.at, title: r.title, body: r.body, link: r.link, readAt: r.read_at }));
}

export function markRead(app: App, id?: string) {
  if (id) run(app.db, "update notifications set read_at = ? where id = ?", now(), id);
  else run(app.db, "update notifications set read_at = ? where read_at is null", now());
}
