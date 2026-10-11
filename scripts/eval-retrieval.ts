/**
 * BEIR-style retrieval evaluation of omem's search layer.
 *
 *   node scripts/eval-retrieval.ts <corpus.jsonl> <queries.jsonl> [--vector] [--limit N] [--home DIR]
 *
 * corpus.jsonl: {"id","text","title"?}   queries.jsonl: {"id","text","rels":{docId: grade}}
 * Reports nDCG@10, Recall@10/@50 and MRR@10 at document level (chunks are
 * folded into their source). The same library is reused across runs when
 * --home points at an existing directory.
 */
process.removeAllListeners("warning");
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { App } = await import("../src/core/app.ts");
const { ensurePersonalSpace } = await import("../src/core/spaces.ts");
const { upsertSource } = await import("../src/sources/store.ts");
const { search } = await import("../src/search/search.ts");
const { embedPending } = await import("../src/search/embeddings.ts");
const { all } = await import("../src/core/db.ts");

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const [corpusPath, queriesPath] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const home = opt("--home", join(process.cwd(), ".scratch", "eval-home"));
const limitQ = Number(opt("--limit", "100000"));
const vector = flag("--vector");

const read = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fresh = !existsSync(join(home, "omem.db"));
const app = App.open(home);
ensurePersonalSpace(app);
app.config.embeddings.provider = vector ? "local" : "none";

if (fresh) {
  const t = Date.now();
  const docs = read(corpusPath) as { id: string; text: string; title?: string }[];
  for (const d of docs) upsertSource(app, { spaceId: "personal", kind: "doc", uri: d.id, title: d.title ?? d.text.slice(0, 40), text: d.text });
  console.error(`indexed ${docs.length} docs in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
if (vector) {
  const t = Date.now();
  let n = 0;
  for (;;) {
    const k = await embedPending(app, 64);
    if (!k) break;
    n += k;
    if (n % 1024 < 64) console.error(`embedded ${n} chunks…`);
  }
  console.error(`embeddings ready (+${n}) in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
const uriOf = new Map(all<{ id: string; uri: string }>(app.db, "select id, uri from sources").map((r) => [r.id, r.uri]));
const queries = (read(queriesPath) as { id: string; text: string; rels: Record<string, number> }[]).slice(0, limitQ);

const dcg = (grades: number[]) => grades.reduce((s, g, i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
let ndcg = 0, r10 = 0, r50 = 0, mrr = 0, ms = 0;
for (const q of queries) {
  const t = performance.now();
  const hits = await search(app, q.text, { types: ["chunk"], limit: 50, perSource: 1 });
  ms += performance.now() - t;
  const ranked = hits.map((h) => uriOf.get(h.sourceId!)!).filter(Boolean);
  const relevant = Object.entries(q.rels).filter(([, g]) => g > 0);
  const ideal = relevant.map(([, g]) => g).sort((a, b) => b - a).slice(0, 10);
  ndcg += dcg(ranked.slice(0, 10).map((id) => q.rels[id] ?? 0)) / (dcg(ideal) || 1);
  const relSet = new Set(relevant.map(([id]) => id));
  r10 += ranked.slice(0, 10).filter((id) => relSet.has(id)).length / relSet.size;
  r50 += ranked.slice(0, 50).filter((id) => relSet.has(id)).length / relSet.size;
  const first = ranked.slice(0, 10).findIndex((id) => relSet.has(id));
  mrr += first >= 0 ? 1 / (first + 1) : 0;
}
const n = queries.length;
const pct = (x: number) => ((100 * x) / n).toFixed(2);
console.log(JSON.stringify({ mode: vector ? "fts+vector (RRF)" : "fts", queries: n, "nDCG@10": pct(ndcg), "Recall@10": pct(r10), "Recall@50": pct(r50), "MRR@10": pct(mrr), avgMs: (ms / n).toFixed(1) }));
