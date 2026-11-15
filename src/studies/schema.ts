import { z } from "zod";

const text = (max = 4000) => z.string().trim().min(1).max(max);
export const resultSchema = z.enum(["passed", "failed", "blocked", "unclear"]);
export const findingSchema = z.object({ kind: z.enum(["defect", "gap", "idea"]), title: text(300), repro: text(12000) });
export const proposalSchema = z.object({
  item: text(100), note: z.string().max(4000).optional(),
  directions: z.array(z.object({ goal: text(500), approach: text(), acceptance: text(), env: z.string().trim().max(1000).optional(), thirdParty: z.boolean().optional(), estimate: text(1000).optional(), trials: z.array(z.object({ object: text(1000), check: text(2000) })).min(1).max(40) })).max(3),
});
export const trialReportSchema = z.object({ trial: text(100), result: resultSchema, summary: text(12000), evidence: z.array(text(1000)).max(50).optional(), findings: z.array(findingSchema).max(20).optional(), unsure: z.boolean().optional() });
export const ledgerSchema = z.object({ item: text(100), direction: text(100).optional(), object: text(1000).optional(), result: resultSchema.optional(), round: z.number().int().positive().optional(), limit: z.number().int().min(1).max(1000).optional() });
export const recordFindingSchema = findingSchema.extend({ item: text(100), trials: z.array(text(100)).min(1).max(1000), same_as: text(100).optional(), distinct_from: z.array(text(100)).max(100).optional() });
export const closeDirectionSchema = z.object({ direction: text(100), state: z.enum(["done", "dropped"]), conclusion: text(12000) });
export type Proposal = z.infer<typeof proposalSchema>;
export type TrialReport = z.infer<typeof trialReportSchema>;
export type FindingInput = z.infer<typeof recordFindingSchema>;
