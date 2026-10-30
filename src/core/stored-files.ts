import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "./app.ts";
import { one } from "./db.ts";

/**
 * Stored originals (files/<hash>.<ext>) are referenced by name everywhere: Feishu message
 * resources, `meta.original`, `meta.media`, `omem-file:` links in source text. Compressing a
 * file (media.ts) never rewrites those references; it records `original → file` in
 * `file_variants`, and everything that opens a stored file goes through here.
 *
 * The original wins while it is still on disk (compressed but not yet deleted).
 */
export function storedName(app: App, name: string): string | null {
  if (existsSync(join(app.filesDir, name))) return name;
  const v = one<{ file: string }>(app.db, "select file from file_variants where original = ? and status = 'done'", name)?.file;
  return v && existsSync(join(app.filesDir, v)) ? v : null;
}

/** Path of what a stored name opens to, or null when neither the original nor a compressed copy is there. */
export function storedPath(app: App, name: string): string | null {
  const n = storedName(app, name);
  return n ? join(app.filesDir, n) : null;
}

export const hasStoredFile = (app: App, name: string) => storedName(app, name) !== null;

/** Set when a new file lands in files/ (keepOriginal); media.ts's auto compression looks only then. */
let added = true;
export const markStoredFileAdded = () => { added = true; };
export function takeStoredFileAdded() {
  const was = added;
  added = false;
  return was;
}
