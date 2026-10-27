/**
 * `omem tool` in an agent's shell: arguments from the command line, and the environment a run's
 * agent process gets so the command speaks with that run's token (same tools and spaces as MCP).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One JSON object, `key=value` pairs (a value that parses as JSON is JSON), or a file (`-` = stdin). */
export function toolArgs(rest: string[], file?: string): Record<string, unknown> {
  if (file) return object(readFileSync(file === "-" ? 0 : file, "utf8"));
  if (!rest.length) return {};
  if (rest.length === 1 && /^\s*\{/.test(rest[0])) return object(rest[0]);
  const out: Record<string, unknown> = {};
  for (const a of rest) {
    const i = a.indexOf("=");
    if (i <= 0) throw new Error(`参数要写成 键=值 或一个 JSON 对象：${a}`);
    const v = a.slice(i + 1);
    try { out[a.slice(0, i)] = JSON.parse(v); } catch { out[a.slice(0, i)] = v; }
  }
  return out;
}

function object(text: string) {
  const v = JSON.parse(text.trim() || "{}");
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("参数要是一个 JSON 对象");
  return v as Record<string, unknown>;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * An `omem` on the agent's PATH that runs this very omem (same node, same code), whatever is
 * installed globally; written once under <home>/bin.
 */
function shimDir(home: string) {
  const cli = [resolve(here, "../cli.js"), resolve(here, "../cli.ts")].find(existsSync);
  if (!cli) return null;
  const dir = join(home, "bin");
  const files: [string, string][] =
    process.platform === "win32"
      ? [["omem.cmd", `@"${process.execPath}" "${cli}" %*\r\n`]]
      : [["omem", `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`]];
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of files) {
      const f = join(dir, name);
      if (!existsSync(f) || readFileSync(f, "utf8") !== text) writeFileSync(f, text);
      if (process.platform !== "win32") chmodSync(f, 0o755);
    }
    return dir;
  } catch (e) {
    console.warn("[omem] 没能写 omem 命令垫片：", (e as Error).message);
    return null;
  }
}

/** Environment for an agent process of a run: its tool token, and `omem` on PATH. */
export function agentToolEnv(home: string, baseUrl: string, token: string): Record<string, string> {
  const env: Record<string, string> = { OMEM_URL: baseUrl, OMEM_TOKEN: token };
  const dir = shimDir(home);
  if (dir) {
    // Windows spells it Path; keep the one key the process already has.
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = [dir, process.env[key]].filter(Boolean).join(delimiter);
  }
  return env;
}
