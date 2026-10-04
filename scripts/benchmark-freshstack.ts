/** Full official Godot topic, preserving source owners and evaluator-side nuggets.
 * The benchmark command explicitly downloads its pinned data and optional Python
 * evaluator dependencies. The application runtime has no Python requirement.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { Store } from "../apps/server/src/store.js";
import { UnifiedRetrieval } from "../apps/server/src/retrieval/unified.js";
import { indexText } from "../apps/server/src/retrieval/units.js";
import { queryTerms } from "../apps/server/src/retrieval/relevance.js";
import { taskFlag } from "./task-args.js";

const manifest = JSON.parse(
  readFileSync("config/benchmarks/freshstack-godot.json", "utf8"),
) as {
  topic: string;
  corpusSize: number;
  uniqueDocuments: number;
  questions: number;
  evaluator: {
    revision: string;
    sha256: string;
    python: string;
    dependencies: string[];
  };
  files: {
    role: string;
    repo: string;
    revision: string;
    path: string;
    size: number;
    sha256: string;
  }[];
};
type Document = {
  _id: string;
  text: string;
  metadata: { url: string; start_byte: bigint; end_byte: bigint };
};
type Question = {
  query_id: string;
  query_title: string;
  query_text: string;
  nuggets: {
    _id: string;
    relevant_corpus_ids: string[];
    non_relevant_corpus_ids: string[];
  }[];
};
const arms = ["bm25", "assistant", "browse"] as const;
type Arm = (typeof arms)[number];
type Result = {
  id: string;
  query: string;
  rankings: Record<Arm, string[]>;
  elapsedMs: number;
};
const directory = resolve(
  process.env.osdk_arg_directory ??
    process.argv[2] ??
    ".repo-review/runtime/benchmarks/freshstack-godot",
);
mkdirSync(directory, { recursive: true });
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const sources = [
  "scripts/benchmark-freshstack.ts",
  "apps/server/src/retrieval/unified.ts",
  "apps/server/src/retrieval/units.ts",
  "apps/server/src/retrieval/relevance.ts",
  "apps/server/src/retrieval/code-navigation.ts",
  "pnpm-lock.yaml",
];
const identity = hash(
  JSON.stringify(manifest) +
    sources.map((p) => hash(readFileSync(p))).join(":"),
);
const statePath = join(directory, "ranking-state.json"),
  rowsPath = join(directory, "rankings.ndjson"),
  reportPath = join(directory, "ranking-report.json");
const evaluateOnly = taskFlag("evaluate-only");
if (evaluateOnly && (!existsSync(statePath) || taskFlag("reset")))
  throw Error(
    "Evaluation requires an existing ranking checkpoint and cannot reset it.",
  );
if (taskFlag("reset"))
  for (const p of [statePath, rowsPath, reportPath]) rmSync(p, { force: true });
if (
  !evaluateOnly &&
  existsSync(statePath) &&
  JSON.parse(readFileSync(statePath, "utf8")).identity !== identity
)
  throw Error(
    "Implementation changed: use --reset or another benchmark directory.",
  );
if (!existsSync(statePath))
  writeFileSync(
    statePath,
    JSON.stringify({
      identity,
      sources,
      implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      startedAt: new Date().toISOString(),
    }),
  );
const state = JSON.parse(readFileSync(statePath, "utf8"));
async function pinnedFile(
  path: string,
  url: string,
  digest: string,
  size?: number,
) {
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) throw Error(`Download HTTP ${response.status}: ${url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== digest || (size !== undefined && bytes.length !== size))
      throw Error("Download identity mismatch");
    writeFileSync(path, bytes);
  }
  const bytes = readFileSync(path);
  if (hash(bytes) !== digest || (size !== undefined && bytes.length !== size))
    throw Error(`Cache identity mismatch: ${path}`);
}
for (const f of manifest.files)
  await pinnedFile(
    join(directory, f.role + ".parquet"),
    `https://huggingface.co/datasets/${f.repo}/resolve/${f.revision}/${f.path}`,
    f.sha256,
    f.size,
  );
const metricsPath = join(directory, "metrics.py");
await pinnedFile(
  metricsPath,
  `https://raw.githubusercontent.com/fresh-stack/freshstack/${manifest.evaluator.revision}/freshstack/retrieval/metrics.py`,
  manifest.evaluator.sha256,
);
const python = join(
  directory,
  "evaluator-venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
if (!existsSync(python))
  execFileSync(
    "osdk",
    [
      "exec",
      "--no-deps",
      "--tool",
      `python@${manifest.evaluator.python}`,
      "--",
      "python",
      "-m",
      "venv",
      join(directory, "evaluator-venv"),
    ],
    { stdio: "inherit" },
  );
execFileSync(
  python,
  [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    ...manifest.evaluator.dependencies,
  ],
  { stdio: "inherit" },
);
const corpusRows = (await parquetReadObjects({
  file: await asyncBufferFromFile(join(directory, "corpus.parquet")),
})) as unknown as Document[];
const questions = (await parquetReadObjects({
  file: await asyncBufferFromFile(join(directory, "queries.parquet")),
})) as unknown as Question[];
if (
  corpusRows.length !== manifest.corpusSize ||
  questions.length !== manifest.questions
)
  throw Error("Incomplete official topic");
// Upstream DataLoader uses a dict comprehension: last row wins for duplicate
// corpus IDs. Godot has five duplicates, including two with different bytes.
const corpus = [...new Map(corpusRows.map((d) => [d._id, d])).values()];
const documentIds = new Set(corpus.map((d) => d._id)),
  questionIds = new Set(questions.map((q) => q.query_id));
if (
  documentIds.size !== manifest.uniqueDocuments ||
  questionIds.size !== questions.length
)
  throw Error("Official ID denominator mismatch");
const qrelsNuggets: Record<string, Record<string, number>> = {},
  queryToNuggets: Record<string, string[]> = {},
  qrelsQuery: Record<string, Record<string, number>> = {};
for (const q of questions) {
  queryToNuggets[q.query_id] = q.nuggets.map((n) => n._id);
  qrelsQuery[q.query_id] = {};
  if (!q.nuggets.length) throw Error(`No nuggets: ${q.query_id}`);
  for (const n of q.nuggets) {
    const labels: Record<string, number> = {};
    for (const [ids, value] of [
      [n.non_relevant_corpus_ids, 0],
      [n.relevant_corpus_ids, 1],
    ] as const)
      for (const id of ids) {
        if (!documentIds.has(id))
          throw Error(`Missing labelled document: ${id}`);
        labels[id] = value;
        qrelsQuery[q.query_id]![id] = Math.max(
          qrelsQuery[q.query_id]![id] ?? 0,
          value,
        );
      }
    qrelsNuggets[n._id] = labels;
  }
}
const results: Result[] = existsSync(rowsPath)
  ? readFileSync(rowsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : [];
const done = new Set(results.map((r) => r.id));
if (
  done.size !== results.length ||
  [...done].some((id) => !questionIds.has(id))
)
  throw Error("Invalid checkpoint");
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopped = true;
  });
if (!evaluateOnly) {
  const temporary = mkdtempSync(join(tmpdir(), "omem-freshstack-")),
    store = new Store(temporary),
    retrieval = new UnifiedRetrieval(store.db, undefined, undefined, true);
  try {
    const insert = store.db.prepare(
        "INSERT INTO retrieval_units VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ),
      fts = store.db.prepare(
        "INSERT INTO retrieval_units_fts(id,title,context,body) VALUES(?,?,?,?)",
      );
    store.db.exec("BEGIN");
    for (const d of corpus) {
      // Source URL groups official chunks; ranges below address the immutable
      // official passage, not invented original-file lines. Byte locators stay in
      // the downloaded official metadata and are not used as relevance labels.
      const anchor = {
        kind: "source",
        key: d._id,
        revisionId: d._id,
        digest: hash(d.text),
        startLine: 1,
        endLine: d.text.split("\n").length,
        fragmentIds: [d._id],
      };
      insert.run(
        d._id,
        d.metadata.url,
        "source",
        "",
        d.text,
        "",
        "[]",
        JSON.stringify(anchor),
        JSON.stringify([anchor]),
        JSON.stringify([d._id]),
        "[]",
        "{}",
        null,
        "document",
        null,
      );
      fts.run(d._id, "", "", indexText(d.text));
    }
    store.db.exec("COMMIT");
    console.log(
      "Indexed",
      corpus.length,
      "official passages; comparing",
      questions.length,
      "complete questions",
    );
    const bm25 = store.db.prepare(
      "SELECT id FROM retrieval_units_fts WHERE retrieval_units_fts MATCH ? ORDER BY bm25(retrieval_units_fts,0,2,1,4) LIMIT 20",
    );
    for (const q of questions) {
      if (done.has(q.query_id)) continue;
      if (stopped) break;
      const query = q.query_title + " " + q.query_text,
        start = performance.now();
      const terms = [
        ...new Set(
          queryTerms(query)
            .flatMap((t) => indexText(t).split(" "))
            .filter(Boolean),
        ),
      ];
      const phrase = terms
        .map((t) => '"' + t.replaceAll('"', '""') + '"')
        .join(" OR ");
      const rankings = {
        bm25: phrase ? bm25.all(phrase).map((r) => String(r.id)) : [],
        assistant: (
          await retrieval.search({ text: query, limit: 20, diversify: false })
        ).map((r) => r.id),
        browse: (await retrieval.search({ text: query, limit: 20 })).map(
          (r) => r.id,
        ),
      };
      const result = {
        id: q.query_id,
        query,
        rankings,
        elapsedMs: Math.round(performance.now() - start),
      };
      appendFileSync(rowsPath, JSON.stringify(result) + "\n");
      results.push(result);
      if (results.length % 10 === 0)
        console.log("Compared", results.length, "/", questions.length);
      await setImmediate();
    }
  } finally {
    await retrieval.close();
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}
const complete = !stopped && results.length === questions.length;
const evaluatorInput = join(directory, "evaluator-input.json");
writeFileSync(
  evaluatorInput,
  JSON.stringify({
    qrelsNuggets,
    queryToNuggets,
    qrelsQuery,
    runs: Object.fromEntries(
      arms.map((arm) => [
        arm,
        Object.fromEntries(
          results.map((r) => [
            r.id,
            Object.fromEntries(r.rankings[arm].map((id, i) => [id, 20 - i])),
          ]),
        ),
      ]),
    ),
  }),
);
// Execute the checksum-verified upstream functions; no local substitute metric.
const metrics = complete
  ? JSON.parse(
      execFileSync(
        python,
        [
          "-c",
          `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("freshstack_metrics",sys.argv[1])
metrics=importlib.util.module_from_spec(spec); spec.loader.exec_module(metrics)
data=json.load(open(sys.argv[2])); output={}
for arm,results in data["runs"].items():
    # Upstream alpha_ndcg indexes a missing pyndeval result for empty runs.
    # Skip evaluating that empty run, but keep ALL query_to_nuggets in its
    # denominator, so unanswered queries still contribute zero, never disappear.
    nonempty={qid:docs for qid,docs in results.items() if docs}
    output[arm]={**metrics.alpha_ndcg(data["qrelsNuggets"],data["queryToNuggets"],nonempty,[5,10,20]),**metrics.coverage(data["qrelsNuggets"],data["queryToNuggets"],results,[5,10,20]),**metrics.recall(data["qrelsQuery"],results,[5,10,20])}
print(json.dumps(output))
`,
          metricsPath,
          evaluatorInput,
        ],
        { encoding: "utf8" },
      ),
    )
  : null;
const report = {
  recordedAt: new Date().toISOString(),
  complete,
  ...state,
  dataset: manifest,
  completedQuestions: results.length,
  metrics,
  scope:
    "Full pinned FreshStack Godot topic, official passages and title + query text. Corpus IDs use upstream DataLoader last-row-wins semantics: 25,482 rows / 25,477 unique passages. Official answer/nuggets remain evaluator-side. Same ICU/FTS5 fields; BM25 versus current lexical assistant candidates and browse grouping. Source URL defines grouping, no embeddings, reranker, material classification, AST parsing, ACP or answer generation. Metrics measure labelled passage/nugget coverage, not answer quality. Unjudged passages are not proven irrelevant.",
  resultsFile: "rankings.ndjson",
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!complete) process.exitCode = 130;
