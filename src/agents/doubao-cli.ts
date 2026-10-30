import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentProfile } from "../core/config.ts";
import { idleWatchdog, launch, resolveCommand, stop } from "./spawn.ts";
import type { AgentEvent, AgentRequest, AgentResult } from "./types.ts";

/**
 * The Doubao CLI (`npm i -g @bytedance/doubao-cli`, command `doubao`, signed in with `doubao login`).
 * No ACP, no MCP and no JSON events: `doubao -p <prompt>` runs a whole turn on the local machine
 * (files, shell) and prints only the final reply to stdout; stderr carries
 * `{"type":"session","session_id":…}`, and `--resume <id>` continues that conversation.
 *
 * - omem tools: through `omem tool` in its shell (the run's token and `omem` on PATH reach the
 *   commands it runs), so the instructions tell it so.
 * - The prompt: there is no stdin; a long one goes into a file it is told to read.
 * - The npm `doubao` is a node wrapper that may stop to ask about an update, and on Windows a .cmd
 *   that cmd.exe re-parses; the native binary it starts is called directly when it is there.
 * - Conversations are kept in the Doubao account (`doubao --list`); the CLI cannot delete or
 *   archive them, so each new omem session adds one to the owner's history.
 */

/** Where the npm package unpacks the native CLI (its scripts/runtime.cjs). */
export function doubaoAppRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const parent =
    platform === "win32" ? env.LOCALAPPDATA : platform === "darwin" ? join(homedir(), "Library/Application Support") : (env.XDG_DATA_HOME ?? (env.HOME ? join(env.HOME, ".local/share") : undefined));
  return parent && isAbsolute(parent) ? join(parent, "doubao_cli", "app") : null;
}

/** The native executable for a profile: the installed one for the default `doubao`, else the command as configured. */
export function doubaoExecutable(profile: AgentProfile): string {
  if (profile.command !== "doubao") return profile.command;
  const root = doubaoAppRoot();
  const native = root && join(root, "current", process.platform === "win32" ? "doubao.exe" : "doubao");
  return native && existsSync(native) ? native : profile.command;
}

export const DOUBAO_CLI_INSTALL = "npm i -g @bytedance/doubao-cli，再 doubao login";

/** What the agent is told when omem's tools come through its shell. */
export const DOUBAO_TOOL_NOTE =
  "【omem 工具】这次运行没有 MCP 工具。说明里提到的 omem 工具（omem_help、omem_call 和各个工具名）都在终端里调用：`omem tool <工具名> 键=值 …`，参数复杂时写进 JSON 文件再 `omem tool <工具名> -f 参数.json`，`omem tool help [分组]` 看说明。权限与这次运行相同。";

/** Longest prompt passed as an argument; longer ones go through a file. */
const INLINE_MAX = 6000;

export function doubaoArgs(profile: AgentProfile, req: AgentRequest, prompt: string) {
  const args = [...profile.args];
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  args.push("-p", prompt);
  if (profile.model) args.push("--model", profile.model);
  if (profile.effort) args.push("--effort", profile.effort);
  // It has no read-only mode; outside coding it asks before risky operations (no one answers, so they fail).
  args.push("--permission-mode", req.allowWrites ? "always_allow" : "ask_risky");
  args.push("-C", req.cwd);
  return args;
}

