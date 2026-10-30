import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { commandLine, freePort, killPid, reachable } from "../core/procs.ts";
import { HttpError } from "../core/util.ts";
import { resolveCommand } from "../agents/spawn.ts";

/**
 * Plugin services (docs/v2/plugins.md): a process a plugin keeps running beside omem — something
 * that captures a screen, drives a device, holds a connection. omem starts it on first use on a
 * loopback port with a token only omem knows, stops it after it has been idle, and proxies the
 * plugin's streams (WebSockets) to it after checking the caller is the owner.
 *
 * The service gets: OMEM_SERVICE_PORT (listen on 127.0.0.1 there), OMEM_SERVICE_TOKEN (requests
 * from omem carry `authorization: Bearer <token>`; refuse others), OMEM_PLUGIN_DIR, OMEM_PLUGIN_DATA
 * (a directory of its own under the data directory) and OMEM_SERVICE_SDK (packages/plugin-sdk/service.mjs,
 * a dependency-free HTTP + WebSocket helper).
 */
export const serviceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  description: z.string().default(""),
  /** `node` runs with omem's own Node; anything else is looked up on PATH. Runs in the plugin's directory. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Stopped after this long with no stream open and no use. */
  idleMinutes: z.number().min(1).max(1440).default(10),
  startTimeoutSeconds: z.number().min(1).max(300).default(20),
});
export type ServiceSpec = z.infer<typeof serviceSchema>;

export const streamSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  description: z.string().default(""),
  service: z.string(),
  /** The WebSocket path on the service. */
  path: z.string().regex(/^\/[^\s]*$/).default("/"),
});
export type StreamSpec = z.infer<typeof streamSchema>;

type Running = { proc: ChildProcess; port: number; token: string; startedAt: string; lastUsed: number; streams: number; idleMs: number; pidFile: string };
const running = new Map<string, Running>();
const starting = new Map<string, Promise<Running>>();
const logs = new Map<string, string[]>();
const key = (plugin: string, name: string) => `${plugin}/${name}`;

const here = dirname(fileURLToPath(import.meta.url));
/** packages/plugin-sdk/service.mjs, from source (src/plugins) and the build (dist/src/plugins). */
function serviceSdk() {
  for (const c of [resolve(here, "../../packages/plugin-sdk/service.mjs"), resolve(here, "../../../packages/plugin-sdk/service.mjs")]) if (existsSync(c)) return pathToFileURL(c).href;
  return "";
}

/** What the service sees of omem's environment: not its secrets. */
function serviceEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/secret|token|password|api_?key|^OMEM_/i.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function remember(k: string, text: string) {
  const lines = logs.get(k) ?? [];
  for (const l of text.split(/\r?\n/)) if (l.trim()) lines.push(`${new Date().toISOString().slice(11, 19)} ${l}`);
  logs.set(k, lines.slice(-200));
}

/** A service left running by an omem that did not get to stop it (killed, restarted by a watcher). */
function reapOrphan(pidFile: string, spec: ServiceSpec) {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  rmSync(pidFile, { force: true });
  if (!pid || pid === process.pid) return;
  const cmd = commandLine(pid);
  const marker = spec.args[0] ?? spec.command;
  if (cmd && cmd.includes(marker)) killPid(pid);
}

let reaper: NodeJS.Timeout | null = null;
function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    for (const [k, r] of running) if (!r.streams && Date.now() - r.lastUsed > r.idleMs) stop(k, "空闲，已停止");
  }, 30_000);
  reaper.unref();
  process.on("exit", () => {
    for (const k of [...running.keys()]) stop(k);
  });
}

function stop(k: string, why?: string) {
  const r = running.get(k);
  if (!r) return false;
  running.delete(k);
  if (r.proc.exitCode === null && r.proc.pid) killPid(r.proc.pid);
  rmSync(r.pidFile, { force: true });
  if (why) remember(k, why);
  return true;
}

