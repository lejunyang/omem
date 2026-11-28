/**
 * Agent turns that live on through a restart of omem (docs/v2/restart-hold.md).
 *
 * A run's ACP agent is started under an agent host (agent-host.ts), a small detached process that
 * owns the agent's stdio and serves it on a socket under the data directory. omem speaks ACP through
 * it as if the agent were its own child (HostedChild). When omem stops in the middle of a turn, the
 * host keeps the agent going and holds what it says, asks and calls; the omem that comes back re-runs
 * the run's handler as after any restart, and where that handler would start the same turn again
 * (same run, same role or check, same AI and folder) it takes the host's turn back instead: the
 * agent's earlier output is replayed, the tool token it was given is honoured again, and the turn's
 * own result is awaited without a new prompt.
 *
 * The table `agent_hosts` lists the hosts of this machine. `owner` is the omem (App) that talks to
 * one now; a row owned by an omem that is gone waits to be taken back or cleaned up.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { now } from "../core/util.ts";
import type { HostSpec } from "./agent-host.ts";
import { FRAME, frame, frameReader } from "./host-frames.ts";
import { egressRequested, egressSupport } from "./sandbox.ts";

const hostScript = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./agent-host.ts" : "./agent-host.js", import.meta.url));

export type HostRow = {
  id: string; run_id: string; slot: string; profile_id: string; cwd: string; session_id: string;
  agent: string; caps: string; system: number; resumed: number; host_pid: number | null; agent_pid: number | null;
  socket: string; key: string; token_hash: string | null; private_tmp: string | null; owner: string;
  created_at: string; updated_at: string;
};
/** What the host says when omem connects; `turn` only when omem comes back for one. */
export type HostHello = {
  ok: boolean; error?: string; hostPid?: number; agentPid?: number | null; proxy?: string | null;
  token?: string | null; stderr?: string;
  turn?: { sessionId: string | null; log: string[]; first: number; delivered: number; done: boolean } | null;
};
/** Where a host is started from inside spawn.ts launch: the process's own id, hold and omem's address. */
export type HostLaunch = { home: string; id: string; graceMs: number; upstream?: string; token?: string };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const owners = new WeakMap<App, string>();
/** Which omem this App is: rows another one owned are from before a restart. */
export function ownerId(app: App) {
  let id = owners.get(app);
  if (!id) owners.set(app, (id = `${process.pid}:${randomBytes(6).toString("hex")}`));
  return id;
}

let graceForTests: number | null = null;
export function setHostGraceForTests(ms: number | null) { graceForTests = ms; }
export const hostGraceMs = (app: App) => graceForTests ?? Math.round(app.config.agents.restartHold.minutes * 60_000);

export const hostDir = (home: string) => join(home, "agent-hosts");
function socketPath(dir: string, id: string) {
  if (process.platform === "win32") return `\\\\.\\pipe\\omem-host-${id}`;
  const path = join(dir, `${id}.sock`);
  // A Unix socket path has to stay under about 104 bytes.
  return path.length < 100 ? path : join(tmpdir(), `omem-${id}.sock`);
}

const live = new Set<HostedChild>();

/**
 * The agent's process as omem sees it: stdin, stdout, stderr and exit, carried over the host's
 * socket. `stdio[3]` is the launcher's descriptor 3 when the sandbox's config goes through it.
 */
export class HostedChild extends EventEmitter {
  readonly id: string;
  pid: number | undefined;
  hostPid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  stdio: unknown[];
  readonly ready: Promise<HostHello>;
  private sock?: Socket;
  private queue: Buffer[] = [];
  private exited = false;
  /** Left for the next omem (detachHostsForShutdown): nothing more is sent or reported. */
  private inert = false;
  private stopAsked = false;

