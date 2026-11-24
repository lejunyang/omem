import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { json, now } from "../core/util.ts";

const text = z.string().trim().min(1);
const step = z.object({ step: text.max(1000), done_when: text.max(500) });
export const changeStepsSchema = z.array(z.discriminatedUnion("who", [
  step.extend({ who: z.enum(["me-read", "me-write", "owner"]) }),
  step.extend({ who: z.literal("other"), waiting_for: text.max(200), check_at: z.string().datetime({ offset: true }) }),
])).min(1).max(6).describe("每个下一步分别交：who 谁做、step 做什么、done_when 做到什么算完；other 另填 waiting_for 等谁、check_at 带时区的回查时间");
export const CHANGE_TYPES = ["scope", "decision", "deadline", "blocker", "info", "stage", "result", "owner", "resolved", "todo", "question"] as const;
export const changeSchema = z.object({
  item: z.string(),
  type: z.enum(["scope", "decision", "deadline", "blocker", "info", "stage", "result", "owner", "resolved"])
    .describe("scope 范围 / decision 决定 / deadline 时间 / blocker 阻塞或风险 / info 其他信息 / stage 阶段 / result 结果 / owner 负责人 / resolved 风险解除"),
  summary: z.string().trim().min(1).max(500).describe("一句话：变了什么"),
  detail: z.string().max(6000).optional().describe("原因和经过"),
  risk: z.string().trim().max(1000).optional().describe("变化带来的风险"),
  next: z.string().trim().max(1000).optional().describe("旧字段，有下一步时改用 steps"),
  steps: changeStepsSchema.optional(), req: z.string().optional(), stages: z.array(z.string()).max(20).optional(),
  refs: z.array(z.string()).min(1).max(50), due: z.string().optional().describe("deadline 必填：ISO 时间或日期"),
  decided: z.boolean().optional().describe("deadline 确认已定时填 true；scope 或 decision 只有本人的拍板原话能直接并进，别人提议不填"),
});
const operationSchema = z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()) });
export type StepOperation = z.infer<typeof operationSchema>;
const operationNoteSchema = z.object({
  action: text.max(1200).describe("只授权做的这一项操作，包括要写的内容或状态"),
  target: text.max(500).describe("要操作的具体对象，包括能区分它的链接、标识或环境"),
  expected: text.max(500).describe("预期结果和怎么核对"),
});
export type StepOperationNote = z.infer<typeof operationNoteSchema>;
export const stepReportSchema = z.object({
  step_id: z.string(), result: z.string().trim().min(1).max(3000), refs: z.array(z.string()).max(16),
  done: z.boolean().optional().describe("达到完成条件才为 true；查不到或仍等别人就填 false"),
  decision: z.object({ title: z.string().trim().min(1).max(200), options: z.array(z.string().trim().min(1).max(40)).min(2).max(6) }).optional(),
  operation: operationSchema.optional().describe("一条可重放的外部写入工具及完整参数"),
  operation_note: operationNoteSchema.optional().describe("没有可重放的工具时写操作说明；result 和 refs 填只读核对的结论和依据。不能和 operation 同填"),
  execution_status: z.enum(["executed", "failed", "uncertain"]).optional().describe("仅用于本人批准操作说明后的执行轮：已核对执行结果 / 明确未完成 / 可能已执行但无法核对；result 写结果或原因"),
});

export type StepInput = z.infer<typeof changeStepsSchema>[number];
export type Step = {
  id: string; change_id: string; batch_id: string; anchor: string; item_id: string;
  who: StepInput["who"]; step: string; done_when: string; waiting_for: string | null; check_at: string | null;
  state: string; run_id: string | null; ask_id: string | null; result: string | null; refs: string | null;
};
const STEP_LABEL: Record<string, string> = {
  pending: "待接手", waiting: "等别人", queued: "已接手", owner: "等本人", proposed: "等确认执行", approved: "已同意执行",
  done: "已处理", checked: "已回查，仍在等", declined: "不执行", suggested: "仅建议", blocked: "未完成", submitted: "已调用，见结果", skipped: "未接手",
  executed: "已执行", failed: "执行失败", uncertain: "不确定，需要核对",
};
export function stepsOf(app: App, changeId: string) {
  return all<Step>(app.db, "select * from item_change_steps where change_id=? order by id", changeId);
}
export function stepViews(app: App, changeId: string) {
  return stepsOf(app, changeId).map(s => ({ id: s.id, who: s.who, step: s.step, doneWhen: s.done_when, waitingFor: s.waiting_for, checkAt: s.check_at,
    status: s.state, statusLabel: STEP_LABEL[s.state], result: s.result, refs: json<string[]>(s.refs, []), runId: s.run_id }));
}
export function stepBrief(steps: ReturnType<typeof stepViews>) {
  return steps.map(s => `下一步（${s.statusLabel}）：${s.waitingFor ? `等${s.waitingFor}，` : ""}${s.step}${s.checkAt ? `；回查 ${s.checkAt}` : ""}${s.result ? `；${s.result} ${s.refs.join(" ")}` : ""}`).join("\n");
}

/** The first declaration wins even when a batch is retried or another writer had already noted the change. */
export function saveChangeSteps(app: App, itemId: string, changeId: string, batchId: string, anchor: string, steps: StepInput[] = []) {
  if (!steps.length || stepsOf(app, changeId).length) return;
  steps.forEach((s, i) => run(app.db, `insert into item_change_steps(id,change_id,batch_id,anchor,item_id,who,step,done_when,waiting_for,check_at,state,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?)`, `${changeId}:${i + 1}`, changeId, batchId, anchor, itemId, s.who, s.step, s.done_when,
  s.who === "other" ? s.waiting_for : null, s.who === "other" ? new Date(s.check_at).toISOString() : null, s.who === "other" ? "waiting" : "pending", now()));
}
