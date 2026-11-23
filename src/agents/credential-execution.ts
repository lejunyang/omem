import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { audit } from "../auth/permissions.ts";
import { activeUser, findUser, OWNER } from "../core/users.ts";
import { COMMAND_OUTPUT_LIMIT, COMMAND_TIMEOUT_SEC } from "../core/util.ts";
import { catalogProfile } from "./catalog.ts";
import { localAccount } from "./accounts.ts";
import { commandLine, gatePaths } from "./command-gate.ts";
import { confirmCredential } from "./credential-confirm.ts";
import { recentApplicationUrl, applicationUrl, checkAccess, knownAccess, sharedHolders } from "./credential-access.ts";
import { commandResource, credentialArgs, credentialCommand, credentialOutcome } from "./credential-outcome.ts";
import { availableLogin, credentialMemberEnv, usableCredential } from "./credentials.ts";
import { launchRun } from "./egress-run.ts";
import { decide, digest, operationWho } from "./operation-policy.ts";
import { ownRun } from "./own-run.ts";
import { addRunEvent } from "./runs.ts";
import { sandboxSupport } from "./sandbox.ts";
import { launch, stop } from "./spawn.ts";
import type { ToolContext } from "./tools.ts";

type Execution = { code: number; stdout: string; stderr: string };
type Entry = NonNullable<ReturnType<typeof credentialCommand>>;

// Binary streams stay separate on the wire. Keep only a bounded tail of each, including
// when the program writes a single large chunk.
async function collect(child: ChildProcess & Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">, signal: AbortSignal) {
  let output = "";
  function tail(stream: NodeJS.ReadableStream) {
    let bytes: Buffer = Buffer.alloc(0);
    const decoder = new StringDecoder("utf8");
    stream.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk.subarray(-COMMAND_OUTPUT_LIMIT)]).subarray(-COMMAND_OUTPUT_LIMIT);
      output = (output + decoder.write(chunk)).slice(-COMMAND_OUTPUT_LIMIT);
    });
    stream.once("end", () => { output = (output + decoder.end()).slice(-COMMAND_OUTPUT_LIMIT); });
    return () => bytes.toString("base64");
  }
  const stdout = tail(child.stdout), stderr = tail(child.stderr);
  const abort = () => stop(child);
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    const [code] = await once(child, "close");
    const execution: Execution = { code: signal.aborted ? 1 : code ?? 1, stdout: stdout(), stderr: stderr() };
    return { execution, output };
  } finally { signal.removeEventListener("abort", abort); }
}

const realDir = (p: string) => { try { return realpathSync(p); } catch { return p; } };

