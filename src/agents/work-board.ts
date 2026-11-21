import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, newId, now, truncate } from "../core/util.ts";
import { nodeId } from "../core/peers.ts";
import { addWorkMessage, enqueueCoordination, queueAgentRound, refreshWork, markRound, type AgentWork, type AssistantScope } from "./agent-work.ts";
import { cancelRun, type Run } from "./runs.ts";
import type { Execution } from "./execution.ts";

const active = "('pending','running','rejected')";
type Attempt = { runId: string; status: Run["status"]; queuedAt: string; startedAt: string | null; finishedAt: string | null; result: string | null; device: string };
type Verdict = { by: string; at: string; decision: Decision["decision"]; note: string };
type TaskRow = { id: string; work_id: string; seq: number; title: string; goal: string; accept: string; agent: string | null; execution: string | null; required: number; status: string; attempts: string; report: string; verdict: string | null; run_id: string; scope: string; space_id: string | null; deadline_minutes: number; deadline_at: string; created_at: string; updated_at: string };
export type TaskPlan = { title: string; goal: string; accept: string; agent?: string; execution?: Execution; required?: boolean; deadline_minutes?: number; spaceId?: string; scope: AssistantScope };
export type Decision = { task: string; decision: "accept" | "redo" | "block"; note?: string; execution?: Execution };

function attempt(app: App, workId: string, id: string, plan: TaskPlan, by: string, note?: string) {
  const work = refreshWork(app, workId)!;
  const task = [plan.title, plan.goal, "验收条件：" + plan.accept, note && "退回理由：" + note].filter(Boolean).join("\n\n");
  const runId = queueAgentRound(app, work, { task, taskId: id, agent: plan.agent ?? "assistant", execution: plan.execution, assistantScope: plan.scope, spaceId: plan.spaceId, queuedBy: by });
  const queuedAt = now();
  const entry: Attempt = { runId, status: "queued", queuedAt, startedAt: null, finishedAt: null, result: null, device: nodeId(app) };
  run(app.db, "update agent_work_tasks set run_id=?, attempts=json_insert(attempts,'$[#]',json(?)), deadline_at=?, updated_at=? where id=?",
    runId, JSON.stringify(entry), new Date(Date.parse(queuedAt) + plan.deadline_minutes! * 60000).toISOString(), queuedAt, id);
}

