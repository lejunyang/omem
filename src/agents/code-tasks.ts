import { existsSync } from "node:fs";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { git } from "../core/git.ts";
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

export type TaskState = "todo" | "coding" | "verify" | "done" | "owner" | "wontdo" | "reverted";
/** build: split from the request; fix: from a review finding; owner: the owner's words; redo: again after a revert. */
export type TaskKind = "build" | "fix" | "owner" | "redo";
export type TaskNote = { at: string; by: string; text: string; kind: "coder" | "verify" | "owner" | "revert" | "lead" | "host" };
export type CodeTask = {
  id: number;
  workId: string;
  seq: number;
  title: string;
  doneWhen: string;
  kind: TaskKind;
  origin: { findings?: number[]; note?: string; redoOf?: number; files?: string[] };
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

export const TASK_STATE_LABEL: Record<TaskState, string> = { todo: "待做", coding: "编码中", verify: "待验证", done: "已完成", owner: "等你决定", wontdo: "不做", reverted: "已回退" };
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
  reverts?: { seq: number; reason: string; by: string }[];
  viewed?: Record<string, number>;
  asks?: Record<string, string>;
};

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

export type TaskPatch = Partial<Pick<CodeTask, "title" | "doneWhen" | "state" | "question" | "options" | "answer" | "verifier" | "coderRun" | "attempts" | "reverts" | "commits" | "checkpoint">>;
export function updateTask(app: App, rootId: string, seq: number, patch: TaskPatch, note?: Omit<TaskNote, "at">): CodeTask {
  const t = getTask(app, rootId, seq);
  const next = { ...t, ...patch };
  const notes = note ? [...t.notes, { at: now(), ...note }] : t.notes;
  run(app.db, "update code_tasks set title=?, done_when=?, state=?, question=?, options=?, answer=?, verifier=?, coder_run=?, attempts=?, reverts=?, commits=?, checkpoint=?, notes=?, updated_at=? where id=?",
    next.title, next.doneWhen, next.state, next.question, next.options.length ? JSON.stringify(next.options) : null, next.answer, next.verifier, next.coderRun, next.attempts, next.reverts, JSON.stringify(next.commits), next.checkpoint, JSON.stringify(notes), now(), t.id);
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
      question: `${taskLabel(seq)}「${t.title}」试了 ${attempts} 次还没改好（最后一次：${truncate(note.text, 300)}）。怎么办？`,
      options: ["按评审的意见再试一次", "改成你说的做法", "不做这一项"],
    }, note);
  }
  return updateTask(app, rootId, seq, { attempts, state: "todo" }, note);
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
export function settleCodingRound(app: App, rootId: string, runId: string, worktrees: WorktreeRef[], round: number) {
  const before = listCheckpoints(app, rootId).at(-1);
  const roundTasks = listTasks(app, rootId).filter((t) => t.coderRun === runId);
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
      else retryTask(app, rootId, t.seq, { by: "host", kind: "host", text: `第 ${round} 轮没有这一项的提交，也没有说明` });
    }
  }
  const finished = listTasks(app, rootId).filter((t) => t.coderRun === runId && ["verify", "done"].includes(t.state)).map((t) => t.seq);
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

// ---- diffs ----------------------------------------------------------------------------------------

export type Patch = { space: string; patch: string; label?: string };

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
 */
export function workPatches(app: App, rootId: string, worktrees: WorktreeRef[], sel: { tasks?: number[]; from?: number; to?: number; since?: "viewed"; userId?: string }): Patch[] {
  const out: Patch[] = [];
  if (sel.tasks?.length) {
    for (const seq of sel.tasks) {
      const t = getTask(app, rootId, seq);
      for (const wt of worktrees) {
        const dir = gitDirOf(app, wt);
        const patch = dir ? taskPatch(dir, t.commits[wt.space] ?? []) : "";
        if (patch.trim()) out.push({ space: wt.space, patch, label: `${taskLabel(seq)} ${t.title}` });
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
    if (patch.trim()) out.push({ space: wt.space, patch });
  }
  return out;
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
  setWorkState(app, rootId, { reverts: [...(w.reverts ?? []), { seq, reason, by }] });
  const redo = opts.redo ?? true;
  return updateTask(app, rootId, seq, { state: redo ? "todo" : "reverted" }, { by, kind: "revert", text: `${redo ? "回退后重做" : "回退"}：${reason}` });
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
  const done: number[] = [];
  for (const r of pending) {
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
    done.push(r.seq);
  }
  setWorkState(app, rootId, { reverts: [] });
  return done;
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
  const tries = t.notes.filter((n) => ["verify", "revert", "host", "owner", "lead"].includes(n.kind)).slice(-4);
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

/** Owner of the work, for asks and notifications. */
export const workOwner = (app: App, rootId: string) => runUser(app, rootId);

export function lastRound(app: App, rootId: string): Run {
  const r = one<{ id: string }>(app.db, "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at desc limit 1", rootId, rootId);
  return getRun(app, r!.id);
}
