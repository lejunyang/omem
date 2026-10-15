import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "../core/app.ts";
import { toolCommand } from "../core/tools.ts";

/**
 * The local injection judge, started by omem when it is needed and stopped
 * when it has been idle for a while. Two processes, both on loopback ports
 * picked at start:
 *
 * - llama-server runs the StartLux-Decision GGUF weights (osdk's
 *   conda:llama.cpp, or one on PATH). `--cache-ram 0 -ctxcp 0` keeps memory
 *   flat; without them the prompt cache grows until the process is killed.
 * - the model's own `startlux_decision.gguf_server` (shipped next to the
 *   weights) renders prompts and reads the option probabilities. Its Python
 *   dependencies come from scripts/startlux (uv, locked).
 *
 * Nobody has to keep these running: the first check starts them (about
 * 10–30 s), later checks reuse them, and they exit after `idleMs` without
 * requests or when omem exits.
 */
const here = dirname(fileURLToPath(import.meta.url));
export function judgeProject() {
  const dir = resolve(here, "../../scripts/startlux");
  return existsSync(join(dir, "pyproject.toml")) ? dir : null;
}

export function judgeModelFile(dir: string) {
  const f = existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith(".gguf")) : undefined;
  return f ? join(dir, f) : null;
}

type Running = { url: string; procs: ChildProcess[]; idle?: NodeJS.Timeout };
let current: Running | null = null;
let starting: Promise<string> | null = null;
let lastError = "";

export function judgeStatus() {
  return { running: !!current, url: current?.url ?? null, lastError };
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

async function waitHealthy(url: string, procs: ChildProcess[], ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (procs.some((p) => p.exitCode !== null)) throw new Error("判官进程启动后退出");
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("判官服务启动超时");
}

function launch(cmd: string[], args: string[], cwd: string, tail: { text: string }) {
  // Own process group: `osdk exec` and `uv run` start the real server as a grandchild, and stopping must reach it.
  const p = spawn(cmd[0], [...cmd.slice(1), ...args], { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  p.stderr?.on("data", (d) => (tail.text = (tail.text + d).slice(-1500)));
  p.on("error", (e) => (tail.text += `\n${e.message}`));
  return p;
}

function kill(p: ChildProcess) {
  if (p.exitCode !== null || !p.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(p.pid), "/t", "/f"], { windowsHide: true });
    else process.kill(-p.pid, "SIGTERM");
  } catch {
    p.kill();
  }
}

export function stopJudge() {
  const r = current;
  current = null;
  if (!r) return;
  clearTimeout(r.idle);
  for (const p of r.procs) kill(p);
}
process.once("exit", stopJudge);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    stopJudge();
    // Keep the default behaviour (exit) when nobody else handles the signal.
    if (process.listenerCount(sig) === 0) process.exit(128 + (sig === "SIGINT" ? 2 : 15));
  });

async function start(app: App): Promise<string> {
  const dir = app.config.guard.modelDir;
  if (!dir) throw new Error("没有设置判官模型目录（运行 omem setup → 注入标记）");
  const gguf = judgeModelFile(dir);
  if (!gguf) throw new Error(`${dir} 里没有 .gguf 文件`);
  const llama = toolCommand("llama-server");
  if (!llama) throw new Error("找不到 llama-server（运行 omem setup → 注入标记，会经 osdk 安装）");
  const uv = toolCommand("uv");
  const project = judgeProject();
  if (!uv || !project) throw new Error("找不到 uv 或判官的 Python 项目（运行 omem setup → 注入标记）");
  const [lp, sp] = [await freePort(), await freePort()];
  const tail = { text: "" };
  const procs: ChildProcess[] = [];
  try {
    procs.push(launch(llama, ["-m", gguf, "-c", "8192", "--parallel", "1", "--cache-ram", "0", "-ctxcp", "0", "--host", "127.0.0.1", "--port", String(lp)], dir, tail));
    await waitHealthy(`http://127.0.0.1:${lp}/health`, procs, 120_000);
    procs.push(
      launch(uv, ["run", "--project", project, "--frozen", "--quiet", "python", "-m", "startlux_decision.gguf_server", "--model-dir", ".", "--llama", `http://127.0.0.1:${lp}`, "--port", String(sp), "--workers", "2"], dir, tail),
    );
    // First run of the Python side may install torch/transformers through uv.
    await waitHealthy(`http://127.0.0.1:${sp}/`, procs, 15 * 60_000);
  } catch (e) {
    for (const p of procs) kill(p);
    throw new Error(`${(e as Error).message}${tail.text ? `：${tail.text.trim().split("\n").slice(-3).join(" / ")}` : ""}`);
  }
  current = { url: `http://127.0.0.1:${sp}`, procs };
  for (const p of procs) p.once("exit", () => current?.procs.includes(p) && stopJudge());
  return current.url;
}

/** URL of a running judge, starting it if needed. A configured `guard.url` (your own server) wins. */
export async function judgeUrl(app: App): Promise<string> {
  const g = app.config.guard;
  if (g.url) return g.url;
  if (current) {
    clearTimeout(current.idle);
    return current.url;
  }
  starting ??= start(app).finally(() => (starting = null));
  try {
    const url = await starting;
    lastError = "";
    return url;
  } catch (e) {
    lastError = (e as Error).message;
    throw e;
  }
}

/** Call after a request so the processes go away when nobody needs them. */
export function judgeDone(app: App) {
  if (!current) return;
  clearTimeout(current.idle);
  current.idle = setTimeout(stopJudge, app.config.guard.idleMs);
  current.idle.unref();
}
