import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentProfile } from "../core/config.ts";
import { sandboxStartError, idleTimeoutFor, idleWatchdog, launch, resolveCommand, stop, touchWhileBusy } from "./spawn.ts";
import { accountOf } from "./sandbox.ts";
import { under } from "./own-sandbox.ts";
import { aiUsageText, type AgentEvent, type AgentRequest, type AgentResult } from "./types.ts";
import { boundToolCommand } from "./tool-cli.ts";

/**
 * The Doubao CLI (`npm i -g @bytedance/doubao-cli`, command `doubao`, signed in with `doubao login`).
 * No ACP, no MCP and no JSON events: `doubao -p <prompt>` runs a whole turn on the local machine
 * (files, shell) and prints only the final reply to stdout; stderr carries
 * `{"type":"session","session_id":…}`, and `--resume <id>` continues that conversation.
 *
 * - omem tools: a private command in each turn's prompt binds its token and address, even when
 *   the shared CLI daemon launches shells with a previous turn's environment.
 * - The prompt stays in -p; stdin is an empty regular file. A long prompt goes into a file it is told to read.
 * - The npm `doubao` is a node wrapper that may stop to ask about an update, and on Windows a .cmd
 *   that cmd.exe re-parses; the native binary it starts is called directly when it is there.
 * - Conversations are kept in the Doubao account (`doubao --list`); dispatch.ts deletes finished
 *   one-off sessions through the OpenAPI when it is authorized on this machine.
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
  "【omem 工具】这次运行没有 MCP 工具。说明里提到的 omem 工具（omem_help、omem_call 和各个工具名）都在终端里调用：`omem tool <工具名> 键=值 …`，参数复杂时写进 JSON 文件再 `omem tool <工具名> -f 参数.json`，`omem tool help [分组]` 看说明。权限与这次运行相同。要说某件事“没有工具、做不了”之前，先 `omem tool help` 看各分组（比如改规则是 wake 分组的 list_rules / save_rule），真的找不到再这样说。\n\n【子任务】这一轮自己做完，不要另开子 Agent 或并行子任务：它们的过程 omem 看不到，读到的也不会交回这一轮。要别的 Agent 帮忙用 omem 的 run_agent / ask_agent；原件按需读，先 search 找到要看的，不要逐份通读。";

/**
 * Runs on the Doubao CLI right now. It prints nothing until the turn is over, so the omem tools it
 * calls through `omem tool` are what shows of its work: the tool endpoint records each as a step
 * (`tool` events) for these runs (server/http.ts).
 */
export const shellToolRuns = new Set<string>();

/** Longest prompt passed as an argument; longer ones go through a file. */
const INLINE_MAX = 6000;

