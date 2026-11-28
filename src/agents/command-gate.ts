/**
 * Command rules (docs/v2/command-gate.md): before an agent's process runs a protected command, a
 * wrapper of the same name in front of its PATH asks omem (`POST /api/command-gate`), which lets
 * it through, refuses it, or holds it for someone's approval on a card or the web page.
 *
 * Outside the Linux sandbox, interception relies on PATH. Sandboxed runs also cover installed
 * entry points with read-only mounts and use an authorized executor for credentialed commands.
 */
import { pathToFileURL } from "node:url";
import { standardCommandLogins } from "./own-sandbox.ts";
import { remoteGit } from "./git-command.ts";
import { credentialCommand } from "./credential-outcome.ts";
import { judgeCredential } from "./credentials.ts";
import { commandDeclarations, type CredentialCommand } from "./credential-registry.ts";
import { auditOperation, commandArgsMatch, currentRules, decide, digest, fingerprint, operationWho, saveOperationRules, type Operation } from "./operation-policy.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { App } from "../core/app.ts";
import type { CommandRule, OperationRule } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { COMMAND_OUTPUT_LIMIT, COMMAND_TIMEOUT_SEC, HttpError, now, truncate, webLink } from "../core/util.ts";
import { activeUser, findUser, listUsers, OWNER, userName } from "../core/users.ts";
import { audit } from "../auth/permissions.ts";
import { addRunEvent } from "./runs.ts";
import { cancelAsk, createAsk, getAsk, markAskSent, registerAskHandler, type Ask } from "./asks.ts";
import type { ToolContext } from "./tools.ts";
import { buildCard, cardText, closeInteraction, larkOwnerOpenId, recordInteraction, sendLark, updateLarkCard } from "../channels/lark-send.ts";

/** Exit code of a refused, held or unchecked command (“found but cannot be run”). */
export const GATE_EXIT = 126;
/** Wrappers nested deeper than this (a wrapper's command starting a wrapper again) are taken as a loop. */
const GATE_MAX_DEPTH = 8;
/** The same call (run, command, arguments) more often than this within a minute is taken as a loop. */
const GATE_BURST = 60;
const bursts = new Map<string, number[]>();

/**
 * Whether this call to the command gate repeats too fast to be anything but a process starting
 * itself again. A backstop behind the wrapper's own checks: each loop level is a process waiting
 * on omem, so an unchecked one fills the machine within minutes.
 */
export function gateBurst(key: string, at = Date.now()): false | "first" | "again" {
  const recent = (bursts.get(key) ?? []).filter(t => at - t < 60_000);
  recent.push(at);
  bursts.set(key, recent.slice(-(GATE_BURST + 1)));
  if (bursts.size > 2000) for (const [k, v] of bursts) if (!v.some(t => at - t < 60_000)) bursts.delete(k);
  return recent.length <= GATE_BURST ? false : recent.length === GATE_BURST + 1 ? "first" : "again";
}
const win = process.platform === "win32";

export function gatePaths(home: string) {
  const bin = join(home, "bin");
  return { bin, guarded: join(bin, "guarded"), script: join(bin, "command-gate.mjs") };
}

/** A command name as rules and wrappers compare it (Windows does not tell case apart). */
const norm = (name: string) => (win ? name.toLowerCase() : name);

/**
 * The wrappers for the current rules and credential declarations under <home>/bin/guarded (stale ones removed); returns that
 * directory, or null when neither supplies a command.
 */
