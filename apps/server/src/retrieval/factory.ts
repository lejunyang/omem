import type { RetrievalPort } from "./port.js";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadChineseEmbedding } from "./embedding.js";
import { UnifiedRetrieval } from "./unified.js";
import { loadChineseReranker } from "./reranker.js";

export const retrievalConfigSchema = z.object({ enabled: z.boolean().default(false), osdkModel: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("memory-zh"), reranker: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional() }).strict();
export type RetrievalConfig = z.input<typeof retrievalConfigSchema>;
export function readRetrievalConfig(path: string) {
  return retrievalConfigSchema.parse(JSON.parse(readFileSync(path,"utf8")));
}
export function createRetrieval(db: DatabaseSync, config?: RetrievalConfig, cwd = process.cwd()): { retrieval: RetrievalPort; close: () => Promise<void> } {
  const retrieval = new UnifiedRetrieval(db, config?.enabled ? () => loadChineseEmbedding(config.osdkModel, cwd) : undefined,
    config?.reranker ? ()=>loadChineseReranker(config.reranker,cwd) : undefined);
  retrieval.start();
  return { retrieval, close: () => retrieval.close() };
}
