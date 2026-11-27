import type { App } from "../core/app.ts";
import { allProfiles } from "../core/config.ts";
import { all, one, run, withinTx } from "../core/db.ts";
import { canWrite } from "../core/users.ts";
import { HttpError, now, truncate, zonedParts, zoneMidnight } from "../core/util.ts";
import { backendAvailable } from "./availability.ts";
import { downReason, excludedReason, hasRoom } from "./capacity.ts";
import { validateExecution, type Execution } from "./execution.ts";
import { getLongTask, type LongTask } from "./long-tasks.ts";
import { createRun, getRun, queuedInLane, ResumeRunAt, updateQueuedRun, type RunContext } from "./runs.ts";
import { getThread } from "./threads.ts";

type WakeEvent = { note: string; drift: boolean };
type Session = { id: string; stage: string; ai: LongTask["ai"] };
type SupervisorState = {
  day?: string; wakes?: number; lastWake?: string; session?: Session; stage?: string;
  briefAsk?: string; cardId?: string; lastPush?: string; pendingPush?: string; pendingHighlights?: string[]; lastReport?: string;
};

export function supervisorState(app: App, id: string): SupervisorState {
  return JSON.parse(one<{ state: string }>(app.db, "select state from long_tasks where id=?", id)!.state);
}

/** Only change the keys owned by this event. A report and an owner message can arrive in one turn. */
export function patchSupervisorState(app: App, id: string, patch: Partial<{ [K in keyof SupervisorState]: SupervisorState[K] | null }>) {
  run(app.db, "update long_tasks set state=json_patch(state,?), updated_at=? where id=?", JSON.stringify(patch), now(), id);
}

const minute = 60_000;
const laneOf = (id: string) => `supervisor:${id}`;
const stopped = (task: LongTask) => ["paused", "ended", "done"].includes(task.status);

export function wakeSupervisor(app: App, id: string, note: string, options: { immediate?: boolean; drift?: boolean } = {}) {
  return withinTx(app.db, () => {
    const task = getLongTask(app, id);
    if (stopped(task)) return;
    const lane = laneOf(id);
    const event: WakeEvent = { note, drift: !!options.drift };
    const queued = queuedInLane(app, lane, "supervise");
    if (queued) {
      const events = (queued.input.events ?? []) as WakeEvent[];
      if (!events.some(e => e.note === note)) events.push(event);
      updateQueuedRun(app, queued.id, {
        input: { ...queued.input, events },
        ...(options.immediate || options.drift ? { notBefore: now() } : {}),
      });
      return queued.id;
    }
    return createRun(app, { kind: "supervise", title: truncate(`监工 · ${task.goal}`, 80), userId: task.userId,
      spaceId: task.spaceId, lane, input: { longTaskId: id, threadId: task.threadId, conversationId: task.threadId,
        itemId: task.itemId, spaces: [task.spaceId], events: [event] },
      notBefore: options.immediate || options.drift ? null : new Date(Date.now() + 5 * minute).toISOString(),
    }).id;
  });
}

export function scheduleSupervisorTimer(app: App, task: LongTask, purpose: "check" | "push" | "summary", at: string) {
  const lane = `${laneOf(task.id)}:${purpose}`;
  if (queuedInLane(app, lane, "wake")) return;
  createRun(app, { kind: "wake", title: purpose === "check" ? "检查长任务的新进展" : "汇总长任务提醒",
    spaceId: task.spaceId, userId: task.userId, lane, notBefore: at,
    input: { supervisorTimer: task.id, purpose, spaces: [task.spaceId] } });
}

// The lane and parent edges both have indexes; never enumerate the installation's run history.
const workers = `with recursive related(id) as (
  select id from runs where lane=?
  union select child.id from related cross join runs child indexed by runs_parent on child.parent_id=related.id
  union select r.id from related cross join runs r indexed by runs_continue_from on json_extract(r.input,'$.continueFrom')=+related.id
), workers as (
  select r.id,r.status,r.kind,
    (r.kind='code' and json_extract(r.input,'$.branches') is null
     or r.kind='agent' and json_extract(r.input,'$.longTaskId') is not null) charged
  from related cross join runs r on r.id=related.id where r.kind in ('agent','code','review')
)`;