export function syncCommandGate(home: string, rules: ({ command: string; args?: string } & Parameters<typeof commandArgsMatch>[0])[], sandbox = false, configured: CredentialCommand[] = []): string | null {
  const { guarded, script } = gatePaths(home);
  const declarations = commandDeclarations(configured);
  const declared = [...new Set(declarations.map(c => norm(c.name)))];
  const names = [...new Set([...(sandbox ? ["git", "aad", ...standardCommandLogins.keys()] : []), ...declared, ...rules.map(r => norm(r.command.trim())).filter(Boolean)])];
  if (!names.length) {
    if (existsSync(guarded)) rmSync(guarded, { recursive: true, force: true });
    return null;
  }
  try {
    mkdirSync(guarded, { recursive: true });
    const onlineOnly = new Set([...configured, ...declarations.filter(c => c.judge)].map(c => norm(c.name)));
    const offline = [...new Set([...declared, ...(sandbox ? ["git"] : [])])].filter(name => !onlineOnly.has(name)).map(name => [name, rules.filter(r => norm(r.command) === name).map(r => ({
      subcommand: r.subcommand, argv: r.argv, argsRegex: r.argsRegex ?? r.args,
    }))]);
    writeIfChanged(script, GATE_SCRIPT.replace("/*sandbox*/false", String(sandbox)).replace("/*local git*/false", String(sandbox && !declared.includes("git"))).replace("/*credential rules*/[]", () => JSON.stringify(offline)));
    const node = process.execPath;
    if (sandbox && !win) {
      const dispatch = join(guarded, "..", "dispatch.mjs");
      writeIfChanged(dispatch, `#!/tmp/.omem-programs/node
(async () => {
  const { existsSync, realpathSync } = await import("node:fs");
  const { basename, join } = await import("node:path");
  const invoked = process.argv[1], name = basename(invoked);
  if (existsSync(join(${JSON.stringify(guarded)}, name))) {
    process.argv.splice(1, 1, ${JSON.stringify(script)}, name);
    await import(${JSON.stringify(pathToFileURL(script).href)});
  } else {
    const { createHash } = await import("node:crypto");
    const actual = realpathSync(invoked);
    if (name === basename(actual)) throw new Error("请使用 PATH 中声明的命令名调用受保护的程序");
    const key = createHash("sha256").update(actual).digest("hex");
    process.execve("/tmp/.omem-programs/native/" + key, [invoked, ...process.argv.slice(2)], process.env);
  }
})().catch(error => { process.stderr.write("[omem] " + error.message + "\\n"); process.exitCode = 126; });
`);
      chmodSync(dispatch, 0o755);
      const hint = join(guarded, "..", "git-askpass");
      writeIfChanged(hint, "#!/bin/sh\necho '远端登录由 omem 执行器使用，请通过 PATH 中的 git push、git fetch 等命令运行。' >&2\nexit 1\n");
      chmodSync(hint, 0o755);
    }
    const want = new Map<string, string>();
    for (const name of names) {
      // Git Bash runs the extensionless script; cmd.exe and PowerShell the .cmd.
      const sh = `#!/bin/sh\nexec "${node.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}" "${name}" "$@"\n`;
      if (sandbox) {
        const entry = JSON.stringify(script);
        const cli = JSON.stringify(name);
        want.set(name, `#!/tmp/.omem-programs/node\nprocess.argv.splice(1,1,${entry},${cli}); import(${JSON.stringify(pathToFileURL(script).href)});\n`);
        const python = join(guarded, "..", name + ".py");
        writeIfChanged(python, `#!/usr/bin/env python3\nimport os,sys\nos.execv("/tmp/.omem-programs/node", ["node", ${entry}, ${cli}] + sys.argv[1:])\n`);
        chmodSync(python, 0o755);
      } else want.set(name, sh);
      if (win) want.set(`${name}.cmd`, `@"${node}" "${script}" "${name}" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
    }
    for (const f of readdirSync(guarded)) if (!want.has(f)) rmSync(join(guarded, f), { force: true });
    for (const [f, text] of want) {
      writeIfChanged(join(guarded, f), text);
      if (!win) chmodSync(join(guarded, f), 0o755);
    }
    return guarded;
  } catch (e) {
    // Without the wrappers the rules would silently not apply: say so loudly.
    console.error("[omem] 没能写命令拦截的垫片，命令规则这次不生效：", (e as Error).message);
    return null;
  }
}

function writeIfChanged(file: string, text: string) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
}

/**
 * The wrapper's program (written to <home>/bin/command-gate.mjs): Node built-ins only. It asks omem,
 * then runs the real command found on PATH without the guarded directory, or exits 126. Anything
 * protected by an operation rule fails closed. Offline credential-only calls may proceed locally.
 */
export const GATE_SCRIPT = String.raw`// omem command gate: generated by omem (src/agents/command-gate.ts), rewritten when the rules change.
import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { StringDecoder } from "node:string_decoder";

const isolated = /*sandbox*/false;
const localGit = /*local git*/false;
const remoteGit = ${remoteGit.toString()};
const DENIED = 126;
const name = process.argv[2] || "";
const args = process.argv.slice(3);
const win = process.platform === "win32";
// A wrapper that ends up starting a wrapper again (its own file under another path, another data
// directory's wrappers, a mount) would recurse without end, one process per level. Stop before asking omem.
const depth = Number(process.env.OMEM_GATE_DEPTH) || 0;
if (process.env.OMEM_GATE_SPAWN === name + ":" + process.ppid || depth >= ${GATE_MAX_DEPTH}) {
  process.stderr.write("[omem] 命令 " + name + " 经 omem 的命令拦截垫片又启动了垫片自己（嵌套 " + (depth + 1) + " 层），可能在循环启动，不执行。\n");
  process.exit(DENIED);
}
const guarded = join(dirname(fileURLToPath(import.meta.url)), "guarded");
function canonicalPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}
const same = (a, b) => {
  const left = canonicalPath(a), right = canonicalPath(b);
  return win ? left.toLowerCase() === right.toLowerCase() : left === right;
};
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";

function fail(message) {
  process.stderr.write("[omem] " + message + "\n");
  process.exit(DENIED);
}

// Any omem wrapper (this one under another path, or another data directory's): a small file that runs command-gate.mjs.
function isWrapper(f, size) {
  if (size > 4096) return false;
  let fd;
  try {
    fd = openSync(f, "r");
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString("utf8").includes("command-gate.mjs");
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function realCommand() {
  const dirs = (process.env[pathKey] || "").split(delimiter).filter((d) => d && !same(d, guarded));
  const exts = win ? (extname(name) ? [""] : (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)) : [""];
  for (const d of dirs) {
    for (const e of exts) {
      const f = join(d, name + e);
      try {
        const st = statSync(f);
        if (!st.isFile() || same(f, join(guarded, name + e)) || isWrapper(f, st.size)) continue;
        accessSync(f, win ? constants.F_OK : constants.X_OK);
        return f;
      } catch {}
    }
  }
  return null;
}

const credentialRules = new Map(/*credential rules*/[]);
const argsMatch = ${commandArgsMatch.toString()};
function offline(message) {
  if (isolated) fail(message);
  const rules = credentialRules.get(win ? name.toLowerCase() : name);
  try {
    if (rules && !rules.some(rule => argsMatch(rule, args, (pattern, input) => {
      if (input.length > 8192) throw new Error("匹配参数过长");
      return runInNewContext("new RegExp(pattern).test(input)", { pattern, input }, { timeout: 25 });
    }))) return { decision: "allow" };
  } catch {}
  fail(message);
}

async function request(path, data, timeout) {
  const url = new URL(path, process.env.OMEM_URL);
  const body = JSON.stringify(data);
  const http = await import(url.protocol === "https:" ? "node:https" : "node:http");
  return new Promise((ok, reject) => {
    const req = http.request(url, { method: "POST", headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: "Bearer " + process.env.OMEM_TOKEN,
    } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", d => text += d);
      res.on("error", reject);
      res.on("end", () => { let value; try { value = JSON.parse(text); } catch {} ok({ status: res.statusCode, value }); });
    });
    const expire = () => req.destroy(new Error("omem 请求超时"));
    let timer = setTimeout(expire, timeout);
    req.on("information", ({ statusCode }) => {
      if (statusCode !== 102 || !data.credentialExecution) return;
      clearTimeout(timer);
      timer = setTimeout(expire, ${((COMMAND_TIMEOUT_SEC + 600) * 2 + 60) * 1000});
    });
    req.once("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body);
  });
}

async function reportOutcome(code, output) {
  try {
    const res = await request("/api/credentials/outcome", { command: name, args, code, output: code === 0 ? "" : output }, 5000);
    const reason = { denied: "没有这个资源的权限", expired: "登录已过期", unauthenticated: "需要重新登录" }[res.value?.reason];
    if (res.status === 200 && reason) process.stderr.write("[omem] " + reason + (res.value.applyUrl ? "，可前往 " + res.value.applyUrl : "") + "。" + (res.value.notice ? res.value.notice : "") + "\n");
  } catch {}
}

async function ask() {
  if (!process.env.OMEM_URL || !process.env.OMEM_TOKEN) return offline("命令 " + name + " 受命令规则保护，这个环境里没有 omem 运行的令牌（OMEM_URL / OMEM_TOKEN），不执行。");
  let res;
  try {
    res = await request("/api/command-gate", { command: name, args, cwd: process.cwd(), credentialExecution: true, stream: isolated,
      ...(name === "aad" && process.env.AAD_CDP_PORT && { desktopPort: Number(process.env.AAD_CDP_PORT) }),
      approver: process.env.OMEM_APPROVER, reason: process.env.OMEM_REASON }, credentialRules.get(win ? name.toLowerCase() : name)?.length === 0 ? 5000 : 310_000);
  } catch (e) { return offline("连不上 omem：" + e.message + "。命令 " + name + " 受命令规则保护，连不上时不执行。"); }
  if (res.status !== 200 || typeof res.value?.decision !== "string") fail("omem 没有放行命令 " + name + "：" + (res.value?.error || "HTTP " + res.status));
  return res.value;
}

let local = false;
if (localGit && name === "git" && !remoteGit(args)) {
  try {
    local = !(credentialRules.get("git") || []).some(r => argsMatch(r, args, (pattern, input) =>
      input.length > 8192 || runInNewContext("new RegExp(pattern).test(input)", { pattern, input }, { timeout: 25 })));
  } catch { /* Ask the host if the local check cannot decide. */ }
}
const v = local ? { decision: "allow" } : await ask();
if (v.decision !== "allow") fail(v.message || "omem 的命令规则不允许执行 " + name + "。");
if (v.notice) process.stderr.write("[omem] " + v.notice + "\n");
if (v.execution) {
  const write = (stream, data) => new Promise(done => stream.write(Buffer.from(data, "base64"), done));
  await Promise.all([write(process.stdout, v.execution.stdout), write(process.stderr, v.execution.stderr)]);
  process.exit(v.execution.code);
}
const stdio = v.report ? ["inherit", "pipe", "pipe"] : "inherit";
if (v.permit) {
  const url = new URL("/api/command-gate/stream/" + encodeURIComponent(v.permit), process.env.OMEM_URL);
  const http = await import(url.protocol === "https:" ? "node:https" : "node:http");
  const { once } = await import("node:events");
  const { createInterface } = await import("node:readline");
  const req = http.request(url, { method: "POST", headers: { "content-type": "application/x-omem-stdin", authorization: "Bearer " + process.env.OMEM_TOKEN } });
  let code, tail = "";
  try {
    const response = once(req, "response");
    req.flushHeaders();
    process.stdin.pipe(req);
    const [res] = await response;
    if (res.statusCode !== 200) {
      let error = "";
      for await (const part of res) error = (error + part).slice(-1000);
      throw new Error(error || "HTTP " + res.statusCode);
    }
    for await (const line of createInterface({ input: res })) {
      const [fd, data] = JSON.parse(line);
      if (fd === 0) { code = data; continue; }
      const stream = fd === 1 ? process.stdout : process.stderr;
      const bytes = Buffer.from(data, "base64");
      if (v.report) tail = (tail + bytes.toString()).slice(-${COMMAND_OUTPUT_LIMIT});
      if (!stream.write(bytes)) await once(stream, "drain");
    }
    if (!Number.isInteger(code)) throw new Error("执行器连接中断");
  } catch (e) { fail("执行器：" + e.message); }
  finally { process.stdin.unpipe(req); process.stdin.pause(); req.destroy(); }
  if (v.report) await reportOutcome(code, tail);
  process.exitCode = code;
} else {
const file = isolated ? (name === "git" && !remoteGit(args) ? "/tmp/.omem-programs/git" : null) : realCommand();
if (!file) fail("omem 放行了 " + name + "，但 PATH 里（除拦截目录外）找不到这个命令。");
let child;
const env = { ...process.env, OMEM_GATE_DEPTH: String(depth + 1), OMEM_GATE_SPAWN: name + ":" + process.pid };
if (win && /\.(cmd|bat)$/i.test(file)) {
  const q = (s) => (s === "" || /[\s"&|<>^()%!,;=]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", '"' + [file, ...args].map(q).join(" ") + '"'], { stdio, env, windowsVerbatimArguments: true });
} else child = spawn(file, args, { stdio, env });
let output = "";
if (v.report) {
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    const decoder = new StringDecoder("utf8");
    stream.on("data", chunk => { output = (output + decoder.write(chunk)).slice(-${COMMAND_OUTPUT_LIMIT}); });
    stream.on("end", () => { output = (output + decoder.end()).slice(-${COMMAND_OUTPUT_LIMIT}); });
    stream.pipe(destination, { end: false });
  }
}
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  try {
    process.on(s, () => {
      try {
        child.kill(s);
      } catch {}
    });
  } catch {}
}
child.on("error", (e) => fail("启动 " + file + " 失败：" + e.message));
child.on("close", async (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    if (v.report) {
      await reportOutcome(code ?? 1, output);
    }
    process.exitCode = code ?? 1;
  }
});
}
`;

/** The guarded directory for an agent process of this app (written now), or null. */
export function commandGateDir(app: App, sandbox = false) {
  const rules = currentRules(app).flatMap(r => r.enabled && r.match.kind === "command" ? [{ ...r.match, command: r.match.executable }] : []);
  const commands = app.config.security.protectedCommands;
  const sandboxHome = join(app.home, "bin", "sandbox");
  if (sandbox || existsSync(sandboxHome)) {
    const dir = syncCommandGate(sandboxHome, rules, true, commands);
    if (!dir) throw new Error("无法准备沙箱命令垫片");
    if (sandbox) return dir;
  }
  return syncCommandGate(app.home, rules, false, commands);
}

/** `env` with the guarded directory first in PATH (whatever the key is spelled). */
export function withGatePath(env: Record<string, string | undefined>, dir: string | null) {
  if (!dir) return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const rest = (env[key] ?? "").split(delimiter).filter((d) => d && norm(d) !== norm(dir));
  return { ...env, [key]: [dir, ...rest].join(delimiter), OMEM_COMMAND_GATE: dir };
}

/** The first rule for this call, by order; none means it runs. */
export function matchCommandRule(rules: CommandRule[], command: string, args: string[]): { rule: CommandRule; index: number } | null {
  const line = args.join(" ");
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (norm(r.command) !== norm(command)) continue;
    let ok = !r.args;
    if (r.args) {
      try {
        ok = new RegExp(r.args).test(line);
      } catch {
        ok = true; // A pattern that no longer compiles guards everything rather than nothing.
      }
    }
    if (ok) return { rule: r, index: i };
  }
  return null;
}

export const commandLine = (command: string, args: string[]) => [command, ...args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))].join(" ");
function legacyArgs(args: string[]) {
  let sensitive = false;
  return args.slice(0, 16).map(arg => {
    const hideValue = sensitive;
    sensitive = /^--?(?:.*[-_])?(?:token|password|secret|authorization|cookie|key)$/i.test(arg);
    return hideValue || (!sensitive && !/^(?:--?)?[a-zA-Z][\w-]{0,15}$/.test(arg)) ? "…" : arg;
  });
}

function safeReason(reason?: string) {
  return truncate((reason ?? "").replace(/(?:bearer\s+|(?:token|password|secret|key)\s*[=:]\s*)[^\s,;]+/gi, "…"), 300);
}

/** Grants are per conversation, else per chain of runs (a wake continues its parent's chain). */
function chainOf(app: App, runId: string | null): string {
  if (!runId) return "none";
  let id = runId;
  for (let i = 0; i < 20; i++) {
    const r = one<{ input: string; parent_id: string | null }>(app.db, "select input, parent_id from runs where id = ?", id);
    if (!r) break;
    const input = safeJson(r.input) as { conversationId?: string; threadId?: string };
    const conv = input.conversationId ?? input.threadId;
    if (conv) return `conv:${conv}`;
    if (!r.parent_id) break;
    id = r.parent_id;
  }
  return `run:${id}`;
}

function safeJson(s: string | null | undefined): Record<string, unknown> {
  try {
    return (JSON.parse(s ?? "{}") as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

type Approver = { userId: string; lark: { id: string; idType: "open_id" | "user_id" } | null; name: string; why: string };

/** The omem user an approver entry names, by entry, id or name. */
function entryMatches(app: App, entry: string, wanted: string) {
  const w = wanted.trim().toLowerCase();
  if (entry.toLowerCase() === w) return true;
  const [kind, ...rest] = entry.split(":");
  const value = rest.join(":").trim().toLowerCase();
  if (kind === "owner") return w === "owner" || w === "本人" || w === userName(app, OWNER).toLowerCase();
  if (value === w) return true;
  if (kind === "user") {
    const u = findUser(app, rest.join(":"));
    return !!u && (u.name.toLowerCase() === w || (u.email ?? "").toLowerCase() === w);
  }
  return false;
}

async function resolveEntry(app: App, entry: string, why: string): Promise<Approver> {
  const owner = (reason: string): Approver => {
    const id = larkOwnerOpenId(app, "main");
    return { userId: OWNER, lark: id ? { id, idType: "open_id" } : null, name: "本人", why: reason };
  };
  if (entry === "owner") return owner(why);
  if (entry.startsWith("user:")) {
    const id = entry.slice(5);
    const u = findUser(app, id);
    if (!u || u.disabledAt) return owner(`找不到用户 ${id}，改由本人批准`);
    if (id === OWNER) return owner(why);
    const { larkOpenIdOf } = await import("../core/users.ts");
    const open = larkOpenIdOf(app, id);
    return { userId: id, lark: open ? { id: open, idType: "open_id" } : null, name: u.name, why };
  }
  const who = entry.slice(5).trim();
  try {
    const { resolveMention } = await import("../channels/lark-people.ts");
    const p = await resolveMention(app, who);
    if ("all" in p) return owner("审批人不能是所有人，改由本人批准");
    const { identityOwner } = await import("../core/users.ts");
    const user = identityOwner(app, "lark", p.userId);
    return { userId: user && findUser(app, user) && !findUser(app, user)!.disabledAt ? user : OWNER, lark: { id: p.userId, idType: p.userId.startsWith("ou_") ? "open_id" : "user_id" }, name: p.name || who, why };
  } catch (e) {
    return owner(`找不到飞书用户「${who}」（${truncate((e as Error).message, 80)}），改由本人批准`);
  }
}

async function approverFor(app: App, rule: CommandRule, nominated: string | undefined, caller: string): Promise<Approver> {
  if (rule.approver === "caller") {
    if (caller !== OWNER && !activeUser(findUser(app, caller))) throw new HttpError(403, "运行调用者没有有效的成员身份");
    return resolveEntry(app, caller === OWNER ? "owner" : "user:" + caller, "这次运行的调用者");
  }
  if (rule.approver !== "run") return resolveEntry(app, rule.approver, "规则指定的审批人");
  if (!nominated?.trim()) return resolveEntry(app, "owner", "运行没有用 OMEM_APPROVER 提名审批人，改由本人批准");
  const entry = rule.approvers.find((e) => entryMatches(app, e, nominated));
  if (!entry) return resolveEntry(app, "owner", `运行提名的「${truncate(nominated, 40)}」不在这条规则的审批人名单里，改由本人批准`);
  return resolveEntry(app, entry, `运行提名（OMEM_APPROVER=${truncate(nominated, 40)}）`);
}

/** What an ask of this kind keeps in its context. */
type OperationGrant = {
  judge?: string; judgeReason?: string; keyed?: boolean;
  member: string;
  ruleId: string;
  egressFallback?: boolean;
  fieldSummary?: string;
  revision: number;
  kind: Operation["kind"];
  argsHash?: string;
  scope?: "once" | "run" | "always";
  runKey: string;
  ownerChoices: boolean;
};
type GateContext = Partial<OperationGrant> & {
  handler: "command-gate";
  key: string;
  chain: string;
  command: string;
  args: string[];
  cwd: string;
  rule: number;
  reuse: CommandRule["reuse"];
  expireHours: number;
  note: string;
  reason: string;
  approverName: string;
  approverWhy: string;
  lark: Approver["lark"];
  callerOnly?: boolean;
  ownerLark: string | null;
  /** Until when the card can be answered. */
  expiresAt: string;
  /** Until when an approval lets the command through (set when approved). */
  grantUntil?: string;
  used?: number;
};

export type Decision = { decision: "allow" | "deny" | "pending"; message?: string; /** The approval being waited for, when pending. */ askId?: string };

/** Gate requests waiting for an ask's answer (in this process). */
const waiting = new Map<string, Set<(a: Ask) => void>>();

export function signalDecision(ask: Ask) {
  const set = waiting.get(ask.id);
  if (!set?.size) return false;
  for (const wake of [...set]) wake(ask);
  return true;
}

export function waitDecision(id: string, ms: number, signal?: AbortSignal): Promise<Ask | null> {
  return new Promise((resolve) => {
    const set = waiting.get(id) ?? new Set();
    waiting.set(id, set);
    const done = (a: Ask | null) => {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      set.delete(done as (a: Ask) => void);
      if (!set.size) waiting.delete(id);
      resolve(a);
    };
    const timer = setTimeout(() => done(null), ms);
    const abort = () => done(null);
    set.add(done as (a: Ask) => void);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort",abort,{once:true});
  });
}

function record(app: App, runId: string | null, actor: string, action: string, c: { command: string; args: string[]; cwd: string; approver?: string; result: string; rule?: number; askId?: string }) {
  const grant = c.askId ? safeJson(one<{context:string}>(app.db,"select context from asks where id=?",c.askId)?.context) as GateContext : undefined;
  audit(app, actor, action.replace(/^command\./,(grant?.kind ?? "command")+"."), c.command, { kind: grant?.kind ?? "command", member: grant?.member ?? actor, ruleId: grant?.ruleId, revision: grant?.revision, command: c.command, argsHash: grant?.argsHash ?? digest(c.args), cwd: c.cwd, runId, approver: c.approver ?? null, result: c.result, rule: c.rule ?? null, askId: c.askId ?? null });
  if (runId && one(app.db, "select 1 from runs where id = ?", runId))
    addRunEvent(app, runId, "status", { text: `命令拦截：${truncate(commandLine(c.command, c.args), 200)} → ${c.result}`, commandGate: { command: c.command, action, approver: c.approver ?? null, askId: c.askId ?? null } });
}

/** A protected command an agent's process is about to run (POST /api/command-gate). */
export async function commandGate(app: App, ctx: ToolContext, req: { command: string; args: string[]; cwd: string; approver?: string; reason?: string }, session?: string): Promise<Decision> {
  return gateOperation(app, ctx, { kind: "command", executable: req.command, argv: req.args, cwd: req.cwd }, { ...req, stage: "wrapper" }, session);
}

type PolicyDecision = ReturnType<typeof decide> & { plugin?: string; judgeKey?: string; reason?: string };

async function commandPolicy(app: App, op: Operation, who: ReturnType<typeof operationWho>): Promise<PolicyDecision> {
  const first = decide(app, op, who);
  if (first.rule || op.kind !== "command" || !op.argv || !op.cwd) return first;
  const entry = credentialCommand(op.executable, op.argv);
  if (!entry?.command.judge) return first;
  const { method } = entry;
  const verdict = await judgeCredential(app, method, entry.command.judge, {
    command: op.executable, argv: [...op.argv], cwd: op.cwd, member: who.member, runId: who.runId ?? null,
  });
  const current = decide(app, op, who);
  if (current.rule) return current;
  if (method.signal.aborted) return { action: "deny" };
  if (!verdict) return { ...first, plugin: method.kind };
  const rule: OperationRule = {
    id: "credential/" + method.kind + "/" + entry.command.name, enabled: true, revision: 1,
    match: { kind: "command", executable: entry.command.name }, action: verdict.action,
    title: verdict.title, approval: { approver: verdict.approver ?? "owner" },
  };
  return { rule, action: verdict.action, plugin: method.kind, judgeKey: verdict.key, reason: safeReason(verdict.reason) };
}

/** Both ACP and PATH consult the current rule again before using an approval. */
export async function gateOperation(app: App, ctx: ToolContext, op: Operation, req: {approver?: string; reason?: string; stage?: "before-wrapper" | "wrapper"; /** An HTTP request's page, shown to the approver. */ page?: string} = {}, session?: string, egress?: { evaluate: () => ReturnType<typeof decide>; fallback: boolean; waitSeconds: number; fieldSummary?: string; signal?: AbortSignal }): Promise<Decision> {
  const who = operationWho(ctx);
  const evaluate = (): PolicyDecision | Promise<PolicyDecision> => egress ? egress.evaluate() : commandPolicy(app, op, who);
  const decision = await evaluate();
  if (decision.plugin) {
    const detail = { plugin: decision.plugin, action: decision.rule ? decision.action : "abstain", reason: decision.reason, runId: ctx.runId };
    audit(app, who.member, "command.judge", decision.plugin, detail);
    if (ctx.runId) addRunEvent(app, ctx.runId, "status", { text: "插件判定：" + (decision.rule?.title ?? detail.action), ...detail });
  }
  const policy = decision.rule;
  if (policy?.approval?.approver === "caller" && (ctx.role === "guest" || ctx.commandHomeUser === null))
    return { decision: "deny", message: "访客运行没有调用者审批权限" };
  auditOperation(app, op, who, policy, decision.action, "策略判定");
  if (decision.action === "deny") return { decision: "deny", message: `omem 的${op.kind === "command" ? "命令规则" : "操作规则"}「${policy?.title || policy?.id}」不允许 Agent 执行这项操作。` };
  if (!policy || decision.action !== "approve") return { decision: "allow" };
  if (op.kind === "command" && (!op.argv || !op.cwd)) return { decision: "deny", message: "缺少命令参数或工作目录，无法绑定授权" };
  await expireCommandAsks(app);
  // A request is named by its method, host and path: the query and the body stay out of cards and the audit trail.
  const command = op.kind === "command" ? op.executable : op.kind === "file" ? op.operation : op.kind === "http" ? requestLine(op) : op.kind;
  const args = op.kind === "command" ? (policy.approval?.reuse ? legacyArgs(op.argv!) : policy.match.kind === "command" ? policy.match.subcommand ?? [] : [])
    : op.kind === "file" ? [op.path.slice(0,300)] : [];
  const cwd = op.kind === "command" ? op.cwd! : op.kind === "http" ? truncate(req.page ?? "", 300) : "";
  const runId = ctx.runId;
  const actor = who.member;
  const index = currentRules(app).findIndex(r => r.id === policy.id);
  const rule: CommandRule = { command, args: "", note: policy.title ?? "", action: "approve",
    approver: policy.approval?.approver ?? "owner", approvers: policy.approval?.approvers ?? [],
    expireHours: (policy.approval?.expiresSeconds ?? 86400)/3600, waitSeconds: policy.approval?.waitSeconds ?? 90, reuse: policy.approval?.reuse ?? "once" };
  if (egress) rule.waitSeconds = Math.min(rule.waitSeconds, egress.waitSeconds);
  const chain = runId ? chainOf(app, runId) : session ?? randomUUID();
  const judgedScope = decision.plugin ? [decision.plugin, policy.approval?.approver, decision.reason, policy.title, runId, ctx.commandTurn] : [];
  const target = decision.judgeKey ?? fingerprint(op,policy);
  const key = digest([who.member, policy.id, policy.revision, target, ...judgedScope, who.role, who.profile, who.space, who.backend]);
  const runKey = digest([who.member, runId, policy.id, policy.revision, ...(decision.plugin ? [...judgedScope, target] : [])]);
  const takeGrant = () => {
    const latest = egress ? egress.evaluate() : decide(app, op, who);
    if (decision.plugin ? latest.rule || credentialCommand(command, op.kind === "command" ? op.argv : undefined)?.method.kind !== decision.plugin
      : latest.rule?.id !== policy.id || latest.rule.revision !== policy.revision || latest.action !== "approve") return false;
    if (egress?.fallback && one(app.db, "select 1 from asks where json_extract(context,'$.key')=? and status='answered' and approved=1 and json_extract(context,'$.scope')='always' limit 1", key)) return true;
    const reusable = runId && one(app.db, `select 1 from asks where json_extract(context,'$.runKey') = ? and
      json_extract(context,'$.scope') = 'run' and status='answered' and approved=1 and json_extract(context,'$.grantUntil') > ?
      and exists(select 1 from runs where id=? and status='running') limit 1`, runKey, now(), runId);
    if (reusable) return true;
    // A reserved grant can only finish at the wrapper during the prompt that reserved it.
    const wrapperTurn = req.stage === "wrapper" ? ctx.commandTurn ?? null : null;
    const grant = one<{id:string}>(app.db, `select id from asks where json_extract(context,'$.key')=? and json_extract(context,'$.chain')=?
      and status='answered' and approved=1 and coalesce(json_extract(context,'$.scope'),'once')='once'
      and (run_id is ? or json_extract(context,'$.retryRunId')=? or json_extract(context,'$.reuse')='window')
      and json_extract(context,'$.grantUntil') > ? and coalesce(json_extract(context,'$.used'),0)=0
      and (json_extract(context,'$.wrapperTurn') is null or json_extract(context,'$.wrapperTurn') = ?)
      order by json_extract(context,'$.wrapperTurn') is not null desc, answered_at desc limit 1`, key,chain,runId,runId,now(),wrapperTurn);
    return !!grant && useGrant(app, grant.id, wrapperTurn, req.stage === "before-wrapper" ? ctx.commandTurn : undefined);
  };
  if (takeGrant()) {
    auditOperation(app, op, who, policy, "allow", "使用已有授权");
    return { decision: "allow" };
  }
  // The same command already waiting in this chain: wait on that card instead of sending another.
  const pending = () => all<{ id: string }>(app.db, "select id from asks where status = 'pending' and json_extract(context, '$.handler') = 'command-gate' and json_extract(context, '$.key') = ? and json_extract(context, '$.chain') = ? and run_id is ? order by created_at desc limit 1", key, chain, runId)
    .map((r) => getAsk(app, r.id))[0];
  let ask = pending();
  let approverName: string;
  if (!ask) {
    const approver = await approverFor(app, rule, req.approver, who.member);
    if (egress?.signal?.aborted) return { decision: "deny", message: "出网入口已关闭" };
    approverName = approver.name;
    ask = pending() ?? await openAsk(app, { runId, key, chain, command, args, cwd, rule, index, approver, reason: safeReason(req.reason),
      grant: { judge: decision.plugin, judgeReason: decision.reason, keyed: !!(decision.plugin && decision.judgeKey && runId), member: who.member, kind: op.kind, ruleId: policy.id, revision: policy.revision, runKey, egressFallback: egress?.fallback, fieldSummary: egress?.fieldSummary, argsHash: op.kind === "command" ? digest(op.argv) : undefined,
        ownerChoices: approver.userId === OWNER && (!approver.lark || approver.lark.id === larkOwnerOpenId(app,"main")) } });
    record(app, runId, actor, "command.ask", { command, args, cwd, approver: approver.name, result: `等 ${approver.name} 批准（${approver.why}）`, rule: index, askId: ask.id });
    if (rule.approver === "run" && approver.userId !== OWNER) {
      const { notify } = await import("../core/notify.ts");
      notify(app, { title: `运行提名 ${approver.name} 审批命令`, body: truncate(commandLine(command, args), 300), link: runId ? `#/runs/${runId}` : "#/", urgency: "silent" });
    }
  } else approverName = (safeJson(one<{ context: string }>(app.db, "select context from asks where id = ?", ask.id)?.context) as GateContext).approverName;
  const current = getAsk(app, ask.id);
  const answered = current.status === "pending" ? await waitDecision(ask.id, rule.waitSeconds * 1000, egress?.signal) : current;
  if (answered?.status === "answered" && answered.approved) {
    // Taken by this request (a once-only approval is used up here).
    const latest = await evaluate();
    const same = digest(latest) === digest(decision);
    const allowed = answered.choice === 2 && !decision.plugin ? latest.rule : undefined;
    if ((same && takeGrant()) || (allowed?.id === policy.id && allowed.revision === policy.revision + 1 && allowed.action === "allow")) {
      record(app, runId, actor, "command.allow", { command, args, cwd, approver: approverName, result: `${approverName} 批准，放行`, rule: index, askId: ask.id });
      return { decision: "allow" };
    }
    return { decision: "deny", message: "授权已失效或已被消费" };
  }
  if (egress && !answered) {
    cancelAsk(app, ask.id, "出网审批超时");
    return { decision: "deny", message: "出网审批超时，请求已拒绝" };
  }
  if (answered?.status === "answered" && !answered.approved) {
    return { decision: "deny", message: `${approverName} 拒绝了这${op.kind === "http" ? "个请求" : "条命令"}${answered.answer ? `，理由：${answered.answer}` : ""}。不要改用其他路径或方式绕过；按理由调整做法，或告诉本人。` };
  }
  record(app, runId, actor, "command.pending", { command, args, cwd, approver: approverName, result: `${rule.waitSeconds} 秒内没有批准，先返回`, rule: index, askId: ask.id });
  if (op.kind === "http") return { decision: "pending", askId: ask.id, message: `这个请求（${command}）需要 ${approverName} 批准，审批卡片已发出；这次没有发出去。批准后原样重做这一步，不要换别的页面、接口或方式绕过。` };
  return { decision: "pending", askId: ask.id, message: `这条命令需要 ${approverName} 批准，审批卡片已发出；批准后会唤醒你，届时原样重新执行这条命令。不要改用其他路径或方式绕过。` };
}

