import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { noteSync } from "./loop-monitor.ts";

export type GitResult = { ok: boolean; stdout: string; stderr: string };

/**
 * No fsmonitor daemon for any git omem (or an agent it starts) runs. With core.fsmonitor on in the
 * user's config, git starts a detached daemon per repository it touches and the daemon stays after
 * the folder is gone — every temporary library, worktree and test repo leaked one (thousands, each
 * holding memory). Set through GIT_CONFIG_COUNT so it reaches every child process; idempotent.
 */
export function disableGitFsmonitor(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  for (let i = 0; i < n; i++) if (env[`GIT_CONFIG_KEY_${i}`] === "core.fsmonitor") return;
  env[`GIT_CONFIG_KEY_${n}`] = "core.fsmonitor";
  env[`GIT_CONFIG_VALUE_${n}`] = "false";
  env.GIT_CONFIG_COUNT = String(n + 1);
}

/** Synchronous: the main thread waits for git (timed, core/loop-monitor.ts). Prefer `gitAsync` on request paths. */
export function git(cwd: string, args: string[], input?: string, env?: Record<string, string>): GitResult {
  const start = performance.now();
  const r = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8", ...env },
    windowsHide: true,
  });
  noteSync(`git ${args.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ")}`, start);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
}

/**
 * The same, without holding the main thread: for anything that goes over the network (fetch,
 * ls-remote) or may take seconds on a large repository. Every HTTP request, tool call and timer
 * waited while a synchronous `git fetch` ran (up to its two-minute timeout).
 */
export function gitAsync(cwd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeoutMs ?? 0,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" },
      windowsHide: true,
    }, (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr || (error ? String(error) : "") }));
  });
}

let available: boolean | undefined;
export function gitAvailable() {
  if (available === undefined) available = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
  return available;
}

export function isGitRepo(dir: string) {
  return gitAvailable() && git(dir, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

/** The knowledge library is its own Git repository so every page change has history. */
export function ensureLibraryRepo(dir: string) {
  if (!gitAvailable() || existsSync(join(dir, ".git"))) return;
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "omem"]);
  git(dir, ["config", "user.email", "omem@localhost"]);
  git(dir, ["config", "core.quotepath", "false"]);
}

export function commitLibrary(dir: string, message: string, paths: string[] = ["."]) {
  if (!gitAvailable() || !existsSync(join(dir, ".git"))) return null;
  git(dir, ["add", "-A", "--", ...paths]);
  const staged = git(dir, ["diff", "--cached", "--quiet"]);
  if (staged.ok) return null; // nothing to commit
  const r = git(dir, ["commit", "-q", "-m", message]);
  if (!r.ok) return null;
  return git(dir, ["rev-parse", "HEAD"]).stdout.trim();
}

export type Commit = { hash: string; at: string; message: string };
export function fileHistory(dir: string, path: string, limit = 50): Commit[] {
  if (!gitAvailable() || !existsSync(join(dir, ".git"))) return [];
  const r = git(dir, ["log", `-n${limit}`, "--follow", "--format=%H%x1f%aI%x1f%s", "--", path]);
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [hash, at, message] = l.split("\x1f");
      return { hash, at, message };
    });
}

export function fileAt(dir: string, hash: string, path: string) {
  const r = git(dir, ["show", `${hash}:${path}`]);
  return r.ok ? r.stdout : null;
}

export function fileDiff(dir: string, hash: string, path: string) {
  return git(dir, ["show", "--format=", hash, "--", path]).stdout;
}

/**
 * Tracked + untracked-not-ignored files of a repository, relative paths. Files of checked-out
 * submodules are listed under their path (`libs/sub/a.ts`); a submodule that is not checked out
 * only has its directory entry, which is left out.
 */
export function listRepoFiles(dir: string, opts: { submodules?: boolean } = {}): string[] | null {
  if (!isGitRepo(dir)) return null;
  // --recurse-submodules only works with --cached, so untracked files are a second call.
  const tracked = git(dir, ["ls-files", "-z", "--cached", ...(opts.submodules === false ? [] : ["--recurse-submodules"])]);
  const untracked = git(dir, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (!tracked.ok || !untracked.ok) return null;
  const gitlinks = new Set(submodules(dir).map((s) => s.path));
  return [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter((p) => p && !gitlinks.has(p)))];
}

