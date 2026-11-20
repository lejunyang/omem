import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { subscriptions } from "./process-hooks.ts";
import type { PluginEventV1 } from "./types.ts";

/** Lease before calling out. A crash after the callback can redeliver the same stable event id. */
export async function deliverPluginEvents(app: App) {
  const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
  run(app.db, "delete from plugin_events where seq in (select seq from plugin_events where at < ? order by at limit 500)", cutoff);
  for (const [key, entry] of subscriptions) {
    const rows = all<{ seq: number; body: string; attempts: number; user_id: string }>(app.db, `select d.seq,e.body,e.user_id,d.attempts from plugin_deliveries d
      join plugin_events e on e.seq=d.seq where d.subscriber=? and d.state='pending' and d.due<=? and e.at>=?
      and not exists(select 1 from plugin_deliveries older where older.subscriber=d.subscriber and older.entity=d.entity and older.seq<d.seq and older.state!='done')
      order by d.due,d.seq limit 32`, key, Date.now(), cutoff);
    for (const row of rows) {
      if (subscriptions.get(key) !== entry) break;
      const event: PluginEventV1 = JSON.parse(row.body);
      const lease = Date.now() + 30000;
      const claimed = run(app.db, "update plugin_deliveries set due=? where subscriber=? and seq=? and state='pending' and due<=?", lease, key, row.seq, Date.now()).changes;
      if (!claimed) continue;
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        if (entry.def.events.includes(event.type) && app.config.plugins.eventSpaces[entry.plugin]?.includes(event.spaceId)) {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("订阅回调超过 15 秒")); }, 15000);
          });
          await Promise.race([entry.def.handle(entry.context(app, row.user_id, event.spaceId, controller.signal), event), timeout]);
        }
        run(app.db, "update plugin_deliveries set state='done',attempts=attempts+1,error=null where subscriber=? and seq=? and due=?", key, row.seq, lease);
      } catch (err) {
        const n = row.attempts + 1;
        run(app.db, "update plugin_deliveries set state=?,attempts=?,due=?,error=? where subscriber=? and seq=? and due=?",
          n >= 6 ? "failed" : "pending", n, Date.now() + 1000 * 2 ** n, String(err).slice(0, 500), key, row.seq, lease);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
  }
}

export function startPluginDelivery(app: App) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await deliverPluginEvents(app); }
    catch (err) { console.warn("[omem] 插件事件投递失败", err); }
    finally { busy = false; }
  }, 2000).unref();
  app.events.once("close", () => clearInterval(timer));
}
