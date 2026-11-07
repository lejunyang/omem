import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { resolve } from "node:path";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { scanPorts } from "../core/listening.ts";
import { commandLine, killPid } from "../core/procs.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError } from "../core/util.ts";
import { codeFolders } from "./code.ts";
import { getRun } from "./runs.ts";
import { setupCommandFor, setupDone, setupKey } from "./workspaces.ts";

/**
 * Previews of a coding delegation's workspace (docs/v2/preview.md): the repository's preview
 * command runs in the workspace, omem finds the ports it and its children listen on, and the
 * owner's browser reaches them on the same port numbers (here, or forwarded by `omem peer open`).
 * One preview per repository at a time; it stops when nobody looks for a while, when the
 * workspace goes away, or when omem stops.
 */

export type PreviewCommand = { name: string; command: string };
export type PreviewPort = { port: number; hosts: string[]; page: boolean | null; connections: number };
export type PreviewStatus = "preparing" | "starting" | "running" | "exited" | "stopped";
export type PreviewView = {
  id: string;
  run: string;
  space: string;
  folder: string;
  branch: string | null;
  name: string;
  command: string;
  status: PreviewStatus;
  ports: PreviewPort[];
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  reason: string | null;
  /** What a known failure in the output means for this machine (file-watch limits), or null. */
  hint: string | null;
  log: string;
};

/** `current`: what runs now (the setup command, then the preview command); `commandAt`: when the preview command started. */
type Preview = Omit<PreviewView, "log" | "hint"> & { pid: number; current: string; log: string; idleSince: number; commandAt: number; everPorts: boolean; lastScan: number; scanning: boolean };

/**
 * Dev servers watch files; on Linux each user has a fixed number of inotify instances and watches,
 * shared with everything else they run. A crash for that reads like the project's own error.
 */
export function previewHint(log: string): string | null {
  if (/\bEMFILE\b[^\n]*\b(watch|inotify)|\b(watch|inotify)[^\n]*\bEMFILE\b|syscall: 'watch',\s*code: 'EMFILE'|code: 'EMFILE',[^}]*syscall: 'watch'/.test(log))
    return "监听文件变化的名额用完了（EMFILE）：这台机器上同一用户的 inotify 实例数有上限（Linux 的 fs.inotify.max_user_instances，常见默认 128），被正在运行的其他程序占满时开发服务器就会崩。关掉一些程序后重试，或请管理员调大这个值；也可以让开发服务器改用轮询监听。";
  if (/\bENOSPC\b[^\n]*\bwatch|System limit for number of file watchers reached/.test(log))
    return "监听的文件数到了上限（ENOSPC）：Linux 的 fs.inotify.max_user_watches 不够，请管理员调大；也可以让开发服务器少监听一些目录或改用轮询。";
  return null;
}

const LOG_MAX = 60_000;
/** A big monorepo's dev servers can take minutes to come up; past this with no port, something is wrong. */
const STARTUP_MS = 15 * 60_000;
const KEY = "previews";
const previews = new Map<string, Preview>();
const children = new Map<string, ChildProcess>();
let timer: NodeJS.Timeout | null = null;