/** Reserve a one-shot for this prompt or consume it at the final check. */
function useGrant(app: App, id: string, wrapperTurn: string | null, reserveForTurn?: string) {
  const g = safeJson(one<{ context: string }>(app.db, "select context from asks where id = ?", id)?.context) as GateContext;
  if (g.reuse === "window") return true;
  if (reserveForTurn)
    return run(app.db, `update asks set context=json_set(context,'$.wrapperTurn',?) where id=?
      and json_extract(context,'$.wrapperTurn') is null and coalesce(json_extract(context,'$.used'),0)=0`, reserveForTurn, id).changes > 0;
  return run(app.db, `update asks set context=json_set(context,'$.used',1) where id=?
    and (json_extract(context,'$.wrapperTurn') is null or json_extract(context,'$.wrapperTurn')=?)
    and coalesce(json_extract(context,'$.used'),0)=0`, id, wrapperTurn).changes > 0;
}

async function openAsk(
  app: App,
  c: { grant: OperationGrant; runId: string | null; key: string; chain: string; command: string; args: string[]; cwd: string; rule: CommandRule; index: number; approver: Approver; reason: string },
): Promise<Ask> {
  const expiresAt = new Date(Date.now() + (c.grant.egressFallback !== undefined ? c.rule.waitSeconds * 1000 : c.rule.expireHours * 3600_000)).toISOString();
  const context: GateContext = {
    ...c.grant,
    handler: "command-gate",
    key: c.key,
    chain: c.chain,
    command: c.command,
    args: c.args,
    cwd: c.cwd,
    rule: c.index,
    reuse: c.rule.reuse,
    expireHours: c.rule.expireHours,
    note: c.rule.note,
    reason: c.reason,
    approverName: c.approver.name,
    approverWhy: c.approver.why,
    lark: c.approver.lark,
    callerOnly: c.rule.approver === "caller",
    ownerLark: c.rule.approver === "caller" ? null : larkOwnerOpenId(app, "main") ?? null,
    expiresAt,
  };
  const line = commandLine(c.command, c.args);
  const http = c.grant.kind === "http";
  const question = [
    `${c.grant.egressFallback !== undefined ? "沙箱进程要发出受保护的请求" : http ? "Agent 操作的网页要发出受保护的请求" : "Agent 要执行受保护的命令"}：\n\n\`\`\`\n${fence(truncate(line, 2000))}\n\`\`\``,
    http ? (c.cwd ? `页面：${c.cwd}` : "") : `目录：${c.cwd || "（未知）"}`,
    c.grant.fieldSummary ? `规则检查的字段：${c.grant.fieldSummary}` : "",
    c.grant.argsHash ? `参数摘要：${c.grant.argsHash.slice(0,16)}` : "",
    c.grant.judgeReason ? `插件判定：${c.grant.judgeReason}` : "",
    c.reason ? `原因（Agent 填写）：${c.reason}` : "",
    c.rule.note ? `规则说明：${c.rule.note}` : "",
    `审批人：${c.approver.name}（${c.approver.why}）`,
  ].filter(Boolean).join("\n\n");
  // The web shows it to the approver (the owner for someone without an omem account); Feishu gets the card below.
  const ask = createAsk(app, { runId: c.runId, conversationId: null, userId: c.approver.userId, kind: "approval", question, options: (c.grant.judge ? (c.grant.keyed ? ["只这一次", "本轮对同一对象放行"] : ["只这一次"]) : c.grant.ownerChoices ? ["只这一次","这次运行里的同类操作","以后按这条规则放行"] : ["只这一次"]).map(label => ({label})), tool: c.grant.kind, args: { command: c.command, args: c.args, cwd: c.cwd }, context, allowText: true });
  const sending = sendCard(app, ask.id, context, c.runId).catch((e: Error) => console.warn(`[omem] 命令审批卡片没发出去：${e.message}`));
  if (c.grant.egressFallback === undefined) await sending;
  // Past its time nobody can approve it any more.
  setTimeout(() => void expireCommandAsks(app).catch(() => {}), c.rule.expireHours * 3600_000 + 1000).unref();
  return ask;
}

