import type { App } from "../core/app.ts";
import { one, withinTx } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { answerAsk, createAsk, getAsk } from "./asks.ts";
import { getLongTask, longTaskInThread, type LongTask } from "./long-tasks.ts";
import { fieldsText } from "./ui-blocks.ts";
import { createRun, runUser } from "./runs.ts";
import { followCodePlan } from "./code-auto-follow.ts";
import { autoFollowFor } from "./auto-follow.ts";
import { supervisorRounds, wakeSupervisor } from "./supervisor.ts";

/** Helpers and review runs inherit the work of their parent. A continuation belongs to its original delegation. */
export function longTaskForRun(app: App, runId: string | null): LongTask | null {
  const seen = new Set<string>();
  while (runId && !seen.has(runId)) {
    seen.add(runId);
    const row: { kind: string; input: string; parent_id: string | null } | undefined = one(app.db, "select kind,input,parent_id from runs where id=?", runId);
    if (!row) break;
    const input = JSON.parse(row.input);
    if (input.longTaskId) return getLongTask(app, input.longTaskId);
    const adopted = row.kind === "code" ? autoFollowFor(app, "code", input.continueFrom ?? runId)
      : input.agentWorkId ? autoFollowFor(app, "agentWork", input.agentWorkId) : null;
    if (adopted) return adopted;
    const thread = input.threadId ?? input.conversationId;
    const task = thread && longTaskInThread(app, thread);
    if (task) return task;
    runId = input.continueFrom ?? input.codeRunId ?? row.parent_id;
  }
  return null;
}

export function workBudgetStop(app: App, task: LongTask, rootId?: string): string | null {
  if (task.status !== "active") return "长任务当前未在推进，先查看任务状态";
  if (Date.now() >= Date.parse(task.createdAt) + task.budget.hours * 3_600_000) return "长任务已达到总时长预算，需要本人加预算";
  const used = supervisorRounds(app, task, rootId);
  if (used.total >= task.budget.codeRounds) return `长任务已用完 ${task.budget.codeRounds} 个工作轮次，需要本人加预算`;
  if (used.local >= app.config.agents.autoAdvance.codeRoundsMax) return "本次交办已达单个交办的编码轮次上限";
  return null;
}

/** Count and enqueue under one write lock, including the first round and retries. */
export function createCodeRound(app: App, request: Parameters<typeof createRun>[1]) {
  return withinTx(app.db, () => {
    const input = request.input ?? {};
    const root = typeof input.continueFrom === "string" ? input.continueFrom : undefined;
    const task = typeof input.longTaskId === "string" ? getLongTask(app, input.longTaskId)
      : longTaskForRun(app, root ?? (typeof input.fromReview === "string" ? input.fromReview : request.parentId ?? null));
    if (!task) {
      const round = createRun(app, request);
      if (!root && !input.branches) followCodePlan(app, round.id);
      return round;
    }
    if ((request.userId ?? runUser(app, request.parentId ?? null)) !== task.userId)
      throw new HttpError(403, "编码运行与长任务必须属于同一用户");
    if (request.parentId && one(app.db, `select 1 from runs where id=? and kind='supervise' and json_extract(output,'$.supervisorReport') is not null`, request.parentId))
      throw new HttpError(409, "助手已交本轮报告，不能再派活");
    if (!input.branches) {
      const stop = workBudgetStop(app, task, root ?? (typeof input.retryOf === "string" ? input.retryOf : undefined));
      if (stop) throw new HttpError(409, stop);
    }
    // Adopted rounds keep their original chain. Detaching the source restores its normal routing.
    if (root && task.sourceKind === "code" && task.sourceId === root) return createRun(app, request);
    return createRun(app, { ...request, input: { ...input, longTaskId: task.id } });
  });
}

export function signalCodeWork(app: App, runId: string, note: string, drift = false) {
  const task = longTaskForRun(app, runId);
  if (task) wakeSupervisor(app, task.id, `交办 ${runId} · ${note}`, { immediate: drift, drift });
  return task?.id ?? null;
}

