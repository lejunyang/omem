import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";

/**
 * Optional dense retrieval. Vectors live next to chunks as Float32 BLOBs and are
 * searched by brute-force cosine: a personal library (≤ a few hundred thousand
 * chunks) fits in memory and needs no ANN index. Changing the model clears all
 * vectors, so mixed embeddings never compete in one ranking.
 */
type Embedder = { id: string; embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> };

let embedder: Embedder | null | undefined;
const cache = new Map<string, { ids: number[]; vecs: Float32Array[] }>();

async function getEmbedder(app: App): Promise<Embedder | null> {
  if (embedder !== undefined) return embedder;
  const cfg = app.config.embeddings;
  if (cfg.provider === "none") return (embedder = null);
  if (cfg.provider === "openai") {
    const url = (cfg.url ?? "https://api.openai.com/v1").replace(/\/$/, "") + "/embeddings";
    const key = process.env[cfg.apiKeyEnv];
    embedder = {
      id: `openai:${cfg.model}`,
      async embed(texts) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: cfg.model, input: texts }),
        });
        if (!res.ok) throw new Error(`embedding HTTP ${res.status}`);
        const body = (await res.json()) as { data: { embedding: number[] }[] };
        return body.data.map((d) => normalize(Float32Array.from(d.embedding)));
      },
    };
    return embedder;
  }
  try {
    const mod = (await import("@huggingface/transformers")) as any;
    // A local directory (e.g. an osdk-managed model view) loads offline.
    let modelId = cfg.model;
    if (existsSync(cfg.model)) {
      mod.env.localModelPath = dirname(resolve(cfg.model)) + "/";
      mod.env.allowRemoteModels = false;
      modelId = basename(resolve(cfg.model));
    }
    const extractor = await mod.pipeline("feature-extraction", modelId, { dtype: "q8" });
    // osdk paths do not name the model, so setup records its family.
    const family = cfg.family ?? (/bge-m3/i.test(cfg.model) ? "bge-m3" : /bge.*zh/i.test(cfg.model) ? "bge-zh" : /bge/i.test(cfg.model) ? "bge" : "other");
    const isBge = family.startsWith("bge");
    embedder = {
      id: `local:${cfg.model}`,
      async embed(texts, kind) {
        const input = family === "bge-zh" && kind === "query" ? texts.map((t) => "为这个句子生成表示以用于检索相关文章：" + t) : texts;
        const out = await extractor(input, { pooling: isBge ? "cls" : "mean", normalize: true });
        const [n, dim] = out.dims as number[];
        const data = out.data as Float32Array;
        return Array.from({ length: n }, (_, i) => data.slice(i * dim, (i + 1) * dim));
      },
    };
  } catch (error) {
    console.warn("[omem] 向量模型不可用，退回纯全文检索：", (error as Error).message);
    embedder = null;
  }
  return embedder;
}

function normalize(v: Float32Array) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Benchmarks and tests: use a stand-in embedder. */
export function setEmbedderForTests(e: Embedder | null) {
  embedder = e;
  cache.clear();
}

export function invalidateVectors() {
  cache.clear();
}

/** Embed chunks that have no vector yet. Returns how many were embedded. */
export async function embedPending(app: App, batch = 32): Promise<number> {
  const e = await getEmbedder(app);
  if (!e) return 0;
  const current = one<{ value: string }>(app.db, "select value from kv where key = 'embedding_model'")?.value;
  if (current !== e.id) {
    run(app.db, "update chunks set embedding = null");
    run(app.db, "insert into kv(key,value) values('embedding_model', ?) on conflict(key) do update set value = excluded.value", e.id);
    cache.clear();
  }
  const rows = all<{ id: number; title: string; path: string; text: string }>(
    app.db,
    "select id, title, path, text from chunks where embedding is null limit ?",
    batch,
  );
  if (!rows.length) return 0;
  const vecs = await e.embed(
    rows.map((r) => `${r.path || r.title}\n${r.text}`.slice(0, 2000)),
    "passage",
  );
  const upd = app.db.prepare("update chunks set embedding = ? where id = ?");
  rows.forEach((r, i) => upd.run(new Uint8Array(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength), r.id));
  cache.clear();
  return rows.length;
}

function load(app: App, spaces?: string[]) {
  const key = spaces?.slice().sort().join(",") ?? "*";
  let hit = cache.get(key);
  if (hit) return hit;
  const where = spaces?.length ? `and space_id in (${spaces.map(() => "?").join(",")})` : "";
  const rows = all<{ id: number; embedding: Uint8Array }>(app.db, `select id, embedding from chunks where embedding is not null ${where}`, ...(spaces ?? []));
  hit = {
    ids: rows.map((r) => r.id),
    vecs: rows.map((r) => new Float32Array(r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength))),
  };
  cache.set(key, hit);
  return hit;
}

export async function vectorSearch(app: App, query: string, spaces: string[] | undefined, limit: number) {
  if (app.config.embeddings.provider === "none") return [];
  const e = await getEmbedder(app);
  if (!e) return [];
  const { ids, vecs } = load(app, spaces);
  if (!ids.length) return [];
  const [q] = await e.embed([query], "query");
  const scored = ids.map((id, i) => {
    const v = vecs[i];
    let s = 0;
    for (let k = 0; k < v.length; k++) s += v[k] * q[k];
    return { chunkId: id, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
