import { createHash } from "node:crypto";
import type { App } from "../core/app.ts";
import type { Config } from "../core/config.ts";
import { HttpError } from "../core/util.ts";
import { one, run, tx } from "../core/db.ts";
import { searchBase } from "./api.ts";
import { dimsOf } from "./vector-codec.ts";
import { vectorIndex } from "./vectors.ts";
import { embedders } from "../plugins/process-hooks.ts";

export function embeddingId(config: Config) {
  const c = config.embeddings;
  if (c.provider === "none") return null;
  if (c.provider === "local") return "local:" + c.model;
  if (c.provider.startsWith("plugin:")) {
    const def = embedders.get(c.provider.slice(7))?.def;
    return def ? c.provider + ":" + JSON.stringify([def.model, def.dimensions]) : null;
  }
  return "api:" + JSON.stringify([searchBase(config, c), c.model, c.dimensions ?? null]);
}
export const storedModel = (app: App) => one<{value: string}>(app.db, "select value from kv where key='embedding_model'")?.value;
export const recordModel = (app: App, id: string) => run(app.db, "insert or replace into kv(key,value) values('embedding_model',?)", id);

/** Older OpenAI indexes have a model tag but no dimension metadata. Both lookups stop at one indexed row. */
export function adoptLegacyIndex(app: App, id: string) {
  tx(app.db, () => {
    const chunk = one<{ embedding: Uint8Array }>(app.db, "select embedding from chunks indexed by chunks_vector_space where embedding is not null limit 1");
    const dimensions = chunk ? dimsOf(chunk.embedding) : one<{ n: number }>(app.db,
      "select length(embedding) / 4 as n from memories indexed by memories_embedded where embedding is not null limit 1")?.n;
    if (dimensions) run(app.db, "insert or replace into kv(key,value) values('embedding_dimensions',?)", String(dimensions));
    recordModel(app, id);
  });
}

const dimensionChanges = new WeakMap<App, { id: string; dimensions: number }>();

/** Validate against the current index after the request, before a query or write can use the batch. */
export function checkIndexDimensions(app: App, id: string, dimensions: number, write: boolean) {
  if (write) run(app.db, "insert or ignore into kv(key,value) values('embedding_dimensions',?)", String(dimensions));
  const stored = one<{ value: string }>(app.db, "select value from kv where key='embedding_dimensions'")?.value;
  if (stored && Number(stored) !== dimensions) {
    dimensionChanges.set(app, { id, dimensions });
    throw new Error(`向量维度冲突：索引为 ${stored} 维，服务返回 ${dimensions} 维。请核对服务，或保存向量设置并确认重建。`);
  }
  dimensionChanges.delete(app);
}

// All counts read covering indexes. Only count a worktree vector if it will actually be cleared.
function spaceFilter(spaces?: readonly string[]) {
  return spaces?.length ? ` and space_id in (${spaces.map(() => "?").join(",")})` : "";
}
function count(app: App, sql: string, spaces?: readonly string[]) {
  if (spaces?.length === 0) return 0;
  return one<{ n: number }>(app.db, "select count(*) n from " + sql, ...(spaces ?? []))!.n;
}
export function pendingVectorCount(app: App, spaces?: readonly string[]) {
  const scope = spaceFilter(spaces);
  return count(app, "chunks indexed by chunks_unembedded where embedding is null and space_id not like 'wt-%'" + scope, spaces)
    + count(app, "memories indexed by memories_unembedded where status='active' and embedding is null" + scope, spaces);
}
export function vectorCounts(app: App, spaces?: readonly string[]) {
  const pending = pendingVectorCount(app, spaces);
  const scope = spaceFilter(spaces);
  const clear = count(app, "chunks indexed by chunks_vector_space where embedding is not null")
    + count(app, "memories indexed by memories_embedded where embedding is not null");
  const rebuild = pending + count(app, "chunks indexed by chunks_vector_space where embedding is not null and space_id not like 'wt-%'" + scope, spaces)
    + count(app, "memories indexed by memories_embedded where status='active' and embedding is not null" + scope, spaces);
  return { pending, clear, rebuild };
}

export function modelChange(app: App, next: Config) {
  const to = embeddingId(next);
  if (!to) {
    if (next.embeddings.provider.startsWith("plugin:") && next.embeddings.provider !== app.config.embeddings.provider)
      throw new HttpError(400, "向量插件提供者不可用，请先启用插件并确认它已注册。");
    return null; // Disabled or temporarily unloaded: keep the index.
  }
  const stored = storedModel(app);
  const legacy = app.config.embeddings.provider === "api" && !app.config.embeddings.dimensions && stored === "openai:" + app.config.embeddings.model;
  const from = legacy ? embeddingId(app.config) : stored ?? embeddingId(app.config);
  const observed = dimensionChanges.get(app);
  const newDimensions = observed?.id === to ? observed.dimensions : undefined;
  if (from === to && !newDimensions) return null;
  const token = createHash("sha256").update(JSON.stringify([from, to, newDimensions])).digest("hex");
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
    const observed = dimensionChanges.get(app);
    if (observed?.id === id) run(app.db, "insert into kv(key,value) values('embedding_dimensions',?)", String(observed.dimensions));
    recordModel(app, id);
  });
  dimensionChanges.delete(app);
  vectorIndex().clear();
}