export async function runDoubaoCli(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const exe = doubaoExecutable(profile);
  const direct = exe !== profile.command || process.platform !== "win32";
  let file: string | undefined;
  let prompt = req.prompt;
  if (!direct || prompt.length > INLINE_MAX) {
    const dir = join(tmpdir(), "omem-doubao");
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${randomUUID()}.md`);
    writeFileSync(file, req.prompt);
    prompt = `先完整读取文件 ${file}（UTF-8），那是这一轮的完整内容，按它执行并回答；回答里不要提这个文件。`;
  }
  const child = launch(exe, doubaoArgs(profile, req, prompt), { cwd: req.cwd, env: { ...profile.env, ...req.mcp?.env, ...req.env } });
  child.stdin.end();
  emit({ type: "status", text: "豆包 CLI 在本机执行，整轮结束后才输出回复" });
  let stdout = "";
  let stderr = "";
  let sessionId: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const watchdog = idleWatchdog(profile.idleTimeoutMs, () => {
        stop(child);
        reject(new Error("豆包 CLI 长时间没有结果，已停止"));
      });
      const onAbort = () => {
        stop(child);
        reject(new Error("CANCELLED"));
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        watchdog.touch();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-8000);
        const id = sessionIn(stderr);
        if (id && id !== sessionId) {
          sessionId = id;
          emit({ type: "session", sessionId: id, resumed: id === req.resumeSessionId });
        }
      });
      child.once("error", (e) => {
        watchdog.close();
        reject(e);
      });
      child.once("close", (code) => {
        watchdog.close();
        req.signal?.removeEventListener("abort", onAbort);
        if (code !== 0) reject(new Error(`豆包 CLI 退出码 ${code}：${errorText(stdout, stderr)}`));
        else resolve();
      });
    });
  } finally {
    if (file) rmSync(file, { force: true });
  }
  const text = stdout.trim();
  if (text) emit({ type: "text", text });
  return { text, stopReason: "end_turn", agent: "doubao", sessionId };
}

function sessionIn(stderr: string): string | undefined {
  for (const line of stderr.split("\n")) {
    try {
      const item = JSON.parse(line);
      if (item?.type === "session" && typeof item.session_id === "string") return item.session_id;
    } catch {}
  }
  return undefined;
}

function errorText(stdout: string, stderr: string) {
  const lines = `${stdout}\n${stderr}`.split("\n").filter((l) => l.trim() && !sessionIn(l));
  return lines.join("\n").replace(/^Error:\s*/m, "").slice(-800) || "没有输出";
}

/** One short invocation that fails during argument checks; returns what it printed. */
function check(exe: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const r = resolveCommand(exe);
  if (!r) return Promise.resolve({ code: null, out: `找不到命令 ${exe}` });
  return new Promise((resolve) => {
    const child = spawn(r.file, [...r.prefix, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: tmpdir() });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    const timer = setTimeout(() => stop(child as never), 60_000);
    child.once("error", (e) => resolve({ code: null, out: e.message }));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const listAfter = (out: string, label: string) => {
  const m = out.match(new RegExp(`${label}:\\s*([^\\n]*?)\\.?(?:\\s+Start |\\s*$)`, "m"));
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null;
};
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Models and their effort levels, from the CLI's own argument errors. `--resume` with an id that
 * does not exist keeps a valid combination from starting a conversation: it fails at the lookup.
 */
export async function probeDoubaoCli(profile: AgentProfile): Promise<{ models: string[]; effortsByModel: Record<string, string[]> }> {
  const exe = doubaoExecutable(profile);
  const base = [...profile.args, "--resume", "1", "-p", "x"];
  const first = await check(exe, [...base, "--model", "__omem_probe__"]);
  const models = listAfter(first.out, "Available models");
  if (!models?.length) throw new Error(errorText(first.out, "") || "豆包 CLI 没有报出模型列表（先运行 doubao login）");
  const effortsByModel: Record<string, string[]> = {};
  await Promise.all(
    models.map(async (m) => {
      for (const level of ["none", "max"]) {
        const r = await check(exe, [...base, "--model", m, "--effort", level]);
        const levels = listAfter(r.out, "Available levels");
        if (levels) return void (effortsByModel[m] = levels);
        // Accepted: it got as far as looking up the conversation. Anything else (no effort setting, a model that needs a subscription): none.
        if (!/IM request failed/i.test(r.out)) return void (effortsByModel[m] = []);
      }
      effortsByModel[m] = LEVELS;
    }),
  );
  return { models, effortsByModel };
}
