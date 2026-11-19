import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { App } from "./app.ts";
import { git, submodules } from "./git.ts";
import { HttpError, sha256, slugify } from "./util.ts";

const exec = promisify(execFile);

/** Network transports only, never helpers or local-file syntax; no prompts. Also used for submodules. */
const SAFE_GIT = ["-c", "protocol.allow=never", "-c", "protocol.http.allow=always", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always"];
const GIT_ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes" });

/** Whether omem cloned this checkout itself (under its repos/ directory): only those are fetched or changed by omem. */
export function managedCheckout(app: App, root: string) {
  const parent = join(realpathSync(app.home), "repos");
  try {
    return realpathSync(root).startsWith(parent + "/") || realpathSync(root).startsWith(parent + "\\");
  } catch {
    return false;
  }
}

export type SubmoduleReport = { total: number; ready: number; fetched: string[]; failed: { path: string; error: string }[] };

/**
 * Check out the submodules of a checkout omem cloned (at every depth), so their files can be
 * indexed. Each one separately: one without access does not stop the others. A checkout the
 * user manages is left alone; its submodules are indexed when the user has initialized them.
 */
export async function ensureSubmodules(app: App, root: string, onProgress?: (text: string) => void): Promise<SubmoduleReport> {
  const report: SubmoduleReport = { total: 0, ready: 0, fetched: [], failed: [] };
  if (!existsSync(join(root, ".gitmodules"))) return report;
  const managed = managedCheckout(app, root);
  // Nested submodules appear once their parent is checked out: a few rounds at most.
  for (let round = 0; round < 4; round++) {
    const list = submodules(root);
    report.total = list.length;
    report.ready = list.filter((s) => s.state !== "missing").length;
    // In omem's own checkout a submodule at another commit than the superproject records is stale too.
    const missing = list.filter((s) => (s.state === "missing" || s.state === "changed") && !report.failed.some((f) => f.path === s.path) && !report.fetched.includes(s.path));
    if (!managed || !missing.length) break;
    const ready = new Set(list.filter((x) => x.state !== "missing").map((x) => x.path));
    for (const [i, s] of missing.entries()) {
      onProgress?.(`拉取子模块 ${report.fetched.length + i + 1}/${missing.length + report.fetched.length}：${s.path}`);
      // A nested submodule is updated from inside its parent submodule, with a path relative to it.
      const parent = [...ready].filter((p) => s.path.startsWith(p + "/")).sort((a, b) => b.length - a.length)[0];
      const cwd = parent ? join(root, parent) : root;
      const rel = parent ? s.path.slice(parent.length + 1) : s.path;
      try {
        await exec("git", [...SAFE_GIT, "-C", cwd, "submodule", "update", "--init", "--depth", "1", "--", rel], { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, env: GIT_ENV() });
        report.fetched.push(s.path);
      } catch (e) {
        // Some servers refuse shallow fetches of a pinned commit; a full fetch then.
        try {
          await exec("git", [...SAFE_GIT, "-C", cwd, "submodule", "update", "--init", "--", rel], { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024, env: GIT_ENV() });
          report.fetched.push(s.path);
        } catch (e2) {
          const msg = String((e2 as { stderr?: string }).stderr || (e2 as Error).message || e).trim().split("\n").slice(-2).join(" ");
          report.failed.push({ path: s.path, error: msg.slice(0, 300) });
        }
      }
    }
  }
  const final = submodules(root);
  report.total = final.length;
  report.ready = final.filter((s) => s.state !== "missing").length;
  return report;
}

/** Only network Git transports; never Git's executable/helper or local-file syntax. */
export function repositoryUrl(value: string): string {
  const input = value.trim();
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._/~+-]+$/.test(input)) return input;
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, "请提供 HTTPS / SSH Git 仓库链接或本地绝对路径"); }
  if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname || url.password || (url.protocol !== "ssh:" && url.username) || url.search || url.hash)
    throw new HttpError(400, "只支持不含密码或令牌的 HTTP(S) / SSH Git 仓库链接");
  return url.toString();
}

/** A remote URL normalized so one repository's https, ssh and scp-style forms compare equal. */
export function remoteKey(url: string) {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+(.+?)(?:\.git)?\/*$/i.exec(url.trim());
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : url.trim();
}

/** A checkout's remotes as `remoteKey`s. */
export function remoteKeys(dir: string) {
  const urls = git(dir, ["remote", "-v"]).stdout.split("\n").map((l) => l.split(/\s+/)[1]).filter(Boolean);
  return new Set(urls.map(remoteKey));
}

/** Two checkouts of one repository: a remote in common (each may have its own .git). */
export function sameRepository(a: string, b: string) {
  const mine = remoteKeys(a);
  return [...remoteKeys(b)].some((k) => mine.has(k));
}

export function repositoryRoot(path: string): string {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `仓库目录不存在：${path}`);
  const result = git(path, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) throw new HttpError(400, "关联编码仓库需要一个 Git 工作目录");
  return realpathSync(result.stdout.trim());
}

