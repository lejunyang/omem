import type { RetrievalPort } from "./port.js";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadChineseEmbedding } from "./embedding.js";
import { UnifiedRetrieval } from "./unified.js";
import { loadChineseReranker } from "./reranker.js";
import type { DecisionService } from "../decision/service.js";
import { assessPassages } from "../decision/passages.js";

export const retrievalConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    osdkModel: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default("memory-zh"),
    rerankBudgetMs: z.number().int().min(1).max(120_000).optional(),
    reranker: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
  })
  .strict();
export type RetrievalConfig = z.input<typeof retrievalConfigSchema>;
export function readRetrievalConfig(path: string) {
  return retrievalConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
export function createRetrieval(
  db: DatabaseSync,
  config?: RetrievalConfig,
  cwd = process.cwd(),
  decisions?: DecisionService,
): { retrieval: RetrievalPort; close: () => Promise<void> } {
  const retrieval = new UnifiedRetrieval(
    db,
    config?.enabled
      ? () => loadChineseEmbedding(config.osdkModel, cwd)
      : undefined,
    config?.reranker
      ? () => loadChineseReranker(config.reranker, cwd)
      : undefined,
    false,
    decisions
      ? async (query, hits) =>
          (
            await assessPassages(decisions, query.text, hits, {
              sourceIdFor: (hit) => {
                if (hit.target.kind !== "source") return undefined;
                const row = db
                  .prepare("SELECT source_id FROM revisions WHERE id=?")
                  .get(hit.target.revisionId);
                return row ? String(row.source_id) : undefined;
              },
            })
          ).hits
      : undefined,
    { budgetMs: config?.rerankBudgetMs ?? 20_000 },
  );
  retrieval.start();
  return { retrieval, close: () => retrieval.close() };
}
