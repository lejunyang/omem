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

/** isolated: its code runs in its own process with Node's permission model (sandbox.ts); inprocess: inside omem, with omem's rights. */
export type RunMode = "isolated" | "inprocess";
/** `dir`: a linked plugin (links.ts) is trusted by its directory, so editing it needs no new confirmation. */
type NotifyGrants = { ask: boolean; deliver: boolean };
type FlowGrants = { [name: string]: boolean | undefined };
/** `permanent`: the owner trusts this plugin whatever it becomes (its code, declarations and grants change without asking again). */
type Record = { credentialDeclarations?: string; credentialHash?: string; embedder?: boolean; backends?: string; flow?: FlowGrants; notify?: NotifyGrants; hash: string; at: string; mode?: RunMode; dir?: string; permanent?: boolean };
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
export function trustState(app: App, id: string, dir: string, linked = false, notify?: NotifyGrants, embedder = false, backends: unknown[] = [], flow?: FlowGrants, credential = false): "trusted" | "changed" | "required" {
  const r = read(app)[id];
  if (!r) return "required";
  // Trusted for good: later code, declarations and grants load without asking. A linked plugin still
  // only from the directory it was trusted in (another directory is other code).
  if (r.permanent) return !linked || !r.dir || r.dir === dir ? "trusted" : "changed";
  if (linked && (credential || r.credentialHash) && r.credentialHash !== codeHash(dir)) return "changed";
  if (linked && (backends.length || r.backends && r.backends !== "[]") && r.backends !== JSON.stringify(backends)) return "changed";
  // A trust by directory holds only for that linked directory; a copy (or another directory) is checked by its code.
  if (linked && ((embedder && !r.embedder) || (notify?.ask && !r.notify?.ask) || (notify?.deliver && !r.notify?.deliver))) return "changed";
  if (linked && Object.entries(flow ?? {}).some(([key, granted]) => granted && !r.flow?.[key])) return "changed";
  if (linked || r.dir) return linked && r.dir === dir ? "trusted" : "changed";
  return r.hash === codeHash(dir) ? "trusted" : "changed";
}

/** Bind the actual grants too: a plugin can derive its declarations from settings at load time. */
export function acceptCredentialDeclarations(app: App, id: string, declarations: unknown[]) {
  const records = read(app);
  const record = records[id];
  const fingerprint = createHash("sha256").update(JSON.stringify(declarations)).digest("hex");
  if (record.credentialDeclarations !== undefined && !record.permanent) return record.credentialDeclarations === fingerprint;
  record.credentialDeclarations = fingerprint;
  write(app, records);
  return true;
}

/** How the owner chose to run it; plugins trusted before there was a choice ran inside omem. */
export const trustMode = (app: App, id: string): RunMode => {
  const r = read(app)[id];
  return r ? (r.mode ?? "inprocess") : "isolated";
};

/** `permanent`: undefined keeps what was chosen before (trusting again after a change does not drop it). */
export function setTrust(app: App, id: string, dir: string | null, mode: RunMode = "isolated", linked = false, notify?: NotifyGrants, embedder = false, backends: unknown[] = [], flow?: FlowGrants, credential = false, permanent?: boolean) {
  const all = read(app);
  const keep = permanent ?? all[id]?.permanent;
  const forGood = keep ? { permanent: true } : {};
  if (dir && linked) all[id] = { credentialHash: credential ? codeHash(dir) : undefined, hash: "", at: now(), mode, dir, notify, embedder, flow, backends: JSON.stringify(backends), ...forGood };
  else if (dir) all[id] = { hash: codeHash(dir), at: now(), mode, ...forGood };
  else delete all[id];
  write(app, all);
}

/** Whether the owner trusts this plugin for good (setTrust's `permanent`). */
export const trustPermanent = (app: App, id: string) => !!read(app)[id]?.permanent;

/** Turn trust-for-good on or off for a plugin already trusted, without reloading it. */
export function setTrustPermanent(app: App, id: string, permanent: boolean) {
  const all = read(app);
  if (!all[id]) return;
  if (permanent) all[id].permanent = true;
  else delete all[id].permanent;
  write(app, all);
}
