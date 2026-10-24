import { executionArgs, type Execution } from "./execution.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { git, isGitRepo } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { findSpace, getSpace, type Space } from "../core/spaces.ts";
import { HttpError, truncate } from "../core/util.ts";
import { resolveRunProfile, runRole } from "./runner.ts";
import { readAgentSpec } from "./specs.ts";
import type { ReviewMetrics, Severity } from "./review.ts";
import type { RoleName } from "../core/config.ts";
import { all } from "../core/db.ts";
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
  execution?: Execution;
  /** Review tier the owner named, and checks to add (docs/v2/review.md). */
  reviewTier?: string;
  reviewChecks?: string[];
  reviewExecution?: Execution;
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
  let resumeCoder = (input as { resumeSessionId?: string }).resumeSessionId;
  const previousId = chain?.rounds.filter((id) => id !== run.id).at(-1);
  if (resumeCoder && previousId) {
    const previous = getRun(app, previousId);
    const profile = resolveRunProfile(app, { actor: { role: "coder" }, ...executionArgs(input.execution) });
    const expected = { profile: profile.id, model: profile.model, effort: profile.effort };
    if (previous.output.coderAI && JSON.stringify(previous.output.coderAI) !== JSON.stringify(expected)) resumeCoder = undefined;
  }
  const coder = await runRole(app, {
    role: "coder",
    execution: input.execution,
    spaceId: run.spaceId!,
    spaces,
    task: coderTask,
    runId: run.id,
    cwd,
    signal: ctx.signal,
    resumeSessionId: resumeCoder,
    onEvent: (e) => ctx.event(e.type, { ...e, phase: "coder" }),
  });
  ctx.output({ coderSummary: replyOf(coder).trim(), coderAI: coder.ai, coderAgent: coder.profileId, coderSessionId: coder.sessionId });

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

  const { planReview, reviewChecks, reviewFor, recordReview, checkBrief, blocksAt, SEVERITY_LABEL } = await import("./review.ts");
  const round = (input as { round?: number }).round ?? 1;
  const previousPlan = chain?.rounds.filter((id) => id !== run.id).map((id) => getRun(app, id).output.reviewPlan as import("./review.ts").ReviewPlan | undefined).filter(Boolean).at(-1);
  let plan = planReview(app, reviewMetrics(worktrees, results, input.task), { tier: input.reviewTier, extraChecks: input.reviewChecks, previous: previousPlan });
  // Words the owner wrote on when a tier or check fits are weighed once, on the first round.
  if (!previousPlan) {
    const { refineReviewPlan } = await import("./review.ts");
    const { askModel } = await import("./oneshot.ts");
    plan = await refineReviewPlan(app, plan, { task: input.task, diff: diffs.join("\n\n"), tierNamed: !!input.reviewTier }, (p) => askModel(app, p, { timeoutMs: 90_000, signal: ctx.signal }));
  }
  const infos = new Map(reviewChecks(app).map((c) => [c.name, c]));
  ctx.output({ reviewPlan: plan });
  ctx.event("status", { text: `独立评审中：「${plan.tierName}」档，${plan.checks.map((c) => infos.get(c)!.label).join("、")}（${plan.reasons.join("；")}）` });
  const head = (r: RepoResult) => (multi ? `### ${r.space}\n\n` : "");
  const checkText = results.map((r) => (r.check ? `${head(r)}命令：${r.check.command}\n退出码：${r.check.code}\n\n${fence("", r.check.output.slice(-4000))}` : `${head(r)}没有配置检查命令。`)).join("\n\n");
  const reviewTask = [
    `## 原始需求\n\n${input.task}`,
    multi ? `## 涉及的仓库\n\n${repos.map((r, i) => `- ${r.id}：${worktrees[i].path}`).join("\n")}\n\n工作目录下每个子目录是一个仓库的 worktree；改过的文件也能用 omem 工具查（space: "*"）。` : "",
    `## 编码 Agent 的说明\n\n${replyOf(coder).trim()}`,
    `## 检查结果\n\n${checkText}`,
    `## 改动统计\n\n${statText}`,
    `## 完整 diff\n\n${truncate(diffs.join("\n\n"), 80000)}`,
  ].filter(Boolean).join("\n\n");
  // Each check is its own session with read-only tools; one failing does not stop the others.
  const outcomes = await Promise.allSettled(plan.checks.map(async (name) => {
    const info = infos.get(name)!;
    const res = await runRole(app, {
      role: (info.builtin ? name : "reviewer") as RoleName,
      ...(info.builtin ? {} : { spec: readAgentSpec(app, name) }),
      reviewCheck: true,
      execution: name === "reviewer" ? input.reviewExecution : undefined,
      spaceId: run.spaceId!,
      spaces,
      alsoRead: indexed,
      task: `${reviewTask}\n\n${checkBrief(info, plan)}`,
      runId: run.id,
      cwd,
      signal: ctx.signal,
      onEvent: (e) => ctx.event(e.type, { ...e, phase: "reviewer", check: name }),
      profileId: info.builtin ? app.config.agents.roles[name] : undefined,
    });
    const text = replyOf(res).trim();
    // A check that only wrote text (an older customized prompt) still counts, by its verdict line.
    if (!reviewFor(app, run.id, round, name)) {
      const ok = /结论[：:]\s*通过/.test(text) || (!/结论[：:]/.test(text) && /结论[：:]\s*通过/.test(res.text));
      recordReview(app, { codeRunId: run.id, round, check: name, tier: plan.tier, verdict: ok ? "approved" : "changes_requested", summary: truncate(text, 4000), findings: [], ai: res.ai });
    }
    return { name, text, ai: res.ai, profileId: res.profileId };
  }));
  const failed = outcomes.flatMap((o, i) => (o.status === "rejected" ? [{ name: plan.checks[i], error: (o.reason as Error).message }] : []));
  if (failed.length === outcomes.length) throw new Error(`评审没有完成：${failed.map((f) => `${infos.get(f.name)!.label}：${f.error}`).join("；")}`);
  for (const f of failed) recordReview(app, { codeRunId: run.id, round, check: f.name, tier: plan.tier, verdict: "failed", summary: f.error, findings: [] });
  const done = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
  const verdicts = done.map((d) => {
    const info = infos.get(d.name)!;
    const row = reviewFor(app, run.id, round, d.name)!;
    const findings = all<{ severity: Severity; file_path: string | null; line: number | null; title: string; suggestion: string }>(app.db, "select severity, file_path, line, title, suggestion from review_findings where review_id = ?", row.id);
    const blocking = findings.filter((f) => blocksAt(f.severity, info.blocks));
    // Findings below the check's blocking level do not hold the change, whatever the verdict said.
    const ok = !blocking.length && (row.verdict === "approved" || findings.length > 0);
    return { ...d, info, ok, blocking };
  });
  const approved = verdicts.every((v) => v.ok);
  const single = plan.checks.length === 1 && done.length === 1;
  const reviewText = single
    ? done[0].text
    : [...verdicts.map((v) => `### ${v.info.label}（${v.ok ? "通过" : "需要修改"}）\n\n${v.text}`), ...failed.map((f) => `### ${infos.get(f.name)!.label}（没有完成）\n\n${f.error}`)].join("\n\n");
  ctx.output({ review: reviewText, reviewAI: done[0]?.ai, reviewAgent: done[0]?.profileId, verdict: approved ? "approved" : "changes-requested" });
  const changeRequest = verdicts.filter((v) => !v.ok).map((v) => [
    single ? "" : `### ${v.info.label}`,
    v.blocking.map((f, i) => `${i + 1}. [${SEVERITY_LABEL[f.severity]}] ${f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""} ` : ""}${f.title}${f.suggestion ? `：${f.suggestion}` : ""}`).join("\n"),
    v.text,
  ].filter(Boolean).join("\n\n")).join("\n\n");
  const checked = results.filter((r) => r.check);
  const statTextLine = results.map((r) => (multi ? `${r.space}：` : "") + (r.diffStat.split("\n").pop() ?? "")).join("\n");
  const checksLine = checked.length ? `\n检查：${checked.some((r) => r.check!.code !== 0) ? "失败" : "通过"}` : "";
  const { queueNextCodeRound, maxCodeRounds, saveCodeChain } = await import("./code-chain.ts");
  let endChain = (getRun(app, run.id).output as { codeChain?: import("./code-chain.ts").CodeChain }).codeChain ?? chain;
  if (endChain && endChain.maxRounds !== plan.maxRounds) {
    endChain = { ...((getRun(app, endChain.askRunId).output.codeChain as import("./code-chain.ts").CodeChain | undefined) ?? endChain), maxRounds: plan.maxRounds };
    saveCodeChain(app, endChain, endChain.askRunId, ...endChain.rounds);
  }
  if (!approved) {
    // Keep the same delegation going: the coder resumes its session and works the reviewers' requests.
    const reviewBody = changeRequest;
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
      title: `${approved ? "交办完成，评审通过" : `交办第 ${endChain?.round ?? 1} 轮评审要求修改（已到自动推进上限 ${maxCodeRounds(app, endChain)} 轮，等本人决定）`}：${run.title}`,
      body: `${statTextLine}${checksLine}`,
      link: `#/runs/${run.id}`,
      // Inside a multi-agent work the nudge belongs to the work's current topic, not a private DM.
      ...(work ? { larkConversationId: work.workConversationId } : {}),
    });
  }
  return { verdict: approved ? "approved" : "changes-requested" };
}

/** What review tiers are chosen by: the size and place of the change, whether checks passed. */
function reviewMetrics(worktrees: WorktreeRef[], results: RepoResult[], task: string): ReviewMetrics {
  let lines = 0;
  const paths: string[] = [];
  for (const [i, r] of results.entries()) {
    if (!r.diffBytes) continue;
    for (const row of git(worktrees[i].path, ["diff", "--cached", "--numstat", "HEAD"]).stdout.split("\n")) {
      const [add, del, file] = row.split("\t");
      if (!file) continue;
      lines += (Number(add) || 0) + (Number(del) || 0);
      paths.push(results.length > 1 ? `${r.space}/${file}` : file);
    }
  }
  return {
    "change.lines": lines,
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
