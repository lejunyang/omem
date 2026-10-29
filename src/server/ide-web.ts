import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { App } from "../core/app.ts";
import { resolveCommand } from "../agents/spawn.ts";
import { findProcesses, freePort, killPid, reachable } from "../core/procs.ts";
import { OWNER, userForToken } from "../core/users.ts";
import { truncate } from "../core/util.ts";
import { NLS_ROUTE, packFor, rewriteWorkbench, translateMessages, workbenchNls } from "./ide-locale.ts";
import { extensionDigest, findExtensionSource, installOmemExtension, listedExtensions, OMEM_EXTENSION, readJsonc, reusableExtensions, reuseExtensions, reuseSources, seedMachineSettings, typescriptTranspiler } from "./ide-setup.ts";

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
/** omem's own HTTP server, for the address the omem extension in the web IDE connects to. */
let ownServer: Server | null = null;
/** What the last start put in (the omem extension, seeded settings, reused extensions), for the report. */
let prepared: Record<string, unknown> | null = null;

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
    reapServers(join(dir, "server"));
    prepared = await prepareIde(app).catch((e: Error) => ({ error: e.message }));
    const command = ideCli(app);
    const set = app.config.ide.web.command?.trim();
    if (!command)
      throw new Error(set ? `找不到 ${set}：在运行页“在 VS Code 中打开”旁的齿轮里改成 VS Code 命令行的完整路径` : "这台机器上找不到 VS Code 的命令行（code-tunnel、code）：装上 VS Code 或它的独立命令行，或在运行页“在 VS Code 中打开”旁的齿轮里填它的路径");
    // resolveCommand runs a .cmd through cmd.exe itself; the arguments are ours (paths, a hex token).
    const child = spawn(command.file, [...command.prefix, ...args], { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: ideEnv(app) });
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

/**
 * The environment serve-web, its server and so the extension host and terminals get: this omem's
 * address (and token, when it has one) for the omem extension to connect without setup. The web IDE
 * is the owner's shell on this machine, which can read omem's config anyway.
 */
function ideEnv(app: App): NodeJS.ProcessEnv {
  const address = ownServer?.address();
  const env: NodeJS.ProcessEnv = { ...process.env, OMEM_HOME: app.home };
  delete env.OMEM_URL;
  delete env.OMEM_TOKEN;
  if (address && typeof address === "object") env.OMEM_URL = `http://127.0.0.1:${address.port}`;
  if (app.config.token) env.OMEM_TOKEN = app.config.token;
  return env;
}