/** Start the service unless it runs; resolves to where it listens and the token it expects. */
export function ensureService(app: App, plugin: { id: string; dir: string }, spec: ServiceSpec): Promise<{ port: number; token: string }> {
  const k = key(plugin.id, spec.name);
  const r = running.get(k);
  if (r && r.proc.exitCode === null) {
    r.lastUsed = Date.now();
    return Promise.resolve({ port: r.port, token: r.token });
  }
  let p = starting.get(k);
  if (!p) {
    p = (async () => {
      startReaper();
      const port = await freePort();
      const token = randomBytes(24).toString("hex");
      const data = join(app.home, "plugin-data", plugin.id);
      mkdirSync(data, { recursive: true });
      const pidFile = join(data, `${spec.name}.pid`);
      reapOrphan(pidFile, spec);
      const found = spec.command === "node" ? { file: process.execPath, prefix: [] as string[] } : resolveCommand(spec.command) ?? { file: spec.command, prefix: [] as string[] };
      const env = serviceEnv({ ...spec.env, OMEM_SERVICE_PORT: String(port), OMEM_SERVICE_TOKEN: token, OMEM_PLUGIN_DIR: plugin.dir, OMEM_PLUGIN_DATA: data, OMEM_SERVICE_SDK: serviceSdk() });
      const child = spawn(found.file, [...found.prefix, ...spec.args], { cwd: plugin.dir, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let failed = false;
      child.stdout?.on("data", (d: Buffer) => remember(k, d.toString()));
      child.stderr?.on("data", (d: Buffer) => remember(k, d.toString()));
      // A missing command is an error event, not an exit: unhandled, it would take omem down.
      child.on("error", (e) => {
        failed = true;
        remember(k, e.message);
      });
      child.on("exit", (code) => {
        if (running.get(k)?.proc === child) running.delete(k);
        remember(k, `进程结束（${code ?? "信号"}）`);
      });
      if (child.pid) writeFileSync(pidFile, String(child.pid));
      remember(k, `启动：${spec.command} ${spec.args.join(" ")}（端口 ${port}）`);
      for (let i = 0; i < spec.startTimeoutSeconds * 5; i++) {
        if (failed || child.exitCode !== null || child.signalCode) break;
        if (await reachable(port)) {
          const r: Running = { proc: child, port, token, startedAt: new Date().toISOString(), lastUsed: Date.now(), streams: 0, idleMs: spec.idleMinutes * 60_000, pidFile };
          running.set(k, r);
          return r;
        }
        await new Promise((ok) => setTimeout(ok, 200));
      }
      if (child.exitCode === null && child.pid) killPid(child.pid);
      rmSync(pidFile, { force: true });
      throw new HttpError(503, `插件 ${plugin.id} 的服务 ${spec.name} 没能启动：${(logs.get(k) ?? []).slice(-6).join("\n") || "没有输出"}`);
    })().finally(() => starting.delete(k));
    starting.set(k, p);
  }
  return p.then((r) => ({ port: r.port, token: r.token }));
}

export const stopService = (plugin: string, name: string) => stop(key(plugin, name), "已停止");
export function stopPluginServices(plugin: string) {
  for (const k of [...running.keys()]) if (k.startsWith(`${plugin}/`)) stop(k, "已停止");
}

/** A stream opened or closed: open streams keep the service from being stopped as idle. */
export function streamUse(plugin: string, name: string, delta: 1 | -1) {
  const r = running.get(key(plugin, name));
  if (!r) return;
  r.streams = Math.max(0, r.streams + delta);
  r.lastUsed = Date.now();
}

export function serviceStatus(plugin: string, specs: ServiceSpec[]) {
  return specs.map((s) => {
    const r = running.get(key(plugin, s.name));
    return { name: s.name, description: s.description, command: [s.command, ...s.args].join(" "), running: !!r, startedAt: r?.startedAt ?? null, streams: r?.streams ?? 0, log: logs.get(key(plugin, s.name)) ?? [] };
  });
}
