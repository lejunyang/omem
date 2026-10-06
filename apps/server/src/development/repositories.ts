import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { git, saveJson } from "./workspace.js";

export type RepositoryPreparation = {
  alias: string;
  url: string;
  ref: string;
  requestId: string;
  phase: "fetching" | "checkout" | "ready" | "failed";
  updatedAt: string;
  pid: number | null;
  commit?: string;
  directory?: string;
  message: string;
  limitations: string[];
};

export function repositoryLocation(value: string) {
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("-"))
    throw Error("请提供完整 Git 地址或绝对路径");
  if (isAbsolute(value)) return resolve(value);
  if (/\s/.test(value)) throw Error("Git URL 不能包含空白字符");
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("Git 地址须为 HTTPS、SSH 或本机绝对路径");
  }
  if (
    !["https:", "http:", "ssh:"].includes(url.protocol) ||
    !url.hostname ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "ssh:" && url.username)
  )
    throw Error(
      "Git 地址不支持此格式；凭据请交给已有 SSH 或 Git credential helper，不写入地址",
    );
  return value;
}
export function repositoryRef(value = "HEAD") {
  if (
    !value ||
    value.startsWith("-") ||
    /[\s~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{")
  )
    throw Error("请指定一个分支、标签或提交，不传选项、refspec 或修订表达式");
  return value;
}
function live(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function clean(message: string) {
  return message
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[credential]@")
    .replace(/(authorization:|password[=:]|token[=:])\s*\S+/gi, "$1 [redacted]")
    .slice(-4000);
}

/** Keep existing Git/SSH authentication. No interactive login, push, hooks, or
 * recursive submodule fetch; progress renews the inactivity deadline. */
async function fetchGit(
  root: string,
  ref: string,
  signal: AbortSignal | undefined,
  progress: (text: string) => void,
) {
  return new Promise<void>((resolveRun, reject) => {
    signal?.throwIfAborted();
    const child = spawn(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.interactive=false",
        "-c",
        "protocol.ext.allow=never",
        "fetch",
        "--progress",
        "--no-tags",
        "--no-recurse-submodules",
        "origin",
        ref,
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([k]) =>
                ![
                  "GIT_DIR",
                  "GIT_WORK_TREE",
                  "GIT_COMMON_DIR",
                  "GIT_INDEX_FILE",
                  "GIT_OBJECT_DIRECTORY",
                  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                ].includes(k),
            ),
          ),
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          GIT_LFS_SKIP_SMUDGE: "1",
        },
      },
    );
    let output = "",
      stopped: Error | undefined,
      timer: ReturnType<typeof setTimeout>,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* Already exited. */
      }
    };
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = reason;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 3000);
    };
    const tick = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => stop(Error("Git 已两分钟没有输出，请检查网络或登录状态后重试")),
        120000,
      );
    };
    const abort = () => stop(Error("仓库准备已中断，可重试原任务"));
    signal?.addEventListener("abort", abort, { once: true });
    const done = (error?: Error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolveRun();
    };
    child.on("error", (error) => done(error));
    child.on("close", (code) =>
      done(
        stopped ??
          (code === 0
            ? undefined
            : Error(clean(output) || `Git fetch 退出 ${code}`)),
      ),
    );
    const receive = (bytes: Buffer) => {
      output = (output + bytes.toString()).slice(-8000);
      tick();
      progress(clean(output));
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    tick();
    if (signal?.aborted) abort();
  });
}

/** One object cache per registered remote; each observed commit has its own
 * worktree. Refresh never resets an older checkout or an in-flight coding run. */
