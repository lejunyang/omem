import { z } from "zod";

const key = z.string().min(1).max(500);
export const knowledgeCitationSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/),
  label: z.string().min(1).max(160),
  reason: z.string().min(1).max(800),
  relation: z.enum(["supports", "explains", "implements", "depends_on", "calls", "contradicts", "background", "tracks"]),
  target: z.object({
    kind: z.enum(["material", "article"]), key,
    startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional(),
    section: z.string().max(100).optional(),
  }).strict(),
  quote: z.string().max(120000).default("").describe("Leave empty. The host extracts the exact quote from the selected fixed line range before independent review."),
}).strict();

export const knowledgeQuestionSchema = z.object({
  question: z.string().min(1).max(1000),
  why: z.string().min(1).max(1200),
  nextStep: z.string().min(1).max(1000),
  blocking: z.boolean(),
  citationKeys: z.array(z.string()).max(20),
}).strict();

export const knowledgeDocumentSchema = z.object({
  key, title: z.string().min(1).max(240), summary: z.string().min(1).max(1600),
  category: z.string().min(1).max(120),
  topicPath: z.array(z.string().trim().min(1).max(120)).optional().describe("Human topic hierarchy, broad to specific. Organize by the subject and reader purpose, not source directories or internal ids."),
  sections: z.array(z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(24000),
  }).strict()).min(1).max(20),
  citations: z.array(knowledgeCitationSchema).min(1).max(160),
  questions: z.array(knowledgeQuestionSchema).max(20),
}).strict();

export const knowledgeBatchSchema = z.object({
  schema_version: z.literal(1), documents: z.array(knowledgeDocumentSchema).min(1).max(16),
}).strict();

export const knowledgeReviewSchema = z.object({
  schema_version: z.literal(1),
  verdicts: z.array(z.object({
    documentKey: key, verdict: z.enum(["accepted", "needs_revision"]),
    issues: z.array(z.string().min(1).max(1600)).max(30),
    questions: z.array(knowledgeQuestionSchema).max(20),
  }).strict()).min(1).max(16),
}).strict();

export const knowledgePlanSchema = z.object({
  schema_version: z.literal(1), title: z.string().min(1).max(240),
  chapters: z.array(z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,59}$/),
    title: z.string().min(1).max(200), purpose: z.string().min(1).max(1600),
    materialKeys: z.array(key).min(1).max(400),
  }).strict()).min(1).max(32),
}).strict();

export const wikiPageBriefSchema = z.object({
  key, title: z.string(), order: z.number().int().nonnegative(),
  kind: z.enum(["tutorial", "explanation", "how-to", "reference"]),
  reader: z.string(), goal: z.string(), scenario: z.string(),
  questions: z.array(z.string()).min(1).max(12), entryPaths: z.array(z.string()).max(20),
  topicPath: z.array(z.string().trim().min(1).max(120)).optional(),
  materialKeys: z.array(key).min(1).optional().describe("Explicit investigation scope. Omit to search all eligible captured materials; entryPaths are starting points only."),
}).strict();
export type WikiPageBrief = z.infer<typeof wikiPageBriefSchema>;

/** A bounded, read-only investigation over already captured material. */
export const knowledgeResearchSchema = z.object({
  schema_version: z.literal(1), ready: z.boolean(),
  findings: z.string().max(12000), gaps: z.array(z.string()).max(12),
  requests: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("search"), query: z.string().min(1).max(300) }).strict(),
    z.object({ kind: z.literal("read"), materialKey: key, startLine: z.number().int().positive(), endLine: z.number().int().positive() }).strict(),
  ])).max(12),
}).strict();
export type KnowledgeResearch = z.infer<typeof knowledgeResearchSchema>;

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;
export type KnowledgeCitation = z.infer<typeof knowledgeCitationSchema>;
export type KnowledgeQuestion = z.infer<typeof knowledgeQuestionSchema>;
export type KnowledgeBatch = z.infer<typeof knowledgeBatchSchema>;
export type KnowledgeReview = z.infer<typeof knowledgeReviewSchema>;
export type KnowledgePlan = z.infer<typeof knowledgePlanSchema>;

export type KnowledgeMaterial = {
  key: string; title: string; path: string | null; sourceId: string; revisionId: string;
  namespace: string; conversationId?: string; actorId?: string | null; actorVerifiedBy?: string | null; eventAt?: string | null; quoted?: boolean; forwarded?: boolean; digest: string; text: string; lineCount: number;
  fragments: { id: string; text: string }[];
  images: { assetId: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; label: string }[];
};

export type KnowledgeArtifact = {
  version: 1; document: KnowledgeDocument;
  dependencies: { kind: "material" | "article"; key: string; digest: string }[];
  generation: { model: string; effort: string | null; at: string; trace: Record<string, unknown> };
  review: { model: string; at: string; trace: Record<string, unknown>; verdict: "accepted" };
  reading?: WikiPageBrief;
};
