import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { resolveCommand } from "../agents/spawn.ts";
import { freePort, killPid, reachable } from "../core/procs.ts";
import { OWNER, userForToken } from "../core/users.ts";

/**
 * Web VS Code under /ide (docs/v2/ide.md): the official `code serve-web`, started on first use on a
 * loopback port with a connection token only omem knows. omem proxies /ide (HTTP and WebSocket),
 * lets through only the owner (this machine without a configured token, or a session cookie the
 * owner got from `GET /api/ide/open`, or the owner's token from a forwarding omem), and adds the token on the way in. It is a shell on this
 * machine, so never for members or guests.
 */
export const IDE_BASE = "/ide";
const COOKIE = "omem_ide";

let proc: ChildProcess | null = null;
let port = 0;
let token = "";
let starting: Promise<number> | null = null;
let pidFile = "";
let exitHooked = false;
const sessions = new Set<string>();

/**
 * The VS Code CLI to run: the configured command, else `code-tunnel` (the CLI itself, shipped beside
 * the desktop app's `code`), else `code` (the standalone CLI on a server).
 */
function cli(app: App) {
  const set = app.config.ide.web.command?.trim();
  const found = set ? resolveCommand(set) : resolveCommand("code-tunnel") ?? resolveCommand("code");
  return { name: set || "code", ...(found ?? { file: set || "code", prefix: [] as string[] }) };
}

/** Start serve-web unless it runs; resolves to its port. */
export function ensureIdeWeb(app: App): Promise<number> {
  if (!app.config.ide.web.enabled) return Promise.reject(new Error("网页版 VS Code 没有打开：设置 → 外观与说明 → 网页版 VS Code"));
  if (proc && proc.exitCode === null && port) return Promise.resolve(port);
  starting ??= (async () => {
    port = await freePort();
    token = randomBytes(24).toString("hex");
    const dir = join(app.home, "ide");
    mkdirSync(dir, { recursive: true });
    const args = ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token", token, "--accept-server-license-terms", "--server-base-path", IDE_BASE, "--server-data-dir", join(dir, "server"), "--cli-data-dir", join(dir, "cli"), "--disable-telemetry"];
    reapOrphan(join(dir, "serve-web.pid"));
    const command = cli(app);
    // resolveCommand runs a .cmd through cmd.exe itself; the arguments are ours (paths, a hex token).
    const child = spawn(command.file, [...command.prefix, ...args], { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    let failed = false;
    const keep = (d: Buffer) => (log = (log + d.toString()).slice(-4000));
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    // A missing command is an error event, not an exit: unhandled, it would take the server down.
    child.on("error", (e) => {
      failed = true;
      keep(Buffer.from(e.message));
    });
    proc = child;
    pidFile = join(dir, "serve-web.pid");
    if (child.pid) writeFileSync(pidFile, String(child.pid));
    child.on("exit", () => {
      if (proc === child) proc = null;
    });
    if (!exitHooked) {
      exitHooked = true;
      process.on("exit", stopIdeWeb);
    }
    for (let i = 0; i < 150; i++) {
      if (failed || child.exitCode !== null || child.signalCode) break;
      if (await reachable(port)) return port;
      await new Promise((r) => setTimeout(r, 200));
    }
    killTree(child);
    throw new Error(`没能启动网页版 VS Code（${command.name} serve-web）：${log.trim().slice(-800) || "命令不存在或没有输出"}`);
  })().finally(() => (starting = null));
  return starting;
}

/** serve-web runs the server as its own child: stop the whole tree. */
function killTree(child: ChildProcess) {
  if (child.exitCode === null && child.pid) killPid(child.pid);
}

/**
 * A serve-web left running by an omem that did not get to stop it (killed, restarted by a watcher):
 * stopped before starting another, if the recorded process still is one.
 */
function reapOrphan(file: string) {
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, "utf8").trim());
  rmSync(file, { force: true });
  if (!pid || pid === process.pid) return;
  const cmd = process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).stdout
    : spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout;
  if (cmd?.includes("serve-web") && cmd.includes("--connection-token")) killPid(pid);
}

