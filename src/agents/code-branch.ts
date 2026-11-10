import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { refreshDefaultBaseRef, fetchBranch, fetchBranchAsync, git, resolveRef } from "../core/git.ts";
import { findSpace, getSpace, type Space } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { OWNER } from "../core/users.ts";
import { cancelHostAsks, ROUND_ASKS } from "./asks.ts";
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
export const identity = (path: string) => (git(path, ["config", "user.email"]).stdout.trim() ? [] : ID);
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

/**
 * The commit the branch's changes at `at` are measured from: where it left the branch it was cut
 * from; on a reused existing branch, the latest commit of its origin copy the work contains
 * (`diffBase`, merge-base for an older `at`); else where the work began.
 */
export function changeBase(dir: string, wt: WorktreeRef, at = "HEAD") {
  if (wt.cutFrom) {
    const baseRef = resolveRef(dir, `refs/remotes/origin/${wt.cutFrom}`) ? `refs/remotes/origin/${wt.cutFrom}` : `refs/heads/${wt.cutFrom}`;
    const mb = git(dir, ["merge-base", at, baseRef]);
    if (mb.ok && ancestor(dir, wt.base, mb.stdout.trim())) return mb.stdout.trim();
  }
  if (wt.diffBase) {
    // A checkpoint from before a later sync does not contain the newer diffBase: the origin commit it
    // did contain is their merge-base.
    const mb = git(dir, ["merge-base", wt.diffBase, at]);
    if (mb.ok && mb.stdout.trim()) return mb.stdout.trim();
  }
  return wt.start ?? wt.base;
}

/** Where a reused branch's comparison starts: the newest commit both it and its origin copy have. */
export function sharedWithOrigin(root: string, branch: string, at: string): string {
  const remote = resolveRef(root, `refs/remotes/origin/${branch}`);
  const mb = remote ? git(root, ["merge-base", at, remote.commit]) : null;
  return mb?.ok && mb.stdout.trim() ? mb.stdout.trim() : at;
}

/**
 * A delegation on a reused branch from before `diffBase` was recorded compared with the commit
 * the branch was at when it was picked, so everything the first sync pulled from origin showed as
 * its change. Its comparison starts where the branch and its origin copy meet now — unless origin
 * already has one of the delegation's coding rounds (it was pushed): then that is not known and
 * the recorded start stays. In memory only; the next round saves it with the worktrees.
 */
export function withDiffBase(app: App, rootId: string, wt: WorktreeRef): WorktreeRef {
  if (!wt.commits || wt.newBranch || wt.cutFrom || wt.diffBase || !wt.targetBranch) return wt;
  const root = findSpace(app, wt.space)?.rootPath;
  if (!root || !resolveRef(root, `refs/remotes/origin/${wt.targetBranch}`)) return wt;
  const tip = wt.pending ?? tipOf(root, wt.branch);
  const start = wt.start ?? wt.base;
  if (!tip) return wt;
  const shared = sharedWithOrigin(root, wt.targetBranch, tip);
  if (shared === start || shared === tip || !ancestor(root, start, shared)) return wt;
  const rounds = new Set(all<{ id: string }>(app.db, "select id from runs where id = ? or json_extract(input, '$.continueFrom') = ?", rootId, rootId).map((r) => r.id));
  const coded = all<{ heads: string; by: string }>(app.db, "select heads, by from code_checkpoints where work_id = ?", rootId)
    .filter((c) => rounds.has(c.by)).map((c) => (JSON.parse(c.heads) as Record<string, string>)[wt.space]).filter(Boolean);
  if (coded.some((h) => ancestor(root, h, shared))) return wt;
  return { ...wt, diffBase: shared };
}

/**
 * Squashing or reverting everything from `from` rewrites or undoes the commits in from..to; they
 * must all be this delegation's. Refused, so the owner reverts by task instead, when some are on
 * origin already (the branch was pushed, or a sync took in commits after the comparison base), or
 * the branch had them before the delegation began (the owner's commits not yet pushed).
 */
