import { z } from "zod";

const stepText = (max: number) => z.string().trim().min(1).max(max);
export const reconcileResultSchema = z.object({ item: z.string(), summary: stepText(1000), steps: z.array(z.object({
  stage: z.string(), action: stepText(400), person: stepText(80).optional(), draft: stepText(1500).optional(), chat: stepText(100).optional(),
}).refine(s => (!!s.draft === !!s.person) && (!s.chat || !!s.draft), "找别人写 person 和 draft；只有本人能做则只填 action")).max(5).optional() });
