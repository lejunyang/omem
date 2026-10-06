import { z } from "zod";

export const attentionPolicySchema = z
  .object({
    focus: z.array(z.string().min(1)).default([]),
    ignore: z.array(z.string().min(1)).default([]),
    notifications: z.enum(["important", "all"]).default("important"),
    instruction: z
      .string()
      .optional()
      .describe(
        "Host-preserved owner wording. The host replaces this with the current user's actual request when preferences are set.",
      ),
  })
  .strict();
export type AttentionPolicy = z.infer<typeof attentionPolicySchema>;

const key = z.string().min(1);
const version = z.number().int().positive();
/** A proposal, applied by the host after the assistant turn completes. */
export const workActionSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("track"),
      title: key,
      goal: key,
      contextIds: z
        .array(key)
        .describe(
          "Prefer the saved project/topic when asked to continuously follow that project; this includes future members. Use returned IDs.",
        ),
      materialKeys: z
        .array(key)
        .describe(
          "Specific originals only. An empty list with contextIds follows all members of the selected project.",
        ),
      attention: attentionPolicySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("feedback"),
      key,
      expectedVersion: version,
      kind: z.enum(["correction", "attention"]),
      text: key.describe(
        "Exact relevant words from the current user message, not paraphrased source text.",
      ),
      attention: attentionPolicySchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("revoke_feedback"),
      key,
      expectedVersion: version,
      feedbackId: key,
    })
    .strict(),
  z
    .object({
      operation: z.literal("scope"),
      key,
      expectedVersion: version,
      contextIds: z.array(key),
      materialKeys: z.array(key),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["pause", "resume", "refresh"]),
      key,
      expectedVersion: version,
    })
    .strict(),
  z
    .object({
      operation: z.literal("start_development"),
      key,
      project: key,
      capabilities: z
        .array(key)
        .optional()
        .describe(
          "Optional subset of registered read-only capabilities for this coding task; omitted uses project defaults.",
        ),
      delegation: key.describe(
        "Copy the CURRENT user's explicit implementation assignment. Reading a source or asking how implementation works is not delegation.",
      ),
    })
    .strict(),
  z
    .object({ operation: z.literal("cancel_development"), taskId: key })
    .strict(),
]);
export type WorkAction = z.infer<typeof workActionSchema>;

export type WorkActor = {
  requestId: string;
  conversationId: string;
  principalId: string;
  userText: string;
  visibility: "private" | "group";
};
export type WorkReceipt = {
  tool: "work_action";
  operation: string;
  message: string;
  key?: string;
  taskId?: string;
  rejected?: boolean;
};
