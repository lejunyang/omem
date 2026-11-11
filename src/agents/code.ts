import { executionArgs, type Execution } from "./execution.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { defaultBaseRef, fetchBranchAsync, git, isGitRepo, resolveRef } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { cancelHostAsks, createAsk, registerAskHandler, ROUND_ASKS } from "./asks.ts";
import { lapseWorkAsks } from "./ask-expiry.ts";
import { businessOf, childSpaces, findSpace, getSpace, type Space } from "../core/spaces.ts";
import { HttpError, stripAnsi, truncate } from "../core/util.ts";
import { resolveRunProfile, runRole } from "./runner.ts";
import type { ReviewEstimate, ReviewMetrics, ReviewPlan } from "./review.ts";
import { createRun, getRun, runUser, setRunOutput, type Run, type RunContext } from "./runs.ts";
import { dropWorktreeSpace, indexWorktree, worktreeSpacesOf, type WorktreeRef } from "./worktree-index.ts";
import { leasedTo, leaseWorkspace, releaseWorkspace, setupCommandFor, setupDone, setupKey, workDirOf } from "./workspaces.ts";
import { branchWorktree, changeBase, checkedOutAt, confirmBranchRun, isBranchWork, planBranch, releaseBranchRun, settleRound, siblingsText, withDiffBase } from "./code-branch.ts";
import { replyOf } from "./types.ts";
import { markNotesDelivered, notesText, pendingNotes, type RoundReview } from "./code-steer.ts";
import { isSourceFile } from "../sources/chunk.ts";
import { OWNER } from "../core/users.ts";
import { retireRecordedSession } from "./session-cleanup.ts";
import { linkRunToItem, materialSpaces, materialsBrief } from "../items/materials.ts";
import { getItem } from "../items/store.ts";

export function shell(command: string, cwd: string, signal: AbortSignal, timeoutMs = 20 * 60_000, env: Record<string, string> = {}): Promise<{ code: number; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    // Verbatim on Windows, as Node's own `shell: true`: quotes inside the command reach cmd unescaped.
    const child = spawn(isWin ? (process.env.ComSpec ?? "cmd.exe") : "sh", isWin ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], { cwd, windowsHide: true, windowsVerbatimArguments: isWin, env: { ...process.env, CI: "1", ...env } });
    let output = "";
    const add = (d: Buffer) => {
      output = (output + d.toString()).slice(-20000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ code: code ?? -1, output: stripAnsi(output), ms: Date.now() - started });
    });
    child.on("error", (e) => resolve({ code: -1, output: String(e), ms: Date.now() - started }));
  });
}

export type CodeInput = {
  execution?: Execution;
  /** Review tier the owner named, and checks to add (docs/v2/review.md). */
  reviewTier?: string;
  reviewChecks?: string[];
  /** Checks review-lead asked to re-run this round (the others are not affected by the fixes). */
  reviewOnly?: string[];
  reviewExecution?: Execution;
  task: string;
  /** Applies to every repository unless `checks` names one for it. */
  checkCommand?: string;
  /** Repository spaces to change together; defaults to the run's space. */
  repos?: string[];
  checks?: Record<string, string>;
  /**
   * Review existing branches instead of coding (by repository space): each is checked out
   * detached, its changes since it left `base` (default: origin's default branch) are what the
   * review sees, and nothing is applied. `fetch` updates them from origin first.
   */
  branches?: Record<string, { branch: string; base?: string }>;
  fetch?: boolean;
  /** Code on top of an existing branch (by repository space): its work branch (code-branch.ts). */
  fromBranches?: Record<string, string>;
  /** A new work branch's name (by repository space); without it the coding Agent names a temporary one. */
  branchNames?: Record<string, string>;
  /** More spaces the coder and reviewers may read: requirement docs, the source of a migration, past cases. */
  readSpaces?: string[];
  /** The item this work is for: the coder and reviewers read its materials (src/items/materials.ts). */
  itemId?: string;
  /** The branch review this fixes: its reviewers also respect what the owner decided there. */
  fromReview?: string;
  /**
   * Git work before coding (code-sync.ts): pull the target branch's remote commits and/or merge or
   * rebase onto another branch; conflicts go to the coding Agent, then to the owner. `syncOnly`:
   * that is the whole task, no coding after it.
   */
  sync?: import("./code-sync.ts").SyncRequest;
  syncOnly?: boolean;
  /** A later round: finish a sync stopped on conflicts the owner has since resolved. */
  syncResume?: boolean;
  /** A later round: move the unapplied work onto the target branch's latest commit. */
  moveToTarget?: boolean;
  moveToTargetMode?: "merge" | "rebase";
  /**
   * A branch review an outside Agent on a paired device does itself (peer-agent.ts, review_branch
   * over `--peer`): this machine prepares the worktrees, index and plan, then waits for that Agent's
   * submit_review / submit_change_points; none of this machine's models is asked anything.
   */
  peerReviewer?: PeerReviewer;
  /**
   * Coding an outside Agent on a paired device does itself (peer-code.ts, delegate_code over
   * `--peer`): a round prepares the worktree and stops; the Agent edits through code_workspace, and
   * its `finish` queues a round with `peerFinished` that commits, checks and reviews what it did.
   */
  peerCoder?: PeerReviewer;
  peerFinished?: boolean;
  /**
   * Driven by tasks instead of rounds (docs/v2/coding-loop.md, code-tasks.ts / code-loop.ts): the
   * coder works task by task, each check verifies what it raised, review-lead picks what to review;
   * `maxRounds` is the budget the owner gave (else the coder estimates one, under the cap).
   */
  taskMode?: boolean;
  maxRounds?: number;
  /** Whether to write a design before coding (designs/work.ts wantsDesign); default auto. */
  design?: "auto" | "always" | "never";
  /** A branch review: the design it is reviewed against (the design keeps only the latest review as its work). */
  designId?: string;
  /** A task-driven later round: what the owner or the assistant said for it since the last one (code-steer.ts notesText). */
  roundNotes?: string;
};
export type PeerReviewer = { caller: string; session: string; agent?: string; model?: string };

/** Whether a coding run reviews existing branches (no coding round, nothing to apply). */
export const isBranchReview = (r: { input: unknown }) => !!(r.input as CodeInput).branches;

export type BranchReviewRequest = {
  space?: string;
  repos: string[];
  branch: string;
  /** Per repository, when the branch is named differently there. */
  branches?: Record<string, string>;
  base?: string;
  task?: string;
  title?: string;
  fetch?: boolean;
  /** Spaces the reviewers may read besides the repositories (already checked against the caller's access). */
  readSpaces?: string[];
} & Pick<CodeInput, "reviewTier" | "reviewChecks" | "reviewExecution" | "itemId" | "peerReviewer" | "designId">;

/** Queue a review of existing branches: a `code` run without the coding round (runCodeTask). */
export function createBranchReview(app: App, req: BranchReviewRequest, parentId?: string | null, userId = OWNER) {
  const ids = [...new Set(req.repos)];
  const home = homeSpace(app, req.space, req.itemId, ids);
  codeRepos(app, home, ids);
  const branches = Object.fromEntries(ids.map((id) => [id, { branch: req.branches?.[id] ?? req.branch, ...(req.base ? { base: req.base } : {}) }]));
  const r = createRun(app, {
    kind: "code",
    spaceId: home,
    title: truncate(req.title?.trim() || `评审分支 ${req.branch}`, 80),
    input: {
      task: req.task?.trim() || `评审分支 ${req.branch} 相对基线的全部改动。`,
      reviewExecution: req.reviewExecution,
      repos: ids,
      branches,
      fetch: req.fetch !== false,
      reviewTier: req.reviewTier || undefined,
      reviewChecks: req.reviewChecks,
      readSpaces: req.readSpaces?.length ? [...new Set(req.readSpaces)] : undefined,
      itemId: req.itemId,
      peerReviewer: req.peerReviewer,
      designId: req.designId,
    } satisfies CodeInput,
    parentId: parentId ?? undefined,
    userId,
  });
  if (req.itemId) linkRunToItem(app, r, req.itemId, userId);
  return r;
}
/**
 * The project's checks, run by the host in the worktree after a coding round: the evidence the
 * reviewers judge instead of running the suite again. `commit`: what they ran on (the round's last
 * commit; absent for a delegation that does not commit). `base`: where the change starts (OMEM_BASE).
 */
export type Check = { command: string; code: number; output: string; ms: number; commit?: string; base?: string; at?: string };

/** The check command a round of a delegation runs in a repository: named for it, for all, or the repository's own. */
export function checkCommandOf(app: App, run: Run, space: string): string | undefined {
  const input = run.input as { checks?: Record<string, string>; checkCommand?: string };
  return input.checks?.[space] ?? input.checkCommand ?? ((findSpace(app, space)?.settings.checkCommand as string | undefined) || undefined);
}

/** The host's last check of a repository in a delegation (any round), newest first. */
export function latestCheck(app: App, rootId: string, space: string): Check | null {
  const rows = all<{ id: string }>(app.db, "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at desc limit 30", rootId, rootId);
  for (const { id } of rows) {
    const out = getRun(app, id).output as { repos?: { space: string; check: Check | null }[] };
    const c = out.repos?.find((r) => r.space === space)?.check;
    if (c) return c;
  }
  return null;
}
/** `base`: on a work branch, the commit the diff was taken from (changeBase). */
type RepoResult = { space: string; diffStat: string; diffBytes: number; check: Check | null; ignored?: IgnoredFiles[]; base?: string };
/** Files of the change that .gitignore covers, by the pattern that covers them. */
export type IgnoredFiles = { pattern: string; files: number; example: string };

/** The run's worktrees, including runs from before multi-repository delegation. */
/** Turns a task-driven round's coder may get after its own, for what its checks sent back and what it has not got to (code-overlap.ts). */
const FOLLOW_UPS = 8;

export function worktreesOf(app: App, runId: string): WorktreeRef[] {
  const r = getRun(app, runId);
  const out = r.output as { worktrees?: WorktreeRef[]; worktree?: string; branch?: string; base?: string };
  if (out.worktrees) return out.worktrees.map((w) => withDiffBase(app, String(r.input.continueFrom ?? r.id), w));
  return out.worktree && r.spaceId ? [{ space: r.spaceId, path: out.worktree, branch: out.branch ?? "", base: out.base ?? "" }] : [];
}

/**
 * Where a delegation or branch review lives: the space asked for, else the business the work is for
 * (the space of its item's requirement tree, else the item's own space), so that space's runs list
 * shows it; else the first repository's. A repository under a business space files its work there.
 */
export function homeSpace(app: App, space: string | undefined, itemId: string | undefined, repos: string[]) {
  if (space) return businessOf(app, space);
  if (!itemId) return businessOf(app, repos[0]);
  const tree = one<{ space_id: string }>(app.db, "select n.space_id from item_materials m join req_nodes n on n.id = m.ref where m.item_id = ? and m.kind = 'req' and n.status = 'active' order by m.id limit 1", itemId);
  return tree?.space_id ?? getItem(app, itemId).spaceId;
}