function commandEnv(owner: boolean, guarded: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATHEXT", "LANG", "LC_ALL", "TZ", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Never the command gate's wrappers (whatever path reaches them): the wrapper would ask omem again.
  const gates = new Set([guarded, process.env.OMEM_COMMAND_GATE].filter((p): p is string => !!p).map(realDir));
  env.PATH = (process.env.PATH ?? "").split(delimiter).filter(p => isAbsolute(p) && !gates.has(realDir(p))).join(delimiter);
  if (owner) {
    env.HOME = env.USERPROFILE = homedir();
    for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "APPDATA", "LOCALAPPDATA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

/** Called only after the command gate allows the original argv in this run. Never called from an outcome report. */
export async function credentialExecution(ctx: ToolContext, entry: Entry, args: string[], live: () => boolean, runSignal: AbortSignal) {
  const { app, runId } = ctx, requester = ctx.userId ?? OWNER;
  const { method, command } = entry, { kind } = method;
  if (!runId || ctx.commandHomeUser !== requester || !live() || !activeUser(findUser(app, requester)) || usableCredential(app, requester, kind)) return;
  const parsed = credentialArgs(args);
  const readOnly = command.readOnly?.find(parsed.matches);
  if (!readOnly) return;
  const display = [command.name, ...(readOnly.subcommand ?? [])].join(" ");
  const resource = commandResource(command, args, parsed);
  if (!resource || !method.precheck) return;
  const denied = knownAccess(app, kind, resource, requester);
  if (denied?.allowed === 0) return { notice: "没有这个资源的权限" + (denied.apply_url ? "，可前往 " + denied.apply_url : "") };
  if (app.config.credentials.lending === "off") return;
  const mode = app.config.credentials.lending;
  const candidates = () => sharedHolders(app, requester, kind, 2, resource, mode === "auto");
  const holders = candidates();
  let last: Execution | undefined;
  for (const holder of holders) {
    const eligible = () => live() && !method.signal.aborted && activeUser(findUser(app, requester)) &&
      app.config.credentials.lending === mode && !usableCredential(app, requester, kind) &&
      availableLogin(app, holder.id, kind) && candidates().some(u => u.id === holder.id && (u.shared || !holder.shared)) &&
      knownAccess(app, kind, resource, requester)?.allowed !== 0;
    if (!eligible()) continue;
    const owner = holder.id === OWNER;
    if (owner && (app.config.agents.accountIsolation === "require" || app.config.security.egress.mode === "all-sandboxed")) continue;
    if (!owner && !sandboxSupport().ok) continue;
    const permission = await checkAccess(app, requester, runId, method, holder.id, requester, resource, { name: command.name, args: [...args] });
    if (permission?.allowed !== true || permission.verifiedRead !== true) {
      const url = applicationUrl(permission?.applyUrl);
      return { execution: last, notice: url ? "可前往 " + url + " 申请权限" : undefined };
    }
    if (!eligible()) continue;
    if (mode === "confirm" || !holder.shared) {
      const consent = await confirmCredential(app, runId, requester, holder.id, kind, resource, commandLine(command.name, args),
        AbortSignal.any([runSignal, method.signal]));
      if (!consent) {
        const url = recentApplicationUrl(app, kind, resource);
        return { decision: "deny" as const, message: "持有人没同意" + (url ? "，可前往 " + url + " 申请权限" : "") };
      }
    }
    const cwd = mkdtempSync(join(tmpdir(), "omem-credential-"));
    try {
      const account = owner ? undefined : { ...localAccount(app, holder.id, kind), env: credentialMemberEnv(app, holder.id, method),
        borrowed: { state: command.state ?? [], dirs: [] } };
      const profile = { ...catalogProfile({ id: kind, name: method.name, command: command.name }), ownAccount: account };
      const ownBox = owner && app.config.agents.ownSandbox.mode !== "off" ? ownRun(app, profile, cwd, false).box : undefined;
      if (owner && app.config.agents.ownSandbox.mode !== "off" && !ownBox) continue;
      const op = { kind: "command" as const, executable: command.name, argv: args, cwd };
      const signal = AbortSignal.any([runSignal, method.signal, AbortSignal.timeout(COMMAND_TIMEOUT_SEC * 1000)]);
      const child = await launchRun(profile, { app, runId, context: ctx, signal }, sandbox => {
        if (!eligible()) throw new Error("出借设置或运行已变化");
        const lenderRule = decide(app, op, { ...operationWho(ctx), member: holder.id });
        if (lenderRule.action !== "allow" && lenderRule.action !== "log") throw new Error("出借人的命令规则需要另行放行");
        const detail = { runId, holder: holder.id, command: command.name, argsHash: digest(args), resource, reason: "发起人缺少有效登录，资源服务已确认读取权" };
        audit(app, requester, "credentials.command", kind, detail);
        addRunEvent(app, runId, "status", { ...detail, text: `使用${holder.name}的${method.name}运行 ${display} 读取 ${resource}。原因是${detail.reason}。` });
        return launch(command.name, args, { cwd, sandbox, ownSandbox: ownBox, baseEnv: commandEnv(owner, gatePaths(app.home).guarded), directOnly: true, stdin: "ignore" });
      });
      const { execution, output } = await collect(child, signal);
      last = execution;
      if (signal.aborted) break;
      const result = await credentialOutcome(app, holder.id, runId, { command: command.name, args, code: last.code, output });
      if (!("reason" in result) || result.reason === "failed") break;
    } catch {
      return { execution: last, notice: "无法在出借人的环境中执行此命令" };
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }
  return { execution: last };
}
