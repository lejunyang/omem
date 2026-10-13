/**
 * Scale benchmark: build a large synthetic library from a JSONL corpus copied
 * into several spaces, then time full-text search (one space / all spaces),
 * vector search over random vectors, and memory use.
 *
 *   node scripts/bench-scale.ts <corpus.jsonl> [--copies 10] [--home DIR] [--queries queries.jsonl] [--dims 512]
 *
 * Vectors are random (embedding a large corpus on CPU takes hours); they only
 * measure the cost of the vector search itself, not its quality.
 */
process.removeAllListeners("warning");
const { existsSync, readFileSync, statSync } = await import("node:fs");
const { join } = await import("node:path");
const { App } = await import("../src/core/app.ts");
const { createSpace, ensurePersonalSpace, findSpace } = await import("../src/core/spaces.ts");
const { upsertSource } = await import("../src/sources/store.ts");
const { search } = await import("../src/search/search.ts");
const { one, run, tx } = await import("../src/core/db.ts");
const embeddings = await import("../src/search/embeddings.ts");

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const corpusPath = args[0];
const copies = Number(opt("--copies", "10"));
const dims = Number(opt("--dims", "512"));
const home = opt("--home", join(process.cwd(), ".scratch", "bench-scale"));
const queriesPath = opt("--queries", "");

const fresh = !existsSync(join(home, "omem.db"));
const app = App.open(home);
ensurePersonalSpace(app);
const docs = readFileSync(corpusPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string; title?: string });
const mb = () => Math.round(process.memoryUsage().rss / 1e6);
const time = async <T>(f: () => Promise<T> | T) => {
  const t = performance.now();
  const r = await f();
  return { r, ms: performance.now() - t };
};

if (fresh) {
  const t0 = performance.now();
  for (let c = 0; c < copies; c++) {
    const id = `s${c}`;
    if (!findSpace(app, id)) createSpace(app, { id, name: id, kind: "topic" });
    for (const d of docs) upsertSource(app, { spaceId: id, kind: "doc", uri: d.id, title: d.title ?? d.text.slice(0, 30), text: d.text });
    console.error(`space ${id}: ${docs.length} docs, ${Math.round((performance.now() - t0) / 1000)} s, rss ${mb()} MB`);
  }
  // Random unit vectors, written straight into chunks.
  const n = one<{ n: number }>(app.db, "select count(*) n from chunks")!.n;
  const upd = app.db.prepare("update chunks set embedding = ? where id = ?");
  const ids = app.db.prepare("select id from chunks").all() as { id: number }[];
  tx(app.db, () => {
    for (const { id } of ids) {
      const v = new Float32Array(dims);
      let s = 0;
      for (let k = 0; k < dims; k++) s += (v[k] = Math.random() - 0.5) ** 2;
      s = Math.sqrt(s);
      for (let k = 0; k < dims; k++) v[k] /= s;
      upd.run(new Uint8Array(v.buffer), id);
    }
  });
  run(app.db, "insert into kv(key,value) values('embedding_model', 'bench') on conflict(key) do update set value = excluded.value");
  console.error(`built ${n} chunks in ${Math.round((performance.now() - t0) / 1000)} s`);
}

const chunks = one<{ n: number }>(app.db, "select count(*) n from chunks")!.n;
const sources = one<{ n: number }>(app.db, "select count(*) n from sources")!.n;
const dbSize = statSync(join(home, "omem.db")).size;
console.log(`library: ${sources} sources, ${chunks} chunks, db ${Math.round(dbSize / 1e6)} MB`);

const queries = queriesPath ? readFileSync(queriesPath, "utf8").split("\n").filter(Boolean).slice(0, 30).map((l) => (JSON.parse(l) as { text: string }).text) : docs.slice(0, 30).map((d) => d.text.slice(5, 25));
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
async function bench(label: string, f: (q: string) => Promise<unknown>) {
  const ms: number[] = [];
  for (const q of queries) ms.push((await time(() => f(q))).ms);
  console.log(`${label.padEnd(34)} p50 ${pct(ms, 0.5).toFixed(0).padStart(5)} ms  p90 ${pct(ms, 0.9).toFixed(0).padStart(5)} ms  rss ${mb()} MB`);
}

app.config.embeddings.provider = "none";
await bench("fts, one space", (q) => search(app, q, { spaces: ["s3"], limit: 20 }));
await bench("fts, all spaces", (q) => search(app, q, { limit: 20 }));

// Vector search cost with a fake embedder: the query vector is random too.
app.config.embeddings.provider = "local";
embeddings.setEmbedderForTests({
  id: "bench",
  async embed(texts: string[]) {
    return texts.map(() => {
      const v = new Float32Array(dims);
      for (let k = 0; k < dims; k++) v[k] = Math.random() - 0.5;
      return v;
    });
  },
});
const first = await time(() => embeddings.vectorSearch(app, "warm", ["s3"], 50));
console.log(`vector cache load (one space)       ${first.ms.toFixed(0)} ms  rss ${mb()} MB`);
await bench("vector, one space", (q) => embeddings.vectorSearch(app, q, ["s3"], 50));
const all = await time(() => embeddings.vectorSearch(app, "warm", undefined, 50));
console.log(`vector cache load (all spaces)      ${all.ms.toFixed(0)} ms  rss ${mb()} MB`);
await bench("vector, all spaces", (q) => embeddings.vectorSearch(app, q, undefined, 50));
await bench("hybrid search, all spaces", (q) => search(app, q, { limit: 20 }));