export function stopIdeWeb() {
  if (proc) killTree(proc);
  if (pidFile) rmSync(pidFile, { force: true });
  proc = null;
  sessions.clear();
}

/** A local path as the web client's `folder` query takes it: forward slashes, `/c:/…` for a Windows drive. */
export function ideFolder(path: string) {
  const p = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(p) ? `/${p[0].toLowerCase()}${p.slice(1)}` : p;
}

/** A session for the owner's browser: the cookie that opens /ide. */
export function newIdeSession() {
  const id = randomBytes(24).toString("hex");
  sessions.add(id);
  return `${COOKIE}=${id}; Path=${IDE_BASE}; HttpOnly; SameSite=Lax`;
}

function cookies(req: IncomingMessage) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, v.join("=")]));
}

/**
 * The owner's: a session cookie, the owner's token (another omem forwarding for `omem peer open`),
 * or this machine when omem trusts loopback (no token configured).
 */
export function ideAllowed(app: App, req: IncomingMessage) {
  if (sessions.has(cookies(req)[COOKIE] ?? "")) return true;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return userForToken(app, auth.slice(7)) === OWNER;
  const ip = req.socket.remoteAddress ?? "";
  return !app.config.token && /^(127\.|::1$|::ffff:127\.)/.test(ip) && !req.headers.authorization;
}

/** Headers for serve-web: its token added as the cookie it checks, omem's own cookie and auth left out. */
function upstreamHeaders(req: IncomingMessage) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && k !== "cookie" && k !== "authorization") out[k] = v;
  const kept = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).filter((c) => c && !c.startsWith(`${COOKIE}=`) && !c.startsWith("vscode-tkn="));
  out.cookie = [...kept, `vscode-tkn=${token}`].join("; ");
  out.host = `127.0.0.1:${port}`;
  return out;
}

const deny = (res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }, status: number, text: string) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
};

/** An HTTP request under /ide (the raw request; its body not read yet). */
export async function proxyIde(app: App, req: IncomingMessage, res: import("node:http").ServerResponse) {
  if (!ideAllowed(app, req)) return deny(res, 401, "网页版 VS Code 只对本人开放：在 omem 网页的运行页点“网页版 VS Code”打开。");
  let p: number;
  try {
    p = await ensureIdeWeb(app);
  } catch (e) {
    return deny(res, 503, (e as Error).message);
  }
  const up = request({ host: "127.0.0.1", port: p, method: req.method, path: req.url, headers: upstreamHeaders(req) }, (r) => {
    // The first open downloads the matching server; serve-web answers 202 meanwhile. A page that
    // reloads itself instead of one that waits for the owner to.
    if (r.statusCode === 202 && req.method === "GET" && /text\/html/.test(String(r.headers["content-type"]))) {
      r.resume();
      res.writeHead(202, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>VS Code</title><p style="font:14px system-ui;margin:24px">第一次打开，正在下载这一版的 VS Code 服务端，好了会自动进入……</p>`);
    }
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => (res.headersSent ? res.destroy() : deny(res, 502, `网页版 VS Code 没有响应：${e.message}`)));
  req.pipe(up);
}

/** WebSocket upgrades under /ide go straight to serve-web, with the same check. */
export function attachIdeUpgrade(app: App, server: Server) {
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url?.startsWith(`${IDE_BASE}/`) && req.url !== IDE_BASE) return;
    if (!ideAllowed(app, req)) return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    ensureIdeWeb(app).then(
      (p) => {
        const upstream = connect(p, "127.0.0.1", () => {
          const headers = upstreamHeaders(req);
          const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]));
          upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
          if (head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        // Either side gone ends both: a half-open socket would keep the server from closing.
        const close = () => (upstream.destroy(), socket.destroy());
        for (const s of [upstream, socket]) s.on("error", close).on("close", close).on("end", close);
      },
      () => socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"),
    );
  });
}
