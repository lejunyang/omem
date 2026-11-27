import { z } from "zod";
import type { App } from "../core/app.ts";
import { allProfiles, supervisorAiSchema } from "../core/config.ts";
import { one, run, withinTx } from "../core/db.ts";
import { getSpace } from "../core/spaces.ts";
import { canWrite } from "../core/users.ts";
import { HttpError, newId, now, truncate } from "../core/util.ts";
import { itemAccess } from "../items/access.ts";
import { addItemEvent, upsertItem } from "../items/store.ts";
import { validateExecution } from "./execution.ts";
import { setRunOutput } from "./runs.ts";
import type { SupervisorReport } from "./supervisor-schema.ts";
import { wakeSupervisor } from "./supervisor.ts";
import { createThread, getThread } from "./threads.ts";

const verbatim = z.string().max(32000).refine(s => !!s.trim(), "内容不能为空");
const lines = z.array(z.string().min(1).max(2000)).max(100);
const briefSchema = z.strictObject({
  doneWhen: lines, outOfScope: lines, scope: lines, constraints: lines, mustAsk: lines,
});
const budgetSchema = z.strictObject({
  dailyWakes: z.number().int().positive(), codeRounds: z.number().int().positive(), hours: z.number().positive(),
});
const notificationsSchema = z.strictObject({
  milestones: z.boolean(), owner: z.boolean(), corrections: z.boolean(), summaryHours: z.number().nonnegative(),
});
const budgetPatch = budgetSchema.partial().refine(b => Object.keys(b).length > 0, "请填写预算");
const initialBrief = {
  doneWhen: [], outOfScope: [], scope: [], constraints: [],
  mustAsk: ["推送或合并到主分支", "发布", "修改目标或涉及范围外的工作", "超出预算", "不可逆的操作", "产品和业务取舍"],
};
export const startLongTaskSchema = z.strictObject({
  spaceId: z.string().min(1), goal: verbatim, ai: supervisorAiSchema.optional(), threadId: z.string().min(1).optional(),
  budget: budgetPatch.optional(), notifications: notificationsSchema.partial().optional(),
});
export const longTaskCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("pause") }), z.strictObject({ action: z.literal("resume") }),
  z.strictObject({ action: z.literal("end") }), z.strictObject({ action: z.literal("ai"), ai: supervisorAiSchema }),
  z.strictObject({ action: z.literal("budget"), budget: budgetPatch }),
  z.strictObject({ action: z.literal("supplement"), text: verbatim }),
]);
export type LongTaskCommand = z.infer<typeof longTaskCommandSchema>;
type SupervisorAi = z.infer<typeof supervisorAiSchema>;
type Brief = z.infer<typeof briefSchema>;
type Budget = z.infer<typeof budgetSchema>;
type SupervisorNote = {
  at: string; runId: string; stage: string; plan: string[]; decisions: { what: string; why: string }[];
  actions: string[]; setAside: string[]; overruled: string[];
};
export type LongTask = {
  id: string; spaceId: string; userId: string; threadId: string; itemId: string;
  goal: string; ai: SupervisorAi; status: "draft" | "active" | "paused" | "ended" | "done";
  brief: Brief; confirmedAt: string | null; supplements: { at: string; text: string }[];
  budget: Budget; notifications: z.infer<typeof notificationsSchema>; notes: SupervisorNote[];
  createdAt: string; updatedAt: string;
};

const columns = `id, space_id spaceId, user_id userId, thread_id threadId, item_id itemId, goal, ai, status,
  brief, confirmed_at confirmedAt, supplements, budget, notifications, notes, created_at createdAt, updated_at updatedAt`;
type JsonColumn = "ai" | "brief" | "supplements" | "budget" | "notifications" | "notes";
type Row = Omit<LongTask, JsonColumn> & Record<JsonColumn, string>;
function taskFrom(row: Row): LongTask {
  return { ...row, ai: JSON.parse(row.ai), brief: JSON.parse(row.brief), supplements: JSON.parse(row.supplements),
    budget: JSON.parse(row.budget), notifications: JSON.parse(row.notifications), notes: JSON.parse(row.notes) };
}