const fence = (s: string) => s.replace(/```/g, "ʼʼʼ");
/** `POST api.example.com/v1/orders`: what a request is called on cards and in the audit trail. */
function requestLine(op: Extract<Operation, { kind: "http" }>) {
  const u = new URL(op.url);
  return truncate(`${op.method.toUpperCase()} ${u.host}${u.pathname}`, 300);
}

function runInfo(app: App, runId: string | null) {
  if (!runId) return null;
  const r = one<{ title: string; kind: string; input: string }>(app.db, "select title, kind, input from runs where id = ?", runId);
  if (!r) return null;
  const input = safeJson(r.input) as { spec?: string; role?: string; rule?: { name?: string } };
  return { title: r.title, who: input.spec ?? input.role ?? r.kind, rule: input.rule?.name ?? null, link: webLink(app, `#/runs/${runId}`) };
}

/** The approval card (Feishu); `state` once it is settled. */
export function commandCard(app: App, c: GateContext, runId: string | null, state?: { kind: "approved" | "declined" | "expired"; by?: string; text?: string | null }) {
  const info = runInfo(app, runId);
  const blocks: Record<string, unknown>[] = [
    { markdown: `\`\`\`\n${fence(truncate(commandLine(c.command, c.args), 1500))}\n\`\`\`` },
    { fields: [{ label: c.kind === "http" ? "页面" : "目录", value: truncate(c.cwd || "（未知）", 200) }, { label: "规则", value: c.judge ?? (c.kind === "http" ? `第 ${c.rule + 1} 条` : `第 ${c.rule + 1} 条（${c.command}）`) }] },
  ];
  if (c.judgeReason) blocks.push({ note: "插件判定：" + cardText(c.judgeReason) });
  if (c.fieldSummary) blocks.push({ note: `规则检查的字段：${cardText(c.fieldSummary)}` });
  if (c.argsHash) blocks.push({ note: `参数摘要：${c.argsHash.slice(0,16)} · 规则 ${cardText(c.ruleId ?? "")}（版本 ${c.revision}）` });
  if (info) blocks.push({ markdown: `**发起**：${/^https?:/.test(info.link) ? `[${cardText(truncate(info.title, 80))}](${info.link})` : cardText(truncate(info.title, 80))} · ${cardText(info.who)}${info.rule ? ` · 规则「${cardText(info.rule)}」` : ""}` });
  if (c.reason) blocks.push({ markdown: `**原因（Agent 填写）**：${cardText(truncate(c.reason, 600))}` });
  if (c.note) blocks.push({ markdown: `**这条命令会改什么**：${cardText(truncate(c.note, 600))}` });
  blocks.push({ note: `审批人：${cardText(c.approverName)}（${cardText(c.approverWhy)}）` });
  if (!state) {
    blocks.push({ note: `${new Date(c.expiresAt).toLocaleString("zh-CN", { hour12: false, timeZone: app.config.timezone })} 前有效` });
    blocks.push({ buttons: [{ text: "只这一次", value: "approve", style: "primary" }, ...(c.judge ? (c.keyed ? [{ text: "本轮对同一对象放行", value: "run" }] : []) : c.ownerChoices ? [...(runId ? [{ text: "这次运行里的同类操作", value: "run" }] : []), { text: "以后按这条规则放行", value: "always" }] : []), { text: "拒绝", value: "decline", style: "danger" }] });
  } else {
    const by = state.by ? `${cardText(state.by)} ` : "";
    blocks.push({ note: state.kind === "approved" ? `${by}已批准${state.text ? `：${cardText(state.text)}` : ""}` : state.kind === "declined" ? `${by}已拒绝${state.text ? `：${cardText(state.text)}` : ""}` : "已过期，没有批准" });
  }
  return { title: state ? "命令审批" : "要放行这条命令吗？", color: state?.kind === "approved" ? "green" : state ? "grey" : "orange", blocks };
}

