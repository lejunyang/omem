import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "./app.ts";
import { one, run } from "./db.ts";
import type { StorageReport } from "./storage-scan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "storage_report";
let running: { startedAt: string; done: Promise<void> } | null = null;
let lastError: string | null = null;

/** The latest scan (kept in kv across restarts) and whether one is running. */
export function storageStatus(app: App) {
  const raw = one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value;
  return { report: raw ? (JSON.parse(raw) as StorageReport) : null, running: running?.startedAt ?? null, error: lastError };
}

/** Start a scan in a child process (its memory and page reads stay out of the server) unless one is running. */
export function startStorageScan(app: App) {
  if (running) return running.done;
  const js = resolve(here, "storage-scan.js");
  const file = existsSync(js) ? js : resolve(here, "storage-scan.ts");
  const done = new Promise<void>((ok) => {
    execFile(process.execPath, [file, app.home], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      lastError = null;
      try {
        if (err) throw new Error(stderr.trim().split("\n").pop() || err.message);
        run(app.db, "insert or replace into kv(key, value) values(?, ?)", KEY, JSON.stringify(JSON.parse(stdout) as StorageReport));
      } catch (e) {
        lastError = (e as Error).message;
      }
      running = null;
      ok();
    });
  });
  running = { startedAt: new Date().toISOString(), done };
  return done;
}
