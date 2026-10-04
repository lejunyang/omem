import { z } from "zod";

export const contextInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["project", "topic"]).default("project"),
  description: z.string().trim().max(1600).default(""),
}).strict();
export const contextIdsSchema = z.array(z.string().min(1).max(300)).max(40);
export type ContextInput = z.infer<typeof contextInputSchema>;
export type MaterialContext = ContextInput & { id: string; sourceCount: number };