/** Repository spaces a delegation changes: each one must be a Git repository. */
export function codeRepos(app: App, spaceId: string, repos?: string[]): Space[] {
  const ids = [...new Set(repos?.length ? repos : [spaceId])];
  return ids.map((id) => {
    let s = getSpace(app, id);
    // A business space names its repository when it has just one; with several, which one has to be said.
    if (!s.rootPath) {
      const kids = childSpaces(app, s.id);
      if (kids.length === 1) s = kids[0];
      else if (kids.length) throw new HttpError(400, `空间 ${id} 下有 ${kids.length} 个仓库（${kids.map((k) => `${k.id}：${k.name}`).join("、")}），说明要改哪个`);
    }
    if (!s.rootPath || !isGitRepo(s.rootPath)) throw new HttpError(400, `空间 ${id} 没有关联 Git 仓库，不能交办编码`);
    return s;
  });
}

const patchFile = (app: App, runId: string, space: string) => {
  const input = getRun(app, runId).input as { continueFrom?: string };
  return join(app.runsDir, input.continueFrom ?? runId, "patches", `${space}.patch`);
};
const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

/**
 * Delegated coding: isolated worktrees (one per repository) → coding agent → project checks →
 * independent reviewer. Nothing touches the user's checkouts until they apply. While the
 * worktrees exist, the files they changed are indexed in temporary spaces (worktree-index.ts).
 */
