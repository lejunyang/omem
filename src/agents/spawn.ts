import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { withAgentPath } from "../core/tools.ts";
import { canonical, ownMounts, ownSandboxEnv, under, type OwnSandbox } from "./own-sandbox.ts";
import { bwrapArgs, installRoot, sandboxSupport, sandboxCommand, type SandboxAccount, type WorkspaceMounts } from "./sandbox.ts";

/**
 * Find an executable on PATH. On Windows npm installs `.cmd` shims, which
 * cannot be spawned without a shell; we run them through cmd.exe explicitly.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): { file: string; prefix: string[] } | null {
  const isWin = process.platform === "win32";
  const exts = isWin ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase()) : [""];
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\") ? [command] : (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean).map((d) => join(d, command));
  for (const base of candidates) {
    for (const ext of extname(base) ? [""] : exts) {
      const file = base + ext;
      try {
        accessSync(file, isWin ? constants.F_OK : constants.X_OK);
        if (isWin && /\.(cmd|bat)$/i.test(file)) {
          // npm shims just run `node <script>`: call node directly so arguments
          // (JSON, quotes) are not re-parsed by cmd.exe.
          const target = npmShimTarget(file);
          if (target) return /\.exe$/i.test(target) ? { file: target, prefix: [] } : { file: process.execPath, prefix: [target] };
          return { file: env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", file] };
        }
        return { file, prefix: [] };
      } catch {}
    }
  }
  return null;
}

/** Extract what an npm-generated .cmd shim runs: a JavaScript entry, or a native .exe (newer packages ship one). */
export function npmShimTarget(cmdFile: string): string | null {
  try {
    const text = readFileSync(cmdFile, "utf8");
    // A script wins over an .exe: pnpm shims name node.exe before the script they run.
    const m = /"%(?:~)?dp0%?\\([^"]+?\.(?:c|m)?js)"/i.exec(text) ?? /"%(?:~)?dp0%?\\(node_modules\\[^"]+?\.exe)"/i.exec(text);
    if (!m) return null;
    const script = join(dirname(cmdFile), m[1].replace(/\\/g, "/"));
    return existsSync(script) ? script : null;
  } catch {
    return null;
  }
}

export function commandExists(command: string) {
  return resolveCommand(command) !== null;
}

/** `sandbox`: run for one user's own account, inside bubblewrap (agents/sandbox.ts); the profile carries it (`accountOf`). */
type LaunchOptions = { cwd: string; env?: NodeJS.ProcessEnv; ownSandbox?: OwnSandbox; sandbox?: SandboxAccount; workspace?: WorkspaceMounts };
export function launch(command: string, args: string[], opts: LaunchOptions & { stdin: "ignore" }): Omit<ChildProcessWithoutNullStreams, "stdin"> & { stdin: null };
export function launch(command: string, args: string[], opts: LaunchOptions & { stdin?: "pipe" }): ChildProcessWithoutNullStreams;
export function launch(command: string, args: string[], opts: LaunchOptions & { stdin?: "pipe" | "ignore" }) {
  // Agents get tools osdk installed (desktop control) on PATH without the owner putting osdk shims there.
  const env = withAgentPath({ ...process.env, ...opts.env });
  const resolved = resolveCommand(command, env);
  if (!resolved) throw new Error(`找不到命令 ${command}。请安装对应 Agent CLI 或在设置中修改命令。`);
  let boxed;
  if (opts.ownSandbox) {
    const box = opts.ownSandbox;
    const cwd = canonical(opts.cwd);
    const command = canonical(resolved.file);
    const runtime = [...box.runtime, resolved.file, command, installRoot(command), ...resolved.prefix.filter(isAbsolute)];
    // Only restore program mounts beneath a mask. Never restore an installation's parent over the data mask.
    const masked = (p: string) => p !== box.data && p !== "/tmp" && [box.data, "/tmp"].some(h => under(p, h));
    const grants = [...box.state, ...box.writable, ...(opts.workspace?.rw ?? []), ...(!box.readOnly ? [cwd] : [])];
    const protectedRuntime = runtime.filter(p => masked(p) || grants.some(dir => under(p, dir)));
    // Bind only the host-assigned inbox. A profile environment is not a mount declaration.
    const inbox = box.artifactDir && opts.env?.OMEM_ARTIFACTS && canonical(opts.env.OMEM_ARTIFACTS) === box.artifactDir
      ? box.artifactDir : undefined;
    const plan = ownMounts({ ...box, runtime: protectedRuntime }, cwd, opts.workspace, inbox);
    for (const dir of [box.runDir, ...box.state]) {
      if (!dir || !plan.rw.includes(dir)) continue;
      if (canonical(dir) !== dir) throw new Error("沙箱状态目录在启动前改变：" + dir);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    boxed = { file: sandboxSupport().bwrap!, env: ownSandboxEnv(process.env, { ...opts.env, PATH: env.PATH, OMEM_RUN_DIR: box.runDir }, box.secretEnv),
      args: bwrapArgs({ ...plan, cwd, command: resolved.file, args: [...resolved.prefix, ...args] }) };
  } else boxed = opts.sandbox ? sandboxCommand(resolved, args, { ...opts.env, PATH: env.PATH }, opts.cwd, opts.sandbox, opts.workspace) : null;
  const child = spawn(boxed?.file ?? resolved.file, boxed?.args ?? [...resolved.prefix, ...args], {
    cwd: opts.cwd,
    env: boxed?.env ?? env,
    stdio: [opts.stdin ?? "pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.stdin?.on("error", () => {});
  return child;
}

export class SandboxStartError extends Error {}

/** bubblewrap reports mount/namespace setup errors on stderr before starting the backend. */
export function sandboxStartError(account: SandboxAccount | undefined, stderr: string): Error | undefined {
  const reason = account && stderr.match(/^bwrap: (.+)$/m)?.[1];
  if (reason) return new SandboxStartError(`这台机器不能隔离成员的运行：${reason}`);
}

export function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      else child.kill(signal);
    } catch {}
  };
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), 2000).unref();
}

/** Abort if the agent stays silent for too long; any activity resets the timer. */
export function idleWatchdog(ms: number, onIdle: () => void) {
  let timer = setTimeout(onIdle, ms);
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(onIdle, ms);
    },
    close() {
      clearTimeout(timer);
    },
  };
}
