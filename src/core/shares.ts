import { createHash, randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { canonicalSourceId } from "../sources/duplicates.ts";
import { HttpError, json, newId, now } from "./util.ts";
import { accessibleSpaces, OWNER } from "./users.ts";
import { readPage } from "../wiki/store.ts";

/**
 * Read-only share links for what a message sent outside omem cites (docs/v2/architecture.md,
 * “分享链接”). A Feishu answer cannot point at omem's own sources, memories or pages, so the
 * cited parts are copied into a share when the message is sent and the message links to it:
 * `<webUrl>/#/share/<token>/<item>`. The share holds a snapshot of those items only (source lines
 * with a little context, a memory, a message, a wiki page or section) — reading it never touches
 * the rest of the database, so the unauthenticated route cannot reach anything else. Only the
 * token's SHA-256 is stored. No expiry unless `shares.expiryDays` says so; revoking (or expiring)
 * empties the snapshot.
 */

export type ShareItem = {
  /** Position in the share (the link's anchor). */
  i: number;
  /** The circled number the message shows for it (trailing citations only). */
  mark?: number;
  /** The citation's own words in the message. */
  label: string;
} & (
  | { kind: "source"; title: string; sourceKind: string; path: string; from: number | null; to: number | null; start: number; lines: string[]; total: number; format: "code" | "markdown" | "text" }
  | { kind: "memory"; title: string; text: string; status: string; createdAt: string }
  | { kind: "message"; title: string; text: string; at: string }
  | { kind: "page"; title: string; section: string | null; markdown: string }
);
export type ShareRef = { ref: string; label: string };

/** At most this much of one source / page goes into a share. */
const MAX_LINES = 400;
const MAX_CHARS = 60_000;
const CONTEXT = 3;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function webBase(app: App) {
  return app.config.webUrl?.trim().replace(/\/+$/, "") || null;
}

/** Spaces a share made for this run may copy from: what the run itself could read. */
export function shareScope(app: App, runId?: string | null): string[] | null {
  if (!runId) return accessibleSpaces(app, OWNER);
  const r = one<{ kind: string; input: string; user_id: string | null }>(app.db, "select kind, input, user_id from runs where id = ?", runId);
  if (!r) return accessibleSpaces(app, OWNER);
  // A guest answer (someone who is not a user) read only the spaces its run recorded.
  if (r.kind === "guest") return json<{ spaces?: string[] }>(r.input, {}).spaces ?? [];
  return accessibleSpaces(app, r.user_id ?? OWNER);
}

const inScope = (scope: string[] | null, space: string) => scope === null || scope.includes(space);

/** Internal references inside shared text are not followable: keep their words only. */
export function stripRefs(md: string) {
  return md
    .replace(/!\[([^\]]*)\]\((?!https?:)[^)]*\)/g, (_a, alt: string) => (alt ? `（图片：${alt}）` : "（图片）"))
    .replace(/\[([^\]]*)\]\((?:src|mem|msg|wiki):[^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\(#\/[^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+?)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_a, t: string) => t.split(/[:/]/).pop() ?? t)
    .replace(/(^|[^\w/])(?:src|mem|msg):[A-Za-z0-9_-]{6,}(?:#L\d+(?:-L?\d+)?)?/g, "$1")
    .replace(/\s*\((?:om|omt)_[\w-]+\)\s*$/gm, "");
}

function clipLines(lines: string[]) {
  const out: string[] = [];
  let size = 0;
  for (const l of lines.slice(0, MAX_LINES)) {
    if (size + l.length > MAX_CHARS) break;
    out.push(l);
    size += l.length + 1;
  }
  return out;
}

function sourceItem(app: App, scope: string[] | null, id: string, from: number | null, to: number | null) {
  // A merged duplicate's old id resolves to the copy that was kept (sources/duplicates.ts).
  const s = one<{ title: string; kind: string; uri: string; text: string; space_id: string }>(app.db, "select title, kind, uri, text, space_id from sources where id = ? and deleted_at is null", canonicalSourceId(app, id));
  if (!s || !inScope(scope, s.space_id)) return null;
  const all = s.text ? s.text.split("\n") : [];
  const total = all.length;
  const a = from ? Math.min(Math.max(1, from), Math.max(1, total)) : null;
  const b = a ? Math.min(total, Math.max(a, to ?? a)) : null;
  let start = a ? Math.max(1, a - CONTEXT) : 1;
  // A table cut in the middle loses its header: start from the table's first row.
  if (a && /^\s*\|/.test(all[a - 1] ?? "")) {
    let t = a;
    while (t > 1 && a - t < 40 && /^\s*\|/.test(all[t - 2] ?? "")) t--;
    start = Math.min(start, t);
  }
  const end = b ? Math.min(total, b + CONTEXT) : total;
  const format: "code" | "text" | "markdown" = s.kind === "code" ? "code" : s.kind === "chat" || s.kind === "conversation" ? "text" : "markdown";
  const raw = all.slice(start - 1, end);
  const lines = clipLines(format === "code" ? raw : raw.map(stripRefs));
  return { kind: "source" as const, title: s.title, sourceKind: s.kind, path: /^https?:/.test(s.uri) || s.uri.startsWith("lark:") ? "" : s.uri, from: a, to: b, start, lines, total, format };
}

function pageItem(app: App, scope: string[] | null, target: string, runSpace: string | null) {
  const [where, section] = target.split("#");
  const [maybeSpace, maybeSlug] = where.includes(":") ? where.split(":") : [null, where];
  const slug = (maybeSlug ?? "").trim();
  if (!slug) return null;
  const spaces = maybeSpace ? [maybeSpace] : [runSpace, ...(all<{ id: string }>(app.db, "select id from spaces").map((r) => r.id))].filter((s): s is string => !!s);
  for (const space of spaces) {
    if (!inScope(scope, space)) continue;
    try {
      const page = readPage(app, space, slug);
      let body = page.body;
      if (section) {
        const lines = body.split("\n");
        const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim() === section.trim());
        if (at >= 0) {
          const level = /^#+/.exec(lines[at])![0].length;
          let end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l) && /^#+/.exec(l)![0].length <= level);
          if (end < 0) end = lines.length;
          body = lines.slice(at, end).join("\n");
        }
      }
      const title = String((page.meta as { title?: string }).title ?? slug.split("/").pop() ?? slug);
      return { kind: "page" as const, title, section: section ?? null, markdown: clipLines(stripRefs(body).split("\n")).join("\n").trim() };
    } catch {}
  }
  return null;
}

type Snapshot = ShareItem extends infer T ? (T extends ShareItem ? Omit<T, "i" | "label" | "mark"> : never) : never;
function snapshot(app: App, scope: string[] | null, ref: string, runSpace: string | null): Snapshot | null {
  let m: RegExpExecArray | null;
  if ((m = /^src:([A-Za-z0-9_-]+)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref))) return sourceItem(app, scope, m[1], m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : null);
  if ((m = /^mem:([A-Za-z0-9_-]+)$/.exec(ref))) {
    const r = one<{ text: string; space_id: string; status: string; kind: string; created_at: string }>(app.db, "select content as text, space_id, status, kind, created_at from memories where id = ?", m[1]);
    if (!r || !inScope(scope, r.space_id)) return null;
    return { kind: "memory", title: "记忆", text: stripRefs(r.text), status: r.status, createdAt: r.created_at };
  }
  if ((m = /^msg:([A-Za-z0-9_-]+)$/.exec(ref))) {
    const r = one<{ text: string; role: string; space_id: string; created_at: string }>(app.db, "select m.text, m.role, c.space_id, m.created_at from messages m join conversations c on c.id = m.conversation_id where m.id = ?", m[1]);
    if (!r || !inScope(scope, r.space_id)) return null;
    return { kind: "message", title: r.role === "user" ? "本人说" : "助理说", text: stripRefs(r.text).slice(0, MAX_CHARS), at: r.created_at };
  }
  if ((m = /^wiki:(.+)$/.exec(ref))) return pageItem(app, scope, m[1], runSpace);
  return null;
}

/**
 * Copy what these references point at into a share, ready to be saved; null when there is no web
 * address to link to, or nothing could be shared (missing, or outside what the run could read).
 * The links are known before saving so the caller can number what it shows; `save` writes it.
 */
export function prepareShare(app: App, input: { refs: ShareRef[]; runId?: string | null; origin?: string; userId?: string }) {
  const base = webBase(app);
  if (!base || !input.refs.length) return null;
  const scope = shareScope(app, input.runId);
  const runSpace = input.runId ? (one<{ space_id: string | null }>(app.db, "select space_id from runs where id = ?", input.runId)?.space_id ?? null) : null;
  const items: ShareItem[] = [];
  const index = new Map<string, number>();
  for (const r of input.refs) {
    if (index.has(r.ref)) continue;
    const item = snapshot(app, scope, r.ref, runSpace);
    if (!item) continue;
    index.set(r.ref, items.length);
    items.push({ ...item, i: items.length, label: r.label } as ShareItem);
  }
  if (!items.length) return null;
  const token = randomBytes(32).toString("base64url");
  const url = `${base}/#/share/${token}`;
  return {
    url,
    link: (ref: string) => (index.has(ref) ? `${url}/${index.get(ref)}` : null),
    /** Write it; `marks` are the numbers the message shows for these refs, `title` its first line. */
    save(marks: Map<string, number> = new Map(), title = "") {
      for (const [ref, i] of index) if (marks.has(ref)) items[i].mark = marks.get(ref);
      const id = newId("sh");
      const days = app.config.shares.expiryDays;
      const created = now();
      const expires = days > 0 ? new Date(Date.parse(created) + days * 86400_000).toISOString() : null;
      run(
        app.db,
        "insert into shares(id, token_hash, user_id, run_id, origin, title, items, created_at, expires_at) values(?,?,?,?,?,?,?,?,?)",
        id, hash(token), input.userId ?? OWNER, input.runId ?? null, input.origin ?? "", title.slice(0, 120), JSON.stringify(items), created, expires,
      );
      return id;
    },
  };
}

/** What the share page shows; null when the token is unknown, revoked or expired. */
export function readShare(app: App, token: string) {
  if (!SHARE_TOKEN.test(token)) return null;
  const r = one<{ id: string; title: string; items: string; created_at: string; expires_at: string | null; revoked_at: string | null }>(app.db, "select id, title, items, created_at, expires_at, revoked_at from shares where token_hash = ?", hash(token));
  if (!r || r.revoked_at) return null;
  if (r.expires_at && Date.parse(r.expires_at) <= Date.now()) {
    run(app.db, "update shares set items = '[]' where id = ?", r.id);
    return null;
  }
  run(app.db, "update shares set views = views + 1, viewed_at = ? where id = ?", now(), r.id);
  return { title: r.title, createdAt: r.created_at, expiresAt: r.expires_at, items: json<ShareItem[]>(r.items, []) };
}

export type ShareSummary = { id: string; runId: string | null; messageId: string | null; origin: string; title: string; labels: string[]; createdAt: string; expiresAt: string | null; revokedAt: string | null; expired: boolean; views: number; viewedAt: string | null };
type Row = { id: string; run_id: string | null; message_id: string | null; origin: string; title: string; items: string; created_at: string; expires_at: string | null; revoked_at: string | null; views: number; viewed_at: string | null; labels: string | null };

/** The owner's shares, newest first (never the token: it is not kept). */
export function listShares(app: App, userId = OWNER, limit = 200): ShareSummary[] {
  return all<Row>(app.db, "select *, (select json_group_array(json_extract(j.value, '$.label')) from json_each(shares.items) j) labels from shares where user_id = ? order by created_at desc limit ?", userId, limit).map((r) => ({
    id: r.id,
    runId: r.run_id,
    messageId: r.message_id,
    origin: r.origin,
    title: r.title,
    labels: json<string[]>(r.labels ?? "[]", []).filter(Boolean),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    expired: !!r.expires_at && Date.parse(r.expires_at) <= Date.now(),
    views: r.views,
    viewedAt: r.viewed_at,
  }));
}

/** Revoke: the link stops working and its copied content is dropped. */
export function revokeShare(app: App, id: string, userId = OWNER) {
  const r = one<{ id: string }>(app.db, "select id from shares where id = ? and user_id = ?", id, userId);
  if (!r) throw new HttpError(404, "分享不存在");
  run(app.db, "update shares set revoked_at = coalesce(revoked_at, ?), items = '[]' where id = ?", now(), id);
}

/** The Feishu message a run's answer went out as, once it is known. */
export function attachShareMessage(app: App, runId: string, messageId: string) {
  run(app.db, "update shares set message_id = ? where run_id = ? and message_id is null", messageId, runId);
}
