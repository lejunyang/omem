import { z } from "zod";

export const taskStatusSchema = z.enum(["open", "waiting", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export const taskFollowUpSchema = z.object({
  waiting_on: z.string().min(1).max(500).nullable(),
  next_check_at: z.iso.datetime({ offset: true }).nullable(),
  snoozed_until: z.iso.datetime({ offset: true }).nullable(),
  time_expression: z.string().max(500).nullable(),
  timezone: z.string().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "Invalid IANA timezone"),
}).strict();
export type TaskFollowUp = z.infer<typeof taskFollowUpSchema>;
export const taskActionSchema = z.enum(["complete", "reopen", "reschedule", "wait", "snooze", "cancel"]);
export type TaskAction = z.infer<typeof taskActionSchema>;
export const taskCommandSchema = z.object({
  action: taskActionSchema,
  expectedVersion: z.number().int().min(1),
  requestId: z.string().min(1).max(200),
  dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
  dueExpression: z.string().max(500).nullable().default(null),
  followUp: taskFollowUpSchema.nullable().optional(),
}).strict();
