import { existsSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { App } from "../core/app.ts";
import { saveConfig, type AgentProfile } from "../core/config.ts";
import { HttpError } from "../core/util.ts";
import { adapterJob, startTask, type AdapterJob } from "./adapter.ts";
import { forgetAvailability } from "./availability.ts";
import { fetchRegistry, installRegistryBinary, platformKey, type RegistryAgent } from "./catalog.ts";
import { probeProfile, saveProbe } from "./probe.ts";

/**
 * Backends added from the official ACP registry (settings → 添加 Agent → ACP 注册表) carry the version
 * they were added at: a downloaded program sits in `<home>/agents/<id>/<version>/`, an npx or uvx
 * profile names `<package>@<version>` / `<package>==<version>`. Nothing moves them on by itself, so
 * settings compares that version with the registry's and offers to upgrade: download the new program
 * (checked against the registry's sha256) and point the profile at it, or rewrite the package version.
 * The upgrade runs as a background job like an npm adapter's (agents/adapter.ts).
 */

export type RegistrySource =
  | { kind: "download"; registryId: string; version: string; dir: string }
  | { kind: "npx" | "uvx"; registryId: string; version: string; pkg: string; at: number };

/** Which registry agent and version a saved profile was added from, or null when it was not. */
export function registrySource(home: string, profile: Pick<AgentProfile, "id" | "command" | "args" | "transport" | "peer">): RegistrySource | null {
  if (profile.transport !== "acp" || profile.peer) return null;
  if (isAbsolute(profile.command)) {
    const root = resolve(home, "agents");
    const rel = relative(root, resolve(profile.command));
    const parts = rel.split(/[\\/]/);
    if (rel.startsWith("..") || isAbsolute(rel) || parts.length < 3) return null;
    return { kind: "download", registryId: parts[0], version: parts[1], dir: resolve(root, parts[0], parts[1]) };
  }
  if (profile.command === "npx") {
    const at = profile.args.findIndex((a) => !a.startsWith("-"));
    const m = at >= 0 ? /^(@?[^@]+)@(\d[\w.+-]*)$/.exec(profile.args[at]) : null;
    return m ? { kind: "npx", registryId: profile.id, version: m[2], pkg: m[1], at } : null;
  }
  if (profile.command === "uvx") {
    const at = profile.args.findIndex((a) => !a.startsWith("-"));
    const m = at >= 0 ? /^([\w.-]+)==([\w.+-]+)$/.exec(profile.args[at]) : null;
    return m ? { kind: "uvx", registryId: profile.id, version: m[2], pkg: m[1], at } : null;
  }
  return null;
}

let cache: { at: number; agents: RegistryAgent[] } | null = null;
async function registry(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 10 * 60_000) return cache.agents;
  cache = { at: Date.now(), agents: await fetchRegistry() };
  return cache.agents;
}
export function resetRegistryCacheForTests(agents?: RegistryAgent[]) {
  cache = agents ? { at: Date.now(), agents } : null;
}

/** Numeric parts compared in order (registry versions may be dates or long build numbers). */
export function versionNewer(a: string, b: string) {
  const pa = a.split(/[.+-]/), pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0), y = Number(pb[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) return a !== b;
    if (x !== y) return x > y;
  }
  return false;
}

function profileOf(app: App, id: string) {
  const p = app.config.agents.profiles.find((x) => x.id === id);
  const src = p && registrySource(app.home, p);
  return p && src ? { profile: p, src } : null;
}

/** Whether a backend was added from the ACP registry (settings shows the version block for it). */
export function isRegistryBackend(app: App, id: string) {
  return !!profileOf(app, id);
}

/** What the page shows: the same shape as an npm adapter's status (agents/adapter.ts AdapterStatus). */
export async function registryStatus(app: App, id: string, fresh = false) {
  const found = profileOf(app, id);
  if (!found) throw new HttpError(400, `${id} 不是从 ACP 注册表添加的后端`);
  const { src } = found;
  let latest: string | null = null, latestError: string | undefined, upgradable = false;
  try {
    const agent = (await registry(fresh)).find((a) => a.id === src.registryId);
    if (!agent) latestError = `ACP 注册表里已经没有 ${src.registryId}`;
    else {
      latest = agent.version;
      const way = src.kind === "download" ? agent.distribution.binary?.[platformKey()] : agent.distribution[src.kind];
      if (!way) latestError = `注册表的新版没有给这台机器（${platformKey()}）的${src.kind === "download" ? "程序" : ` ${src.kind} 包`}`;
      else upgradable = versionNewer(agent.version, src.version);
    }
  } catch (e) {
    latestError = (e as Error).message.slice(0, 300);
  }
  const label = src.kind === "download" ? `${src.registryId}（注册表下载的程序）` : src.pkg;
  return { id, package: label, version: src.version, prefix: null, latest, ...(latestError ? { latestError } : {}), upgradable, registry: null, via: src.kind, job: adapterJob(id) };
}

