/** review entry point: run the incremental sync first, then serve the review
 * API on loopback. It never wires up the personal workspace services. */
import { createReviewStore } from "./store.js";
import { runReviewSync } from "./sync.js";
import { buildReviewApp } from "./app.js";
import { loadReviewCodeModelConfig, buildReviewCodeModel } from "./model-config.js";

const repoRoot = process.env.REVIEW_REPO_ROOT ?? process.cwd();
const port = Number(process.env.REVIEW_PORT || 5180);
const host = "127.0.0.1";

console.log("repo-review: starting incremental sync...");
const store = createReviewStore(repoRoot);
try {
  const stats = await runReviewSync(store, repoRoot);
  console.log("repo-review: sync done", stats);

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
    codeUnderstandingModel,
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
