import { spawnSync } from "node:child_process";
import { commandExists } from "../agents/spawn.ts";

/**
 * External programs omem calls (uv for Docling and the judge's Python side,
 * llama-server for the judge). Use the one on PATH when there is one;
 * otherwise run osdk's managed copy through `osdk exec`, so the user never has
 * to put osdk shims on PATH or select a version by hand.
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
};
/** The package a tool is installed from (the first candidate). */
export const installSpec = (name: string) => OSDK_TOOLS[name]?.[0];

let override: ((name: string) => string[] | null) | null = null;
/** Tests: decide how a tool is invoked. */
export function setToolResolverForTests(fn: ((name: string) => string[] | null) | null) {
  override = fn;
}

/** argv prefix that runs `name`, or null when neither PATH nor osdk can provide it. */
export function toolCommand(name: string): string[] | null {
  if (override) return override(name);
  if (commandExists(name)) return [name];
  if (!commandExists("osdk")) return null;
  const spec = (OSDK_TOOLS[name] ?? []).find(osdkHas);
  return spec ? ["osdk", "exec", "--no-deps", "-t", spec, "--", name] : null;
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

/** Install a tool through osdk (no-op when it is already there). Returns whether it is usable afterwards. */
export function installTool(name: string, opts: { inherit?: boolean } = {}) {
  const spec = installSpec(name);
  if (!spec || !commandExists("osdk")) return !!toolCommand(name);
  const r = spawnSync("osdk", ["install", spec], { stdio: opts.inherit ? "inherit" : "pipe", windowsHide: true, shell: process.platform === "win32" });
  for (const s of OSDK_TOOLS[name]) known.delete(s);
  return r.status === 0 && !!toolCommand(name);
}