export type Submodule = { path: string; commit: string; state: "ok" | "missing" | "changed" | "conflict" };

/** Submodules at every depth: checked out (ok/changed) or not (missing). */
export function submodules(dir: string): Submodule[] {
  if (!existsSync(join(dir, ".gitmodules"))) return [];
  const r = git(dir, ["submodule", "status", "--recursive"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((l) => /^([ +\-U])([0-9a-f]+) (\S+)/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ path: m[3], commit: m[2], state: m[1] === "-" ? "missing" : m[1] === "+" ? "changed" : m[1] === "U" ? "conflict" : "ok" }));
}

export function headCommit(dir: string) {
  const r = git(dir, ["rev-parse", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

/** A branch, tag or commit: the local branch first, then the one on `origin`. */
export function resolveRef(dir: string, name: string): { ref: string; commit: string } | null {
  const short = name.replace(/^refs\/heads\//, "");
  for (const ref of [`refs/heads/${short}`, `refs/remotes/origin/${short.replace(/^origin\//, "")}`, `refs/remotes/${short}`, `refs/tags/${short}`, short]) {
    const r = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.ok && r.stdout.trim()) return { ref, commit: r.stdout.trim() };
  }
  return null;
}

/**
 * Bring one branch of `origin` up to date (its remote-tracking ref only; local branches stay as they
 * are). Synchronous: the main thread waits on the network. Only for the CLI and the few delivery
 * steps not yet moved; use `fetchBranchAsync`.
 */
export function fetchBranch(dir: string, name: string, timeoutMs = 120_000): GitResult {
  if (!git(dir, ["remote", "get-url", "origin"]).ok) return { ok: false, stdout: "", stderr: "没有名为 origin 的远端" };
  const start = performance.now();
  const r = spawnSync("git", fetchArgs(name), {
    cwd: dir,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" },
    windowsHide: true,
  });
  noteSync("git fetch", start);
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr || (r.error ? String(r.error) : "") };
}

const fetchArgs = (name: string) => {
  const short = name.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  return ["fetch", "-q", "--no-tags", "origin", `+refs/heads/${short}:refs/remotes/origin/${short}`];
};

/** `fetchBranch` off the main thread (prefer it wherever the caller can wait). */
export async function fetchBranchAsync(dir: string, name: string, timeoutMs = 120_000): Promise<GitResult> {
  if (!(await gitAsync(dir, ["remote", "get-url", "origin"])).ok) return { ok: false, stdout: "", stderr: "没有名为 origin 的远端" };
  return gitAsync(dir, fetchArgs(name), { timeoutMs });
}

/** Read origin's advertised default branch; supports arbitrary branch names. */
export async function refreshDefaultBaseRef(dir: string): Promise<string | null> {
  if (!(await gitAsync(dir, ["remote", "get-url", "origin"])).ok) return defaultBaseRef(dir);
  const result = await gitAsync(dir, ["ls-remote", "--symref", "origin", "HEAD"], { timeoutMs: 30_000 });
  if (!result.ok) throw new Error(`读取远端默认分支失败：${result.stderr.trim().slice(0, 300)}`);
  const branch = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(result.stdout)?.[1];
  if (!branch) return defaultBaseRef(dir);
  const ref = `refs/remotes/origin/${branch}`;
  git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", ref]);
  return `origin/${branch}`;
}

/** What a branch is usually compared with: origin's default branch, else main / master. */
export function defaultBaseRef(dir: string): string | null {
  const head = git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const name of ["origin/main", "origin/master", "main", "master"]) if (resolveRef(dir, name)) return name;
  return null;
}

export type Branch = { name: string; commit: string; at: string; subject: string; remote: boolean };

/** Local and `origin` branches, most recently committed first; not the `omem/<run>` branches of delegation worktrees. */
export function listBranches(dir: string, limit = 200): Branch[] {
  const r = git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(subject)", "refs/heads", "refs/remotes/origin"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\x1f"))
    .filter(([ref]) => ref !== "refs/remotes/origin/HEAD" && !/^refs\/heads\/omem\/r[0-9a-z]+$/.test(ref))
    .map(([ref, commit, at, subject]) => ({ name: ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, ""), commit, at, subject: subject ?? "", remote: ref.startsWith("refs/remotes/") }))
    .slice(0, limit);
}
