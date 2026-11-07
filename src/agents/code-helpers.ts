import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import { run as sql } from "../core/db.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import type { Execution } from "./execution.ts";
import { addWorktree, shell } from "./code.ts";
import { identity } from "./code-branch.ts";
import { getTask, taskLabel, taskText, updateTask, workRootOf } from "./code-tasks.ts";
import { runRole } from "./runner.ts";
import { addRunEvent, createRun, flushRunText, getRun, runUser, setRunOutput, type Run } from "./runs.ts";
import { getSpace, type Space } from "../core/spaces.ts";
import { replyOf } from "./types.ts";
import type { WorktreeRef } from "./worktree-index.ts";
import { releaseWorkspace, setupCommandFor, setupDone, setupKey } from "./workspaces.ts";

/**
 * Parallel coding inside a round (docs/v2/coding-loop.md §4.2). The round's coder (the lead) hands
 * independent groups of its tasks to helpers (`dispatch_tasks`). Each helper is a coder in a
 * workspace of its own — a pool slot when one is free, so dependencies are already there — checked
 * out where the work branch is when it is dispatched, committing each task (`Omem-Task`); its run is
 * a child of the round's, shown in the run list. When the lead's turn ends the round waits for the
 * helpers and picks their commits onto the work branch in order; conflicts go to the lead to
 * resolve; what still does not merge goes back to do, for the next round on the merged code.
 */

/** What a round tells its helpers about itself while it codes (registered by code.ts). */
export type RoundContext = {
  signal: AbortSignal;
  event: (type: string, data: unknown) => void;
  worktrees: WorktreeRef[];
  repos: Space[];
  execution?: Execution;
  spaces: string[];
  where: (dir: string, wt: WorktreeRef) => string;
};
type Helper = { runId: string; n: number; tasks: number[]; worktrees: WorktreeRef[]; done: Promise<void> };
const rounds = new Map<string, RoundContext & { helpers: Helper[] }>();

export function registerRound(runId: string, ctx: RoundContext) {
  rounds.set(runId, { ...ctx, helpers: [] });
}
export function roundOpen(runId: string) {
  return rounds.has(runId);
}

/** How many helpers a round may run at once (agents.autoAdvance.parallelCoders; 0: none). */
export const helperLimit = (app: App) => app.config.agents.autoAdvance.parallelCoders;

/**
 * Hand groups of the round's own tasks to helpers. Checked: the tasks are this round's and still
 * being coded, the groups do not share a task, and the limit holds. Returns what to tell the lead.
 */
export function dispatchTasks(app: App, roundRunId: string, groups: { tasks: number[]; note?: string }[]): string {
  const round = rounds.get(roundRunId);
  if (!round) throw new HttpError(409, "这一轮已经不在编码了，不能再分给编码助手");
  const limit = helperLimit(app);
  if (!limit) throw new HttpError(400, "设置里关掉了并行编码（agents.autoAdvance.parallelCoders = 0），自己做这些项");
  const running = round.helpers.length;
  if (running + groups.length > limit) throw new HttpError(400, `最多同时 ${limit} 个编码助手，已经有 ${running} 个；少分几组，其余自己做`);
  const rootId = workRootOf(app, roundRunId);
  const seen = new Set<number>();
  for (const g of groups) {
    if (!g.tasks.length) throw new HttpError(400, "每组至少一项");
    for (const seq of g.tasks) {
      if (seen.has(seq)) throw new HttpError(400, `${taskLabel(seq)} 出现在两组里`);
      seen.add(seq);
      const t = getTask(app, rootId, seq);
      if (t.state !== "coding" || t.coderRun !== roundRunId) throw new HttpError(400, `${taskLabel(seq)} 不是你这一轮在做的项（现在：${t.state}${t.coderRun && t.coderRun !== roundRunId ? "，已经分出去了" : ""}）`);
    }
  }
  // Where the work branch is now: helpers start from here; the lead's uncommitted edits are not in it.
  const heads = Object.fromEntries(round.worktrees.map((w) => [w.space, git(w.path, ["rev-parse", "HEAD"]).stdout.trim()]));
  const out: string[] = [];
  for (const g of groups) {
    const n = round.helpers.length + 1;
    const r = createRun(app, {
      kind: "agent",
      spaceId: getRun(app, roundRunId).spaceId,
      title: truncate(`编码助手 ${n}：${g.tasks.map(taskLabel).join("、")}`, 80),
      input: { role: "coder", helperOf: roundRunId, tasks: g.tasks, note: g.note ?? "", task: g.tasks.map((s) => `${taskLabel(s)} ${getTask(app, rootId, s).title}`).join("；") },
      parentId: roundRunId,
      userId: runUser(app, roundRunId),
    });
    sql(app.db, "update runs set status = 'running', started_at = ? where id = ? and status = 'queued'", now(), r.id);
    app.emit({ type: "run", runId: r.id, status: "running" });
    for (const seq of g.tasks) updateTask(app, rootId, seq, { coderRun: r.id }, { by: "coder", kind: "coder", text: `分给编码助手 ${n}${g.note?.trim() ? `：${g.note.trim()}` : ""}` });
    const helper: Helper = { runId: r.id, n, tasks: g.tasks, worktrees: [], done: Promise.resolve() };
    helper.done = runHelper(app, roundRunId, rootId, helper, heads, g.note ?? "").catch(() => {});
    round.helpers.push(helper);
    round.event("status", { text: `编码助手 ${n} 开始：${g.tasks.map(taskLabel).join("、")}` });
    out.push(`编码助手 ${n}（运行 ${r.id}）：${g.tasks.map(taskLabel).join("、")}`);
  }
  return `已分出去：${out.join("；")}。接着做你自己的项，不要改分出去的项涉及的文件；你这一轮结束后宿主把它们的提交合进来。`;
}

