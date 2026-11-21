import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { canReadRun } from "../auth/permissions.ts";
import { requireItem } from "../items/access.ts";
import { describeStage } from "../flows/definitions.ts";
import { itemFlow, itemStages, waitText } from "../flows/store.ts";
import { findings, isStudy, type Direction, type Trial } from "../studies/store.ts";
import { listCheckpoints, recordedTasks, type TaskState } from "./code-tasks.ts";
import { reviewsOf } from "./review.ts";
import { readBoard } from "./work-board.ts";
import { Forest, rootRun, runForest, visibleRuns, type Node, type Reader, type Usage } from "./progress-runs.ts";

type TaskStatus = "pending" | "queued" | "running" | "submitted" | "accepted" | "redo" | "blocked" | "failed" | "cancelled";
export const states = {
  board: { pending: "queued", running: "running", done: "submitted", accepted: "accepted", rejected: "redo", blocked: "blocked", failed: "failed", cancelled: "cancelled" },
  code: { todo: "pending", coding: "running", verify: "submitted", disputed: "blocked", assistant: "blocked", owner: "blocked", done: "accepted", wontdo: "cancelled", reverted: "redo" } satisfies Record<TaskState, TaskStatus>,
  review: { approved: "accepted", changes_requested: "submitted", failed: "failed" },
  flow: { pending: "pending", gated: "blocked", doing: "running", blocked: "blocked", done: "accepted", skipped: "cancelled", stale: "redo" },
  direction: { proposed: "submitted", confirmed: "queued", active: "running", done: "accepted", dropped: "cancelled" },
  trial: { queued: "queued", running: "running", reported: "submitted", skipped: "cancelled" },
} as const satisfies Record<string, Record<string, TaskStatus>>;

type Output = { kind: "report" | "commit" | "branch" | "finding" | "evidence" | "page"; ref: string; label: string };
type Decision = { by?: string; at?: string; ref?: string; result: string; note?: string };
export type ProgressTask = {
  id: string; title: string; state: TaskStatus; goal?: string; accept?: string; needs?: string[]; waitingOn?: string;
  who?: { agent?: string; model?: string; effort?: string; device?: string };
  attempts: ReturnType<Forest["attempts"]>; usage: Usage; outputs?: Output[]; decision?: Decision; decisions?: Decision[];
  round?: number; parentId?: string;
};
export type ProgressView = {
  kind: "board" | "code" | "review" | "flow" | "study"; id: string; title: string; runId?: string; itemId?: string;
  state: "running" | "waiting" | "done" | "failed" | "cancelled"; waitingOn?: string; tasks: ProgressTask[]; usage: Usage;
  rounds?: { runId: string; round?: number; status: string }[];
  previousRounds?: { round: number; directions: number; trials: number; usage: Usage }[];
};

function task(graph: Forest, ids: (string | null | undefined)[], data: Omit<ProgressTask, "attempts" | "usage">): ProgressTask {
  const attempts = graph.attempts(ids);
  const last = attempts.at(-1);
  const ai = last && graph.nodes.get(last.runId)?.ai;
  const who = ai ? JSON.parse(ai) as { profile: string; model?: string; effort?: string } : undefined;
  return { ...(who && { who: { agent: who.profile, model: who.model, effort: who.effort } }), ...data, attempts, usage: graph.usage(attempts.map(a => a.runId)) };
}
function view(graph: Forest, data: Pick<ProgressView, "kind" | "id" | "title" | "tasks" | "itemId" | "runId">, state?: ProgressView["state"],
  options: { stateTasks?: ProgressTask[]; waitingOn?: string; usage?: Usage } = {}): ProgressView {
  const tasks = options.stateTasks ?? data.tasks;
  const waitingOn = options.waitingOn ?? ([...new Set(tasks.map(t => t.waitingOn).filter(Boolean))].join("；") || undefined);
  const active = tasks.some(t => ["running", "pending", "queued", "redo"].includes(t.state));
  state ??= waitingOn ? "waiting" : active ? "running" : tasks.some(t => t.state === "failed") ? "failed"
    : tasks.some(t => t.state === "blocked" || t.state === "submitted") ? "waiting" : tasks.every(t => t.state === "cancelled") ? "cancelled" : "done";
  return { ...data, state, waitingOn, usage: options.usage ?? graph.usage(tasks.flatMap(t => t.attempts.map(a => a.runId))) };
}

