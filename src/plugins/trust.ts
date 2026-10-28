import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { App } from "../core/app.ts";
import { now } from "../core/util.ts";

/**
 * Trust for plugins in the data directory that bring code (docs/v2/plugins.md): a server.ts or
 * services run with the owner's rights, so nothing of them runs until the owner confirms. What is
 * confirmed is a hash of the plugin's code: the manifest (its services' commands) and every file
 * outside web/, agents/, skills/ and node_modules/. A changed hash needs confirming again. Records
 * are per device (secrets/plugin-trust.json), like the code itself.
 */
const SKIP = new Set(["web", "agents", "skills", "node_modules", ".git"]);
/** Large files (a bundled binary) count by size and time, not content. */
const BIG = 50 * 1024 * 1024;

export function codeFiles(dir: string) {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d === dir && SKIP.has(e.name)) continue;
      if (e.name === ".git" || e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function codeHash(dir: string) {
  const h = createHash("sha256");
  for (const f of codeFiles(dir)) {
    const st = statSync(f);
    h.update(relative(dir, f).replace(/\\/g, "/") + "\0");
    h.update(st.size > BIG ? `${st.size}:${st.mtimeMs}` : readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

type Record = { hash: string; at: string };
const file = (app: App) => join(app.home, "secrets", "plugin-trust.json");

function read(app: App): { [id: string]: Record } {
  try {
    return existsSync(file(app)) ? JSON.parse(readFileSync(file(app), "utf8")) : {};
  } catch {
    return {};
  }
}
function write(app: App, all: { [id: string]: Record }) {
  mkdirSync(join(app.home, "secrets"), { recursive: true });
  writeFileSync(file(app), JSON.stringify(all, null, 2));
  try {
    chmodSync(file(app), 0o600);
  } catch {}
}

/** trusted: confirmed and unchanged; changed: confirmed, but the code is not what was confirmed; required: never confirmed. */
export function trustState(app: App, id: string, dir: string): "trusted" | "changed" | "required" {
  const r = read(app)[id];
  if (!r) return "required";
  return r.hash === codeHash(dir) ? "trusted" : "changed";
}

export function setTrust(app: App, id: string, dir: string | null) {
  const all = read(app);
  if (dir) all[id] = { hash: codeHash(dir), at: now() };
  else delete all[id];
  write(app, all);
}