  constructor(o: { id: string; socket: string; key: string; attach: boolean; stdio?: unknown[] }) {
    super();
    this.id = o.id;
    this.stdio = o.stdio ?? [];
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (this.inert || this.exited) return cb();
        const f = frame(FRAME.stdin, chunk);
        if (this.sock) this.sock.write(f, () => cb());
        else { this.queue.push(f); cb(); }
      },
    });
    live.add(this);
    this.ready = this.open(o.socket, o.key, o.attach);
    this.ready.catch((e: Error) => this.gone({ error: e.message }));
  }

  private async open(path: string, key: string, attach: boolean): Promise<HostHello> {
    const deadline = Date.now() + 15_000;
    let sock: Socket;
    for (;;) {
      try {
        sock = await new Promise<Socket>((resolve, reject) => {
          const s = connect(path);
          s.once("connect", () => { s.off("error", reject); resolve(s); });
          s.once("error", reject);
        });
        break;
      } catch (e) {
        if (this.inert || this.exited || Date.now() > deadline || attach) throw new Error(`连不上 Agent 宿主：${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (this.inert) { sock.destroy(); throw new Error("omem 正在停止"); }
    sock.on("error", () => {});
    let hello: ((h: HostHello) => void) | undefined;
    const got = new Promise<HostHello>((resolve) => (hello = resolve));
    sock.on("data", frameReader((type, payload) => {
      if (this.inert) return;
      if (type === FRAME.stdout) this.stdout.write(payload);
      else if (type === FRAME.stderr) this.stderr.write(payload);
      else if (type === FRAME.hello) hello?.(JSON.parse(payload.toString("utf8")));
      else if (type === FRAME.exit) this.gone(JSON.parse(payload.toString("utf8")));
    }));
    sock.on("close", () => { if (!this.inert) this.gone({ error: "Agent 宿主断开" }); });
    sock.write(frame(FRAME.control, JSON.stringify({ op: "hello", key, attach })));
    const h = await Promise.race([got, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Agent 宿主没有应答")), 10_000))]);
    if (!h.ok) { sock.destroy(); throw new Error(`Agent 宿主拒绝连接：${h.error ?? ""}`); }
    this.pid = h.agentPid ?? undefined;
    this.hostPid = h.hostPid;
    this.sock = sock;
    for (const f of this.queue.splice(0)) sock.write(f);
    if (this.stopAsked) this.control({ op: "kill" });
    return h;
  }

  private control(m: Record<string, unknown>) {
    this.sock?.write(frame(FRAME.control, JSON.stringify(m)));
  }

  private gone(info: { code?: number | null; signal?: string | null; error?: string }) {
    if (this.exited || this.inert) return;
    this.exited = true;
    live.delete(this);
    this.exitCode = info.code ?? (info.signal ? null : -1);
    this.signalCode = (info.signal as NodeJS.Signals | null | undefined) ?? null;
    this.stdout.end();
    this.stderr.end();
    if (info.error && info.code === undefined && info.signal === undefined && this.listenerCount("error")) this.emit("error", new Error(info.error));
    this.emit("exit", this.exitCode, this.signalCode);
    this.sock?.end();
  }

  /** Stop the agent and its host (spawn.ts stop). */
  hostedStop() {
    if (this.exited || this.inert) return;
    this.stopAsked = true;
    this.control({ op: "kill" });
  }

  /** omem is going away on purpose: the host holds the turn for the next one. */
  detach() {
    if (this.exited || this.inert) return;
    this.control({ op: "detach" });
    this.inert = true;
    live.delete(this);
    this.sock?.end();
  }
}

/** A restart is coming (cli-main.ts serve): every hosted agent keeps its turn for the omem that comes back. */
export function detachHostsForShutdown() {
  const n = live.size;
  for (const child of [...live]) child.detach();
  return n;
}

/** Start an agent under a new host (spawn.ts launch). Returns at once; the socket connects in the background. */
export function startHosted(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; extra: ("pipe" | number)[] }, h: HostLaunch): HostedChild {
  const dir = hostDir(h.home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socket = socketPath(dir, h.id);
  const key = randomBytes(24).toString("base64url");
  const env = Object.fromEntries(Object.entries(o.env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const spec: HostSpec = { file, args, cwd: o.cwd, env, socket, key, graceMs: h.graceMs, upstream: h.upstream, token: h.token, fds: o.extra.length, log: join(dir, `${h.id}.log`) };
  const specPath = join(dir, `${h.id}.json`);
  writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
  const launcher = spawn(process.execPath, [hostScript, "launch", specPath], { cwd: dir, stdio: ["ignore", "ignore", "ignore", ...o.extra], detached: true, windowsHide: true });
  const child = new HostedChild({ id: h.id, socket, key, attach: false, stdio: [null, null, null, ...launcher.stdio.slice(3)] });
  launcher.once("error", (e) => { if (child.listenerCount("error")) child.emit("error", e); });
  launcher.unref();
  keys.set(h.id, key);
  sockets.set(h.id, socket);
  child.once("exit", () => { keys.delete(h.id); sockets.delete(h.id); });
  return child;
}
const keys = new Map<string, string>();
const sockets = new Map<string, string>();

/**
 * Whether this turn may run under a host, and how. Not for a backend on a key relayed through omem
 * (the relay's token and the model's requests live in this process) or one whose traffic goes through
 * the egress proxy (it lives here too): those start as before and begin again after a restart.
 */
export function hostPlan(app: App, profile: AgentProfile, o: { host?: { runId: string; slot: string }; ownSandbox?: unknown; mcp?: { baseUrl: string; token: string } }) {
  if (!o.host || !app.config.agents.restartHold.enabled) return null;
  if (profile.keyRelay) return null;
  if (egressRequested(app.config, profile, !!o.ownSandbox) && egressSupport().ok) return null;
  if (o.mcp && !/^http:\/\//.test(o.mcp.baseUrl)) return null;
  const launch: HostLaunch = { home: app.home, id: `h${Date.now().toString(36)}${randomBytes(5).toString("hex")}`, graceMs: hostGraceMs(app), upstream: o.mcp?.baseUrl, token: o.mcp?.token };
  return launch;
}

/** Record a hosted agent's session once it has one: from now on a restart leaves its turn to the next omem. */
export function recordHost(app: App, child: HostedChild, slot: { runId: string; slot: string }, s: { profileId: string; cwd: string; sessionId: string; agent: string; caps: unknown; system: boolean; resumed: boolean; token?: string; privateTmp?: string }) {
  const at = now();
  run(app.db, `insert or replace into agent_hosts(id,run_id,slot,profile_id,cwd,session_id,agent,caps,system,resumed,host_pid,agent_pid,socket,key,token_hash,private_tmp,owner,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  child.id, slot.runId, slot.slot, s.profileId, s.cwd, s.sessionId, s.agent, JSON.stringify(s.caps ?? {}), s.system ? 1 : 0, s.resumed ? 1 : 0,
  child.hostPid ?? null, child.pid ?? null, sockets.get(child.id) ?? "", keys.get(child.id) ?? "", s.token ? sha(s.token) : null, s.privateTmp ?? null, ownerId(app), at, at);
  keys.delete(child.id);
  sockets.delete(child.id);
  child.once("exit", () => forgetHost(app, child.id));
  protectSession(app, s.sessionId, child.hostPid);
}

/** The backend session belongs to the host while it lives: cleanup leaves it alone (session-cleanup.ts activeElsewhere). */
export function protectSession(app: App, sessionId: string, hostPid: number | undefined) {
  if (hostPid) run(app.db, "update session_cleanup set owner_pid = ? where session_id = ? and transport = 'acp'", hostPid, sessionId);
}

export function forgetHost(app: App, id: string) {
  try { run(app.db, "delete from agent_hosts where id = ?", id); } catch { /* the database is closed */ }
  for (const ext of [".json", ".log"]) rmSync(join(hostDir(app.home), id + ext), { force: true });
}

function alive(pid: number | null) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Ask a host to stop its agent and exit, through its socket (never by a pid that may have been reused). */
async function stopHost(app: App, row: HostRow) {
  forgetHost(app, row.id);
  if (!alive(row.host_pid)) return;
  await new Promise<void>((resolve) => {
    const s = connect(row.socket);
    const done = () => { clearTimeout(timer); s.destroy(); resolve(); };
    const timer = setTimeout(done, 3000);
    s.once("error", done);
    s.once("connect", () => {
      s.write(frame(FRAME.control, JSON.stringify({ op: "hello", key: row.key, attach: true })));
      s.write(frame(FRAME.control, JSON.stringify({ op: "kill" })));
      s.end();
      s.once("close", done);
    });
  });
}

export type Attached = { child: HostedChild; row: HostRow; hello: HostHello };

/**
 * Take back the turn a host holds for this run's role or check, when it runs on the same AI in the
 * same folder. Hosts of the same slot that do not fit (another AI, two of them) are stopped: the
 * re-run does that work itself now.
 */
export async function claimHost(app: App, slot: { runId: string; slot: string }, profileId: string, cwd: string, token?: string): Promise<Attached | null> {
  const rows = all<HostRow>(app.db, "select * from agent_hosts where run_id = ? and slot = ? and owner != ?", slot.runId, slot.slot, ownerId(app));
  if (!rows.length) return null;
  const fit = rows.filter((r) => r.profile_id === profileId && r.cwd === cwd && alive(r.host_pid));
  const pick = fit.length === 1 ? fit[0] : undefined;
  for (const r of rows) if (r !== pick) await stopHost(app, r);
  if (!pick) return null;
  if (!run(app.db, "update agent_hosts set owner = ?, updated_at = ? where id = ? and owner = ?", ownerId(app), now(), pick.id, pick.owner).changes) return null;
  const child = new HostedChild({ id: pick.id, socket: pick.socket, key: pick.key, attach: true });
  let hello: HostHello;
  try { hello = await child.ready; }
  catch {
    forgetHost(app, pick.id);
    return null;
  }
  if (!hello.turn) {
    child.hostedStop();
    forgetHost(app, pick.id);
    return null;
  }
  const { aliasToolToken, toolContextForToken } = await import("./tools.ts");
  // The token the agent holds acts as this turn's (tools, spaces, run), revoked with it.
  if (hello.token && token && pick.token_hash === sha(hello.token)) aliasToolToken(hello.token, token);
  // The agent's sandbox keeps the /tmp it started with; the protected commands omem runs for it use the same one.
  if (pick.private_tmp && token) {
    const box = toolContextForToken(app, token)?.commandSandbox as { workspace?: { privateTmp?: string } } | undefined;
    if (box?.workspace && box.workspace.privateTmp !== pick.private_tmp) {
      const fresh = box.workspace.privateTmp;
      box.workspace.privateTmp = pick.private_tmp;
      if (fresh) rmSync(fresh, { recursive: true, force: true });
    }
  }
  run(app.db, "update agent_hosts set host_pid = ?, agent_pid = ? where id = ?", hello.hostPid ?? pick.host_pid, hello.agentPid ?? pick.agent_pid, pick.id);
  child.once("exit", () => forgetHost(app, pick.id));
  protectSession(app, pick.session_id, hello.hostPid);
  return { child, row: pick, hello };
}

/**
 * Hosts left by an omem that is gone: those whose run ended (or whose host died) are cleaned up; a
 * running or queued run's host waits to be taken back (and stops itself after its hold).
 */
export async function sweepAgentHosts(app: App) {
  const rows = all<HostRow & { status: string | null }>(app.db,
    "select h.*, r.status from agent_hosts h left join runs r on r.id = h.run_id where h.owner != ?", ownerId(app));
  for (const r of rows) {
    if (!alive(r.host_pid)) forgetHost(app, r.id);
    else if (r.status !== "queued" && r.status !== "running") await stopHost(app, r);
  }
  // Files of hosts no row knows any more (a host that never got a session), after a day.
  try {
    const dir = hostDir(app.home);
    const known = new Set(all<{ id: string }>(app.db, "select id from agent_hosts").map((r) => r.id));
    for (const f of readdirSync(dir)) {
      const id = f.replace(/\.(json|log|sock)$/, "");
      if (known.has(id)) continue;
      const path = join(dir, f);
      if (Date.now() - statSync(path).mtimeMs > 86400_000) rmSync(path, { force: true });
    }
  } catch { /* no hosts yet */ }
}

/** How many hosts hold a turn for this omem to take back (diagnostics, tests). */
export function waitingHosts(app: App) {
  return one<{ n: number }>(app.db, "select count(*) n from agent_hosts where owner != ?", ownerId(app))!.n;
}