export async function runCodeTask(ctx: RunContext) {
  const { app, run } = ctx;
  const input = run.input as CodeInput;
  // A later round continues the first run: same worktrees and its coding Agent session.
  const chain = (await import("./code-chain.ts")).codeChainFor(app, run);
  const continueFrom = (input as { continueFrom?: string }).continueFrom;
  const rootRunId = continueFrom ?? run.id;
  const repos = codeRepos(app, run.spaceId!, input.repos);
  const multi = repos.length > 1;
  const dir = join(app.runsDir, rootRunId);
  const workDir = join(dir, "work");
  const branch = `omem/${rootRunId}`;
  mkdirSync(join(dir, "patches"), { recursive: true });
  const known = worktreesOf(app, rootRunId);
  const worktrees: WorktreeRef[] = [];
  const branchNotes: Record<string, string> = {};
  for (const repo of repos) {
    const path = join(workDir, repo.id);
    const log = (text: string) => ctx.event("status", { text });
    const was = known.find((w) => w.space === repo.id);
    // A work branch: every round places a workspace (kept, or lent again) on the branch's latest commit.
    if (was?.commits || (!was && !input.branches)) {
      const { wt, note } = branchWorktree(app, repo, rootRunId, path, was ?? (await planBranch(repo, rootRunId, { from: input.fromBranches?.[repo.id], name: input.branchNames?.[repo.id] })), log);
      worktrees.push(wt);
      branchNotes[repo.id] = note;
      if (!was) log(`${repo.id} 的工作分支 ${wt.branch}（${wt.newBranch ? `从${wt.cutFrom ? ` ${wt.cutFrom} 的` : ""} ${wt.base.slice(0, 8)} 切出` : `已有分支，从 ${wt.base.slice(0, 8)} 接着做`}），工作区 ${workDirOf(wt)}`);
      continue;
    }
    if (was && existsSync(was.path)) {
      worktrees.push(was);
      continue;
    }
    if (input.branches) {
      const wt = await checkoutBranch(app, repo, rootRunId, input.branches[repo.id], path, input.fetch !== false, log);
      worktrees.push(wt);
      log(`已在 ${wt.slot ? `复用工作区 ${wt.slot}` : path} 检出 ${repo.id} 的分支 ${wt.ref}（${wt.tip!.slice(0, 8)}），评审它相对 ${wt.baseRef} 的改动（分叉点 ${wt.base.slice(0, 8)}）`);
      continue;
    }
    // An older delegation whose worktree is gone: a plain worktree at the commit it began from.
    const wt = was!;
    const made = git(repo.rootPath!, ["worktree", "add", "-q", "--detach", path, wt.start ?? wt.base]);
    if (!made.ok) throw new Error(`在 ${repo.id} 创建工作区失败：${made.stderr}`);
    worktrees.push({ ...wt, path, slot: undefined, inPlace: undefined });
  }
  if (chain) {
    const { saveCodeChain } = await import("./code-chain.ts");
    if (rootRunId !== run.id) saveCodeChain(app, chain, run.id);
    (await import("../channels/lark-code-progress.ts")).startCodeProgress(app, chain);
  }
  ctx.output({ worktrees });

  // Triage before coding: review-lead guesses the tier from the task (shown with the progress, and
  // a heavier option the post-coding triage weighs). Only when a tier has a lead to do it.
  if (!continueFrom && !input.taskMode && !input.reviewTier && !input.peerReviewer && !input.peerCoder && app.config.review.tiers.some((t) => t.lead)) {
    const { estimateReview } = await import("./review.ts");
    const { askModel } = await import("./oneshot.ts");
    const estimate = await estimateReview(app, input.task, (p) => askModel(app, p, { timeoutMs: 60_000, signal: ctx.signal }));
    if (estimate) {
      ctx.output({ reviewEstimate: estimate });
      ctx.event("status", { text: `评审负责人预估需要「${estimate.tierName}」档：${estimate.reason}` });
    }
  }
  const commandFor = (repo: Space) => input.checks?.[repo.id] ?? input.checkCommand ?? (repo.settings.checkCommand as string | undefined);
  const branchText = (i: number) => {
    const wt = worktrees[i];
    if (!wt.commits) return "这次交办的改动由宿主生成 diff，不要提交。";
    return [branchNotes[wt.space], "按功能分几次提交（遵守仓库的提交信息规范），不要 push；这一轮结束时没提交的改动由宿主提交。", siblingsText(app, wt.space, rootRunId)].filter(Boolean).join("\n");
  };
  const where = multi
    ? `\n\n（这次要一起改 ${repos.length} 个仓库。工作目录 ${workDir} 下每个子目录是一个仓库的独立 worktree：\n${repos
        .map((r, i) => `- ${r.id}（${r.name}）：${workDirOf(worktrees[i])}${commandFor(r) ? `；检查命令：${commandFor(r)}` : ""}\n  ${branchText(i).replace(/\n/g, "\n  ")}`)
        .join("\n")}\n用 omem 工具查这几个仓库时传 space: "*"。）`
    : `${commandFor(repos[0]) ? `\n\n检查命令：${commandFor(repos[0])}` : ""}\n\n（工作目录是独立 worktree：${workDirOf(worktrees[0])}）\n\n## 分支\n\n${branchText(0)}`;
  const cwd = multi ? workDir : workDirOf(worktrees[0]);
  // The run's space may be a project; the agents read it and every repository (and their related spaces).
  const owner = runUser(app, run.id);
  const spaces = [...new Set([run.spaceId!, ...repos.map((r) => r.id), ...(input.readSpaces ?? []), ...(input.itemId ? materialSpaces(app, input.itemId, owner) : [])])];
  // Later rounds also see the business changes to the requirement points since the delegation began.
  const began = continueFrom ? getRun(app, continueFrom).createdAt : undefined;
  const itemBrief = input.itemId ? `\n\n${materialsBrief(app, input.itemId, owner, { since: began })}` : "";
  // Retried after a failure: the worktree keeps what the failed attempt changed.
  const retryOf = (input as { retryOf?: string }).retryOf;
  const retried = retryOf ? getRun(app, retryOf) : null;
  // Started again after a restart, its coder having finished before it (the summary and the AI are kept).
  const ranBefore = !retried && typeof run.output.coderSummary === "string" && !!run.output.coderAI && !run.output.gitOnly;
  let coderTask = retried
    ? `${(await import("./retry.ts")).attemptNote(app, retried.id)}\n\n工作区里保留了它已经做的改动（git status / git diff 查看）。\n\n# 任务\n\n${input.task}${itemBrief}${where}`
    : continueFrom
    ? `# 上一轮评审要求修改

${input.task}

继续在原来的工作区里改，不要重做已经通过的部分；改完重新运行检查命令。${where}`
    : `${input.task}${itemBrief}${where}`;
  // ---- Git work first: a sync the owner asked for, finishing one stopped on conflicts, or moving the
  // work onto the target branch's latest commit. Conflicts go to the coding Agent (code-sync.ts).
  const synced = await syncPhase();
  if (synced === "stopped") return { verdict: "sync-conflict" };
  // Finishing a stopped sync that came before coding: the coding is still to do, with the first task.
  if (input.syncResume && !input.syncOnly) coderTask = `${String(getRun(app, rootRunId).input.task ?? "")}${itemBrief}${where}`;
  // Dependencies: a new worktree has none, a reused one only when its lockfiles changed (workspaces.ts).
  for (const [i, repo] of repos.entries()) {
    const dir = workDirOf(worktrees[i]);
    const command = setupCommandFor(repo, dir);
    const key = command ? setupKey(dir, command) : null;
    if (!command || !key) continue;
    ctx.event("status", { text: `准备依赖${multi ? `（${repo.id}）` : ""}：${command}` });
    const r = await shell(command, dir, ctx.signal);
    if (ctx.signal.aborted) throw new Error("已取消");
    if (r.code === 0) {
      setupDone(dir, key);
      ctx.event("status", { text: `依赖已准备${multi ? `（${repo.id}）` : ""}，用时 ${Math.round(r.ms / 1000)} 秒` });
    } else {
      const tail = r.output.slice(-1500);
      ctx.event("status", { text: `准备命令失败${multi ? `（${repo.id}）` : ""}，退出码 ${r.code}：\n${tail}` });
      coderTask = `${coderTask}\n\n（宿主在 ${repo.id} 运行准备命令 \`${command}\` 失败，退出码 ${r.code}，依赖可能不全；需要时自己修好再继续。输出末尾：\n${fence("", tail)}）`;
    }
  }
  const skipCoder = !!(input.syncOnly || input.moveToTarget);
  // A task-driven delegation: what to revert first, then the tasks this round codes (code-tasks.ts).
  const taskMode = !!getRun(app, rootRunId).input.taskMode && !input.branches && !skipCoder && !input.peerCoder;
  // A round that only takes things back (the owner reverted, nothing to code): no coding Agent.
  let gitOnly: string | null = null;
  // Helpers the coder handed groups of tasks to (code-helpers.ts); their tasks settle with the round's.
  let helperRuns: string[] = [];
  if (taskMode) {
    const tasks = await import("./code-tasks.ts");
    const { identity } = await import("./code-branch.ts");
    // What the owner (or anyone) changed on the branch since the last round: a checkpoint of its own, kept by the coder.
    const before = one<{ status: string }>(app.db, "select status from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) and id != ? order by created_at desc limit 1", rootRunId, rootRunId, run.id);
    const outside = continueFrom ? tasks.recordOutsideChanges(app, rootRunId, run.id, worktrees, identity, { previousEnded: before?.status === "done", round: Number((input as { round?: number }).round ?? 1) }) : null;
    if (outside) ctx.event("status", { text: `检查点 ${outside.checkpoint.seq}：${outside.checkpoint.label}，${outside.files.length} 个文件` });
    const reverted = tasks.applyReverts(app, rootRunId, worktrees, (text) => ctx.event("status", { text }), identity);
    const taken = tasks.takeTasks(app, rootRunId, run.id);
    // This run coded before a restart stopped it (its tasks are done or being verified): it goes on
    // to verification and review with what it wrote, not as a round with nothing to code.
    if (continueFrom && !taken.length && !ranBefore) {
      gitOnly = reverted.length ? `这一轮只做了回退：${reverted.join("；")}` : "这一轮没有要编码的修改项";
      // Only a round that reverted skips the stage review (what it took back had been reviewed).
      ctx.output({ gitOnly: reverted.length > 0 });
    }
    const w = tasks.workState(app, rootRunId);
    const planning = !continueFrom && !tasks.listTasks(app, rootRunId).some((t) => t.coderRun !== run.id);
    const list = taken.map((t) => tasks.taskText(app, t)).join("\n\n");
    const head = continueFrom ? "# 这一轮要做的修改项" : `${input.task}${itemBrief}`;
    coderTask = [
      head,
      continueFrom ? list : taken.length && taken.every((t) => t.origin.carried) ? `## 修改项\n\n这次交办按修改项推进（做法见角色说明里的“修改项”）。先用 \`plan_tasks\` 拆分上面的任务${w.budgetBy === "owner" ? `（本人给的预算：最多自动推进 ${w.budget} 轮）` : "，并估计要几轮"}，再逐项做；同一分支上之前的交办留下的这几项也在这一轮做（任务里已经要求的不要再拆一遍）：\n\n${list}` : taken.length ? `## 修改项\n\n这次交办按修改项推进（做法见角色说明里的“修改项”），这些已经列好，逐项做：\n\n${list}` : `## 修改项\n\n这次交办按修改项推进（做法见角色说明里的“修改项”）。先用 \`plan_tasks\` 拆分${w.budgetBy === "owner" ? `（本人给的预算：最多自动推进 ${w.budget} 轮）` : "，并估计要几轮"}，再逐项做。`,
      continueFrom ? "继续在原来的工作区里改，这些项都在这一轮做完，不要做一两项就停下；已完成和不做的项不要动。每项照角色说明里“修改项”的做法提交，并用 finish_task 说明。" : "",
      continueFrom && typeof input.roundNotes === "string" ? input.roundNotes : "",
      outside ? `## ${outside.owner ? "本人在这一轮之前改过代码" : "分支上有别人的新提交"}\n\n${outside.owner ? "本人" : "分支上"}改过这些文件（检查点 ${outside.checkpoint.seq}）：${outside.files.slice(0, 30).join("、")}${outside.files.length > 30 ? ` 等 ${outside.files.length} 个` : ""}。这些改动保留，不要覆盖或回退；和你要做的冲突时先用 report_task 交给本人。` : "",
      where.trim(),
    ].filter(Boolean).join("\n\n");
    if (planning || taken.length) ctx.event("status", { text: taken.length ? `这一轮做 ${taken.map((t) => tasks.taskLabel(t.seq)).join("、")}` : "编码 Agent 先拆分修改项" });
  }
  // The check before coding (pre-check.ts): once, before a new delegation's first round codes; a
  // retry of that round keeps the brief it had.
  const pc = await import("./pre-check.ts");
  let pre = pc.preCheckOf(app, rootRunId) ?? (retried ? pc.preCheckOf(app, retried.id) : null);
  if (pre && retried && !continueFrom) setRunOutput(app, rootRunId, { preCheck: pre });
  if (!pre && !continueFrom && !retried && !ranBefore && !skipCoder && !gitOnly && !input.peerCoder && !input.branches && !input.syncResume && pc.wantsPreCheck(app, run)) {
    pre = await pc.runPreCheck(app, { run, task: `${input.task}${itemBrief}`, spaces, cwd, repos: repos.map((r, i) => ({ id: r.id, name: r.name, dir: workDirOf(worktrees[i]) })), signal: ctx.signal, event: ctx.event });
  }
  if (pre && !continueFrom) coderTask = `${coderTask}\n\n${pc.preCheckText(pre, "coder")}`;
  // The design (designs/work.ts): written and confirmed before a new delegation's first round codes,
  // when it is worth one; the round ends while it waits. Coding goes by an approved own design or
  // someone else's taken as the baseline; without one the coder hands in a change description.
  const dw = await import("../designs/work.ts");
  if (!continueFrom && !retried && !ranBefore && !skipCoder && !gitOnly && !input.peerCoder && !input.branches && !input.syncResume) {
    const stage = await dw.designStage(app, { run, task: [`${input.task}${itemBrief}`, pre ? pc.preCheckText(pre, "design") : ""].filter(Boolean).join("\n\n"), spaces, cwd, signal: ctx.signal, event: ctx.event, pre });
    if (stage.wait) {
      ctx.event("status", { phase: "design", text: "方案已交，等确认后再编码（这一轮先结束，不占并发）" });
      return { verdict: "awaiting-design" };
    }
  }
  const coding = !input.branches && !skipCoder && !input.peerCoder && !gitOnly;
  const going = coding ? dw.goesBy(app, rootRunId) : null;
  if (going && !continueFrom) coderTask = `${coderTask}\n\n${dw.designCoderText(app, going)}`;
  // Without a design to go by, the coder describes what it changed at the end (submit_design).
  const describes = coding && !going && dw.ensureDerived(app, getRun(app, rootRunId)).origin === "derived";
  if (input.peerCoder && !input.peerFinished && !skipCoder) {
    // The other device's Agent codes now; the run ends so it holds no slot meanwhile.
    ctx.event("status", { text: `工作区已准备好，等设备 ${input.peerCoder.caller} 的外部 Agent 编码（code_workspace，run_id=${run.id}）` });
    ctx.output({ verdict: "awaiting-peer-code" });
    return { verdict: "awaiting-peer-code" };
  }
  // The host synced before coding: the coder need not (and in its sandbox often cannot) fetch or pull.
  if (synced && !skipCoder) {
    const heads = worktrees.map((w) => `${multi ? `${w.space}：` : ""}现在的 HEAD ${git(w.path, ["rev-parse", "HEAD"]).stdout.trim()}`).join("\n");
    coderTask = `${coderTask}\n\n## 宿主已做的 Git 同步\n\n${[synced.summary, heads].filter(Boolean).join("\n")}\n\n任务里要求的拉取最新代码已经做完；拉取、合并、推送都由宿主做，不要自己 fetch / pull / push。`;
  }
  // What the owner added while this round waited in the queue.
  const early =input.branches || skipCoder || input.peerCoder ? [] : pendingNotes(app, run.id);
  if (early.length) {
    coderTask = `${coderTask}\n\n${notesText(early)}`;
    markNotesDelivered(app, run.id, early);
  }
  // The failed attempt finished coding and stopped later (checks, review): only those are redone.
  // A failed run retried, or this run started again after a restart once its coder had finished.
  const coded = retried && typeof retried.output.coderSummary === "string" && retried.output.coderAI ? retried.output : ranBefore ? run.output : null;
  if (coded) {
    ctx.output({ coderSummary: coded.coderSummary, coderAI: coded.coderAI, coderAgent: coded.coderAgent, coderSessionId: coded.coderSessionId });
    ctx.event("status", { text: `上一次尝试已经写完代码，这次从检查和评审接着做` });
  }
  if (input.peerFinished) ctx.output({ coderSummary: input.task, coderAI: { profile: `peer:${input.peerCoder?.caller ?? "?"}`, model: input.peerCoder?.model } });
  let coderReply = input.branches ? branchSummary(worktrees) : skipCoder ? synced?.summary ?? "" : gitOnly ?? (input.peerFinished ? input.task : coded ? String(coded.coderSummary) : await code());
  if (gitOnly) ctx.output({ coderSummary: gitOnly });
  // What Git brought in before coding goes to the reviewers too, not only the conflicts.
  if (synced?.report || (synced?.summary && !skipCoder)) coderReply = `${coderReply}\n\n## Git 同步\n\n${[synced.summary, synced.report].filter(Boolean).join("\n\n")}`.trim();
  if (input.branches || skipCoder || synced) ctx.output({ coderSummary: coderReply });
  async function syncPhase(): Promise<"stopped" | { summary: string; report: string; conflicts: number } | null> {
    if (input.branches) return null;
    // Every coding round starts from the target branch's latest commits on origin, asked or not:
    // coding on an old commit leaves the work to be merged by hand later. Nothing to pull, no trace.
    const implicit = !input.sync && !input.syncResume && !input.moveToTarget && !input.syncOnly && !retryOf && !input.peerFinished && worktrees.some((w) => w.targetBranch);
    const cs = await import("./code-sync.ts");
    const unfinished = worktrees.some((w) => cs.syncInProgress(w.path));
    const req: import("./code-sync.ts").SyncRequest | undefined = input.sync ?? (implicit ? { pull: true } : unfinished ? { fetch: false } : undefined);
    if (!req && !input.syncResume && !input.moveToTarget) return null;
    type Pending = { space: string; kind: "sync" | "move"; start?: string; label: string; conflicts: string[] };
    const before = ((getRun(app, rootRunId).output.syncPending ?? []) as Pending[]);
    const pending: Pending[] = [];
    const lines: string[] = [];
    const reports: string[] = [];
    let conflicts = 0;
    for (const [i, wt] of worktrees.entries()) {
      const root = repos[i].rootPath!;
      wt.start ??= wt.base;
      const syncBefore = git(wt.path, ["rev-parse", "HEAD"]).stdout.trim();
      const resolver = resolverFor(wt);
      const status = (text: string) => ctx.event("status", { text: `${multi ? `${wt.space}：` : ""}${text}` });
      let steps: import("./code-sync.ts").SyncStep[] = [];
      let stopped: import("./code-sync.ts").SyncState | null = null;
      const was: Pending | undefined = before.find((p) => p.space === wt.space) ?? (cs.syncInProgress(wt.path) ? { space: wt.space, kind: "sync", label: `继续未完成的 ${cs.syncInProgress(wt.path)}`, conflicts: [] } : undefined);
      if (input.syncResume) {
        if (!was) continue;
        const from = git(wt.path, ["rev-parse", "HEAD"]).stdout.trim();
        const found: string[] = [];
        stopped = await cs.finishSync(wt.path, was.label, resolver, found);
        if (!stopped && was.kind === "move") { cs.popWip(wt.path); wt.start = was.start ?? wt.start; }
        if (!stopped && cs.hasSyncStash(wt.path)) stopped = await cs.popStash(wt.path, resolver);
        steps = [{ label: `${was.label}（本人处理后继续）`, from, to: git(wt.path, ["rev-parse", "HEAD"]).stdout.trim(), conflicts: [...new Set([...was.conflicts, ...found])] }];
        if (stopped) pending.push({ ...was, label: stopped.label, conflicts: stopped.conflicts });
      } else if (input.moveToTarget) {
        const m = await cs.moveToTarget(root, wt, resolver, input.moveToTargetMode ?? "merge");
        if (!m.moved) { lines.push(`${wt.space}：已经在 ${wt.targetBranch} 的最新提交上`); continue; }
        steps = [{ label: `移到 ${wt.targetBranch} 的最新提交 ${m.start!.slice(0, 8)}`, from: m.start!, to: git(wt.path, ["rev-parse", "HEAD"]).stdout.trim(), conflicts: m.conflicts ?? [] }];
        if (m.stopped) { stopped = m.stopped; pending.push({ space: wt.space, kind: "move", start: m.start, label: m.stopped.label, conflicts: m.stopped.conflicts }); }
        else wt.start = m.start;
      } else if (req) {
        // A branch omem cut also takes in what landed on the branch it was cut from; a branch the
        // person picked (a release branch, say) only follows its own remote.
        const autoBase = implicit ? wt.cutFrom ?? null : null;
        const r = await cs.syncWorktree(root, wt, { ...req, ...(autoBase ? { onto: autoBase } : {}) }, resolver, status);
        steps = r.steps;
        if (r.stopped) { stopped = r.stopped; pending.push({ space: wt.space, kind: "sync", label: r.stopped.label, conflicts: r.stopped.conflicts }); }
      }
      if (!stopped) {
        cs.settleDiffBase(wt);
        const at = git(wt.path, ["rev-parse", "HEAD"]).stdout.trim();
        // On a work branch a sync that changed nothing keeps the last one: HEAD then holds coding, not synced commits.
        if (!wt.commits || at !== syncBefore) wt.syncHead = at !== wt.start ? at : undefined;
      }
      for (const st of steps) {
        conflicts += st.conflicts.length;
        lines.push(`${multi ? `${wt.space}：` : ""}${st.label}${st.conflicts.length ? `，解决了 ${st.conflicts.length} 个冲突文件` : ""}`);
      }
      const rep = cs.conflictReport(wt.path, steps);
      if (rep) reports.push(multi ? `### ${wt.space}\n\n${rep}` : rep);
    }
    if (implicit && !conflicts && !pending.length && !lines.length) return null;
    // Later rounds read the worktrees (their start and sync commits) from the first run.
    ctx.output({ worktrees });
    if (rootRunId !== run.id) setRunOutput(app, rootRunId, { worktrees });
    setRunOutput(app, rootRunId, { syncPending: pending.length ? pending : null });
    for (const l of lines) ctx.event("status", { text: l });
    if (pending.length) {
      const ask = askSyncConflict(app, getRun(app, run.id), chain ? (await import("./code-chain.ts")).reportConversation(app, chain) : null, pending.map((p) => ({ ...p, path: worktrees.find((w) => w.space === p.space)!.path })));
      ctx.output({ verdict: "sync-conflict", reviewAskId: ask.id, coderSummary: lines.join("\n") });
      return "stopped";
    }
    return { summary: lines.join("\n"), report: reports.join("\n\n"), conflicts };
  }
  function resolverFor(wt: WorktreeRef): import("./code-sync.ts").Resolver {
    return async (files, label) => {
      ctx.event("status", { text: `${label}：${files.length} 个文件有冲突，交给编码 Agent 解决（${files.slice(0, 8).join("、")}${files.length > 8 ? "…" : ""}）` });
      await runRole(app, {
        role: "coder",
        execution: input.execution,
        spaceId: run.spaceId!,
        spaces,
        task: conflictTask(wt, files, label, String(getRun(app, rootRunId).input.task ?? input.task)),
        runId: run.id,
        cwd: workDirOf(wt),
        signal: ctx.signal,
        onEvent: (e) => ctx.event(e.type, { ...e, phase: "coder" }),
      });
    };
  }
  async function code() {
    let resumeCoder = (input as { resumeSessionId?: string }).resumeSessionId;
    const previousSession = resumeCoder;
    const previousId = chain?.rounds.filter((id) => id !== run.id).at(-1);
    if (resumeCoder && previousId) {
      const previous = getRun(app, previousId);
      const profile = resolveRunProfile(app, { actor: { role: "coder" }, ...executionArgs(input.execution) });
      const expected = { profile: profile.id, model: profile.model, effort: profile.effort };
      if (previous.output.coderAI && JSON.stringify(previous.output.coderAI) !== JSON.stringify(expected)) resumeCoder = undefined;
      // Every call of a resumed round carries the session's whole history (files read, checks, earlier
      // rounds): past the limit a new session reads the branch instead.
      const held = previous.output.coderContext as { used: number; size: number } | undefined;
      const limit = app.config.sessions.codeResumeMaxTokens;
      if (resumeCoder && held && held.used > limit) {
        resumeCoder = undefined;
        ctx.event("status", { phase: "coder", text: `上一轮的编码会话已有 ${Math.round(held.used / 1000)}K 上下文（超过 ${Math.round(limit / 1000)}K），这一轮换新会话，从工作分支接着做` });
      }
    }
    // Later rounds resume this session, so it is kept even on backends that would discard it.
    const runCoder = (task: string, resumeSessionId?: string) => runRole(app, {
      role: "coder",
      addTools: [...(taskMode ? ["plan_tasks", "finish_task", "report_task", "ask_reviewer", ...(app.config.agents.autoAdvance.parallelCoders ? ["dispatch_tasks"] : [])] : []), "attach_artifact", "report_tests", ...(describes ? ["submit_design"] : [])],
      execution: input.execution,
      spaceId: run.spaceId!,
      spaces,
      task,
      runId: run.id,
      cwd,
      signal: ctx.signal,
      resumeSessionId,
      persistSession: true,
      artifacts: true,
      onEvent: (e) => ctx.event(e.type, { ...e, phase: "coder" }),
    });
    // A new session on a later round has not seen the original task: give it along with this round's.
    const first = continueFrom && !retried && chain?.rounds[0] && chain.rounds[0] !== run.id ? String(getRun(app, chain.rounds[0]).input.task ?? "") : "";
    // …and what the earlier rounds did, which it reads from the branch rather than from their history.
    const before = previousId ? String(getRun(app, previousId).output.coderSummary ?? "") : "";
    const commits = worktrees.map((wt) => {
      const log = git(workDirOf(wt), ["log", "--oneline", "-30", `${wt.commits ? changeBase(workDirOf(wt), wt) : wt.start ?? wt.base}..HEAD`]);
      return log.ok && log.stdout.trim() ? `${multi ? `${wt.space}：\n` : ""}${log.stdout.trim()}` : "";
    }).filter(Boolean).join("\n\n");
    // …and the check before coding, which came with the first round's task.
    const checked = (await import("./pre-check.ts")).preCheckOf(app, rootRunId);
    const freshTask = first ? [
      `# 原始任务\n\n${first}${checked ? `\n\n${(await import("./pre-check.ts")).preCheckText(checked, "coder")}` : ""}${going ? `\n\n${dw.designCoderText(app, going)}` : ""}`,
      `# 之前各轮已经做的\n\n这是一个新会话。之前各轮的改动都在工作区里${commits ? `，工作分支上的提交：\n\n${fence("", commits)}` : ""}\n\n需要时用 git log / git diff 看具体改动，不要重做。${before ? `\n\n上一轮编码 Agent 的说明：\n\n${truncate(before, 4000)}` : ""}`,
      coderTask,
    ].join("\n\n") : coderTask;
    // A task-driven round may hand groups of its tasks to helpers coding beside it (code-helpers.ts).
    const helpers = taskMode && app.config.agents.autoAdvance.parallelCoders ? await import("./code-helpers.ts") : null;
    helpers?.registerRound(run.id, {
      signal: ctx.signal,
      event: ctx.event,
      worktrees,
      repos,
      execution: input.execution,
      spaces,
      where: (dir, wt) => {
        const command = commandFor(repos.find((r) => r.id === wt.space)!);
        return `## 工作区\n\n${wt.space}：${dir}（独立的 worktree）${command ? `\n检查命令：${command}` : ""}`;
      },
    });
    // …and its tasks are verified while it codes on, what is not fixed coming back to it (code-overlap.ts).
    const overlap = taskMode ? await import("./code-overlap.ts") : null;
    overlap?.openRound(app, run.id, { event: ctx.event, signal: ctx.signal });
    let coder: Awaited<ReturnType<typeof runCoder>>;
    let reply: string;
    try {
      try {
        coder = await runCoder(resumeCoder ? coderTask : freshTask, resumeCoder);
      } catch (e) {
        if (!resumeCoder || ctx.signal.aborted) throw e;
        // The previous session is gone (cleaned up, or the backend cannot resume it): the worktree
        // still has the changes, so a new session carries on from there.
        ctx.event("status", { phase: "coder", text: `没能接上上一轮的编码会话（${truncate((e as Error).message, 200)}），换新会话继续` });
        coder = await runCoder(freshTask);
      }
      if (previousSession && coder.sessionId && previousSession !== coder.sessionId)
        await retireRecordedSession(app, previousSession, e => ctx.event(e.type, { ...e, phase: "coder" }));
      // What the owner added while it worked and it did not pick up at an omem tool call: one more turn
      // in the same session, before the checks (code-steer.ts).
      reply = replyOf(coder);
      for (let i = 0; i < 3 && !ctx.signal.aborted && coder.sessionId; i++) {
        const notes = pendingNotes(app, run.id);
        if (!notes.length) break;
        markNotesDelivered(app, run.id, notes);
        ctx.event("status", { phase: "coder", text: `把 ${notes.length} 条本人补充交给编码 Agent，接着改` });
        coder = await runCoder(notesText(notes), coder.sessionId);
        reply = `${reply}\n\n## 按本人补充继续\n\n${replyOf(coder)}`;
      }
      // Its turn is over: the checks verify what it finished; what is not fixed, what a second look found
      // meanwhile and what it has not got to come back in the same session, for up to FOLLOW_UPS more
      // turns while each one gets something done (a task finished or reported, the code changed).
      const { listTasks } = await import("./code-tasks.ts");
      const progress = () => JSON.stringify([
        overlap ? listTasks(app, rootRunId).filter((t) => t.coderRun === run.id).map((t) => [t.seq, t.state]) : [],
        worktrees.map((wt) => `${git(workDirOf(wt), ["rev-parse", "HEAD"]).stdout}${git(workDirOf(wt), ["status", "--porcelain"]).stdout}`),
      ]);
      let mark = progress();
      for (let i = 0, moved = true; overlap && !ctx.signal.aborted; i++) {
        const more = i < FOLLOW_UPS && moved && !!coder.sessionId;
        const back = await overlap.settleTurn(app, run.id, more);
        if (!more || !back || ctx.signal.aborted) break;
        const notes = pendingNotes(app, run.id);
        if (notes.length) markNotesDelivered(app, run.id, notes);
        ctx.event("status", { phase: "coder", text: back.includes("## 这一轮还没做的项") ? "这一轮还有项没做，让编码 Agent 在同一会话里接着做" : "把评审的反馈交给编码 Agent，在这一轮接着改" });
        coder = await runCoder([back, notes.length ? notesText(notes) : ""].filter(Boolean).join("\n\n"), coder.sessionId);
        reply = `${reply}\n\n## 接着做\n\n${replyOf(coder)}`;
        const now = progress();
        moved = now !== mark;
        mark = now;
      }
    } finally {
      // The helpers finish, and what they committed is picked onto the work branch (conflicts to the coder).
      if (helpers) helperRuns = await helpers.joinHelpers(app, run.id, (wt, files, label) => resolverFor(wt)(files, label));
      await overlap?.closeRound(app, run.id);
    }
    if (helperRuns.length) reply = `${reply}\n\n## 编码助手\n\n${helperRuns.map((id) => { const h = getRun(app, id); return `- ${h.title}：${h.status === "done" ? truncate(String(h.output.answer ?? ""), 600) : `没做完（${h.error ?? h.status}）`}`; }).join("\n")}`;
    ctx.output({ coderSummary: reply.trim(), coderAI: coder!.ai, coderAgent: coder!.profileId, coderSessionId: coder!.sessionId, coderContext: coder!.contextUsage });
    return reply;
  }

  const results: RepoResult[] = [];
  const diffs: string[] = [];
  for (const [i, repo] of repos.entries()) {
    const wt = worktrees[i];
    const command = commandFor(repo);
    let check: Check | null = null;
    if (command) {
      ctx.event("status", { text: `运行检查${multi ? `（${repo.id}）` : ""}：${command}` });
      // Where the change starts, for a command that checks only what it touches (`git diff --name-only $OMEM_BASE`).
      const base = wt.commits ? changeBase(wt.path, wt) : git(wt.path, ["rev-parse", "HEAD"]).stdout.trim();
      // Screenshots and reports the check writes to OMEM_ARTIFACTS become the round's artifacts.
      const { artifactInbox, collectInbox, takenText } = await import("./artifacts.ts");
      const r = await shell(command, workDirOf(wt), ctx.signal, undefined, { ...(base ? { OMEM_BASE: base } : {}), OMEM_ARTIFACTS: artifactInbox(app, run.id) });
      check = { command, ...r, output: r.output.slice(-8000), ...(base ? { base } : {}), at: new Date().toISOString() };
      const taken = await collectInbox(app, run.id, { source: "check", by: "host", caption: `检查${multi ? `（${repo.id}）` : ""}：${command}` });
      if (taken.made.length || taken.skipped.length) ctx.event("status", { text: takenText(taken) });
    }
    if (wt.commits) {
      // Whatever is left uncommitted becomes this round's last commit; then it goes onto the branch.
      const round = Number(run.input.round ?? 1);
      const settled = settleRound(repo.rootPath!, wt, `${truncate(run.title, 60)}（第 ${round} 轮没提交的改动）`);
      const tell = (text: string) => ctx.event("status", { text: `${multi ? `${repo.id}：` : ""}${text}` });
      if (settled.committed) tell(`把没提交的改动提交为 ${settled.committed.slice(0, 8)}`);
      if (settled.renamed) tell(`分支 ${settled.renamed} 改名为 ${settled.branch}`);
      if (settled.followed) tell(`${settled.followed} 已快进到 ${settled.branch} 的最新提交`);
      if (settled.followError) {
        tell(settled.followError);
        notify(app, { title: `提交没能放回分支：${run.title}`, body: settled.followError, link: `#/runs/${run.id}` });
      }
      ctx.output({ worktrees });
      if (rootRunId !== run.id) setRunOutput(app, rootRunId, { worktrees });
      // The check ran on the tree this commit holds (what was left uncommitted is in it now).
      if (check) check.commit = git(wt.path, ["rev-parse", "HEAD"]).stdout.trim() || undefined;
    } else git(wt.path, ["add", "-A"]);
    if (check) ctx.event("check", { ...check, space: repo.id });
    const range = changeRange(wt);
    const diff = git(wt.path, ["diff", "--no-color", ...range]).stdout;
    const stat = git(wt.path, ["diff", "--stat", ...range]).stdout.trim();
    writeFileSync(patchFile(app, run.id, repo.id), diff);
    const ignored = ignoredAdded(wt);
    results.push({ space: repo.id, diffStat: stat, diffBytes: diff.length, check, ...(ignored.length ? { ignored } : {}), ...(wt.commits ? { base: range[0] } : {}) });
    if (diff.trim()) diffs.push(multi ? `### ${repo.id}\n\n${fence("diff", diff)}` : fence("diff", diff));
  }
  const statText = results.filter((r) => r.diffStat).map((r) => (multi ? `[${r.space}]\n${r.diffStat}` : r.diffStat)).join("\n\n");
  ctx.output({ repos: results, diffStat: statText, diffBytes: results.reduce((n, r) => n + r.diffBytes, 0), check: multi ? undefined : results[0].check });
  if (taskMode) {
    const tasks = await import("./code-tasks.ts");
    // The coder did not split: the whole task is one.
    if (!tasks.listTasks(app, rootRunId).length) {
      const t = tasks.addTask(app, rootRunId, { title: run.title, doneWhen: "", kind: "build", state: "coding" }, "host");
      tasks.updateTask(app, rootRunId, t.seq, { coderRun: run.id });
    }
    const { checkpoint, finished } = tasks.settleCodingRound(app, rootRunId, run.id, worktrees, Number((input as { round?: number }).round ?? 1), helperRuns);
    if (checkpoint) ctx.event("status", { text: `检查点 ${checkpoint.seq}：${finished.length ? `完成 ${finished.map(tasks.taskLabel).join("、")}` : "这一轮没有完成的修改项"}` });
  }
  // Only Git work on a work branch: its commits are on the branch already, and what came in is not this work to review.
  if (skipCoder && worktrees.some((w) => w.commits)) {
    ctx.output({ verdict: "synced" });
    notify(app, { title: `同步完成：${run.title}`, body: truncate(synced && typeof synced === "object" ? synced.summary : coderReply, 600), link: `#/runs/${run.id}` });
    return { verdict: "synced" };
  }
  if (!diffs.length && !taskMode) {
    // Only Git work (a merge, a pull): its commits are what gets applied, by fast-forward.
    if (worktrees.some((w) => w.syncHead)) {
      ctx.output({ verdict: "synced" });
      notify(app, { title: `同步完成，可以应用：${run.title}`, body: truncate(synced && typeof synced === "object" ? synced.summary : coderReply, 600), link: `#/runs/${run.id}` });
      return { verdict: "synced" };
    }
    notify(app, { title: `${input.branches ? "分支相对基线没有改动" : "交办未产生改动"}：${run.title}`, body: truncate(coderReply, 400), link: `#/runs/${run.id}` });
    return { verdict: "no-changes" };
  }
  // The same change moved onto a newer target without conflicts: the last review still holds.
  if (input.moveToTarget && synced && typeof synced === "object" && !synced.conflicts) {
    const previous = chain?.rounds.filter((id) => id !== run.id).map((id) => getRun(app, id)).at(-1);
    ctx.output({ verdict: previous?.output.verdict ?? null, reviewSkipped: "改动没变，只是移到了目标分支的最新提交上，沿用上一轮的评审" });
    notify(app, { title: `已移到目标分支最新提交，可以应用：${run.title}`, body: truncate(synced.summary, 600), link: `#/runs/${run.id}` });
    return { verdict: String(previous?.output.verdict ?? "moved") };
  }

  // What changed becomes searchable (spaces wt-…) for the reviewer and afterwards.
  const indexed: string[] = [];
  for (const [i, r] of results.entries()) {
    if (!r.diffBytes) continue;
    try {
      indexed.push((await indexWorktree(app, run.id, worktrees[i])).space);
    } catch (e) {
      ctx.event("status", { text: `${r.space} 的改动没能建索引：${(e as Error).message}` });
    }
  }
  ctx.output({ indexedSpaces: indexed });

  if (taskMode) {
    const { taskReview } = await import("./code-loop.ts");
    return taskReview(app, run.id, { runId: run.id, signal: ctx.signal, event: ctx.event });
  }
  const { planReview, refineReviewPlan } = await import("./review.ts");
  const { askModel } = await import("./oneshot.ts");
  const previousPlan = chain?.rounds.filter((id) => id !== run.id).map((id) => getRun(app, id).output.reviewPlan as ReviewPlan | undefined).filter(Boolean).at(-1);
  // The owner's choice for this round on (read now: it may have been set while the round coded).
  const owned = (getRun(app, run.id).input as { roundReview?: RoundReview }).roundReview;
  const ownerSays = !!(owned?.tier || owned?.checks?.length);
  let plan = planReview(app, reviewMetrics(worktrees, results, input.task), ownerSays
    ? { tier: owned!.tier ?? input.reviewTier, extraChecks: owned!.checks?.length ? [] : input.reviewChecks, only: owned!.checks }
    : { tier: input.reviewTier, extraChecks: input.reviewChecks, previous: previousPlan });
  if (ownerSays) {
    plan = { ...plan, confirmPlan: false, reasons: [...plan.reasons, `本人指定这一轮起的评审：${owned!.checks?.length ? `只做 ${plan.checks.join("、")}` : `「${plan.tierName}」档`}${owned!.split === false ? "，不拆需求" : ""}`] };
  } else if (input.peerReviewer) {
    // The outside Agent reviews and nobody here rules: no triage, no lead, no plan to confirm.
    plan = { ...plan, lead: false, confirmPlan: false, rotateModels: false, reasons: [...plan.reasons, `由设备 ${input.peerReviewer.caller} 的外部 Agent 评审`] };
  } else if (!previousPlan) {
    // Triage after coding: the owner's words on tiers and checks, review-lead's estimate, and with a
    // lead one step lighter when the change turned out small. Weighed once, on the first round.
    const estimate = getRun(app, run.id).output.reviewEstimate as ReviewEstimate | undefined;
    plan = await refineReviewPlan(app, plan, { task: input.task, diff: diffs.join("\n\n"), tierNamed: !!input.reviewTier, estimate }, (p) => askModel(app, p, { timeoutMs: 90_000, signal: ctx.signal }));
  } else if (input.reviewOnly?.length) {
    // Named by review-lead, or the checks whose findings the owner chose to fix (review-fix.ts).
    const only = plan.checks.filter((c) => input.reviewOnly!.includes(c));
    if (only.length) plan = { ...plan, checks: only, reasons: [...plan.reasons, `这一轮只复审要改的问题所在的评审项：${only.join("、")}（每 ${app.config.review.rereviewAllEvery} 轮全部重审）`] };
  }
  ctx.output({ reviewPlan: plan });
  const { askPlan, reviewRound } = await import("./review-chain.ts");
  if (input.peerReviewer) {
    // The run ends here so it holds no slot while the other device reviews; its last submission
    // queues the `review` run that rules (review-chain.ts, peerSubmitted).
    ctx.event("status", { text: `评审项「${plan.checks.join("、")}」等设备 ${input.peerReviewer.caller} 的外部 Agent 提交（review_task 取材料）` });
    ctx.output({ verdict: "awaiting-peer", reviewStage: "peer" });
    return { verdict: "awaiting-peer" };
  }
  if (plan.confirmPlan && !previousPlan) {
    const ask = askPlan(app, getRun(app, run.id), chain, plan);
    ctx.event("status", { text: `评审计划「${plan.tierName}」档等本人确认后开始` });
    ctx.output({ verdict: "awaiting-plan", reviewStage: "plan", reviewAskId: ask.id });
    return { verdict: "awaiting-plan" };
  }
  return reviewRound(app, run.id, { runId: run.id, signal: ctx.signal, event: ctx.event });
}

