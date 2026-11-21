import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { embeddingId, storedModel, recordModel, pendingVectorCount } from "./embedding-index.ts";
import { apiEmbedder, encodeBatch, type EmbeddingProvider, type Kind } from "./embedding-provider.ts";
import { vectorIndex } from "./vectors.ts";
import { pack, toFloats } from "./vector-codec.ts";
import { all, one, run, tx } from "../core/db.ts";
import { readProcess } from "./read-process.ts";
import { searchStage } from "./trace.ts";
import { modelSource, osdkModelDir, prepareLocalModel } from "./local-models.ts";
import { embedders } from "../plugins/process-hooks.ts";
import { notify } from "../core/notify.ts";
import type { Config } from "../core/config.ts";
import { untilAbort } from "../core/util.ts";

/**
 * Optional dense retrieval. Vectors live next to chunks, packed to one signed byte a dimension
 * (vector-codec.ts), and are searched by brute-force cosine: a personal library fits in memory
 * and needs no ANN index. Changing the model clears all vectors, so mixed embeddings never
 * compete in one ranking.
 */
type Embedder = { id: string; embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> };

let embedder: Embedder | null | undefined;
let testEmbedder = false;
let localKey = "";
const recent = new WeakMap<App, { lastMs: number; lastError: string | null; writeError?: string; pausedUntil?: number }>();
export const embeddingHealth = (app: App) => recent.get(app) ?? { lastMs: 0, lastError: null };


export function resetEmbedder() {
  embedder = undefined;
  testEmbedder = false;
  vectorIndex().clear();
}

async function getEmbedder(app: App, inProcess = false, checkModel = true, config = app.config): Promise<EmbeddingProvider | null> {
  const cfg = config.embeddings;
  if (testEmbedder) return embedder ?? null;
  if (cfg.provider === "none") return null;
  if (cfg.provider === "api") return apiEmbedder(app, cfg, embeddingId(config)!);
  if (cfg.provider.startsWith("plugin:")) {
    const entry = embedders.get(cfg.provider.slice(7));
    if (!entry) return null;
    const id = embeddingId(config)!;
    const current = storedModel(app);
    if (checkModel && current && current !== id) {
      const error = `插件向量模型或维度已变化：${entry.def.name}（${entry.def.model}，${entry.def.dimensions} 维）。请在检索设置确认重建向量，或改回原来的提供者。`;
      recent.set(app, { lastMs: 0, lastError: error, writeError: error });
      const notice = current + "->" + id;
      if (one<{value: string}>(app.db, "select value from kv where key='embedding_model_notice'")?.value !== notice) {
        notify(app, { title: "插件向量已暂停", body: error, urgency: "later", plain: true });
        run(app.db, "insert or replace into kv(key,value) values('embedding_model_notice',?)", notice);
      }
      return null;
    }
    return { id, dimensions: entry.def.dimensions, maxBatch: Math.min(cfg.batch, entry.def.maxBatch ?? 256),
      maxChars: entry.def.maxChars, spaces: entry.spaces.length ? entry.spaces : undefined,
      embed: (texts, kind, signal) => entry.def.embed(texts, kind, signal) };
  }
  const key = JSON.stringify(cfg);
  if (localKey !== key) { embedder = undefined; localKey = key; }
  if (embedder !== undefined) return embedder;
  if (!inProcess && !testEmbedder) {
    // osdk first: while it is still downloading a model nothing has fetched before, there are no vectors
    // yet (asked again on the next use) rather than a second download racing it.
    const src = modelSource(cfg.model);
    if (src.via === "hub" && src.osdk && src.known) {
      void prepareLocalModel(cfg.model);
      if (modelSource(cfg.model).syncing && !src.cached) return null;
    }
    try {
      // Validate in the child before embedPending is allowed to replace an old model's vectors.
      await readProcess(app, "embedding").request({ op: "embed", texts: [], kind: "passage", config: { embeddings: cfg } }, checkModel ? 120_000 : cfg.timeoutMs);
      return (embedder = {
        id: `local:${cfg.model}`,
        embed: (texts, kind) => readProcess(app, kind === "query" ? "vector" : "embedding").request<Float32Array[]>({ op: "embed", texts, kind, config: { embeddings: cfg } }, kind === "query" ? 30_000 : 120_000),
      });
    } catch (error) {
      console.warn("[omem] 向量模型不可用，退回纯全文检索：", (error as Error).message);
      return (embedder = null);
    }
  }
  try {
    // onnxruntime keeps its CPU arena at the largest batch it has seen; turning it off gives memory
    // back after each batch at some speed cost (embeddings.memArena).
    const extractor = await loadLocalModel<any>(cfg.model, (mod, id) => mod.pipeline("feature-extraction", id, { dtype: "q8", ...(cfg.memArena === false ? { session_options: { enableCpuMemArena: false } } : {}) }));
    // osdk paths do not name the model, so setup records its family.
    const family = cfg.family ?? (/bge-m3/i.test(cfg.model) ? "bge-m3" : /bge.*zh/i.test(cfg.model) ? "bge-zh" : /bge/i.test(cfg.model) ? "bge" : "other");
    const isBge = family.startsWith("bge");
    embedder = {
      id: `local:${cfg.model}`,
      async embed(texts, kind) {
        const input = family === "bge-zh" && kind === "query" ? texts.map((t) => "为这个句子生成表示以用于检索相关文章：" + t) : texts;
        const result: Float32Array[] = new Array(input.length);
        for (const group of paddedGroups(input)) {
          const out = await extractor(group.map((i) => input[i]), { pooling: isBge ? "cls" : "mean", normalize: true });
          const dim = (out.dims as number[])[1];
          const data = out.data as Float32Array;
          group.forEach((at, i) => { result[at] = data.slice(i * dim, (i + 1) * dim); });
        }
        return result;
      },
    };
  } catch (error) {
    console.warn("[omem] 向量模型不可用，退回纯全文检索：", (error as Error).message);
    embedder = null;
  }
  return embedder;
}

