import type { Writable } from "node:stream";
import { sandboxNpmrc } from "./sandbox-npmrc.ts";
import { withPinnedBinds } from "./bwrap-spawn.ts";
import { commandMounts } from "./command-mounts.ts";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { withAgentPath } from "../core/tools.ts";
import { canonical, ownSandboxEnv, under, type OwnSandbox } from "./own-sandbox.ts";
import { bwrapArgs, sandboxSupport, sandboxCommand, type SandboxAccount, type WorkspaceMounts } from "./sandbox.ts";

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
type LaunchOptions = { cwd: string; baseEnv?: NodeJS.ProcessEnv; directOnly?: boolean; env?: NodeJS.ProcessEnv; ownSandbox?: OwnSandbox; sandbox?: SandboxAccount; workspace?: WorkspaceMounts };
export function launch(command: string, args: string[], opts: LaunchOptions & { stdin: "ignore" | number }): Omit<ChildProcessWithoutNullStreams, "stdin"> & { stdin: null };
export function launch(command: string, args: string[], opts: LaunchOptions & { stdin?: "pipe" }): ChildProcessWithoutNullStreams;
export function launch(command: string, args: string[], opts: LaunchOptions & { stdin?: "pipe" | "ignore" | number }) {
  // Agents get tools osdk installed (desktop control) on PATH without the owner putting osdk shims there.
  const base = opts.baseEnv ?? process.env;
  const guarded = opts.ownSandbox?.guarded ?? opts.sandbox?.guarded;
  const runEnv = guarded ? { ...opts.env, OMEM_COMMAND_GATE: guarded } : opts.env;
  const env = withAgentPath({ ...base, ...runEnv });
  if (guarded) env.PATH = guarded + delimiter + (env.PATH ?? "");
  const resolved = resolveCommand(command, env);
  if (!resolved) throw new Error(`找不到命令 ${command}。请安装对应 Agent CLI 或在设置中修改命令。`);
  if (opts.directOnly && resolved.prefix.includes("/c")) throw new Error("命令需要经过 shell 才能启动");
  const account = opts.ownSandbox ?? opts.sandbox;
  const npmrc = account && join(canonical(account.home), ".npmrc");
  const registryFile = npmrc && !opts.sandbox?.borrowed && !opts.ownSandbox?.hidden.some(p => under(npmrc, p)) ? npmrc : undefined;
  const runtime = base.XDG_RUNTIME_DIR;
  const desktopPrivate = account ? [
    ...[".ai-auto-desktop", ".aad-request-gates", ".Xauthority", ".omem/remote/profiles"].map(name => join(canonical(account.home), name)),
    ...(base.XAUTHORITY && isAbsolute(base.XAUTHORITY) ? [base.XAUTHORITY] : []),
    ...(runtime && isAbsolute(runtime) ? [join(runtime, "at-spi"), join(runtime, "bus"),
      ...(base.WAYLAND_DISPLAY ? [isAbsolute(base.WAYLAND_DISPLAY) ? base.WAYLAND_DISPLAY : join(runtime, base.WAYLAND_DISPLAY)] : [])] : []),
  ] : [];
  let boxed;
  if (opts.ownSandbox) {
    const box = opts.ownSandbox;
    const cwd = canonical(opts.cwd);
    const plan = box.plan;
    for (const dir of [box.runDir, ...box.state]) {
      if (!dir || !plan.rw.includes(dir)) continue;
      if (canonical(dir) !== dir) throw new Error("沙箱状态目录在启动前改变：" + dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    boxed = { file: sandboxSupport().bwrap!, env: ownSandboxEnv(base, { ...runEnv, PATH: env.PATH, OMEM_RUN_DIR: box.runDir }, box.secretEnv),
      ...bwrapArgs({ ...plan, masked: [...(plan.masked ?? []), ...desktopPrivate], privateTmp: plan.work.privateTmp, commandMounts: commandMounts(runEnv?.OMEM_COMMAND_GATE, env.PATH), network: box.network, cwd, command: box.network ? canonical(resolved.file) : resolved.file, args: [...resolved.prefix, ...args] }, registryFile) };
  } else boxed = opts.sandbox ? sandboxCommand(resolved, args, { ...runEnv, PATH: env.PATH }, opts.cwd, { ...opts.sandbox, masked: [...(opts.sandbox.masked ?? []), ...desktopPrivate] }, opts.workspace, base, registryFile) : null;
  // The registry snapshot owns fd 3 when present. Pinned mount descriptors follow it.
  const config = boxed?.npmrc ? sandboxNpmrc(boxed.npmrc) : undefined;
  const start = (argv: string[], fds: number[]) => {
    const child = spawn(boxed?.file ?? resolved.file, argv, {
      cwd: opts.cwd, env: boxed?.env ?? env,
      stdio: [opts.stdin ?? "pipe", "pipe", "pipe", ...(config ? ["pipe" as const] : []), ...fds],
      shell: false, windowsHide: true, detached: process.platform !== "win32",
    });
    if (config) {
      const input = child.stdio[3] as Writable;
      input.on("error", () => {});
      input.end(config);
    }
    return child;
  };
  const child = boxed?.pinned.size ? withPinnedBinds(boxed.args, boxed.pinned, start, config ? 4 : 3) : start(boxed?.args ?? [...resolved.prefix, ...args], []);
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

/**
 * CPU time (clock ticks) used so far by `pid` and everything under it, reaped children included; Linux only,
 * undefined elsewhere or when the process is gone.
 */
export function treeCpuTicks(pid: number | undefined): number | undefined {
  if (!pid || process.platform !== "linux") return undefined;
  const kids = new Map<number, number[]>(), ticks = new Map<number, number>();
  let dirs: string[];
  try { dirs = readdirSync("/proc"); } catch { return undefined; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    try {
      // The name in parentheses can hold spaces: after the last ")" come "state ppid … utime stime cutime cstime".
      const stat = readFileSync(`/proc/${d}/stat`, "utf8"), f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const n = Number(d), ppid = Number(f[1]);
      ticks.set(n, Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]));
      kids.set(ppid, [...(kids.get(ppid) ?? []), n]);
    } catch { /* gone meanwhile */ }
  }
  if (!ticks.has(pid)) return undefined;
  let sum = 0;
  const todo = [pid], seen = new Set<number>();
  while (todo.length) { const p = todo.pop()!; if (seen.has(p)) continue; seen.add(p); sum += ticks.get(p) ?? 0; todo.push(...(kids.get(p) ?? [])); }
  return sum;
}

/**
 * Keep `watchdog` alive while the process tree under `pid` keeps using CPU: a print-mode agent that only writes
 * its answer at the end may be building or testing for longer than the idle limit. Returns a stop function.
 */
export function touchWhileBusy(pid: number | undefined, watchdog: { touch(): void }, everyMs = 60_000) {
  let last = treeCpuTicks(pid);
  if (last === undefined) return () => {};
  const timer = setInterval(() => {
    const now = treeCpuTicks(pid);
    if (now !== undefined && now > last!) watchdog.touch();
    if (now !== undefined) last = now;
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * How long a backend may stay silent at its effort. At the highest efforts a model can think for over ten
 * minutes without sending anything (Codex at xhigh / max, 2026-11-26..28: six runs stopped by the default
 * limit after a tool result, one just as it answered), so those get a multiple of the profile's idle limit.
 */
export const EFFORT_IDLE_FACTOR: Readonly<Record<string, number>> = { xhigh: 2, max: 3 };
export function idleTimeoutFor(profile: { idleTimeoutMs: number; effort?: string | null }) {
  return Math.round(profile.idleTimeoutMs * (EFFORT_IDLE_FACTOR[String(profile.effort ?? "").toLowerCase()] ?? 1));
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
