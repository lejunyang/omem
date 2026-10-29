import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { commandExists } from "../agents/spawn.ts";

/**
 * External programs omem calls (uv for Docling and the judge's Python side,
 * llama-server for the judge, aad for desktop and browser control). Use the one
 * on PATH when there is one; otherwise run osdk's managed copy through
 * `osdk exec`, so the user never has to put osdk shims on PATH or select a
 * version by hand.
 *
 * uv comes from conda-forge first: a standalone binary that needs no Python.
 * `pypi:uv` installs into a venv and so needs an osdk-managed Python, and on
 * some machines its venv points outside the install dir and osdk refuses it;
 * it stays as a fallback for an existing install.
 */
export const OSDK_TOOLS: Record<string, string[]> = {
  uv: ["conda:uv", "pypi:uv"],
  uvx: ["conda:uv", "pypi:uv"],
  "llama-server": ["conda:llama.cpp"],
  aad: ["github:lejunyang/ai-auto-desktop"],
};
/** The package a tool is installed from (the first candidate). */
export const installSpec = (name: string) => OSDK_TOOLS[name]?.[0];

/**
 * Tools that osdk installs as a plain directory of programs (a GitHub release archive): found by
 * looking in the install directory, not through `osdk exec`. The release ships `aad` next to its
 * helpers (`aad-browser`, the platform helpers), which must stay together, so the directory is what
 * agents get on PATH.
 */
const DIR_TOOLS = new Set(["aad"]);

/** `-o` options for `osdk install` of a tool on this machine. */
export function installOptions(name: string, platform: string = process.platform, arch: string = process.arch): string[] {
  // osdk cannot choose between the GNU and the musl Linux archives of one release; the static musl one runs on any distribution.
  if (name === "aad" && platform === "linux") return ["-o", `asset-template=aad-{version}-${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl.tar.gz`];
  return [];
}

let override: ((name: string) => string[] | null) | null = null;
/** Tests: decide how a tool is invoked. */
export function setToolResolverForTests(fn: ((name: string) => string[] | null) | null) {
  override = fn;
}

/** argv prefix that runs `name`, or null when neither PATH nor osdk can provide it. */
export function toolCommand(name: string): string[] | null {
  if (override) return override(name);
  if (DIR_TOOLS.has(name) ? pathWorks(name) : commandExists(name)) return [name];
  if (!commandExists("osdk")) return null;
  if (DIR_TOOLS.has(name)) {
    const dir = osdkToolDir(name);
    return dir ? [join(dir, name + (process.platform === "win32" ? ".exe" : ""))] : null;
  }
  const spec = (OSDK_TOOLS[name] ?? []).find(osdkHas);
  return spec ? ["osdk", "exec", "--no-deps", "-t", spec, "--", name] : null;
}

const works = new Map<string, { at: number; ok: boolean }>();
/**
 * A program on PATH that runs. osdk puts a shim for every tool it has ever installed on PATH, and
 * the shim exits with "no backend provides" while the tool is not the selected one, so presence is no proof.
 */
function pathWorks(name: string) {
  const hit = works.get(name);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.ok;
  const ok = commandExists(name) && spawnSync(name, ["--version"], { windowsHide: true, timeout: 15_000, shell: process.platform === "win32", stdio: "ignore" }).status === 0;
  works.set(name, { at: Date.now(), ok });
  return ok;
}

const known = new Map<string, boolean>();
/** Installed and runnable: `osdk where` alone also answers for half-finished installs. */
function osdkHas(spec: string) {
  if (!known.has(spec)) {
    const opts = { encoding: "utf8" as const, windowsHide: true, shell: process.platform === "win32", timeout: 30_000 };
    const where = spawnSync("osdk", ["where", spec], opts);
    const bin = spec === "conda:llama.cpp" ? "llama-server" : spec.split(":")[1];
    known.set(spec, where.status === 0 && spawnSync("osdk", ["exec", "--no-deps", "-t", spec, "--", bin, "--version"], opts).status === 0);
  }
  return known.get(spec)!;
}

const dirs = new Map<string, { at: number; dir: string | null }>();
const DIR_TTL_MS = 60_000;
const DIR_MISS_TTL_MS = 600_000;
/**
 * Where osdk keeps the programs of a directory tool: the newest complete install under osdk's install
 * directory. An install made with options (the Linux asset template) has a different key than the
 * package's default selection, so `osdk where` alone cannot be trusted to find it; it is the fallback
 * when the install directory cannot be read.
 */