export function assertOwnRange(dir: string, wt: WorktreeRef, from: string, to: string) {
  if (!wt.commits) return;
  const start = wt.start ?? wt.base;
  if (ancestor(dir, start, to) && !ancestor(dir, start, from))
    throw new HttpError(409, `${wt.space} 的这段提交里有交办开始前分支上就有的提交（${start.slice(0, 8)} 及以前，还没推送到 origin），整段压缩或回退会把它们一起撤掉；请按修改项回退`);
  const name = wt.cutFrom ?? wt.targetBranch;
  const remote = name ? resolveRef(dir, `refs/remotes/origin/${name}`) : null;
  if (!remote) return;
  const count = (...args: string[]) => git(dir, ["rev-list", "--count", ...args]).stdout.trim();
  if (count(to, `^${from}`) !== count(to, `^${from}`, `^${remote.commit}`))
    throw new HttpError(409, `${wt.space} 的这段提交里有 origin/${name} 上已有的提交（已推送，或同步进来的公共提交），整段压缩或回退会撤掉它们；请按修改项回退`);
}

export type BranchPlan = { branch: string; base: string; newBranch: boolean; cutFrom?: string; diffBase?: string };

/**
 * The work branch of a new delegation in `repo`: an existing branch (`from`, made local when only
 * origin has it), a new one named `name` (an existing local one is used as it is), or a temporary
 * `omem/<run>` the coding Agent renames. New branches start at the refreshed default branch (local HEAD only without a default).
 */