/**
 * Check out an existing branch for review: a detached worktree at the branch tip whose HEAD is
 * moved back to where it left the base (`reset --soft`), so its changes are staged against HEAD
 * like a delegation's and the diff, metrics, index and file views work unchanged.
 */
async function checkoutBranch(app: App, repo: Space, runId: string, target: { branch: string; base?: string } | undefined, path: string, fetch: boolean, log: (text: string) => void): Promise<WorktreeRef> {
  if (!target?.branch) throw new HttpError(400, `没有指定 ${repo.id} 要评审的分支`);
  const root = repo.rootPath!;
  const baseRef = target.base || defaultBaseRef(root);
  if (!baseRef) throw new HttpError(400, `${repo.id} 找不到默认分支（main / master），请指定基线分支`);
  if (fetch) for (const name of new Set([target.branch, baseRef])) await fetchBranchAsync(root, name);
  const tip = resolveRef(root, target.branch);
  if (!tip) throw new HttpError(404, `${repo.id} 里没有分支 ${target.branch}`);
  const baseTip = resolveRef(root, baseRef);
  if (!baseTip) throw new HttpError(404, `${repo.id} 里没有基线 ${baseRef}`);
  const mb = git(root, ["merge-base", baseTip.commit, tip.commit]);
  if (!mb.ok) throw new HttpError(400, `${target.branch} 和 ${baseRef} 没有共同的提交`);
  const base = mb.stdout.trim();
  const slot = addWorktree(app, repo, runId, path, tip.commit, log)?.path;
  const reset = git(path, ["reset", "-q", "--soft", base]);
  if (!reset.ok) throw new Error(`在 ${repo.id} 准备评审工作区失败：${reset.stderr}`);
  return { space: repo.id, path, branch: "", base, ref: target.branch, tip: tip.commit, baseRef, ...(slot ? { slot } : {}) };
}

