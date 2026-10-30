import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { fetchBranch, git, resolveRef } from "../core/git.ts";
import { findSpace, getSpace, type Space } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { cancelHostAsks } from "./asks.ts";
import { getRun, setRunOutput } from "./runs.ts";
import { hasSyncStash, syncInProgress } from "./code-sync.ts";
import { dropWorktreeSpace, worktreeSpacesOf, type WorktreeRef } from "./worktree-index.ts";
import { leaseWorkspace, releaseWorkspace, workDirOf } from "./workspaces.ts";

/**
 * Delegations on a work branch (docs/v2/ide.md “工作分支与工作区”): each repository gets a branch
 * the coding Agent commits to, round by round, in a lent workspace. Between rounds the workspace is
 * detached, so the branch can be checked out anywhere (the owner's main directory, to run it); a
 * round on a branch checked out elsewhere commits on a detached HEAD and fast-forwards that
 * checkout at the end. Nothing is applied or committed by hand: the owner confirms, which pushes.
 */

const ID = ["-c", "user.name=omem", "-c", "user.email=omem@localhost"];
const identity = (path: string) => (git(path, ["config", "user.email"]).stdout.trim() ? [] : ID);
const head = (path: string) => git(path, ["rev-parse", "HEAD"]).stdout.trim();
const tipOf = (root: string, branch: string) => git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).stdout.trim() || null;
const ancestor = (dir: string, a: string, b: string) => git(dir, ["merge-base", "--is-ancestor", a, b]).ok;
const same = (a: string, b: string) => {
  const n = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return n(a) === n(b);
};

export const isBranchWork = (wts: WorktreeRef[]) => wts.some((w) => w.commits);

/** Where `branch` is checked out among the repository's worktrees, other than `except`; null when nowhere. */
export function checkedOutAt(root: string, branch: string, except?: string): string | null {
  const listed = git(root, ["worktree", "list", "--porcelain", "-z"]);
  for (const block of listed.stdout.split("\0\0")) {
    const fields = block.split("\0");
    if (!fields.includes(`branch refs/heads/${branch}`)) continue;
    const path = fields.find((f) => f.startsWith("worktree "))?.slice(9);
    if (path && !(except && same(path, except))) return resolve(path);
  }
  return null;
}

/** The commit the branch's changes are measured from: where it left the branch it was cut from, else where the work began. */
export function changeBase(dir: string, wt: WorktreeRef, at = "HEAD") {
  if (wt.cutFrom) {
    const mb = git(dir, ["merge-base", at, `refs/heads/${wt.cutFrom}`]);
    if (mb.ok && ancestor(dir, wt.base, mb.stdout.trim())) return mb.stdout.trim();
  }
  return wt.start ?? wt.base;
}

export type BranchPlan = { branch: string; base: string; newBranch: boolean; cutFrom?: string };

/**
 * The work branch of a new delegation in `repo`: an existing branch (`from`, made local when only
 * origin has it), a new one named `name` (an existing local one is used as it is), or a temporary
 * `omem/<run>` the coding Agent renames. New branches start at the repository's local HEAD.
 */
