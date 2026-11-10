import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { vectorIndex } from "./vectors.ts";
import { all, one, run } from "../core/db.ts";
import { readProcess } from "./read-process.ts";
import { searchStage } from "./trace.ts";

/**
 * Optional dense retrieval. Vectors live next to chunks as Float32 BLOBs and are
 * searched by brute-force cosine: a personal library (≤ a few hundred thousand
 * chunks) fits in memory and needs no ANN index. Changing the model clears all
 * vectors, so mixed embeddings never compete in one ranking.
 */
type Embedder = { id: string; embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]> };

let embedder: Embedder | null | undefined;
let testEmbedder = false;

export function resetEmbedder() {
  embedder = undefined;
  vectorIndex().clear();
}

async function getEmbedder(app: App, inProcess = false): Promise<Embedder | null> {
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
  if (!inProcess && !testEmbedder) {
    try {
      // Validate in the child before embedPending is allowed to replace an old model's vectors.
      await readProcess(app, "embedding").request({ op: "embed", texts: [], kind: "passage", config: { embeddings: cfg } }, 120_000);
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
    const local = existsSync(model);
    mod.env.localModelPath = local ? dirname(resolve(model)) + "/" : "/models/";
    mod.env.allowRemoteModels = !local;
    return load(mod, local ? basename(resolve(model)) : model);
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

function normalize(v: Float32Array) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
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
  const e = await getEmbedder(app);
  if (!e) return 0;
  const current = one<{ value: string }>(app.db, "select value from kv where key = 'embedding_model'")?.value;
  if (current !== e.id) {
    run(app.db, "update chunks set embedding = null");
    run(app.db, "update memories set embedding = null");
    run(app.db, "insert into kv(key,value) values('embedding_model', ?) on conflict(key) do update set value = excluded.value", e.id);
    // Every vector is gone: readers start over on the model change, the log's entries for it are noise.
    run(app.db, "insert into kv(key,value) values('vector_log_floor', (select coalesce(max(seq), 0) from vector_log)) on conflict(key) do update set value = excluded.value");
    run(app.db, "delete from vector_log");
    vectorIndex().clear();
  }
  const rows = all<{ id: number; space_id: string; title: string; path: string; text: string }>(
    app.db,
    "select id, space_id, title, path, text from chunks where embedding is null and space_id not like 'wt-%' limit ?",
    batch,
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
    if (t?.embedding) known.set(r.id, new Float32Array(t.embedding.buffer.slice(t.embedding.byteOffset, t.embedding.byteOffset + t.embedding.byteLength)));
  }
  // Within the batch too: identical inputs are embedded once.
  const input = (r: (typeof rows)[number]) => `${r.path || r.title}\n${r.text}`.slice(0, 2000);
  const fresh = [...new Set(rows.filter((r) => !known.has(r.id)).map(input))];
  const made = fresh.length ? await e.embed(fresh, "passage") : [];
  const byInput = new Map(fresh.map((t, i) => [t, made[i]]));
  for (const r of rows) if (!known.has(r.id)) known.set(r.id, byInput.get(input(r))!);
  const upd = app.db.prepare("update chunks set embedding = ? where id = ?");
  for (const r of rows) {
    const v = known.get(r.id)!;
    upd.run(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), r.id);
  }
  vectorIndex().add(app, rows.map((r) => ({ id: r.id, spaceId: r.space_id, vec: known.get(r.id)! })));
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

/** Only the isolated process loads the local runtime. The parent keeps batching and writes. */
export async function embedLocally(app: App, texts: string[], kind: "query" | "passage") {
  const e = await getEmbedder(app, true);
  if (!e) throw new Error("向量模型不可用");
  return e.embed(texts, kind);
}

export async function vectorSearch(app: App, query: string, spaces: string[] | undefined, limit: number) {
  if (app.config.embeddings.provider === "none") return [];
  if (!testEmbedder) return searchStage("vector", () => readProcess(app, "vector").request<{ chunkId: number; score: number }[]>({ op: "vector", query, spaces, limit, config: { embeddings: app.config.embeddings } }, 30_000));
  const e = await getEmbedder(app);
  if (!e) return [];
  const [q] = await e.embed([query], "query");
  await vectorIndex().prepare(app, spaces);
  return vectorIndex().search(app, q, spaces, limit);
}
