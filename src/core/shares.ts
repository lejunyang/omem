import { createHash, randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { canonicalSourceId } from "../sources/duplicates.ts";
import { HttpError, json, newId, now } from "./util.ts";
import { accessibleSpaces, OWNER } from "./users.ts";
import { readPage } from "../wiki/store.ts";
import { keptHere } from "../auth/visibility.ts";

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
  | { kind: "review"; title: string; verdict: string | null; summary: string; branches: { repo: string; branch: string; base: string | null }[]; findings: ReviewShareFinding[]; at: string }
);
/** One finding of a shared review: what it says and what the owner decided, without the run behind it. */
export type ReviewShareFinding = { n: number; severity: string; title: string; detail: string; suggestion: string; file: string | null; line: number | null; /** The copied code at the finding's own place, when it could be read. */ at: number | null; decision: "fix" | "later" | "wontfix"; note: string; resolution: string | null };
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
  // Seen by fewer people than its space, or by what Feishu allows each: not copied into a link anyone opens.
  if (keptHere(app, canonicalSourceId(app, id))) return null;
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

/** A code location the way reviews write it: `repo/path/file.ts`, `…:12`, `…:12-30` (web/src/lib/markdown.ts). */
const CODE_REF = /^((?:[\w.@~-]+\/)*[\w.@~-]+\.[\w]{1,8})(?::L?(\d+)(?:[-–]L?(\d+))?)?$/;
/** Lines of code around a cited range in a shared review, and at most this many in all. */
const CODE_CONTEXT = 12, CODE_LINES = 240, MAX_EVIDENCE = 120;

/**
 * A review's conclusion for someone outside omem (a colleague who wrote the branch, a reviewer): its
 * verdict, the lead's summary and every finding still standing in the latest round, with the owner's
 * decision. What the findings cite comes along, so the reader can open it: the code lines on the
 * reviewed branch (with some lines around them), and the sources, memories and pages the sharer may
 * read (never a restricted source). A citation in the text becomes `#ev-<n>`, the copied item n; one
 * that cannot be copied keeps its words only. A snapshot like any share: no run, no transcript; revocable.
 */