/** A worktree for reviewing a branch at `path`, detached at `commit`: a lent slot (returned) or a new one. */
export function addWorktree(app: App, repo: Space, runId: string, path: string, commit: string, log: (text: string) => void): { path: string } | undefined {
  const slot = leaseWorkspace(app, repo, runId, path, log);
  if (slot) {
    const moved = git(slot.path, ["checkout", "-q", "--detach", commit]);
    if (moved.ok) return slot;
    releaseWorkspace(runId, { path, slot: slot.path });
    log(`工作区 ${slot.path} 没能切到 ${commit.slice(0, 8)}，改为新建工作区：${moved.stderr.trim().slice(0, 300)}`);
  }
  const r = git(repo.rootPath!, ["worktree", "add", "-q", "--detach", path, commit]);
  if (!r.ok) throw new Error(`在 ${repo.id} 创建工作区失败：${r.stderr}`);
  return undefined;
}

/** What the reviewers read in place of a coding Agent's summary: the branch and its commits. */
function branchSummary(worktrees: WorktreeRef[]) {
  return worktrees.map((wt) => {
    const log = git(wt.path, ["log", "--no-color", "--format=- %h %an %ad %s", "--date=short", "-n", "60", `${wt.base}..${wt.tip}`]).stdout.trim();
    return `${worktrees.length > 1 ? `### ${wt.space}\n\n` : ""}这是对已有分支的评审，没有编码这一步：${wt.space} 的分支 ${wt.ref}（${wt.tip!.slice(0, 8)}）相对 ${wt.baseRef}，从分叉点 ${wt.base.slice(0, 8)} 起的改动。工作区的文件就是分支最新的代码；为了让改动显示成 diff，HEAD 特意放在分叉点、分支的改动暂存着（\`git diff --cached\` 能看到），这是正常的检出状态，不要在结论或修改单里要求“确认分支”或“切到正确的提交”。\n\n提交：\n${log || "（没有提交）"}`;
  }).join("\n\n");
}