async function sendCard(app: App, askId: string, c: GateContext, runId: string | null) {
  if (!app.config.lark?.enabled || !c.lark) return;
  const sent = await sendLark({ userId: c.lark.id, userIdType: c.lark.idType, bot: "main" }, { card: buildCard(commandCard(app, c, runId) as never) });
  // The approver, and the owner, may press it.
  markAskSent(app, askId);
  recordInteraction(app, { messageId: sent.messageId, chatId: null, conversationId: null, runId, purpose: "command-gate", allowed: [c.lark.id, ...(c.ownerLark && c.ownerLark !== c.lark.id ? [c.ownerLark] : [])], payload: { askId }, bot: "main" });
}

/** The card once the ask is settled (answered on the web, on the card, or expired). */
async function closeCard(app: App, ask: Ask, c: GateContext) {
  const row = one<{ id: string; message_id: string | null }>(app.db, "select id, message_id from card_interactions where purpose = 'command-gate' and json_extract(payload, '$.askId') = ? and message_id is not null order by created_at desc limit 1", ask.id);
  if (!row?.message_id) return;
  closeInteraction(app, row.id, ask.answeredBy ?? "");
  await updateLarkCard(row.message_id, buildCard(commandCard(app, c, ask.runId, settled(app, ask)) as never), "main").catch(() => {});
}