function boardView(app: App, graph: Forest, node: Node, itemId?: string) {
  const visible = new Set(graph.nodes.keys());
  let board: ReturnType<typeof readBoard>;
  try { board = readBoard(app, node.id, visible); } catch (e) {
    if (e instanceof HttpError && e.status === 404) return;
    throw e;
  }
  const tasks = board.tasks.map((t): ProgressTask => {
    const latest = t.attempts.at(-1);
    const attempts = t.attempts.map(a => ({
      runId: a.runId, status: a.status, startedAt: a.startedAt ?? undefined, endedAt: a.finishedAt ?? undefined,
      queuedMs: a.queuedMs, runMs: a.executionMs, usage: graph.usage([a.runId]),
    }));
    return {
      attempts, usage: graph.usage(attempts.map(a => a.runId)),
      who: latest && { agent: latest.ai?.profile, model: latest.ai?.model, effort: latest.ai?.effort, device: latest.device },
      id: t.id, title: t.title, goal: t.goal, accept: t.accept, state: states.board[t.status as keyof typeof states.board],
      outputs: latest && t.report ? [{ kind: "report", ref: latest.runId, label: t.report }] : undefined,
      decision: t.verdict && { by: t.verdict.by, at: t.verdict.at, result: t.verdict.decision, note: t.verdict.note } || undefined,
    };
  });
  const state = { running: "running", review: "waiting", summarized: "done" } as const;
  const block = view(graph, { kind: "board", id: node.id, title: board.title, runId: node.id, itemId, tasks }, state[board.status as keyof typeof state]);
  if (board.status === "review") block.waitingOn = "等协调助手验收";
  return block;
}

const taskWaits: Partial<Record<TaskState, string>> = { owner: "等本人决定", assistant: "等发起助手处理", disputed: "等评审负责人裁决" };
const verdictWaits: Record<string, string> = {
  approved: "等本人确认交付", "awaiting-plan": "等本人确认评审计划", "awaiting-assistant": "等发起助手处理",
  "changes-requested": "等决定要改的问题", "awaiting-peer-code": "等外部编码", "awaiting-peer": "等外部评审"
};

function codeView(app: App, graph: Forest, node: Node, itemId?: string) {
  const checkpoints = listCheckpoints(app, node.id);
  const helpers = [...graph.nodes.values()].filter(r => r.helper && (r.helper === node.id || graph.nodes.get(r.helper)?.first === node.id));
  const tasks = recordedTasks(app, node.id).filter(t => !t.coderRun || graph.nodes.has(t.coderRun)).map(t => {
    const mine = helpers.filter(r => (JSON.parse(r.assigned ?? "[]") as number[]).includes(t.seq));
    const runs = checkpoints.filter(c => c.tasks.includes(t.seq) && !mine.some(r => r.parent === c.by)).map(c => c.by);
    const ids = [...runs, ...mine.map(r => r.id), t.coderRun];
    const outputs: Output[] = Object.entries(t.commits).flatMap(([repo, shas]) => shas.map(ref => ({ kind: "commit", ref, label: repo + " · " + ref })));
    for (const r of mine) for (const w of JSON.parse(r.branches ?? "[]") as { space: string; branch: string }[])
      if (w.branch) outputs.push({ kind: "branch", ref: w.branch, label: w.space + " · " + w.branch });
    const waitingOn = taskWaits[t.state];
    return task(graph, ids, { id: `T${t.seq}`, title: t.title, accept: t.doneWhen, state: states.code[t.state], outputs, waitingOn });
  });
  const rounds = [...graph.nodes.values()].filter(r => r.id === node.id || r.first === node.id);
  const last = rounds.at(-1)!;
  const terminal = last.discarded || node.discarded ? "cancelled" : last.applied || node.applied ? "done"
    : last.status === "failed" || last.status === "cancelled" ? last.status : undefined;
  const waitingOn = terminal ? undefined : node.paused ? "等本人确认继续"
    : verdictWaits[last.verdict ?? ""] ?? (last.status === "queued" ? "排队" : undefined);
  const state = terminal ?? (waitingOn ? "waiting" : tasks.length ? undefined : last.status === "done" ? "done" : "running");
  return {
    ...view(graph, { kind: "code", id: node.id, runId: node.id, itemId, title: node.title, tasks }, state, {
      waitingOn, usage: tasks.length ? undefined : graph.usage(rounds.map(r => r.id)),
    }),
    rounds: rounds.map(r => ({ runId: r.id, status: r.status, round: r.round ?? undefined })),
  };
}