/**
 * A new, empty repository to code in: `value` is an absolute path (absent, or an empty directory) or a
 * name, which goes under omem's repos/ directory. One empty commit on main, so worktrees and branches
 * have a base to start from.
 */
export function initRepository(app: App, value: string): string {
  const input = value.trim();
  if (!input) throw new HttpError(400, "新建仓库要给一个名字或本地绝对路径");
  let target: string;
  if (isAbsolute(input)) target = resolve(input);
  else {
    const name = slugify(input);
    if (/[\\/]/.test(input) || !name || name.startsWith(".")) throw new HttpError(400, "新建仓库的名字不能带路径；要放在别处就给绝对路径");
    const parent = join(realpathSync(app.home), "repos");
    mkdirSync(parent, { recursive: true });
    if (realpathSync(parent) !== resolve(parent)) throw new HttpError(400, "repos 目录不能通过符号链接指向其他位置");
    target = join(parent, name);
  }
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new HttpError(400, `${target} 已存在且不是目录`);
    if (readdirSync(target).length) throw new HttpError(409, `${target} 已存在且不是空目录；已有的仓库直接关联，不用新建`);
  } else mkdirSync(target, { recursive: true });
  const step = (args: string[]) => {
    const r = git(target, args);
    if (!r.ok) throw new HttpError(500, `新建仓库失败（git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""}）：${r.stderr.trim().slice(0, 300)}`);
    return r;
  };
  step(["init", "-q", "-b", "main"]);
  // A machine without a Git identity still gets its first commit; later commits use whatever is configured.
  const who = git(target, ["config", "user.name"]).stdout.trim() && git(target, ["config", "user.email"]).stdout.trim() ? [] : ["-c", "user.name=omem", "-c", "user.email=omem@localhost"];
  step([...who, "commit", "-q", "--allow-empty", "-m", "init"]);
  return realpathSync(target);
}

/**
 * Check out `branch` in a repository space's own directory (where delegations cut their work branch
 * from): a local branch, or one only on origin (made local, tracking it). Refused while there are
 * uncommitted changes to tracked files, or when another worktree has the branch; untracked files stay.
 */
export function checkoutBranch(root: string, branch: string): { current: string; previous: string } {
  if (!/^(?!-)(?!.*\.\.)[\w./-]+$/.test(branch) || branch.endsWith("/") || branch.endsWith(".lock")) throw new HttpError(400, `分支名不对：${branch}`);
  const previous = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (previous === branch) return { current: branch, previous };
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim();
  if (dirty) throw new HttpError(409, `仓库目录里有没提交的改动，先提交或收起再切换：\n${dirty.split("\n").slice(0, 10).join("\n")}`);
  const local = git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const remote = !local && git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).ok;
  if (!local && !remote) throw new HttpError(404, `没有分支 ${branch}`);
  const r = git(root, local ? ["checkout", "-q", branch] : ["checkout", "-q", "--track", "-b", branch, `origin/${branch}`]);
  if (!r.ok) throw new HttpError(409, `没能检出 ${branch}：${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return { current: branch, previous };
}

const pending = new Map<string, Promise<string>>();
/** Repeated/concurrent URLs reuse one checkout. Failed clones never become spaces. */
export async function cloneRepository(app: App, value: string): Promise<string> {
  const url = repositoryUrl(value);
  const name = slugify(basename(url.replace(/\/$/, "")).replace(/\.git$/, "")) || "repo";
  const parent = join(realpathSync(app.home), "repos");
  const target = join(parent, `${name}-${sha256(url).slice(0, 12)}`);
  const active = pending.get(target);
  if (active) return active;
  const work = (async () => {
    mkdirSync(parent, { recursive: true });
    if (realpathSync(parent) !== resolve(parent)) throw new HttpError(400, "repos 目录不能通过符号链接指向其他位置");
    if (existsSync(target)) {
      if (repositoryRoot(target) !== resolve(target) || git(target, ["remote", "get-url", "origin"]).stdout.trim() !== url)
        throw new HttpError(409, "克隆目录已被其他仓库占用，请检查 omem 的 repos 目录");
      return target;
    }
    const temporary = join(parent, `.clone-${sha256(url).slice(0, 12)}-${Date.now()}`);
    try {
      // Submodules are checked out afterwards one by one (ensureSubmodules), so one without access does not fail the clone.
      await exec("git", [...SAFE_GIT, "clone", "--", url, temporary], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024, env: GIT_ENV() });
      repositoryRoot(temporary);
      renameSync(temporary, target);
      return target;
    } catch {
      rmSync(temporary, { recursive: true, force: true });
      throw new HttpError(400, "Git 克隆失败或超时；请检查仓库链接、网络及本机 Git/SSH 读取权限，再重试。未创建空间或关联。");
    }
  })();
  pending.set(target, work);
  try { return await work; } finally { pending.delete(target); }
}