function settled(app: App, ask: Ask) {
  const by = ask.answeredBy ? (findUser(app, ask.answeredBy) ? userName(app, ask.answeredBy) : ask.answeredBy) : undefined;
  return ask.status === "cancelled" ? { kind: "expired" as const } : { kind: ask.approved ? ("approved" as const) : ("declined" as const), by, text: ask.answer };
}

/** A button on the Feishu card (lark-actions.ts). Returns the card to show. */
export async function decideCommandCard(app: App, payload: { askId?: string }, approve: boolean, by: string, choice?: number) {
  const id = String(payload.askId ?? "");
  await expireCommandAsks(app);
  let ask = getAsk(app, id);
  if (ask.status === "pending") {
    const { answerAsk } = await import("./asks.ts");
    ask = await answerAsk(app, id, { approved: approve, by, choice: ask.options.length ? choice : undefined });
  }
  const c = safeJson(one<{ context: string }>(app.db, "select context from asks where id = ?", id)?.context) as GateContext;
  return commandCard(app, c, ask.runId, settled(app, ask));
}

/** Pending approvals past their time: closed, the card says so, and whoever asked hears of it. */
export async function expireCommandAsks(app: App) {
  const due = all<{ id: string }>(app.db, "select id from asks where status = 'pending' and json_extract(context, '$.handler') = 'command-gate' and json_extract(context, '$.expiresAt') < ?", now());
  for (const r of due) {
    cancelAsk(app, r.id);
    const ask = getAsk(app, r.id);
    const c = safeJson(one<{ context: string }>(app.db, "select context from asks where id = ?", r.id)?.context) as GateContext;
    record(app, ask.runId, "omem", "command.expire", { command: c.command, args: c.args, cwd: c.cwd, approver: c.approverName, result: "审批过期，没有放行", rule: c.rule, askId: r.id });
    await closeCard(app, ask, c).catch(() => {});
    await tellRun(app, ask, c, `命令 \`${truncate(commandLine(c.command, c.args), 300)}\` 的审批过期了（${c.approverName} 没有批准）。没有执行；还需要的话告诉本人。`);
  }
  return due.length;
}

