import { readRetrievalConfig } from "../apps/server/src/retrieval/factory.js";
/** Reader-driven repository application of the shared knowledge pipeline. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { wikiPageBriefSchema } from "../packages/contracts/src/knowledge.js";
import { profileSchema } from "../packages/contracts/src/index.js";
import { createReviewStore } from "../apps/server/src/review/store.js";
import { loadReviewCodeModelConfig } from "../apps/server/src/review/model-config.js";
import { restoreReviewKnowledge, publishReviewArticle, writeReviewKnowledgeIndex } from "../apps/server/src/review/knowledge.js";
import { KnowledgePipeline } from "../apps/server/src/knowledge/pipeline.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { RuntimeRequestRepository } from "../apps/server/src/agent-runtime/requests.js";
import { taskFlag, taskTargets } from "./task-args.js";

const root = process.env.REVIEW_REPO_ROOT ?? process.cwd();
const config = loadReviewCodeModelConfig();
if (config.transport !== "acp" || !config.command) throw Error("Reader guides require the configured ACP agent");
const plan = z.object({ version: z.literal(1), pages: z.array(wikiPageBriefSchema).min(1) }).parse(JSON.parse(readFileSync(join(root, "config/wiki-pages.json"), "utf8")));
const targets = taskTargets();
const pages = plan.pages.filter(p => !targets.length || targets.some(t => p.key === t || p.key === `guide:${t}`));
if (!pages.length) throw Error("No matching reader page");
const profile = profileSchema.parse({ id: "traex", name: "Reader guide", transport: "acp", command: config.command, args: config.args ?? [], model: config.model, effort: config.effort, timeoutMs: config.timeoutMs, maxContextChars: 200000 });
const store = createReviewStore(root), runtime = join(root, ".repo-review/runtime");
mkdirSync(runtime, { recursive: true });
const { repository, coverage } = restoreReviewKnowledge(store, root);
for (const page of plan.pages) repository.savePlan(page);
const pipeline = new KnowledgePipeline(repository, new RoleRuntimeGateway(new RoleBundleRegistry(), join(runtime, "reader-agents"), new RuntimeRequestRepository(store.db)), profile,
  { retrievalConfig: readRetrievalConfig(join(root, "config/retrieval.json")), budget: config, retryTag: taskFlag("retry") ? new Date().toISOString() : undefined, onPublish: a => publishReviewArticle(root, a), log: message => console.log(new Date().toISOString(), message) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void pipeline.stop());
const results: { key: string; state: string; error?: string }[] = [];
try {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, pages.length) }, async () => {
    while (next < pages.length) {
      const page = pages[next++]!;
      try { await pipeline.writePage(page); results.push({ key: page.key, state: "reviewed" }); }
      catch (error) { results.push({ key: page.key, state: "failed", error: String(error) }); console.error("FAILED", page.key, String(error)); process.exitCode = 1; }
    }
  }));
  repository.refresh();
  const articles = repository.list(), known = new Map(articles.map(a => [a.document.key, a]));
  const report = { version: 1, checkedAt: new Date().toISOString(), model: profile.model, workflow: "reader-first", selection: pages.map(p => p.key),
    pages: plan.pages.map(p => ({ key: p.key, title: p.title, state: results.find(r => r.key === p.key)?.state ?? (known.get(p.key)?.current ? "reviewed" : known.has(p.key) ? "stale" : "pending"), error: results.find(r => r.key === p.key)?.error })),
    files: coverage.map(row => ({ ...row, knowledge: row.materialKey ? known.get(row.materialKey)?.current ? "reviewed" : known.has(row.materialKey) ? "stale" : "pending" : "not-applicable" })),
    failures: results.filter(r => r.state === "failed") };
  writeFileSync(join(root, ".repo-review/knowledge/coverage.json"), JSON.stringify(report, null, 2) + "\n");
  writeReviewKnowledgeIndex(root, articles);
  console.log(JSON.stringify({ pages: report.pages, files: report.files.length }, null, 2));
} finally { await pipeline.stop(); store.close(); }