export async function planBranch(repo: Space, runId: string, opts: { from?: string; name?: string }): Promise<BranchPlan> {
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
    // The local copy may be far behind origin: the comparison starts where the two meet, not at
    // the local tip (the first round's sync pulls origin in and moves it on, code-sync.ts).
    await fetchBranchAsync(root, name);
    const base = tipOf(root, name)!;
    return { branch: name, base, newBranch: false, diffBase: sharedWithOrigin(root, name, base) };
  }
  const name = (opts.name ?? `omem/${runId}`).replace(/^refs\/heads\//, "");
  if (!git(root, ["check-ref-format", `refs/heads/${name}`]).ok) throw new HttpError(400, `分支名不合法：${name}`);
  const baseRef = await refreshDefaultBaseRef(root);
  if (baseRef && git(root, ["remote", "get-url", "origin"]).ok) {
    const fetched = await fetchBranchAsync(root, baseRef);
    if (!fetched.ok) throw new HttpError(409, `更新默认分支失败：${fetched.stderr.trim().slice(0, 300)}`);
  }
  const base = (baseRef ? resolveRef(root, baseRef.startsWith("origin/") ? baseRef : `origin/${baseRef}`)?.commit ?? resolveRef(root, baseRef)?.commit : null) ?? head(root);
  if (!base) throw new HttpError(400, `${repo.id} 还没有提交`);
  const made = git(root, ["branch", name, base]);
  if (!made.ok) throw new HttpError(409, `没能建分支 ${name}：${made.stderr.trim().slice(0, 300)}`);
  const cutFrom = baseRef?.replace(/^origin\//, "") ?? (git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || undefined);
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
    : { space: repo.id, path, branch: wt.branch, base: wt.base, start: wt.base, targetBranch: wt.branch, commits: true, ...(wt.newBranch ? { newBranch: true } : {}), ...(wt.cutFrom ? { cutFrom: wt.cutFrom } : {}), ...(wt.diffBase ? { diffBase: wt.diffBase } : {}) };
  const fresh = !existsSync(ref.path);
  if (fresh) {
    delete ref.slot;
    const slot = leaseWorkspace(app, repo, runId, path, log, { idle: idle(app) });
    if (slot) ref.slot = slot.path;
    else {
      git(root, ["worktree", "prune"]);
      const made = git(root, ["worktree", "add", "-q", "--detach", path, tipOf(root, ref.branch) ?? ref.base]);
      if (!made.ok) throw new Error(`在 ${repo.id} 创建工作区失败：${made.stderr}`);
    }
  }
  return { wt: ref, note: placeOnBranch(root, ref, { fresh }) };
}

/**
 * Put the worktree at the branch's latest commit before a round: on the branch itself when it is
 * checked out nowhere else, detached at its tip when it is (the owner runs it there). Commits a
 * previous round could not put back on the branch stay where they are. Returns what the coding
 * Agent should know about it.
 */
export function placeOnBranch(root: string, wt: WorktreeRef, opts: { fresh?: boolean } = {}): string {
  const dir = workDirOf(wt);
  // Keep interrupted operations (including picks/reverts) in place for the conflict resolver.
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
  // This run's own workspace already has commits on top of the branch that a round has not put
  // back yet (a peer Agent commits during its round; the host settles them only at the end of the
  // round its `finish` queues). Moving to the tip would leave them behind, so build on them; the
  // end of this round puts them on the branch. A workspace just leased may hold another run's
  // leftovers, so it always starts from the tip.
  if (!opts.fresh && at !== tip && ancestor(dir, tip, at)) {
    if (elsewhere) {
      git(dir, ["checkout", "-q", "--detach", at]);
      return `工作区里有还没放回分支 ${wt.branch} 的提交（${at.slice(0, 8)}），在它们上面接着做；分支 ${wt.branch} 正在 ${elsewhere} 检出，这一轮结束后宿主把提交快进到那里。不要切换分支，也不要改分支名。`;
    }
    const forward = git(dir, ["checkout", "-q", "-B", wt.branch, at]);
    if (!forward.ok) throw new Error(`没能把分支 ${wt.branch} 快进到工作区的提交：${forward.stderr.trim().slice(0, 300)}`);
    return `你在分支 ${wt.branch} 上（已快进到工作区里还没放回分支的提交 ${at.slice(0, 8)}）。`;
  }
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
  const wts = ((getRun(app, first).output.worktrees ?? []) as WorktreeRef[]).map((w) => withDiffBase(app, first, w));
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
  return ((out.worktrees ?? []) as WorktreeRef[]).filter((w) => w.commits).map((w) => withDiffBase(app, first, w)).map((wt) => {
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

/** What squashing would fold into one commit; checked for every repository before any is squashed. */
function squashRange(t: Target) {
  const tip = tipOf(t.root, t.wt.branch);
  if (!tip) throw new HttpError(404, `分支 ${t.wt.branch} 不在了`);
  const base = changeBase(t.root, t.wt, tip);
  if (base === tip) throw new HttpError(400, "分支上没有新提交");
  assertOwnRange(t.root, t.wt, base, tip);
  return { base, tip };
}

/** Squash the work branch into one commit on top of where its changes start. */
export function squashWorkBranch(app: App, runId: string, space: string, message: string) {
  const t = targetOf(app, runId, space);
  if (!message.trim()) throw new HttpError(400, "填写压缩后的提交信息");
  const { base, tip } = squashRange(t);
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

/** Push one work branch to origin as its upstream; a remote that moved on is refused unless `force` (with a lease). */
function pushWorkBranch(root: string, wt: WorktreeRef, force: boolean, before: { branch: string }[], rev?: string) {
  fetchBranch(root, wt.branch);
  const tip = rev ?? tipOf(root, wt.branch)!;
  const known = git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wt.branch}`]).stdout.trim();
  if (known && !ancestor(root, known, tip) && !force)
    throw new HttpError(409, `origin/${wt.branch} 有本地没有的提交：先在分支面板“合并到”origin/${wt.branch}，或者确认要覆盖时选“强制推送”`);
  const lease = known && !ancestor(root, known, tip) ? [`--force-with-lease=refs/heads/${wt.branch}:${known}`] : [];
  const r = git(root, ["-c", "remote.origin.mirror=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", ...lease, "origin", `${rev ?? `refs/heads/${wt.branch}`}:refs/heads/${wt.branch}`]);
  if (!r.ok) throw new HttpError(409, `${before.length ? `${before.map((p) => p.branch).join("、")} 已推送；` : ""}推送 ${wt.space} 的 ${wt.branch} 失败：${(r.stderr || r.stdout).trim().slice(0, 800)}`);
  git(root, ["branch", `--set-upstream-to=origin/${wt.branch}`, wt.branch]);
  return { space: wt.space, branch: wt.branch, at: new Date().toISOString(), head: tip, ...(lease.length ? { forced: true } : {}) };
}

/**
 * Push the work branches and keep going (“先推上去验证，再接着改”): the workspaces and the work stay,
 * later rounds add to the same branches, and the owner confirms at the end as usual. What goes out is
 * `heads` (a checkpoint the loop reached, so a round coding now does not push half a task), else the
 * branch tips when no round is coding.
 */
export function deliverBranchWork(app: App, runId: string, opts: { force?: boolean; heads?: Record<string, string> } = {}) {
  const first = String(getRun(app, runId).input.continueFrom ?? runId);
  const firstRun = getRun(app, first);
  if (firstRun.output.appliedAt || firstRun.output.discardedAt) throw new HttpError(409, "这次交办已经确认或丢弃了");
  const coding = rounds(app, first).some((r) => ["queued", "running"].includes(r.status));
  if (coding && !opts.heads) throw new HttpError(409, "这一轮还在编码，结束后再推送");
  const wts = ((firstRun.output.worktrees ?? []) as WorktreeRef[]).filter((w) => w.commits);
  if (!wts.length) throw new HttpError(400, "还没有提交，没有可推送的");
  const pushed: ReturnType<typeof pushWorkBranch>[] = [];
  const notes: string[] = [];
  for (const wt of wts) {
    const rev = opts.heads?.[wt.space];
    if (wt.pending && !rev) throw new HttpError(409, `${wt.space} 有一轮的提交没能放回分支 ${wt.branch}（${wt.pending.slice(0, 8)}，在工作区里）：等下一轮合并进来再推送`);
    const t = targetOf(app, runId, wt.space);
    if (!git(t.root, ["remote", "get-url", "origin"]).ok) { notes.push(`${wt.space}：没有 origin，只在本地`); continue; }
    pushed.push(pushWorkBranch(t.root, wt, !!opts.force, pushed, rev));
  }
  return { pushed, notes };
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
  if (opts.squash?.trim()) for (const wt of wts) squashRange(targetOf(app, runId, wt.space));
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
    pushed.push(pushWorkBranch(t.root, wt, force, pushed));
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
  for (const r of rounds(app, first)) cancelHostAsks(app, r.id, [...ROUND_ASKS, "work-deliver"]);
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

const SETTLE_AFTER_MS = 3600_000;
const SETTLE_ASKS = [...ROUND_ASKS, "work-deliver", "code-task", "code-sync"];

/**
 * Work the owner finished elsewhere, settled hourly so it stops waiting on them (docs/v2/coding-work.md):
 * - its branch is on origin with everything it committed, pushed by hand (not by omem's “推送”, which
 *   keeps the work open): it counts as confirmed, and what it left carries on to the next delegation
 *   on the branch, as after a confirm;
 * - a later delegation works on the same branch: it ends there, its open tasks pointing to the newer one.
 * Only work idle for an hour, with no round running and no Git operation stopped half way.
 */
export async function settleCodeWorks(app: App) {
  const since = new Date(Date.now() - 60 * 86400_000).toISOString();
  const roots = all<{ id: string; created_at: string; open: number }>(app.db, `select id, created_at,
      (json_extract(output, '$.appliedAt') is null and json_extract(output, '$.discardedAt') is null and json_extract(output, '$.supersededBy') is null) open
    from runs where kind = 'code' and json_extract(input, '$.continueFrom') is null and json_extract(input, '$.branches') is null and created_at > ? order by created_at`, since);
  const branchesOf = (id: string) => ((getRun(app, id).output.worktrees ?? []) as WorktreeRef[]).map((w) => `${w.space}\0${w.targetBranch ?? w.branch}`);
  const out = { pushed: [] as string[], superseded: [] as string[] };
  for (const r of roots.filter((x) => x.open)) {
    const list = all<{ id: string; status: string; at: string }>(app.db, "select id, status, coalesce(finished_at, started_at, created_at) at from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?)", r.id, r.id);
    if (list.some((x) => ["queued", "running"].includes(x.status))) continue;
    if (all(app.db, "select 1 from runs where kind = 'review' and status in ('queued', 'running') and parent_id in (" + list.map(() => "?").join(",") + ")", ...list.map((x) => x.id)).length) continue;
    const lastAt = list.reduce((t, x) => (x.at > t ? x.at : t), r.created_at);
    if (Date.now() - Date.parse(lastAt) < SETTLE_AFTER_MS) continue;
    const first = getRun(app, r.id);
    if ((first.output.syncPending as unknown[] | undefined)?.length) continue;
    const wts = (first.output.worktrees ?? []) as WorktreeRef[];
    if (!wts.length) continue;
    const settle = (patch: Record<string, unknown>) => {
      for (const id of list.map((x) => x.id)) {
        setRunOutput(app, id, patch);
        cancelHostAsks(app, id, SETTLE_ASKS);
      }
      releaseBranchRun(app, r.id);
      for (const s of worktreeSpacesOf(app, r.id)) dropWorktreeSpace(app, s.id);
    };
    const pushed = await pushedOutside(app, first.output, wts);
    if (pushed) {
      settle({ appliedAt: new Date().toISOString(), settled: "pushed-outside", pushed: [...((first.output.pushed ?? []) as unknown[]), ...pushed] });
      out.pushed.push(r.id);
      continue;
    }
    const mine = new Set(branchesOf(r.id));
    const later = roots.find((x) => x.id !== r.id && x.created_at > lastAt && branchesOf(x.id).some((b) => mine.has(b)));
    if (!later) continue;
    const tasks = await import("./code-tasks.ts");
    for (const t of tasks.listTasks(app, r.id))
      if (["todo", "coding", "verify", "disputed", "assistant", "owner"].includes(t.state))
        tasks.updateTask(app, r.id, t.seq, { state: "wontdo" }, { by: "host", kind: "host", text: `同一分支上后来的交办 ${later.id} 接着做了` });
    settle({ supersededBy: later.id, settled: "superseded" });
    out.superseded.push(r.id);
  }
  return out;
}

/** Each work branch on origin with all it committed, none of it pushed by omem: the branches as pushed, else null. */
async function pushedOutside(app: App, out: Record<string, unknown>, wts: WorktreeRef[]) {
  const mine = wts.filter((w) => w.commits);
  if (!mine.length || mine.some((w) => w.pending)) return null;
  const delivered = new Set([
    ...((out.pushed ?? []) as { space: string; head?: string }[]).map((p) => `${p.space}\0${p.head}`),
    ...(((out.work as { delivered?: { branches: { space: string; head: string }[] }[] } | undefined)?.delivered ?? []).flatMap((d) => d.branches.map((b) => `${b.space}\0${b.head}`))),
  ]);
  const res: { space: string; branch: string; at: string; head: string; outside: true }[] = [];
  for (const wt of mine) {
    const root = findSpace(app, wt.space)?.rootPath;
    const tip = root && existsSync(root) ? tipOf(root, wt.branch) : null;
    if (!root || !tip || delivered.has(`${wt.space}\0${tip}`)) return null;
    await fetchBranchAsync(root, wt.branch);
    const remote = git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${wt.branch}`]).stdout.trim();
    if (!remote || !ancestor(root, tip, remote)) return null;
    res.push({ space: wt.space, branch: wt.branch, at: new Date().toISOString(), head: tip, outside: true });
  }
  return res;
}

export const ownerOnly = (userId: string | null | undefined) => {
  if ((userId ?? OWNER) !== OWNER) throw new HttpError(403, "分支操作只对本人开放");
};
