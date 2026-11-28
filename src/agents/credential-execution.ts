import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { audit } from "../auth/permissions.ts";
import type { App } from "../core/app.ts";
import { activeUser, findUser, OWNER, userName } from "../core/users.ts";
import { COMMAND_OUTPUT_LIMIT, COMMAND_TIMEOUT_SEC } from "../core/util.ts";
import { catalogProfile } from "./catalog.ts";
import { localAccount } from "./accounts.ts";
import { commandLine, gatePaths } from "./command-gate.ts";
import { confirmCredential } from "./credential-confirm.ts";
import { recentApplicationUrl, applicationUrl, checkAccess, knownAccess, sharedHolders } from "./credential-access.ts";
import { commandResource, credentialArgs, credentialCommand, credentialOutcome } from "./credential-outcome.ts";
import { credentialMethods } from "./credential-registry.ts";
import { availableLogin, credentialHold, credentialMemberEnv, credentialRefreshPending, inviteCredential, usableCredential } from "./credentials.ts";
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

type Ran = { execution: Execution; output: string; aborted: boolean };

/**
 * Run one declared read-only command with `holder`'s login (the owner's machine login, or a member's
 * account directory) in a throwaway directory. "unavailable": this machine cannot run it as that
 * holder (no sandbox); undefined: starting it failed.
 */
