// An approval is consumed by a single streaming connection. Only host-selected programs,
// mounts and environment reach the child. The client supplies stdin, argv and a working directory.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { audit } from "../auth/permissions.ts";
import { activeUser, findUser, OWNER } from "../core/users.ts";
import { COMMAND_TIMEOUT_SEC } from "../core/util.ts";
import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { accountHome, accountStatePaths } from "./accounts.ts";
import { credentialCommand } from "./credential-outcome.ts";
import { credentialMethods, declaredPaths } from "./credential-registry.ts";
import { launchRun } from "./egress-run.ts";
import { canonical, gitLoginPaths, standardCommandLogins, under, type OwnSandbox } from "./own-sandbox.ts";
import { currentRules } from "./operation-policy.ts";
import { addRunEvent } from "./runs.ts";
import { withPinnedBinds } from "./bwrap-spawn.ts";
import { bwrapArgs, sandboxSupport, type WorkspaceMounts } from "./sandbox.ts";
import { remoteGit } from "./git-command.ts";
import { stop } from "./spawn.ts";
import { onToolTokenRevoked, toolContextForToken, type ToolContext } from "./tools.ts";
import { actingAs } from "../rules/run-as.ts";

export type CommandSandbox = { profile: AgentProfile; workspace: WorkspaceMounts; own?: OwnSandbox };
type Call = { command: string; args: string[]; cwd: string };

function program(name: string, writable: string[]) {
  if (basename(name) !== name || !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]*$/.test(name)) throw new Error("需要命令名");
  for (const dir of (process.env.PATH ?? "").split(":").filter(isAbsolute)) {
    if (writable.some(path => under(canonical(dir), path)) || dir.endsWith("/guarded")) continue;
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); return { real: realpathSync(file), path: join(canonical(dir), name) }; } catch { /* next install */ }
  }
  throw new Error("宿主没有安装命令 " + name);
}