export async function shareReview(app: App, runId: string, userId = OWNER) {
  const base = webBase(app);
  if (!base) throw new HttpError(400, "omem 没有配置对外网址（设置 → 设备 → 网页地址），分享链接打不开");
  const r = one<{ id: string; kind: string; title: string; output: string; input: string; finished_at: string | null; created_at: string; space_id: string | null }>(app.db, "select id, kind, title, output, input, finished_at, created_at, space_id from runs where id = ?", runId);
  if (!r || r.kind !== "code") throw new HttpError(404, "没有这次评审");
  const out = json<{ codeChain?: { rounds: string[] }; reviewLead?: { summary?: string } }>(r.output, {});
  // The latest round that has a review: a round still being coded has none yet.
  const rounds = out.codeChain?.rounds ?? [r.id];
  const last = [...rounds].reverse().find((id) => one(app.db, "select 1 from reviews where code_run_id = ? limit 1", id));
  if (!last) throw new HttpError(409, "这次评审还没有结论");
  const lastOut = last === r.id ? out : json<typeof out>(one<{ output: string }>(app.db, "select output from runs where id = ?", last)?.output, {});
  const reviews = all<{ id: string }>(app.db, "select id from reviews where code_run_id = ?", last);
  const rows = all<{ severity: string; title: string; detail: string; suggestion: string; file_path: string | null; line: number | null; state: string; merged_into: number | null; decision: string | null; decision_note: string | null; resolution: string | null }>(app.db,
    `select severity, title, detail, suggestion, file_path, line, state, merged_into, decision, decision_note, resolution from review_findings where review_id in (${reviews.map(() => "?").join(",")}) and merged_into is null and state in ('open', 'accepted') order by case severity when 'blocker' then 0 when 'major' then 1 when 'minor' then 2 else 3 end, id`, ...reviews.map((x) => x.id));

  // ---- evidence: copied once per place, numbered from 1 (0 is the review itself)
  const scope = accessibleSpaces(app, userId);
  const { readRunFile } = await import("../agents/run-file.ts");
  const files = new Map<string, Promise<{ path: string; lines: string[] } | null>>();
  const fileOf = (path: string) => {
    if (!files.has(path)) files.set(path, readRunFile(app, last, { path }, userId).then((f) => {
      if (f.size > 2 * 1024 * 1024) return null;
      const bytes = f.bytes();
      return bytes.subarray(0, 8000).includes(0) ? null : { path: `${f.space}/${f.path}`, lines: bytes.toString("utf8").split(/\r?\n/) };
    }).catch(() => null));
    return files.get(path)!;
  };
  const evidence: ShareItem[] = [];
  const index = new Map<string, number>();
  async function cite(ref: string, label: string): Promise<number | null> {
    if (index.has(ref)) return index.get(ref)!;
    if (evidence.length >= MAX_EVIDENCE) return null;
    let item: Snapshot | null = null;
    const m = CODE_REF.exec(ref);
    if (m && !/^(?:src|mem|msg|wiki):/.test(ref)) {
      const f = await fileOf(m[1]);
      if (f) {
        const total = f.lines.length;
        const from = m[2] ? Math.min(Math.max(1, Number(m[2])), Math.max(1, total)) : null;
        const to = from ? Math.min(total, Math.max(from, Number(m[3] ?? m[2]))) : null;
        const start = from ? Math.max(1, from - CODE_CONTEXT) : 1;
        const end = to ? Math.min(total, to + CODE_CONTEXT, start + CODE_LINES - 1) : Math.min(total, CODE_LINES);
        item = { kind: "source", title: f.path.split("/").pop() ?? f.path, sourceKind: "code", path: f.path, from, to, start, lines: clipLines(f.lines.slice(start - 1, end)), total, format: "code" };
      }
    } else item = snapshot(app, scope, ref, r!.space_id);
    if (!item) return null;
    const i = evidence.length + 1;
    index.set(ref, i);
    evidence.push({ ...item, i, label } as ShareItem);
    return i;
  }
  /** The text with each citation it can copy pointing at the copy, the rest as plain words. */
  async function linked(md: string) {
    const found: { at: number; len: number; label: string; ref: string }[] = [];
    for (const m of md.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      let href = m[2];
      try { href = decodeURIComponent(href); } catch {}
      if (/^(?:https?:|mailto:|#)/i.test(href)) continue;
      found.push({ at: m.index!, len: m[0].length, label: m[1], ref: href });
    }
    let text = "", pos = 0;
    for (const f of found) {
      const n = await cite(f.ref, f.label || f.ref);
      text += md.slice(pos, f.at) + (n ? `[${f.label || f.ref}](#ev-${n})` : f.label);
      pos = f.at + f.len;
    }
    return stripRefs(text + md.slice(pos));
  }

  const decisionOf = (f: (typeof rows)[number]) => (f.decision ?? (f.state === "accepted" || ["blocker", "major"].includes(f.severity) ? "fix" : "later")) as ReviewShareFinding["decision"];
  const findings: ReviewShareFinding[] = [];
  for (const [k, f] of rows.entries()) {
    const at = f.file_path ? await cite(`${f.file_path}${f.line ? `:${f.line}` : ""}`, `${f.file_path}${f.line ? `:${f.line}` : ""}`) : null;
    findings.push({ n: k + 1, severity: f.severity, title: stripRefs(f.title), detail: (await linked(f.detail)).slice(0, 8000), suggestion: (await linked(f.suggestion)).slice(0, 4000), file: f.file_path, line: f.line, at, decision: decisionOf(f), note: stripRefs(f.decision_note ?? ""), resolution: f.resolution });
  }
  const input = json<{ branches?: Record<string, string | { branch: string; base?: string }>; base?: string }>(r.input, {});
  const branches = Object.entries(input.branches ?? {}).map(([repo, b]) => typeof b === "string" ? { repo, branch: b, base: input.base ?? null } : { repo, branch: b.branch, base: b.base ?? input.base ?? null });
  const summary = await linked(lastOut.reviewLead?.summary ?? "");
  const item: ShareItem = { i: 0, label: r.title, kind: "review", title: r.title, verdict: findings.some((f) => f.decision === "fix") ? "changes-requested" : "approved", summary, branches, findings, at: r.finished_at ?? r.created_at };
  const token = randomBytes(32).toString("base64url");
  const id = newId("sh");
  const days = app.config.shares.expiryDays;
  const created = now();
  const expires = days > 0 ? new Date(Date.parse(created) + days * 86400_000).toISOString() : null;
  run(app.db, "insert into shares(id, token_hash, user_id, run_id, origin, title, items, created_at, expires_at) values(?,?,?,?,?,?,?,?,?)",
    id, hash(token), userId, r.id, "review", `评审：${r.title}`.slice(0, 120), JSON.stringify([item, ...evidence]), created, expires);
  return { id, url: `${base}/#/share/${token}`, findings: findings.length, evidence: evidence.length, expiresAt: expires };
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
