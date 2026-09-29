import { restoreReviewKnowledge, writeReviewKnowledgeIndex } from "../apps/server/src/review/knowledge.js";
/** Explicit repository application of the shared material knowledge pipeline. */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { profileSchema } from "../packages/contracts/src/index.js";
import { moduleForPath } from "../packages/contracts/src/code-modules.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { RuntimeRequestRepository } from "../apps/server/src/agent-runtime/requests.js";
import { KnowledgeRepository, digest } from "../apps/server/src/knowledge/repository.js";
import { KnowledgePipeline } from "../apps/server/src/knowledge/pipeline.js";
import { restoreKnowledgeArticles, writeKnowledgeArticle } from "../apps/server/src/knowledge/artifacts.js";
import { captureRepositoryMaterials, createReviewKnowledgeRepository, linkedMaterialOffers } from "../apps/server/src/review/materials.js";
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
const only = process.argv.find(a => a.startsWith("--only="))?.slice(7) ?? process.argv.find(a => a.startsWith("--target="))?.slice(9);
const filesOnly = process.argv.includes("--files-only") || !!only;
const store = createReviewStore(root), repository = createReviewKnowledgeRepository(store);
const runtime = join(root, ".repo-review/runtime");
const stage = join(runtime, "knowledge-staging"), assets = join(root, ".repo-review/knowledge/articles");
mkdirSync(stage, { recursive: true }); mkdirSync(assets, { recursive: true });
const pipeline = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), join(runtime, "knowledge-agents"), new RuntimeRequestRepository(store.db)), profile,
  { concurrency, budget: config, log: m => console.log(new Date().toISOString(), m), onPublish: a => {
    writeKnowledgeArticle(stage, a);
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
  const materials = allMaterials.filter(m => !only || m.path === only || m.path?.startsWith(only + "/"));
  if (!materials.length) throw Error("No matching captured materials");
  const byKey = new Map(allMaterials.map(m => [m.key, m]));
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
  const recordCoverage = () => {
    const known = new Map(repository.list().map(a => [a.document.key, a]));
    const output = { version: 1, checkedAt: new Date().toISOString(), profile: reviewModelConfigPath(), model: profile.model,
      files: coverage.map(row => ({ ...row, knowledge: row.materialKey ? known.get(row.materialKey)?.current ? "reviewed" : known.has(row.materialKey) ? "stale" : "pending" : "not-applicable" })), failures: report.failures };
    writeFileSync(join(runtime, "knowledge-coverage.json"), JSON.stringify(output, null, 2) + "\n");
    copyFileSync(join(runtime, "knowledge-coverage.json"), join(root, ".repo-review/knowledge/coverage.json"));
    return output;
  };
  recordCoverage();
  if (report.failures.length) { console.error("Analysis failures:", report.failures); process.exitCode = 1; }
  if (!filesOnly && !report.failures.length) {
    const groups = new Map<string, string[]>();
    for (const m of materials) {
      const path = m.path ?? "";
      const group = /^(apps|packages|scripts)\//.test(path) ? moduleForPath(path) : path.startsWith("docs/") ? "docs-" + (path.split("/")[1] ?? "root") : "project";
      const keys = groups.get(group) ?? []; keys.push(m.key); groups.set(group, keys);
    }
    for (const [group, keys] of groups) await pipeline.synthesize({ key: `module:${group}`, title: `${group} · 模块理解`, purpose: "解释这个模块的职责、背景、主要流程、约束、跨模块关系和未决问题，引用子知识，面向首次阅读的读者。" }, keys);
    const plan = await pipeline.plan();
    writeFileSync(join(stage, "plan.json"), JSON.stringify(plan, null, 2) + "\n"); copyFileSync(join(stage, "plan.json"), join(root, ".repo-review/knowledge/plan.json"));
    for (const chapter of plan.chapters.filter(c => c.key !== "overview")) await pipeline.synthesize({ key: `topic:${chapter.key}`, title: chapter.title, purpose: chapter.purpose }, chapter.materialKeys);
    const overview = plan.chapters.find(c => c.key === "overview")!;
    await pipeline.synthesize({ key: "topic:overview", title: overview.title, purpose: overview.purpose }, plan.chapters.filter(c => c.key !== "overview").map(c => `topic:${c.key}`));
    recordCoverage();
  }
  const pages = repository.list().filter(a => a.current);
  writeReviewKnowledgeIndex(root, pages);
  console.log("DONE", { reviewed: materials.filter(m => repository.get(m.key)?.current).length, targetCount: materials.length, currentPages: pages.length, questions: repository.questions().filter(q => q.state === "open").length, failures: report.failures.length });
} finally { await pipeline.stop(); store.close(); }