/** The newest server serve-web downloaded (the one it runs unless a newer one comes out). */
function newestServer(root: string) {
  const base = join(root, "cli", "serve-web");
  return (
    subdirs(base)
      .filter((c) => /^[0-9a-f]{40}$/.test(c))
      .map((commit) => ({ commit, dir: join(base, commit), version: (readObject(join(base, commit, "product.json"))?.version as string | undefined) ?? null, at: statSync(join(base, commit)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0] ?? null
  );
}

/** Before serve-web starts: omem's extension, settings and (when asked) extensions from this machine. */
async function prepareIde(app: App) {
  const root = join(app.home, "ide");
  const serverData = join(root, "server");
  const extDir = join(serverData, "extensions");
  const web = app.config.ide.web;
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  if (web.omemExtension !== false) out.omemExtension = installOmemExtension({ source: findExtensionSource(), extDir, serverData, transpile: await typescriptTranspiler() });
  const sources = reuseSources();
  if (web.reuseSettings !== false) out.seededSettings = seedMachineSettings(serverData, sources);
  if (web.reuseExtensions) out.reusedExtensions = reuseExtensions({ extDir, serverData, record: join(root, "reused-extensions.json"), sources, serverVersion: newestServer(root)?.version ?? null });
  return out;
}

/**
 * VS Code servers of this data directory still running without a serve-web above them (it was
 * killed and they were not in its process group): stopped, so they do not pile up with old settings.
 */
function reapServers(serverData: string) {
  for (const p of findProcesses(/server-main\.js/)) if (p.cmd.includes(`--server-data-dir ${serverData}`) && p.cmd.includes(`--server-base-path ${IDE_BASE}`)) killPid(p.pid);
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
  prepared = null;
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
  const own = NLS_ROUTE.exec((req.url ?? "").slice(IDE_BASE.length).replace(/\?.*$/, ""));
  if (own) return serveNls(app, own[1], own[2], res);
  let p: number;
  try {
    p = await ensureIdeWeb(app);
  } catch (e) {
    return deny(res, 503, (e as Error).message);
  }
  const headers = upstreamHeaders(req);
  // The workbench page gets its translated strings swapped (ide-locale.ts): asked for uncompressed.
  const page = req.method === "GET" && /text\/html/.test(String(req.headers.accept ?? ""));
  if (page) delete headers["accept-encoding"];
  const up = request({ host: "127.0.0.1", port: p, method: req.method, path: req.url, headers }, (r) => {
    // The first open downloads the matching server; serve-web answers 202 meanwhile. A page that
    // reloads itself instead of one that waits for the owner to.
    if (r.statusCode === 202 && req.method === "GET" && /text\/html/.test(String(r.headers["content-type"]))) {
      r.resume();
      res.writeHead(202, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>VS Code</title><p style="font:14px system-ui;margin:24px">第一次打开，正在下载这一版的 VS Code 服务端，好了会自动进入……</p>`);
    }
    if (page && r.statusCode === 200 && /text\/html/.test(String(r.headers["content-type"])) && !r.headers["content-encoding"]) {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.from(rewriteWorkbench(Buffer.concat(chunks).toString("utf8"), IDE_BASE, (commit, locale) => !!safeNls(app, commit, locale)), "utf8");
        const out: Record<string, string | string[] | undefined> = { ...r.headers, "content-length": String(body.length) };
        delete out["transfer-encoding"];
        res.writeHead(200, out);
        res.end(body);
      });
      r.on("error", () => res.destroy());
      return;
    }
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => (res.headersSent ? res.destroy() : deny(res, 502, `网页版 VS Code 没有响应：${e.message}`)));
  req.pipe(up);
}

/** The interface strings omem built for a server build and language; null (English) when it cannot. */
function safeNls(app: App, commit: string, locale: string) {
  try {
    return workbenchNls(join(app.home, "ide"), commit, locale);
  } catch {
    return null;
  }
}

function serveNls(app: App, commit: string, locale: string, res: import("node:http").ServerResponse) {
  const built = safeNls(app, commit, decodeURIComponent(locale));
  if (!built) return deny(res, 404, "没有这一版的界面翻译");
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  res.end(readFileSync(built.file));
}

/** WebSocket upgrades under /ide go straight to serve-web, with the same check. */
export function attachIdeUpgrade(app: App, server: Server) {
  ownServer = server;
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

  // The interface strings omem gives the page (ide-locale.ts) for the newest server, per installed language.
  const newest = servers[0];
  const languages = [...new Set(packs.flatMap((p) => p.languages as string[]))];
  const interfaceStrings = newest
    ? languages.map((locale) => {
        const found = packFor(extDir, locale);
        const built = found ? translateMessages(join(root, "cli", "serve-web", newest.commit), found.main) : null;
        return { locale, server: newest.version, pack: found ? `${found.pack.id}@${found.pack.version}` : null, translated: built?.translated ?? null, total: built?.messages.length ?? null, result: built ? "按键翻译" : "英文（没有可用的语言包或服务端文件不全）" };
      })
    : [];

  // The omem extension and what could be reused from VS Code already on this machine (names, versions, counts; no contents).
  const source = findExtensionSource();
  const installedOmem = listedExtensions(extDir).find((e) => e.identifier.id.toLowerCase() === OMEM_EXTENSION);
  const installedDigest = installedOmem ? (readObject(join(extDir, installedOmem.relativeLocation ?? `${OMEM_EXTENSION}-${installedOmem.version}`, ".omem-source.json"))?.digest as string | undefined) : undefined;
  const sourceDigest = source ? extensionDigest(source) : null;
  const countKeys = (file: string) => {
    const o = readObject(file);
    return o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).length : null;
  };
  const reuse = reuseSources().map((s) => {
    const userDir = dirname(s.settings);
    const keybindings = readJsonc(join(userDir, "keybindings.json"));
    return {
      kind: s.kind,
      settings: { file: s.settings, exists: existsSync(s.settings), keys: countKeys(s.settings) },
      ...(s.kind === "desktop" ? { keybindings: Array.isArray(keybindings) ? keybindings.length : null, snippets: existsSync(join(userDir, "snippets")) ? readdirSync(join(userDir, "snippets")).sort() : [] } : {}),
      extensions: { dir: s.extensions, exists: existsSync(s.extensions), list: reusableExtensions(s.extensions, newest?.version ?? null).map((x) => ({ id: `${x.id}@${x.version}`, platform: x.platform, engine: x.engine, fits: x.fits, why: x.why ?? null })) },
    };
  });
  return {
    cli: { name: cli?.name ?? null, path: cli?.path ?? null, configured },
    dirs: { root, cliData: join(root, "cli"), serverData: serverDir, userData: join(dataDir, "User"), extensions: extDir },
    servers,
    extensions,
    languagePacks: { installed: packs, registered },
    interfaceStrings,
    omemExtension: { enabled: app.config.ide.web.omemExtension !== false, source, sourceDigest, installed: installedOmem ? { version: installedOmem.version, digest: installedDigest ?? null, current: !!sourceDigest && installedDigest === sourceDigest } : null },
    reuse: {
      settings: app.config.ide.web.reuseSettings !== false,
      extensions: !!app.config.ide.web.reuseExtensions,
      seeded: readObject(join(dataDir, "Machine", ".omem-seeded.json")),
      reused: readJsonc(join(root, "reused-extensions.json")),
      sources: reuse,
    },
    lastStart: prepared,
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
