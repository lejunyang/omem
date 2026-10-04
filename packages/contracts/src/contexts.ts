import { z } from "zod";

export const contextInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["project", "topic"]).default("project"),
  description: z.string().trim().max(1600).default(""),
}).strict();
export const contextIdsSchema = z.array(z.string().min(1).max(300)).max(40);
export type ContextInput = z.infer<typeof contextInputSchema>;
export type MaterialContext = ContextInput & { id: string; sourceCount: number };

/** A model's proposed filing decision, never a fact or a new project. */
export const contextResolutionSchema = z.object({
  status: z.enum(["matched", "ambiguous", "unrelated"]),
  contextIds: contextIdsSchema,
  candidateIds: contextIdsSchema,
  reason: z.string().min(1).max(2400),
  question: z.string().min(1).max(600).nullable(),
}).strict();
export type ContextResolution = z.infer<typeof contextResolutionSchema>;
export type ContextAssignment = {
  version: number;
  revisionId: string | null;
  status: "manual" | "automatic" | "ambiguous" | "unrelated";
  reason: string;
  question: string | null;
  candidateIds: string[];
};
