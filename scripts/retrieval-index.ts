import { taskFlag } from "./task-args.js";
/** Explicit catch-up for large imports; server also indexes subsequent captures. */
import { SemanticRetrieval } from "../apps/server/src/retrieval/semantic.js";
import { loadChineseEmbedding } from "../apps/server/src/retrieval/embedding.js";
import { loadConfig } from "../apps/server/src/config.js";
import { Store } from "../apps/server/src/store.js";
import { createReviewStore } from "../apps/server/src/review/store.js";
import { restoreReviewKnowledge } from "../apps/server/src/review/knowledge.js";
import { runReviewSync } from "../apps/server/src/review/sync.js";
import { runCodeSync } from "../apps/server/src/code/sync.js";
import { readRetrievalConfig } from "../apps/server/src/retrieval/factory.js";
import { join } from "node:path";
const review = taskFlag("review"), root = process.cwd();
const config = review ? readRetrievalConfig(process.env.REVIEW_RETRIEVAL_CONFIG ?? join(root,"config/retrieval.json")) : loadConfig().retrieval;
const store = review ? createReviewStore(root) : new Store(loadConfig().dataDir);
const retrieval = new SemanticRetrieval(store.db, () => loadChineseEmbedding(config?.osdkModel,root));
try {
  if (review) { await runReviewSync(store,root); restoreReviewKnowledge(store,root); await runCodeSync(store,root); }
  let count = 0;
  while (true) { const indexed = await retrieval.indexBatch(16); if (!indexed) break; count += indexed; console.log("Indexed",count,"fragments",retrieval.health()); }
  console.log(JSON.stringify({ completed: true, ...retrieval.health() }));
} finally { await retrieval.close(); store.close(); }