export function getLongTask(app: App, id: string): LongTask {
  const row = one<Row>(app.db, `select ${columns} from long_tasks where id=?`, id);
  if (!row) throw new HttpError(404, "没有这个长任务");
  return taskFrom(row);
}
export function longTaskInThread(app: App, threadId: string): LongTask | null {
  const row = one<Row>(app.db, `select ${columns} from long_tasks where thread_id=?`, threadId);
  return row ? taskFrom(row) : null;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, result.error.issues.map(i => i.path.join(".") + " " + i.message).join("；"));
  return result.data;
}

function supervisorAi(app: App, userId: string, ai?: SupervisorAi): SupervisorAi {
  const pick = ai ?? app.config.longTasks.supervisor ?? app.config.agents.tiers.strong;
  if (!pick) throw new HttpError(400, "请指定监工 AI，或在设置里配置默认监工或强模型");
  const profile = allProfiles(app.config).find(p => p.id === pick.profile);
  // Keep the chosen model even when the backend is temporarily down. The supervisor queues that exact choice.
  const e = validateExecution(app, { profile: pick.profile, model: pick.model ?? profile?.model,
    effort: pick.effort ?? profile?.effort, source: "user", reason: "长任务的监工" }, userId, true)!;
  return { profile: e.profile, model: e.model, effort: e.effort };
}

export function startLongTask(app: App, input: z.input<typeof startLongTaskSchema> & { userId: string }): LongTask {
  const { userId, ...args } = input;
  const { spaceId, threadId, goal, ...settings } = parse(startLongTaskSchema, args);
  requireTaskWrite(app, { userId, spaceId });
  getSpace(app, spaceId);
  const parent = threadId ? getThread(app, threadId) : null;
  if (parent && (parent.spaceId !== spaceId || parent.userId !== userId)) throw new HttpError(403, "发起会话不属于当前用户和空间");
  const ai = supervisorAi(app, userId, settings.ai);
  const budget = { dailyWakes: 40, codeRounds: app.config.agents.autoAdvance.codeRoundsMax, hours: 8, ...settings.budget };
  const notifications = { milestones: true, owner: true, corrections: true, summaryHours: 3, ...settings.notifications };
  const title = truncate(goal.trim(), 100);
  return withinTx(app.db, () => {
    const item = upsertItem(app, undefined, { kind: "watch", title, detail: goal, spaceId, userId }, "user");
    const lark = parent && parent.channel.startsWith("lark");
    const thread = createThread(app, { spaceId, userId, title, parentId: parent?.id,
      channel: parent?.channel ?? "web", key: lark ? parent.key?.split("#")[0] : null,
      settings: { itemId: item.id, links: parent ? [parent.id] : [], ...(lark && { isolatedTopic: true,
        lastMessageId: parent.settings.lastMessageId, group: parent.settings.group, lark: parent.settings.lark }) } });
    const id = newId("lt"), at = now();
    run(app.db, `insert into long_tasks(id,space_id,user_id,thread_id,item_id,goal,ai,brief,budget,notifications,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?)`, id, spaceId, userId, thread.id, item.id, goal, JSON.stringify(ai),
      JSON.stringify(initialBrief), JSON.stringify(budget), JSON.stringify(notifications), at, at);
    wakeSupervisor(app, id, "长任务已创建，请起草任务书", { immediate: true });
    return getLongTask(app, id);
  });
}

function requireTaskWrite(app: App, task: Pick<LongTask, "spaceId" | "userId">) {
  if (!canWrite(app, task.userId, task.spaceId) || !itemAccess(app, task.userId, task, "write"))
    throw new HttpError(403, "需要长任务所在空间的编辑权限");
}

function requireOpen(task: LongTask) {
  if (task.status === "ended" || task.status === "done") throw new HttpError(409, "这件长任务已结束");
}