/** The native input bridge accepts regular files; /dev/null can fail to read and Node pipes are sockets. */
function emptyStdin<T extends Pick<ChildProcess, "once">>(start: (fd: number) => T): T {
  const dir = join(tmpdir(), "omem-doubao");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.stdin`);
  writeFileSync(file, "", { mode: 0o600, flag: "wx" });
  const fd = openSync(file, "r");
  try {
    let child: T;
    try { child = start(fd); }
    finally { closeSync(fd); }
    // Keep it until close: Windows can keep the inherited handle open during the turn.
    child.once("close", () => rmSync(file, { force: true }));
    return child;
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
}

type CwdOption = "-C" | "--cwd" | "--directory" | "--workdir" | "--working-directory";
export function doubaoCwdOptionFromHelp(help: string): CwdOption | null {
  const options = Array.from(help.matchAll(/^\s*(-C|--cwd|--directory|--workdir|--working-directory)(?=[\s,=])/gm), m => m[1] as CwdOption);
  return options.find(option => option === "-C") ?? options[0] ?? null;
}

/**
 * What this install of the CLI can do, from its help (no login needed):
 * - `acp`: `doubao acp serve` (2.38+): turns go through ACP (MCP tools, streamed replies, model options);
 * - `delete`: `doubao delete <会话ID> --yes`: omem's one-off conversations are deleted with the CLI itself,
 *   also under a member's own account, instead of through the owner's OpenAPI login;
 * - `modelList`: `doubao model list --json` lists models and their levels for the probe.
 * Older installs keep `-p` and the OpenAPI cleanup.
 */
export type DoubaoFeatures = { cwdOption: CwdOption | null; acp: boolean; delete: boolean; modelList: boolean };
export function doubaoFeaturesFromHelp(help: string): DoubaoFeatures {
  return {
    cwdOption: doubaoCwdOptionFromHelp(help),
    acp: /^\s*doubao\s+acp\s+serve\b/m.test(help),
    delete: /^\s*doubao\s+delete\s+<[^>]+>/m.test(help),
    modelList: /^\s*doubao\s+model\s+list\b/m.test(help),
  };
}
const NONE: DoubaoFeatures = { cwdOption: null, acp: false, delete: false, modelList: false };
const features = new Map<string, DoubaoFeatures>();
let ignoreInstalled = false;
/** Tests: the `doubao` installed on this machine counts as an old one (fakes with their own command are still asked). */
export function ignoreInstalledDoubaoForTests() { ignoreInstalled = true; }
/**
 * Cached per executable (path, mtime, size) and launcher arguments, so an update of the CLI is seen
 * on the next turn. Synchronous: which interface a turn uses decides its capabilities (backendCapabilities).
 */
export function doubaoFeatures(profile: Pick<AgentProfile, "command" | "args" | "peer">): DoubaoFeatures {
  if (profile.peer || (ignoreInstalled && profile.command === "doubao")) return NONE;
  const exe = doubaoExecutable(profile as AgentProfile), resolved = resolveCommand(exe);
  if (!resolved) return NONE;
  const stat = statSync(resolved.file, { throwIfNoEntry: false });
  const key = JSON.stringify([resolved.file, stat?.mtimeMs, stat?.size, profile.args]);
  let found = features.get(key);
  if (!found) {
    const dir = join(tmpdir(), "omem-doubao");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}.stdin`);
    writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    const fd = openSync(file, "r");
    try {
      const r = spawnSync(resolved.file, [...resolved.prefix, ...profile.args, "--help"], { stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 5000, windowsHide: true, cwd: tmpdir() });
      found = r.status === 0 ? doubaoFeaturesFromHelp(`${r.stdout}\n${r.stderr}`) : NONE;
    } finally { closeSync(fd); rmSync(file, { force: true }); }
    if (features.size >= 64) features.clear();
    // A failed check is not cached for good: the next turn asks again.
    if (found !== NONE) features.set(key, found);
  }
  return found;
}

/**
 * The profile as an ACP agent (`doubao acp serve`); same id, account and settings. The CLI takes only
 * a terminal, pipe or regular file as stdin, and Node's stdio pipes are sockets on Linux and macOS:
 * there `cat` hands it the messages through a real pipe (the process group is stopped as one).
 */
export function doubaoAcpProfile(profile: AgentProfile, platform = process.platform): AgentProfile {
  const args = [...profile.args, "acp", "serve"], exe = doubaoExecutable(profile);
  if (platform === "win32") return { ...profile, transport: "acp", command: exe, args };
  return { ...profile, transport: "acp", command: "/bin/sh", args: ["-c", 'cat | "$0" "$@"', exe, ...args] };
}

/** A session id from `-p` (the conversation number) as ACP names it, so a thread started before the update resumes. */
export function doubaoAcpSessionId(id: string) {
  return /^\d+$/.test(id) ? `conversation-${id}` : id;
}

export function doubaoCommand(profile: AgentProfile, req: AgentRequest, prompt: string, cwdOption: CwdOption | null = null) {
  const args = [...profile.args];
  // Native directory options must precede the CLI frontend (including --resume and -p).
  if (cwdOption) args.push(cwdOption, req.cwd);
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  args.push("-p", prompt);
  if (profile.model) args.push("--model", profile.model);
  if (profile.effort) args.push("--effort", profile.effort);
  // It has no read-only mode; outside coding it asks before risky operations (no one answers, so they fail).
  const permission = req.doubaoPermission ?? "ask_risky";
  args.push("--permission-mode", permission);
  return { args, permission };
}

