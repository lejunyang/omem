import type { FlowStage } from "./definitions.ts";
import type { StageRow } from "./store.ts";
import { HttpError } from "../core/util.ts";

export const retryTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
const MINUTE = 60_000;
const RETRY_DELAYS = [15, 30, 60].map(minutes => minutes * MINUTE);

export function canResumeStage(stage: FlowStage, row: StageRow) {
  return !!row.enteredAt && !row.control.gateReview && !row.control.budgetExceeded && !row.control.question && !row.control.upstream
    && typeof stage.by === "object" && "run" in stage.by && !stage.tools?.includes("propose_directions")
    && !stage.tools?.includes("record_finding");
}

export function externalRetry(row: StageRow, requestedAt: string, instruction: string, now: Date) {
  const requested = Date.parse(requestedAt);
  if (!retryTime.test(requestedAt) || !Number.isFinite(requested)) throw new HttpError(400, "重试时间要带时区");
  const attempts = row.control.externalRetry?.attempts ?? 0;
  const delay = RETRY_DELAYS[attempts];
  const waitUntil = delay === undefined ? undefined : new Date(Math.max(requested, now.getTime() + delay)).toISOString();
  return { waitUntil, retry: { attempts, instruction } };
}