function reviewView(app: App, graph: Forest, node: Node, itemId?: string) {
  const reviews = reviewsOf(app, [node.id]);
  const children = [...graph.nodes.values()].filter(r => r.parent === node.id && r.kind === "review" && !r.splitOnly);
  const checks = new Set<string>([...JSON.parse(node.plan ?? "[]"), ...reviews.map(r => r.check_name)]);
  const tasks = [...checks].map(name => {
    const result = reviews.filter(r => r.check_name === name).at(-1);
    const attempts = children.filter(r => !r.onlyChecks || (JSON.parse(r.onlyChecks) as string[]).includes(name));
    // Embedded checks run in the coding round; standalone re-reviews share their review run.
    const ids = attempts.map(r => r.id);
    if (!ids.length && result) ids.push(node.id);
    const decisions = result?.findings.flatMap(f => {
      const rows: Decision[] = [];
      if (f.state !== "open") rows.push({ ref: String(f.id), by: "评审负责人", result: f.state, note: f.triage_note });
      if (f.decision) rows.push({ ref: String(f.id), result: f.decision, note: f.decision_note });
      return rows;
    });
    const latest = attempts.at(-1);
    const executing = latest && ["running", "queued"].includes(latest.status);
    let state: TaskStatus = result ? states.review[result.verdict as keyof typeof states.review] : "pending";
    if (latest && (executing || latest.status === "failed" || latest.status === "cancelled")) state = latest.status as TaskStatus;
    else if (!result && node.reviewStage === "checks") state = "running";
    return task(graph, ids, {
      id: name, title: name, state,
      who: result?.profile_id || result?.model ? { agent: result.profile_id ?? undefined, model: result.model ?? undefined, effort: result.effort ?? undefined } : undefined,
      outputs: result ? [{ kind: "report", ref: result.id, label: `${result.verdict} · ${result.findings.length} 个问题 · ${result.summary}` },
      ...result.findings.map(f => ({ kind: "finding" as const, ref: String(f.id), label: f.title }))] : undefined,
      decisions, decision: decisions?.at(-1), waitingOn: node.reviewStage === "plan" ? "等本人确认评审计划" : undefined
    });
  });
  if (tasks.length) return view(graph, { kind: "review", id: node.id, runId: node.id, itemId, title: node.title + " · 评审", tasks },
    node.reviewStage === "done" && tasks.every(t => ["accepted", "submitted"].includes(t.state)) ? "done" : undefined);
}

