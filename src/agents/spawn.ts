import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";

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

export function launch(command: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...opts.env };
  const resolved = resolveCommand(command, env);
  if (!resolved) throw new Error(`找不到命令 ${command}。请安装对应 Agent CLI 或在设置中修改命令。`);
  const child = spawn(resolved.file, [...resolved.prefix, ...args], {
    cwd: opts.cwd,
    env,
    stdio: "pipe",
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  child.stdin.on("error", () => {});
  return child;
}

export function stop(child: ChildProcessWithoutNullStreams) {
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
