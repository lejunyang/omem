import { createHash } from "node:crypto";
import type { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";
import { one, run, tx } from "../core/db.ts";
import { searchBase } from "./api.ts";
import { vectorIndex } from "./vectors.ts";
import { embedders } from "../plugins/process-hooks.ts";

export function embeddingId(config: Config) {
  const c = config.embeddings;
  if (c.provider === "none") return null;
  if (c.provider === "local") return "local:" + c.model;
  if (c.provider.startsWith("plugin:")) {
    const def = embedders.get(c.provider.slice(7))?.def;
    return c.provider + ":" + JSON.stringify([def?.model ?? null, def?.dimensions ?? null]);
  }
  return "api:" + JSON.stringify([searchBase(config, c), c.model, c.dimensions ?? null]);
}
export const storedModel = (app: App) => one<{value: string}>(app.db, "select value from kv where key='embedding_model'")?.value;
export const recordModel = (app: App, id: string) => run(app.db, "insert or replace into kv(key,value) values('embedding_model',?)", id);

// All counts read covering indexes. Only count a worktree vector if it will actually be cleared.
export function vectorCounts(app: App, spaces?: readonly string[]) {
  const scope = spaces ? spaces.length ? ` and space_id in (${spaces.map(() => "?").join(",")})` : " and 0" : "";
  const count = (sql: string, ...args: string[]) => one<{n: number}>(app.db, "select count(*) n from " + sql, ...args)!.n;
  const args = spaces ?? [];
  const pending = count("chunks indexed by chunks_unembedded where embedding is null and space_id not like 'wt-%'" + scope, ...args)
    + count("memories indexed by memories_unembedded where status='active' and embedding is null" + scope, ...args);
  const clear = count("chunks indexed by chunks_vector_space where embedding is not null")
    + count("memories indexed by memories_embedded where embedding is not null");
  const rebuild = pending + count("chunks indexed by chunks_vector_space where embedding is not null and space_id not like 'wt-%'" + scope, ...args)
    + count("memories indexed by memories_embedded where status='active' and embedding is not null" + scope, ...args);
  return { pending, clear, rebuild };
}

export function modelChange(app: App, next: Config) {
  const to = embeddingId(next);
  if (!to) return null; // Disabling preserves the index for later use.
  const stored = storedModel(app);
  const legacy = app.config.embeddings.provider === "api" && !app.config.embeddings.dimensions && stored === "openai:" + app.config.embeddings.model;
  const from = legacy ? embeddingId(app.config) : stored ?? embeddingId(app.config);
  if (from === to) return null;
  const token = createHash("sha256").update(JSON.stringify([from, to])).digest("hex");
  const entry = next.embeddings.provider.startsWith("plugin:") ? embedders.get(next.embeddings.provider.slice(7)) : null;
  return { ...vectorCounts(app, entry?.spaces.length ? entry.spaces : undefined), token, to };
}

export function replaceIndex(app: App, id: string) {
  tx(app.db, () => {
    run(app.db, "update chunks set embedding=null where embedding is not null");
    run(app.db, "update memories set embedding=null where embedding is not null");
    run(app.db, "insert or replace into kv(key,value) values('vector_log_floor',(select coalesce(max(seq),0) from vector_log))");
    run(app.db, "delete from vector_log");
    run(app.db, "delete from kv where key='embedding_dimensions'");
    recordModel(app, id);
  });
  vectorIndex().clear();
}
