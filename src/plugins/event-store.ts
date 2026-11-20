import type { App } from "../core/app.ts";
import { all, run, tx } from "../core/db.ts";
import { newId, now } from "../core/util.ts";
import type { PluginEventV1, Subscription } from "./types.ts";

export function replaceSubscriptions(app: App, plugin: string, defs: Subscription[]) {
  tx(app.db, () => {
    run(app.db, "delete from plugin_subscriptions where plugin=?", plugin);
    for (const def of defs) for (const type of new Set(def.events)) {
      run(app.db, "insert into plugin_subscriptions(plugin,subscriber,type) values(?,?,?)", plugin, plugin + ":" + def.id, type);
    }
  });
}

/** Called inside the transaction that writes the fact. Space grants belong to the host. */
export function enqueuePluginEvent(app: App, type: PluginEventV1["type"], spaceId: string | null, fact: () => Pick<PluginEventV1, "entity" | "actor" | "data"> & { userId: string }) {
  const grants = app.config.plugins.eventSpaces;
  if (!spaceId || !Object.values(grants).some(spaces => spaces.includes(spaceId))) return;
  const targets = all<{ subscriber: string; plugin: string }>(app.db, "select subscriber,plugin from plugin_subscriptions where type=?", type)
    .filter(row => grants[row.plugin]?.includes(spaceId));
  if (!targets.length) return;
  const { userId, ...body } = fact();
  const event: PluginEventV1 = { v: 1, id: newId("pe"), type, at: now(), spaceId, ...body };
  const seq = run(app.db, "insert into plugin_events(id,at,user_id,body) values(?,?,?,?)", event.id, event.at, userId, JSON.stringify(event)).lastInsertRowid;
  for (const { subscriber } of targets) run(app.db, "insert into plugin_deliveries(subscriber,seq,entity) values(?,?,?)", subscriber, seq, event.entity.kind + ":" + event.entity.id);
}

export function findingEvent(app: App, type: "finding.decision" | "finding.resolution", r: { id: string; spaceId: string | null; userId: string }, finding: { id: number; file_path: string | null; line: number | null }, decision: string | null, reason: string, actor: "user" | "agent" | "host" = "host") {
  enqueuePluginEvent(app, type, r.spaceId, () => ({
    userId: r.userId, entity: { kind: "finding", id: String(finding.id) },
    actor: { kind: actor },
    data: { runId: r.id, file: finding.file_path, line: finding.line, decision, reason },
  }));
}

export function replayPluginEvent(app: App, subscriber: string, id: string) {
  return run(app.db, "update plugin_deliveries set state='pending', attempts=0, due=0, error=null where subscriber=? and seq=(select seq from plugin_events where id=?) and state='failed'", subscriber, id).changes > 0;
}