function executorMounts(app: App, user: string, scope: CommandSandbox, call: Call, entry: ReturnType<typeof credentialCommand>, git: boolean) {
  if (!isAbsolute(call.cwd)) throw new Error("工作目录必须是绝对路径");
  // cwd is interpreted INSIDE the new namespace. It never authorizes a host bind mount.
  const home = canonical(user === OWNER ? homedir() : accountHome(app, user));
  const ro = [...scope.workspace.ro], rw = [...scope.workspace.rw];
  const workspacePaths = [...ro, ...rw];
  if (workspacePaths.some(path => canonical(path) !== path)) throw new Error("工作区挂载已改变");
  const writable = scope.own?.plan.rw ?? [...rw, home];
  const executable = program(call.command, writable);
  const file = executable.real;
  if (writable.some(path => under(file, path))) throw new Error("执行器程序位于 Agent 可写目录");
  const runtime = dirname(dirname(process.execPath));
  if (writable.some(dir => under(runtime, dir) || under(dir, runtime))) throw new Error("执行器运行库位于 Agent 可写目录");
  ro.push(runtime, file);
  const dependencies = file.indexOf("/node_modules/");
  if (dependencies > 0) {
    const modules = file.slice(0, dependencies) + "/node_modules";
    if (writable.some(dir => under(dir, modules) || under(modules, dir))) throw new Error("命令依赖与 Agent 可写目录重叠");
    ro.push(modules);
  }
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"), LANG: process.env.LANG ?? "C", TMPDIR: "/tmp/.omem-executor-tmp" };
  const granted = new Set<string>();
  if (entry) {
    if (user !== OWNER) accountStatePaths(app, user, entry.command.state ?? []);
    const declared = declaredPaths(app, { provides: { backends: [], commands: [entry.command] } });
    if (declared.install.some(p => writable.some(dir => under(p.path, dir) || under(dir, p.path))))
      throw new Error("命令安装目录与 Agent 可写目录重叠");
    ro.push(...declared.install.map(p => p.path));
    const bins = (process.env.PATH ?? "").split(":").filter(dir => isAbsolute(dir) && declared.install.some(p => under(canonical(dir), p.path)));
    env.PATH = [env.PATH, ...bins.map(canonical)].join(":");
    for (const rel of entry.command.state ?? []) {
      const path = join(home, rel);
      if (canonical(path) !== path) throw new Error("命令状态目录含有符号链接");
      if (existsSync(path)) { rw.push(path); granted.add(path); }
    }
  }
  const standard = standardCommandLogins.get(call.command) ?? [];
  for (const rel of git ? gitLoginPaths : standard) {
    const path = join(home, rel);
    if (!granted.has(path) && existsSync(path) && canonical(path) === path) {
      // Cloud CLIs renew sessions within their own declared configuration directories.
      (git || rel === ".ssh" ? ro : rw).push(path);
      granted.add(path);
    }
  }
  if ((git || standard.includes(".ssh")) && user === OWNER && process.env.SSH_AUTH_SOCK && existsSync(process.env.SSH_AUTH_SOCK)) {
    env.SSH_AUTH_SOCK = canonical(process.env.SSH_AUTH_SOCK);
    ro.push(env.SSH_AUTH_SOCK); granted.add(env.SSH_AUTH_SOCK);
  }
  if (git) env.GIT_TERMINAL_PROMPT = "0";
  // The root is empty outside the explicit mounts. A login's parent need not be masked
  // if the only visible directory inside it is the selected login itself.
  const masked = [...(scope.own?.hidden ?? []), ...(scope.own?.masked ?? []).filter(path =>
    !granted.has(path) && [...ro, ...rw].some(root => under(path, root)))];
  const links = [...(scope.workspace.links ?? [])];
  if (user === OWNER && home !== homedir() && !links.some(link => link.path === homedir()))
    links.push({ path: homedir(), target: home });
  if (executable.path !== file && ![...ro, "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].some(root => under(executable.path, root)))
    links.push({ path: executable.path, target: file });
  return { home, ro, rw, file: executable.path, env, masked, links };
}

type Pending = { token: string; start(input: IncomingMessage, output: ServerResponse): Promise<void> };
const pending = new Map<string, Pending>();

export function executionPermit(ctx: ToolContext, token: string, call: Call) {
  const scope = ctx.commandSandbox;
  if (!scope) return;
  const { app, runId } = ctx;
  const entry = credentialCommand(call.command, call.args);
  const git = call.command === "git" && remoteGit(call.args);
  const declared = credentialMethods().some(method => method.provides.commands.some(c => c.name === call.command));
  const standard = standardCommandLogins.has(call.command);
  if (!declared && !standard && !git && !currentRules(app).some(r => r.enabled && r.match.kind === "command" && r.match.executable === call.command)) return;
  const user = ctx.userId ?? OWNER;
  if ((entry || standard || git) && (ctx.actor !== "agent" || ctx.commandHomeUser !== user || ctx.shadow || ctx.view || ctx.boardAccess || ctx.role === "guest"))
    throw new Error("本轮没有使用这份命令凭据的权限");
  const rules = app.config.security.operationRules, legacy = app.config.security.commandRules;
  const turn = ctx.commandTurn;
  const id = randomUUID();
  if (pending.size >= 512) throw new Error("待执行命令已满，请稍后再试");
  const dispose = () => { pending.delete(id); clearTimeout(timer); unsubscribe(); };
  const timer = setTimeout(dispose, 15_000).unref();
  const unsubscribe = onToolTokenRevoked(token, dispose);
  pending.set(id, { token, async start(input, output) {
    dispose();
    const live = toolContextForToken(app, token);
    if (!live || (user !== OWNER && !activeUser(findUser(app, user))) || live.runId !== runId || live.commandTurn !== turn || live.commandSandbox !== scope ||
        app.config.security.operationRules !== rules || app.config.security.commandRules !== legacy ||
        entry?.method.signal.aborted || (runId && actingAs(runId))) throw new Error("运行、身份或规则已变化，请重新执行");
    const { home, ro, rw, file, env, masked, links } = executorMounts(app, user, scope, call, entry, git);
    // The relay and its runtime are read-only. Do not mount the service checkout in the executor.
    const controller = new AbortController();
    const cancel = () => controller.abort();
    output.once("close", cancel);
    const revoke = onToolTokenRevoked(token, cancel);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(COMMAND_TIMEOUT_SEC * 1000), ...(entry ? [entry.method.signal] : [])]);
    try {
      const support = sandboxSupport();
      if (!support.ok || !support.bwrap) throw new Error("命令执行器需要 Linux 沙箱");
      audit(app, user, "command.execute", call.command, { runId, argv: call.args, cwd: call.cwd });
      const child = await launchRun(scope.profile, { app, ownSandbox: scope.own, runId, context: ctx, signal }, (account, own) => {
        signal.throwIfAborted();
        const network = own?.network ?? account?.network;
        if (network) ro.push(realpathSync(new URL(import.meta.url.endsWith(".ts") ? "./egress-relay.ts" : "./egress-relay.js", import.meta.url)));
        const argv = bwrapArgs({ ...scope.workspace, links, minimalRoot: true, network, privateDirs: [home], hide: [canonical(app.home), "/tmp/.omem-executor-tmp"],
          masked, ro, rw, cwd: call.cwd, command: file, args: call.args });
        return withPinnedBinds(argv, undefined, (args, fds) => spawn(support.bwrap!, args,
          { env, cwd: "/", stdio: ["pipe", "pipe", "pipe", ...fds], detached: true }) as ChildProcessWithoutNullStreams);
      });
      const abort = () => stop(child);
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted || output.destroyed) abort();
        const exited = once(child, "close");
        output.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        output.flushHeaders();
        child.stdin.on("error", () => input.unpipe(child.stdin));
        input.pipe(child.stdin);
        async function forward(stream: NodeJS.ReadableStream, fd: number) {
          for await (const chunk of stream) {
            if (!output.write(JSON.stringify([fd, Buffer.from(chunk).toString("base64")]) + "\n"))
              await once(output, "drain", { signal });
          }
        }
        const [[code]] = await Promise.all([exited, forward(child.stdout, 1), forward(child.stderr, 2)]);
        output.end(JSON.stringify([0, code ?? 1]) + "\n");
        if (runId) addRunEvent(app, runId, "status", { text: "沙箱命令执行结束：" + call.command, exitCode: code, cwd: call.cwd });
      } finally { abort(); signal.removeEventListener("abort", abort); input.unpipe(child.stdin); }
    } finally { revoke(); output.off("close", cancel); }
  } });
  return id;
}

export function pendingExecution(token: string, id: string) {
  const permit = pending.get(id);
  return permit?.token === token ? permit.start : undefined;
}
