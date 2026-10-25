import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { vectorIndex } from "./vectors.ts";
import { all, one, run } from "../core/db.ts";

/**
 * Optional dense retrieval. Vectors live next to chunks as Float32 BLOBs and are
 * searched by brute-force cosine: a personal library (≤ a few hundred thousand
 * chunks) fits in memory and needs no ANN index. Changing the model clears all
 * vectors, so mixed embeddings never compete in one ranking.
 */
type Embedder = { id: string; embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> };

let embedder: Embedder | null | undefined;

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
    // onnxruntime keeps its CPU arena at the largest batch it has seen; turning it off gives memory
    // back after each batch at some speed cost (embeddings.memArena).
    const extractor = await mod.pipeline("feature-extraction", modelId, { dtype: "q8", ...(cfg.memArena === false ? { session_options: { enableCpuMemArena: false } } : {}) });
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
  vectorIndex().clear();
}

export function invalidateVectors() {
  vectorIndex().clear();
}

/** Embed chunks that have no vector yet. Returns how many were embedded. */
export async function embedPending(app: App, batch = 32): Promise<number> {
  const e = await getEmbedder(app);
  if (!e) return 0;
  const current = one<{ value: string }>(app.db, "select value from kv where key = 'embedding_model'")?.value;
  if (current !== e.id) {
    run(app.db, "update chunks set embedding = null");
    run(app.db, "update memories set embedding = null");
    run(app.db, "insert into kv(key,value) values('embedding_model', ?) on conflict(key) do update set value = excluded.value", e.id);
    vectorIndex().clear();
  }
  const rows = all<{ id: number; space_id: string; title: string; path: string; text: string }>(
    app.db,
    "select id, space_id, title, path, text from chunks where embedding is null limit ?",
    batch,
  );
  if (!rows.length) return 0;
  const vecs = await e.embed(
    rows.map((r) => `${r.path || r.title}\n${r.text}`.slice(0, 2000)),
    "passage",
  );
  const upd = app.db.prepare("update chunks set embedding = ? where id = ?");
  rows.forEach((r, i) => upd.run(new Uint8Array(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength), r.id));
  vectorIndex().add(app, rows.map((r, i) => ({ id: r.id, spaceId: r.space_id, vec: vecs[i] })));
  return rows.length;
}

/** Embed active memories that have no vector yet (passive recall). Run after embedPending, which resets them on a model change. */
export async function embedPendingMemories(app: App, batch = 32): Promise<number> {
  const e = await getEmbedder(app);
  if (!e) return 0;
  if (one<{ value: string }>(app.db, "select value from kv where key = 'embedding_model'")?.value !== e.id) return 0;
  const rows = all<{ id: string; subject: string; content: string }>(app.db, "select id, subject, content from memories where status = 'active' and embedding is null limit ?", batch);
  if (!rows.length) return 0;
  const vecs = await e.embed(rows.map((r) => (r.subject ? `${r.subject}：${r.content}` : r.content).slice(0, 2000)), "passage");
  const upd = app.db.prepare("update memories set embedding = ? where id = ?");
  rows.forEach((r, i) => upd.run(new Uint8Array(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength), r.id));
  return rows.length;
}

/** One vector (a question by default; "passage" to compare memory with memory), or null when vectors are off or the model is unavailable. */
export async function embedQuery(app: App, text: string, kind: "query" | "passage" = "query"): Promise<Float32Array | null> {
  if (app.config.embeddings.provider === "none") return null;
  const e = await getEmbedder(app);
  if (!e) return null;
  const [q] = await e.embed([text.slice(0, 2000)], kind);
  return q;
}

export async function vectorSearch(app: App, query: string, spaces: string[] | undefined, limit: number) {
  if (app.config.embeddings.provider === "none") return [];
  const e = await getEmbedder(app);
  if (!e) return [];
  const [q] = await e.embed([query], "query");
  return vectorIndex().search(app, q, spaces, limit);
}
