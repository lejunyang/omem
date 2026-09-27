/** review entry point: run the incremental sync first, then serve the review
 * API on loopback. It never wires up the personal workspace services. */
import { createReviewStore } from "./store.js";
import { runReviewSync } from "./sync.js";
import { buildReviewApp } from "./app.js";

const repoRoot = process.env.REVIEW_REPO_ROOT ?? process.cwd();
const port = Number(process.env.REVIEW_PORT || 5180);
const host = "127.0.0.1";

console.log("repo-review: starting incremental sync...");
const store = createReviewStore(repoRoot);
try {
  const stats = await runReviewSync(store, repoRoot);
  console.log("repo-review: sync done", stats);

  const { app } = await buildReviewApp({ store, repoRoot, port });
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
