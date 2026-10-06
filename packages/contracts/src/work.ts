import { z } from "zod";
import { projectConfigurationSchema } from "./development.js";

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
      operation: z.literal("configure_project"),
      project: key,
      configuration: projectConfigurationSchema,
      delegation: key.describe(
        "Exact current owner request to prepare/configure this project's development checks. Saves configuration only; does not execute commands.",
      ),
    })
    .strict(),
  z
    .object({
      operation: z.literal("prepare_repository"),
      alias: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/),
      url: key.describe(
        "Exact Git address/path supplied by the owner, or the origin of an already registered project. No credentials in URLs.",
      ),
      ref: key.describe(
        "Requested branch, tag or commit; use HEAD only when no version was specified. Preserve a registered project's ref when retrying.",
      ),
      delegation: key.describe(
        "Copy the current owner request to prepare, fetch or retry this repository. This queues preparation, not coding.",
      ),
    })
    .strict(),
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
      configuration: projectConfigurationSchema
        .optional()
        .describe(
          "Optional explicit project configuration. Normally dispatch the assignment directly: the coding agent reads repository rules and chooses missing/outdated checks in its own checkout.",
        ),
      inputReceipts: z
        .array(z.uuid())
        .optional()
        .describe(
          "Relevant actual external receipt IDs returned by conversation_inputs or capability_call. Empty means none; omitted carries up to 100 recent receipts for selected capabilities. No arbitrary paths or invented source content.",
        ),
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
  z
    .object({
      operation: z.literal("resume_development"),
      taskId: key,
      delegation: key.describe(
        "Exact CURRENT user instruction to continue this existing task on the same checkout, including adopting a reviewed changed requirement.",
      ),
    })
    .strict(),
  z
    .object({
      operation: z.literal("apply_development"),
      taskId: key,
      reviewedFingerprint: key.describe(
        "Copy from a fresh work_result with phase=ready and matchesReviewed=true. Never invent or reuse a different task's fingerprint.",
      ),
      delegation: key.describe(
        "Exact CURRENT user instruction to apply this reviewed patch to the registered repository. Does not authorize commit, push or deployment.",
      ),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["follow_action", "unfollow_action"]),
      key,
      actionId: key,
      expectedRevision: key.describe(
        "Current requirement revision from work_status.",
      ),
      delegation: key.describe(
        "Exact CURRENT user instruction to add or stop following this requirement action in personal todos.",
      ),
    })
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
  personalTaskId?: string;
  rejected?: boolean;
};
