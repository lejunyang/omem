import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { git, isGitRepo } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { findSpace, getSpace, type Space } from "../core/spaces.ts";
import { HttpError, truncate } from "../core/util.ts";
import { runRole } from "./runner.ts";
import { getRun, setRunOutput, type RunContext } from "./runs.ts";
import { dropWorktreeSpace, indexWorktree, worktreeSpacesOf, type WorktreeRef } from "./worktree-index.ts";
import { replyOf } from "./types.ts";

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
  task: string;
  /** Applies to every repository unless `checks` names one for it. */
  checkCommand?: string;
  /** Repository spaces to change together; defaults to the run's space. */
  repos?: string[];
  checks?: Record<string, string>;
};
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
    const base = git(repo.rootPath!, ["rev-parse", "HEAD"]).stdout.trim();
    const r = git(repo.rootPath!, ["worktree", "add", "-q", "-b", branch, path, base]);
    if (!r.ok) throw new Error(`在 ${repo.id} 创建工作区失败：${r.stderr}`);
    worktrees.push({ space: repo.id, path, branch, base });
    ctx.event("status", { text: `已在 ${path} 创建 ${repo.id} 的独立工作区（基于 ${base.slice(0, 8)}）` });
  }
  if (chain) {
    const { saveCodeChain } = await import("./code-chain.ts");
    if (rootRunId !== run.id) saveCodeChain(app, chain, run.id);
    (await import("../channels/lark-code-progress.ts")).startCodeProgress(app, chain);
  }
  ctx.output({ worktrees });

  const commandFor = (repo: Space) => input.checks?.[repo.id] ?? input.checkCommand ?? (repo.settings.checkCommand as string | undefined);
  const where = multi
    ? `\n\n（这次要一起改 ${repos.length} 个仓库。工作目录 ${workDir} 下每个子目录是一个仓库的独立 worktree：\n${repos
        .map((r, i) => `- ${r.id}（${r.name}）：${worktrees[i].path}${commandFor(r) ? `；检查命令：${commandFor(r)}` : ""}`)
        .join("\n")}\n用 omem 工具查这几个仓库时传 space: "*"。）`
    : `${commandFor(repos[0]) ? `\n\n检查命令：${commandFor(repos[0])}` : ""}\n\n（工作目录是独立 worktree：${worktrees[0].path}）`;
  const cwd = multi ? workDir : worktrees[0].path;
  // The run's space may be a project; the agents read it and every repository (and their related spaces).
  const spaces = [...new Set([run.spaceId!, ...repos.map((r) => r.id)])];
  const coderTask = continueFrom
    ? `# 上一轮评审要求修改

${input.task}

继续在原来的工作区里改，不要重做已经通过的部分；改完重新运行检查命令。${where}`
    : `${input.task}${where}`;
  const coder = await runRole(app, {
    role: "coder",
    spaceId: run.spaceId!,
    spaces,
    task: coderTask,
    runId: run.id,
    cwd,
    signal: ctx.signal,
    resumeSessionId: (input as { resumeSessionId?: string }).resumeSessionId,
    onEvent: (e) => ctx.event(e.type, { ...e, phase: "coder" }),
  });
  ctx.output({ coderSummary: replyOf(coder).trim(), coderAgent: coder.profileId, coderSessionId: coder.sessionId });

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
    notify(app, { title: `交办未产生改动：${run.title}`, body: truncate(replyOf(coder), 400), link: `#/runs/${run.id}` });
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

  ctx.event("status", { text: "独立评审中" });
  const head = (r: RepoResult) => (multi ? `### ${r.space}\n\n` : "");
  const checkText = results.map((r) => (r.check ? `${head(r)}命令：${r.check.command}\n退出码：${r.check.code}\n\n${fence("", r.check.output.slice(-4000))}` : `${head(r)}没有配置检查命令。`)).join("\n\n");
  const review = await runRole(app, {
    role: "reviewer",
    spaceId: run.spaceId!,
    spaces,
    alsoRead: indexed,
    task: [
      `## 原始需求\n\n${input.task}`,
      multi ? `## 涉及的仓库\n\n${repos.map((r, i) => `- ${r.id}：${worktrees[i].path}`).join("\n")}\n\n工作目录下每个子目录是一个仓库的 worktree；改过的文件也能用 omem 工具查（space: "*"）。` : "",
      `## 编码 Agent 的说明\n\n${replyOf(coder).trim()}`,
      `## 检查结果\n\n${checkText}`,
      `## 改动统计\n\n${statText}`,
      `## 完整 diff\n\n${truncate(diffs.join("\n\n"), 80000)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    runId: run.id,
    cwd,
    signal: ctx.signal,
    onEvent: (e) => ctx.event(e.type, { ...e, phase: "reviewer" }),
    profileId: app.config.agents.roles.reviewer,
  });
  // The verdict and its reasons, without the reviewer's narration on the way (that stays in the run's events).
  const reviewText = replyOf(review).trim();
  // A reviewer that ends with a short line keeps its verdict in the reply; look at the whole text if not.
  const approved = /结论[：:]\s*通过/.test(reviewText) || (!/结论[：:]/.test(reviewText) && /结论[：:]\s*通过/.test(review.text));
  ctx.output({ review: reviewText, reviewAgent: review.profileId, verdict: approved ? "approved" : "changes-requested" });
  const checked = results.filter((r) => r.check);
  const statTextLine = results.map((r) => (multi ? `${r.space}：` : "") + (r.diffStat.split("\n").pop() ?? "")).join("\n");
  const checksLine = checked.length ? `\n检查：${checked.some((r) => r.check!.code !== 0) ? "失败" : "通过"}` : "";
  const { queueNextCodeRound, MAX_AUTO_ROUNDS } = await import("./code-chain.ts");
  const endChain = (getRun(app, run.id).output as { codeChain?: import("./code-chain.ts").CodeChain }).codeChain ?? chain;
  if (!approved) {
    // Keep the same delegation going: the coder resumes its session and works the reviewer's request.
    const reviewBody = reviewText;
    const next = endChain
      ? queueNextCodeRound(app, endChain, `评审要求修改（第 ${endChain.round} 轮评审）：\n\n${reviewBody.slice(0, 12000)}`, { resumeSessionId: coder.sessionId })
      : null;
    if (next) {
      ctx.event("status", { text: `评审要求修改，已在同一会话安排第 ${next.chain.round} 轮（复用同一编码会话和工作区）` });
      ctx.output({ codeChain: next.chain });
      return { verdict: "changes-requested", continuedRunId: next.run.id };
    }
  }
  {
    const { workForChild } = await import("./agent-work.ts");
    const work = workForChild(app, run);
    notify(app, {
      title: `${approved ? "交办完成，评审通过" : `交办第 ${endChain?.round ?? 1} 轮评审要求修改（已到自动推进上限 ${MAX_AUTO_ROUNDS} 轮，等本人决定）`}：${run.title}`,
      body: `${statTextLine}${checksLine}`,
      link: `#/runs/${run.id}`,
      // Inside a multi-agent work the nudge belongs to the work's current topic, not a private DM.
      ...(work ? { larkConversationId: work.workConversationId } : {}),
    });
  }
  return { verdict: approved ? "approved" : "changes-requested" };
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
  if (r.kind !== "code" || r.status !== "done") throw new HttpError(400, "只能应用已完成的编码运行");
  if ((r.output as { appliedAt?: string }).appliedAt) throw new HttpError(409, "这次交办已经应用过");
  const targets = patchFiles(app, runId)
    .filter((p) => readFileSync(p.file, "utf8").trim())
    .map((p) => {
      const root = getSpace(app, p.space).rootPath;
      if (!root) throw new HttpError(400, `空间 ${p.space} 没有关联目录`);
      return { ...p, root };
    });
  if (!targets.length) throw new HttpError(404, "没有可应用的改动");
  const label = (space: string) => (targets.length > 1 ? `${space}：` : "");
  for (const t of targets) {
    const check = git(t.root, ["apply", "--check", "--3way", t.file]);
    if (!check.ok) throw new HttpError(409, `${label(t.space)}无法干净应用：${check.stderr.slice(0, 1000)}`);
  }
  const applied: string[] = [];
  for (const t of targets) {
    const res = git(t.root, ["apply", "--3way", t.file]);
    if (!res.ok) throw new HttpError(409, `${label(t.space)}应用失败${applied.length ? `（${applied.join("、")} 已应用）` : ""}：${res.stderr.slice(0, 1000)}`);
    applied.push(t.space);
  }
  setRunOutput(app, runId, { appliedAt: new Date().toISOString() });
  removeWorktrees(app, runId);
  return { applied: true, spaces: applied };
}

export function discardCodeRun(app: App, runId: string) {
  removeWorktrees(app, runId);
  setRunOutput(app, runId, { discardedAt: new Date().toISOString() });
}
