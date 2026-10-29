import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { App } from "../core/app.ts";
import { git } from "../core/git.ts";
import type { Space } from "../core/spaces.ts";
import { now, sha256 } from "../core/util.ts";

/**
 * Workspaces for delegated coding (docs/v2/ide.md). A new worktree per delegation has no
 * dependencies installed, so omem keeps a few long-lived worktrees per repository under
 * `<data>/workspaces/<space>/<n>` and lends them to runs: made on first need, up to MAX_POOL, and
 * when all are taken an idle one (its run not running, clean, its HEAD on some branch) is taken
 * back. Nothing to configure but the setup command, which defaults by the lockfile.
 *
 * A lease is a file in the worktree's own git directory naming the run; the run reaches the slot
 * through a link at its usual place (`runs/<id>/work/<space>`), so a lease is held exactly while
 * that link exists. Releasing resets the slot (tracked and untracked files, not ignored ones) and
 * removes the link. The setup command runs in any worktree whose lockfiles changed since it last ran.
 *
 * Older settings (`pool`, `workspaces`: the owner's own worktrees, `inPlace`: the main directory)
 * no longer lend anything; runs that hold such a slot still give it back the same way.
 */
export type WorkspaceSettings = { setupCommand?: string };

type Lease = { run: string; space: string; prev: string | null; at: string };
export type WorkspaceSlot = { path: string; state: "free" | "leased" | "invalid" | "dirty"; run?: string; branch?: string | null; reason?: string };

export const MAX_POOL = 4;
const LEASE = "omem-lease.json";
const SETUP = "omem-setup";
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "requirements*.txt", "Gemfile.lock", "composer.lock", "pubspec.lock", "Podfile.lock", "gradle.lockfile"];
/** What prepares dependencies when the space names no command: by the lockfile at the top. */
const AUTO_SETUP: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --prefer-offline"],
  ["yarn.lock", "yarn install --frozen-lockfile"],
  ["bun.lock", "bun install --frozen-lockfile"],
  ["bun.lockb", "bun install --frozen-lockfile"],
  ["package-lock.json", "npm ci"],
];

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const gitDir = (dir: string) => {
  const r = git(dir, ["rev-parse", "--absolute-git-dir"]);
  return r.ok ? r.stdout.trim() : null;
};
const commonDir = (dir: string) => {
  const r = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.ok ? real(r.stdout.trim()) : null;
};
const isLink = (p: string) => !!lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink();
const dirty = (path: string) => git(path, ["status", "--porcelain"]).stdout.trim() !== "";

/** Where processes for a worktree run: the slot itself for a leased one (tools resolve links differently). */
export function workDirOf(wt: { path: string }) {
  return isLink(wt.path) ? real(wt.path) : wt.path;
}

export function managedSlot(app: App, repoId: string, n: number) {
  return join(app.home, "workspaces", repoId, String(n));
}

const slots = (app: App, repo: Space) => Array.from({ length: MAX_POOL }, (_, i) => managedSlot(app, repo.id, i + 1));

/** The setup command for a worktree of `repo`: the space's, else by its lockfile; null for none. */
export function setupCommandFor(repo: Space, dir: string): string | null {
  const named = String((repo.settings as WorkspaceSettings).setupCommand ?? "").trim();
  if (named) return named === "none" ? null : named;
  return AUTO_SETUP.find(([file]) => existsSync(join(dir, file)))?.[1] ?? null;
}