export function supervisorUsage(app: App, task: LongTask) {
  // Providers emit cumulative split token counts; use the last such event for each run.
  return all<{ kind: string; tokens: number }>(app.db, workers + `
    select case when r.kind='supervise' then '监工' else '干活的' end kind,
      sum(json_extract(e.data,'$.input') + json_extract(e.data,'$.output')) tokens
    from related cross join runs r on r.id=related.id cross join run_events e on e.run_id=r.id
      and e.seq=(select max(seq) from run_events indexed by progress_tokens where run_id=r.id and type='usage'
        and json_type(data,'$.input')='integer' and json_type(data,'$.output')='integer')
    group by 1`, laneOf(task.id));
}

export function supervisorFacts(app: App, task: LongTask) {
  return one<{ active: number; rounds: number; total: number; done: number; openItems: number; pendingQuestions: number; lastChange: string | null }>(app.db, workers + `
    select (select count(*) from workers where status in ('running','queued')) active,
      (select count(*) from workers where charged) rounds,
      (select count(*) from workers w cross join asks a on a.run_id=w.id
        where a.status='pending' and json_extract(a.context,'$.supervisorTaskId')=?) pendingQuestions,
      count(*) total, count(case when state='done' then 1 end) done,
      count(case when state not in ('done','wontdo','reverted') then 1 end) openItems,
      max(coalesce(max(updated_at),''),coalesce((select max((select at from run_events e where e.run_id=w.id order by seq desc limit 1)) from workers w),''),
        coalesce((select max(created_at) from code_checkpoints where work_id in (select id from workers)),'')) lastChange
    from code_tasks where work_id in (select id from workers)`, laneOf(task.id), task.id)!;
}

export async function checkSupervisorTimer(app: App, id: string, purpose: string) {
  const task = getLongTask(app, id);
  if (purpose === "push") {
    (await import("./supervisor-report.ts")).flushSupervisorPush(app, task);
    return { quiet: true };
  }
  if (stopped(task)) return { quiet: true };
  if (purpose === "summary") {
    const { sendSupervisorSummary } = await import("./supervisor-report.ts");
    sendSupervisorSummary(app, task);
    return { quiet: true };
  }
  const state = supervisorState(app, id);
  const interval = app.config.longTasks.checkMinutes * minute;
  const due = Date.parse(state.lastWake ?? task.createdAt) + interval;
  if (Date.now() >= due) {
    const facts = supervisorFacts(app, task);
    if (facts.active && facts.lastChange && facts.lastChange > (state.lastWake ?? task.createdAt))
      wakeSupervisor(app, id, "定时检查发现新的运行事件、提交或修改项变化", { immediate: true });
  }
  scheduleSupervisorTimer(app, task, "check", new Date(Math.max(due, Date.now() + interval)).toISOString());
  return { quiet: true };
}

function nextDay(app: App) {
  const { date } = zonedParts(Date.now(), app.config.timezone);
  const tomorrow = new Date(Date.parse(date + "T00:00Z") + 86400_000).toISOString().slice(0, 10);
  return +zoneMidnight(tomorrow, app.config.timezone);
}

async function waitForAi(ctx: RunContext, task: LongTask, why: string): Promise<never> {
  const since = Number(getRun(ctx.app, ctx.run.id).output.queueSince ?? Date.now());
  const end = since + ctx.app.config.agents.queueTimeoutMinutes * minute;
  ctx.output({ queueSince: since, queueReason: why });
  if (Date.now() < end) throw new ResumeRunAt(Math.min(end, Date.now() + minute));
  const text = `监工 ${Object.values(task.ai).join(" · ")} 等待超过 ${ctx.app.config.agents.queueTimeoutMinutes} 分钟，本轮停止。原因：${why}。`;
  const { deliverToThread } = await import("./inbox.ts");
  await deliverToThread(ctx.app, task.threadId, text, { runId: ctx.run.id });
  throw new Error(text);
}

async function ensureTopic(app: App, task: LongTask) {
  const thread = getThread(app, task.threadId);
  if (!thread.channel.startsWith("lark") || thread.key?.includes("#") || !thread.parentId) return;
  const anchor = thread.settings.lastMessageId;
  if (anchor) await (await import("./inbox.ts")).deliverToThread(app, task.threadId, `长任务 · ${task.goal}`, { openTopicFrom: anchor });
}

