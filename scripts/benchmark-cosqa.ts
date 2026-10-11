/** Pinned public code retrieval; labels stay outside the captured library and
 * model. Stage ranks distinguish model judgment from host slot preservation. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { Store } from "../apps/server/src/store.js";
import {
  UnifiedRetrieval,
  type RetrievalTrace,
} from "../apps/server/src/retrieval/unified.js";
import { RetrievalProjection } from "../apps/server/src/retrieval/units.js";
import { loadChineseReranker } from "../apps/server/src/retrieval/reranker.js";
import type { RetrievalHit } from "../apps/server/src/retrieval/port.js";
import { taskFlag } from "./task-args.js";

const manifest = JSON.parse(
  readFileSync("config/benchmarks/cosqa.json", "utf8"),
) as {
  repo: string;
  revision: string;
  corpusSize: number;
  files: { role: string; path: string; size: number; sha256: string }[];
};
const directory = resolve(
  process.env.osdk_arg_directory ?? ".repo-review/runtime/benchmarks/cosqa",
);
const option = (name: string, fallback: string) =>
  process.env[`osdk_arg_${name.replaceAll("-", "_")}`] ??
  process.env[`osdk_arg_${name}`] ??
  fallback;
const integer = (name: string, fallback: string, min: number, max: number) => {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max)
    throw Error(`Invalid ${name}`);
  return value;
};
const offset = integer("offset", "50", 0, 499),
  count = integer("count", "50", 1, 500);
const budgetMs = integer("budget-ms", "0", 0, Number.MAX_SAFE_INTEGER);
const budgetsMs = option("budgets-ms", "")
  ? option("budgets-ms", "").split(",").map(Number)
  : [budgetMs];
if (!budgetsMs.length || new Set(budgetsMs).size !== budgetsMs.length ||
    budgetsMs.some(n => !Number.isSafeInteger(n) || n < 0)) throw Error("Invalid budgets-ms");
const armName = (alias: string, budget: number) => budgetsMs.length === 1 ? alias : `${alias}@${budget}`;
const aliases = option("models", "relevance-zh").split(",").filter(Boolean);
if (
  !aliases.length ||
  new Set(aliases).size !== aliases.length ||
  aliases.some((a) => !["relevance-zh", "relevance-zh-v2"].includes(a))
)
  throw Error("Unsupported/duplicate installed model alias");
const baselineRef = option("baseline", "");
if (baselineRef && (budgetsMs.length > 1 || budgetsMs.includes(0)))
  throw Error("Old return projection replay requires one positive budget; use current arms for unlimited comparison");
mkdirSync(directory, { recursive: true });
const hash = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const baselineCommit = baselineRef
  ? execFileSync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", baselineRef + "^{commit}"],
      { encoding: "utf8" },
    ).trim()
  : undefined;
// This compares the return/host projection, keeping current shared recall and
// inference modules identical. It is not a replay of an entire older program.
let Baseline: typeof UnifiedRetrieval | undefined;
if (baselineCommit) {
  const original = resolve("apps/server/src/retrieval/unified.ts");
  const code = execFileSync(
    "git",
    ["show", baselineCommit + ":apps/server/src/retrieval/unified.ts"],
    { encoding: "utf8" },
  );
  const local = join(directory, "baseline-unified.ts");
  writeFileSync(
    local,
    code.replace(
      /from ["'](\.\.?\/[^"']+)["']/g,
      (_match, path: string) =>
        "from " + JSON.stringify(resolve(dirname(original), path)),
    ),
  );
  Baseline = (await import(local)).UnifiedRetrieval;
}
for (const file of manifest.files) {
  const path = join(directory, file.role + ".parquet");
  if (!existsSync(path)) {
    const response = await fetch(
      `https://huggingface.co/datasets/${manifest.repo}/resolve/${manifest.revision}/${file.path}`,
    );
    if (!response.ok) throw Error(`Public data HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  if (bytes.length !== file.size || hash(bytes) !== file.sha256)
    throw Error("Public data checksum mismatch: " + file.role);
}
const readRows = async (role: string) =>
  parquetReadObjects({
    file: await asyncBufferFromFile(join(directory, role + ".parquet")),
  });
const queries = (await readRows("queries")) as { _id: string; text: string }[];
const labels = (await readRows("qrels")) as {
  "query-id": string;
  "corpus-id": string;
  score: number;
}[];
const positives = new Map<string, string[]>();
for (const row of labels)
  if (row.score > 0)
    positives.set(row["query-id"], [
      ...(positives.get(row["query-id"]) ?? []),
      row["corpus-id"],
    ]);
const selected = [...positives.keys()]
  .sort((a, b) => hash(a).localeCompare(hash(b)))
  .slice(offset, offset + count);
if (selected.length !== count)
  throw Error("Selected count exceeds positive query set");
const cases = selected.map((id) => ({
  id,
  query: queries.find((q) => q._id === id)!.text,
  relevant: positives.get(id)!,
}));
const registrationPath = join(directory, "registered.json");
const registration = existsSync(registrationPath)
  ? JSON.parse(readFileSync(registrationPath, "utf8"))
  : {
      registeredAt: new Date().toISOString(),
      revision: manifest.revision,
      offset,
      count,
      cases,
    };
if (
  registration.revision !== manifest.revision ||
  JSON.stringify(registration.cases) !== JSON.stringify(cases)
)
  throw Error("Registered public questions changed; choose another directory");
writeFileSync(registrationPath, JSON.stringify(registration, null, 2) + "\n");
const identity = hash(
  JSON.stringify({ manifest, cases, budgetsMs, aliases, baselineCommit }) +
    [
      "apps/server/src/retrieval/unified.ts",
      "apps/server/src/retrieval/rerank-passages.ts",
      "apps/server/src/retrieval/reading-excerpt.ts",
      "scripts/benchmark-cosqa.ts",
    ]
      .map((p) => hash(readFileSync(p)))
      .join(":"),
);
const reportPath = join(directory, "ranking-report.json");
if (taskFlag("register-only")) {
  console.log(
    JSON.stringify({ registered: cases.length, registrationPath, identity }),
  );
  process.exit(0);
}
if (existsSync(reportPath) && !taskFlag("reset"))
  throw Error("Existing result; use --reset or another directory");
const temporary = mkdtempSync(join(tmpdir(), "omem-cosqa-")),
  store = new Store(temporary);
const rows: {
  id: string;
  query: string;
  relevant: string[];
  arms: Record<string, ReturnType<typeof evaluate>>;
}[] = [];
const failures: { model: string; error: string }[] = [];
const modelIds: Record<string, string> = {};
let stopped = false,
  complete = false;
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopped = true;
    controller.abort(new Error("Benchmark cancelled"));
  });
const corpus = (await readRows("corpus")) as {
  _id: string;
  title?: string;
  text: string;
}[];
const sourceIds = new Map<string, string>();
const documentIds = (hits: { references: RetrievalHit["references"] }[]) => [
  ...new Set(
    hits.flatMap((h) => h.references.map((r) => sourceIds.get(r.revisionId)!)),
  ),
];
function evaluate(
  hits: RetrievalHit[],
  traces: RetrievalTrace[],
  elapsedMs: number,
  relevant: string[],
) {
  const recalled = documentIds(
    traces.filter((t) => t.stage === "fusion").flatMap((t) => t.hits),
  );
  const input = documentIds(
    traces.filter((t) => t.stage === "reranker-input").flatMap((t) => t.hits),
  );
  const models = traces.find((t) => t.stage === "reranker")?.hits ?? [];
  const fullInput = documentIds(models.filter(h => h.rankingStatus?.state === "scored" &&
    h.rankingStatus.evaluatedWindows === h.rankingStatus.plannedWindows));
  const byDocument = new Map<string, number>();
  for (const h of models)
    if (h.reranking)
      for (const id of documentIds([h]))
        byDocument.set(
          id,
          Math.max(byDocument.get(id) ?? -Infinity, h.reranking.relevance),
        );
  const modelOrder = [...byDocument]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const host =
    traces.filter((t) => t.stage === "host-ranking").at(-1)?.candidates ?? [];
  return {
    recalled,
    input,
    fullInput,
    modelOrder,
    hostOrder: documentIds(host),
    ranked: documentIds(hits),
    elapsedMs,
    scoredWindows: traces
      .filter((t) => t.stage === "reranker-input")
      .reduce((n, t) => n + t.hits.length, 0),
    plannedWindows: models.reduce((n,h) => n + (h.rankingStatus?.plannedWindows ?? 0),0),
    scoredUnits: models.filter(h=>h.rankingStatus?.state === "scored").length,
    candidateUnits: models.length,
    relevantScores: relevant.map((id) => ({ id, score: byDocument.get(id) })),
    results: hits
      .filter(
        (h, i) =>
          i < 20 || documentIds([h]).some((id) => relevant.includes(id)),
      )
      .map((h) => ({
        documents: documentIds([h]),
        score: h.score,
        reranking: h.reranking,
        rankingStatus: h.rankingStatus,
        readingRange: h.readingRange,
        target:
          h.target.kind === "source"
            ? { startLine: h.target.startLine, endLine: h.target.endLine }
            : h.target,
        characters: h.text.length,
        textDigest: hash(h.text),
      })),
  };
}
function save() {
  const rank = (ids: string[], relevant: string[]) =>
    ids.findIndex((id) => relevant.includes(id)) + 1;
  const arms = [...new Set(rows.flatMap((r) => Object.keys(r.arms)))];
  const metrics = Object.fromEntries(
    arms.map((arm) => {
      const measured = rows.filter((r) => r.arms[arm]);
      const mean = (f: (r: (typeof rows)[number]) => number) =>
        measured.reduce((n, r) => n + f(r), 0) / measured.length;
      const coverage = (r: (typeof rows)[number], ids: string[]) =>
        r.relevant.filter((id) => ids.includes(id)).length / r.relevant.length;
      return [
        arm,
        {
          questions: measured.length,
          recall: mean((r) => coverage(r, r.arms[arm]!.recalled)),
          input: mean((r) => coverage(r, r.arms[arm]!.input)),
          fullInput: mean((r) => coverage(r, r.arms[arm]!.fullInput)),
          meanElapsedMs: mean((r) => r.arms[arm]!.elapsedMs),
          recall5: mean((r) => coverage(r, r.arms[arm]!.ranked.slice(0, 5))),
          recall20: mean((r) => coverage(r, r.arms[arm]!.ranked.slice(0, 20))),
          recall100: mean((r) =>
            coverage(r, r.arms[arm]!.ranked.slice(0, 100)),
          ),
          mrr10: mean((r) => {
            const p = rank(r.arms[arm]!.ranked, r.relevant);
            return p > 0 && p <= 10 ? 1 / p : 0;
          }),
        },
      ];
    }),
  );
  const report = {
    recordedAt: new Date().toISOString(),
    complete,
    identity,
    implementationCommit: commit,
    baselineCommit,
    registration,
    corpusSize: corpus.length,
    units: store.db.prepare("SELECT count(*) n FROM retrieval_units").get()!.n,
    budgetMs,
    budgetsMs,
    modelIds,
    failures,
    metrics,
    cases: rows,
    scope:
      "Full pinned CosQA corpus, pre-registered positive query subset. Lexical + installed cross-encoders, no embeddings, AST navigation, query variants, Decision or answer generation. Labels only measure retrieved documents; returned-unit completeness does not establish complete answer evidence. Baseline keeps current shared recall/inference modules. Individual stage ranks separate evaluated-model ranking from host fallback slot preservation. No full benchmark claim.",
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}
try {
  if (
    corpus.length !== manifest.corpusSize ||
    new Set(corpus.map((d) => d._id)).size !== corpus.length
  )
    throw Error("Corpus ID/count mismatch");
  for (let i = 0; i < corpus.length; i += 200)
    store.tx(() => {
      for (const d of corpus.slice(i, i + 200)) {
        const captured = store.capture(
          {
            source: "file",
            externalId: d._id,
            title: d.title || d._id,
            context: { connector: { kind: "file", path: d._id } },
            parts: [{ type: "text", text: d.text }],
          },
          { learning: false, notify: false },
        );
        sourceIds.set(captured.revision.id, d._id);
      }
    });
  new RetrievalProjection(store.db).sync();
  for (const c of cases)
    for (const id of c.relevant)
      if (!corpus.some((d) => d._id === id))
        throw Error("Missing qrel document");
  for (const c of cases) rows.push({ ...c, arms: {} });
  const lexical = new UnifiedRetrieval(store.db, undefined, undefined, true);
  try {
    for (const c of rows) {
      const traces: RetrievalTrace[] = [],
        started = performance.now();
      const hits = await lexical.search(
        { text: c.query, kinds: ["source"], limit: 200, diversify: false },
        (t) => traces.push(t),
      );
      c.arms.lexical = evaluate(
        hits,
        traces,
        performance.now() - started,
        c.relevant,
      );
    }
  } finally {
    await lexical.close();
  }
  for (const alias of aliases) {
    let model: Awaited<ReturnType<typeof loadChineseReranker>> | undefined;
    try {
      model = await loadChineseReranker(alias);
      modelIds[alias] = model.id;
      await model.score("python process data", [
        "A function processes the data.",
      ], {signal:controller.signal});
      for (const [index, c] of rows.entries()) {
        const definitions: [string, typeof UnifiedRetrieval, number][] =
          Baseline && alias === aliases[0]
            ? [
                ["baseline:" + alias, Baseline, budgetsMs[0]!],
                [alias, UnifiedRetrieval, budgetsMs[0]!],
              ]
            : budgetsMs.map(budget => [armName(alias,budget), UnifiedRetrieval, budget]);
        const ordered = index % 2 ? [...definitions].reverse() : definitions;
        for (const [arm, Type, armBudget] of ordered) {
          const traces: RetrievalTrace[] = [];
          const retrieval = new Type(
            store.db,
            undefined,
            async () => ({ ...model!, close: async () => {} }),
            true,
            undefined,
            { budgetMs: armBudget },
          );
          const started = performance.now();
          try {
            const hits = await retrieval.search(
              {
                text: c.query,
                kinds: ["source"],
                limit: 200,
                diversify: false,
                signal: controller.signal,
              },
              (t) => traces.push(t),
            );
            c.arms[arm] = evaluate(
              hits,
              traces,
              performance.now() - started,
              c.relevant,
            );
          } finally {
            await retrieval.close();
          }
        }
        save();
        console.log(
          JSON.stringify({
            model: alias,
            completed: index + 1,
            total: rows.length,
          }),
        );
        if (stopped) break;
      }
    } catch (error) {
      failures.push({ model: alias, error: String(error) });
    } finally {
      await model?.close();
    }
    if (stopped) break;
  }
  complete =
    !stopped &&
    !failures.length &&
    rows.every(
      (r) =>
        aliases.every((a) => budgetsMs.every(budget=>r.arms[armName(a,budget)])) &&
        (!Baseline || r.arms["baseline:" + aliases[0]]),
    );
  console.log(JSON.stringify({ complete, metrics: save().metrics, failures }));
  if (!complete) process.exitCode = stopped ? 130 : 1;
} finally {
  store.close();
  rmSync(temporary, { recursive: true, force: true });
  rmSync(join(directory, "baseline-unified.ts"), { force: true });
}
