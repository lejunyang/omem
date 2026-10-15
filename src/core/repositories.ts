import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { App } from "./app.ts";
import { git } from "./git.ts";
import { HttpError, sha256, slugify } from "./util.ts";

const exec = promisify(execFile);

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

export function repositoryRoot(path: string): string {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `仓库目录不存在：${path}`);
  const result = git(path, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) throw new HttpError(400, "关联编码仓库需要一个 Git 工作目录");
  return realpathSync(result.stdout.trim());
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
      await exec("git", ["-c", "protocol.allow=never", "-c", "protocol.http.allow=always", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "clone", "--", url, temporary], {
        timeout: 5 * 60_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes" },
      });
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