const HELPER_BRIEF = [
  "# 你是编码助手",
  "编码负责人把下面几项交给你，在你自己的工作区里做（从工作分支现在的位置切出，和负责人、别的助手同时在改别的项）：",
  "- 只改这几项需要的地方，不要动别的项涉及的文件，不要改名或切分支，不要 push；",
  "- 每项做完提交（提交信息末尾单独一行 `Omem-Task: T<编号>`），再用 `finish_task` 说明做了什么、怎么验证的；提交不了就直接 `finish_task`，宿主替你提交；",
  "- 对评审问题拿不准用 `ask_reviewer` 问提出它的评审项；要本人定的用 `report_task` 交出去，接着做别的项。",
  "做完后宿主把你的提交合进工作分支。",
].join("\n");

/** One helper: its own workspaces, the coder there, then what it committed (or left) recorded on its run. */
async function runHelper(app: App, roundRunId: string, rootId: string, h: Helper, heads: Record<string, string>, note: string) {
  const round = rounds.get(roundRunId)!;
  const log = (text: string) => addRunEvent(app, h.runId, "status", { text });
  try {
    // Where every run's workspaces live (runs/<run>/work/<space>): a pool lease counts only through that link.
    const base = join(app.runsDir, h.runId, "work");
    for (const repo of round.repos) {
      const path = join(base, repo.id);
      const slot = addWorktree(app, repo, h.runId, path, heads[repo.id], log)?.path;
      const wt = { ...round.worktrees.find((w) => w.space === repo.id)!, path, start: heads[repo.id], ...(slot ? { slot } : { slot: undefined }), inPlace: undefined };
      h.worktrees.push(wt);
      const dir = slot ?? path;
      const command = setupCommandFor(repo, dir);
      const key = command ? setupKey(dir, command) : null;
      if (command && key) {
        log(`准备依赖：${command}`);
        const r = await shell(command, dir, round.signal);
        if (r.code === 0) setupDone(dir, key);
        else log(`准备命令失败，退出码 ${r.code}`);
      }
    }
    setRunOutput(app, h.runId, { worktrees: h.worktrees });
    const cwd = h.worktrees.length > 1 ? base : h.worktrees[0].slot ?? h.worktrees[0].path;
    const tasks = h.tasks.map((s) => getTask(app, rootId, s));
    const where = h.worktrees.map((w) => round.where(w.slot ?? w.path, w)).join("\n");
    const res = await runRole(app, {
      role: "coder",
      addTools: ["finish_task", "report_task", "ask_reviewer", "attach_artifact"],
      artifacts: true,
      execution: round.execution,
      spaceId: getRun(app, roundRunId).spaceId!,
      spaces: round.spaces,
      task: [HELPER_BRIEF, note.trim() ? `## 编码负责人的交代\n\n${note.trim()}` : "", `## 这几项\n\n${tasks.map((t) => taskText(app, t)).join("\n\n")}`, where].filter(Boolean).join("\n\n"),
      runId: h.runId,
      cwd,
      signal: round.signal,
      onEvent: (e) => addRunEvent(app, h.runId, e.type, e),
    });
    flushRunText(app, h.runId);
    // Left uncommitted: one task still open takes it, else it is merged without a task.
    const open = h.tasks.filter((s) => getTask(app, rootId, s).state === "coding");
    for (const wt of h.worktrees) {
      const dir = wt.slot ?? wt.path;
      if (!git(dir, ["status", "--porcelain"]).stdout.trim()) continue;
      git(dir, ["add", "-A"]);
      git(dir, [...identity(dir), "commit", "-q", "--no-verify", "-m", `编码助手 ${h.n} 没提交的改动${open.length === 1 ? `\n\nOmem-Task: ${taskLabel(open[0])}` : ""}`]);
    }
    const commits = Object.fromEntries(h.worktrees.map((w) => [w.space, git(w.slot ?? w.path, ["rev-list", "--reverse", `${heads[w.space]}..HEAD`]).stdout.split("\n").filter(Boolean)]));
    setRunOutput(app, h.runId, { commits, answer: replyOf(res).trim(), ai: res.ai });
    sql(app.db, "update runs set status = 'done', profile_id = ?, finished_at = ? where id = ?", res.profileId, now(), h.runId);
    app.emit({ type: "run", runId: h.runId, status: "done" });
    round.event("status", { text: `编码助手 ${h.n} 做完了：${h.tasks.map(taskLabel).join("、")}（${Object.values(commits).flat().length} 个提交）` });
  } catch (e) {
    flushRunText(app, h.runId);
    sql(app.db, "update runs set status = 'failed', error = ?, finished_at = ? where id = ?", (e as Error).message, now(), h.runId);
    addRunEvent(app, h.runId, "error", { message: (e as Error).message });
    app.emit({ type: "run", runId: h.runId, status: "failed" });
    round.event("status", { text: `编码助手 ${h.n} 没做完：${(e as Error).message}` });
  }
}

