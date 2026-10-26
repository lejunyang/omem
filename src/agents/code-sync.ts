import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchBranch, git, resolveRef } from "../core/git.ts";
import { HttpError } from "../core/util.ts";
import type { WorktreeRef } from "./worktree-index.ts";

/**
 * Bringing a delegation's worktree up to date before (or instead of) coding: pull the target
 * branch's remote commits, then merge or rebase onto another branch. Git does the work; the coding
 * Agent only resolves conflicts (it may ask the owner), and what it cannot resolve stops the run
 * for the owner. The resulting commits are delivered by fast-forwarding the target branch on apply
 * (code.ts), the coding changes after them as the usual uncommitted patch.
 *
 * `moveToTarget` is the other direction: the run's unapplied work (and its sync commits) rebased
 * onto the target branch's latest commit, when the branch moved and the patch no longer applies.
 */
export type SyncMode = "merge" | "rebase";
export type SyncRequest = {
  /** Bring in the target branch's commits from origin first (fast-forward when possible). */
  pull?: boolean;
  /** Another branch to merge or rebase onto (e.g. main), its latest commit (fetched first). */
  onto?: string;
  mode?: SyncMode;
  /** Fetch from origin first (default true). */
  fetch?: boolean;
};
export type SyncStep = { label: string; from: string; to: string; conflicts: string[] };
export type SyncState = { op: "merge" | "rebase"; label: string; conflicts: string[] };
/** Resolves the listed conflicts in the worktree (the coding Agent): leaves them resolved or not. */
export type Resolver = (files: string[], label: string) => Promise<void>;

