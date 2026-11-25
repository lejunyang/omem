import { z } from "zod";
import { retryTime } from "./stage-retry.ts";

const stepText = (max: number) => z.string().trim().min(1).max(max);
export const reconcileResultSchema = z.object({ item: z.string(), summary: stepText(1000), steps: z.array(z.object({
  kind: z.enum(["external", "assistant", "owner"]),
  stage: z.string(), action: stepText(400), person: stepText(80).optional(), draft: stepText(1500).optional(), chat: stepText(100).optional(),
  retry_at: z.string().max(40).regex(retryTime).refine(value => Number.isFinite(Date.parse(value))).optional(),
  why_owner: stepText(400).optional(), evidence: z.array(stepText(250)).max(20).optional(),
}).refine(s => s.kind === "owner" ? !!s.why_owner && !s.retry_at && (!!s.draft === !!s.person) && (!s.chat || !!s.draft)
  : !s.person && !s.draft && !s.chat && !s.why_owner && (s.kind === "external") === !!s.retry_at,
"等外部恢复填 retry_at；只有本人能做填 why_owner；要本人找别人可补 person、draft、关联群 chat")).max(5).optional(),
  finish: z.object({ reason: stepText(1000), evidence: z.array(stepText(250)).min(1).max(50), close_item: z.boolean().optional() }).optional(),
}).refine(a => !a.finish || !a.steps?.length, "收口和下一步不能一起交");
