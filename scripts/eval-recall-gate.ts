/**
 * Calibrate the passive-recall gate (src/memory/passive.ts).
 *
 *   node scripts/eval-recall-gate.ts <corpus.jsonl> <queries.jsonl> <neg_queries.jsonl> [--chars N] [--home DIR] [--limit 5]
 *
 * Each corpus document becomes one memory (cut to --chars, default whole text). queries.jsonl
 * have relevant documents in the corpus ({"id","text","rels"}); neg_queries.jsonl have none
 * (their relevant documents were left out), standing in for messages no memory is about.
 * For each threshold it reports, on positive queries, how often something is added and how
 * often that includes a relevant memory, the precision of what is added, and on negative
 * queries how often anything is added at all (all of it noise).
 */
process.removeAllListeners("warning");
const { existsSync, readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { App } = await import("../src/core/app.ts");
const { ensurePersonalSpace } = await import("../src/core/spaces.ts");
const { remember } = await import("../src/memory/store.ts");
const { passiveRecall } = await import("../src/memory/passive.ts");
const { embedPending, embedPendingMemories } = await import("../src/search/embeddings.ts");

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const [corpusPath, posPath, negPath] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const chars = Number(opt("--chars", "0"));
const home = opt("--home", join(process.cwd(), ".scratch", `eval-gate${chars ? "-" + chars : ""}`));
const limit = Number(opt("--limit", "5"));

const read = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const fresh = !existsSync(join(home, "omem.db"));
const app = App.open(home);
ensurePersonalSpace(app);
app.config.embeddings.provider = "local";
if (fresh) {
  for (const d of read(corpusPath) as { id: string; text: string }[]) {
    const text = d.text.replace(/<br>|<img>/g, " ").replace(/\s+/g, " ").trim();
    remember(app, { spaceId: "personal", kind: "fact", content: chars ? text.slice(0, chars) : text, tags: [`doc-${d.id}`], createdBy: "user" });
  }
}
await embedPending(app, 64); // records the model, so memory vectors are accepted
const t0 = Date.now();
let n = 0;
for (let k = await embedPendingMemories(app, 64); k; k = await embedPendingMemories(app, 64)) {
  n += k;
  if (n % 1024 < 64) console.error(`embedded ${n} memories…`);
}
if (n) console.error(`memory vectors ready (+${n}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

type Q = { id: string; text: string; rels: Record<string, number> };
const docOf = (tags: string[] | undefined) => tags?.find((t) => t.startsWith("doc-"))?.slice(4) ?? "";
async function top(q: Q) {
  const hits = await passiveRecall(app, { text: q.text, spaces: ["personal"], userId: "owner", threshold: 0, limit: 10 });
  return hits.map((h) => ({ doc: docOf(h.memory.tags), score: h.score }));
}
const pos: { q: Q; hits: Awaited<ReturnType<typeof top>> }[] = [];
for (const q of read(posPath) as Q[]) pos.push({ q, hits: await top(q) });
const neg: typeof pos = [];
for (const q of read(negPath) as Q[]) neg.push({ q, hits: await top(q) });

// Ranking quality of the memory vectors themselves (no gate).
const dcg = (g: number[]) => g.reduce((s, x, i) => s + (2 ** x - 1) / Math.log2(i + 2), 0);
let ndcg = 0;
for (const { q, hits } of pos) {
  const ideal = Object.values(q.rels).sort((a, b) => b - a).slice(0, 10);
  ndcg += dcg(hits.map((h) => q.rels[h.doc] ?? 0)) / (dcg(ideal) || 1);
}
console.log(JSON.stringify({ memories: chars ? `first ${chars} chars` : "whole document", pos: pos.length, neg: neg.length, "nDCG@10": ((100 * ndcg) / pos.length).toFixed(2) }));

const pct = (x: number, d: number) => (d ? ((100 * x) / d).toFixed(1) : "-");
console.log("threshold | pos: any added | pos: relevant added | precision of added | avg added | neg: any added | neg avg added");
for (let t = 0.4; t <= 0.801; t += 0.025) {
  let pAny = 0, pRel = 0, added = 0, addedRel = 0, nAny = 0, nAdded = 0;
  for (const { q, hits } of pos) {
    const kept = hits.filter((h) => h.score >= t).slice(0, limit);
    if (kept.length) pAny++;
    if (kept.some((h) => q.rels[h.doc])) pRel++;
    added += kept.length;
    addedRel += kept.filter((h) => q.rels[h.doc]).length;
  }
  for (const { hits } of neg) {
    const kept = hits.filter((h) => h.score >= t).slice(0, limit);
    if (kept.length) nAny++;
    nAdded += kept.length;
  }
  console.log(`${t.toFixed(3)} | ${pct(pAny, pos.length)}% | ${pct(pRel, pos.length)}% | ${pct(addedRel, added)}% | ${(added / pos.length).toFixed(2)} | ${pct(nAny, neg.length)}% | ${(nAdded / neg.length).toFixed(2)}`);
}
