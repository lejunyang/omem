import type { RetrievalPort } from "./port.js";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadChineseEmbedding } from "./embedding.js";
import { KeywordRetrieval } from "./keyword.js";
import { SemanticRetrieval } from "./semantic.js";
import { loadChineseReranker } from "./reranker.js";

export const retrievalConfigSchema = z.object({ enabled: z.boolean().default(false), osdkModel: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("memory-zh"), reranker: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict();
export type RetrievalConfig = z.input<typeof retrievalConfigSchema>;
export function readRetrievalConfig(path: string) {
  return retrievalConfigSchema.parse(JSON.parse(readFileSync(path,"utf8")));
}
export function createRetrieval(db: DatabaseSync, config?: RetrievalConfig, cwd = process.cwd()): { retrieval: RetrievalPort; close: () => Promise<void> } {
  if (!config?.enabled) return { retrieval: new KeywordRetrieval(db), close: async () => {} };
  const retrieval = new SemanticRetrieval(db, () => loadChineseEmbedding(config.osdkModel, cwd), config.reranker ? ()=>loadChineseReranker(config.reranker,cwd) : undefined);
  retrieval.start();
  return { retrieval, close: () => retrieval.close() };
}