/** A verbatim brief/supplement entry, or a run of this task that contains the cited observation. */
export function checkSupervisorBasis(app: App, caller: string | null, target: string, basis?: string) {
  const task = longTaskForRun(app, caller);
  if (!task || task.id !== longTaskForRun(app, target)?.id) throw new HttpError(403, "只能调整自己长任务的交办");
  if (task.status !== "active") throw new HttpError(409, "只有推进中的长任务可以调整交办");
  if (one(app.db, "select 1 from runs where id=? and json_extract(output,'$.supervisorReport') is not null", caller))
    throw new HttpError(409, "助手已交本轮报告，不能再调整交办");
  const text = basis?.trim();
  const entries = [task.goal, ...Object.values(task.brief).flat(), ...task.supplements.map(s => s.text)];
  if (text && entries.some(line => typeof line === "string" && line.trim() && text.includes(line.trim()))) return;
  const ids = text?.match(/\br[0-9a-z]{19}\b/g) ?? [];
  if (ids.some(id => longTaskForRun(app, id)?.id === task.id)) return;
  throw new HttpError(400, "basis 要引用任务书的一条原文、本人补充的原话或本任务的运行 ID。需要改目标或范围时请在报告中问本人");
}

export function createWorkerAsk(app: App, input: Parameters<typeof createAsk>[1]) {
  const supervisor = longTaskForRun(app, input.runId);
  if (!supervisor) return createAsk(app, input);
  if ((input.kind && input.kind !== "question") || (input.context?.handler && input.context.handler !== "review-escalation"))
    throw new HttpError(400, "只有工作者的问题和评审分歧可以交给助手跟进");
  return withinTx(app.db, () => {
    const ask = createAsk(app, { ...input, context: { ...input.context, supervisorTaskId: supervisor.id, notificationOnly: true } });
    const choices = ask.options.map(option => option.label).join(" / ");
    const fields = ask.ui?.fields?.length ? fieldsText(ask.ui.fields) : "";
    wakeSupervisor(app, supervisor.id, [`运行 ${ask.runId} 的问题 ${ask.id}`, ask.question, choices, fields].filter(Boolean).join("\n"));
    return ask;
  });
}

/** Only the question routed by the host (never approvals or another task's asks) may be answered here. */
export async function answerWorkerQuestion(app: App, taskId: string, questionId: string, answer: string, ownerId?: string) {
  const taskQuestion = /^task:(\d+):(.+)$/.exec(questionId);
  if (taskQuestion) {
    const { answerTask, settleTask } = await import("./code-loop.ts");
    const { getTask } = await import("./code-tasks.ts");
    const row = one<{ work_id: string; seq: number }>(app.db, "select work_id,seq from code_tasks where id=?", Number(taskQuestion[1]));
    if (!row || longTaskForRun(app, row.work_id)?.id !== taskId) throw new HttpError(404, "这个长任务没有该修改项");
    const task = getTask(app, row.work_id, row.seq);
    if (task.origin.questionId !== taskQuestion[2]) throw new HttpError(409, "修改项或问题已经变化，请重新核对");
    if (task.state !== "assistant") {
      if (!ownerId && task.notes.some(n => n.by === "supervisor" && n.text === "重做：" + answer.trim())) return;
      throw new HttpError(409, "修改项已经处理");
    }
    if (!answer.trim()) throw new HttpError(400, "回答不能为空");
    if (ownerId) answerTask(app, row.work_id, row.seq, { choice: answer.trim() }, ownerId);
    else settleTask(app, row.work_id, row.seq, { action: "retry", text: answer.trim(), ownerWords: false }, "supervisor");
    return;
  }
  const routed = one(app.db, `select 1 from asks where id=? and kind='question' and json_extract(context,'$.supervisorTaskId')=?`, questionId, taskId);
  if (!routed) throw new HttpError(404, "这个问题不在本任务的跟进清单里");
  const ask = getAsk(app, questionId);
  if (ask.status === "answered" && ask.answer === answer.trim()) return;
  const choice = ask.options.findIndex(option => option.label === answer.trim());
  await answerAsk(app, questionId, { by: ownerId && ask.handler?.startsWith("study-") ? ownerId : "supervisor", ...(choice < 0 ? { text: answer } : { choice }) });
}
