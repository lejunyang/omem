import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { HttpError, json, now } from "../core/util.ts";
import { deleteSource, sourceText, upsertSource } from "./store.ts";

/**
 * Working files: originals an agent writes while it works — the current results of a long task
 * (which chats were scanned, what was found so far), or a report built up day by day by a
 * scheduled rule. Stored as sources (kind "work", uri "work/<path>") so they can be searched,
 * read and cited like anything else; not ingested into memories (they are already derived).
 * A file may be tied to an item or a rule, and may expire: an expired file leaves a tombstone.
 */
export type WorkLinks = { item?: string; rule?: string };
export type WorkMeta = { expiresAt?: string | null; links?: WorkLinks; runId?: string | null; writes?: number };

const MAX = 400_000;

export function workUri(path: string) {
  const clean = path
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .join("/")
    .replace(/^work\//, "");
  if (!clean) throw new HttpError(400, "工作文件需要路径，如 oncall/群清单 或 weekly/2026-W43");
  return `work/${clean}`;
}

/** "30d", "12h", a date or ISO time; null/"never" = keep. */
export function expiryFrom(keep: string | number | null | undefined, from = Date.now()): string | null | undefined {
  if (keep === undefined) return undefined;
  if (keep === null || keep === "never" || keep === 0) return null;
  if (typeof keep === "number") return new Date(from + keep * 86400_000).toISOString();
  const m = /^(\d+(?:\.\d+)?)\s*([dhw])$/i.exec(keep.trim());
  if (m) return new Date(from + Number(m[1]) * { d: 86400_000, h: 3600_000, w: 7 * 86400_000 }[m[2].toLowerCase() as "d" | "h" | "w"]).toISOString();
  const t = Date.parse(keep);
  if (Number.isNaN(t)) throw new HttpError(400, `看不懂过期时间：${keep}（用 30d、12h、2w、日期或 never）`);
  return new Date(t).toISOString();
}

export function writeWorkFile(
  app: App,
  input: { spaceId: string; path: string; title?: string; text: string; mode?: "replace" | "append"; expires?: string | number | null; links?: WorkLinks; runId?: string | null },
) {
  const uri = workUri(input.path);
  const prev = all<{ id: string; title: string; meta: string; deleted_at: string | null }>(app.db, "select id, title, meta, deleted_at from sources where space_id = ? and uri = ?", input.spaceId, uri)[0];
  const alive = prev && !prev.deleted_at ? prev : undefined;
  const meta = (alive ? json(alive.meta, {}) : {}) as WorkMeta;
  const before = alive ? sourceText(app, alive.id) : "";
  const body = input.text.replace(/\r\n?/g, "\n").trimEnd();
  const text = input.mode === "append" && before ? `${before.trimEnd()}\n\n${body}` : body;
  if (text.length > MAX) throw new HttpError(400, `工作文件太长（${text.length} 字，上限 ${MAX}）：整理精简，或按时间拆成几个文件`);
  const expiresAt = expiryFrom(input.expires);
  const links = { ...(meta.links ?? {}), ...Object.fromEntries(Object.entries(input.links ?? {}).filter(([, v]) => v)) };
  const title = input.title?.trim() || alive?.title || uri.split("/").pop()!;
  const r = upsertSource(app, {
    spaceId: input.spaceId,
    kind: "work",
    uri,
    title,
    mime: "text/markdown",
    text,
    meta: { ...meta, expiresAt: expiresAt === undefined ? (meta.expiresAt ?? null) : expiresAt, links, runId: input.runId ?? meta.runId ?? null, writes: (meta.writes ?? 0) + 1 },
  });
  return { ...r, uri, created: !alive, expiresAt: expiresAt === undefined ? (meta.expiresAt ?? null) : expiresAt, lines: text.split("\n").length };
}

export type WorkFile = { id: string; spaceId: string; uri: string; title: string; updatedAt: string; expiresAt: string | null; links: WorkLinks; lines: number };

/** Live working files tied to an item or a rule (or all of them in some spaces). */
export function listWorkFiles(app: App, opts: { item?: string; rule?: string; spaces?: string[] | null; limit?: number } = {}): WorkFile[] {
  const where = ["kind = 'work'", "deleted_at is null"];
  const params: string[] = [];
  if (opts.item) where.push("json_extract(meta, '$.links.item') = ?"), params.push(opts.item);
  if (opts.rule) where.push("json_extract(meta, '$.links.rule') = ?"), params.push(opts.rule);
  if (opts.spaces) where.push(`space_id in (${opts.spaces.map(() => "?").join(",") || "''"})`), params.push(...opts.spaces);
  return all<{ id: string; space_id: string; uri: string; title: string; updated_at: string; meta: string; n: number }>(
    app.db,
    `select id, space_id, uri, title, updated_at, meta, length(text) - length(replace(text, char(10), '')) + 1 n from sources where ${where.join(" and ")} order by updated_at desc limit ?`,
    ...params,
    opts.limit ?? 50,
  ).map((r) => {
    const m = json(r.meta, {}) as WorkMeta;
    return { id: r.id, spaceId: r.space_id, uri: r.uri, title: r.title, updatedAt: r.updated_at, expiresAt: m.expiresAt ?? null, links: m.links ?? {}, lines: r.n };
  });
}

/** One line per file, for a task prompt or a tool result. */
export function workFileLines(files: WorkFile[]) {
  return files.map((f) => `- src:${f.id} ${f.uri}「${f.title}」${f.lines} 行，${f.updatedAt.slice(0, 16)} 更新${f.expiresAt ? `，${f.expiresAt.slice(0, 10)} 过期` : ""}`).join("\n");
}

/** Expired working files become tombstones (heartbeat). */
export function expireWorkFiles(app: App, at = now()) {
  const due = all<{ id: string }>(app.db, "select id from sources where kind = 'work' and deleted_at is null and json_extract(meta, '$.expiresAt') is not null and json_extract(meta, '$.expiresAt') < ?", at);
  for (const r of due) deleteSource(app, r.id);
  return due.length;
}
