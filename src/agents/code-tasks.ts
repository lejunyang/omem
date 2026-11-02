import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { fetchBranch, git, resolveRef } from "../core/git.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { getRun, runUser, setRunOutput, type Run } from "./runs.ts";
import type { WorktreeRef } from "./worktree-index.ts";

/**
 * A delegation driven by tasks instead of rounds (docs/v2/coding-loop.md): the work is a list of
 * tasks (T1, T2…), each with what “done” means, its own commits (`Omem-Task: T3` in the message)
 * and its own verification by the check that raised it. Rounds remain as batches: each coding round
 * takes the tasks still to do, and its checkpoint records the work branch afterwards, so any task
 * or any stretch between checkpoints can be looked at, or reverted, on its own.
 *
 * The host keeps the state, the budget and the Git work; splitting, judging and deciding stay with
 * the agents (code-loop.ts runs the reviews and decides what comes next).
 */

/** disputed: the coder objects to a finding its check still insists on; review-lead rules (code-loop.ts). */
export type TaskState = "todo" | "coding" | "verify" | "disputed" | "done" | "owner" | "wontdo" | "reverted";
/** build: split from the request; fix: from a review finding; owner: the owner's words; redo: again after a revert. */
export type TaskKind = "build" | "fix" | "owner" | "redo";
export type TaskNote = { at: string; by: string; text: string; kind: "coder" | "verify" | "owner" | "revert" | "lead" | "host" | "consult" | "assistant" };
export type CodeTask = {
  id: number;
  workId: string;
  seq: number;
  title: string;
  doneWhen: string;
  kind: TaskKind;
  /** blocked: the coder was held up by its environment, which the assistant that started the work sees to first; escalated: it passed it on to the owner. */
  origin: { findings?: number[]; note?: string; redoOf?: number; files?: string[]; blocked?: boolean; escalated?: boolean };
  state: TaskState;
  question: string | null;
  options: string[];
  answer: string | null;
  /** The review check that verifies it (the one that raised its finding); none: the next stage review covers it. */
  verifier: string | null;
  coderRun: string | null;
  attempts: number;
  reverts: number;
  commits: Record<string, string[]>;
  checkpoint: number | null;
  notes: TaskNote[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type Checkpoint = { seq: number; heads: Record<string, string>; tasks: number[]; by: string; label: string; createdAt: string };

export const TASK_STATE_LABEL: Record<TaskState, string> = { todo: "待做", coding: "编码中", verify: "待验证", disputed: "裁决中", done: "已完成", owner: "等你决定", wontdo: "不做", reverted: "已回退" };
/** After this many tries a task the coder and the reviewer cannot settle goes to the owner. */
export const MAX_ATTEMPTS = 3;

/**
 * What the loop keeps on the delegation's first run (`output.work`): the round it may go up to
 * without the owner (`until`) and the size of one budget, pause, the review sessions kept per check,
 * where the last stage review stopped, reverts waiting for the next round, each viewer's last seen
 * checkpoint, and the asks open for owner questions.
 */
export type WorkState = {
  budget: number;
  /** owner: given when delegating (the coder's estimate does not replace it). */
  budgetBy?: "owner" | "coder";
  until: number;
  paused?: string | null;
  sessions?: Record<string, { id: string; used?: number }>;
  stageAt?: number | null;
  stages?: number[];
  reverts?: RevertOp[];
  viewed?: Record<string, number>;
  asks?: Record<string, string>;
  /** A second look at the last stage by other models, beside the next round (code-overlap.ts); cleared when it is done. */
  look?: LookState | null;
  /** The model each check's second look uses in this work, chosen once so its session goes on. */
  lookAI?: Record<string, { profile: string; model?: string; effort?: string }>;
};

/** The stage a second look reads (the reviewed round, its commits) and which checks look again. */
export type LookState = { run: string; round: number; stage: number; since?: Record<string, string>; heads: Record<string, string>; checks: { name: string; focus: string }[] };

/**
 * Something to take back before the next round codes, each as a commit of its own: a task's commits,
 * everything after a checkpoint, one file as it was at a revision, or one hunk of a diff.
 */
export type RevertOp = { reason: string; by: string } & (
  | { seq: number; checkpoint?: undefined; file?: undefined; patch?: undefined }
  | { checkpoint: number; seq?: undefined; file?: undefined; patch?: undefined }
  | { file: { space: string; path: string; rev: string }; seq?: undefined; checkpoint?: undefined; patch?: undefined }
  | { patch: { space: string; text: string }; seq?: undefined; checkpoint?: undefined; file?: undefined }
);

type Row = {
  id: number; work_id: string; seq: number; title: string; done_when: string; kind: TaskKind; origin: string; state: TaskState;
  question: string | null; options: string | null; answer: string | null; verifier: string | null; coder_run: string | null;
  attempts: number; reverts: number; commits: string; checkpoint: number | null; notes: string; created_by: string; created_at: string; updated_at: string;
};
const toTask = (r: Row): CodeTask => ({
  id: r.id, workId: r.work_id, seq: r.seq, title: r.title, doneWhen: r.done_when, kind: r.kind, origin: JSON.parse(r.origin), state: r.state,
  question: r.question, options: r.options ? JSON.parse(r.options) : [], answer: r.answer, verifier: r.verifier, coderRun: r.coder_run,
  attempts: r.attempts, reverts: r.reverts, commits: JSON.parse(r.commits), checkpoint: r.checkpoint, notes: JSON.parse(r.notes),
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

// ---- the work a run belongs to -------------------------------------------------------------------

/** The first run of the delegation a code or review run belongs to. */
export function workRootOf(app: App, runId: string): string {
  const r = getRun(app, runId);
  if (r.kind === "review" && typeof r.input.codeRunId === "string") return workRootOf(app, r.input.codeRunId);
  return String(r.input.continueFrom ?? r.id);
}

/** Whether a delegation is driven by tasks (set when it was started; older ones keep rounds). */
export function isTaskWork(app: App, runId: string): boolean {
  const id = one<{ id: string }>(app.db, "select id from runs where id = ?", runId)?.id;
  if (!id) return false;
  return !!getRun(app, workRootOf(app, id)).input.taskMode;
}

export const taskLabel = (seq: number) => `T${seq}`;
/** “T3”, “t3”, “3” or 3. */
export function parseTaskRef(ref: string | number): number {
  const n = typeof ref === "number" ? ref : Number(/^\s*[Tt]?(\d+)\s*$/.exec(ref)?.[1]);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `修改项编号写成 T1、T2 这样：${ref}`);
  return n;
}

export function workState(app: App, rootId: string): WorkState {
  const root = getRun(app, rootId);
  const w = root.output.work as WorkState | undefined;
  if (w) return w;
  const given = Number(root.input.maxRounds) || null;
  const budget = clampBudget(app, given);
  return { budget, until: budget, ...(given ? { budgetBy: "owner" as const } : {}) };
}
export function setWorkState(app: App, rootId: string, patch: Partial<WorkState>): WorkState {
  const next = { ...workState(app, rootId), ...patch };
  setRunOutput(app, rootId, { work: next });
  return next;
}

/** A budget in rounds: what was asked for, else what the coder estimated, never more than the cap. */
export function clampBudget(app: App, rounds: number | undefined | null) {
  const cap = app.config.agents.autoAdvance.codeRoundsMax;
  const n = rounds && Number.isFinite(rounds) ? Math.round(rounds) : app.config.agents.autoAdvance.codeRounds;
  return Math.max(1, Math.min(cap, n));
}

/** The coder's estimate of how many rounds the work takes, unless the owner gave a budget. */
export function estimateBudget(app: App, rootId: string, rounds: number) {
  const w = workState(app, rootId);
  if (w.budgetBy === "owner") return w;
  const budget = clampBudget(app, rounds);
  return setWorkState(app, rootId, { budget, budgetBy: "coder", until: Math.max(budget, 1) });
}

/** The owner acted (answered, added a task, said go on): from the current round there is a whole budget again. */
export function renewBudget(app: App, rootId: string, round: number) {
  const w = workState(app, rootId);
  return setWorkState(app, rootId, { until: Math.max(w.until, round + w.budget), paused: null });
}

// ---- tasks ----------------------------------------------------------------------------------------

export function listTasks(app: App, rootId: string): CodeTask[] {
  return all<Row>(app.db, "select * from code_tasks where work_id = ? order by seq", rootId).map(toTask);
}
export function getTask(app: App, rootId: string, seq: number): CodeTask {
  const r = one<Row>(app.db, "select * from code_tasks where work_id = ? and seq = ?", rootId, seq);
  if (!r) throw new HttpError(404, `这次交办没有修改项 ${taskLabel(seq)}`);
  return toTask(r);
}

export type NewTask = { title: string; doneWhen?: string; kind: TaskKind; origin?: CodeTask["origin"]; state?: TaskState; question?: string; options?: string[]; verifier?: string | null };
export function addTask(app: App, rootId: string, t: NewTask, by: string): CodeTask {
  const seq = (one<{ n: number | null }>(app.db, "select max(seq) as n from code_tasks where work_id = ?", rootId)?.n ?? 0) + 1;
  const at = now();
  run(app.db, "insert into code_tasks(work_id, seq, title, done_when, kind, origin, state, question, options, verifier, created_by, created_at, updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    rootId, seq, truncate(t.title.trim(), 200), (t.doneWhen ?? "").trim(), t.kind, JSON.stringify(t.origin ?? {}), t.state ?? "todo", t.question ?? null, t.options?.length ? JSON.stringify(t.options) : null, t.verifier ?? null, by, at, at);
  app.emit({ type: "changed", entity: "code-task", id: rootId });
  return getTask(app, rootId, seq);
}

export type TaskPatch = Partial<Pick<CodeTask, "title" | "doneWhen" | "origin" | "state" | "question" | "options" | "answer" | "verifier" | "coderRun" | "attempts" | "reverts" | "commits" | "checkpoint">>;
export function updateTask(app: App, rootId: string, seq: number, patch: TaskPatch, note?: Omit<TaskNote, "at">): CodeTask {
  const t = getTask(app, rootId, seq);
  const next = { ...t, ...patch };
  const notes = note ? [...t.notes, { at: now(), ...note }] : t.notes;
  run(app.db, "update code_tasks set title=?, done_when=?, origin=?, state=?, question=?, options=?, answer=?, verifier=?, coder_run=?, attempts=?, reverts=?, commits=?, checkpoint=?, notes=?, updated_at=? where id=?",
    next.title, next.doneWhen, JSON.stringify(next.origin), next.state, next.question, next.options.length ? JSON.stringify(next.options) : null, next.answer, next.verifier, next.coderRun, next.attempts, next.reverts, JSON.stringify(next.commits), next.checkpoint, JSON.stringify(notes), now(), t.id);
  app.emit({ type: "changed", entity: "code-task", id: rootId });
  return getTask(app, rootId, seq);
}

/**
 * A task that did not come out right goes back to be done again; after MAX_ATTEMPTS it goes to the
 * owner (the coder and the reviewer cannot settle it), the rest of the work goes on.
 */
export function retryTask(app: App, rootId: string, seq: number, note: Omit<TaskNote, "at">): CodeTask {
  const t = getTask(app, rootId, seq);
  const attempts = t.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    return updateTask(app, rootId, seq, {
      attempts,
      state: "owner",
      question: `改了 ${attempts} 次，验证还是没通过（每次的意见在下面“之前的情况”里）。要怎么改，还是不做？`,
      options: ["按评审的意见再试一次", "改成你说的做法", "不做这一项"],
    }, note);
  }
  return updateTask(app, rootId, seq, { attempts, state: "todo" }, note);
}

const NOT_REACHED = "轮编码 Agent 停下时还没做这一项";

/**
 * A round ended before its coder got to a task (no commit, no finish_task or report_task): not a try
 * that failed, so it waits for the next round as it was. A task left alone round after round is
 * stuck on something nobody said: it goes to whoever started the work, like one held up (blocked).
 */
export function notReached(app: App, rootId: string, seq: number, round: number): CodeTask {
  const t = getTask(app, rootId, seq);
  const note = { by: "host", kind: "host" as const, text: `第 ${round} ${NOT_REACHED}` };
  let times = 1;
  for (const n of [...t.notes].reverse()) {
    if (n.kind === "host" && n.text.endsWith(NOT_REACHED)) times++;
    else if (n.kind !== "host") break;
  }
  if (times < MAX_ATTEMPTS) return updateTask(app, rootId, seq, { state: "todo" }, note);
  return updateTask(app, rootId, seq, {
    state: "owner",
    question: `编码 Agent 连续 ${times} 轮都没做到这一项：它在做别的项，或者每轮停下前没轮到它，也没有用 report_task 说明为什么。可能是这一项太大、说得不清楚，或者依赖别的项。`,
    options: ["说清楚了，再做一次"],
    origin: { ...t.origin, blocked: true, escalated: undefined },
  }, note);
}

/** A finding taken up as a task: its check verifies it, the finding remembers the task. */
export function taskForFinding(app: App, rootId: string, f: { id: number; title: string; suggestion: string; owner_suggestion?: string | null; check_name: string; file_path: string | null }, by: string, owner?: { question: string; options: string[] }): CodeTask {
  const existing = one<{ task_id: number | null }>(app.db, "select task_id from review_findings where id = ?", f.id)?.task_id;
  if (existing) {
    const t = one<Row>(app.db, "select * from code_tasks where id = ?", existing);
    if (t && t.work_id === rootId) return toTask(t);
  }
  const t = addTask(app, rootId, {
    title: f.title,
    doneWhen: f.owner_suggestion?.trim() || f.suggestion,
    kind: "fix",
    origin: { findings: [f.id], ...(f.file_path ? { files: [f.file_path] } : {}) },
    verifier: f.check_name,
    ...(owner ? { state: "owner", question: owner.question, options: owner.options } : {}),
  }, by);
  run(app.db, "update review_findings set task_id = ?, decision = coalesce(decision, 'fix') where id = ?", t.id, f.id);
  return t;
}

/** States a later finding can still join: the task is not settled yet. */
export const JOINABLE: TaskState[] = ["todo", "coding", "verify", "disputed", "owner"];

/**
 * A finding that restates a task the work already has (review-lead merged it there): the task
 * gains it, no second task asks the same. A settled task does not: a problem still there after
 * it is a new task.
 */
export function joinTask(app: App, rootId: string, findingId: number, seq: number): CodeTask {
  const t = getTask(app, rootId, seq);
  if (!JOINABLE.includes(t.state)) throw new HttpError(400, `${taskLabel(seq)} 现在是“${TASK_STATE_LABEL[t.state]}”，不能再并进去；问题还在就接受为新的一项，在 note 里写是哪一项没改好`);
  const findings = [...new Set([...(t.origin.findings ?? []), findingId])];
  run(app.db, "update code_tasks set origin = ?, updated_at = ? where id = ?", JSON.stringify({ ...t.origin, findings }), now(), t.id);
  run(app.db, "update review_findings set task_id = ?, decision = coalesce(decision, 'fix') where id = ?", t.id, findingId);
  app.emit({ type: "changed", entity: "code-task", id: rootId });
  return getTask(app, rootId, seq);
}

/** The work's tasks as checks and review-lead read them: label, state, title. */
export const taskList = (app: App, rootId: string) => listTasks(app, rootId).map((t) => `- ${taskLabel(t.seq)} [${TASK_STATE_LABEL[t.state]}] ${t.title}`).join("\n");

// ---- commits and checkpoints ---------------------------------------------------------------------

/** Where a worktree's Git commands run now: the worktree while it exists, else the repository. */
export function gitDirOf(app: App, wt: WorktreeRef): string | null {
  if (existsSync(wt.path)) return wt.path;
  const root = one<{ root_path: string | null }>(app.db, "select root_path from spaces where id = ?", wt.space)?.root_path;
  return root ?? null;
}

/** Commits from..to and the tasks their messages name (`Omem-Task: T3`, several allowed); `revert`: the host's revert of a task. */
export function commitsByTask(dir: string, from: string, to = "HEAD"): { sha: string; tasks: number[]; subject: string; revert: boolean }[] {
  const log = git(dir, ["log", "--reverse", "--format=%H%x1f%s%x1f%B%x1e", `${from}..${to}`]);
  if (!log.ok) return [];
  return log.stdout.split("\x1e").map((x) => x.trim()).filter(Boolean).map((entry) => {
    const [sha, subject, body] = entry.split("\x1f");
    const tasks = [...(body ?? "").matchAll(/^Omem-Task:\s*(.+)$/gim)].flatMap((m) => [...m[1].matchAll(/[Tt]?(\d+)/g)].map((x) => Number(x[1])));
    return { sha, subject, tasks: [...new Set(tasks)], revert: /^Omem-Revert:/im.test(body ?? "") };
  });
}

export function listCheckpoints(app: App, rootId: string): Checkpoint[] {
  return all<{ seq: number; heads: string; tasks: string; by: string; label: string; created_at: string }>(app.db, "select * from code_checkpoints where work_id = ? order by seq", rootId)
    .map((r) => ({ seq: r.seq, heads: JSON.parse(r.heads), tasks: JSON.parse(r.tasks), by: r.by, label: r.label, createdAt: r.created_at }));
}

/** The commit each repository of the work starts from (checkpoint 0). */
export function startHeads(worktrees: WorktreeRef[]): Record<string, string> {
  return Object.fromEntries(worktrees.map((w) => [w.space, w.start ?? w.base]));
}

/**
 * Where the work branch is now, as a numbered checkpoint. A ref under refs/omem keeps its commits
 * alive whatever happens to the branch later (squash, rebase, revert).
 */
export function recordCheckpoint(app: App, rootId: string, worktrees: WorktreeRef[], by: string, tasks: number[], label: string): Checkpoint | null {
  const heads: Record<string, string> = {};
  for (const wt of worktrees) {
    const dir = gitDirOf(app, wt);
    const h = dir ? git(dir, ["rev-parse", "HEAD"]).stdout.trim() : "";
    if (h) heads[wt.space] = h;
  }
  if (!Object.keys(heads).length) return null;
  const last = listCheckpoints(app, rootId).at(-1);
  if (last && JSON.stringify(last.heads) === JSON.stringify(heads)) return last;
  const seq = (last?.seq ?? 0) + 1;
  run(app.db, "insert into code_checkpoints(work_id, seq, heads, tasks, by, label, created_at) values(?,?,?,?,?,?,?)", rootId, seq, JSON.stringify(heads), JSON.stringify(tasks), by, label, now());
  for (const wt of worktrees) {
    const dir = gitDirOf(app, wt);
    if (dir && heads[wt.space]) git(dir, ["update-ref", `refs/omem/${rootId}/cp${seq}`, heads[wt.space]]);
  }
  return listCheckpoints(app, rootId).at(-1)!;
}

/**
 * Before a round codes: what changed on the work branch since the last checkpoint without a round
 * doing it — the owner's edits left in the worktree (committed as theirs, `Omem-By: owner`), commits
 * made on the branch elsewhere, what came in from origin — becomes a checkpoint of its own. It is
 * never counted as a task's change, and the coder is told to keep it. Uncommitted changes after a
 * round that failed are that round's unfinished work and stay as they are.
 */
export function recordOutsideChanges(app: App, rootId: string, runId: string, worktrees: WorktreeRef[], identity: (dir: string) => string[], opts: { previousEnded: boolean; round: number }): { checkpoint: Checkpoint; files: string[]; owner: boolean } | null {
  const last = listCheckpoints(app, rootId).at(-1);
  if (!last) return null;
  let owner = false;
  if (opts.previousEnded) for (const wt of worktrees) {
    if (!existsSync(wt.path) || !git(wt.path, ["status", "--porcelain"]).stdout.trim()) continue;
    git(wt.path, ["add", "-A"]);
    if (git(wt.path, [...identity(wt.path), "commit", "-q", "--no-verify", "-m", `本人的修改（第 ${opts.round} 轮开始前在工作区里改的）\n\nOmem-By: owner`]).ok) owner = true;
  }
  const files: string[] = [];
  let moved = false;
  for (const wt of worktrees) {
    const at = last.heads[wt.space];
    const now = git(wt.path, ["rev-parse", "HEAD"]).stdout.trim();
    if (!at || !now || at === now) continue;
    moved = true;
    for (const f of git(wt.path, ["diff", "--name-only", at, now]).stdout.split("\n").filter(Boolean)) files.push(worktrees.length > 1 ? `${wt.space}/${f}` : f);
  }
  if (!moved) return null;
  const cp = recordCheckpoint(app, rootId, worktrees, owner ? "owner" : "branch", [], owner ? `本人的修改（第 ${opts.round} 轮开始前）` : `分支上的其他提交（第 ${opts.round} 轮开始前）`);
  return cp ? { checkpoint: cp, files, owner } : null;
}

/** The heads a checkpoint number stands for: 0 is where the work started. */
export function headsAt(app: App, rootId: string, worktrees: WorktreeRef[], seq: number | null | undefined): Record<string, string> {
  if (!seq) return startHeads(worktrees);
  const cp = listCheckpoints(app, rootId).find((c) => c.seq === seq);
  if (!cp) throw new HttpError(404, `没有检查点 ${seq}`);
  return { ...startHeads(worktrees), ...cp.heads };
}

/**
 * After a coding round: its commits go to the tasks they name (a round of one task takes them all),
 * then the round's tasks settle — finished ones to verification (or done, when the next stage review
 * covers them), untouched ones back to do with one more attempt — and a checkpoint is recorded.
 */
export function settleCodingRound(app: App, rootId: string, runId: string, worktrees: WorktreeRef[], round: number, helpers: string[] = []) {
  const before = listCheckpoints(app, rootId).at(-1);
  // The round's own tasks and its helpers' (code-helpers.ts).
  const coders = new Set([runId, ...helpers]);
  const roundTasks = listTasks(app, rootId).filter((t) => t.coderRun && coders.has(t.coderRun));
  const touched = new Set<number>();
  for (const wt of worktrees) {
    const dir = gitDirOf(app, wt);
    if (!dir) continue;
    const from = before?.heads[wt.space] ?? wt.start ?? wt.base;
    for (const c of commitsByTask(dir, from)) {
      if (c.revert) continue;
      const named = c.tasks.length ? c.tasks : roundTasks.length === 1 ? [roundTasks[0].seq] : [];
      for (const seq of named) {
        const t = one<Row>(app.db, "select * from code_tasks where work_id = ? and seq = ?", rootId, seq);
        if (!t) continue;
        const task = toTask(t);
        const list = task.commits[wt.space] ?? [];
        if (!list.includes(c.sha)) updateTask(app, rootId, seq, { commits: { ...task.commits, [wt.space]: [...list, c.sha] } });
        touched.add(seq);
      }
    }
  }
  for (const t of roundTasks) {
    const task = getTask(app, rootId, t.seq);
    if (task.state === "coding") {
      if (touched.has(t.seq)) updateTask(app, rootId, t.seq, { state: task.verifier ? "verify" : "done" }, { by: "host", kind: "host", text: "有这一项的提交，但编码 Agent 没有用 finish_task 说明" });
      else notReached(app, rootId, t.seq, round);
    }
  }
  const finished = listTasks(app, rootId).filter((t) => t.coderRun && coders.has(t.coderRun) && ["verify", "done"].includes(t.state)).map((t) => t.seq);
  const cp = recordCheckpoint(app, rootId, worktrees, runId, finished, `第 ${round} 轮${finished.length ? `：${finished.map(taskLabel).join("、")}` : ""}`);
  if (cp) for (const seq of finished) if (getTask(app, rootId, seq).checkpoint === null) updateTask(app, rootId, seq, { checkpoint: cp.seq });
  return { checkpoint: cp, finished };
}

/**
 * A task the coder finished without committing (it forgot, or its sandbox cannot write the
 * repository's Git metadata): what is uncommitted in each worktree becomes this task's commit.
 * Returns the repositories committed in.
 */
export function commitTask(app: App, rootId: string, seq: number, worktrees: WorktreeRef[], identity: (dir: string) => string[]): string[] {
  const t = getTask(app, rootId, seq);
  const made: string[] = [];
  for (const wt of worktrees) {
    if (!existsSync(wt.path)) continue;
    if (!git(wt.path, ["status", "--porcelain"]).stdout.trim()) continue;
    git(wt.path, ["add", "-A"]);
    const c = git(wt.path, [...identity(wt.path), "commit", "-q", "--no-verify", "-m", `${truncate(t.title, 72)}\n\nOmem-Task: ${taskLabel(seq)}`]);
    if (c.ok) made.push(wt.space);
  }
  return made;
}

/**
 * The commits on the work branch since the last checkpoint that name `seq`, on the task now (the
 * round settles the rest at its end): its check verifies it while the round goes on (code-overlap.ts).
 */
export function attributeCommits(app: App, rootId: string, worktrees: WorktreeRef[], seq: number) {
  const before = listCheckpoints(app, rootId).at(-1);
  for (const wt of worktrees) {
    const dir = gitDirOf(app, wt);
    if (!dir) continue;
    const t = getTask(app, rootId, seq);
    const list = t.commits[wt.space] ?? [];
    const mine = commitsByTask(dir, before?.heads[wt.space] ?? wt.start ?? wt.base).filter((c) => !c.revert && c.tasks.includes(seq) && !list.includes(c.sha)).map((c) => c.sha);
    if (mine.length) updateTask(app, rootId, seq, { commits: { ...t.commits, [wt.space]: [...list, ...mine] } });
  }
}

// ---- diffs ----------------------------------------------------------------------------------------

/** `from` / `to`: the revisions the patch goes between (“恢复成改动前” restores a file to `from`; VS Code shows both sides). */
/** `at`: a checkout whose HEAD is `to` (an editor shows its files as the new side); none when the branch is not checked out. */
export type Patch = { space: string; patch: string; label?: string; from?: string; to?: string; at?: string };

/** The work's own worktree or any other of the repository where `tip` is what is checked out. */
function checkoutAt(dir: string, wt: WorktreeRef, tip: string): string | undefined {
  const list = git(dir, ["worktree", "list", "--porcelain"]).stdout.split(/\n\s*\n/).map((block) => ({ path: /^worktree (.+)$/m.exec(block)?.[1], head: /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] }));
  const at = list.filter((w) => w.path && w.head === tip);
  return (at.find((w) => w.path === wt.path) ?? at[0])?.path;
}

/** One task's change: its commits (one diff when they follow each other, else one per commit). */
function taskPatch(dir: string, shas: string[]): string {
  if (!shas.length) return "";
  const first = shas[0];
  const last = shas.at(-1)!;
  const span = git(dir, ["rev-list", "--count", `${first}^..${last}`]);
  if (span.ok && Number(span.stdout.trim()) === shas.length) return git(dir, ["diff", "--no-color", `${first}^`, last]).stdout;
  return shas.map((s) => git(dir, ["show", "--no-color", "--format=", s]).stdout).join("\n");
}

/**
 * The change a viewer asked for: some tasks, the stretch between two checkpoints, or everything
 * after the checkpoint they last looked at (`since: "viewed"`). Checkpoint 0 is the start.
 * `base`: the whole branch against another one (`origin/main`, fetched first), from where they part:
 * for reviewing everything the branch will bring, not only this work's rounds.
 */
export function workPatches(app: App, rootId: string, worktrees: WorktreeRef[], sel: { tasks?: number[]; from?: number; to?: number; since?: "viewed"; base?: string; userId?: string }): Patch[] {
  const out: Patch[] = [];
  if (sel.base) {
    const lastHeads = headsAt(app, rootId, worktrees, listCheckpoints(app, rootId).at(-1)?.seq ?? 0);
    for (const wt of worktrees) {
      const dir = gitDirOf(app, wt);
      if (!dir) continue;
      if (sel.base.startsWith("origin/")) fetchBranch(dir, sel.base, 60_000);
      const base = resolveRef(dir, sel.base);
      if (!base) throw new HttpError(400, `${wt.space} 里没有分支 ${sel.base}`);
      const own = wt.branch ? git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}^{commit}`]).stdout.trim() : "";
      const tip = own || lastHeads[wt.space];
      const from = tip ? git(dir, ["merge-base", base.commit, tip]).stdout.trim() : "";
      if (!from) throw new HttpError(400, `${wt.space} 的工作分支和 ${sel.base} 没有共同的提交`);
      const patch = git(dir, ["diff", "--no-color", from, tip]).stdout;
      if (patch.trim()) out.push({ space: wt.space, patch, from, to: tip, at: checkoutAt(dir, wt, tip) });
    }
    return out;
  }
  if (sel.tasks?.length) {
    for (const seq of sel.tasks) {
      const t = getTask(app, rootId, seq);
      for (const wt of worktrees) {
        const dir = gitDirOf(app, wt);
        const shas = t.commits[wt.space] ?? [];
        const patch = dir ? taskPatch(dir, shas) : "";
        const from = dir && shas.length ? git(dir, ["rev-parse", `${shas[0]}^`]).stdout.trim() : "";
        if (patch.trim()) out.push({ space: wt.space, patch, label: `${taskLabel(seq)} ${t.title}`, ...(from ? { from, to: shas.at(-1)! } : {}) });
      }
    }
    return out;
  }
  const last = listCheckpoints(app, rootId).at(-1)?.seq ?? 0;
  const from = sel.since === "viewed" ? workState(app, rootId).viewed?.[sel.userId ?? OWNER] ?? 0 : sel.from ?? 0;
  const to = sel.to ?? last;
  const a = headsAt(app, rootId, worktrees, from);
  const b = headsAt(app, rootId, worktrees, to);
  for (const wt of worktrees) {
    const dir = gitDirOf(app, wt);
    if (!dir || !a[wt.space] || !b[wt.space] || a[wt.space] === b[wt.space]) continue;
    const patch = git(dir, ["diff", "--no-color", a[wt.space], b[wt.space]]).stdout;
    if (patch.trim()) out.push({ space: wt.space, patch, from: a[wt.space], to: b[wt.space] });
  }
  return out;
}

/**
 * A file as it was at a commit of one of the work's repositories (VS Code shows both sides of a task's
 * change from these). Missing at that commit: null.
 */
export function fileAt(app: App, worktrees: WorktreeRef[], space: string, path: string, rev: string): Buffer | null {
  const wt = worktrees.find((w) => w.space === space);
  const dir = wt && gitDirOf(app, wt);
  if (!dir) throw new HttpError(404, `这次交办没有改 ${space}`);
  if (!/^[0-9a-f]{7,64}$/.test(rev) || git(dir, ["cat-file", "-t", rev]).stdout.trim() !== "commit") throw new HttpError(400, `${rev} 不是这个仓库里的提交`);
  if (path.split("/").includes("..") || path.startsWith("/")) throw new HttpError(400, "文件路径不对");
  const shown = spawnSync("git", ["show", `${rev}:${path}`], { cwd: dir, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return shown.status === 0 ? shown.stdout : null;
}

// ---- reverts --------------------------------------------------------------------------------------

/**
 * A task to revert before the next round codes: automatically when its verification found it broke
 * something (once per task), or on the owner's word. The task goes back to do, with the reason.
 */
export function scheduleRevert(app: App, rootId: string, seq: number, reason: string, by: string, opts: { redo?: boolean } = {}) {
  const t = getTask(app, rootId, seq);
  if (!Object.values(t.commits).some((l) => l.length)) throw new HttpError(409, `${taskLabel(seq)} 还没有提交，没有可回退的`);
  const w = workState(app, rootId);
  if ((w.reverts ?? []).some((r) => r.seq === seq)) return t;
  setWorkState(app, rootId, { reverts: [...(w.reverts ?? []), { seq, reason, by } as RevertOp] });
  const redo = opts.redo ?? true;
  return updateTask(app, rootId, seq, { state: redo ? "todo" : "reverted" }, { by, kind: "revert", text: `${redo ? "回退后重做" : "回退"}：${reason}` });
}

/**
 * The owner takes back a stretch, a file or a hunk (the next round does it first, docs/v2/coding-loop.md §5).
 * Checked now so a mistake is refused at once: the checkpoint exists, the revision is a commit of
 * the repository, the patch is a Git diff of one of the work's repositories.
 */
export function scheduleWorkRevert(app: App, rootId: string, worktrees: WorktreeRef[], op: Omit<RevertOp, "by" | "reason"> & { reason?: string }, by: string) {
  const reason = op.reason?.trim() || "本人要求回退";
  let entry: RevertOp;
  if (op.checkpoint !== undefined) {
    if (!listCheckpoints(app, rootId).some((c) => c.seq === op.checkpoint) && op.checkpoint !== 0) throw new HttpError(404, `没有检查点 ${op.checkpoint}`);
    entry = { checkpoint: op.checkpoint, reason, by };
  } else if (op.file) {
    const wt = worktrees.find((w) => w.space === op.file!.space);
    const dir = wt && gitDirOf(app, wt);
    if (!dir) throw new HttpError(404, `这次交办没有改 ${op.file.space}`);
    if (!/^[0-9a-f]{7,64}$/.test(op.file.rev) || git(dir, ["cat-file", "-t", op.file.rev]).stdout.trim() !== "commit") throw new HttpError(400, `${op.file.rev} 不是这个仓库里的提交`);
    if (op.file.path.split("/").includes("..") || op.file.path.startsWith("/")) throw new HttpError(400, "文件路径不对");
    entry = { file: op.file, reason, by };
  } else if (op.patch) {
    if (!worktrees.some((w) => w.space === op.patch!.space)) throw new HttpError(404, `这次交办没有改 ${op.patch.space}`);
    if (!/^diff --git /.test(op.patch.text) || !/^@@ /m.test(op.patch.text)) throw new HttpError(400, "要回退的不是一段 Git 改动");
    entry = { patch: op.patch, reason, by };
  } else throw new HttpError(400, "要回退什么：检查点、文件或一段改动");
  const w = workState(app, rootId);
  return setWorkState(app, rootId, { reverts: [...(w.reverts ?? []), entry] });
}

/** How a pending revert reads to people (the run page, the coder). */
export function revertLabel(r: RevertOp) {
  if (r.seq !== undefined) return `回退 ${taskLabel(r.seq)}`;
  if (r.checkpoint !== undefined) return r.checkpoint ? `回到检查点 ${r.checkpoint}` : "回到开始的样子";
  if (r.file) return `把 ${r.file.path} 恢复成 ${r.file.rev.slice(0, 8)} 时的样子`;
  return `回退 ${/^diff --git a\/(\S+)/.exec(r.patch!.text)?.[1] ?? "一段改动"} 里的一段`;
}

/**
 * Whether a task's change can be taken back alone: no later commit of the work touches its files.
 * Otherwise reverting it would take later work with it, so the fix goes forward instead.
 */
export function revertsCleanly(app: App, rootId: string, worktrees: WorktreeRef[], seq: number): boolean {
  const t = getTask(app, rootId, seq);
  for (const wt of worktrees) {
    const shas = t.commits[wt.space] ?? [];
    if (!shas.length) continue;
    const dir = gitDirOf(app, wt);
    if (!dir) return false;
    const files = new Set(shas.flatMap((s) => git(dir, ["show", "--name-only", "--format=", s]).stdout.split("\n").filter(Boolean)));
    const later = git(dir, ["log", "--name-only", "--format=", `${shas.at(-1)}..HEAD`]).stdout.split("\n").filter(Boolean);
    if (later.some((f) => files.has(f))) return false;
  }
  return true;
}

/**
 * Before the coder starts: revert the scheduled tasks' commits in the worktrees, one commit per task
 * (`Omem-Revert: T3`). One that does not apply cleanly is left alone and goes forward as a fix.
 */
export function applyReverts(app: App, rootId: string, worktrees: WorktreeRef[], log: (text: string) => void, identity: (dir: string) => string[]) {
  const w = workState(app, rootId);
  const pending = w.reverts ?? [];
  if (!pending.length) return [];
  const done: string[] = [];
  const commit = (dir: string, message: string) => git(dir, [...identity(dir), "commit", "-q", "--no-verify", "-m", message]).ok;
  for (const r of pending) {
    if (r.seq === undefined) {
      const ok = applyOtherRevert(app, rootId, worktrees, r, commit);
      log(ok ? `已${revertLabel(r)}` : `没能${revertLabel(r)}，改成一个修改项交给编码 Agent`);
      if (ok) done.push(revertLabel(r));
      continue;
    }
    const t = getTask(app, rootId, r.seq);
    let ok = true;
    const made: { dir: string; head: string }[] = [];
    for (const wt of worktrees) {
      const shas = t.commits[wt.space] ?? [];
      if (!shas.length) continue;
      const dir = wt.path;
      const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
      const rev = git(dir, ["revert", "--no-commit", ...[...shas].reverse()]);
      if (!rev.ok) {
        git(dir, ["revert", "--abort"]);
        git(dir, ["reset", "-q", "--hard", head]);
        ok = false;
        break;
      }
      const c = git(dir, [...identity(dir), "commit", "-q", "--no-verify", "--allow-empty", "-m", `回退 ${taskLabel(t.seq)}：${truncate(t.title, 60)}\n\n${truncate(r.reason, 1500)}\n\nOmem-Revert: ${taskLabel(t.seq)}`]);
      if (!c.ok) { git(dir, ["reset", "-q", "--hard", head]); ok = false; break; }
      made.push({ dir, head });
    }
    if (!ok) {
      for (const m of made) git(m.dir, ["reset", "-q", "--hard", m.head]);
      updateTask(app, rootId, r.seq, {}, { by: "host", kind: "revert", text: "回退和后来的改动冲突，没有回退；这一轮在现在的代码上改" });
      log(`${taskLabel(r.seq)} 回退有冲突，改为在现在的代码上改`);
      continue;
    }
    const kept = Object.fromEntries(Object.keys(t.commits).map((space) => [space, [] as string[]]));
    updateTask(app, rootId, r.seq, { commits: kept, reverts: t.reverts + 1 }, { by: "host", kind: "revert", text: `已回退之前的提交：${Object.values(t.commits).flat().map((s) => s.slice(0, 8)).join("、")}` });
    log(`已回退 ${taskLabel(r.seq)}「${truncate(t.title, 40)}」`);
    done.push(revertLabel(r));
  }
  setWorkState(app, rootId, { reverts: [] });
  return done;
}

/**
 * A checkpoint, a file or a hunk taken back, as one commit (`Omem-Revert: …`). Back to a checkpoint
 * reverses everything after it in one go, and the tasks done after it are marked reverted; a hunk
 * that no longer applies becomes a task for the coder, with the hunk and the reason.
 */
function applyOtherRevert(app: App, rootId: string, worktrees: WorktreeRef[], r: RevertOp, commit: (dir: string, message: string) => boolean): boolean {
  const trailer = `\n\n${truncate(r.reason, 1500)}\n\nOmem-Revert: ${revertLabel(r)}`;
  if (r.checkpoint !== undefined) {
    const heads = headsAt(app, rootId, worktrees, r.checkpoint);
    let changed = false;
    for (const wt of worktrees) {
      const from = heads[wt.space];
      if (!from) continue;
      const diff = git(wt.path, ["diff", "--binary", from, "HEAD"]).stdout;
      if (!diff.trim()) continue;
      const applied = git(wt.path, ["apply", "-R", "--index", "-"], diff);
      if (!applied.ok || !commit(wt.path, `${revertLabel(r)}${trailer}`)) {
        git(wt.path, ["reset", "-q", "--hard", "HEAD"]);
        return false;
      }
      changed = true;
    }
    if (changed) for (const t of listTasks(app, rootId)) {
      if ((t.checkpoint ?? 0) > r.checkpoint && ["done", "verify"].includes(t.state)) updateTask(app, rootId, t.seq, { state: "reverted" }, { by: r.by, kind: "revert", text: `${revertLabel(r)}：${r.reason}` });
    }
    return true;
  }
  if (r.file) {
    const wt = worktrees.find((w) => w.space === r.file!.space);
    if (!wt) return false;
    const there = git(wt.path, ["cat-file", "-e", `${r.file.rev}:${r.file.path}`]).ok;
    const restored = there ? git(wt.path, ["checkout", r.file.rev, "--", r.file.path]) : git(wt.path, ["rm", "-q", "-f", "--ignore-unmatch", "--", r.file.path]);
    if (!restored.ok) return false;
    if (git(wt.path, ["diff", "--cached", "--quiet"]).ok) return true;
    if (!commit(wt.path, `${revertLabel(r)}${trailer}`)) { git(wt.path, ["reset", "-q", "--hard", "HEAD"]); return false; }
    return true;
  }
  const p = r.patch!;
  const wt = worktrees.find((w) => w.space === p.space);
  const text = p.text.endsWith("\n") ? p.text : `${p.text}\n`;
  const applied = wt ? git(wt.path, ["apply", "-R", "--3way", "--index", "-"], text) : null;
  if (wt && applied?.ok && commit(wt.path, `${revertLabel(r)}${trailer}`)) return true;
  if (wt) git(wt.path, ["reset", "-q", "--hard", "HEAD"]);
  // It no longer applies as it is: the coder takes it back by hand.
  addTask(app, rootId, { title: `按本人的要求回退：${revertLabel(r).replace(/^回退 /, "")}`, doneWhen: `把下面这段改动退回去（代码已经变过，按意思回退，不要整段覆盖）。原因：${r.reason}\n\n\`\`\`diff\n${truncate(text, 6000)}\n\`\`\``, kind: "owner", origin: { note: r.reason } }, r.by);
  return false;
}

// ---- for the coder -------------------------------------------------------------------------------

/** A task some round took but did not finish: that round failed, was stopped or cancelled. */
export function stranded(app: App, t: CodeTask) {
  if (t.state !== "coding" || !t.coderRun) return false;
  const status = one<{ status: string }>(app.db, "select status from runs where id = ?", t.coderRun)?.status;
  return !status || !["queued", "running"].includes(status);
}

/**
 * Tasks a round codes: the ones to do now, any a failed round left half done, and its own when the
 * same run starts over (a restart), marked as taken by this run.
 */
export function takeTasks(app: App, rootId: string, runId: string): CodeTask[] {
  const todo = listTasks(app, rootId).filter((t) => t.state === "todo" || (t.state === "coding" && (t.coderRun === runId || stranded(app, t))));
  for (const t of todo) updateTask(app, rootId, t.seq, { state: "coding", coderRun: runId });
  return todo.map((t) => getTask(app, rootId, t.seq));
}

/** What a task asks for, as the coder reads it: what done means, where it came from, how it went before. */
export function taskText(app: App, t: CodeTask) {
  const findings = (t.origin.findings ?? []).map((id) => one<{ title: string; detail: string; suggestion: string; owner_suggestion: string | null; file_path: string | null; line: number | null; check_name: string }>(app.db, "select f.title, f.detail, f.suggestion, f.owner_suggestion, f.file_path, f.line, r.check_name from review_findings f join reviews r on r.id = f.review_id where f.id = ?", id)).filter(Boolean);
  const tries = t.notes.filter((n) => ["verify", "revert", "host", "owner", "lead", "consult", "assistant"].includes(n.kind)).slice(-6);
  return [
    `### ${taskLabel(t.seq)} ${t.title}`,
    t.doneWhen ? `完成标准：${t.doneWhen}` : "",
    ...findings.map((f) => [
      `评审问题 #${(t.origin.findings ?? [])[findings.indexOf(f)]}（${f!.check_name}${f!.file_path ? `，${f!.file_path}${f!.line ? `:${f!.line}` : ""}` : ""}）：${f!.title}`,
      f!.detail ? truncate(f!.detail, 2500) : "",
      f!.owner_suggestion?.trim() ? `建议（本人改写，以此为准）：${f!.owner_suggestion.trim()}` : f!.suggestion ? `建议：${f!.suggestion}` : "",
    ].filter(Boolean).join("\n")),
    t.origin.note ? `本人的原话：${t.origin.note}` : "",
    t.answer ? `本人的决定：${t.answer}` : "",
    tries.length ? `之前的情况：\n${tries.map((n) => `- ${n.text}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * What the owner reads when a task waits on them, as plainly as a review finding: the question, then
 * the task in full (what done means, the finding it came from, each try and what was said about it)
 * and what the coder said last.
 */
export function ownerQuestionText(app: App, t: CodeTask) {
  const said = t.notes.filter((n) => n.kind === "coder").at(-1);
  return [
    t.question ?? "",
    taskText(app, t).split("\n").slice(1).join("\n").trim(),
    said && !(t.question ?? "").includes(said.text) ? `编码 Agent 最后的说明：${said.text}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Owner of the work, for asks and notifications. */
export const workOwner = (app: App, rootId: string) => runUser(app, rootId);

/** The tasks held up by the coder's environment that wait for the assistant (ensureOwnerAsks), for its turn after the round. */
export function blockedText(app: App, rootId: string) {
  const blocked = listTasks(app, rootId).filter((t) => t.state === "owner" && t.origin.blocked && !t.origin.escalated);
  return blocked.length
    ? `## 编码 Agent 被挡住、等你处理的修改项\n\n${blocked.map((t) => `- ${taskLabel(t.seq)}「${t.title}」：${truncate(t.question ?? "", 600)}`).join("\n")}\n\n这些没有问本人。你能处理的（查清楚、换个做法、宿主已经做过的）处理好后用 settle_code_task 让它重做或不做；要本人做或决定的，用 settle_code_task 的 owner 交给本人。`
    : "";
}

export function lastRound(app: App, rootId: string): Run {
  const r = one<{ id: string }>(app.db, "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at desc limit 1", rootId, rootId);
  return getRun(app, r!.id);
}
