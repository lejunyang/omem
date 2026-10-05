import type { Store } from "../../store.js";

/** Only successful reads are cached. Explicit retry bypasses mutable document cache. */
export class LarkResourceCache {
  constructor(private store: Store) {}
  get<T>(key: string): T | null {
    const row = this.store.db
      .prepare(
        "SELECT value FROM lark_resource_cache WHERE key=? AND expires_at>?",
      )
      .get(key, new Date().toISOString());
    return row ? (JSON.parse(String(row.value)) as T) : null;
  }
  put(key: string, value: unknown, ttlMs: number) {
    this.store.db
      .prepare(
        "INSERT INTO lark_resource_cache VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
      )
      .run(
        key,
        JSON.stringify(value),
        new Date(Date.now() + ttlMs).toISOString(),
      );
    this.store.db
      .prepare("DELETE FROM lark_resource_cache WHERE expires_at<=?")
      .run(new Date().toISOString());
  }
}