export class RepositoryPreparer {
  constructor(readonly root: string) {}
  directory(alias: string) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(alias))
      throw Error("无效项目别名");
    return join(this.root, "repositories", alias);
  }
  status(alias: string): RepositoryPreparation | null {
    const file = join(this.directory(alias), "state.json");
    if (!existsSync(file)) return null;
    const state = JSON.parse(
      readFileSync(file, "utf8"),
    ) as RepositoryPreparation;
    if (["fetching", "checkout"].includes(state.phase) && !live(state.pid))
      return {
        ...state,
        phase: "failed",
        message: "上次准备被中断，可以重试；已下载对象保留",
      };
    return state;
  }
  async prepare(
    alias: string,
    url: string,
    ref: string,
    requestId: string,
    signal?: AbortSignal,
  ) {
    url = repositoryLocation(url);
    ref = repositoryRef(ref);
    const root = this.directory(alias),
      cache = join(root, "objects.git"),
      lock = join(root, "lock.json");
    const previous = this.status(alias);
    if (previous && previous.url !== url)
      throw Error("该别名已绑定另一仓库，请使用新别名");
    if (
      previous?.requestId === requestId &&
      previous.phase === "ready" &&
      previous.directory &&
      existsSync(previous.directory)
    )
      return previous;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, "utf8"));
      if (live(owner.pid)) throw Error("同一仓库仍在准备中，请查询状态");
      unlinkSync(lock);
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, requestId }), {
      flag: "wx",
      mode: 0o600,
    });
    const state: RepositoryPreparation = {
      alias,
      url,
      ref,
      requestId,
      phase: "fetching",
      updatedAt: new Date().toISOString(),
      pid: process.pid,
      message: "正在读取指定仓库和版本",
      limitations: [],
    };
    const save = () => {
      state.updatedAt = new Date().toISOString();
      saveJson(join(root, "state.json"), state);
    };
    save();
    try {
      signal?.throwIfAborted();
      if (!existsSync(join(cache, "HEAD"))) {
        mkdirSync(cache, { recursive: true, mode: 0o700 });
        await git(cache, "init", "--bare", "--quiet");
      }
      const remote = await git(cache, "remote");
      if (!remote.split("\n").includes("origin"))
        await git(cache, "remote", "add", "origin", url);
      if ((await git(cache, "remote", "get-url", "origin")).trim() !== url)
        throw Error("缓存仓库地址与登记地址不一致");
      let last = 0;
      await fetchGit(cache, ref, signal, (message) => {
        if (Date.now() - last < 500) return;
        last = Date.now();
        state.message = message;
        save();
      });
      signal?.throwIfAborted();
      const commit = (
        await git(cache, "rev-parse", "--verify", "FETCH_HEAD^{commit}")
      ).trim();
      state.commit = commit;
      state.phase = "checkout";
      state.message = "正在准备固定提交的本地工作区";
      save();
      // Keep commits reachable even if a remote branch is later force-pushed.
      await git(cache, "update-ref", `refs/omem/prepared/${commit}`, commit);
      const directory = join(root, "versions", commit);
      if (!existsSync(join(directory, ".git"))) {
        await git(cache, "worktree", "prune");
        await git(
          cache,
          "-c",
          "filter.lfs.smudge=",
          "-c",
          "filter.lfs.process=",
          "-c",
          "filter.lfs.required=false",
          "worktree",
          "add",
          "--detach",
          directory,
          commit,
        );
      }
      if ((await git(directory, "rev-parse", "HEAD")).trim() !== commit)
        throw Error("准备目录的提交已被修改；保留现状，请使用新项目别名");
      signal?.throwIfAborted();
      if ((await git(directory, "status", "--porcelain")).trim())
        state.limitations.push(
          "此提交的工作区已有未提交修改，已保留；新编码任务需先处理这些修改",
        );
      if (existsSync(join(directory, ".gitmodules")))
        state.limitations.push(
          "尚未递归读取子模块，需单独准备其访问权限与内容",
        );
      const attributes = join(directory, ".gitattributes");
      if (
        existsSync(attributes) &&
        /filter=lfs/.test(readFileSync(attributes, "utf8"))
      )
        state.limitations.push("LFS 内容未自动下载，当前可能仍为指针文件");
      state.directory = directory;
      state.phase = "ready";
      state.pid = null;
      state.message = "仓库已准备，已固定提交；尚未编码或运行项目脚本";
      save();
      return state;
    } catch (error) {
      state.phase = "failed";
      state.pid = null;
      state.message = clean(
        error instanceof Error ? error.message : String(error),
      );
      save();
      throw Error(state.message);
    } finally {
      unlinkSync(lock);
    }
  }
}