export function planBranch(repo: Space, runId: string, opts: { from?: string; name?: string }): BranchPlan {
  const root = repo.rootPath!;
  const existing = opts.from ?? (opts.name && tipOf(root, opts.name) ? opts.name : undefined);
  if (existing) {
    const start = resolveRef(root, existing);
    if (!start) throw new HttpError(404, `${repo.id} 里没有分支 ${existing}`);
    const name = start.ref.startsWith("refs/heads/") ? start.ref.slice(11) : start.ref.startsWith("refs/remotes/origin/") ? start.ref.slice(20) : null;
    if (!name) throw new HttpError(400, `${existing} 不是分支`);
    if (!tipOf(root, name)) {
      const made = git(root, ["branch", "--track", name, start.ref]);
      if (!made.ok) throw new HttpError(409, `没能建本地分支 ${name}：${made.stderr.trim().slice(0, 300)}`);
    }
    return { branch: name, base: tipOf(root, name)!, newBranch: false };
  }
  const name = (opts.name ?? `omem/${runId}`).replace(/^refs\/heads\//, "");
  if (!git(root, ["check-ref-format", `refs/heads/${name}`]).ok) throw new HttpError(400, `分支名不合法：${name}`);
  const base = head(root);
  if (!base) throw new HttpError(400, `${repo.id} 还没有提交`);
  const made = git(root, ["branch", name, base]);
  if (!made.ok) throw new HttpError(409, `没能建分支 ${name}：${made.stderr.trim().slice(0, 300)}`);
  const cutFrom = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || undefined;
  return { branch: name, base, newBranch: true, ...(cutFrom ? { cutFrom } : {}) };
}

/**
 * A run that is not running or queued may lose its idle workspace to another run — except a
 * delegation an outside Agent codes (peer-code.ts): between rounds its uncommitted edits live in
 * the workspace, so it keeps it until confirmed or discarded.
 */
const idle = (app: App) => (id: string) => {
  try {
    const run = getRun(app, id);
    const root = run.input.continueFrom ? getRun(app, String(run.input.continueFrom)) : run;
    if ((root.input as { peerCoder?: unknown }).peerCoder && !root.output.appliedAt && !root.output.discardedAt) return false;
    return !["queued", "running"].includes(run.status);
  } catch {
    return true;
  }
};

/**
 * The round's worktree of a work branch at `path`: a lent slot when one can be had (taken back
 * from an idle delegation if need be), else a worktree of its own there. Then placed on the branch.
 */
export function branchWorktree(app: App, repo: Space, runId: string, path: string, wt: WorktreeRef | BranchPlan, log: (text: string) => void): { wt: WorktreeRef; note: string } {
  const root = repo.rootPath!;
  const ref: WorktreeRef = "space" in wt
    ? { ...wt }
    : { space: repo.id, path, branch: wt.branch, base: wt.base, start: wt.base, targetBranch: wt.branch, commits: true, ...(wt.newBranch ? { newBranch: true } : {}), ...(wt.cutFrom ? { cutFrom: wt.cutFrom } : {}) };
  if (!existsSync(ref.path)) {
    delete ref.slot;
    const slot = leaseWorkspace(app, repo, runId, path, log, { idle: idle(app) });
    if (slot) ref.slot = slot.path;
    else {
      git(root, ["worktree", "prune"]);
      const made = git(root, ["worktree", "add", "-q", "--detach", path, tipOf(root, ref.branch) ?? ref.base]);
      if (!made.ok) throw new Error(`在 ${repo.id} 创建工作区失败：${made.stderr}`);
    }
  }
  return { wt: ref, note: placeOnBranch(root, ref) };
}

/**
 * Put the worktree at the branch's latest commit before a round: on the branch itself when it is
 * checked out nowhere else, detached at its tip when it is (the owner runs it there). Commits a
 * previous round could not put back on the branch stay where they are. Returns what the coding
 * Agent should know about it.
 */
export function placeOnBranch(root: string, wt: WorktreeRef): string {
  const dir = workDirOf(wt);
  // A merge or rebase stopped on conflicts waits here for the owner: the round finishes it in place.
  if (syncInProgress(dir) || hasSyncStash(dir)) return `工作区里有一次没做完的同步（${wt.branch}），宿主会先把它做完。`;
  let tip = tipOf(root, wt.branch);
  if (!tip) {
    // Deleted meanwhile: brought back where the worktree is.
    git(root, ["branch", wt.branch, head(dir)]);
    tip = head(dir);
  }
  const at = head(dir);
  if (wt.pending && at === wt.pending && at !== tip && !ancestor(dir, at, tip)) {
    git(dir, ["checkout", "-q", "--detach"]);
    return `工作区里有上一轮没能放回分支 ${wt.branch} 的提交，你在游离 HEAD 上接着做。${ancestor(dir, tip, at) ? "" : `分支 ${wt.branch} 之后又有了新提交（本人在别处提交的）：先 \`git merge ${wt.branch}\` 并解决冲突。`}`;
  }
  const elsewhere = checkedOutAt(root, wt.branch, dir);
  const moved = elsewhere ? git(dir, ["checkout", "-q", "--detach", tip]) : git(dir, ["checkout", "-q", wt.branch]);
  if (!moved.ok) throw new Error(`没能把工作区切到分支 ${wt.branch}：${moved.stderr.trim().slice(0, 300)}`);
  return elsewhere
    ? `分支 ${wt.branch} 正在 ${elsewhere} 检出（本人在那里运行和验证），所以工作区停在它最新提交的游离 HEAD 上。照常提交，宿主在这一轮结束后把提交快进到那里；不要切换分支，也不要改分支名。`
    : `你在分支 ${wt.branch} 上。${wt.newBranch && wt.branch.startsWith("omem/") ? `这是临时名字：按这次的功能起一个合适的分支名（参照仓库已有分支的命名习惯，如 feat/xxx、fix/xxx），用 \`git branch -m ${wt.branch} <新名字>\` 改。` : ""}`;
}

export type Settled = { committed: string | null; branch: string; renamed?: string; followed?: string; followError?: string };

/**
 * End of a round: what the coding Agent (or the checks) left uncommitted becomes a commit, a
 * rename is read back, commits made on a detached HEAD go onto the branch (fast-forwarding the
 * checkout that has it), and the worktree is detached again.
 */
export function settleRound(root: string, wt: WorktreeRef, message: string): Settled {
  const dir = workDirOf(wt);
  git(dir, ["add", "-A"]);
  let committed: string | null = null;
  if (git(dir, ["diff", "--cached", "--quiet"]).ok === false) {
    const c = git(dir, [...identity(dir), "commit", "-q", "--no-verify", "-m", message]);
    if (!c.ok) throw new Error(`没能提交剩下的改动：${c.stderr.trim().slice(0, 400)}`);
    committed = head(dir);
  }
  const out: Settled = { committed, branch: wt.branch };
  const on = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (on && on !== wt.branch && !tipOf(root, wt.branch)) {
    out.renamed = wt.branch;
    wt.branch = wt.targetBranch = out.branch = on;
  }
  const at = head(dir);
  const tip = tipOf(root, wt.branch);
  if (!on && tip !== at) {
    const elsewhere = checkedOutAt(root, wt.branch, dir);
    if (elsewhere) {
      const ff = git(elsewhere, ["merge", "--ff-only", "-q", at]);
      if (ff.ok) out.followed = elsewhere;
      else out.followError = `${elsewhere} 没能快进到这一轮的提交（${(ff.stderr || ff.stdout).trim().slice(0, 300)}）：那里在 ${wt.branch} 上有新提交，或者没提交的改动和这些提交改了同一批文件。提交留在工作区，下一轮会先把分支合并进来`;
    } else if (!git(root, ["update-ref", `refs/heads/${wt.branch}`, at, ...(tip ? [tip] : [])]).ok) out.followError = `分支 ${wt.branch} 在这一轮里被移动过，没能放上这一轮的提交；提交留在工作区`;
  } else if (on && on !== wt.branch) {
    out.followError = `编码 Agent 切到了别的分支 ${on}，这一轮的提交在那条分支上`;
  }
  if (out.followError && !on) wt.pending = at;
  else delete wt.pending;
  git(dir, ["checkout", "-q", "--detach"]);
  return out;
}

/** Other open delegations on the repository's branches, for the coding Agent to know about (and pick from). */
export function siblingsText(app: App, space: string, rootRunId: string) {
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const roots = all<{ id: string; title: string; status: string }>(app.db, "select id, title, status from runs where kind = 'code' and id != ? and json_extract(input, '$.continueFrom') is null and json_extract(output, '$.appliedAt') is null and json_extract(output, '$.discardedAt') is null and created_at > ? order by created_at desc limit 30", rootRunId, since);
  const lines: string[] = [];
  for (const r of roots) {
    const wt = ((getRun(app, r.id).output.worktrees ?? []) as WorktreeRef[]).find((w) => w.space === space && w.commits);
    if (!wt) continue;
    const latest = all<{ status: string }>(app.db, "select status from runs where id = ? or json_extract(input, '$.continueFrom') = ? order by created_at desc limit 1", r.id, r.id)[0]?.status ?? r.status;
    lines.push(`- ${wt.branch}：${r.title}（${latest === "running" || latest === "queued" ? "进行中" : "待确认"}）`);
  }
  return lines.length ? `同一仓库里还没确认的其他交办（分支是共享的，需要它们的改动时可以 \`git log <分支>\`、\`git cherry-pick <提交>\`；不要改它们的分支）：\n${lines.join("\n")}` : "";
}

type Target = { first: string; wt: WorktreeRef; root: string; wts: WorktreeRef[] };

function targetOf(app: App, runId: string, space: string, opts: { idle?: boolean } = {}): Target {
  const run = getRun(app, runId);
  const first = String(run.input.continueFrom ?? run.id);
  const wts = (getRun(app, first).output.worktrees ?? []) as WorktreeRef[];
  const wt = wts.find((w) => w.space === space && w.commits);
  if (!wt) throw new HttpError(404, `这次交办在 ${space} 上没有工作分支`);
  const root = findSpace(app, space)?.rootPath;
  if (!root || !existsSync(root)) throw new HttpError(409, `空间 ${space} 的仓库目录不在了`);
  if (opts.idle !== false && rounds(app, first).some((r) => ["queued", "running"].includes(r.status))) throw new HttpError(409, "交办正在进行，等这一轮结束再操作分支");
  return { first, wt, root, wts };
}

const rounds = (app: App, first: string) => all<{ id: string; status: string }>(app.db, "select id, status from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?) order by created_at", first, first);

const saveWts = (app: App, first: string, wts: WorktreeRef[]) => setRunOutput(app, first, { worktrees: wts });

/** Each repository's work branch for the run page: its commits, where it is checked out, how it stands against origin. */
export function branchStatus(app: App, runId: string) {
  const run = getRun(app, runId);
  const first = String(run.input.continueFrom ?? run.id);
  const out = getRun(app, first).output;
  return ((out.worktrees ?? []) as WorktreeRef[]).filter((w) => w.commits).map((wt) => {
    const root = findSpace(app, wt.space)?.rootPath ?? "";
    const tip = root ? tipOf(root, wt.branch) : null;
    const base = tip ? changeBase(root, wt, tip) : wt.base;
    const log = tip ? git(root, ["log", "--no-color", "--format=%H%x09%an%x09%aI%x09%s", "-n", "50", `${base}..${tip}`]).stdout.split("\n").filter(Boolean).map((l) => {
      const [hash, author, at, ...subject] = l.split("\t");
      return { hash, author, at, subject: subject.join("\t") };
    }) : [];
    const stat = tip ? git(root, ["diff", "--shortstat", base, tip]).stdout.trim() : "";
    const remote = root ? git(root, ["remote", "get-url", "origin"]).ok : false;
    const tracking = root ? git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wt.branch}`]).stdout.trim() : "";
    const counts = tip && tracking ? git(root, ["rev-list", "--left-right", "--count", `${tip}...${tracking}`]).stdout.trim().split(/\s+/).map(Number) : null;
    const checkedOut = root && tip ? checkedOutAt(root, wt.branch, existsSync(wt.path) ? workDirOf(wt) : undefined) : null;
    return {
      space: wt.space, branch: wt.branch, exists: !!tip, tip, base, cutFrom: wt.cutFrom ?? null, newBranch: !!wt.newBranch,
      commits: log, stat, root, mainBranch: root ? git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || null : null,
      checkedOut, inMain: !!checkedOut && !!root && same(checkedOut, root),
      workspace: existsSync(wt.path) ? workDirOf(wt) : null,
      remote, pushed: !!tracking, ahead: counts?.[0] ?? null, behind: counts?.[1] ?? null,
      pushedAt: ((out.pushed ?? []) as { space: string; at: string }[]).find((p) => p.space === wt.space)?.at ?? null,
    };
  });
}

/** Rename the work branch (everywhere it is checked out too). */
export function renameWorkBranch(app: App, runId: string, space: string, name: string) {
  const t = targetOf(app, runId, space);
  const next = name.trim().replace(/^refs\/heads\//, "");
  if (!next || !git(t.root, ["check-ref-format", `refs/heads/${next}`]).ok) throw new HttpError(400, `分支名不合法：${name}`);
  if (next === t.wt.branch) return { branch: next };
  if (tipOf(t.root, next)) throw new HttpError(409, `已经有分支 ${next}`);
  const r = git(t.root, ["branch", "-m", t.wt.branch, next]);
  if (!r.ok) throw new HttpError(409, `改名失败：${r.stderr.trim().slice(0, 400)}`);
  t.wt.branch = t.wt.targetBranch = next;
  saveWts(app, t.first, t.wts);
  return { branch: next };
}

/** Check the work branch out in the repository's own directory, so the owner runs it there; later rounds fast-forward it. */
export function checkoutInMain(app: App, runId: string, space: string) {
  const t = targetOf(app, runId, space);
  if (!tipOf(t.root, t.wt.branch)) throw new HttpError(404, `分支 ${t.wt.branch} 不在了`);
  const at = git(t.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if (at === t.wt.branch) return { path: t.root, branch: at };
  if (git(t.root, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim()) throw new HttpError(409, `${t.root} 有没提交的改动，先提交或暂存再切到 ${t.wt.branch}`);
  const r = git(t.root, ["checkout", "-q", t.wt.branch]);
  if (!r.ok) throw new HttpError(409, `没能在 ${t.root} 检出 ${t.wt.branch}：${r.stderr.trim().slice(0, 400)}`);
  return { path: t.root, branch: t.wt.branch, from: at || null };
}

/** Squash the work branch into one commit on top of where its changes start. */
export function squashWorkBranch(app: App, runId: string, space: string, message: string) {
  const t = targetOf(app, runId, space);
  if (!message.trim()) throw new HttpError(400, "填写压缩后的提交信息");
  const tip = tipOf(t.root, t.wt.branch);
  if (!tip) throw new HttpError(404, `分支 ${t.wt.branch} 不在了`);
  const base = changeBase(t.root, t.wt, tip);
  if (base === tip) throw new HttpError(400, "分支上没有新提交");
  const made = git(t.root, [...identity(t.root), "commit-tree", `${tip}^{tree}`, "-p", base, "-F", "-"], message.trim());
  if (!made.ok) throw new HttpError(409, `压缩失败：${made.stderr.trim().slice(0, 400)}`);
  const squashed = made.stdout.trim();
  const elsewhere = checkedOutAt(t.root, t.wt.branch);
  // Same tree: the checkout's files stay as they are, only its HEAD moves.
  const moved = elsewhere ? git(elsewhere, ["reset", "-q", "--soft", squashed]) : git(t.root, ["update-ref", `refs/heads/${t.wt.branch}`, squashed, tip]);
  if (!moved.ok) throw new HttpError(409, `压缩失败：${moved.stderr.trim().slice(0, 400)}`);
  return { branch: t.wt.branch, before: tip, head: squashed, count: Number(git(t.root, ["rev-list", "--count", `${base}..${tip}`]).stdout.trim()) };
}

function releaseWorktree(root: string, first: string, wt: WorktreeRef) {
  if (wt.slot) releaseWorkspace(first, wt);
  else if (existsSync(wt.path)) git(root, ["worktree", "remove", "--force", wt.path]);
  git(root, ["worktree", "prune"]);
}

/**
 * The owner's confirmation: optionally squash, push each work branch to origin (set as upstream;
 * with a lease when it was squashed or `force`), then give the workspaces back. Branches stay.
 */
export function confirmBranchRun(app: App, runId: string, opts: { squash?: string; force?: boolean; push?: boolean } = {}) {
  const run = getRun(app, runId);
  const first = String(run.input.continueFrom ?? run.id);
  const firstRun = getRun(app, first);
  if (run.status !== "done") throw new HttpError(400, "只能确认已完成的交办");
  if (firstRun.output.appliedAt) throw new HttpError(409, "这次交办已经确认过");
  if (firstRun.output.discardedAt) throw new HttpError(409, "这次交办已经丢弃");
  if ((firstRun.output.syncPending as unknown[] | undefined)?.length) throw new HttpError(409, "还有没处理完的 Git 冲突，先在提醒卡片里继续或放弃这次同步");
  const wts = ((firstRun.output.worktrees ?? []) as WorktreeRef[]).filter((w) => w.commits);
  const pushed: { space: string; branch: string; at: string; forced?: boolean }[] = [];
  const notes: string[] = [];
  for (const wt of wts) {
    const t = targetOf(app, runId, wt.space);
    if (wt.pending) throw new HttpError(409, `${wt.space} 有一轮的提交没能放回分支 ${wt.branch}（${wt.pending.slice(0, 8)}，在工作区里）：续一轮让编码 Agent 合并进来，再确认`);
    let force = !!opts.force;
    if (opts.squash?.trim()) {
      const s = squashWorkBranch(app, runId, wt.space, opts.squash);
      notes.push(`${wt.space}：${s.count} 个提交压缩成一个`);
      force = true;
    }
    if (opts.push === false || !git(t.root, ["remote", "get-url", "origin"]).ok) {
      notes.push(`${wt.space}：${opts.push === false ? "没有推送" : "没有 origin，只在本地"}`);
      continue;
    }
    fetchBranch(t.root, wt.branch);
    const tip = tipOf(t.root, wt.branch)!;
    const known = git(t.root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wt.branch}`]).stdout.trim();
    if (known && !ancestor(t.root, known, tip) && !force)
      throw new HttpError(409, `origin/${wt.branch} 有本地没有的提交：先在分支面板“合并到”origin/${wt.branch}，或者确认要覆盖时选“强制推送”`);
    const lease = known && !ancestor(t.root, known, tip) ? [`--force-with-lease=refs/heads/${wt.branch}:${known}`] : [];
    const r = git(t.root, ["-c", "remote.origin.mirror=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", ...lease, "origin", `refs/heads/${wt.branch}:refs/heads/${wt.branch}`]);
    if (!r.ok) throw new HttpError(409, `${pushed.length ? `${pushed.map((p) => p.branch).join("、")} 已推送；` : ""}推送 ${wt.space} 的 ${wt.branch} 失败：${(r.stderr || r.stdout).trim().slice(0, 800)}`);
    git(t.root, ["branch", `--set-upstream-to=origin/${wt.branch}`, wt.branch]);
    pushed.push({ space: wt.space, branch: wt.branch, at: new Date().toISOString(), ...(lease.length ? { forced: true } : {}) });
  }
  for (const wt of wts) {
    const root = getSpace(app, wt.space).rootPath!;
    releaseWorktree(root, first, wt);
  }
  for (const s of worktreeSpacesOf(app, first)) dropWorktreeSpace(app, s.id);
  const appliedAt = new Date().toISOString();
  const appliedTo = wts.map((wt) => {
    const root = getSpace(app, wt.space).rootPath!;
    return { space: wt.space, path: checkedOutAt(root, wt.branch) ?? root, branch: wt.branch };
  });
  for (const id of new Set([first, runId])) setRunOutput(app, id, { appliedAt, appliedTo, pushed, confirmNotes: notes });
  for (const r of rounds(app, first)) cancelHostAsks(app, r.id, "review-done");
  return { applied: true, spaces: wts.map((w) => w.space), targets: appliedTo, pushed, notes };
}