/** The name before the first colon is a name only if it does not look like part of a command. */
export function previewCommands(settings: Record<string, unknown>): PreviewCommand[] {
  const out: PreviewCommand[] = [];
  for (const raw of String(settings.previewCommands ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([^:：=/$'"`\s][^:：=/$'"`]*?)\s*[:：]\s*(\S.*)$/.exec(line);
    if (m) out.push({ name: m[1].trim(), command: m[2].trim() });
    else out.push({ name: out.length ? `命令 ${out.length + 1}` : "预览", command: line });
  }
  return out;
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function view(p: Preview, logChars = 8000): PreviewView {
  const { pid: _pid, current: _c, idleSince: _i, commandAt: _a, everPorts: _e, lastScan: _l, scanning: _s, log, ...rest } = p;
  return { ...rest, ports: p.ports.map((x) => ({ ...x })), hint: previewHint(log), log: log.slice(-logChars) };
}

function remember(app: App) {
  const running = [...previews.values()].filter(live).map((p) => ({ id: p.id, pid: p.pid, command: p.current, folder: p.folder }));
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY, JSON.stringify(running));
}

/** Preview processes a previous omem left running (it stopped without stopping them). */
export function stopLeftovers(app: App) {
  const raw = one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value;
  let left: { pid: number; command: string }[] = [];
  try {
    left = JSON.parse(raw ?? "[]");
  } catch {}
  for (const l of left) {
    if ([...previews.values()].some((p) => p.pid === l.pid)) continue;
    // Only if the pid still runs that command: it may have been reused by something else.
    if (l.pid > 1 && commandLine(l.pid).includes(l.command.slice(0, 60))) killPid(l.pid);
  }
  remember(app);
}

/** The root delegation of a coding run (where its workspaces are recorded). */
const rootOf = (app: App, runId: string) => {
  const r = getRun(app, runId);
  if (r.kind !== "code") throw new HttpError(400, "只有交办编码的运行能预览");
  return String(r.input.continueFrom ?? r.id);
};

const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/** What a delegation can preview: each repository's folder and its preview commands. */
export function previewTargets(app: App, runId: string) {
  const root = rootOf(app, runId);
  return codeFolders(app, root).map((f) => {
    const space = findSpace(app, f.space);
    return { space: f.space, spaceName: space?.name ?? f.space, folder: f.path, kind: f.kind, branch: f.branch, commands: space ? previewCommands(space.settings) : [] };
  });
}

export function listPreviews(app: App, runId?: string): PreviewView[] {
  const root = runId ? rootOf(app, runId) : null;
  return [...previews.values()].filter((p) => !root || p.run === root).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((p) => view(p, root ? 4000 : 0));
}

export function getPreview(id: string, logChars = 8000): PreviewView {
  const p = previews.get(id);
  if (!p) throw new HttpError(404, "没有这个预览（可能已经停了，或 omem 重启过）");
  return view(p, logChars);
}

function end(app: App, p: Preview, status: PreviewStatus, reason: string | null, code: number | null = null) {
  if (p.status === "exited" || p.status === "stopped") return;
  Object.assign(p, { status, reason, exitCode: code, endedAt: new Date().toISOString(), ports: [] });
  // The group: what the command started in the background goes too (`a & b`). Never an unknown pid (killPid refuses it too).
  if (p.pid > 1) killPid(p.pid);
  children.delete(p.id);
  remember(app);
  // Ended ones stay listed a while, so the page can say why; then they go.
  setTimeout(() => {
    if (previews.get(p.id) === p) previews.delete(p.id);
  }, 10 * 60_000).unref();
}

export function stopPreview(app: App, id: string, reason = "你停掉了"): PreviewView {
  const p = previews.get(id);
  if (!p) throw new HttpError(404, "没有这个预览");
  end(app, p, "stopped", reason);
  return view(p);
}

export function stopAllPreviews(app: App) {
  for (const p of previews.values()) end(app, p, "stopped", "omem 停止了");
  if (timer) clearInterval(timer);
  timer = null;
}

export function startPreview(app: App, b: { run: string; space: string; name?: string }): PreviewView {
  const root = rootOf(app, b.run);
  const target = previewTargets(app, root).find((t) => t.space === b.space);
  if (!target) throw new HttpError(409, "这次交办在这个仓库没有工作区（可能已经收回、应用或丢弃）");
  if (!target.commands.length) throw new HttpError(400, `${target.spaceName} 还没设预览命令：在空间设置里填“预览命令”`);
  const cmd = b.name ? target.commands.find((c) => c.name === b.name) : target.commands[0];
  if (!cmd) throw new HttpError(404, `没有名为 ${b.name} 的预览命令`);
  // The project's ports are fixed: one preview per repository.
  for (const p of previews.values()) if (p.space === b.space && live(p)) end(app, p, "stopped", "同一个仓库开了另一个预览");
  // Dependencies first, by the same rule as coding: when this folder never ran the setup command, or its lockfiles changed.
  const repo = findSpace(app, b.space);
  const setup = repo ? setupCommandFor(repo, target.folder) : null;
  const setupAs = setup ? setupKey(target.folder, setup) : null;
  const id = `pv${randomBytes(6).toString("hex")}`;
  const now = Date.now();
  const p: Preview = {
    id, run: root, space: b.space, folder: target.folder, branch: target.branch, name: cmd.name, command: cmd.command,
    status: setupAs ? "preparing" : "starting", ports: [], startedAt: new Date(now).toISOString(), endedAt: null, exitCode: null, reason: null,
    pid: -1, current: "", log: "", idleSince: now, commandAt: now, everPorts: false, lastScan: 0, scanning: false,
  };
  previews.set(id, p);
  const go = () => {
    Object.assign(p, { status: "starting", commandAt: Date.now() });
    launch(app, p, cmd.command, (code) => {
      const ports = p.everPorts ? "" : "，没有开出端口（看输出）";
      end(app, p, "exited", code === 0 ? `命令结束了${ports}` : `命令退出（${code ?? "被终止"}）${ports}`, code);
    });
  };
  if (setup && setupAs) {
    const started = Date.now();
    launch(app, p, setup, (code) => {
      if (p.status !== "preparing") return;
      if (code !== 0) return end(app, p, "exited", `准备命令失败（退出码 ${code ?? "被终止"}）`, code);
      setupDone(target.folder, setupAs);
      p.log = `${p.log}\n[omem] 依赖已准备，用时 ${Math.round((Date.now() - started) / 1000)} 秒\n`;
      go();
    });
  } else go();
  if (!timer) timer = setInterval(() => void tick(app), 2000).unref();
  return view(p);
}

const live = (p: Preview) => p.status === "preparing" || p.status === "starting" || p.status === "running";

/** Run one command of the preview in its folder (its own process group), output into its log. */
function launch(app: App, p: Preview, command: string, exited: (code: number | null) => void) {
  const isWin = process.platform === "win32";
  p.log = `${p.log}$ ${command}\n`.slice(-LOG_MAX);
  let child: ChildProcess;
  try {
    // Rejected before any process exists (a NUL in the command, a bad folder): the preview just ends.
    child = spawn(isWin ? (process.env.ComSpec ?? "cmd.exe") : "sh", isWin ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], {
      cwd: p.folder,
      detached: !isWin,
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none", OMEM_PREVIEW: "1" },
    });
  } catch (e) {
    p.log = `${p.log}${(e as Error).message}\n`.slice(-LOG_MAX);
    Object.assign(p, { pid: -1, current: command });
    return end(app, p, "exited", "命令没能运行（看输出）", -1);
  }
  Object.assign(p, { pid: child.pid ?? -1, current: command });
  children.set(p.id, child);
  const add = (d: Buffer) => {
    p.log = (p.log + stripAnsi(d.toString())).slice(-LOG_MAX);
  };
  child.stdout?.on("data", add);
  child.stderr?.on("data", add);
  let done = false;
  child.on("error", (e) => {
    add(Buffer.from(`\n${e.message}\n`));
    if (!done) (done = true), end(app, p, "exited", "命令没能运行", -1);
  });
  child.on("exit", (code) => {
    if (!done) (done = true), exited(code);
  });
  remember(app);
}

/** Whether `/` on the port answers with a web page (checked once per port). */
function isPage(host: string, port: number) {
  return new Promise<boolean>((ok) => {
    const req = request({ host, port, path: "/", method: "GET", headers: { accept: "text/html", host: `localhost:${port}` }, timeout: 5000 }, (res) => {
      ok(/text\/html/.test(String(res.headers["content-type"] ?? "")) || (res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400);
      res.destroy();
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => ok(false));
    req.end();
  });
}

const idleMs = (app: App) => (app.config.preview?.idleMinutes ?? 30) * 60_000;

async function scan(app: App, p: Preview) {
  if (p.pid <= 1) return;
  p.scanning = true;
  try {
    const s = await scanPorts(p.pid);
    if (p.status !== "starting" && p.status !== "running") return;
    const before = new Map(p.ports.map((x) => [x.port, x]));
    p.ports = s.listening.map((l) => ({ port: l.port, hosts: l.hosts, page: before.get(l.port)?.page ?? null, connections: s.connections.get(l.port) ?? 0 }));
    if (p.ports.length) p.everPorts = true;
    if (p.ports.length && p.status === "starting") Object.assign(p, { status: "running", idleSince: Date.now() });
    for (const x of p.ports) if (x.page === null) x.page = await isPage(x.hosts[0], x.port);
    const now = Date.now();
    if (p.status === "starting") {
      if (now - p.commandAt > STARTUP_MS) end(app, p, "stopped", `${STARTUP_MS / 60_000} 分钟还没有监听任何端口，停掉了`);
    } else if (p.ports.some((x) => x.connections > 0)) p.idleSince = now;
    else if (now - p.idleSince > idleMs(app)) end(app, p, "stopped", `${Math.round(idleMs(app) / 60_000)} 分钟没人看，停掉了`);
  } catch (e) {
    p.log = (p.log + `\n[omem] 查端口失败：${(e as Error).message}\n`).slice(-LOG_MAX);
  } finally {
    p.lastScan = Date.now();
    p.scanning = false;
  }
}

async function tick(app: App) {
  const going = [...previews.values()].filter(live);
  if (!going.length && timer) {
    clearInterval(timer);
    timer = null;
    return;
  }
  for (const p of going) {
    // The workspace went back to the pool, or the change was applied or dropped.
    let here = true;
    try {
      here = codeFolders(app, p.run).some((f) => norm(f.path) === norm(p.folder));
    } catch {
      here = false;
    }
    if (!here) {
      end(app, p, "stopped", "交办的工作区已经收回");
      continue;
    }
    // Nothing listens while dependencies install. Then every 2 s while it comes up, every 15 s after.
    if (p.status === "preparing") continue;
    const every = p.status === "starting" || !p.ports.length ? 2000 : 15_000;
    if (!p.scanning && Date.now() - p.lastScan >= every) void scan(app, p);
  }
}

/** A forwarded connection to one of the preview's own ports, or null when it is not one. */
export function previewDial(id: string, port: number): { hosts: string[]; opened: () => void } | null {
  const p = previews.get(id);
  if (!p || (p.status !== "running" && p.status !== "starting")) return null;
  const x = p.ports.find((q) => q.port === port);
  if (!x) return null;
  return { hosts: x.hosts, opened: () => (p.idleSince = Date.now()) };
}