export async function runDoubaoCli(profile: AgentProfile, req: AgentRequest, emit: (e: AgentEvent) => void): Promise<AgentResult> {
  const exe = doubaoExecutable(profile);
  const direct = exe !== profile.command || process.platform !== "win32";
  let file: string | undefined;
  let prompt = req.prompt;
  const account = accountOf(profile);
  const dir = account ? join(account.home, ".omem-prompts") : join(tmpdir(), "omem-doubao");
  let toolsDir: string | undefined;
  try {
    if (req.mcp?.token && req.mcp.baseUrl) {
      mkdirSync(dir, { recursive: true });
      toolsDir = mkdtempSync(join(dir, "tools-"));
      const bound = boundToolCommand(toolsDir, { ...req.mcp.env, OMEM_URL: req.mcp.baseUrl, OMEM_TOKEN: req.mcp.token });
      prompt += `\n\n【本轮 omem 命令】\n${bound.command}\n本轮所有 omem 工具都用上面这个命令加上 tool 和参数（例如：上面的命令 tool help）。它已绑定本轮权限；说明里的 omem tool 都指这个入口。不要沿用前轮入口。`;
    }
    if (!direct || prompt.length > INLINE_MAX) {
      // In a user's sandbox /tmp is its own: the file goes in their account folder, which it sees.
      mkdirSync(dir, { recursive: true });
      file = join(dir, `${randomUUID()}.md`);
      writeFileSync(file, prompt, { mode: 0o600 });
      prompt = `先完整读取文件 ${file}（UTF-8），那是这一轮的完整内容，按它执行并回答；回答里不要提这个文件。`;
    }
    // -p still reads non-terminal stdin as context, so give the native bridge a readable empty file.
    const box = req.ownSandbox;
    const extra = [file, toolsDir].filter((path): path is string => !!path && !box?.hidden.some(hidden => under(path, hidden)));
    const ownSandbox = box ? { ...box, plan: { ...box.plan, ro: [...box.plan.ro, ...extra] } } : box;
    const { args, permission } = doubaoCommand(profile, req, prompt, doubaoFeatures(profile).cwdOption);
    const child = await (await import("./egress-run.ts")).launchRun(profile, { ...req, ownSandbox }, (sandbox, box) => emptyStdin(stdin => launch(exe, args, { cwd: req.cwd, workspace: req.workspace, ownSandbox: box, env: { ...profile.env, ...req.mcp?.env, ...req.env }, stdin, sandbox })));
    emit({ type: "status", text: aiUsageText(profile, permission === "always_allow" ? "完全访问" : "风险审批", req.selection) });
    emit({ type: "status", text: "豆包 CLI 在本机执行，整轮结束后才输出回复；过程里只看得到它调用的 omem 工具" });
    if (req.runId) shellToolRuns.add(req.runId);
    let stdout = "";
    let stderr = "";
    let sessionId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const watchdog = idleWatchdog(idleTimeoutFor(profile), () => {
          stop(child);
          reject(new Error("豆包 CLI 长时间没有结果，已停止"));
        });
        // -p prints only when the turn ends: a long build or test run is not silence while its processes use CPU.
        const stopBusy = touchWhileBusy(child.pid, watchdog);
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
          watchdog.close(); stopBusy();
          reject(e);
        });
        child.once("close", (code) => {
          watchdog.close(); stopBusy();
          req.signal?.removeEventListener("abort", onAbort);
          if (code !== 0) reject(sandboxStartError(account, stderr) ?? new Error(`豆包 CLI 退出码 ${code}：${errorText(stdout, stderr)}`));
          else resolve();
        });
      });
    } finally { if (req.runId) shellToolRuns.delete(req.runId); }
    const text = stdout.trim();
    if (text) emit({ type: "text", text });
    return { text, stopReason: "end_turn", agent: "doubao", sessionId };
  } finally {
    if (file) rmSync(file, { force: true });
    if (toolsDir) rmSync(toolsDir, { recursive: true, force: true });
  }
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

/**
 * The CLIs on a machine share one background service, which shuts down a moment after the last one exits:
 * a command started in that moment fails at once with `service_unavailable` and works when started again.
 */
export const DOUBAO_SERVICE_BUSY = /service_unavailable:/;
async function check(exe: string, args: string[], account?: ReturnType<typeof accountOf>, timeoutMs = 60_000, env?: Record<string, string>): Promise<{ code: number | null; out: string }> {
  for (let attempt = 1; ; attempt++) {
    const r = await checkOnce(exe, args, account, timeoutMs, env);
    if (r.code === 0 || attempt >= 4 || !DOUBAO_SERVICE_BUSY.test(r.out)) return r;
    await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
  }
}

/** Runs `start` again while the shared service is shutting down (nothing was done yet when it says so). */
export async function doubaoRetry<T>(start: () => Promise<T>, signal?: AbortSignal, onRetry?: () => void): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await start(); }
    catch (e) {
      if (attempt >= 4 || signal?.aborted || !DOUBAO_SERVICE_BUSY.test((e as Error).message)) throw e;
      onRetry?.();
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
}