let loading: Promise<unknown> = Promise.resolve();

/**
 * Load a transformers.js model by hub id or from a local directory (an osdk-managed model loads
 * offline). The local path is a library-wide setting, so loads run one at a time.
 */
export function loadLocalModel<T>(model: string, load: (mod: any, id: string) => Promise<T>): Promise<T> {
  const next = loading.then(async () => {
    const mod = (await import("@huggingface/transformers")) as any;
    // A directory the owner set, else osdk's pinned copy of a model named by its hub id (local-models.ts);
    // only without either does transformers.js download it itself.
    const dir = existsSync(model) ? model : osdkModelDir(model);
    mod.env.localModelPath = dir ? dirname(resolve(dir)) + "/" : "/models/";
    mod.env.allowRemoteModels = !dir;
    return load(mod, dir ? basename(resolve(dir)) : model);
  });
  loading = next.catch(() => {});
  return next;
}

/**
 * A batch is padded to its longest text, and attention memory grows with the square of that
 * length: run texts of similar length together, and fewer of them when they are long.
 */
const PADDED_CHARS = 16_000;
export function paddedGroups(texts: string[]): number[][] {
  const order = texts.map((t, i) => ({ i, n: t.length })).sort((a, b) => a.n - b.n);
  const groups: number[][] = [];
  let cur: number[] = [];
  for (const { i, n } of order) {
    if (cur.length && (cur.length + 1) * Math.max(n, 1) > PADDED_CHARS) { groups.push(cur); cur = []; }
    cur.push(i);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Benchmarks and tests: use a stand-in embedder. */
export function setEmbedderForTests(e: Embedder | null) {
  testEmbedder = true;
  embedder = e;
  vectorIndex().clear();
}

export function invalidateVectors() {
  vectorIndex().clear();
}

/**
 * Embed chunks that have no vector yet. Returns how many were embedded. Not the indexes of a
 * delegation's or branch review's worktree (`wt-…`, worktree-index.ts): they live as long as the
 * review and are searched by text; a few reviews of one large branch at once are tens of thousands
 * of chunks, and embedding them took the CPU the reviewers' own tool calls needed.
 */
export async function embedPending(app: App, batch = 32): Promise<number> {
  const e = await writer(app);
  if (!e) return 0;
  batch = Math.min(batch, e.maxBatch ?? batch);
  const scope = e.spaces ? ` and space_id in (${e.spaces.map(() => "?").join(",")})` : "";
  const rows = all<{ id: number; space_id: string; title: string; path: string; text: string }>(
    app.db,
    // Through the index of chunks without a vector (`chunks_unembedded`): usually there are none, and
    // finding that out by reading the table took half a second on a large library, every half minute.
    "select id, space_id, title, path, text from chunks indexed by chunks_unembedded where embedding is null and space_id not like 'wt-%'" + scope + " limit ?",
    ...(e.spaces ?? []), batch,
  );
  if (!rows.length) return 0;
  // Text already embedded elsewhere (another copy of the same chat or document, docs/v2/multi-user.md):
  // its vector is copied instead of asking the model again.
  const twin = app.db.prepare(
    "select embedding from chunks where length(text) = ? and substr(text, 1, 80) = ? and embedding is not null and text = ? and (case when path != '' then path else title end) = ? and id != ? limit 1",
  );
  const known = new Map<number, Float32Array>();
  for (const r of rows) {
    const t = twin.get(r.text.length, r.text.slice(0, 80), r.text, r.path || r.title, r.id) as { embedding: Uint8Array } | undefined;
    // The twin's stored vector, packed or the older float32 form (vector-codec.ts).
    if (t?.embedding) known.set(r.id, toFloats(t.embedding));
  }
  // Within the batch too: identical inputs are embedded once.
  const input = (r: (typeof rows)[number]) => `${r.path || r.title}\n${r.text}`.slice(0, 2000);
  const fresh = [...new Set(rows.filter((r) => !known.has(r.id)).map(input))];
  const made = fresh.length ? await encode(app, e, fresh, "passage", true) : [];
  if (!made || !stillSelected(app, e)) return 0;
  const byInput = new Map(fresh.map((t, i) => [t, made[i]]));
  for (const r of rows) if (!known.has(r.id)) known.set(r.id, byInput.get(input(r))!);
  const upd = app.db.prepare("update chunks set embedding = ? where id = ?");
  tx(app.db, () => {
    for (const r of rows) upd.run(pack(known.get(r.id)!), r.id);
  });
  vectorIndex().add(app, rows.map((r) => ({ id: r.id, spaceId: r.space_id, vec: known.get(r.id)! })));
  return rows.length;
}

/** Embed active memories that have no vector yet (passive recall). Run after embedPending, which resets them on a model change. */
export async function embedPendingMemories(app: App, batch = 32): Promise<number> {
  const e = await writer(app);
  if (!e) return 0;
  batch = Math.min(batch, e.maxBatch ?? batch);
  const scope = e.spaces ? ` and space_id in (${e.spaces.map(() => "?").join(",")})` : "";
  const rows = all<{ id: string; subject: string; content: string }>(app.db, "select id, subject, content from memories indexed by memories_unembedded where status = 'active' and embedding is null" + scope + " limit ?", ...(e.spaces ?? []), batch);
  if (!rows.length) return 0;
  const vecs = await encode(app, e, rows.map((r) => (r.subject ? `${r.subject}：${r.content}` : r.content).slice(0, 2000)), "passage", true);
  if (!vecs || !stillSelected(app, e)) return 0;
  const upd = app.db.prepare("update memories set embedding = ? where id = ?");
  tx(app.db, () => rows.forEach((r, i) => upd.run(new Uint8Array(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength), r.id)));
  return rows.length;
}

function stillSelected(app: App, e: EmbeddingProvider) {
  const current = storedModel(app);
  return (testEmbedder || embeddingId(app.config) === e.id) && (!current || current === e.id);
}

async function writer(app: App) {
  if ((recent.get(app)?.pausedUntil ?? 0) > Date.now()) return null;
  const e = await getEmbedder(app);
  if (!e) return null;
  const current = storedModel(app);
  // Old openai configurations stored only the model name. Adopt the existing index on upgrade.
  if (!current || (app.config.embeddings.provider === "api" && current === "openai:" + app.config.embeddings.model && !app.config.embeddings.dimensions))
    recordModel(app, e.id);
  return stillSelected(app, e) ? e : null;
}

async function encode(app: App, e: EmbeddingProvider, texts: string[], kind: Kind, write = false) {
  const at = Date.now();
  try {
    const dim = e.maxBatch && one<{value: string}>(app.db, "select value from kv where key='embedding_dimensions'")?.value;
    const rows = await encodeBatch(e, texts, kind, app.config.embeddings.timeoutMs, Number(dim) || undefined);
    if (!stillSelected(app, e)) return null;
    if (write && e.maxBatch) {
      run(app.db, "insert or ignore into kv(key,value) values('embedding_dimensions',?)", String(rows[0].length));
      if (Number(one<{value:string}>(app.db, "select value from kv where key='embedding_dimensions'")!.value) !== rows[0].length)
        throw new Error("向量维度与已存索引不符");
    }
    recent.set(app, { ...(write ? {} : recent.get(app)), lastMs: Date.now() - at, lastError: null });
    return rows;
  } catch (err) {
    const error = (err as Error).message;
    recent.set(app, { ...recent.get(app), lastMs: Date.now() - at, lastError: error,
      ...(write && { writeError: error, pausedUntil: Date.now() + 30_000 }) });
    return null;
  }
}

export function resumeEmbedding(app: App) { recent.delete(app); }

/** Scope every use of the shared vector index, including vectors left from an earlier grant. */
export function embeddingSpaces(app: App, requested: readonly string[] | null) {
  if (!app.config.embeddings.provider.startsWith("plugin:")) return requested;
  const entry = embedders.get(app.config.embeddings.provider.slice(7));
  if (!entry) return [];
  if (!entry.spaces.length) return requested;
  return entry.spaces.filter(s => !requested || requested.includes(s));
}

export function embeddingStatus(app: App) {
  const cfg = app.config.embeddings;
  const plugin = cfg.provider.startsWith("plugin:") ? embedders.get(cfg.provider.slice(7)) : undefined;
  const scoped = cfg.provider.startsWith("plugin:") && !plugin ? [] : plugin?.spaces.length ? plugin.spaces : undefined;
  const changed = cfg.provider.startsWith("plugin:") && !!storedModel(app) && storedModel(app) !== embeddingId(app.config);
  const health = embeddingHealth(app);
  const excludedSpaces = scoped ? all<{id: string}>(app.db,
    `select id from spaces where id not like 'wt-%'${scoped.length ? ` and id not in (${scoped.map(() => "?").join(",")})` : ""} order by id limit 1000`, ...scoped).map(s => s.id) : [];
  return { provider: cfg.provider, kind: cfg.provider.startsWith("plugin:") ? "plugin" : cfg.provider,
    model: plugin?.def.model ?? cfg.model, dimensions: plugin?.def.dimensions ?? cfg.dimensions ??
      (Number(one<{value: string}>(app.db, "select value from kv where key='embedding_dimensions'")?.value) || null),
    plugin: plugin?.plugin ?? null, name: plugin?.def.name ?? null, ...health,
    pending: pendingVectorCount(app, scoped), excludedSpaces, excludedReason: excludedSpaces.length ? "插件未获授权，这些空间没有向量" : null,
    state: cfg.provider === "none" ? "off" : changed ? "model-changed" : cfg.provider.startsWith("plugin:") && !plugin ? "unavailable" : health.writeError ? "paused" : health.lastError ? "failed" : health.lastMs ? "ready" : "idle" };
}

/** Connectivity probes send only this fixture, even for unsaved configurations. */
export const EMBEDDING_TEST_TEXT = "这是一条向量接口检测文本。";
export async function testEmbedding(app: App, cfg: Config["embeddings"]) {
  const signal = AbortSignal.timeout(cfg.timeoutMs);
  const rows = await untilAbort(signal, async () => {
    const e = await getEmbedder(app, false, false, { ...app.config, embeddings: cfg });
    if (!e) throw new Error("向量提供者不可用");
    return encodeBatch(e, [EMBEDDING_TEST_TEXT], "query", cfg.timeoutMs);
  });
  return rows[0].length;
}

/** One vector, or null when the configured provider is unavailable. */
export async function embedQuery(app: App, text: string, kind: Kind = "query", spaces?: readonly string[] | null, sourceSpaces?: readonly string[]): Promise<Float32Array | null> {
  if (app.config.embeddings.provider === "none") return null;
  const e = await getEmbedder(app);
  if (!e || !stillSelected(app, e)) return null;
  if (e.spaces && sourceSpaces?.some(id => !e.spaces!.includes(id))) return null;
  if (e.spaces && spaces && !spaces.some(s => e.spaces!.includes(s))) return null;
  return (await encode(app, e, [text.slice(0, 2000)], kind))?.[0] ?? null;
}

/** Only the isolated process loads the local runtime. The parent keeps batching and writes. */
export async function embedLocally(app: App, texts: string[], kind: "query" | "passage") {
  const e = await getEmbedder(app, true);
  if (!e) throw new Error("向量模型不可用");
  return encodeBatch(e, texts, kind, 120_000);
}

export async function vectorSearch(app: App, query: string, spaces: string[] | undefined, limit: number) {
  if (app.config.embeddings.provider === "none") return [];
  if (app.config.embeddings.provider !== "local" && !testEmbedder) {
    const e = await getEmbedder(app);
    if (!e) return [];
    spaces = e.spaces ? e.spaces.filter(s => !spaces || spaces.includes(s)) : spaces;
    if (spaces && !spaces.length) return [];
    const vector = await embedQuery(app, query, "query", spaces);
    if (!vector) return [];
    return searchStage("vector", () => readProcess(app, "vector").request<{ chunkId: number; score: number }[]>({ op: "vector", query, spaces, limit, vector, config: { embeddings: app.config.embeddings } }, 30_000));
  }
  if (!testEmbedder && storedModel(app) && storedModel(app) !== embeddingId(app.config)) return [];
  if (!testEmbedder) return searchStage("vector", () => readProcess(app, "vector").request<{ chunkId: number; score: number }[]>({ op: "vector", query, spaces, limit, config: { embeddings: app.config.embeddings } }, 30_000));
  const e = await getEmbedder(app);
  if (!e) return [];
  const q = await embedQuery(app, query);
  if (!q) return [];
  await vectorIndex().prepare(app, spaces);
  return vectorIndex().search(app, q, spaces, limit);
}
