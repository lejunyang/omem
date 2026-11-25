import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchBranch, fetchBranchAsync, git, resolveRef } from "../core/git.ts";
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
export type SyncOperation = SyncMode | "cherry-pick" | "revert";
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
export type SyncState = { op: SyncOperation; label: string; conflicts: string[] };
/** Resolves the listed conflicts in the worktree (the coding Agent): leaves them resolved or not. */
export type Resolver = (files: string[], label: string) => Promise<void>;

const ID = ["-c", "user.name=omem", "-c", "user.email=omem@localhost"];
/** Git refuses to commit without a name; the repository's own identity wins when it has one. */
function identity(path: string) {
  return git(path, ["config", "user.email"]).stdout.trim() ? [] : ID;
}
const head = (path: string) => git(path, ["rev-parse", "HEAD"]).stdout.trim();
const syncGit = (path: string, args: string[]) => git(path, ["-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", ...args]);

/**
 * Pulling origin into a reused branch (`diffBase`, code-branch.ts) moves its comparison on to the
 * pulled commit — unless origin already has some of the work (it was pushed): then the commits
 * since the old base are still the work's and the base stays. The move waits in `diffBaseNext`
 * until the merge or rebase is done (it may stop on conflicts); `settleDiffBase` makes it.
 */
function nextDiffBase(wt: WorktreeRef, remote: string) {
  if (!wt.commits || !wt.diffBase || wt.cutFrom) return;
  const at = head(wt.path);
  const base = git(wt.path, ["merge-base", wt.diffBase, at]).stdout.trim() || wt.diffBase;
  const shared = git(wt.path, ["merge-base", at, remote]).stdout.trim();
  if (shared && git(wt.path, ["merge-base", "--is-ancestor", shared, base]).ok) wt.diffBaseNext = remote;
}
export function settleDiffBase(wt: WorktreeRef) {
  if (!wt.diffBaseNext || syncInProgress(wt.path)) return;
  if (git(wt.path, ["merge-base", "--is-ancestor", wt.diffBaseNext, "HEAD"]).ok) wt.diffBase = wt.diffBaseNext;
  delete wt.diffBaseNext;
}
export function unmerged(path: string) {
  const result = git(path, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  if (!result.ok) throw new Error(result.stderr);
  return result.stdout.split("\0").filter(Boolean);
}

/** An unfinished Git operation belongs to this worktree, including a sequenced pick/revert. */
export function syncInProgress(path: string): SyncOperation | null {
  const at = (name: string) => {
    const r = git(path, ["rev-parse", "--git-path", name]);
    return r.ok && !!r.stdout.trim() && existsSync(resolve(path, r.stdout.trim()));
  };
  if (at("rebase-merge") || at("rebase-apply")) return "rebase";
  if (at("MERGE_HEAD")) return "merge";
  if (at("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (at("REVERT_HEAD")) return "revert";
  if (at("sequencer/todo")) {
    const file = git(path, ["rev-parse", "--git-path", "sequencer/todo"]).stdout.trim();
    const next = readFileSync(resolve(path, file), "utf8").split("\n").find((l) => /^(pick|revert)\s/.test(l));
    if (next?.startsWith("pick ")) return "cherry-pick";
    if (next?.startsWith("revert ")) return "revert";
  }
  return null;
}

function regularText(root: string, file: string): string | undefined {
  const path = join(root, file);
  if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || realpathSync(path) !== path) return;
  return readFileSync(path, "utf8");
}

const hasMarkers = (text: string, size: number) => Array.from(text.matchAll(/^(<+|>+|\|+) /gm)).some(m => m[1].length === size);

function markerSizes(path: string, files: string[]) {
  const sizes = new Map<string, number>();
  for (let start = 0; start < files.length; start += 32) {
    const attrs = git(path, ["check-attr", "-z", "conflict-marker-size", "--", ...files.slice(start, start + 32)]);
    if (!attrs.ok) throw new Error(attrs.stderr);
    const fields = attrs.stdout.split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3) sizes.set(fields[i], Number(fields[i + 2]) || 7);
  }
  return sizes;
}

export function markedConflicts(path: string, files: string[]) {
  const root = realpathSync(path);
  const sizes = markerSizes(path, files);
  return files.filter(file => hasMarkers(regularText(root, file) ?? "", sizes.get(file) ?? 7));
}

export function stageResolvedConflicts(path: string, files: string[], marked: string[], resolved: string[] = []) {
  const root = realpathSync(path);
  const sizes = markerSizes(path, files);
  const text = new Map(files.map(file => [file, regularText(root, file)]));
  const remainingMarkers = files.filter(file => hasMarkers(text.get(file) ?? "", sizes.get(file) ?? 7));
  const ready = [...new Set([...marked.filter(file => text.get(file) !== undefined), ...resolved])].filter(file => !remainingMarkers.includes(file));
  if (ready.length) {
    const result = git(path, ["--literal-pathspecs", "add", "-A", "--", ...ready]);
    if (!result.ok) throw new Error(result.stderr);
  }
  for (const file of marked) {
    if (text.get(file) !== undefined || ready.includes(file)) continue;
    const staged = git(path, ["show", `:0:${file}`]);
    if (staged.ok && hasMarkers(staged.stdout, sizes.get(file) ?? 7)) remainingMarkers.push(file);
  }
  return [...new Set([...unmerged(path), ...remainingMarkers])];
}

export async function resolveConflicts(path: string, files: string[], label: string, resolver: Resolver) {
  const marked = markedConflicts(path, files);
  await resolver(files, label);
  return stageResolvedConflicts(path, files, marked);
}

/** The newest of a branch's local and origin copies: the remote one when the local is behind it. */
function freshest(root: string, name: string): { ref: string; commit: string } | null {
  const short = name.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  if (name.startsWith("origin/") || name.startsWith("refs/remotes/")) return resolveRef(root, name);
  const local = resolveRef(root, `refs/heads/${short}`);
  const remote = resolveRef(root, `refs/remotes/origin/${short}`);
  if (local && remote && local.commit !== remote.commit && git(root, ["merge-base", "--is-ancestor", local.commit, remote.commit]).ok) return remote;
  return local ?? remote ?? resolveRef(root, name);
}

function start(path: string, op: SyncMode, commit: string) {
  return op === "merge" ? syncGit(path, [...identity(path), "merge", "--no-ff", "--no-edit", commit]) : syncGit(path, [...identity(path), "rebase", "--rebase-merges", "--no-update-refs", commit]);
}
function proceed(path: string, op: SyncOperation) {
  return op === "merge" ? syncGit(path, [...identity(path), "commit", "--no-edit"]) : syncGit(path, [...identity(path), "-c", "core.editor=true", op, "--continue"]);
}

/**
 * Carry a stopped Git operation to its end: each round of conflicts goes to the resolver, then
 * Git continues. Returns what is still unresolved (the run stops and asks the owner), or null.
 */
export async function finishSync(path: string, label: string, resolver: Resolver, conflicts: string[] = []): Promise<SyncState | null> {
  for (let round = 0; round < 20; round++) {
    const op = syncInProgress(path);
    if (!op) return null;
    let files = unmerged(path);
    if (files.length) {
      conflicts.push(...files.filter((f) => !conflicts.includes(f)));
      files = await resolveConflicts(path, files, label, resolver);
      if (files.length) return { op, label, conflicts: files };
    }
    const r = proceed(path, op);
    // Nothing left to commit in this step (the resolution took one side entirely): skip it.
    if (!r.ok && op === "rebase" && !unmerged(path).length && /nothing to commit|empty/i.test(r.stderr + r.stdout)) syncGit(path, ["-c", "core.editor=true", "rebase", "--skip"]);
    else if (!r.ok && (op === "cherry-pick" || op === "revert") && !unmerged(path).length && git(path, ["diff", "--cached", "--quiet", "HEAD"]).ok) {
      const skip = git(path, [...identity(path), "-c", "core.editor=true", op, "--skip"]);
      if (!skip.ok && !unmerged(path).length && syncInProgress(path)) throw new HttpError(409, `${label}没能跳过空提交：${(skip.stderr || skip.stdout).slice(0, 600)}`);
    } else if (!r.ok && !unmerged(path).length && syncInProgress(path)) throw new HttpError(409, `${label}没能继续：${(r.stderr || r.stdout).slice(0, 600)}`);
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
export async function syncWorktree(root: string, wt: WorktreeRef, req: SyncRequest, resolver: Resolver, status: (text: string) => void, holdStash = false) {
  const path = wt.path;
  const recovered: SyncStep[] = [];
  const op = syncInProgress(path);
  if (op) {
    const label = `继续未完成的 ${op}`;
    status(label);
    const from = head(path), conflicts: string[] = [];
    const stopped = await finishSync(path, label, resolver, conflicts);
    recovered.push({ label, from, to: head(path), conflicts });
    if (stopped) return { steps: recovered, stopped, stashed: hasSyncStash(path), remaining: req };
  }
  // Work already in the worktree (a later round) waits in the stash while Git merges or rebases.
  const retained = hasSyncStash(path);
  const dirty = !retained && !!git(path, ["status", "--porcelain"]).stdout.trim();
  if (dirty) pushSyncStash(path);
  const stashed = retained || dirty;
  const r = await syncSteps(root, wt, req, resolver, status);
  r.steps.unshift(...recovered);
  if (r.stopped || !stashed) return { ...r, stashed };
  const left = await popStash(path, resolver, holdStash);
  return { ...r, stopped: left, restoring: !!left, stashed: !!left || holdStash };
}

const STASH = "omem: 同步前未提交的改动";

/**
 * The stash is shared by every worktree of a repository, so which entry is this worktree's is kept
 * in the worktree's own Git directory (`--git-path` of a name Git does not share). Without it, one
 * worktree's left-over stash made every other worktree look mid-sync (a new delegation then skipped
 * moving its workspace onto the branch and merged origin into whatever commit the slot was left on),
 * and finishing a sync could apply another worktree's work.
 */
const stashMark = (path: string) => resolve(path, git(path, ["rev-parse", "--git-path", "omem-sync-stash"]).stdout.trim());

/** Set aside the worktree's uncommitted work for a sync, remembering which stash entry it is. */
export function pushSyncStash(path: string) {
  const st = syncGit(path, [...identity(path), "stash", "push", "-q", "--include-untracked", "-m", STASH]);
  if (!st.ok) throw new HttpError(409, `暂存未提交的改动失败：${st.stderr.slice(0, 600)}`);
  writeFileSync(stashMark(path), git(path, ["rev-parse", "stash@{0}"]).stdout.trim());
}

/** This worktree's sync stash (`stash@{n}`), if it is still there. */
function ownStash(path: string): string | null {
  const mark = stashMark(path);
  if (!existsSync(mark)) return null;
  const sha = readFileSync(mark, "utf8").trim();
  const line = git(path, ["stash", "list", "--format=%gd %H"]).stdout.split("\n").find((l) => l.endsWith(` ${sha}`));
  if (!line) rmSync(mark, { force: true });
  return line ? line.split(" ")[0]! : null;
}

/** Put the stashed work back on top of the synced code; its conflicts go to the resolver. */
export async function popStash(path: string, resolver: Resolver, hold = false): Promise<SyncState | null> {
  const ref = ownStash(path);
  if (!ref) return null;
  const again = syncGit(path, ["stash", "apply", ref]);
  if (!again.ok) {
    const files = unmerged(path);
    if (!files.length) throw new HttpError(409, `放回未提交的改动失败：${again.stderr.slice(0, 600)}`);
    const left = await resolveConflicts(path, files, "放回同步前的改动", resolver);
    if (left.length) return { op: "merge", label: "放回同步前的改动", conflicts: left };
  }
  if (!hold) dropSyncStash(path);
  return null;
}

export function dropSyncStash(path: string) {
  const ref = ownStash(path);
  if (!ref) return;
  const dropped = git(path, ["stash", "drop", "-q", ref]);
  if (!dropped.ok) throw new HttpError(409, `清理同步暂存失败：${dropped.stderr.slice(0, 600)}`);
  rmSync(stashMark(path), { force: true });
}

export function rollbackSync(path: string, from: string) {
  const op = syncInProgress(path);
  const args = [...(op ? [[op, "--abort"]] : []), ["reset", "--hard", from], ["clean", "-fd"]];
  for (const command of args) {
    const r = syncGit(path, command);
    if (!r.ok) throw new HttpError(409, `恢复同步前的工作区失败：${r.stderr.slice(0, 600)}`);
  }
  const ref = ownStash(path);
  if (!ref) return;
  const restored = syncGit(path, ["stash", "apply", "--index", ref]);
  if (!restored.ok) throw new HttpError(409, `恢复未提交的改动失败，已保留暂存：${restored.stderr.slice(0, 600)}`);
  dropSyncStash(path);
}

/** Fetch the target branch and tell whether origin has commits the worktree does not (a failed fetch counts as no). */
export function behindOrigin(root: string, wt: WorktreeRef): boolean {
  if (!wt.targetBranch || !fetchBranch(root, wt.targetBranch).ok) return false;
  const remote = resolveRef(root, `refs/remotes/origin/${wt.targetBranch}`);
  return !!remote && !git(wt.path, ["merge-base", "--is-ancestor", remote.commit, head(wt.path)]).ok;
}

async function syncSteps(root: string, wt: WorktreeRef, req: SyncRequest, resolver: Resolver, status: (text: string) => void) {
  const steps: SyncStep[] = [];
  const mode: SyncMode = req.mode ?? "merge";
  const path = wt.path;
  if (req.fetch !== false) {
    for (const name of new Set([req.pull ? wt.targetBranch : null, req.onto].filter((x): x is string => !!x))) {
      const f = await fetchBranchAsync(root, name);
      if (!f.ok && name === req.onto && git(root, ["remote", "get-url", "origin"]).ok) throw new HttpError(409, `更新基准分支 ${name} 失败：${f.stderr.trim().slice(0, 300)}`);
      if (!f.ok) status(`没能从 origin 拉取 ${name}：${f.stderr.trim().slice(0, 200)}（按本地已有的版本继续）`);
    }
  }
  if (req.pull && wt.targetBranch) {
    const remote = resolveRef(root, `refs/remotes/origin/${wt.targetBranch}`);
    const at = head(path);
    if (remote) nextDiffBase(wt, remote.commit);
    if (!remote) status(`origin 上没有 ${wt.targetBranch}，跳过拉取`);
    else if (remote.commit === at || git(path, ["merge-base", "--is-ancestor", remote.commit, at]).ok) status(`${wt.targetBranch} 已经包含 origin 的最新提交`);
    else if (git(path, ["merge-base", "--is-ancestor", at, remote.commit]).ok) {
      const ff = syncGit(path, ["merge", "--ff-only", remote.commit]);
      if (!ff.ok) throw new HttpError(409, `快进到 origin/${wt.targetBranch} 失败：${ff.stderr.slice(0, 600)}`);
      steps.push({ label: `拉取 origin/${wt.targetBranch}（快进）`, from: at, to: head(path), conflicts: [] });
    } else {
      const left = await step(path, mode, remote, `${mode === "merge" ? "合并" : "变基到"} origin/${wt.targetBranch}`, resolver, steps);
      if (left) return { steps, stopped: left, remaining: { onto: req.onto, mode, fetch: false } };
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
export const hasSyncStash = (path: string) => ownStash(path) !== null;

/**
 * Merge the latest target into the run by default, preserving uncommitted work. Explicit rebase
 * replays from the actual shared ancestor and puts the temporary WIP commit back as staged changes.
 */
export async function moveToTarget(root: string, wt: WorktreeRef, resolver: Resolver, mode: SyncMode = "merge") {
  if (!wt.targetBranch) throw new HttpError(400, `${wt.space} 没有目标分支，不能移到最新提交上`);
  const tip = resolveRef(root, `refs/heads/${wt.targetBranch}`);
  if (!tip) throw new HttpError(404, `找不到目标分支 ${wt.targetBranch}`);
  const path = wt.path;
  const at = head(path);
  // A stale recorded start must not replay history already included in the work branch.
  if (git(path, ["merge-base", "--is-ancestor", tip.commit, at]).ok) return { moved: false as const, stopped: null };
  if (mode === "merge") {
    const r = await syncWorktree(root, wt, { onto: tip.commit, mode, fetch: false }, resolver, () => {});
    return { moved: true as const, stopped: r.stopped, start: tip.commit, conflicts: [...new Set(r.steps.flatMap(s => s.conflicts))] };
  }
  const shared = git(path, ["merge-base", at, tip.commit]);
  if (!shared.ok || !shared.stdout.trim()) throw new HttpError(409, `${wt.targetBranch} 与工作分支没有可确认的共同祖先，不能自动迁移`);
  git(path, ["add", "-A"]);
  const wip = !!git(path, ["diff", "--cached", "--name-only", "HEAD"]).stdout.trim();
  if (wip) {
    const c = git(path, [...identity(path), "commit", "-q", "--no-verify", "-m", "omem: 未应用的改动"]);
    if (!c.ok) throw new HttpError(409, `暂存改动失败：${c.stderr.slice(0, 600)}`);
  }
  const conflicts: string[] = [];
  const r = git(path, [...identity(path), "rebase", "--rebase-merges", "--onto", tip.commit, shared.stdout.trim()]);
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
  const ref = ownStash(path);
  if (ref) git(path, ["stash", "pop", "-q", ref]);
  rmSync(stashMark(path), { force: true });
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
