/** Live native Agent comparison on one frozen corpus. Questions are supplied by
 * the evaluator and are never captured as source material. No synthetic pass rate. */
import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { Store } from "../apps/server/src/store.js";
import { KnowledgeRepository } from "../apps/server/src/knowledge/repository.js";
import { createReviewKnowledgeRepository } from "../apps/server/src/review/materials.js";
import { developmentRetrieval } from "../apps/server/src/review/development.js";
import { UnifiedRetrieval } from "../apps/server/src/retrieval/unified.js";
import { loadChineseEmbedding } from "../apps/server/src/retrieval/embedding.js";
import {
  AssistantRuntime,
  type ResearchActivity,
} from "../apps/server/src/assistant/runtime.js";
import { AcpAssistantModel } from "../apps/server/src/assistant/acp-model.js";
import { acp } from "../apps/server/src/agents.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { taskFlag } from "./task-args.js";
import {
  beginReviewRun,
  completedReviewRuns,
  pruneCandidates,
} from "./review-retention.js";

const option = (name: string, fallback = "") =>
  process.env[`osdk_arg_${name}`] ||
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ||
  fallback;
if (!option("questions"))
  throw Error("Provide --questions with a JSON question file");
const cases = z
  .array(
    z
      .object({
        id: z.string(),
        turns: z.array(z.string().min(1).max(2000)).min(1),
      })
      .strict(),
  )
  .min(1)
  .parse(JSON.parse(readFileSync(resolve(option("questions")), "utf8")));
const review = taskFlag("review");
const variantSelection = z
  .enum(["both", "research", "reading-first"])
  .parse(option("variant", "both"));
if (variantSelection === "reading-first" && !option("reading-model"))
  throw Error("--variant reading-first requires --reading-model");
const sourceDir = resolve(
  option("data", review ? ".repo-review/runtime/data" : ".omem"),
);
const directory = resolve(
  option(
    "output",
    `.repo-review/runtime/assistant-compare/${Date.now()}-${randomUUID().slice(0, 8)}`,
  ),
);
const dataDir = join(directory, "data");
const file = join(dataDir, "omem.sqlite");
const sourceFile = join(sourceDir, "omem.sqlite");
if (!existsSync(sourceFile))
  throw Error(`Source database not found: ${sourceFile}`);
if (existsSync(file))
  throw Error(
    "Choose a fresh output directory; previous results are preserved",
  );
const finishRun = beginReviewRun(directory, "assistant");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// SQLite may need to create WAL/SHM handles after the last writer closed.
// No business-data writes run on this connection; backup owns the consistent read.
const source = new DatabaseSync(sourceFile);
try {
  await backup(source, file);
} catch (error) {
  rmSync(dataDir, { recursive: true, force: true });
  finishRun();
  throw error;
} finally {
  source.close();
}
if (existsSync(join(sourceDir, "assets")))
  cpSync(join(sourceDir, "assets"), join(dataDir, "assets"), {
    recursive: true,
  });
const store = new Store(dataDir);
const repository = review
  ? createReviewKnowledgeRepository(store)
  : new KnowledgeRepository(store);
const retrieval = new UnifiedRetrieval(
  store.db,
  () => loadChineseEmbedding(),
  undefined,
  true,
);
const port = review ? developmentRetrieval(store, retrieval) : retrieval;
const digest = () =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sources: store.db
          .prepare("SELECT id,head FROM sources ORDER BY id")
          .all(),
        knowledge: store.db
          .prepare("SELECT * FROM knowledge_heads ORDER BY document_key")
          .all(),
        descriptions: store.db
          .prepare(
            "SELECT revision_id,version,description FROM material_descriptions ORDER BY revision_id,version",
          )
          .all(),
      }),
    )
    .digest("hex");
const config = loadReviewCodeModelConfig();
if (config.transport !== "acp")
  throw Error("Assistant comparison requires an ACP configuration");