/** An answer nobody's command was waiting for: wake the run that asked, or tell the owner. */
async function tellRun(app: App, ask: Ask, c: GateContext, note: string) {
  const runId = ask.runId;
  const { notify } = await import("../core/notify.ts");
  const fallback = () => notify(app, { title: "命令审批有了结果", body: note, link: runId ? `#/runs/${runId}` : "#/" });
  if (!runId) return fallback();
  const r = one<{ input: string; user_id: string | null }>(app.db, "select input,user_id from runs where id = ?", runId);
  const input = safeJson(r?.input) as { conversationId?: string; threadId?: string; spec?: string; itemStepApproval?: string };
  // An approval received while the original request is waiting still goes through signalDecision.
  // Once it is no longer waiting, don't start an untracked second attempt at this one-shot step.
  if (input.itemStepApproval) return notify(app, { userId: r?.user_id ?? OWNER, title: "事项步骤的命令审批有了结果",
    body: "原执行轮已不在等这项审批，不会自动再执行。请先核对步骤结果。", link: `#/runs/${runId}` });
  const conversationId = input.conversationId ?? input.threadId;
  const target = conversationId ? { conversationId } : input.spec ? { spec: input.spec, resumeRunId: runId } : null;
  if (!target) return fallback();
  try {
    const { fireWake } = await import("./wakes.ts");
    const w = fireWake(app, { note, target, setBy: { runId, agent: "命令审批" }, setAt: ask.createdAt });
    if (w.runId && ask.approved) run(app.db, "update asks set context=json_set(context,'$.retryRunId',?) where id=?", w.runId, ask.id);
    if (w.skipped) fallback();
  } catch (e) {
    console.warn(`[omem] 命令审批后唤醒运行 ${runId} 失败：${(e as Error).message}`);
    fallback();
  }
}

