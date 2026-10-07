import { z } from "zod";

const text = z.string().trim().min(1);
const identifiers = z.array(text.max(300)).max(500);
const path = z.array(text.max(120)).max(12);

/** A reading plan, not an article or a source of facts. Page identity is
 * allocated by the host only when the reader confirms the whole draft. */
export const knowledgeOutlinePageInputSchema = z
  .object({
    title: text.max(240),
    kind: z.enum(["tutorial", "explanation", "how-to", "reference"]),
    reader: text.max(1200),
    goal: text.max(3000),
    scenario: z.string().trim().max(3000),
    questions: z.array(text.max(800)).min(1).max(12),
    entryPaths: z.array(text.max(500)).max(20),
    topicPath: path,
    materialKeys: identifiers,
    contextIds: z.array(text.max(300)).max(40),
    existingKey: text.max(300).nullable(),
  })
  .strict();
export const knowledgeOutlinePageSchema =
  knowledgeOutlinePageInputSchema.extend({
    title: z.string().trim().max(240),
    reader: z.string().trim().max(1200),
    goal: z.string().trim().max(3000),
    questions: z.array(z.string().trim().max(800)).max(12),
    id: text.max(300),
  });
export const knowledgeOutlineInputSchema = z
  .object({
    title: z.string().trim().max(240),
    reader: z.string().trim().max(1200),
    goal: z.string().trim().max(3000),
    topicPath: path,
    materialKeys: identifiers,
    contextIds: z.array(text.max(300)).max(40),
    pages: z.array(knowledgeOutlinePageSchema).max(32),
  })
  .strict();
export const knowledgeOutlineProposalSchema = z
  .object({
    schema_version: z.literal(1),
    rationale: text.max(6000),
    gaps: z.array(text.max(1600)).max(20),
    pages: z.array(knowledgeOutlinePageInputSchema).min(1).max(32),
  })
  .strict();
export type KnowledgeOutlinePage = z.infer<typeof knowledgeOutlinePageSchema>;
export type KnowledgeOutlineInput = z.infer<typeof knowledgeOutlineInputSchema>;
export type KnowledgeOutlineProposal = z.infer<
  typeof knowledgeOutlineProposalSchema
>;
export type KnowledgeOutlineDraft = KnowledgeOutlineInput & {
  id: string;
  version: number;
  state: "editing" | "planning" | "ready" | "failed" | "applied";
  rationale: string;
  gaps: string[];
  error: string | null;
  jobId: string | null;
  appliedPages: { id: string; key: string; jobId: string }[];
  createdAt: string;
  updatedAt: string;
};
export type KnowledgeOutlineView = KnowledgeOutlineDraft & {
  pageStatuses: {
    id: string;
    key: string;
    title: string;
    state: string;
    error: string | null;
  }[];
};
