import { executionArgs, type Execution } from "./execution.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { App } from "../core/app.ts";
import { defaultBaseRef, fetchBranch, git, isGitRepo, resolveRef } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { cancelHostAsks } from "./asks.ts";
import { findSpace, getSpace, type Space } from "../core/spaces.ts";
import { HttpError, truncate } from "../core/util.ts";
import { resolveRunProfile, runRole } from "./runner.ts";
import type { ReviewEstimate, ReviewMetrics, ReviewPlan } from "./review.ts";
import { createRun, getRun, runUser, setRunOutput, type RunContext } from "./runs.ts";
import { dropWorktreeSpace, indexWorktree, worktreeSpacesOf, type WorktreeRef } from "./worktree-index.ts";
import { replyOf } from "./types.ts";
import { isSourceFile } from "../sources/chunk.ts";
import { OWNER } from "../core/users.ts";
import { linkRunToItem, materialSpaces, materialsBrief } from "../items/materials.ts";

function shell(command: string, cwd: string, signal: AbortSignal, timeoutMs = 20 * 60_000): Promise<{ code: number; output: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? (process.env.ComSpec ?? "cmd.exe") : "sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], { cwd, windowsHide: true, env: { ...process.env, CI: "1" } });
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
      resolve({ code: code ?? -1, output, ms: Date.now() - started });
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
  /** Code on top of an existing branch (by repository space) instead of the checked-out HEAD. */
  fromBranches?: Record<string, string>;
  /** More spaces the coder and reviewers may read: requirement docs, the source of a migration, past cases. */
  readSpaces?: string[];
  /** The item this work is for: the coder and reviewers read its materials (src/items/materials.ts). */
  itemId?: string;
  /** The branch review this fixes: its reviewers also respect what the owner decided there. */
  fromReview?: string;
};

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
} & Pick<CodeInput, "reviewTier" | "reviewChecks" | "reviewExecution" | "itemId">;

/** Queue a review of existing branches: a `code` run without the coding round (runCodeTask). */
export function createBranchReview(app: App, req: BranchReviewRequest, parentId?: string | null, userId = OWNER) {
  const ids = [...new Set(req.repos)];
  const home = req.space ?? ids[0];
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
    } satisfies CodeInput,
    parentId: parentId ?? undefined,
    userId,
  });
  if (req.itemId) linkRunToItem(app, r, req.itemId, userId);
  return r;
}
type Check = { command: string; code: number; output: string; ms: number };
type RepoResult = { space: string; diffStat: string; diffBytes: number; check: Check | null };

/** The run's worktrees, including runs from before multi-repository delegation. */
export function worktreesOf(app: App, runId: string): WorktreeRef[] {
  const r = getRun(app, runId);
  const out = r.output as { worktrees?: WorktreeRef[]; worktree?: string; branch?: string; base?: string };
  if (out.worktrees) return out.worktrees;
  return out.worktree && r.spaceId ? [{ space: r.spaceId, path: out.worktree, branch: out.branch ?? "", base: out.base ?? "" }] : [];
}

