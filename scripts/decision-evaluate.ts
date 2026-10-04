/** Chinese decision experiments: run completion is not a quality acceptance. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arch, cpus, totalmem } from "node:os";
import { z } from "zod";
import { decisionWorker } from "./decision-models/client.js";

const option = (name: string, fallback: string) =>
  process.env[`osdk_arg_${name}`] ||
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ||
  fallback;
const alias = option("model", "decision-gliclass");
const backend = z
  .enum(["gliclass", "mlx", "gguf"])
  .parse(
    option(
      "backend",
      alias === "decision-gliclass"
        ? "gliclass"
        : alias.startsWith("decision-plumb4b")
          ? "gguf"
          : "mlx",
    ),
  );
const suitePath = resolve(
  option("cases", ".repo-review/benchmarks/decisions-zh.json"),
);
const source = readFileSync(suitePath, "utf8");
const suite = z
  .object({
    version: z.number(),
    description: z.string(),
    optionSets: z.record(
      z.string(),
      z.array(z.object({ key: z.string(), description: z.string() })),
    ),
    cases: z.array(
      z.object({
        id: z.string(),
        group: z.string(),
        context: z.string(),
        question: z.string(),
        options: z.string(),
        expected: z.array(z.string()).min(1),
        note: z.string().optional(),
        provenance: z.unknown().optional(),
      }),
    ),
  })
  .parse(JSON.parse(source));
const output = resolve(
  option("output", `.repo-review/runtime/decision-models/${alias}.json`),
);
const rotations = z.coerce
  .number()
  .int()
  .min(1)
  .max(4)
  .parse(option("rotations", "2"));
const readout = z
  .enum(["classification", "query-label"])
  .parse(option("readout", "classification"));
if (readout === "query-label" && (backend !== "gliclass" || rotations !== 1))
  throw Error(
    "query-label requires GLiClass and --rotations 1 (there are no options to rotate)",
  );
const worker = await decisionWorker(alias, backend, option("device", "cpu"));
const report = {
  startedAt: new Date().toISOString(),
  complete: false,
  suite: {
    path: suitePath,
    sha256: createHash("sha256").update(source).digest("hex"),
    description: suite.description,
  },
  machine: { cpu: cpus()[0]?.model, arch: arch(), memoryBytes: totalmem() },
  model: worker.metadata,
  readout,
  method:
    "Resident model, sequential inputs, cyclic option-order controls. Expected labels never sent to model. Hand-authored scenarios are not an independent benchmark or a production accuracy estimate. Scores are uncalibrated. Completion does not mean acceptance.",
  results: [] as Record<string, any>[],
  summary: {} as Record<string, unknown>,
};
const save = () => {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
};
save();
try {
  for (let rotation = 0; rotation < rotations; rotation++) {
    for (const item of suite.cases) {
      const options = suite.optionSets[item.options];
      if (
        !options ||
        item.expected.some((k) => !options.some((o) => o.key === k))
      )
        throw Error(`Invalid option set for ${item.id}`);
      const shift = rotation % options.length;
      const query =
        readout === "query-label"
          ? z.object({ query: z.string() }).parse(item.provenance).query
          : undefined;
      const result = await worker.decide({
        id: `${item.id}:${rotation}`,
        context: item.context,
        question: item.question,
        options: [...options.slice(shift), ...options.slice(0, shift)],
        queryLabel: query,
      });
      const correct =
        readout === "classification"
          ? !!result.selected && item.expected.includes(result.selected)
          : null;
      report.results.push({
        ...item,
        rotation,
        ...result,
        caseId: item.id,
        correct,
      });
      save();
      console.log(
        JSON.stringify({
          id: item.id,
          rotation,
          selected: result.selected,
          expected: item.expected,
          correct,
          elapsedMs: result.elapsedMs,
          error: result.error,
        }),
      );
    }
  }
  const duration = report.results
    .map((r) => r.elapsedMs as number)
    .sort((a, b) => a - b);
  const errors = report.results.filter((r) => r.error).length;
  const relevance = report.results.filter((r) => r.options === "relevance");
  const ranking = [
    ...new Set(suite.cases.filter((c) => c.provenance).map((c) => c.group)),
  ].map((group) => {
    const rows = report.results.filter(
      (r) => r.group === group && r.rotation === 0,
    );
    const ranked = [...rows].sort(
      (a, b) =>
        (b.scores?.[readout === "query-label" ? "relevant" : "direct"] ?? -1) -
        (a.scores?.[readout === "query-label" ? "relevant" : "direct"] ?? -1),
    );
    return {
      group,
      hasDirect: rows.some((r) => r.expected.includes("direct")),
      before: rows.map((r) => r.caseId),
      after: ranked.map((r) => r.caseId),
      firstDirectBefore:
        rows.findIndex((r) => r.expected.includes("direct")) + 1 || null,
      firstDirectAfter:
        ranked.findIndex((r) => r.expected.includes("direct")) + 1 || null,
      errors: rows.filter((r) => r.error).length,
    };
  });
  report.summary = {
    correct:
      readout === "classification"
        ? report.results.filter((r) => r.correct).length
        : null,
    total: report.results.length,
    errors,
    ranking,
    p50Ms: duration[Math.floor(duration.length * 0.5)],
    p95Ms:
      duration[
        Math.min(duration.length - 1, Math.floor(duration.length * 0.95))
      ],
    groups: Object.fromEntries(
      [...new Set(suite.cases.map((c) => c.group))].map((group) => {
        const rows = report.results.filter((r) => r.group === group);
        return [
          group,
          {
            correct:
              readout === "classification"
                ? rows.filter((r) => r.correct).length
                : null,
            total: rows.length,
          },
        ];
      }),
    ),
    optionOrderChanges: suite.cases
      .filter(
        (c) =>
          new Set(
            report.results
              .filter((r) => r.caseId === c.id)
              .map((r) => r.selected),
          ).size > 1,
      )
      .map((c) => c.id),
    wrongDirectAnswers: report.results
      .filter((r) => r.selected === "answer" && !r.correct)
      .map((r) => r.id),
    directSupport:
      readout === "classification"
        ? {
            truePositive: relevance.filter(
              (r) => r.expected.includes("direct") && r.selected === "direct",
            ).length,
            falsePositive: relevance.filter(
              (r) => !r.expected.includes("direct") && r.selected === "direct",
            ).length,
            falseNegative: relevance.filter(
              (r) => r.expected.includes("direct") && r.selected !== "direct",
            ).length,
          }
        : null,
    peakProcessBytes: Math.max(
      ...report.results.map((r) => r.processPeakBytes || 0),
    ),
    peakModelAllocationBytes: Math.max(
      ...report.results.map((r) => r.peakModelBytes || 0),
    ),
    maxObservedServerResidentBytes: Math.max(
      ...report.results.map((r) => r.serverResidentBytes || 0),
    ),
  };
  report.complete = true;
  save();
  console.log(JSON.stringify({ output, summary: report.summary }));
  if (errors) process.exitCode = 1;
} finally {
  await worker.close();
}