const ID = ["-c", "user.name=omem", "-c", "user.email=omem@localhost"];
/** Git refuses to commit without a name; the repository's own identity wins when it has one. */
function identity(path: string) {
  return git(path, ["config", "user.email"]).stdout.trim() ? [] : ID;
}
const head = (path: string) => git(path, ["rev-parse", "HEAD"]).stdout.trim();
const unmerged = (path: string) => git(path, ["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean);

/** A merge or rebase stopped half way in this worktree. */
export function syncInProgress(path: string): "merge" | "rebase" | null {
  const at = (name: string) => existsSync(resolve(path, git(path, ["rev-parse", "--git-path", name]).stdout.trim()));
  if (at("rebase-merge") || at("rebase-apply")) return "rebase";
  if (at("MERGE_HEAD")) return "merge";
  return null;
}

/** Files that still carry conflict markers (resolved in the index but not in the text). */
function withMarkers(path: string, files: string[]) {
  return files.filter((f) => {
    try {
      return /^(<{7}|>{7}) /m.test(readFileSync(join(path, f), "utf8"));
    } catch {
      return false;
    }
  });
}

/** The newest of a branch's local and origin copies: the remote one when the local is behind it. */
function freshest(root: string, name: string): { ref: string; commit: string } | null {
  const short = name.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  const local = resolveRef(root, `refs/heads/${short}`);
  const remote = resolveRef(root, `refs/remotes/origin/${short}`);
  if (local && remote && local.commit !== remote.commit && git(root, ["merge-base", "--is-ancestor", local.commit, remote.commit]).ok) return remote;
  return local ?? remote ?? resolveRef(root, name);
}

function start(path: string, op: SyncMode, commit: string) {
  return op === "merge" ? git(path, [...identity(path), "merge", "--no-ff", "--no-edit", commit]) : git(path, [...identity(path), "rebase", "--rebase-merges", commit]);
}
function proceed(path: string, op: SyncMode) {
  return op === "merge" ? git(path, [...identity(path), "commit", "--no-edit"]) : git(path, [...identity(path), "-c", "core.editor=true", "rebase", "--continue"]);
}

/**
 * Carry a stopped merge or rebase to its end: each round of conflicts goes to the resolver, then
 * Git continues. Returns what is still unresolved (the run stops and asks the owner), or null.
 */
export async function finishSync(path: string, label: string, resolver: Resolver, conflicts: string[] = []): Promise<SyncState | null> {
  for (let round = 0; round < 20; round++) {
    const op = syncInProgress(path);
    if (!op) return null;
    let files = unmerged(path);
    if (files.length) {
      conflicts.push(...files.filter((f) => !conflicts.includes(f)));
      await resolver(files, label);
      files = [...new Set([...unmerged(path), ...withMarkers(path, files)])];
      if (files.length) return { op, label, conflicts: files };
      git(path, ["add", "-A"]);
    }
    const r = proceed(path, op);
    // Nothing left to commit in this step (the resolution took one side entirely): skip it.
    if (!r.ok && op === "rebase" && !unmerged(path).length && /nothing to commit|empty/i.test(r.stderr + r.stdout)) git(path, ["-c", "core.editor=true", "rebase", "--skip"]);
    else if (!r.ok && !unmerged(path).length && syncInProgress(path)) throw new HttpError(409, `${label}没能继续：${(r.stderr || r.stdout).slice(0, 600)}`);
  }
  throw new HttpError(409, `${label}的冲突一直没有处理完`);
}

/** Run one merge or rebase step; conflicts go to the resolver. */
async function step(path: string, op: SyncMode, target: { ref: string; commit: string }, label: string, resolver: Resolver, steps: SyncStep[]): Promise<SyncState | null> {
  const from = head(path);
  const conflicts: string[] = [];
  const r = start(path, op, target.commit);
  if (!r.ok && !syncInProgress(path)) throw new HttpError(409, `${label}失败：${(r.stderr || r.stdout).slice(0, 600)}`);
  const left = await finishSync(path, label, resolver, conflicts);
  steps.push({ label, from, to: head(path), conflicts });
  return left;
}

/**
 * Bring the worktree up to date as asked. `targetBranch` is the branch the work lands on (its
 * origin copy is what `pull` brings in). Returns the steps taken and, when conflicts were left,
 * where it stopped.
 */
export async function syncWorktree(root: string, wt: WorktreeRef, req: SyncRequest, resolver: Resolver, status: (text: string) => void) {
  const path = wt.path;
  // Work already in the worktree (a later round) waits in the stash while Git merges or rebases.
  const stashed = !!git(path, ["status", "--porcelain"]).stdout.trim();
  if (stashed) {
    const st = git(path, [...identity(path), "stash", "push", "-q", "--include-untracked", "-m", STASH]);
    if (!st.ok) throw new HttpError(409, `暂存未提交的改动失败：${st.stderr.slice(0, 600)}`);
  }
  const r = await syncSteps(root, wt, req, resolver, status);
  if (r.stopped || !stashed) return { ...r, stashed };
  const left = await popStash(path, resolver);
  return { ...r, stopped: left, stashed: !!left };
}

const STASH = "omem: 同步前未提交的改动";
/** Put the stashed work back on top of the synced code; its conflicts go to the resolver. */
export async function popStash(path: string, resolver: Resolver): Promise<SyncState | null> {
  const list = git(path, ["stash", "list", "--format=%gd %s"]).stdout.split("\n").find((l) => l.includes(STASH));
  if (!list) return null;
  const ref = list.split(" ")[0];
  const again = git(path, ["stash", "apply", ref]);
  if (!again.ok) {
    const files = unmerged(path);
    if (!files.length) throw new HttpError(409, `放回未提交的改动失败：${again.stderr.slice(0, 600)}`);
    await resolver(files, "放回同步前的改动");
    const left = [...new Set([...unmerged(path), ...withMarkers(path, files)])];
    if (left.length) return { op: "merge", label: "放回同步前的改动", conflicts: left };
    git(path, ["add", "-A"]);
  }
  git(path, ["stash", "drop", "-q", ref]);
  return null;
}

async function syncSteps(root: string, wt: WorktreeRef, req: SyncRequest, resolver: Resolver, status: (text: string) => void) {
  const steps: SyncStep[] = [];
  const mode: SyncMode = req.mode ?? "merge";
  const path = wt.path;
  if (req.fetch !== false) {
    for (const name of new Set([req.pull ? wt.targetBranch : null, req.onto].filter((x): x is string => !!x))) {
      const f = fetchBranch(root, name);
      if (!f.ok) status(`没能从 origin 拉取 ${name}：${f.stderr.trim().slice(0, 200)}（按本地已有的版本继续）`);
    }
  }
  if (req.pull && wt.targetBranch) {
    const remote = resolveRef(root, `refs/remotes/origin/${wt.targetBranch}`);
    const at = head(path);
    if (!remote) status(`origin 上没有 ${wt.targetBranch}，跳过拉取`);
    else if (remote.commit === at || git(path, ["merge-base", "--is-ancestor", remote.commit, at]).ok) status(`${wt.targetBranch} 已经包含 origin 的最新提交`);
    else if (git(path, ["merge-base", "--is-ancestor", at, remote.commit]).ok) {
      const ff = git(path, ["merge", "--ff-only", remote.commit]);
      if (!ff.ok) throw new HttpError(409, `快进到 origin/${wt.targetBranch} 失败：${ff.stderr.slice(0, 600)}`);
      steps.push({ label: `拉取 origin/${wt.targetBranch}（快进）`, from: at, to: head(path), conflicts: [] });
    } else {
      const left = await step(path, mode, remote, `${mode === "merge" ? "合并" : "变基到"} origin/${wt.targetBranch}`, resolver, steps);
      if (left) return { steps, stopped: left };
    }
  }
  if (req.onto) {
    const onto = freshest(root, req.onto);
    if (!onto) throw new HttpError(404, `找不到分支 ${req.onto}`);
    if (git(path, ["merge-base", "--is-ancestor", onto.commit, head(path)]).ok) status(`已经包含 ${req.onto} 的最新提交，不用${mode === "merge" ? "合并" : "变基"}`);
    else {
      const left = await step(path, mode, onto, `${mode === "merge" ? "合并" : "变基到"} ${req.onto}`, resolver, steps);
      if (left) return { steps, stopped: left };
    }
  }
  return { steps, stopped: null as SyncState | null };
}

/** Whether the stash still holds the work a stopped sync set aside. */
export const hasSyncStash = (path: string) => git(path, ["stash", "list", "--format=%s"]).stdout.includes(STASH);

/**
 * Move the run's work onto the target branch's latest commit: the uncommitted change is committed
 * for the move, everything since the old start is rebased, and the change is put back as staged
 * (the patch to apply). Sync commits, if any, stay commits above the new start.
 */
export async function moveToTarget(root: string, wt: WorktreeRef, resolver: Resolver) {
  if (!wt.targetBranch) throw new HttpError(400, `${wt.space} 没有目标分支，不能移到最新提交上`);
  const tip = resolveRef(root, `refs/heads/${wt.targetBranch}`);
  if (!tip) throw new HttpError(404, `找不到目标分支 ${wt.targetBranch}`);
  const path = wt.path;
  const oldStart = wt.start ?? wt.base;
  if (tip.commit === oldStart) return { moved: false as const, stopped: null };
  git(path, ["add", "-A"]);
  const wip = !!git(path, ["diff", "--cached", "--name-only", "HEAD"]).stdout.trim();
  if (wip) {
    const c = git(path, [...identity(path), "commit", "-q", "--no-verify", "-m", "omem: 未应用的改动"]);
    if (!c.ok) throw new HttpError(409, `暂存改动失败：${c.stderr.slice(0, 600)}`);
  }
  const conflicts: string[] = [];
  const r = git(path, [...identity(path), "rebase", "--rebase-merges", "--onto", tip.commit, oldStart]);
  if (!r.ok && !syncInProgress(path)) throw new HttpError(409, `移到 ${wt.targetBranch} 最新提交失败：${(r.stderr || r.stdout).slice(0, 600)}`);
  const left = await finishSync(path, `移到 ${wt.targetBranch} 最新提交`, resolver, conflicts);
  if (left) return { moved: true as const, stopped: left, wip, start: tip.commit, conflicts };
  if (wip) git(path, ["reset", "-q", "--soft", "HEAD~1"]);
  return { moved: true as const, stopped: null, wip, start: tip.commit, conflicts };
}

/** After an interrupted move was finished: the WIP commit (if it was made) goes back to staged. */
export function popWip(path: string) {
  if (git(path, ["log", "-1", "--format=%s"]).stdout.trim() === "omem: 未应用的改动") git(path, ["reset", "-q", "--soft", "HEAD~1"]);
}

/** Leave a stopped merge or rebase. */
export function abortSync(path: string) {
  const op = syncInProgress(path);
  if (op) git(path, [op, "--abort"]);
  popWip(path);
  // Back where it started, the set-aside work goes back as it was.
  const ref = git(path, ["stash", "list", "--format=%gd %s"]).stdout.split("\n").find((l) => l.includes(STASH))?.split(" ")[0];
  if (ref) git(path, ["stash", "pop", "-q", ref]);
}

/** For the reviewers and the owner: how each conflicted file ended up, against the branch merged in. */
export function conflictReport(path: string, steps: SyncStep[]) {
  const out: string[] = [];
  for (const s of steps) {
    if (!s.conflicts.length) continue;
    const d = git(path, ["diff", "--no-color", s.from, s.to, "--", ...s.conflicts]).stdout;
    out.push(`### ${s.label}：解决了 ${s.conflicts.length} 个冲突文件（${s.conflicts.join("、")}）\n\n相对同步前的变化：\n\n${"```diff"}\n${d.slice(0, 20000)}\n${"```"}`);
  }
  return out.join("\n\n");
}
