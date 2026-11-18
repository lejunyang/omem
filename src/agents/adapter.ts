import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { App } from "../core/app.ts";
import { adapterPackage, adapterPrefix } from "../core/peer-inspect.ts";
import { HttpError } from "../core/util.ts";
import { catalogEntry } from "./catalog.ts";
import { probeProfile, saveProbe } from "./probe.ts";
import { listAgentProfiles } from "./runner.ts";

/**
 * The npm package behind a catalog ACP backend (codex-acp, claude-agent-acp…): which version is
 * installed, which is the newest, and upgrading it in place. Shared by settings → AI and the
 * `agent-upgrade` peer command. Only a catalog package already installed globally here: nothing new
 * gets onto the machine, and never an arbitrary package.
 */

const run = promisify(execFile);
const npm = (args: string[], cwd: string, timeout: number) =>
  // npm is a .cmd shim on Windows: it needs a shell there (the arguments are checked, never free text).
  run("npm", args, { cwd, timeout, maxBuffer: 20_000_000, shell: process.platform === "win32" });

const registry = async () => {
  const { publicNpmRegistry } = await import("../core/peer-exec.ts");
  return publicNpmRegistry((await import("../setup.ts")).packageRoot());
};

function installed(app: App, id: string) {
  const entry = catalogEntry(id);
  const profile = listAgentProfiles(app).find((p) => p.id === id);
  if (!entry?.npm || !profile || profile.command !== entry.command) throw new HttpError(400, `${id} 不是目录里带 npm 包的后端`);
  const pkg = adapterPackage(profile);
  if (pkg?.via !== "installed" || pkg.name !== entry.npm) throw new HttpError(400, `${id} 的适配器不是全局安装的 ${entry.npm}，不在这里升级`);
  return { entry, profile, pkg, npmName: entry.npm };
}

/** Whether a backend has an npm adapter here at all (settings shows the block only then). */
export function hasAdapter(app: App, id: string) {
  try {
    installed(app, id);
    return true;
  } catch {
    return false;
  }
}

const newer = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

export type AdapterStatus = { id: string; package: string; version: string | null; prefix: string | null; latest: string | null; latestError?: string; upgradable: boolean; registry: string | null };

/** The installed version and npm's newest (asked from the public registry in osdk.toml). */
export async function adapterStatus(app: App, id: string): Promise<AdapterStatus> {
  const { profile, pkg, npmName } = installed(app, id);
  const reg = await registry();
  let latest: string | null = null, latestError: string | undefined;
  try {
    const r = await npm(["view", npmName, "version", ...(reg ? [`--registry=${reg}`] : [])], app.home, 30_000);
    latest = r.stdout.trim().split("\n").at(-1)?.trim() || null;
  } catch (e) {
    latestError = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").slice(-2).join(" ").slice(0, 300);
  }
  return { id, package: npmName, version: pkg.version, prefix: adapterPrefix(profile), latest, ...(latestError ? { latestError } : {}), upgradable: !!(latest && pkg.version && newer(latest, pkg.version)), registry: reg };
}

const upgrading = new Set<string>();

/**
 * `npm i -g <package>@<version|latest>` into the prefix the command is found in (omem's own npm may
 * have another global prefix, and then the copy in use would stay old), from the public registry.
 * An exact version also lifts a minimum-release-age policy for this install only. A successful
 * upgrade probes the backend again, so new models and efforts show at once.
 */
export async function upgradeAdapter(app: App, id: string, version?: string) {
  const { profile, pkg, npmName } = installed(app, id);
  if (version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new HttpError(400, "version 要写成 1.2.3");
  if (upgrading.has(id)) throw new HttpError(409, `${id} 正在升级`);
  upgrading.add(id);
  try {
    const reg = await registry();
    const prefix = adapterPrefix(profile);
    const pin = version ? ["--min-release-age=0", `--before=${new Date().toISOString()}`] : [];
    let code = 0, output = "";
    try {
      const r = await npm(["i", "-g", `${npmName}@${version ?? "latest"}`, ...(prefix ? [`--prefix=${prefix}`] : []), ...(reg ? [`--registry=${reg}`] : []), ...pin], app.home, 600_000);
      output = r.stdout + r.stderr;
    } catch (e) {
      code = (e as { code?: number }).code ?? 1;
      output = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? (e as Error).message);
    }
    const after = adapterPackage(profile)?.version ?? null;
    const ok = code === 0 && (version ? after === version : true);
    let probe: Awaited<ReturnType<typeof probeProfile>> | undefined;
    if (ok && after !== pkg.version) {
      probe = await probeProfile(profile, app);
      if (!probe.error) saveProbe(app, id, probe);
    }
    return { ok, package: npmName, before: pkg.version, after, prefix, registry: reg ?? "（这台机器的 npm 设置）", output: output.split("\n").slice(-15).join("\n"), ...(probe ? { probe } : {}) };
  } finally {
    upgrading.delete(id);
  }
}