/**
 * Let a delegation go: give its workspaces back; a branch it made, never pushed and checked out
 * nowhere is deleted with it when `discard`; without it only the workspaces go (an item that ended).
 */
export function releaseBranchRun(app: App, runId: string, opts: { discard?: boolean } = {}) {
  const run = getRun(app, runId);
  const first = String(run.input.continueFrom ?? run.id);
  const deleted: string[] = [];
  for (const wt of ((getRun(app, first).output.worktrees ?? []) as WorktreeRef[]).filter((w) => w.commits)) {
    const root = findSpace(app, wt.space)?.rootPath;
    if (!root || !existsSync(root)) continue;
    releaseWorktree(root, first, wt);
    if (!opts.discard || !wt.newBranch) continue;
    const pushed = git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wt.branch}`]).ok;
    if (!pushed && !checkedOutAt(root, wt.branch) && git(root, ["branch", "-D", wt.branch]).ok) deleted.push(wt.branch);
  }
  if (opts.discard) for (const s of worktreeSpacesOf(app, first)) dropWorktreeSpace(app, s.id);
  return { deleted };
}

/** An item ended: its delegations that are not running give their workspaces back (branches stay for later). */
export function releaseItemWorkspaces(app: App, itemId: string) {
  const runs = all<{ ref: string }>(app.db, "select ref from item_materials where item_id = ? and kind = 'run'", itemId);
  const released: string[] = [];
  for (const { ref } of runs) {
    let first: string;
    try {
      first = String(getRun(app, ref).input.continueFrom ?? ref);
    } catch {
      continue;
    }
    const out = getRun(app, first).output;
    if (out.appliedAt || out.discardedAt) continue;
    if (rounds(app, first).some((r) => ["queued", "running"].includes(r.status))) continue;
    const wts = ((out.worktrees ?? []) as WorktreeRef[]).filter((w) => w.commits && existsSync(w.path));
    if (wts.some((w) => w.pending)) continue;
    if (!wts.length) continue;
    releaseBranchRun(app, first);
    released.push(first);
  }
  return released;
}

export const ownerOnly = (userId: string | null | undefined) => {
  if ((userId ?? OWNER) !== OWNER) throw new HttpError(403, "分支操作只对本人开放");
};
