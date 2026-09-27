import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../apps/server/src/config.js";
import { LearningPipeline } from "../apps/server/src/learning/pipeline.js";
import {
  FeedbackService,
  MemoryService,
} from "../apps/server/src/memory/service.js";
import {
  qualityPredictionSchema,
  type QualityPrediction,
} from "../apps/server/src/quality/evaluator.js";
import { QualityRepository } from "../apps/server/src/quality/repository.js";
import { Store } from "../apps/server/src/store.js";
import { selectLiveProfile } from "./live-model.js";

const datasetId = process.argv[2] || process.env.OMEM_QUALITY_DATASET_ID;
if (!datasetId) throw Error("Usage: quality-run <frozen-dataset-id>");
const config = loadConfig();
const sourceStore = new Store(config.dataDir);
const repository = new QualityRepository(sourceStore.db);
const frozen = repository.verifyFrozen(datasetId);
const configured = config.profiles.find((profile) => profile.id === "traex");
if (!configured) throw Error("TraeX profile is not configured");
const { profile } = await selectLiveProfile(configured, config.agentCwd);
const output = resolve(
  process.env.OMEM_QUALITY_PREDICTIONS ||
    `.omem/quality/${datasetId}-predictions.json`,
);
const predictions: QualityPrediction[] = existsSync(output)
  ? (JSON.parse(readFileSync(output, "utf8")) as unknown[]).map((value) =>
      qualityPredictionSchema.parse(value),
    )
  : [];
const completed = new Set(predictions.map((prediction) => prediction.sampleId));
const limit = Math.max(
  1,
  Number(process.env.OMEM_QUALITY_RUN_LIMIT || frozen.samples.length),
);

const statement = (body: Record<string, unknown>) =>
  String(body.title ?? body.statement ?? body.trigger ?? JSON.stringify(body));
const persist = () => {
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(predictions, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, output);
  chmodSync(output, 0o600);
};

try {
  let processed = 0;
  for (const sample of frozen.samples) {
    if (completed.has(sample.id) || processed >= limit) continue;
    const directory = join(
      tmpdir(),
      `omem-quality-run-${datasetId}-${sample.ordinal}-${randomUUID()}`,
    );
    const store = new Store(directory);
    const started = Date.now();
    try {
      store.capture({
        source: "manual",
        externalId: sample.id,
        title: `Quality ${sample.ordinal}`,
        parts: [{ type: "text", text: sample.input.text }],
        context: { application: sample.input.source.section },
        provenance: {
          collectorId: "quality-runner",
          actorId: sample.input.provenance.actorId,
          actorType: sample.input.provenance.actorVerified
            ? "owner"
            : "unknown",
          actorVerifiedBy: sample.input.provenance.actorVerified
            ? "quality-label"
            : null,
          sourceUri: sample.input.source.uri,
          eventId: sample.id,
          eventAt: new Date().toISOString(),
          timezone: "Asia/Shanghai",
          quoted: sample.input.provenance.forwarded,
          forwarded: sample.input.provenance.forwarded,
          producerKind: "original",
        },
      });
      const memory = new MemoryService(store, { ownerId: "owner" });
      const pipeline = new LearningPipeline({
        store,
        memory,
        feedback: new FeedbackService(store),
        profile,
        workspaceRoot: config.agentCwd,
        workerId: `quality-${sample.ordinal}`,
      });
      await pipeline.drain(10);
      await pipeline.stop();
      const proposals = memory
        .proposals()
        .filter((proposal) =>
          ["applied", "awaiting_decision", "approved"].includes(proposal.state),
        );
      const attempts = store.jobs
        .list()
        .flatMap((job) => store.jobs.attempts(job.id));
      const numericUsage = (key: string) => {
        const values = attempts.flatMap((attempt) => {
          const value = attempt.usage[key];
          return typeof value === "number" ? [value] : [];
        });
        return values.length
          ? values.reduce((sum, value) => sum + value, 0)
          : null;
      };
      predictions.push(
        qualityPredictionSchema.parse({
          sampleId: sample.id,
          prediction: {
            disposition: proposals.length ? "extract" : "abstain",
            objects: proposals.map((proposal) => ({
              kind: proposal.kind,
              statement: statement(proposal.body),
              evidenceQuote:
                proposal.evidence.find((item) => item.exact_quote)
                  ?.exact_quote ?? "[image evidence]",
              ...(proposal.kind === "task"
                ? {
                    ownerId: proposal.body.owner_id ?? null,
                    dueAt: proposal.body.due_at ?? null,
                    dueExpression: proposal.body.due_expression ?? null,
                  }
                : {}),
            })),
            autoApply: proposals.some(
              (proposal) => proposal.state === "applied",
            ),
            forbiddenEffects: [],
            notes: "Generated by the isolated quality runner.",
          },
          durationMs: Date.now() - started,
          inputTokens: numericUsage("inputTokens"),
          outputTokens: numericUsage("outputTokens"),
          error: null,
        }),
      );
    } catch (error) {
      predictions.push(
        qualityPredictionSchema.parse({
          sampleId: sample.id,
          prediction: {
            disposition: "needs_context",
            objects: [],
            autoApply: false,
            forbiddenEffects: [],
            notes: "Runner failed before a validated prediction.",
          },
          durationMs: Date.now() - started,
          inputTokens: null,
          outputTokens: null,
          error:
            error instanceof Error ? error.message.slice(0, 2000) : "unknown",
        }),
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
    persist();
    processed++;
    console.log(
      JSON.stringify({
        sample: sample.ordinal,
        completed: predictions.length,
        total: frozen.samples.length,
      }),
    );
  }
  console.log(
    JSON.stringify({ output, completed: predictions.length }, null, 2),
  );
} finally {
  sourceStore.close();
}