function flowViews(app: App, graph: Forest, id: string, title: string, history: boolean) {
  const f = itemFlow(app, id);
  if (!f) return [];
  const rows = itemStages(app, id);
  const instance = [...graph.nodes.values()].filter(r => r.item === id && r.flowStart === f.startedAt);
  const tasks = f.definition.stages.flatMap(d => {
    const s = rows.find(s => s.id === d.id);
    if (s?.control.runId && !graph.nodes.has(s.control.runId)) return [];
    const ids = instance.filter(r => r.stage === d.id && r.round === f.round).map(r => r.id);
    const wait = s?.state === "gated" ? "等本人确认" : s?.waitingOn ? waitText(s.waitingOn) : undefined;
    const status = s?.state ?? "pending";
    return [task(graph, [...ids, s?.control.runId], {
      id: d.id, title: d.name, goal: d.note, accept: describeStage(d).done, needs: d.needs,
      state: states.flow[status], waitingOn: wait, outputs: s?.evidence.map(ref => ({ kind: "evidence", ref, label: ref }))
    })];
  });
  const visibleStages = new Set(tasks.map(t => t.id));
  for (const t of tasks) t.needs = t.needs?.filter(n => visibleStages.has(n));
  const block = view(graph, { kind: "flow", id: id + "/" + f.startedAt, title: f.definition.name, itemId: id, tasks },
    f.endedAt ? tasks.every(t => ["accepted", "cancelled"].includes(t.state)) ? "done" : "cancelled" : undefined);
  if (f.roundClosedAt && !f.endedAt) { block.state = "waiting"; block.waitingOn = "等下一轮"; }
  if (!isStudy(f)) return [block];
  const roundFilter = history ? "" : " and round=?";
  const params = history ? [id] : [id, f.round];
  const ds = all<Direction>(app.db, "select * from study_directions where item_id=?" + roundFilter + " order by round,created_at", ...params);
  const ts = all<Trial>(app.db, "select * from study_trials where item_id=?" + roundFilter + " order by round,direction_id,seq", ...params)
    .filter(t => !t.run_id || graph.nodes.has(t.run_id));
  const byTrial = new Map<string, Output[]>();
  const trialIds = new Set(ts.map(t => t.id));
  for (const finding of findings(app, id)) for (const ref of JSON.parse(finding.trials) as string[]) {
    if (!trialIds.has(ref)) continue;
    const list = byTrial.get(ref) ?? [];
    list.push({ kind: "finding", ref: finding.id, label: finding.title });
    byTrial.set(ref, list);
  }

  const studyTasks: ProgressTask[] = [];
  for (const d of ds) {
    studyTasks.push(task(graph, [], {
      id: d.id, title: d.goal, goal: d.approach, accept: d.acceptance, round: d.round, state: states.direction[d.state],
      waitingOn: d.state === "proposed" ? "等本人选择方向" : undefined, outputs: d.conclusion ? [{ kind: "report", ref: d.id, label: d.conclusion }] : undefined
    }));
  }
  for (const t of ts) {
    const ids = instance.filter(r => r.trial === t.id).map(r => r.id);
    if (t.run_id) ids.push(t.run_id);
    const evidence = JSON.parse(t.evidence) as string[];
    const outputs: Output[] = evidence.map(ref => ({ kind: "evidence", ref, label: ref }));
    outputs.push(...byTrial.get(t.id) ?? []);
    if (t.result) outputs.push({ kind: "report", ref: t.id, label: t.result + " · " + t.summary });
    const row = task(graph, ids, {
      id: t.id, title: t.object, accept: t.check, parentId: t.direction_id, needs: t.fix_of ? [t.fix_of] : undefined,
      round: t.round, state: states.trial[t.state], outputs
    });
    if (t.peer_run && t.peer) row.who = { ...row.who, device: t.peer };
    studyTasks.push(row);
  }
  const current = studyTasks.filter(t => t.round === f.round);
  const study = view(graph, { kind: "study", id, itemId: id, title, tasks: studyTasks },
    f.endedAt || f.roundClosedAt ? block.state : current.length ? undefined : "running", {
      stateTasks: current,
      usage: graph.usage([...instance.filter(r => r.trial).map(r => r.id), ...studyTasks.flatMap(t => t.attempts.map(a => a.runId))]),
    });
  const counts = all<{ round: number; directions: number; trials: number }>(app.db, `select round,sum(d) directions,sum(t) trials from (
    select round,count(*) d,0 t from study_directions where item_id=? and round<? group by round
    union all select round,0,count(*) from study_trials where item_id=? and round<?
    and (run_id is null or run_id in (select value from json_each(?))) group by round)
    group by round order by round`, id, f.round, id, f.round, JSON.stringify([...graph.nodes.keys()]));
  study.previousRounds = counts.map(c => ({ ...c, usage: graph.usage(instance.filter(r => r.trial && r.round === c.round).map(r => r.id)) }));
  return [block, study];
}

function workViews(app: App, graph: Forest, linkedItem?: string) {
  const ids = JSON.stringify([...graph.nodes.keys()]);
  const candidates = all<{ id: string; board: number; code: number; review: number }>(app.db, `select r.id,
    exists(select 1 from agent_work_tasks where work_id=r.id) board,
    (r.kind='code' and json_extract(input,'$.continueFrom') is null and json_extract(input,'$.branches') is null or exists(select 1 from code_tasks where work_id=r.id)) code,
    (json_extract(output,'$.reviewPlan.checks') is not null or exists(select 1 from reviews where code_run_id=r.id)) review
    from runs r where r.id in (select value from json_each(?)) and (board or code or review) order by created_at desc`, ids);
  const views: ProgressView[] = [];
  for (const c of candidates) {
    const node = graph.nodes.get(c.id)!;
    const item = linkedItem ?? node.item ?? undefined;
    for (const b of [c.board && boardView(app, graph, node, item), c.code && codeView(app, graph, node, item), c.review && reviewView(app, graph, node, item)])
      if (b) views.push(b);
  }
  return views;
}