const models = option("models", "gpt-5.6-sol").split(",").filter(Boolean);
const report: Record<string, any> = {
  startedAt: new Date().toISOString(),
  implementationCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  implementationFiles: Object.fromEntries(
    [
      "apps/server/src/assistant/acp-model.ts",
      "apps/server/src/assistant/reading-stage.ts",
      "apps/server/src/assistant/answer-review.ts",
      "apps/server/src/assistant/research.ts",
      "apps/server/src/assistant/runtime.ts",
      "packages/agent-runtime/roles/answer-reviewer/1/prompt.md",
      "packages/agent-runtime/roles/answer-reviewer/1/manifest.json",
      "packages/agent-runtime/roles/answer-reviewer/1/skills/omem-answer-review/SKILL.md",
      "packages/agent-runtime/roles/daily-assistant/1/manifest.json",
      "packages/agent-runtime/roles/daily-assistant/1/skills/omem-assistant-research/SKILL.md",
      "scripts/assistant-compare.ts",
    ].map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  ),
  corpusDigest: digest(),
  materialCount: repository.materials().length,
  method:
    "One frozen corpus, existing shared retrieval without reranker, real native ACP and all research tools. Independent conversations per case; turns within each case preserve history. Model order alternates per case. Check answers manually; successful submission does not imply correctness.",
  profiles: [],
  variantSelection,
  cases: [],
};
const save = () =>
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
const generations = new Set<Promise<unknown>>();
try {
  // Load model/query services outside timed questions; missing vectors remain
  // explicitly visible in health, rather than silently changing this corpus.
  await retrieval.indexBatch(0);
  report.retrieval = retrieval.health();
  let readingProfile;
  if (option("reading-model")) {
    readingProfile = profileSchema.parse({
      id: "reader",
      name: "Material-first reader",
      transport: config.transport,
      command: config.command,
      args: config.args,
      timeoutMs: config.timeoutMs,
      model: option("reading-model"),
    });
    const discovery = await acp(
      readingProfile,
      join(directory, "probe", "reader"),
      null,
      () => {},
      new AbortController().signal,
    );
    const effort = discovery.configOptions.find(
      (o) => o.category === "reasoning_effort" || o.id === "reasoning_effort",
    );
    const supported =
      effort?.type === "select"
        ? effort.options
            .flatMap((o) => ("options" in o ? o.options : [o]))
            .map((o) => o.value)
        : [];
    const requested = option("reading-effort", "auto");
    const selected =
      requested === "auto"
        ? ["none", "minimal", "low"].find((value) => supported.includes(value))
        : requested;
    if (!selected || !supported.includes(selected))
      throw Error(
        `Reader effort unavailable: ${requested}; supported: ${supported.join(", ")}`,
      );
    readingProfile = { ...readingProfile, effort: selected };
    // Real session validation happens again with the selected effort on each turn.
    report.readingProfile = {
      model: readingProfile.model,
      effort: selected,
      supported,
    };
  }
  const profiles: {
    profile: ReturnType<typeof profileSchema.parse>;
    variant: string;
    reader?: ReturnType<typeof profileSchema.parse>;
  }[] = [];
  for (const model of models) {
    const profile = profileSchema.parse({
      id: "traex",
      name: model,
      transport: config.transport,
      command: config.command,
      args: config.args,
      timeoutMs: config.timeoutMs,
      model,
      effort: option("effort", "medium"),
    });
    const probe = await acp(
      profile,
      join(directory, "probe", model),
      null,
      () => {},
      new AbortController().signal,
    );
    report.profiles.push({
      requested: { model: profile.model, effort: profile.effort },
      actual: probe.configOptions.map((o) => ({
        id: o.id,
        currentValue: o.currentValue,
      })),
      agent: probe.agentInfo,
    });
    if (variantSelection !== "reading-first")
      profiles.push({ profile, variant: "research" });
    if (readingProfile && variantSelection !== "research")
      profiles.push({
        profile,
        variant: "reading-first",
        reader: readingProfile,
      });
  }
  save();
  for (const [index, test] of cases.entries())
    for (const { profile, variant, reader } of index % 2
      ? [...profiles].reverse()
      : profiles) {
      let modelStart = 0;
      let events: (ResearchActivity & { elapsedMs: number })[] = [];
      const adapter = new AcpAssistantModel({
        profile,
        readingProfile: reader,
        repository,
        workspaceRoot: join(directory, "agents"),
        retrievalConfig: { enabled: true, osdkModel: "memory-zh" },
      });
      const runtime = new AssistantRuntime(
        store,
        {
          generate: async (input) => {
            modelStart = performance.now();
            const generation = adapter.generate({
              ...input,
              onResearchActivity: (e) => {
                events.push({
                  ...e,
                  elapsedMs: Math.round(performance.now() - modelStart),
                });
                input.onResearchActivity?.(e);
              },
            });
            generations.add(generation);
            try {
              return await generation;
            } finally {
              generations.delete(generation);
            }
          },
        },
        { ownerId: "owner", retrieval: port, turnTimeoutMs: profile.timeoutMs },
      );
      const conversation = runtime.conversations.open({
        principalId: "owner",
        channel: "web",
        chatId: randomUUID(),
        visibility: "private",
      });
      try {
        for (const [turnIndex, question] of test.turns.entries()) {
          events = [];
          modelStart = 0;
          const start = performance.now();
          console.log(
            JSON.stringify({
              case: test.id,
              turn: turnIndex + 1,
              model: profile.model,
              variant,
              state: "running",
            }),
          );
          try {
            const result = await runtime.turn({
              conversationId: conversation.id,
              userText: question,
              mode: "research",
            });
            const failed =
              result.degraded || result.turn.inputMessageRefs.status !== "done";
            report.cases.push({
              case: test.id,
              turn: turnIndex + 1,
              question,
              model: profile.model,
              variant,
              effort: profile.effort,
              elapsedMs: Math.round(performance.now() - start),
              initialRetrievalMs: modelStart
                ? Math.round(modelStart - start)
                : null,
              events,
              result,
            });
            if (failed) process.exitCode = 1;
            console.log(
              JSON.stringify({
                case: test.id,
                turn: turnIndex + 1,
                model: profile.model,
                variant,
                ms: report.cases.at(-1).elapsedMs,
                failed,
              }),
            );
          } catch (error) {
            report.cases.push({
              case: test.id,
              turn: turnIndex + 1,
              question,
              model: profile.model,
              variant,
              error: String(error),
              elapsedMs: Math.round(performance.now() - start),
              events,
            });
            process.exitCode = 1;
          }
          report.corpusUnchanged = digest() === report.corpusDigest;
          save();
          if (!report.corpusUnchanged)
            throw Error("Source corpus changed during comparison");
        }
      } finally {
        runtime.shutdown();
      }
    }
  report.completedAt = new Date().toISOString();
  save();
} finally {
  // turn() can return on cancellation before ACP closes. Release its snapshot
  // only after both author and owned reviewer have actually stopped.
  await Promise.allSettled(generations);
  await retrieval.close();
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  finishRun();
  pruneCandidates(completedReviewRuns(dirname(directory), "assistant"));
}
console.log("Comparison saved: " + join(directory, "report.json"));