/** Repository spaces a delegation changes: each one must be a Git repository. */
export function codeRepos(app: App, spaceId: string, repos?: string[]): Space[] {
  const ids = [...new Set(repos?.length ? repos : [spaceId])];
  return ids.map((id) => {
    const s = getSpace(app, id);
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
  for (const repo of repos) {
    const have = known.find((w) => w.space === repo.id && existsSync(w.path));
    if (have) {
      worktrees.push(have);
      continue;
    }
    const path = join(workDir, repo.id);
    if (input.branches) {
      const wt = checkoutBranch(repo, input.branches[repo.id], path, input.fetch !== false);
      worktrees.push(wt);
      ctx.event("status", { text: `已在 ${path} 检出 ${repo.id} 的分支 ${wt.ref}（${wt.tip!.slice(0, 8)}），评审它相对 ${wt.baseRef} 的改动（分叉点 ${wt.base.slice(0, 8)}）` });
      continue;
    }
    const from = input.fromBranches?.[repo.id];
    const start = from ? resolveRef(repo.rootPath!, from) : null;
    if (from && !start) throw new HttpError(404, `${repo.id} 里没有分支 ${from}`);
    const base = start?.commit ?? git(repo.rootPath!, ["rev-parse", "HEAD"]).stdout.trim();
    const r = git(repo.rootPath!, ["worktree", "add", "-q", "-b", branch, path, base]);
    if (!r.ok) throw new Error(`在 ${repo.id} 创建工作区失败：${r.stderr}`);
    const targetBranch = from ? branchFromRef(start!.ref) : git(repo.rootPath!, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || null;
    worktrees.push({ space: repo.id, path, branch, base, targetBranch, ...(from ? { baseRef: from } : {}) });
    ctx.event("status", { text: `已在 ${path} 创建 ${repo.id} 的独立工作区（基于 ${from ? `分支 ${from} 的 ` : ""}${base.slice(0, 8)}）` });
  }
  if (chain) {
    const { saveCodeChain } = await import("./code-chain.ts");
    if (rootRunId !== run.id) saveCodeChain(app, chain, run.id);
    (await import("../channels/lark-code-progress.ts")).startCodeProgress(app, chain);
  }
  ctx.output({ worktrees });

  // Triage before coding: review-lead guesses the tier from the task (shown with the progress, and
  // a heavier option the post-coding triage weighs). Only when a tier has a lead to do it.
  if (!continueFrom && !input.reviewTier && app.config.review.tiers.some((t) => t.lead)) {
    const { estimateReview } = await import("./review.ts");
    const { askModel } = await import("./oneshot.ts");
    const estimate = await estimateReview(app, input.task, (p) => askModel(app, p, { timeoutMs: 60_000, signal: ctx.signal }));
    if (estimate) {
      ctx.output({ reviewEstimate: estimate });
      ctx.event("status", { text: `评审负责人预估需要「${estimate.tierName}」档：${estimate.reason}` });
    }
  }
  const commandFor = (repo: Space) => input.checks?.[repo.id] ?? input.checkCommand ?? (repo.settings.checkCommand as string | undefined);
  const where = multi
    ? `\n\n（这次要一起改 ${repos.length} 个仓库。工作目录 ${workDir} 下每个子目录是一个仓库的独立 worktree：\n${repos
        .map((r, i) => `- ${r.id}（${r.name}）：${worktrees[i].path}${commandFor(r) ? `；检查命令：${commandFor(r)}` : ""}`)
        .join("\n")}\n用 omem 工具查这几个仓库时传 space: "*"。）`
    : `${commandFor(repos[0]) ? `\n\n检查命令：${commandFor(repos[0])}` : ""}\n\n（工作目录是独立 worktree：${worktrees[0].path}）`;
  const cwd = multi ? workDir : worktrees[0].path;
  // The run's space may be a project; the agents read it and every repository (and their related spaces).
  const owner = runUser(app, run.id);
  const spaces = [...new Set([run.spaceId!, ...repos.map((r) => r.id), ...(input.readSpaces ?? []), ...(input.itemId ? materialSpaces(app, input.itemId, owner) : [])])];
  const itemBrief = input.itemId ? `\n\n${materialsBrief(app, input.itemId, owner)}` : "";
  const coderTask = continueFrom
    ? `# 上一轮评审要求修改

${input.task}

继续在原来的工作区里改，不要重做已经通过的部分；改完重新运行检查命令。${where}`
    : `${input.task}${itemBrief}${where}`;
  const coderReply = input.branches ? branchSummary(worktrees) : await code();
  if (input.branches) ctx.output({ coderSummary: coderReply });
  async function code() {
    let resumeCoder = (input as { resumeSessionId?: string }).resumeSessionId;
    const previousId = chain?.rounds.filter((id) => id !== run.id).at(-1);
    if (resumeCoder && previousId) {
      const previous = getRun(app, previousId);
      const profile = resolveRunProfile(app, { actor: { role: "coder" }, ...executionArgs(input.execution) });
      const expected = { profile: profile.id, model: profile.model, effort: profile.effort };
      if (previous.output.coderAI && JSON.stringify(previous.output.coderAI) !== JSON.stringify(expected)) resumeCoder = undefined;
    }
    // Later rounds resume this session, so it is kept even on backends that would discard it.
    const runCoder = (task: string, resumeSessionId?: string) => runRole(app, {
      role: "coder",
      execution: input.execution,
      spaceId: run.spaceId!,
      spaces,
      task,
      runId: run.id,
      cwd,
      signal: ctx.signal,
      resumeSessionId,
      persistSession: true,
      onEvent: (e) => ctx.event(e.type, { ...e, phase: "coder" }),
    });
    // A new session on a later round has not seen the original task: give it along with this round's.
    const first = continueFrom && chain?.rounds[0] && chain.rounds[0] !== run.id ? String(getRun(app, chain.rounds[0]).input.task ?? "") : "";
    const freshTask = first ? `# 原始任务

${first}

${coderTask}` : coderTask;
    let coder: Awaited<ReturnType<typeof runCoder>>;
    try {
      coder = await runCoder(resumeCoder ? coderTask : freshTask, resumeCoder);
    } catch (e) {
      if (!resumeCoder || ctx.signal.aborted) throw e;
      // The previous session is gone (cleaned up, or the backend cannot resume it): the worktree
      // still has the changes, so a new session carries on from there.
      ctx.event("status", { phase: "coder", text: `没能接上上一轮的编码会话（${truncate((e as Error).message, 200)}），换新会话继续` });
      coder = await runCoder(freshTask);
    }
    ctx.output({ coderSummary: replyOf(coder).trim(), coderAI: coder.ai, coderAgent: coder.profileId, coderSessionId: coder.sessionId });
    return replyOf(coder);
  }

  const results: RepoResult[] = [];
  const diffs: string[] = [];
  for (const [i, repo] of repos.entries()) {
    const wt = worktrees[i];
    const command = commandFor(repo);
    let check: Check | null = null;
    if (command) {
      ctx.event("status", { text: `运行检查${multi ? `（${repo.id}）` : ""}：${command}` });
      const r = await shell(command, wt.path, ctx.signal);
      check = { command, ...r, output: r.output.slice(-8000) };
      ctx.event("check", { ...check, space: repo.id });
    }
    git(wt.path, ["add", "-A"]);
    const diff = git(wt.path, ["diff", "--cached", "--no-color", "HEAD"]).stdout;
    const stat = git(wt.path, ["diff", "--cached", "--stat", "HEAD"]).stdout.trim();
    writeFileSync(patchFile(app, run.id, repo.id), diff);
    results.push({ space: repo.id, diffStat: stat, diffBytes: diff.length, check });
    if (diff.trim()) diffs.push(multi ? `### ${repo.id}\n\n${fence("diff", diff)}` : fence("diff", diff));
  }
  const statText = results.filter((r) => r.diffStat).map((r) => (multi ? `[${r.space}]\n${r.diffStat}` : r.diffStat)).join("\n\n");
  ctx.output({ repos: results, diffStat: statText, diffBytes: results.reduce((n, r) => n + r.diffBytes, 0), check: multi ? undefined : results[0].check });
  if (!diffs.length) {
    notify(app, { title: `${input.branches ? "分支相对基线没有改动" : "交办未产生改动"}：${run.title}`, body: truncate(coderReply, 400), link: `#/runs/${run.id}` });
    return { verdict: "no-changes" };
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

  const { planReview, refineReviewPlan } = await import("./review.ts");
  const { askModel } = await import("./oneshot.ts");
  const previousPlan = chain?.rounds.filter((id) => id !== run.id).map((id) => getRun(app, id).output.reviewPlan as ReviewPlan | undefined).filter(Boolean).at(-1);
  let plan = planReview(app, reviewMetrics(worktrees, results, input.task), { tier: input.reviewTier, extraChecks: input.reviewChecks, previous: previousPlan });
  if (!previousPlan) {
    // Triage after coding: the owner's words on tiers and checks, review-lead's estimate, and with a
    // lead one step lighter when the change turned out small. Weighed once, on the first round.
    const estimate = getRun(app, run.id).output.reviewEstimate as ReviewEstimate | undefined;
    plan = await refineReviewPlan(app, plan, { task: input.task, diff: diffs.join("\n\n"), tierNamed: !!input.reviewTier, estimate }, (p) => askModel(app, p, { timeoutMs: 90_000, signal: ctx.signal }));
  } else if (plan.lead && input.reviewOnly?.length) {
    const only = plan.checks.filter((c) => input.reviewOnly!.includes(c));
    if (only.length) plan = { ...plan, checks: only, reasons: [...plan.reasons, `评审负责人安排这一轮只复审受影响的：${only.join("、")}`] };
  }
  ctx.output({ reviewPlan: plan });
  const { askPlan, reviewRound } = await import("./review-chain.ts");
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
function checkoutBranch(repo: Space, target: { branch: string; base?: string } | undefined, path: string, fetch: boolean): WorktreeRef {
  if (!target?.branch) throw new HttpError(400, `没有指定 ${repo.id} 要评审的分支`);
  const root = repo.rootPath!;
  const baseRef = target.base || defaultBaseRef(root);
  if (!baseRef) throw new HttpError(400, `${repo.id} 找不到默认分支（main / master），请指定基线分支`);
  if (fetch) for (const name of new Set([target.branch, baseRef])) fetchBranch(root, name);
  const tip = resolveRef(root, target.branch);
  if (!tip) throw new HttpError(404, `${repo.id} 里没有分支 ${target.branch}`);
  const baseTip = resolveRef(root, baseRef);
  if (!baseTip) throw new HttpError(404, `${repo.id} 里没有基线 ${baseRef}`);
  const mb = git(root, ["merge-base", baseTip.commit, tip.commit]);
  if (!mb.ok) throw new HttpError(400, `${target.branch} 和 ${baseRef} 没有共同的提交`);
  const base = mb.stdout.trim();
  const add = git(root, ["worktree", "add", "-q", "--detach", path, tip.commit]);
  if (!add.ok) throw new Error(`在 ${repo.id} 检出 ${target.branch} 失败：${add.stderr}`);
  const reset = git(path, ["reset", "-q", "--soft", base]);
  if (!reset.ok) throw new Error(`在 ${repo.id} 准备评审工作区失败：${reset.stderr}`);
  return { space: repo.id, path, branch: "", base, ref: target.branch, tip: tip.commit, baseRef };
}

/** What the reviewers read in place of a coding Agent's summary: the branch and its commits. */
function branchSummary(worktrees: WorktreeRef[]) {
  return worktrees.map((wt) => {
    const log = git(wt.path, ["log", "--no-color", "--format=- %h %an %ad %s", "--date=short", "-n", "60", `${wt.base}..${wt.tip}`]).stdout.trim();
    return `${worktrees.length > 1 ? `### ${wt.space}\n\n` : ""}这是对已有分支的评审，没有编码这一步：${wt.space} 的分支 ${wt.ref}（${wt.tip!.slice(0, 8)}）相对 ${wt.baseRef}，从分叉点 ${wt.base.slice(0, 8)} 起的改动。工作区的文件就是分支最新的代码；为了让改动显示成 diff，HEAD 特意放在分叉点、分支的改动暂存着（\`git diff --cached\` 能看到），这是正常的检出状态，不要在结论或修改单里要求“确认分支”或“切到正确的提交”。\n\n提交：\n${log || "（没有提交）"}`;
  }).join("\n\n");
}

/** What review tiers are chosen by: the size and place of the change, whether checks passed. */
function reviewMetrics(worktrees: WorktreeRef[], results: RepoResult[], task: string): ReviewMetrics {
  let lines = 0;
  let codeLines = 0;
  const paths: string[] = [];
  for (const [i, r] of results.entries()) {
    if (!r.diffBytes) continue;
    for (const row of git(worktrees[i].path, ["diff", "--cached", "--numstat", "HEAD"]).stdout.split("\n")) {
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
  return patchFiles(app, runId)
    .map((p) => ({ space: p.space, patch: readFileSync(p.file, "utf8") }))
    .filter((p) => p.patch.trim());
}

function branchFromRef(ref: string): string | null {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length).split("/").slice(1).join("/");
  return null;
}

export type AppliedTarget = { space: string; path: string; branch: string | null };
type ApplyTarget = AppliedTarget & { root: string; file: string; create: boolean; newBranch?: boolean; start?: string };

/** Resolve the original branch without switching the user's checkout or writing anything. */
function applyTargets(app: App, runId: string): ApplyTarget[] {
  const r = getRun(app, runId);
  const first = getRun(app, String(r.input.continueFrom ?? r.id));
  if (r.kind !== "code" || r.status !== "done") throw new HttpError(400, "只能应用已完成的编码运行");
  if (isBranchReview(r)) throw new HttpError(400, "分支评审只给评审意见，没有可应用的改动；要改，基于该分支交办编码（from_branch）");
  if (r.output.appliedAt || first.output.appliedAt) throw new HttpError(409, "这次交办已经应用过");
  if (r.output.discardedAt || first.output.discardedAt) throw new HttpError(409, "这次交办已经丢弃");
  return patchFiles(app, runId).filter(p => readFileSync(p.file, "utf8").trim()).map(p => {
    const root = getSpace(app, p.space).rootPath;
    if (!root) throw new HttpError(400, `空间 ${p.space} 没有关联目录`);
    const wt = worktreesOf(app, first.id).find(w => w.space === p.space);
    const from = (first.input as CodeInput).fromBranches?.[p.space] ?? wt?.baseRef;
    const target = wt?.targetBranch !== undefined ? wt.targetBranch : from ? branchFromRef(resolveRef(root, from)?.ref ?? `refs/heads/${from.replace(/^refs\/heads\//, "").replace(/^origin\//, "")}`) : undefined;
    const current = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || null;
    if (!target) {
      if (target === null && wt?.base && git(root, ["rev-parse", "HEAD"]).stdout.trim() !== wt.base)
        throw new HttpError(409, `空间 ${p.space} 基于指定提交 ${wt.base.slice(0, 12)}，请核对接收版本后重试`);
      return { ...p, root, path: root, branch: current, create: false };
    }
    if (!git(root, ["check-ref-format", `refs/heads/${target}`]).ok) throw new HttpError(400, "目标分支名称无效");
    const listed = git(root, ["worktree", "list", "--porcelain", "-z"]);
    if (!listed.ok) throw new HttpError(409, `读取 ${p.space} 的分支工作区失败：${listed.stderr}`);
    const checkedOut = listed.stdout.split("\0\0").map(block => block.split("\0")).find(fields => fields.includes(`branch refs/heads/${target}`));
    const path = checkedOut?.find(f => f.startsWith("worktree "))?.slice(9);
    if (path) {
      if (!existsSync(path)) throw new HttpError(409, `目标分支「${target}」的工作区不存在：${path}`);
      return { ...p, root, path, branch: target, create: false };
    }
    const local = git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`]).ok;
    const start = local ? `refs/heads/${target}` : resolveRef(root, from ?? target)?.ref;
    if (!start) throw new HttpError(409, `目标分支「${target}」不存在，不能应用`);
    return { ...p, root, path: join(app.runsDir, first.id, "applied", p.space), branch: target, create: true, newBranch: !local, start };
  });
}

/** Preview for the confirmation dialog; creating branch worktrees happens only on apply. */
export function codeApplyTargets(app: App, runId: string): AppliedTarget[] {
  return applyTargets(app, runId).map(({ space, path, branch }) => ({ space, path, branch }));
}

/** Remove the run's worktrees and branches, and the temporary index of what they changed. */
function removeWorktrees(app: App, runId: string) {
  for (const wt of worktreesOf(app, runId)) {
    const root = findSpace(app, wt.space)?.rootPath;
    if (!root || !existsSync(root)) continue;
    if (existsSync(wt.path)) git(root, ["worktree", "remove", "--force", wt.path]);
    else git(root, ["worktree", "prune"]);
    if (wt.branch) git(root, ["branch", "-D", wt.branch]);
  }
  for (const s of worktreeSpacesOf(app, runId)) dropWorktreeSpace(app, s.id);
}

/**
 * Apply a finished run's patches to the user's working trees as uncommitted changes, every
 * repository or none (all are checked first). The worktrees are removed afterwards; the
 * patches stay with the run.
 */
export function applyCodeRun(app: App, runId: string) {
  const r = getRun(app, runId);
  const targets = applyTargets(app, runId);
  if (!targets.length) throw new HttpError(404, "没有可应用的改动");
  const created: (ApplyTarget & { createdHead: string })[] = [];
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
      const check = git(t.path, ["apply", "--check", "--3way", t.file]);
      if (!check.ok) throw new HttpError(409, `${targets.length > 1 ? `${t.space}：` : ""}无法干净应用到 ${t.branch ?? "指定版本"}（${t.path}）：${check.stderr.slice(0, 1000)}`);
    }
    applying = true;
    for (const t of targets) {
      const res = git(t.path, ["apply", "--3way", t.file]);
      if (!res.ok) throw new HttpError(409, `应用到 ${t.path} 失败${applied.length ? `（${applied.join("、")} 已应用）` : ""}：${res.stderr.slice(0, 1000)}`);
      applied.push(t.space);
    }
  } catch (error) {
    // Preflight failed: remove only the clean worktrees/branches this attempt created.
    // After application starts, retain every destination for recovery, even on failure.
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
  for (const id of new Set([firstId, runId])) setRunOutput(app, id, { appliedAt, appliedTo });
  removeWorktrees(app, runId);
  cancelHostAsks(app, runId, "review-done");
  return { applied: true, spaces: applied, targets: appliedTo };
}

export function discardCodeRun(app: App, runId: string) {
  removeWorktrees(app, runId);
  setRunOutput(app, runId, { discardedAt: new Date().toISOString() });
  cancelHostAsks(app, runId, "review-done");
}