export function dispatchBoard(app: App, work: AgentWork, plans: TaskPlan[], by: string) {
  const workId = work.askRunId;
  const ids = tx(app.db, () => {
    let seq = one<{ n: number }>(app.db, "select coalesce(max(seq),0) n from agent_work_tasks where work_id=?", workId)!.n;
    const ids = plans.map(plan => {
      const id = newId("wt"), at = now();
      const minutes = plan.deadline_minutes ?? app.config.agents.workBoard.deadlineMinutes;
      run(app.db, `insert into agent_work_tasks(id,work_id,seq,title,goal,accept,agent,execution,scope,space_id,required,deadline_minutes,deadline_at,created_at,updated_at)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, workId, ++seq, plan.title, plan.goal, plan.accept, plan.agent ?? null, JSON.stringify(plan.execution ?? null), JSON.stringify(plan.scope), plan.spaceId ?? null, Number(plan.required !== false), minutes, at, at, at);
      attempt(app, workId, id, { ...plan, deadline_minutes: minutes }, by);
      return id;
    });
    return ids;
  });
  app.emit({ type: "work", workId });
  return ids;
}

const reportPageSize = 8000;
/** How long an attempt ran, as a person says it. */
const took = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分钟`;

export function reportPage(answer: string, runId: string, offset = 0) {
  let end = offset + reportPageSize;
  if (end >= answer.length) return answer.slice(offset);
  // Keep both halves of a supplementary character on the same page.
  if (/[\uD800-\uDBFF]/.test(answer[end - 1])) end--;
  return answer.slice(offset, end) + `\n（报告续页：read_run run_id=${runId} offset=${end}）`;
}

type AttemptRow = { task: string; entry: string; ai: string | null; profile_id: string | null; used: number | null; answer: string | null };
function snapshot(app: App, workId: string, full = false, visible?: ReadonlySet<string>) {
  const rows = all<TaskRow>(app.db, "select * from agent_work_tasks where work_id=? order by seq", workId);
  const attempts = all<AttemptRow>(app.db, `select t.id task,a.value entry,r.ai,r.profile_id,
    (select json_extract(data,'$.used') from run_events where run_id=r.id and type='usage' order by seq desc limit 1) used,
    ${full ? `case when r.id=t.run_id and json_extract(a.value,'$.status')='done' then substr(json_extract(r.output,'$.answer'),1,${reportPageSize + 1}) end` : "null"} answer
    from agent_work_tasks t join json_each(t.attempts) a left join runs r on r.id=json_extract(a.value,'$.runId') where t.work_id=? order by t.seq,a.key`, workId);
  return rows.filter(t => !visible || visible.has(t.run_id) && (JSON.parse(t.attempts) as Attempt[]).every(a => visible.has(a.runId))).map(t => {
    const history = attempts.filter(a => a.task === t.id).map(a => {
      const e: Attempt = JSON.parse(a.entry);
      const end = Date.parse(e.finishedAt ?? now());
      const ai = a.ai ? JSON.parse(a.ai) as Run["ai"] : null;
      return { ...e, ai, backend: ai?.profile ?? a.profile_id, model: ai?.model ?? null, used: a.used,
        queuedMs: (e.startedAt ? Date.parse(e.startedAt) : end) - Date.parse(e.queuedAt), executionMs: e.startedAt ? end - Date.parse(e.startedAt) : 0 };
    });
    return { id: t.id, workId, seq: t.seq, title: t.title, goal: t.goal, accept: t.accept, agent: t.agent, required: !!t.required,
      execution: t.execution ? JSON.parse(t.execution) : null, status: t.status, attempts: history, report: t.report,
      verdict: t.verdict ? JSON.parse(t.verdict) as Verdict : null, deadlineAt: t.deadline_at, createdAt: t.created_at, updatedAt: t.updated_at,
      ...(full ? { answer: attempts.find(a => a.task === t.id && a.answer)?.answer } : {}) };
  });
}

export function readBoard(app: App, id: string, visible?: ReadonlySet<string>) {
  const tasks = snapshot(app, id, false, visible);
  if (!tasks.length) throw new HttpError(404, "找不到任务板");
  const work = refreshWork(app, id)!;
  const required = tasks.filter(t => t.required || t.verdict?.decision === "redo");
  const status = required.some(t => ["pending","running","rejected"].includes(t.status)) ? "running"
    : required.some(t => t.status === "done" || t.status === "failed") ? "review" : "summarized";
  return { workId: id, title: work.title, askRunId: id, rootConversationId: work.rootConversationId, workConversationId: work.workConversationId, status, tasks };
}

// Called inside the same write transaction as settlement. Clearing notice consumes this wave once.
function coordinateIfReady(app: App, workId: string) {
  if (one(app.db, `select 1 from agent_work_tasks where work_id=? and (required=1 or json_extract(verdict,'$.decision')='redo') and status in ${active} limit 1`, workId)) return;
  if (!run(app.db, "update agent_work_tasks set notice=0 where work_id=? and notice=1", workId).changes) return;
  const tasks = snapshot(app, workId, true);
  const work = refreshWork(app, workId)!;
  const reports = tasks.map(t => {
    const heading = `# ${t.seq}. ${t.title}（${t.id}，${t.status}）`;
    if (t.status === "accepted" || t.status === "blocked")
      return `${heading}\n已有决定：${t.status === "accepted" ? "接受" : "阻塞"} ${t.verdict?.note ?? ""}`;
    if (t.status === "cancelled") return heading;
    if (t.status !== "done" && t.status !== "failed") return `${heading}\n可选块仍在执行，本轮可先汇总必选结果。`;
    const a = t.attempts.at(-1)!;
    return `${heading}\n本轮验收 ID：${t.id}\n验收条件：${t.accept}\n执行：${t.agent ?? "临时助手"} · ${a.backend ?? "未知后端"} · ${a.ai?.model ?? "未知模型"} · 用时 ${took(a.executionMs)}\n报告（运行 ${a.runId}）：\n${reportPage(t.answer || t.report, a.runId)}`;
  });
  const text = [`任务板 ${workId}。请对标有“本轮验收 ID”的块用 work_review 提交决定。退回重做后结束本轮；其余情况验收完即可向本人汇总，每个论断注明来自哪一块。`, ...reports].join("\n\n");
  const msg = addWorkMessage(app, work, { role: "assistant", text, meta: { command: true, board: workId } });
  enqueueCoordination(app, work, msg, tasks.filter(t => t.attempts.at(-1)?.finishedAt).map(t => t.attempts.at(-1)!.runId), `验收：${work.title}`);
}

function finishAttempt(app: App, t: TaskRow, status: string, report: string, at = now()) {
  run(app.db, `update agent_work_tasks set status=?, report=?, updated_at=?, attempts=json_set(attempts,'$[#-1].status',?,'$[#-1].finishedAt',?,'$[#-1].result',?) where id=?`,
    status, truncate(report, 2000), at, status, at, truncate(report, 2000), t.id);
  const work = refreshWork(app, t.work_id)!;
  markRound(app, work, t.run_id, status === "done" ? "done" : "failed");
}

export function settleBoardRun(app: App, r: Run) {
  const workId = String(r.input.agentWorkId);
  tx(app.db, () => {
    const t = one<TaskRow>(app.db, `select * from agent_work_tasks where run_id=? and status in ${active}`, r.id);
    if (!t) return;
    const late = (r.finishedAt ?? now()) >= t.deadline_at;
    finishAttempt(app, t, late ? "failed" : r.status, late ? "超时" : String(r.error || r.output.answer || (r.status === "cancelled" ? "已取消" : "（没有输出）")), r.finishedAt ?? now());
    coordinateIfReady(app, workId);
  });
  app.emit({ type: "work", workId });
}

export function reviewBoard(app: App, workId: string, decisions: Decision[], by: string) {
  tx(app.db, () => {
    for (const d of decisions) {
      const t = one<TaskRow>(app.db, "select * from agent_work_tasks where work_id=? and id=?", workId, d.task);
      if (!t || !["done","failed","cancelled"].includes(t.status)) throw new HttpError(400, "只能验收本板已结束的块");
      const at = now();
      const verdict: Verdict = { by, at, decision: d.decision, note: d.note ?? "" };
      const status = { redo: "rejected", block: "blocked", accept: "accepted" }[d.decision];
      run(app.db, "update agent_work_tasks set status=?, verdict=?, updated_at=? where id=?", status, JSON.stringify(verdict), at, t.id);
      if (d.decision === "redo") {
        if (JSON.parse(t.attempts).length >= 3) throw new HttpError(400, "每块最多重做 2 次，请接受或标阻塞");
        const execution = d.execution ?? JSON.parse(t.execution ?? "null") ?? undefined;
        run(app.db, "update agent_work_tasks set notice=1, execution=? where id=?", JSON.stringify(execution ?? null), t.id);
        attempt(app, workId, t.id, { ...t, required: !!t.required, agent: t.agent ?? undefined, scope: JSON.parse(t.scope), spaceId: t.space_id ?? undefined, execution }, by, d.note);
      }
    }
  });
  app.emit({ type: "work", workId });
}

export function cancelBoard(app: App, workId: string, task?: string) {
  tx(app.db, () => {
    const rows = all<TaskRow>(app.db, `select * from agent_work_tasks where work_id=? ${task ? "and id=?" : ""}`, workId, ...(task ? [task] : []));
    if (!rows.length) throw new HttpError(404, "找不到任务板或子任务");
    for (const t of rows.filter(t => ["pending","running","rejected"].includes(t.status))) {
      cancelRun(app, t.run_id);
      finishAttempt(app, t, "cancelled", "已取消");
    }
    coordinateIfReady(app, workId);
  });
  app.emit({ type: "work", workId });
}

// Only live tasks are indexed here. Repair the gap between a run settling and the board consuming it.
export function maintainBoards(app: App, restart = false) {
  if (!restart && !one(app.db, `select 1 from agent_work_tasks where status in ${active} and deadline_at<=? limit 1`, now())) return;
  const changed = tx(app.db, () => {
    // Read the current attempt under the write lock: another process may have just retried it.
    const rows = all<TaskRow & { state: string | null; ended: string | null; answer: string | null; error: string | null }>(app.db,
      `select t.*, r.status state,r.finished_at ended,substr(json_extract(r.output,'$.answer'),1,2000) answer,r.error
       from agent_work_tasks t left join runs r on r.id=t.run_id where t.status in ${active}
       ${restart ? "and (r.id is null or r.status!='queued' or t.deadline_at<=?)" : "and t.deadline_at<=? limit 100"}`, now());
    const boards = new Set<string>();
    for (const t of rows) {
      const ended = t.state && ["done","failed","cancelled"].includes(t.state);
      const timeout = (t.ended ?? now()) >= t.deadline_at;
      if (!ended && t.state) {
        cancelRun(app, t.run_id);
        if (restart && t.state === "running") {
          run(app.db, "update runs set status='failed',error='服务重启',finished_at=? where id=?", now(), t.run_id);
        }
      }
      const report = timeout ? "超时" : ended ? t.error || t.answer || "已结束" : "服务重启";
      finishAttempt(app, t, ended && !timeout ? t.state! : "failed", report, t.ended ?? now());
      boards.add(t.work_id);
    }
    for (const id of boards) coordinateIfReady(app, id);
    return boards;
  });
  for (const workId of changed) app.emit({ type: "work", workId });
}
