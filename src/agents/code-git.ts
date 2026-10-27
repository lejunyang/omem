import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { addRunEvent, getRun, setRunOutput } from "./runs.ts";

export const codeGitActionSchema = z.object({
  space: z.string().min(1),
  action: z.enum(["commit", "commit_push", "push"]),
  message: z.string().trim().max(10000).optional(),
  expected_state: z.string().min(1),
  /** Push to this branch of origin instead of the original target branch (a new branch for a merge request, say). */
  branch: z.string().trim().max(200).optional(),
  /** After a rebase the remote branch has diverged: replace it, but only if it is still what was last fetched. */
  force: z.boolean().optional(),
});
type Action = z.infer<typeof codeGitActionSchema>;
type Target = { space: string; path: string; branch: string | null };
export type CodeGitOperation = {
  id: string; at: string; space: string; branch: string; action: Action["action"]; actor: string;
  before: string; head: string; committed: string | null; pushed: boolean; ok: boolean; error?: string;
  /** Where it was pushed when not the target branch, and whether it replaced diverged commits. */
  to?: string; forced?: boolean;
};

/** Only recorded receiving worktrees are addressable; callers cannot supply a filesystem path. */
function targetOf(app: App, runId: string, space: string) {
  const run = getRun(app, runId);
  const first = getRun(app, String(run.input.continueFrom ?? run.id));
  // Applied for good, or applied while the work goes on (“先应用到原分支，再接着改”).
  if (run.kind !== "code" || first.kind !== "code" || !(first.output.appliedAt || first.output.partlyAppliedAt))
    throw new HttpError(400, "请先应用编码改动，再提交或推送");
  const target = ((first.output.appliedTo ?? first.output.partlyAppliedTo) as Target[] | undefined)?.find(t => t.space === space);
  if (!target) throw new HttpError(404, "这个运行没有该仓库的接收工作区");
  const root = findSpace(app, space)?.rootPath;
  if (!root || !existsSync(target.path)) throw new HttpError(409, "接收工作区不存在，请检查仓库位置");
  const commonDir = (path: string) => {
    const r = git(path, ["rev-parse", "--git-common-dir"]);
    if (!r.ok) throw new HttpError(409, "接收目录不是 Git 工作区");
    return realpathSync(resolve(path, r.stdout.trim()));
  };
  const common = commonDir(root);
  if (commonDir(target.path) !== common) throw new HttpError(409, "接收目录已不属于原仓库");
  const top = git(target.path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || realpathSync(top.stdout.trim()) !== realpathSync(target.path)) throw new HttpError(409, "接收目录已不是工作区根目录");
  const branch = git(target.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (!target.branch || branch !== target.branch) throw new HttpError(409, "接收工作区已切换分支或处于分离 HEAD，请恢复原目标分支");
  return { ...target, branch, first, common };
}

function checked(path: string, args: string[]) {
  const r = git(path, args);
  if (!r.ok) throw new HttpError(409, `读取 Git 状态失败：${r.stderr.slice(0, 1000)}`);
  return r.stdout;
}

export function readCodeGit(app: App, runId: string, space: string) {
  const t = targetOf(app, runId, space);
  const head = checked(t.path, ["rev-parse", "HEAD"]).trim();
  const status = checked(t.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files: { path: string; index: string; worktree: string }[] = [];
  const rows = status.split("\0");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    files.push({ path: row.slice(3), index: row[0], worktree: row[1] });
    if (/[RC]/.test(row.slice(0, 2))) i++; // -z records the rename source separately.
  }
  const stagedDiff = checked(t.path, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]);
  const remoteUrls = git(t.path, ["remote", "get-url", "--push", "--all", "origin"]);
  const urls = remoteUrls.ok ? remoteUrls.stdout.trim().split("\n").filter(Boolean) : [];
  const remote = urls.length === 1 ? "origin" : null;
  const tracking = git(t.path, ["rev-parse", "--verify", `refs/remotes/origin/${t.branch}`]);
  const counts = tracking.ok ? checked(t.path, ["rev-list", "--left-right", "--count", `${head}...${tracking.stdout.trim()}`]).trim().split(/\s+/).map(Number) : null;
  let blockedReason: string | null = null;
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
    const p = checked(t.path, ["rev-parse", "--git-path", name]).trim();
    if (existsSync(resolve(t.path, p))) blockedReason = "仓库有未完成的合并、变基或拣选，请先处理";
  }
  if (files.some(f => f.index === "U" || f.worktree === "U" || ["AA", "DD"].includes(f.index + f.worktree))) blockedReason = "仓库还有未解决的冲突";
  const state = createHash("sha256").update(JSON.stringify([realpathSync(t.path), t.branch, head, status, stagedDiff, remoteUrls.stdout, tracking.stdout, blockedReason])).digest("hex");
  return {
    space, path: t.path, branch: t.branch, head, state, remote,
    pushTarget: createHash("sha256").update(remoteUrls.stdout).digest("hex"),
    pushUnavailable: remote ? null : urls.length > 1 ? "origin 配置了多个推送地址，请在仓库中处理" : "仓库没有配置 origin 推送地址",
    ahead: counts?.[0] ?? null, behind: counts?.[1] ?? null,
    files, staged: files.filter(f => ![" ", "?", "!"].includes(f.index)).length,
    unstaged: files.filter(f => f.worktree !== " ").length,
    stagedDiff: stagedDiff.slice(0, 24000), diffTruncated: stagedDiff.length > 24000,
    blockedReason, operations: ((t.first.output.gitOperations ?? []) as CodeGitOperation[]).filter(o => o.space === space).slice(-20),
  };
}

