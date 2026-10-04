/** Ranking diagnosis on an external corpus, NOT an end-to-end RAG benchmark.
 * Official passage IDs/boundaries and qrels stay intact. Labels never enter
 * the index. Both arms share ICU tokenization and FTS5 BM25 field weights.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { Store } from "../apps/server/src/store.js";
import { UnifiedRetrieval } from "../apps/server/src/retrieval/unified.js";
import { indexText } from "../apps/server/src/retrieval/units.js";
import { queryTerms } from "../apps/server/src/retrieval/relevance.js";

type Manifest = { repo: string; commit: string; files: { path: string; name: string; sha256: string; size: number; url: string }[] };
const manifest = JSON.parse(readFileSync(resolve("config/benchmarks/mtrag-cloud.json"), "utf8")) as Manifest;
const directory = resolve(process.env.osdk_arg_directory ?? process.argv[2] ?? ".repo-review/runtime/benchmarks/mtrag-cloud");
mkdirSync(directory, { recursive: true });
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
for (const file of manifest.files) {
  const path = join(directory, file.name);
  if (!existsSync(path)) {
    console.log("Downloading public benchmark:", file.name);
    const response = await fetch(file.url);
    if (!response.ok) throw Error(`Download failed: ${response.status} ${file.url}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length !== file.size || hash(data) !== file.sha256) throw Error(`Checksum mismatch: ${file.name}`);
    writeFileSync(path, data);
  }
  if (hash(readFileSync(path)) !== file.sha256) throw Error(`Cached checksum mismatch: ${file.name}`);
}
// Decode the verified archive every time, so an edited loose corpus cannot be
// mistaken for the pinned dataset. No third-party benchmark code is executed.
const corpusPath = join(directory, "cloud.jsonl");
writeFileSync(corpusPath, execFileSync("unzip", ["-p", join(directory, "cloud.jsonl.zip"), "cloud.jsonl"], { maxBuffer: 180_000_000 }));
const temporary = mkdtempSync(join(tmpdir(), "omem-mtrag-ranking-"));
const store = new Store(temporary);
const retrieval = new UnifiedRetrieval(store.db, undefined, undefined, true);
const qrels = new Map<string, Set<string>>();
for (const line of readFileSync(join(directory, "dev.tsv"), "utf8").trim().split("\n").slice(1)) {
  const [query, document, relevance] = line.split("\t");
  if (Number(relevance) > 0) {
    const relevant = qrels.get(query!) ?? new Set<string>();
    relevant.add(document!); qrels.set(query!, relevant);
  }
}
function metrics(ids: string[], relevant: Set<string>) {
  const at = (k: number) => ids.slice(0, k).filter(id => relevant.has(id)).length;
  const first = ids.slice(0, 10).findIndex(id => relevant.has(id));
  const dcg = ids.slice(0, 10).reduce((sum, id, i) => sum + (relevant.has(id) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(10, relevant.size) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return { recall5: at(5) / relevant.size, recall10: at(10) / relevant.size, recall20: at(20) / relevant.size,
    ndcg10: dcg / ideal, mrr10: first < 0 ? 0 : 1 / (first + 1), hit5: Number(at(5) > 0) };
}
type Scores = ReturnType<typeof metrics>;
type Result = { id: string; formulation: string; query: string; baseline: Scores; omem: Scores; baselineIds: string[]; omemIds: string[] };
const results: Result[] = [];
try {
  const insert = store.db.prepare("INSERT INTO retrieval_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const fts = store.db.prepare("INSERT INTO retrieval_units_fts(id,title,context,body) VALUES(?,?,?,?)");
  const corpusIds = new Set<string>();
  const reader = createInterface({ input: createReadStream(corpusPath), crlfDelay: Infinity });
  store.db.exec("BEGIN");
  for await (const line of reader) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as { _id: string; text: string; title?: string; url?: string };
    corpusIds.add(doc._id);
    // Passage IDs end in source-document offsets. Keep one owner per original
    // document so omem's normal two-excerpt diversity rule is actually exercised.
    const owner = doc._id.replace(/-\d+-\d+$/, "");
    const anchor = { kind: "source", key: owner, revisionId: owner, digest: hash(doc.text), startLine: 1, endLine: doc.text.split("\n").length, fragmentIds: [doc._id] };
    insert.run(doc._id, owner, "source", doc.title ?? "", doc.text, "", "[]", JSON.stringify(anchor), JSON.stringify([anchor]), JSON.stringify([doc._id]), "[]", "{}", null, "document", null);
    fts.run(doc._id, indexText(doc.title ?? ""), "", indexText(doc.text));
    if (corpusIds.size % 10000 === 0) console.log("Indexed passages", corpusIds.size);
  }
  store.db.exec("COMMIT");
  for (const ids of qrels.values()) for (const id of ids) if (!corpusIds.has(id)) throw Error(`Qrel absent from full corpus: ${id}`);
  const bm25 = store.db.prepare("SELECT id FROM retrieval_units_fts WHERE retrieval_units_fts MATCH ? ORDER BY bm25(retrieval_units_fts,0,2,1,4) LIMIT 20");
  for (const formulation of ["lastturn", "rewrite"]) {
    const queries = readFileSync(join(directory, `cloud_${formulation}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line) as { _id: string; text: string });
    if (new Set(queries.map(q => q._id)).size !== queries.length || queries.length !== qrels.size) throw Error("Query/qrels denominator mismatch");
    for (const q of queries) {
      const relevant = qrels.get(q._id);
      if (!relevant) throw Error(`Missing qrels: ${q._id}`);
      // Dataset speaker wrappers are transport, not part of the user's query.
      const query = q.text.replace(/\|user\|:\s*/g, "").trim();
      const terms = [...new Set(queryTerms(query).flatMap(t => indexText(t).split(" ")).filter(Boolean))];
      const phrase = terms.map(t => '"' + t.replaceAll('"', '""') + '"').join(" OR ");
      const baselineIds = phrase ? bm25.all(phrase).map(r => String(r.id)) : [];
      const omemIds = (await retrieval.search({ text: query, limit: 20 })).map(r => r.id);
      results.push({ id: q._id, formulation, query, baseline: metrics(baselineIds, relevant), omem: metrics(omemIds, relevant), baselineIds, omemIds });
      if (results.length % 20 === 0) console.log("Queries compared", results.length);
    }
  }
  const summary = ["lastturn", "rewrite"].map(formulation => {
    const rows = results.filter(r => r.formulation === formulation);
    const mean = (arm: "baseline" | "omem") => Object.fromEntries(Object.keys(rows[0]![arm]).map(key => [key, rows.reduce((sum, r) => sum + r[arm][key as keyof Scores], 0) / rows.length]));
    return { formulation, questions: rows.length, baseline: mean("baseline"), omem: mean("omem"),
      recall20Improved: rows.filter(r => r.omem.recall20 > r.baseline.recall20).length,
      recall20Regressed: rows.filter(r => r.omem.recall20 < r.baseline.recall20).length,
      lostAllTop20Support: rows.filter(r => r.baseline.recall20 > 0 && r.omem.recall20 === 0).map(r => r.id) };
  });
  const report = { recordedAt: new Date().toISOString(), implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dataset: manifest, corpusSha256: hash(readFileSync(corpusPath)), corpusPassages: corpusIds.size, questions: qrels.size,
    scope: "Full MTRAG Cloud retrieval dev subset; official presegmented English corpus and official positive qrels. Ranking-only: no capture, embeddings, catalog, knowledge, ACP or answer generation. Baseline shares omem ICU/query terms/FTS5 weights; it is not the paper's BM25 implementation. Official rewrites are supplied controls, not omem-generated rewrites. Unjudged passages are not known irrelevant.",
    summary, results };
  writeFileSync(join(directory, "ranking-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ corpusPassages: report.corpusPassages, questions: report.questions, summary }, null, 2));
} finally {
  await retrieval.close(); store.close(); rmSync(temporary, { recursive: true, force: true });
  rmSync(corpusPath, { force: true });
}
