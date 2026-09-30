import { existsSync } from "node:fs";
import { readRetrievalConfig } from "../retrieval/factory.js";
import { restoreReviewKnowledge } from "./knowledge.js";
import { captureRepositoryMaterials, createReviewKnowledgeRepository } from "./materials.js";
import { restoreKnowledgeArticles } from "../knowledge/artifacts.js";
import { join } from "node:path";
/** review entry point: run the incremental sync first, then serve the review
 * API on loopback. It never wires up the personal workspace services. */
import { createReviewStore } from "./store.js";
import { runCodeSync } from "../code/sync.js";
import { runReviewSync } from "./sync.js";
import { buildReviewApp } from "./app.js";
import { loadReviewCodeModelConfig, buildReviewCodeModel } from "./model-config.js";

const repoRoot = process.env.REVIEW_REPO_ROOT ?? process.cwd();
const port = Number(process.env.REVIEW_PORT || 5180);
const host = "127.0.0.1";

console.log("repo-review: starting incremental sync...");
const store = createReviewStore(repoRoot);
createReviewKnowledgeRepository(store);
try {
  const stats = await runReviewSync(store, repoRoot);
  console.log("repo-review: sync done", stats);
  const knowledge = restoreReviewKnowledge(store, repoRoot);
  console.log("repo-review: code projection", await runCodeSync(store, repoRoot));
  console.log("repo-review: knowledge restored", knowledge.restored.reduce((n, r) => { n[r.state] = (n[r.state] ?? 0) + 1; return n; }, {} as Record<string, number>));

  // Opt-in model: only REVIEW_CODE_MODEL_CONFIG is read; default is no model.
  const codeUnderstandingModel = loadReviewCodeModelConfig();
  const port_ = buildReviewCodeModel();
  console.log(
    "repo-review: code understanding model =",
    port_ ? port_.transport : "none",
  );

  const { app } = await buildReviewApp({
    store,
    repoRoot,
    port,
    webPort: Number(process.env.REVIEW_WEB_PORT || 5181),
    codeUnderstandingModel,
    retrievalConfig: process.env.REVIEW_RETRIEVAL_CONFIG || existsSync(join(repoRoot,"config/retrieval.json"))
      ? readRetrievalConfig(process.env.REVIEW_RETRIEVAL_CONFIG ?? join(repoRoot,"config/retrieval.json")) : undefined,
  });
  await app.listen({ port, host });
  console.log(`repo-review: API at http://${host}:${port}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
} catch (error) {
  store.close();
  throw error;
}
