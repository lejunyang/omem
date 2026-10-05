/** Repository input adapter for the generic native material catalog workflow. */
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { profileSchema } from "../packages/contracts/src/index.js";
import { createReviewStore } from "../apps/server/src/review/store.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { restoreReviewKnowledge } from "../apps/server/src/review/knowledge.js";
import { publishMaterialDescription } from "../apps/server/src/knowledge/material-descriptions.js";
import { KnowledgePipeline } from "../apps/server/src/knowledge/pipeline.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RuntimeRequestRepository } from "../apps/server/src/agent-runtime/requests.js";
import { readRetrievalConfig } from "../apps/server/src/retrieval/factory.js";
import { taskFlag, taskTargets } from "./task-args.js";

const root = process.env.REVIEW_REPO_ROOT ?? process.cwd(),
  config = loadReviewCodeModelConfig();
if (config.transport !== "acp" || !config.command)
  throw Error("Material catalog requires the configured ACP Agent");
const store = createReviewStore(root),
  { repository } = restoreReviewKnowledge(store, root),
  targets = taskTargets();
const selected = repository
  .materials()
  .filter(
    (m) =>
      (!targets.length ||
        targets.some(
          (t) =>
            m.key === t ||
            m.path === t ||
            m.path?.startsWith(t.replace(/\/$/, "") + "/"),
        )) &&
      (!taskFlag("documents") || /\.(?:md|markdown)$/i.test(m.path ?? m.title)),
  );
const pending = selected.filter(
  (m) =>
    !store.descriptions.get(m.revisionId) ||
    (taskFlag("retry") &&
      store.descriptions.get(m.revisionId)?.author !== "user"),
);
const profile = profileSchema.parse({
  id: "traex",
  name: "材料用途整理",
  transport: "acp",
  command: config.command,
  args: config.args ?? [],
  model: config.model,
  effort: config.effort,
  timeoutMs: config.timeoutMs, idleTimeoutMs: config.idleTimeoutMs, maxDurationMs: config.maxDurationMs,
  maxContextChars: 200000,
});
const runtime = join(root, ".repo-review/runtime/catalog-agents");
const pipeline = new KnowledgePipeline(
  repository,
  new RoleRuntimeGateway(
    new RoleBundleRegistry(),
    runtime,
    new RuntimeRequestRepository(store.db),
  ),
  profile,
  {
    retrievalConfig: readRetrievalConfig(join(root, "config/retrieval.json")),
    retryTag: taskFlag("retry") ? new Date().toISOString() : undefined,
    log: (message) => console.log(new Date().toISOString(), message),
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void pipeline.stop());
const results: { keys: string[]; state: string; error?: string }[] = [];
try {
  for (let offset = 0; offset < pending.length; offset += 8) {
    const batch = pending.slice(offset, offset + 8);
    try {
      const entries = await pipeline.describeMaterials(batch);
      for (const entry of entries)
        publishMaterialDescription(
          join(root, ".repo-review/knowledge/material-descriptions"),
          {
            version: 1,
            key: entry.key,
            digest: entry.digest,
            description: entry.description,
            generation: {
              at: entry.updatedAt,
              trace: entry.trace as unknown as Record<string, unknown>,
            },
          },
        );
      results.push({ keys: batch.map((m) => m.key), state: "described" });
      console.log(
        JSON.stringify({
          described: offset + batch.length,
          total: pending.length,
          roles: entries.map((e) => ({
            key: e.key,
            role: e.description.role,
            status: e.description.status,
            concepts: e.description.concepts.length,
          })),
        }),
      );
    } catch (error) {
      results.push({
        keys: batch.map((m) => m.key),
        state: "failed",
        error: String(error),
      });
      console.error(String(error));
      process.exitCode = 1;
      break;
    }
  }
} finally {
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    join(runtime, "latest.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        selected: selected.length,
        pending: pending.length,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  await pipeline.stop();
  store.close();
}
