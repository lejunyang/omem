import { z } from "zod";

const stepText = (max: number) => z.string().trim().min(1).max(max);
export const reconcileResultSchema = z.object({ item: z.string(), summary: stepText(1000), steps: z.array(z.object({
  stage: z.string(), action: stepText(400), person: stepText(80).optional(), draft: stepText(1500).optional(), chat: stepText(100).optional(),
}).refine(s => (!!s.draft === !!s.person) && (!s.chat || !!s.draft), "找别人写 person、draft 和要发到的关联群 chat；只有本人能做则只填 action")).max(5).optional(),
  finish: z.object({ reason: stepText(1000), evidence: z.array(stepText(250)).min(1).max(50), close_item: z.boolean().optional() }).optional(),
}).refine(a => !a.finish || !a.steps?.length, "收口和下一步不能一起交");
