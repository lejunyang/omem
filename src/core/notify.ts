import type { App } from "./app.ts";
import { all, run } from "./db.ts";
import { newId, now } from "./util.ts";

export type NotifyAction = { label: string; action: string; style?: "primary" | "danger" | "default" };

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
  actions?: NotifyAction[];
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
  input: { title: string; body?: string; link?: string | null; userId?: string; entity?: string; entityId?: string; actions?: NotifyAction[] },
) {
  const n: Notification = {
    id: newId("n"),
    at: now(),
    title: input.title,
    body: input.body ?? "",
    link: input.link ?? null,
    readAt: null,
    userId: input.userId ?? "owner",
    ...(input.entityId ? { entity: input.entity ?? "item", entityId: input.entityId, actions: input.actions ?? [] } : {}),
  };
  run(app.db, "insert into notifications(id,at,title,body,link,user_id) values(?,?,?,?,?,?)", n.id, n.at, n.title, n.body, n.link, n.userId);
  app.emit({ type: "notification", id: n.id, title: n.title, body: n.body, link: n.link });
  for (const sink of sinks) Promise.resolve(sink(n)).catch((e) => console.warn("[omem] 通知发送失败", e));
  return n;
}

export function listNotifications(app: App, limit = 50) {
  return all<{ id: string; at: string; title: string; body: string; link: string | null; read_at: string | null }>(
    app.db,
    "select * from notifications order by at desc limit ?",
    limit,
  ).map((r) => ({ id: r.id, at: r.at, title: r.title, body: r.body, link: r.link, readAt: r.read_at }));
}

export function markRead(app: App, id?: string) {
  if (id) run(app.db, "update notifications set read_at = ? where id = ?", now(), id);
  else run(app.db, "update notifications set read_at = ? where read_at is null", now());
}