function osdkToolDir(name: string): string | null {
  const hit = dirs.get(name);
  if (hit && Date.now() - hit.at < (hit.dir ? DIR_TTL_MS : DIR_MISS_TTL_MS)) return hit.dir;
  const exe = name + (process.platform === "win32" ? ".exe" : "");
  const run = (args: string[]) => spawnSync("osdk", args, { encoding: "utf8", windowsHide: true, shell: process.platform === "win32", timeout: 30_000 });
  const spec = installSpec(name)!;
  let dir: string | null = null;
  const root = /install_dir\s*:\s*(.+)/.exec(run(["doctor"]).stdout ?? "")?.[1]?.trim();
  const base = root && join(root, "github", ...spec.slice(spec.indexOf(":") + 1).split("/"));
  if (base && existsSync(base)) {
    const found: { dir: string; version: string }[] = [];
    for (const v of readdirSync(base)) for (const key of existsSync(join(base, v)) ? readdirSync(join(base, v)) : []) if (existsSync(join(base, v, key, exe))) found.push({ dir: join(base, v, key), version: v });
    found.sort((x, y) => x.version.localeCompare(y.version, undefined, { numeric: true }));
    dir = found.at(-1)?.dir ?? null;
  }
  if (!dir) {
    const where = run(["where", spec]);
    const first = where.status === 0 ? (where.stdout ?? "").trim().split("\n").pop()?.trim() : "";
    if (first && existsSync(join(first, exe))) dir = first;
  }
  dirs.set(name, { at: Date.now(), dir });
  return dir;
}

/** Install a tool through osdk (no-op when it is already there). Returns whether it is usable afterwards. */
export function installTool(name: string, opts: { inherit?: boolean } = {}) {
  const spec = installSpec(name);
  if (!spec || !commandExists("osdk")) return !!toolCommand(name);
  const r = spawnSync("osdk", ["install", spec, ...installOptions(name)], { stdio: opts.inherit ? "inherit" : "pipe", windowsHide: true, shell: process.platform === "win32" });
  for (const s of OSDK_TOOLS[name]) known.delete(s);
  dirs.delete(name);
  works.delete(name);
  return r.status === 0 && !!toolCommand(name);
}

/** What `name --version` prints (the first version-looking token), or null when it cannot run. */
export function toolVersion(name: string): string | null {
  const cmd = toolCommand(name);
  if (!cmd) return null;
  const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8", windowsHide: true, timeout: 15_000, shell: false });
  if (r.status !== 0) return null;
  return /\d+\.\d+\.\d+[\w.+-]*/.exec(`${r.stdout ?? ""}`)?.[0] ?? null;
}

/** Whether a tool is usable and how it is reached: on PATH, or in osdk's install directory. */
export function toolStatus(name: string): { installed: boolean; version: string | null; via: "path" | "osdk" | null } {
  const cmd = toolCommand(name);
  if (!cmd) return { installed: false, version: null, via: null };
  return { installed: true, version: toolVersion(name), via: override ? "osdk" : cmd.length === 1 && cmd[0] === name ? "path" : "osdk" };
}

/** Desktop and browser control (ai-auto-desktop's `aad`): the one place the rest of omem asks about it. */
export const desktopControl = {
  spec: () => installSpec("aad")!,
  status: () => toolStatus("aad"),
};

/**
 * Directories put at the front of PATH for agent processes, so an installed tool that is not on the
 * owner's PATH (aad, found through osdk) still works by name from an agent's shell.
 */
export function agentPathDirs(): string[] {
  if (override) return [];
  const out: string[] = [];
  for (const name of DIR_TOOLS) {
    if (pathWorks(name) || !commandExists("osdk")) continue;
    const dir = osdkToolDir(name);
    if (dir) out.push(dir);
  }
  return out;
}

/** `env` with the agent tool directories at the front of its PATH (whatever case the platform spells the key in). */
export function withAgentPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra = agentPathDirs();
  if (!extra.length) return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return { ...env, [key]: [...extra, env[key]].filter(Boolean).join(delimiter) };
}
