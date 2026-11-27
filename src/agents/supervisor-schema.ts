import { z } from "zod";

const line = z.string().trim().min(1).max(2000);
const lines = z.array(line).max(40);
const answer = z.object({ questionId: line, answer: line, basis: line });
const question = z.object({ questionId: line.optional(), question: line.max(200), options: z.array(line.max(200)).min(2).max(8), prefer: line.max(200), why: line.max(500) })
  .refine(q => q.options.includes(q.prefer), "倾向填写所列选项之一");
export const reportSchema = z.object({
  status: z.enum(["on-track", "drifting", "stuck", "needs-owner", "done"]),
  stage: line.max(120).describe("当前阶段；同一阶段保持原名"),
  goalCheck: lines,
  decisions: z.array(z.object({ what: line, why: line })).max(40),
  actions: lines,
  progress: z.object({ done: lines, doing: lines, next: lines }),
  askOwner: z.array(question).max(20),
  answers: z.array(answer).max(20).optional().describe("授权内的问题，按宿主给的 questionId 写回"),
  setAside: lines.optional(), overruled: lines.optional(),
  brief: z.object({ doneWhen: lines, outOfScope: lines, scope: lines, constraints: lines.optional() }).optional()
    .describe("草案或修改建议；本人确认后生效。完成条件、排除项、目录范围逐行填写。"),
});
export type SupervisorReport = z.infer<typeof reportSchema>;
