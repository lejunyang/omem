import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type GitResult = { ok: boolean; stdout: string; stderr: string };

export function git(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C.UTF-8" },
    windowsHide: true,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
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