/**
 * The lead's turn is over: wait for the helpers, pick their commits onto the work branch in order
 * (conflicts to the lead, through `resolve`), give their workspaces back. Tasks whose commits do not
 * merge go back to do. Returns the helpers' run ids (their tasks settle with the round's).
 */
export async function joinHelpers(app: App, roundRunId: string, resolve: (wt: WorktreeRef, files: string[], label: string) => Promise<void>): Promise<string[]> {
  const round = rounds.get(roundRunId);
  if (!round) return [];
  rounds.delete(roundRunId);
  if (!round.helpers.length) return [];
  const rootId = workRootOf(app, roundRunId);
  round.event("status", { text: `等编码助手做完：${round.helpers.map((h) => `编码助手 ${h.n}`).join("、")}` });
  await Promise.allSettled(round.helpers.map((h) => h.done));
  for (const h of round.helpers) {
    const commits = (getRun(app, h.runId).output.commits ?? {}) as Record<string, string[]>;
    let merged = true;
    for (const wt of round.worktrees) {
      const shas = commits[wt.space] ?? [];
      if (!shas.length) continue;
      if (!(await pick(wt, shas, `合并编码助手 ${h.n} 的提交`, resolve, round.signal))) { merged = false; break; }
    }
    round.event("status", { text: merged ? `已合并编码助手 ${h.n} 的 ${Object.values(commits).flat().length} 个提交` : `编码助手 ${h.n} 的提交合不进来，它的项下一轮在合并后的代码上重做` });
    if (!merged) for (const seq of h.tasks) {
      const t = getTask(app, rootId, seq);
      if (["verify", "done", "coding"].includes(t.state)) updateTask(app, rootId, seq, { state: "todo", commits: Object.fromEntries(Object.keys(t.commits).map((s) => [s, []])) }, { by: "host", kind: "host", text: `编码助手 ${h.n} 的改动和别的改动冲突，没合进去；在合并后的代码上重做` });
    }
    for (const wt of h.worktrees) {
      if (wt.slot) releaseWorkspace(h.runId, { path: wt.path, slot: wt.slot });
      else if (existsSync(wt.path)) git(getSpace(app, wt.space).rootPath!, ["worktree", "remove", "--force", wt.path]);
    }
  }
  return round.helpers.map((h) => h.runId);
}

/** Cherry-pick commits onto a worktree; a conflict goes to `resolve` once, then the pick goes on or is undone. */
async function pick(wt: WorktreeRef, shas: string[], label: string, resolve: (wt: WorktreeRef, files: string[], label: string) => Promise<void>, signal: AbortSignal) {
  const dir = wt.path;
  const before = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
  let r = git(dir, [...identity(dir), "cherry-pick", "--allow-empty", "--keep-redundant-commits", ...shas]);
  for (let i = 0; !r.ok && i < shas.length; i++) {
    const files = git(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter(Boolean);
    if (!files.length || signal.aborted) break;
    await resolve(wt, files, label).catch(() => {});
    if (git(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim()) break;
    git(dir, ["add", "-A"]);
    r = git(dir, [...identity(dir), "-c", "core.editor=true", "cherry-pick", "--continue"]);
  }
  if (r.ok) return true;
  git(dir, ["cherry-pick", "--abort"]);
  git(dir, ["reset", "-q", "--hard", before]);
  return false;
}