export function runProgress(app: App, id: string, reader: Reader, history = false) {
  const root = rootRun(app, id, reader);
  if (!root) {
    // Detail access can allow a redacted code run without permission to read its review.
    const base = !reader.spaces && canReadRun(app, reader.user, id) && one(app.db, "select 1 from runs where id=?", id);
    if (base) return [];
    throw new HttpError(404, "运行不存在");
  }
  const graph = runForest(app, [root], reader);
  const views = workViews(app, graph);
  const items = new Set([...graph.nodes.values()].filter(r => r.flowStart && r.item).map(r => r.item!));
  for (const item of items) {
    let row;
    try { row = requireItem(app, item, reader.user, "read"); } catch (e) {
      if (e instanceof HttpError && e.status === 404) continue;
      throw e;
    }
    if (reader.spaces && !reader.spaces.includes(row.spaceId)) continue;
    const f = itemFlow(app, item);
    if (f && [...graph.nodes.values()].some(r => r.item === item && r.flowStart === f.startedAt)) {
      const related = itemForest(app, item, reader);
      views.push(...flowViews(app, related, item, row.title, history));
    }
  }
  return views;
}

function itemForest(app: App, item: string, reader: Reader) {
  const refs = all<{ id: string }>(app.db, `select id from runs where json_extract(input,'$.itemId')=?
    union select id from runs indexed by progress_board_item where json_extract(output,'$.turnContext.item.id')=? and json_extract(output,'$.agentWork.askRunId')=id
    union select r.id from conversations c indexed by progress_thread_item cross join runs r indexed by runs_work_conversation on json_extract(r.output,'$.agentWork.workConversationId')=+c.id
      where json_extract(c.settings,'$.itemId')=? and json_extract(r.output,'$.agentWork.askRunId')=r.id
    union select ref from item_materials where item_id=? and kind='run'
    union select run_id from study_trials where item_id=? and run_id is not null
    union select json_extract(control,'$.runId') from item_stages where item_id=? and json_extract(control,'$.runId') is not null limit 4097`, item, item, item, item, item, item);
  if (refs.length > 4096) throw new HttpError(413, "事项关联运行超过单次进度查询上限");
  return runForest(app, refs.map(r => r.id), reader);
}
export function itemProgress(app: App, id: string, reader: Reader, history = false, limit = 30) {
  const item = requireItem(app, id, reader.user, "read");
  if (reader.spaces && !reader.spaces.includes(item.spaceId)) throw new HttpError(404, "事项不存在");
  const graph = itemForest(app, id, reader);
  const views = [...flowViews(app, graph, id, item.title, history), ...workViews(app, graph, id)];
  const active = (v: ProgressView) => Number(v.state === "waiting" || v.state === "running");
  return views.sort((a, b) => active(b) - active(a)).slice(0, Math.min(100, limit));
}

/** Keep the original board response for existing clients, applying the same attempt visibility. */
export function boardForReader(app: App, id: string, reader: Reader) {
  const visible = visibleRuns(app, reader);
  if (visible.sql === "1") return readBoard(app, id);
  const ids = all<{ id: string }>(app.db, `select r.id from agent_work_tasks t join json_each(t.attempts) a
    join runs r on r.id=json_extract(a.value,'$.runId') where t.work_id=? and ${visible.sql}`, id, ...visible.params);
  return readBoard(app, id, new Set(ids.map(r => r.id)));
}

export function progressText(views: ProgressView[]) {
  const usage = (u: Usage) => `输入 ${u.input} / 输出 ${u.output} token，${u.runs} 次运行，${u.missing} 次缺报`;
  const labels: Record<TaskStatus | ProgressView["state"], string> = {
    pending: "待开始", queued: "排队", running: "进行中", submitted: "待验收", accepted: "已接受", redo: "待重做",
    blocked: "阻塞", failed: "失败", cancelled: "已取消", waiting: "等待", done: "已完成",
  };
  return views.map(b => {
    const lines = b.tasks.slice(0, 50).map(t => {
      const latest = t.attempts.at(-1);
      const attempt = latest && `${t.attempts.length} 次尝试，最近 ${latest.runId}${latest.runMs === undefined ? "" : `（执行 ${Math.round(latest.runMs / 1000)} 秒）`}`;
      return [`- ${t.id} ${t.title}（${labels[t.state]}）`, t.waitingOn, t.who?.model, attempt, t.decision?.result, usage(t.usage)].filter(Boolean).join(" · ");
    });
    if (b.tasks.length > lines.length) lines.push(`另有 ${b.tasks.length - lines.length} 项`);
    return [`${b.title}（${b.kind} · ${labels[b.state]}）`, b.waitingOn, usage(b.usage), ...lines].filter(Boolean).join("\n");
  }).join("\n\n") || "没有可见的进度";
}
