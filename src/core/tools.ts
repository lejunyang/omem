import { spawnSync } from "node:child_process";
import { commandExists } from "../agents/spawn.ts";

/**
 * External programs omem calls (uv for Docling and the judge's Python side,
 * llama-server for the judge). Use the one on PATH when there is one;
 * otherwise run osdk's managed copy through `osdk exec`, so the user never has
 * to put osdk shims on PATH or select a version by hand.
 */
export const OSDK_TOOLS: Record<string, string> = {
  uv: "pypi:uv",
  uvx: "pypi:uv",
  "llama-server": "conda:llama.cpp",
};

let override: ((name: string) => string[] | null) | null = null;
/** Tests: decide how a tool is invoked. */
export function setToolResolverForTests(fn: ((name: string) => string[] | null) | null) {
  override = fn;
}

/** argv prefix that runs `name`, or null when neither PATH nor osdk can provide it. */
export function toolCommand(name: string): string[] | null {
  if (override) return override(name);
  if (commandExists(name)) return [name];
  const spec = OSDK_TOOLS[name];
  if (spec && commandExists("osdk") && osdkHas(spec)) return ["osdk", "exec", "--no-deps", "-t", spec, "--", name];
  return null;
}

const known = new Map<string, boolean>();
function osdkHas(spec: string) {
  if (!known.has(spec)) {
    const r = spawnSync("osdk", ["where", spec], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32", timeout: 15_000 });
    known.set(spec, r.status === 0);
  }
  return known.get(spec)!;
}

/** Install a tool through osdk (no-op when it is already there). Returns whether it is usable afterwards. */
export function installTool(name: string, opts: { inherit?: boolean } = {}) {
  const spec = OSDK_TOOLS[name];
  if (!spec || !commandExists("osdk")) return !!toolCommand(name);
  const r = spawnSync("osdk", ["install", spec], { stdio: opts.inherit ? "inherit" : "pipe", windowsHide: true, shell: process.platform === "win32" });
  known.delete(spec);
  return r.status === 0 && !!toolCommand(name);
}
