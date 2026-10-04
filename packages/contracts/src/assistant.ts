import { z } from "zod";
import { taskActionSchema, taskFollowUpSchema } from "./task-flow.js";

const deadline = z.string().nullable().describe(
  "Actual completion deadline explicitly requested by the owner, with timezone. A reminder/check-in time belongs in follow_up.next_check_at. Null when only a reminder is requested; do not inherit a project's deadline for a new reminder.",
);
const followUp = taskFollowUpSchema.nullable().describe(
  "Reminder/check-in scheduling, including a NEW reminder with no waiting party. Set next_check_at and the owner's exact time_expression; waiting_on=null unless waiting for someone, snoozed_until=null for an initial reminder. Separate from a completion deadline.",
);

/** Native research returns locators, not copied database IDs or copied code. */
export const assistantReplySchema = z
  .object({
    answer: z.string().min(1),
    citations: z.array(
      z
        .object({
          id: z.string().regex(/^cite_[1-9]\d*$/),
          key: z.string().min(1),
          revision: z.string().optional(),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
        })
        .strict(),
    ),
    create_task: z
      .object({
        title: z.string().min(1),
        detail: z.string(),
        citation_ids: z.array(z.string()),
        due_at: deadline,
        due_expression: z.string().nullable(),
        follow_up: followUp,
      })
      .strict()
      .nullable(),
    update_task: z
      .object({
        task_id: z.string(),
        expected_version: z.number().int().positive(),
        action: taskActionSchema,
        due_at: deadline,
        due_expression: z.string().nullable(),
        follow_up: followUp,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AssistantReply = z.infer<typeof assistantReplySchema>;

export const answerDraftSchema = assistantReplySchema.pick({
  answer: true,
  citations: true,
});
export const answerReviewSchema = z
  .object({
    summary: z.string(),
    issues: z.array(
      z
        .object({
          problem: z.string().min(1),
          whyItMatters: z.string().min(1),
          suggestion: z.string().min(1),
          sources: assistantReplySchema.shape.citations,
        })
        .strict(),
    ),
  })
  .strict();
export type AnswerDraft = z.infer<typeof answerDraftSchema>;
export type AnswerReview = z.infer<typeof answerReviewSchema>;
