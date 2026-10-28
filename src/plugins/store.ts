import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";

/**
 * Each plugin's own records (docs/v2/plugins.md): JSON documents in named collections, per
 * plugin and user. A keyed record (a learner's skill rating) has one row per key; its id is
 * derived from the key so the same record on two devices meets when pulled. Records without
 * a key (one per answer) get a fresh one.
 */
export type PluginRecord<T = Record<string, unknown>> = { key: string; data: T; spaceId: string; createdAt: string; updatedAt: string };

const COLLECTION = /^[a-z][a-z0-9_-]{0,39}$/;
const recordId = (plugin: string, userId: string, collection: string, key: string) => `${plugin}:${userId}:${collection}:${key}`;
type Row = { key: string; data: string; space_id: string; created_at: string; updated_at: string };
const toRecord = <T>(r: Row): PluginRecord<T> => ({ key: r.key, data: json<T>(r.data, {} as T), spaceId: r.space_id, createdAt: r.created_at, updatedAt: r.updated_at });

export type PluginStore = ReturnType<typeof pluginStore>;

/** The records one plugin keeps for one user; writes land in `spaceId`. */
export function pluginStore(app: App, plugin: string, userId: string, spaceId: string) {
  const check = (collection: string) => {
    if (!COLLECTION.test(collection)) throw new HttpError(400, `集合名不合法：${collection}（小写字母开头，字母、数字、_、-）`);
    return collection;
  };
  return {
    get<T = Record<string, unknown>>(collection: string, key: string): T | null {
      const r = one<Row>(app.db, "select * from plugin_records where id = ?", recordId(plugin, userId, check(collection), key));
      return r ? toRecord<T>(r).data : null;
    },
    /** Insert or replace; without a key a new record is added. Returns the key. */
    put(collection: string, key: string | null | undefined, data: unknown): string {
      check(collection);
      const k = key || newId("r");
      if (k.length > 200) throw new HttpError(400, "key 太长（最多 200 字）");
      const text = JSON.stringify(data ?? {});
      if (text.length > 200_000) throw new HttpError(400, "单条记录太大（最多 200 KB）");
      const at = now();
      run(
        app.db,
        `insert into plugin_records(id,plugin,user_id,space_id,collection,key,data,created_at,updated_at) values(?,?,?,?,?,?,?,?,?)
         on conflict(id) do update set data = excluded.data, updated_at = excluded.updated_at`,
        recordId(plugin, userId, collection, k),
        plugin,
        userId,
        spaceId,
        collection,
        k,
        text,
        at,
        at,
      );
      return k;
    },
    delete(collection: string, key: string) {
      return run(app.db, "delete from plugin_records where id = ?", recordId(plugin, userId, check(collection), key)).changes > 0;
    },
    /** Newest first; `since` (ISO time) keeps those created after it. */
    list<T = Record<string, unknown>>(collection: string, opts: { limit?: number; since?: string } = {}): PluginRecord<T>[] {
      const where = ["plugin = ?", "user_id = ?", "collection = ?", ...(opts.since ? ["created_at >= ?"] : [])];
      return all<Row>(
        app.db,
        `select key, data, space_id, created_at, updated_at from plugin_records where ${where.join(" and ")} order by created_at desc, key desc limit ?`,
        plugin,
        userId,
        check(collection),
        ...(opts.since ? [opts.since] : []),
        Math.min(Math.max(opts.limit ?? 100, 1), 5000),
      ).map((r) => toRecord<T>(r));
    },
    count(collection: string) {
      return one<{ n: number }>(app.db, "select count(*) n from plugin_records where plugin = ? and user_id = ? and collection = ?", plugin, userId, check(collection))!.n;
    },
  };
}
