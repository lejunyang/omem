import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import type { Space } from "../core/spaces.ts";
import { now, sha256 } from "../core/util.ts";

/**
 * Reusable workspaces for delegated coding (docs/v2/ide.md). A new worktree per delegation has no
 * dependencies installed; a repository can instead lend its runs a few long-lived worktrees that
 * keep their ignored files (node_modules, build caches) between runs:
 *
 * - `workspaces`: worktrees the owner already has (with dependencies installed), lent only while
 *   clean and given back on the branch they were on;
 * - `pool`: worktrees omem creates under `<data>/workspaces/<space>/<n>` on first use;
 * - `inPlace`: the repository's main directory itself, lent first while it is clean. The run works
 *   on the branch checked out there (no omem branch); applying keeps its changes where they are,
 *   discarding resets the directory like any other slot.
 *
 * A lease is a file in the worktree's own git directory naming the run; the run reaches the slot
 * through a link at its usual place (`runs/<id>/work/<space>`), so a lease is held exactly while
 * that link exists. Releasing resets the slot (tracked and untracked files, not ignored ones) and
 * removes the link. `setupCommand` runs in any worktree whose lockfiles changed since it last ran.
 */
export type WorkspaceSettings = { workspaces?: string[]; pool?: number; setupCommand?: string; inPlace?: boolean };

type Lease = { run: string; space: string; prev: string | null; at: string };
export type WorkspaceSlot = { path: string; managed: boolean; main?: boolean; state: "free" | "leased" | "missing" | "invalid" | "dirty"; run?: string; reason?: string };

const MAX_POOL = 8;
const LEASE = "omem-lease.json";
const SETUP = "omem-setup";
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "requirements*.txt", "Gemfile.lock", "composer.lock", "pubspec.lock", "Podfile.lock", "gradle.lockfile"];

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const expand = (p: string) => resolve(p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p);
const gitDir = (dir: string) => {
  const r = git(dir, ["rev-parse", "--absolute-git-dir"]);
  return r.ok ? r.stdout.trim() : null;
};
const commonDir = (dir: string) => {
  const r = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.ok ? real(r.stdout.trim()) : null;
};
const isLink = (p: string) => !!lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink();

/** Where processes for a worktree run: the slot itself for a leased one (tools resolve links differently). */
export function workDirOf(wt: { path: string }) {
  return isLink(wt.path) ? real(wt.path) : wt.path;
}

export function managedSlot(app: App, repoId: string, n: number) {
  return join(app.home, "workspaces", repoId, String(n));
}

type Candidate = { path: string; managed: boolean; main?: boolean };

function candidates(app: App, repo: Space, opts: { main?: boolean } = {}): Candidate[] {
  const st = repo.settings as WorkspaceSettings;
  const main = st.inPlace && repo.rootPath && opts.main !== false ? [{ path: repo.rootPath, managed: false, main: true }] : [];
  const listed = (Array.isArray(st.workspaces) ? st.workspaces : []).map((p) => String(p).trim()).filter(Boolean).map((p) => ({ path: expand(p), managed: false }));
  const n = Math.max(0, Math.min(MAX_POOL, Math.floor(Number(st.pool) || 0)));
  return [...main, ...listed, ...Array.from({ length: n }, (_, i) => ({ path: managedSlot(app, repo.id, i + 1), managed: true }))];
}

/** Why a directory cannot be lent to runs of `root`'s repository, or null. */
function unusable(root: string, c: Candidate) {
  const path = c.path;
  if (!existsSync(path)) return "目录不存在";
  const top = git(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || real(top.stdout.trim()) !== real(path)) return "不是 Git 工作区的根目录";
  if (real(path) === real(root)) return c.main ? null : "是仓库主目录本身（要在主目录里改，打开“在主目录里改”）";
  if (commonDir(path) !== commonDir(root)) return "不是这个仓库的工作区（用 git worktree add 建，和仓库共用提交记录）";
  return null;
}

function readLease(file: string): Lease | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Lease;
  } catch {
    return null;
  }
}

/** The run holding a slot: its link still points there. A lease whose link is gone is stale. */
function holder(app: App, slot: string, file: string) {
  const lease = readLease(file);
  if (!lease) return null;
  const link = join(app.runsDir, lease.run, "work", lease.space);
  return isLink(link) && real(link) === real(slot) ? lease.run : null;
}

const dirty = (path: string) => git(path, ["status", "--porcelain"]).stdout.trim() !== "";

/** The repository's lendable worktrees and their state (settings page). */
export function listWorkspaces(app: App, repo: Space): WorkspaceSlot[] {
  const root = repo.rootPath;
  return candidates(app, repo).map((c) => {
    if (c.managed && !existsSync(c.path)) return { ...c, state: "missing" as const };
    const reason = root ? unusable(root, c) : "空间没有关联仓库";
    if (reason) return { ...c, state: "invalid" as const, reason };
    const dir = gitDir(c.path)!;
    const run = holder(app, c.path, join(dir, LEASE));
    if (run) return { ...c, state: "leased" as const, run };
    return !c.managed && dirty(c.path) ? { ...c, state: "dirty" as const, reason: "有没提交的改动，不会借给交办" } : { ...c, state: "free" as const };
  });
}

