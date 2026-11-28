import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { json } from "../core/util.ts";

/**
 * What a turn sent its agent, kept for the run page (“上下文” → 看提示词): the standing instructions
 * and the message. Text is stored by its hash under `<home>/prompt-log`, gzipped, so the instructions
 * a background role gets every few minutes are one file; the `prompt` event keeps the hashes. Files
 * not used for `agents.promptLog.days` are removed. Local to this machine (not part of pull or backup).
 */

/** A message can be a whole diff; past this it is cut (the run's own input still has the task). */
export const PROMPT_LOG_MAX = 400_000;

const dir = (app: App) => join(app.home, "prompt-log");
const fileOf = (app: App, hash: string) => join(dir(app), hash.slice(0, 2), `${hash}.gz`);
const HASH = /^[0-9a-f]{32}$/;

function keep(app: App, text: string): string {
  const cut = text.length > PROMPT_LOG_MAX ? `${text.slice(0, PROMPT_LOG_MAX)}\n\n…（后面还有 ${text.length - PROMPT_LOG_MAX} 字没有保留）` : text;
  const hash = createHash("sha256").update(cut).digest("hex").slice(0, 32);
  const file = fileOf(app, hash);
  if (existsSync(file)) {
    // Used again: its age counts from now.
    const at = new Date();
    try { utimesSync(file, at, at); } catch {}
  } else {
    mkdirSync(join(dir(app), hash.slice(0, 2)), { recursive: true });
    writeFileSync(file, gzipSync(cut));
  }
  return hash;
}

export type PromptTexts = { system?: string; message: string };
export type PromptKept = { system?: string; message?: string };

/**
 * A `prompt` event as it is stored: the texts it came with (types.ts sessionPrompt) are put in the
 * log and replaced by their hashes, or dropped when the log is off or cannot be written.
 */
export function keepPromptTexts(app: App, data: unknown): unknown {
  const { texts, ...rest } = data as { texts?: PromptTexts } & Record<string, unknown>;
  if (!texts || !app.config.agents.promptLog.enabled) return rest;
  try {
    const kept: PromptKept = { ...(texts.system ? { system: keep(app, texts.system) } : {}), message: keep(app, texts.message) };
    return { ...rest, kept };
  } catch (e) {
    console.warn("[omem] 保存提示词原文失败：", (e as Error).message);
    return rest;
  }
}

function read(app: App, hash: string | undefined): string | null {
  if (!hash || !HASH.test(hash)) return null;
  try {
    return gunzipSync(readFileSync(fileOf(app, hash))).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The texts of one `prompt` event of a run. `systemSent`: whether the instructions went with this
 * turn; a turn that continued a session did not send them again, and `system` is then what a new
 * session would have got at that moment (the session's own start may have differed a little).
 */
export function promptOfEvent(app: App, runId: string, seq: number) {
  const row = one<{ data: string }>(app.db, "select data from run_events where run_id = ? and seq = ? and type = 'prompt'", runId, seq);
  if (!row) return null;
  const d = json<{ kept?: PromptKept; via?: string; systemSent?: boolean }>(row.data, {});
  const system = read(app, d.kept?.system);
  const message = read(app, d.kept?.message);
  return { seq, via: d.via ?? "none", systemSent: !!d.systemSent, system, message, kept: !!d.kept, expired: !!d.kept && message === null, days: app.config.agents.promptLog.days };
}

/** Removes texts no turn has used for `agents.promptLog.days` (hourly, main.ts). */
export function prunePromptLog(app: App, at = Date.now()) {
  const root = dir(app);
  if (!existsSync(root)) return 0;
  const before = at - app.config.agents.promptLog.days * 86_400_000;
  let removed = 0;
  for (const sub of readdirSync(root)) {
    const folder = join(root, sub);
    let names: string[];
    try { names = readdirSync(folder); } catch { continue; }
    for (const name of names) {
      const file = join(folder, name);
      try {
        if (statSync(file).mtimeMs < before) { rmSync(file); removed++; }
      } catch {}
    }
  }
  return removed;
}
