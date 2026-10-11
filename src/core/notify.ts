import type { App } from "./app.ts";
import { all, run } from "./db.ts";
import { newId, now } from "./util.ts";

export type Notification = { id: string; at: string; title: string; body: string; link: string | null; readAt: string | null };

type Sink = (n: Notification) => Promise<void> | void;
const sinks: Sink[] = [];
/** External channels (Feishu bot, Telegram…) register here to receive notifications. */
export function addNotificationSink(sink: Sink) {
  sinks.push(sink);
}

export function notify(app: App, input: { title: string; body?: string; link?: string | null }) {
  const n: Notification = { id: newId("n"), at: now(), title: input.title, body: input.body ?? "", link: input.link ?? null, readAt: null };
  run(app.db, "insert into notifications(id,at,title,body,link) values(?,?,?,?,?)", n.id, n.at, n.title, n.body, n.link);
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