/** Why a slot cannot be lent to runs of `root`'s repository, or null. */
function unusable(root: string, path: string) {
  const top = git(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || real(top.stdout.trim()) !== real(path)) return "不是 Git 工作区的根目录";
  if (commonDir(path) !== commonDir(root)) return "不是这个仓库的工作区";
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

/** The run a worktree (the main directory included) is lent to right now, or null. */
export function leasedTo(app: App, path: string) {
  const dir = existsSync(path) ? gitDir(path) : null;
  return dir ? holder(app, path, join(dir, LEASE)) : null;
}

/** The repository's workspaces made so far and their state (settings page). */
export function listWorkspaces(app: App, repo: Space): WorkspaceSlot[] {
  const root = repo.rootPath;
  return slots(app, repo).filter((p) => existsSync(p)).map((path) => {
    const reason = root ? unusable(root, path) : "空间没有关联仓库";
    if (reason) return { path, state: "invalid" as const, reason };
    const branch = git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || null;
    const run = holder(app, path, join(gitDir(path)!, LEASE));
    if (run) return { path, state: "leased" as const, run, branch };
    return dirty(path) ? { path, state: "dirty" as const, branch, reason: "有上次留下的改动，下次借出时清掉" } : { path, state: "free" as const, branch };
  });
}

/** HEAD is on some branch, so moving the slot elsewhere loses nothing. */
const parked = (path: string) => !!git(path, ["for-each-ref", "--count=1", "--contains", "HEAD", "refs/heads"]).stdout.trim();

/**
 * Lend run `runId` a slot of `repo` and link it at `link`: a free one, else a new one (up to
 * MAX_POOL), else one whose run is idle (`idle(run)`) and that is clean with its HEAD on a branch,
 * taken back from that run (its link goes; its next round leases again). Null when none: the
 * caller makes a worktree of its own. The slot keeps whatever is checked out; the caller moves it.
 */
export function leaseWorkspace(app: App, repo: Space, runId: string, link: string, log: (text: string) => void, opts: { idle?: (run: string) => boolean } = {}): { path: string } | null {
  const root = repo.rootPath!;
  const take = (path: string, from?: string) => {
    const reason = unusable(root, path);
    if (reason) {
      log(`跳过工作区 ${path}：${reason}`);
      return null;
    }
    const file = join(gitDir(path)!, LEASE);
    const held = holder(app, path, file);
    if (held && held !== from) return null;
    if (from) {
      try {
        unlinkSync(join(app.runsDir, from, "work", repo.id));
      } catch {}
    }
    rmSync(file, { force: true });
    try {
      writeFileSync(file, JSON.stringify({ run: runId, space: repo.id, prev: null, at: now() } satisfies Lease), { flag: "wx" });
    } catch {
      return null;
    }
    // Leftovers of a run that stopped half way; ignored files (dependencies) stay.
    if (dirty(path)) {
      git(path, ["reset", "-q", "--hard"]);
      git(path, ["clean", "-fdq"]);
    }
    try {
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(path, link, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      rmSync(file, { force: true });
      log(`没能链接工作区 ${path}：${(e as Error).message}`);
      return null;
    }
    if (from) log(`收回交办 ${from} 闲着的工作区 ${path}（它的分支和提交都在，下一轮再借）`);
    return { path };
  };
  const all = slots(app, repo);
  for (const path of all.filter((p) => existsSync(p))) {
    const got = take(path);
    if (got) return got;
  }
  for (const path of all.filter((p) => !existsSync(p))) {
    mkdirSync(dirname(path), { recursive: true });
    git(root, ["worktree", "prune"]);
    const made = git(root, ["worktree", "add", "-q", "--detach", path, "HEAD"]);
    if (!made.ok) {
      log(`没能建工作区 ${path}：${made.stderr.trim().slice(0, 300)}`);
      continue;
    }
    const got = take(path);
    if (got) return got;
  }
  if (!opts.idle) return null;
  for (const path of all.filter((p) => existsSync(p))) {
    const dir = gitDir(path);
    const run = dir ? readLease(join(dir, LEASE))?.run : null;
    if (!run || run === runId || !opts.idle(run) || dirty(path) || !parked(path)) continue;
    const got = take(path, run);
    if (got) return got;
  }
  return null;
}

/**
 * Give a leased slot back: drop the run's link, then (if the lease is still this run's) reset the
 * slot's tracked and untracked files and return it to the branch it was on. Ignored files stay.
 * `keep` gives it back as it is: the main directory after an older run was applied there.
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