async function runWith(ctx: ToolContext & { runId: string }, entry: Entry, args: string[], holder: string, eligible: () => boolean,
  runSignal: AbortSignal, event?: { reason: string; text: string; audited?: string }): Promise<Ran | "unavailable" | undefined> {
  const { app, runId } = ctx, { method, command } = entry, owner = holder === OWNER;
  if (!owner && !sandboxSupport().ok) return "unavailable";
  const cwd = mkdtempSync(join(tmpdir(), "omem-credential-"));
  try {
    const account = owner ? undefined : { ...localAccount(app, holder, method.kind), masked: [], env: credentialMemberEnv(app, holder, method),
      borrowed: { state: command.state ?? [], dirs: [] } };
    const profile = { ...catalogProfile({ id: method.kind, name: method.name, command: command.name }), ownAccount: account };
    const ownBox = owner && app.config.agents.ownSandbox.mode !== "off" ? ownRun(app, profile, cwd, false, undefined, { kind: null, credentialState: command.state }).box : undefined;
    if (owner && app.config.agents.ownSandbox.mode !== "off" && !ownBox) return "unavailable";
    const op = { kind: "command" as const, executable: command.name, argv: args, cwd };
    const signal = AbortSignal.any([runSignal, method.signal, AbortSignal.timeout(COMMAND_TIMEOUT_SEC * 1000)]);
    const child = await launchRun(profile, { app, runId, source: "executor", context: ctx, signal, ownSandbox: ownBox }, (sandbox, ownSandbox) => {
      if (!eligible()) throw new Error("出借设置或运行已变化");
      const rule = decide(app, op, { ...operationWho(ctx), member: holder });
      if (rule.action !== "allow" && rule.action !== "log") throw new Error("持有人的命令规则需要另行放行");
      if (event) {
        const detail = { runId, holder, command: command.name, argsHash: digest(args), resource: commandResource(command, args) ?? null, reason: event.reason };
        if (event.audited) audit(app, ctx.userId ?? OWNER, event.audited, method.kind, detail);
        addRunEvent(app, runId, "status", { ...detail, text: event.text });
      }
      return launch(command.name, args, { cwd, sandbox, ownSandbox, baseEnv: commandEnv(owner, gatePaths(app.home).guarded), directOnly: true, stdin: "ignore" });
    });
    const { execution, output } = await collect(child, signal);
    return { execution, output, aborted: signal.aborted };
  } catch {
    return;
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

/**
 * Settings → 安全 → 本人的登录兜底: a member's read-only command uses the member's own login first;
 * when that gives nothing usable (no login, expired, no permission) the member is asked to authorize
 * and the owner's login answers this command now, without waiting for them.
 */
export function ownerFallback(app: App, ctx: ToolContext) {
  const requester = ctx.userId ?? OWNER;
  return app.config.credentials.ownerFallback && app.config.credentials.lending === "auto" && requester !== OWNER &&
    ctx.actor === "agent" && !!ctx.runId && !ctx.shadow && !ctx.boardAccess && !ctx.view && ctx.role !== "guest" &&
    (ctx.commandHomeUser === requester || ctx.commandHomeUser === OWNER);
}

const REASON_TEXT = { none: "没有可用的", unauthenticated: "没登录", expired: "登录过期了", denied: "没有这个资源的权限" } as const;

async function fallbackExecution(ctx: ToolContext & { runId: string }, entry: Entry, args: string[], display: string, live: () => boolean, runSignal: AbortSignal) {
  const { app, runId } = ctx, requester = ctx.userId ?? OWNER, { method, command } = entry, { kind } = method;
  // In a run that borrows the owner's HOME the command would otherwise just run with the owner's login.
  const isolated = ctx.commandHomeUser === requester;
  const eligible = () => live() && !method.signal.aborted && activeUser(findUser(app, requester)) && ownerFallback(app, ctx);
  const name = userName(app, requester);
  let last: Execution | undefined, reason: keyof typeof REASON_TEXT = "none", applyUrl: string | null = null;
  if (usableCredential(app, requester, kind)) {
    const own = await runWith(ctx, entry, args, requester, eligible, runSignal,
      { reason: "发起人自己的登录", text: `使用${name}自己的${method.name}运行 ${display}。` });
    if (own && own !== "unavailable") {
      last = own.execution;
      if (own.aborted || !eligible()) return { execution: last };
      const result: { reason?: "unauthenticated" | "expired" | "denied" | "failed"; applyUrl?: string | null } =
        await credentialOutcome(app, requester, runId, { command: command.name, args, code: last.code, output: own.output }, false);
      if (last.code === 0 || !result.reason || result.reason === "failed") return { execution: last };
      reason = result.reason;
      applyUrl = result.applyUrl ?? null;
    } else if (isolated) return { notice: `无法用${name}自己的${method.name}运行这条命令` };
    // Not isolated and his login cannot be started here: the owner's login below still answers.
  }
  const hold = credentialHold(app, OWNER, kind);
  const lends = hold.sharing.scope === "all" || hold.sharing.scope === "members" && hold.sharing.members.includes(requester);
  const usable = lends && availableLogin(app, OWNER, kind, hold) &&
    app.config.agents.accountIsolation !== "require" && app.config.security.egress.mode !== "all-sandboxed";
  const refreshing = reason !== "denied" && credentialRefreshPending(requester, method, credentialHold(app, requester, kind));
  if (!refreshing) inviteCredential(app, requester, method, reason, { command: display, applyUrl, covered: usable });
  const asked = refreshing ? "omem 正在自动续签" : reason === "denied" ? (applyUrl ? "已把申请链接发给他" : "") : `已提醒他授权${method.name}`;
  if (!usable || !eligible()) {
    return { execution: last, notice: `${name}${REASON_TEXT[reason]}${method.name}${reason === "none" ? "登录" : ""}${asked ? "，" + asked : ""}。` };
  }
  const text = `${name}${REASON_TEXT[reason]}${method.name}${reason === "none" ? "登录" : ""}${asked ? "，" + asked : ""}；这次用${userName(app, OWNER)}的${method.name}运行 ${display}。`;
  if (!isolated) {
    // The command runs right after this answer, in the owner's environment this run already has.
    const detail = { runId, holder: OWNER, command: command.name, argsHash: digest(args), resource: commandResource(command, args) ?? null, reason: "发起人的登录查不到，用本人的登录兜底" };
    audit(app, requester, "credentials.command", kind, detail);
    addRunEvent(app, runId, "status", { ...detail, text });
    return { notice: text };
  }
  const ran = await runWith(ctx, entry, args, OWNER, eligible, runSignal, { reason: "发起人的登录查不到，用本人的登录兜底", text, audited: "credentials.command" });
  if (!ran || ran === "unavailable") return { execution: last, notice: `无法在${userName(app, OWNER)}的环境中执行此命令` };
  if (!ran.aborted) await credentialOutcome(app, OWNER, runId, { command: command.name, args, code: ran.execution.code, output: ran.output });
  return { execution: ran.execution, notice: text };
}

/**
 * A rule's run that switched to a member who agreed (rules/run-as.ts, act_as): a declared command runs
 * on that member's login in their account sandbox, whatever it does — they agreed to this rule using
 * their identity. Never falls back to the owner's login: without theirs it is refused and they are asked
 * to log in (the run goes on once they do, credential-wait.ts).
 */
export async function memberExecution(ctx: ToolContext & { runId: string }, entry: Entry, args: string[], member: string, ruleId: string,
  live: () => boolean, runSignal: AbortSignal, stillConsented: () => boolean) {
  const { app, runId } = ctx, { method, command } = entry, name = userName(app, member);
  const display = [command.name, ...args.filter((x) => !x.startsWith("-")).slice(0, 2)].join(" ");
  if (!sandboxSupport().ok) return { decision: "deny" as const, message: `这台机器不能在${name}的账号环境里运行命令（需要沙箱），这次跳过他` };
  if (!usableCredential(app, member, method.kind)) {
    if (credentialRefreshPending(member, method, credentialHold(app, member, method.kind)))
      return { decision: "deny" as const, message: `${name}的${method.name}正在自动续签；这次跳过他` };
    inviteCredential(app, member, method, "none", { command: display, applyUrl: null, covered: false });
    return { decision: "deny" as const, message: `${name}没有可用的${method.name}登录，已提醒他授权；这次跳过他` };
  }
  const eligible = () => live() && !method.signal.aborted && activeUser(findUser(app, member)) && stillConsented();
  const ran = await runWith(ctx, entry, args, member, eligible, runSignal,
    { reason: `规则以${name}的身份运行（他已同意）`, text: `以${name}的${method.name}运行 ${display}。`, audited: "credentials.command" });
  if (!ran || ran === "unavailable") return { decision: "deny" as const, message: `无法在${name}的环境中执行这条命令` };
  let notice: string | undefined;
  if (!ran.aborted) {
    const result = await credentialOutcome(app, member, runId, { command: command.name, args, code: ran.execution.code, output: ran.output }, true, true);
    notice = (result as { notice?: string }).notice;
  }
  audit(app, member, "rule.run-as.command", ruleId, { runId, command: command.name, argsHash: digest(args) });
  return { decision: "allow" as const, execution: ran.execution, notice };
}

/** Called only after the command gate allows the original argv in this run. Never called from an outcome report. */
export async function credentialExecution(ctx: ToolContext, entry: Entry, args: string[], live: () => boolean, runSignal: AbortSignal) {
  const { app, runId } = ctx, requester = ctx.userId ?? OWNER;
  const { method, command } = entry, { kind } = method;
  if (!runId || !live() || !activeUser(findUser(app, requester))) return;
  const parsed = credentialArgs(args);
  const readOnly = command.readOnly?.find(parsed.matches);
  if (!readOnly) return;
  const display = [command.name, ...(readOnly.subcommand ?? [])].join(" ");
  if (ownerFallback(app, ctx)) return fallbackExecution({ ...ctx, runId }, entry, args, display, live, runSignal);
  if (ctx.commandHomeUser !== requester || usableCredential(app, requester, kind)) return;
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
    const reason = "发起人缺少有效登录，资源服务已确认读取权";
    const ran = await runWith({ ...ctx, runId }, entry, args, holder.id, eligible, runSignal,
      { reason, text: `使用${holder.name}的${method.name}运行 ${display} 读取 ${resource}。原因是${reason}。`, audited: "credentials.command" });
    if (ran === "unavailable") continue;
    if (!ran) return { execution: last, notice: "无法在出借人的环境中执行此命令" };
    last = ran.execution;
    if (ran.aborted) break;
    const result = await credentialOutcome(app, holder.id, runId, { command: command.name, args, code: last.code, output: ran.output });
    if (!("reason" in result) || result.reason === "failed") break;
  }
  return { execution: last };
}

/**
 * For a member's run with local tools: whose login the declared commands use is omem's call, so the
 * agent runs them as they are instead of switching profiles or starting a login for the member itself.
 */
export function commandLoginNote(app: App, userId: string) {
  if (userId === OWNER) {
    const startable = credentialMethods().filter(m => m.ownerLogin).flatMap(m => m.provides.commands.map(c => c.name));
    if (!startable.length) return "";
    return `- 命令行登录：${[...new Set(startable)].join("、")} 报没登录或登录过期时，omem 自己发起官方登录、把链接发给${userName(app, OWNER)}，授权后这段对话会自动接着做（输出里以 [omem] 开头的行会说明）。不要自己发起这些命令的登录，也不要为等授权设唤醒或轮询\n`;
  }
  const names = [...new Set(credentialMethods().flatMap(m => m.provides.commands.filter(c => c.readOnly?.length).map(c => c.name)))];
  if (!names.length) return "";
  const who = userName(app, userId), owner = userName(app, OWNER);
  const fallback = app.config.credentials.ownerFallback && app.config.credentials.lending === "auto"
    ? `${who}自己的登录查不到（没登录、过期、没权限）时，omem 会提醒他授权，并在同一条命令里改用${owner}的登录接着查`
    : `${who}自己没有可用登录时，omem 按出借设置决定能不能借别人的`;
  return `- 命令行登录：${names.join("、")} 用谁的登录由 omem 决定，直接运行即可；不要自己换 profile、配置文件或令牌，不要自己发起这些命令的登录，也不要为此让${who}去授权。${fallback}；输出里以 [omem] 开头的行会说明这次用了谁的登录、为什么\n`;
}