registerAskHandler("command-gate", async (app, ask, context) => {
  const c = context as unknown as GateContext;
  const by = settled(app, ask).by ?? ask.answeredBy ?? "";
  if (ask.approved && c.ruleId) {
    const scope = ask.choice === 2 ? "always" : ask.choice === 1 ? "run" : "once";
    if (scope === "always" && !c.egressFallback) {
      const rules = currentRules(app);
      if (rules.some(r => r.id === c.ruleId && r.revision === c.revision))
        saveOperationRules(app, rules.map(r => r.id === c.ruleId ? { ...r, action: "allow" } : r));
    }
    const reuse = ask.answeredBy === OWNER && ask.choice === null ? c.reuse : "once";
    run(app.db, "update asks set context=json_set(context,'$.scope',?,'$.grantUntil',?,'$.reuse',?) where id=?", scope,new Date(Date.now() + c.expireHours * 3600_000).toISOString(),reuse,ask.id);
    audit(app, ask.answeredBy!, "operation.approve", c.command, {kind:c.kind, ruleId:c.ruleId, revision:c.revision, member:c.member, runId:ask.runId, approver:ask.answeredBy, approverWhy:c.approverWhy, scope, result:"批准",argsHash:c.argsHash});
  }
  record(app, ask.runId, ask.answeredBy ?? "", ask.approved ? "command.approve" : "command.reject", { command: c.command, args: c.args, cwd: c.cwd, approver: by, result: ask.approved ? `${by} 批准` : `${by} 拒绝${ask.answer ? `：${truncate(ask.answer, 200)}` : ""}`, rule: c.rule, askId: ask.id });
  const fresh = getAsk(app, ask.id);
  await closeCard(app, fresh, c).catch(() => {});
  if (signalDecision(fresh)) return;
  if (c.egressFallback !== undefined) return;
  const line = `\`${truncate(commandLine(c.command, c.args), 300)}\``;
  await tellRun(
    app,
    fresh,
    c,
    ask.approved
      ? `${by} 已批准命令 ${line}（目录 ${c.cwd || "未知"}）。请在同一目录原样重新执行这条命令${ask.choice == null && ask.answeredBy === OWNER && c.reuse === "window" ? `；${c.expireHours} 小时内同样的命令不用再批` : ""}。`
      : `${by} 拒绝了命令 ${line}${ask.answer ? `，理由：${ask.answer}` : ""}。没有执行；不要换方式绕过，按理由调整做法或告诉本人。`,
  );
}, (app, ask, context, by, answer) => {
  const c = context as GateContext;
  if (c.callerOnly && by !== ask.userId) throw new HttpError(403, "只有这次运行的调用者能批准");
  if (c.expiresAt <= now()) throw new Error("审批卡片已过期");
  if (c.judge && answer.choice === 1 && c.keyed) {
    if (by !== ask.userId || !one(app.db, "select 1 from runs where id=? and status='running'", ask.runId))
      throw new Error("只有审批人能在有效运行中批准同一对象");
    return;
  }
  if ((answer.choice ?? 0) > 0) {
    if (by !== OWNER || !c.ownerChoices) throw new Error("只有本人能扩大授权范围");
    if (!c.egressFallback && !currentRules(app).some(r => r.enabled && r.id === c.ruleId && r.revision === c.revision && r.action === "approve")) throw new Error("规则已变化");
    if (answer.choice === 1 && !one(app.db, "select 1 from runs where id=? and status='running'", ask.runId)) throw new Error("运行已结束");
  }
});

/** Who can be picked as an approver on the settings page. */
export function approverChoices(app: App) {
  return listUsers(app)
    .filter((u) => u.kind === "person" && !u.disabledAt && u.status !== "pending")
    .map((u) => ({ value: u.id === OWNER ? "owner" : `user:${u.id}`, label: u.id === OWNER ? `本人（${u.name}）` : u.name }));
}
