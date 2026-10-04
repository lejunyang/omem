import { readRetrievalConfig } from "../apps/server/src/retrieval/factory.js";
import { reviewMaterialHref } from "../apps/server/src/review/knowledge.js";
import { taskFlag, taskTargets } from "./task-args.js";
import { restoreReviewKnowledge, writeReviewKnowledgeIndex } from "../apps/server/src/review/knowledge.js";
/** Explicit repository application of the shared material knowledge pipeline. */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profileSchema } from "../packages/contracts/src/index.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { RuntimeRequestRepository } from "../apps/server/src/agent-runtime/requests.js";
import { KnowledgeRepository, digest } from "../apps/server/src/knowledge/repository.js";
import { KnowledgePipeline } from "../apps/server/src/knowledge/pipeline.js";
import { restoreKnowledgeArticles, writeKnowledgeArticle } from "../apps/server/src/knowledge/artifacts.js";
import { createReviewKnowledgeRepository, linkedMaterialOffers } from "../apps/server/src/review/materials.js";
import { createReviewStore } from "../apps/server/src/review/store.js";
import { runReviewSync } from "../apps/server/src/review/sync.js";
import { runCodeSync } from "../apps/server/src/code/sync.js";
import { loadReviewCodeModelConfig, reviewModelConfigPath } from "../apps/server/src/review/model-config.js";
import { listFiles, edgesTouching } from "../apps/server/src/code/store.js";

const root = process.env.REVIEW_REPO_ROOT ?? process.cwd();
const config = loadReviewCodeModelConfig();
if (config.transport !== "acp" || !config.command) throw Error("Knowledge roles require an explicitly configured ACP profile");
const profile = profileSchema.parse({ id: "traex", name: "Repository knowledge", transport: "acp", command: config.command, args: config.args ?? [], model: config.model, effort: config.effort, timeoutMs: config.timeoutMs, maxContextChars: 200000 });
const concurrency = Number(process.env.REVIEW_KNOWLEDGE_CONCURRENCY ?? 3);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw Error("REVIEW_KNOWLEDGE_CONCURRENCY must be 1..6");
const only = taskTargets();
if (!only.length) throw Error("Select a file or directory for internal notes; use review:guides for reader pages");
const store = createReviewStore(root), repository = createReviewKnowledgeRepository(store);
const runtime = join(root, ".repo-review/runtime");
const stage = join(runtime, "knowledge-staging"), assets = join(root, ".repo-review/knowledge/articles");
mkdirSync(stage, { recursive: true }); mkdirSync(assets, { recursive: true });
const pipeline = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), join(runtime, "knowledge-agents"), new RuntimeRequestRepository(store.db)), profile,
  { retrievalConfig: readRetrievalConfig(join(root, "config/retrieval.json")), concurrency, retryTag: taskFlag("retry") ? new Date().toISOString() : undefined, budget: config, log: m => console.log(new Date().toISOString(), m), onPublish: a => {
    writeKnowledgeArticle(stage, a, reviewMaterialHref);
    for (const ext of ["json", "md"]) copyFileSync(join(stage, `${digest(a.document.key)}.${ext}`), join(assets, `${digest(a.document.key)}.${ext}`));
  } });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void pipeline.stop());
try {
  console.log("Actual profile:", reviewModelConfigPath(), profile.model, { input: config.maxInputTokens, output: config.maxOutputTokens, concurrency });
  await runReviewSync(store, root);
  const coverage = restoreReviewKnowledge(store, root).coverage;
  await runCodeSync(store, root);
  console.log("Restore:", restoreKnowledgeArticles(repository, assets).reduce((n, r) => { n[r.state] = (n[r.state] ?? 0) + 1; return n; }, {} as Record<string, number>));
  const allMaterials = repository.materials().filter(m => m.key.startsWith("omem:"));
  const byKey = new Map(allMaterials.map(m => [m.key, m]));
  const requested = allMaterials.filter(m => !only.length || only.some(path => m.path === path || m.path?.startsWith(path + "/")));
  const materials = requested;
  if (!materials.length) throw Error("No matching captured materials");
  const files = listFiles(store), byFile = new Map(files.map(f => [f.fileId, f]));
  console.log("Material inventory:", materials.length, "targets;", coverage.filter(c => c.state === "excluded").length, "excluded;", coverage.filter(c => c.state === "failed").length, "capture failures");
  const report = await pipeline.analyze(materials, targets => {
    const extra = new Set<string>();
    for (const target of targets) {
      const file = files.find(f => f.path === target.path);
      if (file) for (const edge of edgesTouching(store, { fileId: file.fileId })) {
        if (edge.edgeKind === "imports" && edge.toFileId) { const f = byFile.get(edge.toFileId); if (f) extra.add(`omem:${f.path}`); }
      }
    }
    return [...linkedMaterialOffers(allMaterials, targets), ...[...extra].filter(k => !targets.some(t => t.key === k)).slice(0, 4).map(k => byKey.get(k)).filter(m => !!m).map(material => ({ material, ranges: [{ start: 1, end: Math.min(material.lineCount, 70) }] }))];
  });
  const summary = { checkedAt: new Date().toISOString(), selection: only, total: report.total, reused: report.reused, failures: report.failures };
  writeFileSync(join(runtime, "internal-analysis.json"), JSON.stringify(summary, null, 2) + "\n");
  if (report.failures.length) process.exitCode = 1;
  writeReviewKnowledgeIndex(root, repository.published());
  console.log("Internal notes", summary);

} finally { await pipeline.stop(); store.close(); }