/** Rewrite one profile in the configuration (the rest stays as the owner set it). */
function saveProfile(app: App, id: string, patch: Partial<AgentProfile>) {
  const next = structuredClone(app.config);
  next.agents.profiles = next.agents.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p));
  saveConfig(next, app.home);
  Object.assign(app.config, next);
}

/** Older downloaded versions go; the one just replaced stays (a session that started on it may still be running). */
function pruneVersions(app: App, registryId: string, keep: string[]) {
  const root = resolve(app.home, "agents", registryId);
  if (!existsSync(root)) return;
  for (const v of readdirSync(root)) if (!keep.includes(v)) rmSync(resolve(root, v), { recursive: true, force: true });
}

/** Upgrade a registry backend to the registry's current version, in the background. */
export async function upgradeRegistryAgent(app: App, id: string) {
  const found = profileOf(app, id);
  if (!found) throw new HttpError(400, `${id} 不是从 ACP 注册表添加的后端`);
  const { src } = found;
  const agent = (await registry(true)).find((a) => a.id === src.registryId);
  if (!agent) throw new HttpError(404, `ACP 注册表里已经没有 ${src.registryId}`);
  if (!versionNewer(agent.version, src.version)) throw new HttpError(409, `${id} 已是注册表上的 ${agent.version}`);
  const target = src.kind === "download" ? agent.distribution.binary?.[platformKey()] : undefined;
  const launch = src.kind === "download" ? undefined : agent.distribution[src.kind];
  if (src.kind === "download" ? !target : !launch?.package) throw new HttpError(400, `注册表的 ${agent.version} 没有给这台机器（${platformKey()}）的运行方式`);
  const command = src.kind === "download" ? `下载 ${target!.archive}` : `${src.kind} ${launch!.package}`;
  return startTask(id, "upgrade", { package: src.kind === "download" ? src.registryId : src.pkg, via: src.kind, command, before: src.version }, async (job: AdapterJob) => {
    let patch: Partial<AgentProfile>;
    if (src.kind === "download") {
      const log = (s: string) => (job.output = `${job.output}\n${s}`.trim());
      const p = await installRegistryBinary(agent, target!, app.home, log);
      patch = { command: p.command, args: p.args, env: { ...(found.profile.env ?? {}), ...(p.env ?? {}) } };
      log(`已解压到 ${resolve(app.home, "agents", agent.id, agent.version)}${sep}`);
    } else {
      // The registry's arguments for that version: the package spec first, then what the agent needs.
      const args = [...found.profile.args.slice(0, src.at), launch!.package!, ...(launch!.args ?? [])];
      patch = { args, env: { ...(found.profile.env ?? {}), ...(launch!.env ?? {}) } };
      job.output = `${src.kind} 下次启动时取 ${launch!.package}`;
    }
    saveProfile(app, id, patch);
    forgetAvailability();
    job.after = agent.version;
    job.ok = true;
    // An npx / uvx package is fetched when it next starts: probing now would download it inside the job.
    if (src.kind !== "download") return;
    pruneVersions(app, src.registryId, [agent.version, src.version]);
    const profile = app.config.agents.profiles.find((p) => p.id === id)!;
    job.probe = await probeProfile(profile, app);
    if (!job.probe.error) saveProbe(app, id, job.probe);
  });
}

/** The upgrade settings and the `agent-upgrade` peer command start: an npm adapter, or a registry backend. */
export async function upgradeBackend(app: App, id: string, version?: string) {
  const { hasAdapter, upgradeAdapter } = await import("./adapter.ts");
  if (hasAdapter(app, id) || !isRegistryBackend(app, id)) return upgradeAdapter(app, id, version);
  if (version !== undefined) throw new HttpError(400, "从 ACP 注册表添加的后端只能升到注册表上的版本，不能指定 version");
  return upgradeRegistryAgent(app, id);
}