/** What a worktree's change is measured as: a work branch against where it starts, an older delegation's staged change against HEAD. */
function changeRange(wt: WorktreeRef) {
  return wt.commits ? [changeBase(wt.path, wt), "HEAD"] : ["--cached", "HEAD"];
}

/**
 * Files the change adds although the repository ignores them: generated code, dependencies or build
 * output someone forced in with `git add -f`. A fresh checkout regenerates them, so they drift.
 */
export function ignoredAdded(wt: WorktreeRef): IgnoredFiles[] {
  const added = git(wt.path, ["diff", "--name-only", "--diff-filter=A", "-z", ...changeRange(wt)]).stdout;
  if (!added) return [];
  // -v gives source, line, pattern and path per file; a `!` pattern is a match that keeps the file.
  const f = git(wt.path, ["check-ignore", "-v", "--no-index", "--stdin", "-z"], added).stdout.split("\0");
  const by = new Map<string, IgnoredFiles>();
  for (let i = 0; i + 3 < f.length; i += 4) {
    if (f[i + 2].startsWith("!")) continue;
    const g = by.get(f[i + 2]) ?? { pattern: f[i + 2], files: 0, example: f[i + 3] };
    g.files++;
    by.set(g.pattern, g);
  }
  return [...by.values()];
}

/** The ignored files of each repository as a list: the pattern, how many, one of them. */
export function ignoredText(repos: { space: string; ignored?: IgnoredFiles[] }[]) {
  const multi = repos.length > 1;
  return repos.flatMap((r) => (r.ignored ?? []).map((g) => `- ${multi ? `${r.space}：` : ""}\`.gitignore\` 的 \`${g.pattern}\`：${g.files} 个文件（如 \`${g.example}\`）`)).join("\n");
}

/** What review tiers are chosen by: the size and place of the change, whether checks passed. */
export function reviewMetrics(worktrees: WorktreeRef[], results: RepoResult[], task: string): ReviewMetrics {
  let lines = 0;
  let codeLines = 0;
  const paths: string[] = [];
  for (const [i, r] of results.entries()) {
    if (!r.diffBytes) continue;
    for (const row of git(worktrees[i].path, ["diff", "--numstat", ...changeRange(worktrees[i])]).stdout.split("\n")) {
      const [add, del, file] = row.split("\t");
      if (!file) continue;
      const n = (Number(add) || 0) + (Number(del) || 0);
      lines += n;
      if (isSourceFile(file)) codeLines += n;
      paths.push(results.length > 1 ? `${r.space}/${file}` : file);
    }
  }
  return {
    "change.lines": lines,
    "change.codeLines": codeLines,
    "change.files": paths.length,
    "change.repos": results.filter((r) => r.diffBytes).length,
    "change.paths": paths,
    "change.checksPassed": results.every((r) => !r.check || r.check.code === 0),
    "task.text": task,
  };
}

/** Each repository's patch file; runs from before multi-repository delegation have one changes.patch. */
function patchFiles(app: App, runId: string): { space: string; file: string }[] {
  const r = getRun(app, runId);
  const legacy = join(app.runsDir, runId, "changes.patch");
  if (existsSync(legacy)) return r.spaceId ? [{ space: r.spaceId, file: legacy }] : [];
  const repos = (r.output as { repos?: RepoResult[] }).repos ?? [];
  return repos.map((x) => ({ space: x.space, file: patchFile(app, runId, x.space) })).filter((x) => existsSync(x.file));
}

export function codePatches(app: App, runId: string): { space: string; patch: string }[] {
  return codeDiffView(app, runId).patches;
}

/**
 * A round's patches and diff stat as the run page and reviewers see them. Rounds on a reused
 * branch from before `diffBase` (code-branch.ts withDiffBase) saved a diff from the branch's old
 * local commit, so everything the sync pulled from origin showed as theirs: when the round's end
 * commit is known (its check or checkpoint), the diff is taken again from the corrected base.
 * Nothing is written back.
 */
export function codeDiffView(app: App, runId: string): { output: Run["output"]; patches: { space: string; patch: string }[] } {
  const run = getRun(app, runId);
  const patches = patchFiles(app, runId)
    .map((p) => ({ space: p.space, patch: readFileSync(p.file, "utf8") }))
    .filter((p) => p.patch.trim());
  const repos = (run.output as { repos?: RepoResult[] }).repos;
  if (run.kind !== "code" || !repos?.some((r) => !r.base)) return { output: run.output, patches };
  const first = String(run.input.continueFrom ?? run.id);
  const worktrees = worktreesOf(app, first);
  const cp = all<{ heads: string }>(app.db, "select heads from code_checkpoints where work_id = ? and by = ? order by seq desc limit 1", first, runId)[0];
  const heads = cp ? (JSON.parse(cp.heads) as Record<string, string>) : {};
  let changed = false;
  const fixed = repos.map((r) => {
    const wt = worktrees.find((w) => w.space === r.space);
    const to = r.check?.commit ?? heads[r.space];
    if (r.base || !wt?.commits || !wt.diffBase || !to) return r;
    const dir = existsSync(wt.path) ? wt.path : findSpace(app, wt.space)?.rootPath;
    const from = dir ? changeBase(dir, wt, to) : null;
    if (!dir || !from || from === (wt.start ?? wt.base)) return r;
    const diff = git(dir, ["diff", "--no-color", from, to]);
    if (!diff.ok) return r;
    changed = true;
    const i = patches.findIndex((p) => p.space === r.space);
    if (i >= 0) patches.splice(i, 1);
    if (diff.stdout.trim()) patches.push({ space: r.space, patch: diff.stdout });
    return { ...r, base: from, diffStat: git(dir, ["diff", "--stat", from, to]).stdout.trim(), diffBytes: diff.stdout.length };
  });
  if (!changed) return { output: run.output, patches };
  const multi = fixed.length > 1;
  return {
    output: { ...run.output, repos: fixed, diffStat: fixed.filter((r) => r.diffStat).map((r) => (multi ? `[${r.space}]\n${r.diffStat}` : r.diffStat)).join("\n\n"), diffBytes: fixed.reduce((n, r) => n + r.diffBytes, 0) },
    patches,
  };
}

function branchFromRef(ref: string): string | null {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length).split("/").slice(1).join("/");
  return null;
}

export type AppliedTarget = { space: string; path: string; branch: string | null };
type ApplyTarget = AppliedTarget & { root: string; file: string; create: boolean; newBranch?: boolean; start?: string; syncHead?: string; startCommit?: string };

