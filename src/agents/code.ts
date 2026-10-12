import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { git, isGitRepo } from "../core/git.ts";
import { notify } from "../core/notify.ts";
import { getSpace } from "../core/spaces.ts";
import { HttpError, truncate } from "../core/util.ts";
import { runRole } from "./runner.ts";
import { getRun, setRunOutput, type RunContext } from "./runs.ts";

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

/**
 * Delegated coding: isolated worktree → coding agent → project checks →
 * independent reviewer. Nothing touches the user's checkout until they apply.
 */
export async function runCodeTask(ctx: RunContext) {
  const { app, run } = ctx;
  const space = getSpace(app, run.spaceId!);
  const root = space.rootPath;
  if (!root || !isGitRepo(root)) throw new Error("交办编码需要空间关联一个 Git 仓库");
  const { task, checkCommand } = run.input as { task: string; checkCommand?: string };
  const dir = join(app.runsDir, run.id);
  const worktree = join(dir, "worktree");
  const branch = `omem/${run.id}`;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(worktree)) {
    const base = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const r = git(root, ["worktree", "add", "-q", "-b", branch, worktree, base]);
    if (!r.ok) throw new Error(`创建工作区失败：${r.stderr}`);
    ctx.output({ worktree, branch, base });
    ctx.event("status", { text: `已在 ${worktree} 创建独立工作区（基于 ${base.slice(0, 8)}）` });
  }

  const coder = await runRole(app, {
    role: "coder",
    spaceId: space.id,
    task: `${task}${checkCommand ? `\n\n检查命令：${checkCommand}` : ""}\n\n（工作目录是独立 worktree：${worktree}）`,
    runId: run.id,
    cwd: worktree,
    signal: ctx.signal,
    onEvent: (e) => ctx.event(e.type, { ...e, phase: "coder" }),
  });
  ctx.output({ coderSummary: coder.text.trim(), coderAgent: coder.profileId });

  const command = checkCommand ?? (space.settings.checkCommand as string | undefined);
  let check: { command: string; code: number; output: string; ms: number } | null = null;
  if (command) {
    ctx.event("status", { text: `运行检查：${command}` });
    const r = await shell(command, worktree, ctx.signal);
    check = { command, ...r, output: r.output.slice(-8000) };
    ctx.event("check", check);
    ctx.output({ check });
  }

  git(worktree, ["add", "-A"]);
  const diff = git(worktree, ["diff", "--cached", "--no-color", "HEAD"]).stdout;
  const stat = git(worktree, ["diff", "--cached", "--stat", "HEAD"]).stdout.trim();
  writeFileSync(join(dir, "changes.patch"), diff);
  ctx.output({ diffStat: stat, diffBytes: diff.length });
  if (!diff.trim()) {
    notify(app, { title: `交办未产生改动：${run.title}`, body: truncate(coder.text, 400), link: `#/runs/${run.id}` });
    return { verdict: "no-changes" };
  }

  ctx.event("status", { text: "独立评审中" });
  const review = await runRole(app, {
    role: "reviewer",
    spaceId: space.id,
    task: [
      `## 原始需求\n\n${task}`,
      `## 编码 Agent 的说明\n\n${coder.text.trim()}`,
      check ? `## 检查结果\n\n命令：${check.command}\n退出码：${check.code}\n\n\`\`\`\n${check.output.slice(-4000)}\n\`\`\`` : "## 检查结果\n\n没有配置检查命令。",
      `## 改动统计\n\n${stat}`,
      `## 完整 diff\n\n\`\`\`diff\n${truncate(diff, 80000)}\n\`\`\``,
    ].join("\n\n"),
    runId: run.id,
    cwd: worktree,
    signal: ctx.signal,
    onEvent: (e) => ctx.event(e.type, { ...e, phase: "reviewer" }),
    profileId: app.config.agents.roles.reviewer,
  });
  const approved = /结论[：:]\s*通过/.test(review.text);
  ctx.output({ review: review.text.trim(), reviewAgent: review.profileId, verdict: approved ? "approved" : "changes-requested" });
  notify(app, {
    title: `${approved ? "交办完成，评审通过" : "交办完成，评审要求修改"}：${run.title}`,
    body: `${stat.split("\n").pop() ?? ""}${check ? `\n检查：${check.code === 0 ? "通过" : "失败"}` : ""}`,
    link: `#/runs/${run.id}`,
  });
  return { verdict: approved ? "approved" : "changes-requested" };
}

export function codePatch(app: App, runId: string) {
  const file = join(app.runsDir, runId, "changes.patch");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Apply a finished run's patch to the user's working tree as uncommitted changes. */
export function applyCodeRun(app: App, runId: string) {
  const r = getRun(app, runId);
  if (r.kind !== "code" || r.status !== "done") throw new HttpError(400, "只能应用已完成的编码运行");
  const space = getSpace(app, r.spaceId!);
  const patch = join(app.runsDir, runId, "changes.patch");
  if (!existsSync(patch)) throw new HttpError(404, "没有可应用的改动");
  const check = git(space.rootPath!, ["apply", "--check", "--3way", patch]);
  if (!check.ok) throw new HttpError(409, `无法干净应用：${check.stderr.slice(0, 1000)}`);
  const res = git(space.rootPath!, ["apply", "--3way", patch]);
  if (!res.ok) throw new HttpError(409, res.stderr.slice(0, 1000));
  setRunOutput(app, runId, { appliedAt: new Date().toISOString() });
  return { applied: true };
}

export function discardCodeRun(app: App, runId: string) {
  const r = getRun(app, runId);
  const space = getSpace(app, r.spaceId!);
  const out = r.output as { worktree?: string; branch?: string };
  if (out.worktree) git(space.rootPath!, ["worktree", "remove", "--force", out.worktree]);
  if (out.branch) git(space.rootPath!, ["branch", "-D", out.branch]);
  setRunOutput(app, runId, { discardedAt: new Date().toISOString() });
}
