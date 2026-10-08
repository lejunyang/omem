/** Read-only candidate/model/host comparison over the existing review library.
 * Evidence annotations never enter retrieval, model input or classification. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import {
  UnifiedRetrieval,
  type RetrievalTrace,
} from "../apps/server/src/retrieval/unified.js";
import { loadChineseEmbedding } from "../apps/server/src/retrieval/embedding.js";
import { loadChineseReranker } from "../apps/server/src/retrieval/reranker.js";
import { materialFromRow } from "../apps/server/src/retrieval/units.js";
import { readRetrievalConfig } from "../apps/server/src/retrieval/factory.js";
import { DecisionService } from "../apps/server/src/decision/service.js";
import { passageQuestions } from "../apps/server/src/decision/questions.js";
import { assessPassages } from "../apps/server/src/decision/passages.js";
import type { RetrievalHit } from "../apps/server/src/retrieval/port.js";
import { taskFlag } from "./task-args.js";

const root = process.cwd(),
  output = join(
    root,
    ".repo-review/knowledge/verification/retrieval-candidates.json",
  );
const file = join(root, ".repo-review/runtime/data/omem.sqlite");
if (!existsSync(file))
  throw Error(
    "Run osdk run retrieval:index --review first. No private library is read.",
  );
const annotations = z
  .object({
    cases: z.array(
      z.object({
        query: z.string(),
        groups: z
          .array(
            z.object({
              label: z.string(),
              alternatives: z
                .array(
                  z.object({ path: z.string(), needle: z.string().optional() }),
                )
                .min(1),
            }),
          )
          .min(1),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        join(
          root,
          ".repo-review/knowledge/verification/retrieval-evidence.json",
        ),
        "utf8",
      ),
    ),
  );
const original = z
  .array(z.object({ query: z.string(), expectedPaths: z.array(z.string()) }))
  .parse(
    JSON.parse(
      readFileSync(
        join(root, ".repo-review/knowledge/verification/queries.json"),
        "utf8",
      ),
    ),
  );
if (
  original.length !== annotations.cases.length ||
  original.some((q) => !annotations.cases.some((a) => a.query === q.query))
)
  throw Error(
    "Evidence annotations must keep the original questions unchanged.",
  );
const config = readRetrievalConfig(join(root, "config/retrieval.json"));
const aliases = (process.env.osdk_arg_models ?? "relevance-zh,relevance-zh-v2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!aliases.length || aliases.some((s) => !/^relevance-zh(?:-v2)?$/.test(s)))
  throw Error(
    "models must be relevance-zh and/or relevance-zh-v2. Resources must already be installed.",
  );
const db = new DatabaseSync(file, { readOnly: true });
const embedding = await loadChineseEmbedding(config.osdkModel, root);
const sharedEmbedding = { ...embedding, close: async () => {} };
const decision = taskFlag("decision")
  ? new DecisionService({ mode: "2b" })
  : undefined;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
type Gold = {
  key: string;
  revisionId: string;
  digest: string;
  startLine: number;
  endLine: number;
  needle?: string;
};
const errors: { mode: string; error: string }[] = [],
  results: unknown[] = [],
  raw: unknown[] = [];
let before: string | undefined;
try {
  // Pin one SQLite read snapshot; no copy, source sync, vector write or model download.
  db.exec("BEGIN");
  before = String(db.prepare("PRAGMA data_version").get()!.data_version);
  const sourceRows = db
    .prepare(
      `SELECT r.*,s.namespace,s.external_id FROM sources s JOIN revisions r ON r.id=s.head
    LEFT JOIN review_source_meta m ON m.source_id=s.id WHERE m.removed IS NULL OR m.removed=0`,
    )
    .all();
  const materials = sourceRows
    .map((row) => materialFromRow(db, row))
    .filter((m) => m !== null);
  const visibleIds = new Set(
    materials.flatMap((m) => m.fragments.map((f) => f.id)),
  );
  const byPath = new Map(materials.map((m) => [m.path, m]));
  const gold = annotations.cases.map((item) => ({
    ...item,
    groups: item.groups.map((group) => ({
      ...group,
      alternatives: group.alternatives.map((a) => {
        const material = byPath.get(a.path);
        if (!material) throw Error(`Missing current original: ${a.path}`);
        const lines = material.text.split("\n"),
          found = a.needle
            ? lines.flatMap((line, index) =>
                line.includes(a.needle!) ? [index + 1] : [],
              )
            : [];
        if (a.needle && found.length !== 1)
          throw Error(
            `Evidence needle must locate one current line: ${a.path} / ${a.needle}`,
          );
        return {
          key: material.key,
          revisionId: material.revisionId,
          digest: material.digest,
          startLine: found[0] ?? 1,
          endLine: found[0] ?? lines.length,
          needle: a.needle,
        } satisfies Gold;
      }),
    })),
  }));
  const supports = (hit: RetrievalHit, a: Gold) =>
    hit.references.some(
      (r) =>
        r.key === a.key &&
        r.revisionId === a.revisionId &&
        r.digest === a.digest &&
        r.startLine <= a.endLine &&
        r.endLine >= a.startLine,
    );
  const compact = (hit: RetrievalHit) => ({
    id: hit.id,
    title: hit.title,
    headingPath: hit.headingPath,
    target:
      hit.target.kind === "source"
        ? { ...hit.target, fragmentIds: undefined }
        : hit.target,
    score: hit.score,
    routes: hit.routes,
    reranking: hit.reranking,
    assessment: hit.assessment,
    excerpt: hit.text.slice(0, 160),
    textDigest: digest(hit.text),
    textLength: hit.text.length,
  });
  const baseline = new Map<string, RetrievalHit[]>();
  const modes = ["baseline", ...aliases, ...(decision ? ["decision-2b"] : [])];
  let actualDecisionScoring = 0;
  for (const mode of modes) {
    const retrieval = new UnifiedRetrieval(
      db,
      () => Promise.resolve(sharedEmbedding),
      mode.startsWith("relevance-")
        ? () => loadChineseReranker(mode, root)
        : undefined,
      true,
      mode === "decision-2b" && decision
        ? async (q, hits) => (await assessPassages(decision, q.text, hits)).hits
        : undefined,
    );
    try {
      await retrieval.indexBatch(0);
      if (retrieval.health().semantic.pending !== 0)
        throw Error(
          "Index is not ready; run osdk run retrieval:index --review first.",
        );
      for (const item of gold) {
        if (
          mode === "decision-2b" &&
          decision &&
          decision.status().status === "idle"
        ) {
          const hit = baseline.get(item.query)?.[0];
          if (hit)
            await decision.decide(
              {
                user_question: item.query,
                material: hit.text,
                title: hit.title,
                headings: hit.headingPath,
                surrounding_context: hit.context,
                source_kind: hit.kind,
              },
              passageQuestions,
            );
        }
        const traces: RetrievalTrace[] = [],
          started = performance.now();
        const hits = await retrieval.search(
          {
            text: item.query,
            limit: 40,
            diversify: false,
            kinds: ["source"],
            visible: (id) => visibleIds.has(id),
          },
          (trace) => traces.push(trace),
        );
        if (mode === "baseline") baseline.set(item.query, hits);
        actualDecisionScoring += hits.filter((h) => h.assessment).length;
        const summarize = (stage: RetrievalTrace) => {
          const ordered = [...stage.hits].sort((a, b) => b.score - a.score);
          // Final/Decision order may intentionally differ from raw score order.
          const ranked = ["final", "selection", "decision"].includes(
            stage.stage,
          )
            ? stage.hits
            : ordered;
          const evidence = item.groups.map((group) => {
            const found = ranked.findIndex((h) =>
              group.alternatives.some((a) => supports(h, a)),
            );
            const input = ranked.findIndex((h) =>
              group.alternatives.some(
                (a) =>
                  supports(h, a) && (!a.needle || h.text.includes(a.needle)),
              ),
            );
            return {
              label: group.label,
              firstRank: found < 0 ? null : found + 1,
              firstInputRank: input < 0 ? null : input + 1,
            };
          });
          return {
            stage: stage.stage,
            model: stage.model,
            error: stage.error,
            count: ranked.length,
            evidence,
            top10: ranked.slice(0, 10).map(compact),
          };
        };
        const stages = traces.map(summarize),
          final = stages.find((s) => s.stage === "final")!;
        const expected = original.find(
          (q) => q.query === item.query,
        )!.expectedPaths;
        const pathRank = hits.findIndex(
          (h) =>
            h.target.kind === "source" &&
            expected.includes(h.target.key.replace(/^omem:/, "")),
        );
        const pool = traces.find((s) => s.stage === "fusion")?.hits ??
          [...new Map(traces.filter(s=>s.stage==="lexical"||s.stage==="symbols")
            .flatMap(s=>s.hits).map(h=>[h.id,h])).values()],
          candidateIds = new Set(pool.map((h) => h.id));
        const windowInputs = traces.find((s) => s.stage === "reranker-input");
        const modelRank = windowInputs
          ? windowInputs.hits.reduce((map, h) => {
              if (h.score > (map.get(h.id)?.score ?? -Infinity))
                map.set(h.id, h);
              return map;
            }, new Map<string, RetrievalHit>())
          : undefined;
        const modelOnly = modelRank
          ? summarize({
              stage: "reranker-input",
              model: windowInputs!.model,
              hits: [...modelRank.values()],
            })
          : undefined;
        const failures = item.groups.map((group) => {
          const recalled = pool.some((h) =>
              group.alternatives.some((a) => supports(h, a)),
            ),
            at5 = hits
              .slice(0, 5)
              .some((h) => group.alternatives.some((a) => supports(h, a)));
          return {
            label: group.label,
            stage: at5
              ? "top5-evidence"
              : !recalled
                ? "candidate-recall-miss"
                : windowInputs &&
                    !windowInputs.hits.some((h) =>
                      group.alternatives.some((a) => supports(h, a)),
                    )
                  ? "model-pool-cutoff"
                  : windowInputs &&
                      !windowInputs.hits.some((h) =>
                        group.alternatives.some(
                          (a) =>
                            supports(h, a) &&
                            (!a.needle || h.text.includes(a.needle)),
                        ),
                      )
                    ? "model-input-window-miss"
                    : "ranking-miss",
          };
        });
        results.push({
          mode,
          query: item.query,
          elapsedMs: Math.round(performance.now() - started),
          oldPathMetric: {
            expectedPaths: expected,
            rank: pathRank < 0 ? null : pathRank + 1,
            passed: pathRank >= 0 && pathRank < 5,
          },
          candidateCount: candidateIds.size,
          evidence: final.evidence,
          failures,
          modelOnly,
          stages,
        });
        raw.push({
          mode,
          query: item.query,
          rerankerInputs: windowInputs?.hits.map((h) => ({
            id: h.id,
            text: h.text,
            score: h.score,
          })),
          health: retrieval.health(),
          decision: decision?.status(),
        });
        console.log(
          JSON.stringify({
            mode,
            query: item.query,
            ms: Math.round(performance.now() - started),
            evidence: final.evidence,
            failures,
          }),
        );
      }
    } catch (error) {
      errors.push({ mode, error: String(error) });
      console.error(mode, String(error));
    } finally {
      await retrieval.close();
    }
  }
  const report = {
    version: 1,
    recordedAt: new Date().toISOString(),
    implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceDigest: digest(
      materials
        .map((m) => `${m.key}:${m.digest}`)
        .sort()
        .join("\n"),
    ),
    annotationsDigest: digest(
      readFileSync(
        join(
          root,
          ".repo-review/knowledge/verification/retrieval-evidence.json",
        ),
        "utf8",
      ),
    ),
    units: Number(
      db.prepare("SELECT count(*) n FROM retrieval_units").get()!.n,
    ),
    gold,
    results,
    errors,
    decision: {
      attempted: !!decision,
      actualAssessedHits: actualDecisionScoring,
      status: decision?.status(),
    },
    limits: [
      "Six known repository regression questions; manual core-evidence coverage does not prove complete or correct generated answers.",
      "Models share one read-only SQLite snapshot, current originals, embedding and production ranking; no private data, downloads or database copies.",
      "Raw cross-encoder input is before tokenizer truncation at 512 tokens; firstInputRank only checks supplied text.",
      "Timing includes loading and exact vector scans; sequential local measurements, not a throughput benchmark.",
      "Old expected-path metric is kept separately and unchanged. Evidence annotations are never passed to retrievers or models.",
      "Default reranker configuration remains unchanged. Native Decision admission can fail; an unavailable model is not an accuracy result.",
    ],
  };
  mkdirSync(join(root, ".repo-review/runtime"), { recursive: true });
  writeFileSync(
    join(root, ".repo-review/runtime/retrieval-candidate-inputs.json"),
    JSON.stringify(raw, null, 2) + "\n",
  );
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  if (errors.length) process.exitCode = 1;
} finally {
  await decision?.close();
  await embedding.close();
  db.exec("ROLLBACK");
  db.close();
}