export async function runSupervisor(ctx: RunContext) {
  const { app } = ctx;
  const task = getLongTask(app, String(ctx.run.input.longTaskId));
  if (stopped(task)) return { quiet: true };
  if (!canWrite(app, task.userId, task.spaceId)) throw new HttpError(403, "已失去长任务所在空间的修改权限");
  const state = supervisorState(app, task.id);
  const day = zonedParts(Date.now(), app.config.timezone).date;
  const wakes = state.day === day ? state.wakes ?? 0 : 0;
  if (!ctx.run.output.counted && wakes >= task.budget.dailyWakes) throw new ResumeRunAt(nextDay(app));
  if (ctx.run.output.supervisorReport) return { summary: "本轮报告已保存" };
  const profile = allProfiles(app.config).find(p => p.id === task.ai.profile);
  const selected = profile && { ...profile, ...task.ai };
  const execution: Execution = { ...task.ai, source: "flow", reason: "长任务指定的监工" };
  await ensureTopic(app, task);
  try { validateExecution(app, execution, task.userId, true); }
  catch (error) {
    if (error instanceof HttpError) return waitForAi(ctx, task, error.message);
    throw error;
  }
  const unavailable = !selected || !backendAvailable(selected, app.home) ? "后端不可用" :
    excludedReason(app, selected) ?? downReason(app, selected) ?? (!hasRoom(app, selected) ? "等待模型空位" : null);
  if (unavailable) return waitForAi(ctx, task, unavailable);
  withinTx(app.db, () => {
    patchSupervisorState(app, task.id, { day, wakes: wakes + (ctx.run.output.counted ? 0 : 1), lastWake: now() });
    ctx.output({ counted: true, queueSince: ctx.run.output.queueSince ?? Date.now() });
  });
  const events = ctx.run.input.events as WakeEvent[];
  const prompt = [
    ...events.filter(e => e.drift).map(e => e.note),
    "# 任务书", task.goal, JSON.stringify(task.brief), JSON.stringify(task.budget),
    "# 本人补充", JSON.stringify(task.supplements),
    "# 监工笔记", JSON.stringify(task.notes),
    "# 本轮事件", ...events.filter(e => !e.drift).map(e => e.note),
    `当前状态：${task.status}；上轮阶段：${state.stage ?? "起草任务书"}。`,
  ].join("\n\n");
  const previous = state.session;
  const resume = previous && previous.stage === state.stage && previous.ai.profile === task.ai.profile &&
    previous.ai.model === task.ai.model && previous.ai.effort === task.ai.effort ? previous.id : undefined;
  if (previous && !resume) {
    const { retireRecordedSession } = await import("./session-cleanup.ts");
    await retireRecordedSession(app, previous.id, e => ctx.event(e.type, e));
    patchSupervisorState(app, task.id, { session: null });
  }
  const { runRole, isRetryableAgentError, isBackendDown } = await import("./runner.ts");
  const result = await runRole(app, { role: "supervisor", task: prompt, runId: ctx.run.id, userId: task.userId, spaceId: task.spaceId,
    spaces: [task.spaceId], readScope: [task.spaceId], fullAccess: false, profileId: task.ai.profile, persistSession: true,
    queueUntil: Number(getRun(app, ctx.run.id).output.queueSince) + app.config.agents.queueTimeoutMinutes * minute,
    resumeSessionId: resume, execution, signal: ctx.signal,
    denyTools: task.status === "draft" ? ["delegate_code","message_code_run","continue_code_run","settle_code_task","run_agent"] : [],
    onEvent: e => ctx.event(e.type, e),
  }).catch(async error => {
    const acted = one(app.db, "select 1 from run_events where run_id=? and type='tool-write' limit 1", ctx.run.id);
    if (!acted && (isRetryableAgentError(error) || isBackendDown(error))) return waitForAi(ctx, task, error.message);
    throw error;
  });
  const report = getRun(app, ctx.run.id).output.supervisorReport;
  if (!report) throw new Error("这一轮监工没有提交 supervise_report");
  const stage = supervisorState(app, task.id).stage ?? "";
  const limit = app.config.sessions.background.maxContextTokens;
  const keep = result.sessionId && !stopped(getLongTask(app, task.id)) && (!state.stage || state.stage === stage) && !(limit && (result.contextUsage?.used ?? 0) > limit);
  patchSupervisorState(app, task.id, { session: keep ? { id: result.sessionId!, stage, ai: task.ai } : null });
  if (result.sessionId && !keep) {
    const { retireRecordedSession } = await import("./session-cleanup.ts");
    await retireRecordedSession(app, result.sessionId, event => ctx.event(event.type, event));
  }
  return { ai: result.ai, sessionId: result.sessionId, contextUsage: result.contextUsage };
}
