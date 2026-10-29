import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { resolveCommand } from "../agents/spawn.ts";
import { findProcesses, freePort, killPid, reachable } from "../core/procs.ts";
import { OWNER, userForToken } from "../core/users.ts";
import { truncate } from "../core/util.ts";

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
 * the desktop app's `code`), else `code` (the standalone CLI on a server). Null when none is there.
 */
export function ideCli(app: App) {
  const set = app.config.ide.web.command?.trim();
  for (const name of set ? [set] : ["code-tunnel", "code"]) {
    const found = resolveCommand(name);
    if (found) return { name, ...found, path: found.prefix.at(-1) ?? found.file };
  }
  return null;
}

/** Start serve-web unless it runs; resolves to its port. */
export function ensureIdeWeb(app: App): Promise<number> {
  if (proc && proc.exitCode === null && port) return Promise.resolve(port);
  starting ??= (async () => {
    port = await freePort();
    token = randomBytes(24).toString("hex");
    const dir = join(app.home, "ide");
    mkdirSync(dir, { recursive: true });
    const args = ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token", token, "--accept-server-license-terms", "--server-base-path", IDE_BASE, "--server-data-dir", join(dir, "server"), "--cli-data-dir", join(dir, "cli"), "--disable-telemetry"];
    reapOrphan(join(dir, "serve-web.pid"));
    const command = ideCli(app);
    const set = app.config.ide.web.command?.trim();
    if (!command)
      throw new Error(set ? `找不到 ${set}：在运行页“在 VS Code 中打开”旁的齿轮里改成 VS Code 命令行的完整路径` : "这台机器上找不到 VS Code 的命令行（code-tunnel、code）：装上 VS Code 或它的独立命令行，或在运行页“在 VS Code 中打开”旁的齿轮里填它的路径");
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
  // The page tells the browser where to open its WebSocket from the host it was asked for: the
  // address the browser used (first hop's, through `omem peer open`), not serve-web's own port.
  out["x-forwarded-host"] = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? out.host;
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

// ---- state, for diagnosing the web VS Code on a machine (peer command `ide`) --------------------

/** JSON with comments and trailing commas (VS Code's settings.json, argv.json); null when it does not parse. */
function readJsonc(file: string): unknown {
  try {
    const text = readFileSync(file, "utf8");
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        out += "\n";
      } else if (c === "/" && text[i + 1] === "*") {
        i = text.indexOf("*/", i + 2);
        if (i < 0) break;
        i++;
      } else out += c;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}
const readObject = (file: string) => (readJsonc(file) ?? null) as Record<string, any> | null;

const subdirs = (path: string) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
/** The connection token must not leave the machine in a command line or a log line. */
const redactIde = (s: string) => s.replace(/(--connection-token(?:-file)?[= ])\S+/g, "$1<已隐藏>").replace(/((?:vscode-tkn|tkn)=)[^\s;&"]+/g, "$1<已隐藏>");
function tailLines(file: string, n: number) {
  try {
    return readFileSync(file, "utf8").slice(-60_000).split(/\r?\n/).filter(Boolean).slice(-n).map((l) => redactIde(truncate(l, 400)));
  } catch {
    return [];
  }
}
const minorOf = (v: string | undefined) => Number(/^\D*(\d+)\.(\d+)/.exec(v ?? "")?.[2] ?? NaN);

/**
 * What the web VS Code on this machine is made of: the CLI, the server serve-web downloaded (version,
 * commit, terminal native modules), its data and extension directories, installed extensions and language
 * packs against the server's version, language and terminal settings, recent server logs and the
 * processes that run. Read-only; no tokens.
 */
export function ideWebReport(app: App) {
  const root = join(app.home, "ide");
  const serverDir = join(root, "server");
  const dataDir = join(serverDir, "data");
  const extDir = join(serverDir, "extensions");
  const configured = app.config.ide.web.command?.trim() || null;
  const cli = ideCli(app);
  const servers = subdirs(join(root, "cli", "serve-web")).map((commit) => {
    const dir = join(root, "cli", "serve-web", commit);
    const product = readObject(join(dir, "product.json")) ?? {};
    const pty = join(dir, "node_modules", "node-pty", "build", "Release");
    return {
      commit,
      version: (product.version as string | undefined) ?? null,
      quality: (product.quality as string | undefined) ?? null,
      binary: ["bin/code-server", "bin/code-server.cmd"].find((b) => existsSync(join(dir, b))) ?? null,
      nodePty: { installed: existsSync(join(dir, "node_modules", "node-pty")), native: existsSync(pty) ? readdirSync(pty).filter((f) => f.endsWith(".node")) : [] },
      modifiedAt: statSync(dir).mtime.toISOString(),
    };
  });
  // The one serve-web used last is the newest download.
  servers.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const serverVersion = servers[0]?.version ?? undefined;

  const listed = readJsonc(join(extDir, "extensions.json"));
  const fromFile = Array.isArray(listed) ? listed.filter((e) => e?.identifier?.id).map((e) => `${e.identifier.id}@${e.version}`) : [];
  // Without extensions.json: the folder names, `<id>-<version>`.
  const extensions = fromFile.length ? fromFile : subdirs(extDir).map((d) => d.replace(/-(\d[\w.]*)$/, "@$1"));
  const packs = subdirs(extDir).filter((d) => /language-pack/i.test(d)).map((d) => {
    const pkg = readObject(join(extDir, d, "package.json"));
    const version = pkg?.version as string | undefined;
    return {
      extension: d,
      languages: ((pkg?.contributes?.localizations ?? []) as { languageId?: string }[]).map((l) => l.languageId).filter(Boolean),
      engine: (pkg?.engines?.vscode as string | undefined) ?? null,
      // A pack made for an older server translates the strings it knew; the newer ones come out in English or mismatched.
      minorsBehindServer: Number.isNaN(minorOf(serverVersion)) || Number.isNaN(minorOf(version)) ? null : minorOf(serverVersion) - minorOf(version),
    };
  });
  const registry = readObject(join(dataDir, "languagepacks.json")) ?? {};
  const registered = Object.entries(registry).map(([language, v]) => ({
    language,
    extensions: ((v?.extensions ?? []) as { extensionIdentifier?: { id?: string }; version?: string }[]).map((e) => `${e.extensionIdentifier?.id}@${e.version}`),
    translations: Object.keys(v?.translations ?? {}).length,
    mainFileExists: !!v?.translations?.vscode && existsSync(v.translations.vscode),
  }));

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const argvFiles = [join(serverDir, "argv.json"), join(dataDir, "argv.json"), join(dataDir, "User", "argv.json"), ...(home ? [join(home, ".vscode-server", "argv.json"), join(home, ".vscode", "argv.json")] : [])];
  const argv = argvFiles.filter((f) => existsSync(f)).map((file) => ({ file, locale: (readObject(file)?.locale as string | undefined) ?? null }));
  const settings = [join(dataDir, "User", "settings.json"), join(dataDir, "Machine", "settings.json")].map((file) => {
    const all = readObject(file);
    return { file, exists: existsSync(file), parsed: !!all, relevant: Object.fromEntries(Object.entries(all ?? {}).filter(([k]) => /locale|language|terminal|shell/i.test(k))) };
  });

  const sessions = subdirs(join(dataDir, "logs")).slice(-5).reverse().map((name) => ({ name, files: readdirSync(join(dataDir, "logs", name)).sort() }));
  const latest = sessions[0]?.name;
  const logs = latest ? Object.fromEntries(["ptyhost.log", "remoteagent.log"].filter((f) => existsSync(join(dataDir, "logs", latest, f))).map((f) => [f, tailLines(join(dataDir, "logs", latest, f), 15)])) : {};

  let pidFile: { pid: number; alive: boolean } | null = null;
  try {
    const pid = Number(readFileSync(join(root, "serve-web.pid"), "utf8").trim());
    if (pid) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      pidFile = { pid, alive };
    }
  } catch {}
  return {
    cli: { name: cli?.name ?? null, path: cli?.path ?? null, configured },
    dirs: { root, cliData: join(root, "cli"), serverData: serverDir, userData: join(dataDir, "User"), extensions: extDir },
    servers,
    extensions,
    languagePacks: { installed: packs, registered },
    locale: { argv, settings, env: Object.fromEntries(["LANG", "LANGUAGE", "LC_ALL", "LC_MESSAGES"].map((k) => [k, process.env[k] ?? null])) },
    terminal: { shell: process.env.SHELL ?? process.env.ComSpec ?? null, nodePty: servers[0]?.nodePty ?? null },
    logs: { sessions, ...logs },
    running: {
      own: proc && proc.exitCode === null ? { pid: proc.pid ?? null, port } : null,
      pidFile,
      processes: findProcesses(/serve-web|server-main\.js|bin[\\/]code-server|ptyHost/i).slice(0, 20).map((p) => ({ pid: p.pid, cmd: redactIde(truncate(p.cmd, 500)) })),
    },
  };
}
