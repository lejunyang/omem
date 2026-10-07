import { z } from "zod";
import { contextIdsSchema } from "./contexts.js";

export const scheduleTimingSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("interval"),
      everyMinutes: z.number().int().min(1).max(525_600),
    })
    .strict(),
  z
    .object({
      type: z.literal("cron"),
      expression: z.string().trim().min(1).max(200),
      timezone: z.string().trim().min(1).max(100),
    })
    .strict(),
]);
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;

export const scheduleInputSchema = z
  .object({
    kind: z.enum(["lark_discovery", "daily_brief"]),
    name: z.string().trim().min(1).max(120),
    instruction: z.string().trim().max(6000).default(""),
    contextIds: contextIdsSchema.default([]),
    enabled: z.boolean().default(false),
    timing: scheduleTimingSchema,
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export type ScheduleKind = ScheduleInput["kind"];

export type ScheduleRun = {
  id: string;
  taskId: string;
  taskVersion: number;
  jobId: string;
  trigger: "scheduled" | "manual";
  scheduledFor: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  state:
    | "queued"
    | "running"
    | "retry_wait"
    | "succeeded"
    | "failed"
    | "cancelled";
  summary: string | null;
  detail: string | null;
  resultRef: string | null;
  error: string | null;
  skipped: boolean;
  notificationState: string | null;
};

export type ScheduledTask = Omit<ScheduleInput, "expectedVersion"> & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRun: ScheduleRun | null;
  recentRuns: ScheduleRun[];
};

export type ScheduleResult = {
  summary: string;
  detail?: string;
  resultRef?: string | null;
  usage?: Record<string, unknown>;
  skipped?: boolean;
  notificationState?: string;
};