/** Resolve the original branch without switching the user's checkout or writing anything. */
function applyTargets(app: App, runId: string): ApplyTarget[] {
  const r = getRun(app, runId);
  const first = getRun(app, String(r.input.continueFrom ?? r.id));
  if (r.kind !== "code" || r.status !== "done") throw new HttpError(400, "只能应用已完成的编码运行");
  if (isBranchReview(r)) throw new HttpError(400, "分支评审只给评审意见，没有可应用的改动；要改，基于该分支交办编码（from_branch）");
  if (r.output.appliedAt || first.output.appliedAt) throw new HttpError(409, "这次交办已经应用过");
  if (r.output.discardedAt || first.output.discardedAt) throw new HttpError(409, "这次交办已经丢弃");
  if ((first.output.syncPending as unknown[] | undefined)?.length) throw new HttpError(409, "还有没处理完的 Git 冲突，先在提醒卡片里继续或放弃这次同步");
  const wts = worktreesOf(app, first.id);
  const withPatch = patchFiles(app, runId).filter(p => readFileSync(p.file, "utf8").trim());
  // A space with only sync commits (a merge, a pull) is applied too, by fast-forward.
  const all = [...withPatch, ...wts.filter(w => w.syncHead && !withPatch.some(p => p.space === w.space)).map(w => ({ space: w.space, file: "" }))];
  const targets = all.map((p): ApplyTarget => {
    const root = getSpace(app, p.space).rootPath;
    if (!root) throw new HttpError(400, `空间 ${p.space} 没有关联目录`);
    const wt = wts.find(w => w.space === p.space);
    // Worked on in the main directory: the changes are already where they would be applied.
    if (wt?.inPlace) {
      const current = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || null;
      if (wt.targetBranch && current !== wt.targetBranch) throw new HttpError(409, `仓库主目录 ${root} 已不在分支 ${wt.targetBranch} 上（现在是 ${current ?? "游离 HEAD"}），切回去再应用`);
      return { space: p.space, file: "", root, path: root, branch: current, create: false };
    }
    const sync = wt?.syncHead ? { syncHead: wt.syncHead, startCommit: wt.start ?? wt.base } : {};
    const from = (first.input as CodeInput).fromBranches?.[p.space] ?? wt?.baseRef;
    const target = wt?.targetBranch !== undefined ? wt.targetBranch : from ? branchFromRef(resolveRef(root, from)?.ref ?? `refs/heads/${from.replace(/^refs\/heads\//, "").replace(/^origin\//, "")}`) : undefined;
    const current = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || null;
    if (!target) {
      if (target === null && wt?.base && git(root, ["rev-parse", "HEAD"]).stdout.trim() !== wt.base)
        throw new HttpError(409, `空间 ${p.space} 基于指定提交 ${wt.base.slice(0, 12)}，请核对接收版本后重试`);
      return { ...p, ...sync, root, path: root, branch: current, create: false };
    }
    if (!git(root, ["check-ref-format", `refs/heads/${target}`]).ok) throw new HttpError(400, "目标分支名称无效");
    const listed = git(root, ["worktree", "list", "--porcelain", "-z"]);
    if (!listed.ok) throw new HttpError(409, `读取 ${p.space} 的分支工作区失败：${listed.stderr}`);
    const checkedOut = listed.stdout.split("\0\0").map(block => block.split("\0")).find(fields => fields.includes(`branch refs/heads/${target}`));
    // Git lists paths with forward slashes on Windows; the native form is what the owner copies and compares.
    const listedPath = checkedOut?.find(f => f.startsWith("worktree "))?.slice(9);
    const path = listedPath ? resolve(listedPath) : undefined;
    if (path) {
      if (!existsSync(path)) throw new HttpError(409, `目标分支「${target}」的工作区不存在：${path}`);
      return { ...p, ...sync, root, path, branch: target, create: false };
    }
    const local = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`]).ok;
    const start = local ? `refs/heads/${target}` : resolveRef(root, from ?? target)?.ref;
    if (!start) throw new HttpError(409, `目标分支「${target}」不存在，不能应用`);
    return { ...p, ...sync, root, path: join(app.runsDir, first.id, "applied", p.space), branch: target, create: true, newBranch: !local, start };
  });
  // A directory another delegation is coding in (the main directory, lent “直接在主目录里改”): applying
  // there would mix both changes, and discarding that one would wipe this one out.
  for (const t of targets) {
    const by = t.create ? null : leasedTo(app, t.path);
    if (by && by !== first.id) throw new HttpError(409, `${t.path} 正借给交办 ${by}（直接在主目录里改），它还没应用或丢弃；现在应用会把两次的改动混在一起。先应用或丢弃那次交办，再应用这次`);
  }
  return targets;
}

/**
 * Folders an editor can open for a coding run (docs/v2/ide.md): its worktrees while they exist (a
 * reused slot by its own path), and where the change landed once applied.
 */
export function codeFolders(app: App, runId: string): { space: string; path: string; kind: "work" | "applied"; branch: string | null }[] {
  const r = getRun(app, runId);
  if (r.kind !== "code") return [];
  const rootId = String(r.input.continueFrom ?? r.id);
  const applied = (getRun(app, rootId).output.appliedTo ?? r.output.appliedTo) as AppliedTarget[] | undefined;
  if (applied?.length) return applied.filter((t) => existsSync(t.path)).map((t) => ({ space: t.space, path: t.path, kind: "applied", branch: t.branch }));
  return worktreesOf(app, rootId).flatMap((w) => {
    if (existsSync(w.path)) return [{ space: w.space, path: workDirOf(w), kind: "work" as const, branch: w.branch || w.ref || null }];
    // A work branch between rounds: where it is checked out, if anywhere.
    const root = w.commits ? findSpace(app, w.space)?.rootPath : null;
    const at = root ? checkedOutAt(root, w.branch) : null;
    return at ? [{ space: w.space, path: at, kind: "work" as const, branch: w.branch }] : [];
  });
}

/**
 * The delegations whose folder (worktree, reused slot or applied target) `folder` is, newest first,
 * with their rounds: how an editor opened on that folder finds its run (docs/v2/ide.md).
 */
export function codeRunsAt(app: App, folder: string, userId: string | null) {
  const norm = (p: string) => {
    let r = resolve(p);
    try {
      r = realpathSync(r);
    } catch {}
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const want = norm(folder);
  const roots = all<{ id: string; user_id: string | null }>(app.db, "select id, user_id from runs where kind = 'code' and json_extract(input, '$.continueFrom') is null order by created_at desc limit 300");
  const out: { id: string; rounds: string[]; title: string; status: string; space: string | null; folder: "work" | "applied" }[] = [];
  for (const root of roots) {
    if (userId && root.user_id !== userId) continue;
    const hit = codeFolders(app, root.id).find((f) => norm(f.path) === want);
    if (!hit) continue;
    const rounds = all<{ id: string }>(app.db, "select id from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?) order by created_at", root.id, root.id).map((x) => x.id);
    const last = getRun(app, rounds.at(-1)!);
    out.push({ id: last.id, rounds, title: last.title, status: last.status, space: last.spaceId, folder: hit.kind });
  }
  return out;
}

/** Preview for the confirmation dialog; creating branch worktrees happens only on apply. */
export function codeApplyTargets(app: App, runId: string): AppliedTarget[] {
  const wts = worktreesOf(app, String(getRun(app, runId).input.continueFrom ?? runId));
  // A work branch is pushed, not applied: where it is checked out (or the repository), and its name.
  if (isBranchWork(wts)) return wts.filter((w) => w.commits).map((w) => {
    const root = findSpace(app, w.space)?.rootPath ?? "";
    return { space: w.space, path: (root && checkedOutAt(root, w.branch)) || root, branch: w.branch };
  });
  return applyTargets(app, runId).map(({ space, path, branch }) => ({ space, path, branch }));
}

/** Remove the run's worktrees and branches, and the temporary index of what they changed. */
function removeWorktrees(app: App, runId: string, opts: { applied?: boolean } = {}) {
  const leasedBy = String(getRun(app, runId).input.continueFrom ?? runId);
  for (const wt of worktreesOf(app, runId)) {
    if (wt.commits) continue;
    const root = findSpace(app, wt.space)?.rootPath;
    if (!root || !existsSync(root)) continue;
    // A reusable slot is reset and kept for the next run; the main directory keeps an applied run's changes.
    if (!releaseWorkspace(leasedBy, wt, { keep: opts.applied && wt.inPlace })) {
      if (existsSync(wt.path)) git(root, ["worktree", "remove", "--force", wt.path]);
      else git(root, ["worktree", "prune"]);
    }
    if (wt.branch) git(root, ["branch", "-D", wt.branch]);
  }
  for (const s of worktreeSpacesOf(app, runId)) dropWorktreeSpace(app, s.id);
}

/**
 * Apply a finished run's patches to the user's working trees as uncommitted changes, every
 * repository or none (all are checked first). The worktrees are removed afterwards; the
 * patches stay with the run.
 *
 * `keepWorking` (“先应用到原分支，再接着改”): the worktrees stay for the next round. What was
 * applied is committed there and becomes the new start, so later rounds' diffs (and the next
 * apply) hold only what came after.
 */
export function applyCodeRun(app: App, runId: string, opts: { keepWorking?: boolean; squash?: string; force?: boolean } = {}) {
  const r = getRun(app, runId);
  if (isBranchWork(worktreesOf(app, String(r.input.continueFrom ?? r.id)))) {
    // The commits are on the branch already (and in the main directory when it has the branch).
    if (opts.keepWorking) return { applied: false, spaces: [] as string[], targets: [] as AppliedTarget[] };
    if (r.kind !== "code" || isBranchReview(r)) throw new HttpError(400, "只有编码交办能确认");
    return confirmBranchRun(app, runId, { squash: opts.squash, force: opts.force });
  }
  const targets = applyTargets(app, runId);
  if (!targets.length) throw new HttpError(404, "没有可应用的改动");
  const created: (ApplyTarget & { createdHead: string })[] = [];
  const forwarded: { target: ApplyTarget; before: string }[] = [];
  const applied: string[] = [];
  let applying = false;
  try {
    for (const t of targets.filter(t => t.create)) {
      mkdirSync(dirname(t.path), { recursive: true });
      const made = git(t.root, ["worktree", "add", ...(t.newBranch ? ["-b", t.branch!] : []), t.path, t.newBranch ? t.start! : t.branch!]);
      if (!made.ok) throw new HttpError(409, `为目标分支「${t.branch}」建立工作区失败：${made.stderr}`);
      created.push({ ...t, createdHead: git(t.path, ["rev-parse", "HEAD"]).stdout.trim() });
    }
    for (const t of targets) {
      if (t.branch && git(t.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() !== t.branch)
        throw new HttpError(409, `接收目录 ${t.path} 的分支已变化，请重新应用`);
      // The target may have advanced within the synced history, or already contain it.
      const at = git(t.path, ["rev-parse", "HEAD"]).stdout.trim();
      if (t.syncHead && !git(t.path, ["merge-base", "--is-ancestor", at, t.syncHead]).ok && !git(t.path, ["merge-base", "--is-ancestor", t.syncHead, at]).ok)
        throw new HttpError(409, `${t.branch ?? t.space} 在交办之后有了新提交，同步的结果不能直接快进；点“移到目标分支最新提交”重做一次再应用`);
    }
    // Fast-forward first (the patch is relative to the synced commits), undone if a patch then fails.
    for (const t of targets.filter(t => t.syncHead)) {
      const before = git(t.path, ["rev-parse", "HEAD"]).stdout.trim();
      const ff = git(t.path, ["merge", "--ff-only", t.syncHead!]);
      if (!ff.ok) throw new HttpError(409, `快进 ${t.branch ?? t.space} 失败（接收目录里的修改和同步的提交冲突？）：${ff.stderr.slice(0, 800)}`);
      if (git(t.path, ["rev-parse", "HEAD"]).stdout.trim() !== before) forwarded.push({ target: t, before });
    }
    for (const t of targets.filter(t => t.file)) {
      const check = git(t.path, ["apply", "--check", "--3way", t.file]);
      if (!check.ok) throw new HttpError(409, `${targets.length > 1 ? `${t.space}：` : ""}无法干净应用到 ${t.branch ?? "指定版本"}（${t.path}）：${check.stderr.slice(0, 1000)}；目标分支变了的话，点“移到目标分支最新提交”重做一次`);
    }
    applying = true;
    for (const t of targets.filter(t => t.file)) {
      const res = git(t.path, ["apply", "--3way", t.file]);
      if (!res.ok) throw new HttpError(409, `应用到 ${t.path} 失败${applied.length ? `（${applied.join("、")} 已应用）` : ""}：${res.stderr.slice(0, 1000)}`);
      applied.push(t.space);
    }
  } catch (error) {
    // Preflight failed: remove only the clean worktrees/branches this attempt created.
    // After application starts, retain every destination for recovery, even on failure.
    if (!applying) for (const { target, before } of forwarded.reverse()) git(target.path, ["reset", "-q", "--keep", before]);
    if (!applying) for (const t of created.reverse()) {
      const removed = git(t.root, ["worktree", "remove", t.path]);
      if (removed.ok && t.newBranch && git(t.root, ["rev-parse", `refs/heads/${t.branch}`]).stdout.trim() === t.createdHead)
        git(t.root, ["branch", "-D", t.branch!]);
    }
    throw error;
  }
  const appliedTo = targets.map(({ space, path, branch }) => ({ space, path, branch }));
  const appliedAt = new Date().toISOString();
  const firstId = String(r.input.continueFrom ?? r.id);
  if (opts.keepWorking) {
    const wts = worktreesOf(app, firstId);
    for (const wt of wts) {
      // The main directory's branch is the owner's: nothing committed there, the work just goes on.
      if (!targets.some((t) => t.space === wt.space) || wt.inPlace) continue;
      git(wt.path, ["add", "-A"]);
      const id = git(wt.path, ["config", "user.email"]).stdout.trim() ? [] : ["-c", "user.name=omem", "-c", "user.email=omem@localhost"];
      const c = git(wt.path, [...id, "commit", "-q", "--no-verify", "--allow-empty", "-m", `omem: 已应用到 ${appliedTo.find((t) => t.space === wt.space)?.branch ?? "原分支"}（第 ${r.input.round ?? 1} 轮）`]);
      if (!c.ok) throw new HttpError(409, `已应用，但没能在工作区 ${wt.path} 记下应用的位置：${c.stderr.slice(0, 400)}`);
      wt.start = git(wt.path, ["rev-parse", "HEAD"]).stdout.trim();
      wt.syncHead = undefined;
    }
    setRunOutput(app, firstId, { worktrees: wts, partlyAppliedTo: appliedTo, partlyAppliedAt: appliedAt });
    // Shown on the run page like a full apply (where it landed, commit there); the work goes on.
    setRunOutput(app, runId, { appliedTo, partlyAppliedAt: appliedAt });
    cancelHostAsks(app, runId, ROUND_ASKS);
    return { applied: true, spaces: applied, targets: appliedTo };
  }
  for (const id of new Set([firstId, runId])) setRunOutput(app, id, { appliedAt, appliedTo });
  removeWorktrees(app, runId, { applied: true });
  for (const id of workRoundIds(app, firstId)) cancelHostAsks(app, id, ROUND_ASKS);
  // Questions its agents still had open lapse with it (ask-expiry.ts).
  lapseWorkAsks(app, firstId);
  return { applied: true, spaces: applied, targets: appliedTo };
}

export function discardCodeRun(app: App, runId: string) {
  const r = getRun(app, runId);
  if (getRun(app, String(r.input.continueFrom ?? r.id)).output.appliedAt && isBranchWork(worktreesOf(app, runId))) throw new HttpError(409, "这次交办已经确认过");
  releaseBranchRun(app, runId, { discard: true });
  removeWorktrees(app, runId);
  setRunOutput(app, runId, { discardedAt: new Date().toISOString() });
  for (const id of workRoundIds(app, String(r.input.continueFrom ?? r.id))) cancelHostAsks(app, id, [...ROUND_ASKS, "code-sync", "work-deliver", "design-confirm"]);
  lapseWorkAsks(app, runId);
}

/** Every round of a delegation or branch review, from its first run. */
function workRoundIds(app: App, rootId: string) {
  return all<{ id: string }>(app.db, "select id from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?)", rootId, rootId).map((x) => x.id);
}

/** What the coding Agent is told when Git stops on conflicts. */
export function conflictTask(wt: WorktreeRef, files: string[], label: string, task: string) {
  return `# 解决 Git 冲突：${label}

仓库 ${wt.space} 的工作区 ${wt.path} 里，下面这些文件有冲突：

${files.map((f) => `- ${f}`).join("\n")}

这次交办的任务（供理解改动意图）：

${truncate(task, 3000)}

要求：
1. 读两边的改动（\`git diff\`、\`git log --merge\`、\`git show :2:<文件>\` / \`:3:<文件>\`），按两边的意图合并，不要简单地选一边丢掉另一边的功能。
2. 业务上拿不准取舍的（两边都改了同一个规则、同一个接口）用 ask_user 问本人，给出选项并说明各自的后果；本人没回答前不要猜。
3. 解决后删掉所有冲突标记，对这些文件 \`git add\`；能跑检查命令就跑一下。
4. 不要 commit，不要继续或中止 merge / rebase / cherry-pick / revert，宿主会接着做。
5. 结束时逐个文件说明怎么解决的；实在解决不了的，说明卡在哪里（会交给本人）。`;
}

const SYNC_GO = "已解决，继续";
const SYNC_STOP = "放弃这次同步";

/** Conflicts the coding Agent could not resolve: the owner resolves them in the worktree, or gives up the sync. */
function askSyncConflict(app: App, run: Run, conversationId: string | null, left: { space: string; label: string; conflicts: string[]; path: string }[]) {
  return createAsk(app, {
    runId: run.id,
    conversationId,
    question: [
      `「${truncate(run.title, 40)}」的 Git 同步有冲突没能自动解决：`,
      ...left.map((l) => `- ${l.space}（${l.label}）：${l.conflicts.join("、")}\n  工作区：${l.path}`),
      "在工作区里解决、对这些文件 git add 之后点“继续”（不用 commit）；也可以放弃这次同步，工作区回到同步前的样子。",
    ].join("\n"),
    options: [{ label: SYNC_GO }, { label: SYNC_STOP }],
    context: { handler: "code-sync", codeRunId: run.id },
  });
}

registerAskHandler("code-sync", async (app, ask, ctx) => {
  const run = getRun(app, String(ctx.codeRunId));
  const rootId = String(run.input.continueFrom ?? run.id);
  const root = getRun(app, rootId);
  if (ask.choice === 1) {
    const { abortSync } = await import("./code-sync.ts");
    for (const wt of worktreesOf(app, rootId)) if (existsSync(wt.path)) abortSync(wt.path);
    setRunOutput(app, rootId, { syncPending: null });
    setRunOutput(app, run.id, { verdict: "sync-aborted" });
    notify(app, { userId: ask.userId, title: `已放弃这次同步：${run.title}`, body: "工作区回到了同步前的样子。", link: `#/runs/${run.id}` });
    return;
  }
  const note = ask.choice === null ? ask.answer ?? "" : (ask.answer ?? "").slice(SYNC_GO.length + 1);
  try {
    await queueGitRound(app, run, `继续 Git 同步（本人已处理冲突）${note.trim() ? `：${note.trim()}` : ""}`, { syncResume: true, syncOnly: !!(root.input as CodeInput).syncOnly || !!(run.input as CodeInput).moveToTarget }, ask.userId);
  } catch (e) {
    notify(app, { userId: ask.userId, title: `没能继续同步：${run.title}`, body: (e as Error).message, link: `#/runs/${run.id}` });
  }
});

/** Queue a round that moves the unapplied work onto the target branch's latest commit. */
export async function queueMoveToTarget(app: App, runId: string, userId = OWNER, mode: "merge" | "rebase" = "merge") {
  const run = getRun(app, runId);
  if (isBranchReview(run)) throw new HttpError(400, "分支评审没有要移动的改动");
  return queueGitRound(app, run, `${mode === "merge" ? "合并目标分支的最新提交，集中处理冲突" : "将改动变基到目标分支的最新提交"}（冲突交给编码 Agent，解决不了找本人）`, { moveToTarget: true, moveToTargetMode: mode }, userId);
}

/** Queue a round that merges or rebases the work branch onto another branch (conflicts to the coding Agent). */
export async function queueSyncRound(app: App, runId: string, sync: { onto: string; mode: "merge" | "rebase" }, userId = OWNER) {
  const run = getRun(app, runId);
  if (isBranchReview(run)) throw new HttpError(400, "分支评审没有工作分支");
  const first = getRun(app, String(run.input.continueFrom ?? run.id));
  if (first.output.appliedAt || first.output.discardedAt) throw new HttpError(409, "这次交办已经确认或丢弃");
  return queueGitRound(app, run, `把 ${sync.onto} ${sync.mode === "rebase" ? "变基" : "合并"}到工作分支上（冲突交给编码 Agent，解决不了找本人）`, { sync: { onto: sync.onto, mode: sync.mode }, syncOnly: true }, userId);
}

/** A round of Git work in the same worktrees: in the delegation's conversation, or standalone (web, CLI). */
async function queueGitRound(app: App, run: Run, task: string, extraInput: Record<string, unknown>, userId: string) {
  const { codeChainFor, queueNextCodeRound } = await import("./code-chain.ts");
  const chain = codeChainFor(app, run);
  if (chain) {
    const next = queueNextCodeRound(app, chain, task, { manual: true, extraInput });
    if (!next) throw new HttpError(409, "原交办记录不完整，无法继续");
    return next.run;
  }
  const { queueStandaloneFix, workRuns } = await import("./review-fix.ts");
  const rootId = String(run.input.continueFrom ?? run.id);
  return queueStandaloneFix(app, rootId, workRuns(app, rootId).at(-1)!, task, userId, extraInput);
}