// Serialize mutations across runs sharing a repository. Git's own index/ref locks also protect
// against other processes; the preview token rejects changes made since the user's inspection.
const busy = new Set<string>();
function mutate(path: string, args: string[]): Promise<{ ok: boolean; error: string }> {
  return new Promise(resolve => {
    execFile("git", args, { cwd: path, encoding: "utf8", timeout: 120000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" }, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, error: error ? `${stderr || stdout || error.message}`.slice(0, 4000) : "" });
    });
  });
}

export async function actCodeGit(app: App, runId: string, input: Action, actor = "user") {
  const a = codeGitActionSchema.parse(input);
  const t = targetOf(app, runId, a.space);
  if (busy.has(t.common)) throw new HttpError(409, "这个仓库正在提交或推送，请稍后刷新状态");
  busy.add(t.common);
  try {
    const before = readCodeGit(app, runId, a.space);
    if (a.expected_state !== before.state) throw new HttpError(409, "Git 状态已变化，请刷新并重新检查待提交内容");
    if (before.blockedReason) throw new HttpError(409, before.blockedReason);
    if (a.action !== "push" && (!a.message || !before.staged)) throw new HttpError(400, !a.message ? "请填写提交信息" : "没有已暂存的修改；如已提交，请选择仅推送");
    if (a.action !== "commit" && !before.remote) throw new HttpError(400, before.pushUnavailable!);
    const dest = a.branch?.replace(/^refs\/heads\//, "").replace(/^origin\//, "") || t.branch;
    if (a.action !== "commit" && !git(t.path, ["check-ref-format", `refs/heads/${dest}`]).ok) throw new HttpError(400, `分支名不合法：${dest}`);
    const operation: CodeGitOperation = { id: randomUUID(), at: new Date().toISOString(), space: a.space, branch: t.branch, action: a.action, actor,
      before: before.head, head: before.head, committed: null, pushed: false, ok: false,
      ...(dest !== t.branch ? { to: dest } : {}), ...(a.force ? { forced: true } : {}) };
    const record = () => {
      const history = (getRun(app, t.first.id).output.gitOperations ?? []) as CodeGitOperation[];
      for (const id of new Set([t.first.id, runId])) {
        setRunOutput(app, id, { gitOperations: [...history.filter(o => o.id !== operation.id), operation] });
        addRunEvent(app, id, "git-operation", operation);
      }
    };
    // Persist each completed step. A failed push never hides or rolls back a successful commit.
    if (a.action !== "push") {
      const result = await mutate(t.path, ["commit", "-m", a.message!]);
      operation.head = checked(t.path, ["rev-parse", "HEAD"]).trim();
      if (operation.head !== before.head) operation.committed = operation.head;
      if (!result.ok) { operation.error = `提交失败：${result.error}`; record(); return operation; }
      operation.ok = a.action === "commit";
      record();
    }
    if (a.action !== "commit") {
      // Revalidate the recorded target after commit hooks, then push the inspected commit only.
      try {
        const current = readCodeGit(app, runId, a.space);
        if (current.pushTarget !== before.pushTarget || current.head !== operation.head || current.blockedReason)
          throw new HttpError(409, "提交后 Git 状态或推送地址发生变化，请刷新后再推送");
      }
      catch (error) { operation.ok = false; operation.error = (error as Error).message; record(); return operation; }
      // Force only with a lease: the remote branch must still be what this repository last fetched.
      const known = git(t.path, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${dest}`]).stdout.trim();
      const lease = a.force ? [known ? `--force-with-lease=refs/heads/${dest}:${known}` : `--force-with-lease=refs/heads/${dest}`] : [];
      const result = await mutate(t.path, ["-c", "remote.origin.mirror=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", ...lease, "origin", `${operation.head}:refs/heads/${dest}`]);
      operation.pushed = result.ok;
      operation.ok = result.ok;
      if (!result.ok) operation.error = `${operation.committed ? "本地提交已完成；" : ""}推送失败，可刷新后仅重试推送${/rejected|non-fast-forward|fetch first/i.test(result.error) && !a.force ? "（远端分支有本地没有的提交：变基过的分支要选“强制推送”，否则先同步）" : ""}：${result.error}`;
      record();
    }
    return operation;
  } finally { busy.delete(t.common); }
}