/**
 * Lend run `runId` a free slot of `repo` and link it at `link`; null when none is free (the caller
 * makes a new worktree as before). The slot keeps whatever is checked out; the caller moves it.
 * `main: false` leaves the main directory out (a branch review moves HEAD around).
 */
export function leaseWorkspace(app: App, repo: Space, runId: string, link: string, log: (text: string) => void, opts: { main?: boolean } = {}): { path: string; main: boolean } | null {
  const root = repo.rootPath!;
  for (const c of candidates(app, repo, opts)) {
    if (c.managed && !existsSync(c.path)) {
      mkdirSync(dirname(c.path), { recursive: true });
      git(root, ["worktree", "prune"]);
      const made = git(root, ["worktree", "add", "-q", "--detach", c.path, "HEAD"]);
      if (!made.ok) {
        log(`没能建复用工作区 ${c.path}：${made.stderr.trim().slice(0, 300)}`);
        continue;
      }
    }
    const reason = unusable(root, c);
    if (reason) {
      log(`跳过复用工作区 ${c.path}：${reason}`);
      continue;
    }
    const file = join(gitDir(c.path)!, LEASE);
    if (holder(app, c.path, file)) continue;
    rmSync(file, { force: true });
    try {
      writeFileSync(file, JSON.stringify({ run: runId, space: repo.id, prev: null, at: now() } satisfies Lease), { flag: "wx" });
    } catch {
      continue;
    }
    if (dirty(c.path)) {
      // omem's own slots hold nothing but runs' leftovers; the owner's are theirs.
      if (!c.managed) {
        rmSync(file, { force: true });
        log(`${c.main ? "仓库主目录" : "跳过复用工作区"} ${c.path}：有没提交的改动${c.main ? "，这次不在主目录里改" : ""}`);
        continue;
      }
      git(c.path, ["reset", "-q", "--hard"]);
      git(c.path, ["clean", "-fdq"]);
    }
    const branch = git(c.path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
    const prev = c.managed ? null : branch || git(c.path, ["rev-parse", "HEAD"]).stdout.trim() || null;
    writeFileSync(file, JSON.stringify({ run: runId, space: repo.id, prev, at: now() } satisfies Lease));
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(c.path, link, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      rmSync(file, { force: true });
      log(`没能链接复用工作区 ${c.path}：${(e as Error).message}`);
      continue;
    }
    return { path: c.path, main: !!c.main };
  }
  return null;
}

/**
 * Give a leased slot back: drop the run's link, then (if the lease is still this run's) reset the
 * slot's tracked and untracked files and return it to the branch it was on. Ignored files stay.
 * `keep` gives it back as it is: the main directory after its run was applied.
 */
export function releaseWorkspace(runId: string, wt: { path: string; slot?: string }, opts: { keep?: boolean } = {}) {
  if (!wt.slot) return false;
  if (isLink(wt.path)) {
    try {
      unlinkSync(wt.path);
    } catch {
      rmSync(wt.path, { force: true });
    }
  }
  const dir = existsSync(wt.slot) ? gitDir(wt.slot) : null;
  if (!dir) return true;
  const file = join(dir, LEASE);
  const lease = readLease(file);
  // Another run has it now, or this record came from another machine.
  if (lease?.run !== runId) return true;
  if (opts.keep) {
    rmSync(file, { force: true });
    return true;
  }
  git(wt.slot, ["reset", "-q", "--hard"]);
  git(wt.slot, ["clean", "-fdq"]);
  const commit = !lease.prev || /^[0-9a-f]{40,64}$/.test(lease.prev);
  if (commit || !git(wt.slot, ["checkout", "-q", lease.prev!]).ok) git(wt.slot, ["checkout", "-q", "--detach", ...(commit && lease.prev ? [lease.prev] : [])]);
  rmSync(file, { force: true });
  return true;
}

/** The key the setup command last ran for in this worktree differs from now: returns the new one. */
export function setupKey(path: string, command: string): string | null {
  const dir = gitDir(path);
  if (!dir) return null;
  const locks = git(path, ["ls-files", "-s", "--", ...LOCKFILES.map((f) => `:(glob)**/${f}`)]).stdout;
  const key = sha256(`${command}\n${locks}`);
  try {
    if (readFileSync(join(dir, SETUP), "utf8") === key) return null;
  } catch {}
  return key;
}

export function setupDone(path: string, key: string) {
  const dir = gitDir(path);
  if (dir) writeFileSync(join(dir, SETUP), key);
}