/** Caller has authenticated the owner of this task (HTTP, command or confirmation card). Budget fields are new totals. */
export function changeLongTask(app: App, id: string, command: LongTaskCommand): LongTask {
  const c = parse(longTaskCommandSchema, command);
  return withinTx(app.db, () => {
    const task = getLongTask(app, id);
    requireOpen(task);
    requireTaskWrite(app, task);
    const at = now();
    let note: string;
    switch (c.action) {
      case "pause":
      case "resume":
      case "end": {
        const status = c.action === "end" ? "ended" : c.action === "pause" ? "paused" : task.confirmedAt ? "active" : "draft";
        if (status === task.status) return task;
        if (c.action === "resume" && task.status !== "paused") throw new HttpError(409, "只有暂停的长任务可以继续");
        note = { end: "本人结束了长任务", pause: "本人暂停了长任务", resume: "本人继续了长任务" }[c.action];
        run(app.db, "update long_tasks set status=?,updated_at=? where id=?", status, at, id);
        upsertItem(app, task.itemId, { status: c.action === "end" ? "cancelled" : c.action === "pause" ? "snoozed" : "open", note }, "user");
        break;
      }
      case "supplement":
        note = c.text;
        run(app.db, "update long_tasks set supplements=json_insert(supplements,'$[#]',json_object('at',?,'text',?)),updated_at=? where id=?", at, c.text, at, id);
        break;
      case "budget": {
        const budget = { ...task.budget, ...c.budget };
        note = `本人调整了预算：${budget.hours} 小时、${budget.codeRounds} 轮、每天唤醒 ${budget.dailyWakes} 次`;
        run(app.db, "update long_tasks set budget=?,updated_at=? where id=?", JSON.stringify(budget), at, id);
        break;
      }
      case "ai": {
        const ai = supervisorAi(app, task.userId, c.ai);
        note = "本人更换监工 AI：" + [ai.profile, ai.model, ai.effort].filter(Boolean).join(" · ");
        run(app.db, "update long_tasks set ai=?,updated_at=? where id=?", JSON.stringify(ai), at, id);
        break;
      }
    }
    if (c.action === "supplement" || c.action === "budget" || c.action === "ai")
      addItemEvent(app, task.itemId, c.action, note, "user");
    wakeSupervisor(app, id, note, { immediate: true });
    return getLongTask(app, id);
  });
}

/** Apply only the fields accepted on the owner's confirmation card. Drafts stay inert until there is a completion criterion. */
export function confirmLongTaskBrief(app: App, id: string, changes: Partial<Brief>): LongTask {
  const patch = parse(briefSchema.partial(), changes);
  return withinTx(app.db, () => {
    const task = getLongTask(app, id);
    requireOpen(task);
    requireTaskWrite(app, task);
    const brief = { ...task.brief, ...patch };
    if (!brief.doneWhen.some(s => s.trim())) throw new HttpError(400, "请填写至少一条完成条件");
    const at = now();
    run(app.db, "update long_tasks set brief=?, confirmed_at=?, status=case when status='draft' then 'active' else status end, updated_at=? where id=?",
      JSON.stringify(brief), at, at, id);
    const note = "本人确认了任务书";
    addItemEvent(app, task.itemId, "brief", note, "user");
    wakeSupervisor(app, id, note, { immediate: true });
    return getLongTask(app, id);
  });
}

/** Called after validating the supervisor's run and report, inside the same transaction as the card proposal. */
export function saveLongTaskReport(app: App, id: string, runId: string, report: SupervisorReport, progressText: string) {
  withinTx(app.db, () => {
    const task = getLongTask(app, id);
    requireOpen(task);
    requireTaskWrite(app, task);
    if (task.status === "paused" || (report.status === "done" && task.status !== "active"))
      throw new HttpError(409, "当前长任务状态不能提交这份报告");
    if (one(app.db, "select 1 from runs where id=? and json_type(output,'$.supervisorReport') is not null", runId))
      throw new HttpError(409, "本轮已经交过报告");
    const note: SupervisorNote = { at: now(), runId, stage: report.stage, plan: report.progress.next, decisions: report.decisions,
      actions: report.actions, setAside: report.setAside ?? [], overruled: report.overruled ?? [] };
    setRunOutput(app, runId, { supervisorReport: report, progressText });
    run(app.db, `update long_tasks set notes=json_insert(notes,'$[#]',json(?)), updated_at=?,
      status=case when ?='done' then 'done' else status end where id=?`, JSON.stringify(note), note.at, report.status, id);
    addItemEvent(app, task.itemId, "supervise", progressText, "supervisor", [`run:${runId}`], runId);
    if (report.status === "done") upsertItem(app, task.itemId, { status: "done" }, "agent", runId);
  });
}