/** One short invocation that fails during argument checks; returns what it printed. */
function checkOnce(exe: string, args: string[], account?: ReturnType<typeof accountOf>, timeoutMs = 60_000, env?: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const r = resolveCommand(exe);
  if (!r) return Promise.resolve({ code: null, out: `找不到命令 ${exe}` });
  return new Promise((resolve) => {
    // A user's own account: in their sandbox, from their account folder.
    let child: ReturnType<typeof spawn>;
    try {
      child = emptyStdin(stdin => account ? launch(exe, args, { cwd: account.home, stdin, sandbox: account, env }) : spawn(r.file, [...r.prefix, ...args], { stdio: [stdin, "pipe", "pipe"], windowsHide: true, cwd: tmpdir(), ...(env && { env: { ...process.env, ...env } }) }));
    } catch (e) {
      return resolve({ code: null, out: (e as Error).message });
    }
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d));
    child.stderr?.on("data", (d: Buffer) => (out += d));
    const timer = setTimeout(() => stop(child as never), timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); resolve({ code: null, out: e.message }); });
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
  const account = accountOf(profile);
  // Newer CLIs list them: names (what `--model` takes and the ACP model option shows) and each one's levels.
  const listed = doubaoFeatures(profile).modelList ? modelList((await check(exe, [...profile.args, "model", "list", "--json"], account)).out) : null;
  if (listed) return listed;
  const base = [...profile.args, "--resume", "1", "-p", "x"];
  const first = await check(exe, [...base, "--model", "__omem_probe__"], account);
  const models = listAfter(first.out, "Available models");
  if (!models?.length) throw new Error(errorText(first.out, "") || "豆包 CLI 没有报出模型列表（先运行 doubao login）");
  const effortsByModel: Record<string, string[]> = {};
  await Promise.all(
    models.map(async (m) => {
      for (const level of ["none", "max"]) {
        const r = await check(exe, [...base, "--model", m, "--effort", level], account);
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

/** `doubao model list --json`: one result line among log lines; null when this CLI has no such command. */
export function modelList(out: string): { models: string[]; effortsByModel: Record<string, string[]> } | null {
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const models = JSON.parse(line)?.result?.models;
      if (!Array.isArray(models) || !models.length) continue;
      const named = models.filter((m): m is { name: string; efforts?: unknown } => typeof m?.name === "string" && !!m.name);
      return {
        models: named.map(m => m.name),
        effortsByModel: Object.fromEntries(named.map(m => [m.name, Array.isArray(m.efforts) ? m.efforts.filter((e): e is string => typeof e === "string") : []])),
      };
    } catch {}
  }
  return null;
}

/**
 * Delete one of omem's conversations with the CLI (`doubao delete <会话编号> --yes`), under the account that
 * made it. `-p` reports the conversation number; an ACP session id is matched to it by the session's
 * folder, title and last update in `session/list` and `doubao --list` (ACP has no delete and no number).
 * A conversation that is gone, or a session that never got one, is done.
 */
export async function deleteDoubaoCliSession(profile: AgentProfile, sessionId: string, cwd: string, signal?: AbortSignal) {
  const conversation = /^\d+$/.test(sessionId) ? sessionId : /^conversation-(\d+)$/.exec(sessionId)?.[1] ?? await conversationOf(profile, sessionId, cwd, signal);
  if (!conversation) return;
  if (signal?.aborted) throw new Error("CANCELLED");
  const r = await check(doubaoExecutable(profile), [...profile.args, "delete", conversation, "--yes"], accountOf(profile), 60_000, profile.env);
  if (r.code === 0 || /^not_found:/m.test(r.out)) return;
  throw new Error(`豆包 CLI 删除会话失败：${errorText(r.out, "")}`);
}

async function conversationOf(profile: AgentProfile, sessionId: string, cwd: string, signal?: AbortSignal): Promise<string | null> {
  const { findAcpSession } = await import("./acp.ts");
  const session = await doubaoRetry(() => findAcpSession(doubaoAcpProfile(profile), sessionId, cwd, signal), signal);
  if (!session) return null;
  const at = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
  if (!session.title || Number.isNaN(at)) throw new Error("豆包没有给出这个会话的标题和更新时间，认不出它的会话编号");
  const r = await check(doubaoExecutable(profile), [...profile.args, "--list", "--limit", "200", "--json"], accountOf(profile), 60_000, profile.env);
  const hits = listedSessions(r.out).filter(s => s.title === session.title && Date.parse(s.updated_at ?? "") === at && (!s.cwd || !session.cwd || s.cwd === session.cwd));
  if (hits.length === 1) return hits[0].session_id;
  throw new Error(hits.length ? "豆包会话列表里有几条同名同时间的会话，认不出是哪一条" : `豆包会话列表里还找不到这个会话${r.code === 0 ? "" : `：${errorText(r.out, "")}`}`);
}

function listedSessions(out: string): { session_id: string; title?: string; updated_at?: string; cwd?: string }[] {
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const sessions = JSON.parse(line)?.result?.sessions;
      if (Array.isArray(sessions)) return sessions.filter(s => typeof s?.session_id === "string");
    } catch {}
  }
  return [];
}
