import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { canonicalSourceId } from "../sources/duplicates.ts";
import { commitLibrary, fileAt, fileDiff, fileHistory } from "../core/git.ts";
import { getSpace, spaceDir } from "../core/spaces.ts";
import { HttpError, now, sha256 } from "../core/util.ts";
import { indexText } from "../search/tokenize.ts";

export type PageMeta = {
  title: string;
  summary?: string;
  /** guide | concept | howto | reference | topic | person | project | index */
  kind?: string;
  order?: number;
  tags?: string[];
  updated?: string;
  /** Paths the page used to have (set when it is moved), so old links still open it. */
  aliases?: string[];
  [key: string]: unknown;
};
export type Page = { id: string; spaceId: string; slug: string; meta: PageMeta; body: string; updatedAt: string };
export type PageCite = { sourceId: string; uri: string; title: string; lineStart: number | null; lineEnd: number | null; stale: boolean; deleted: boolean };

const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}._\-/]*$/u;

export function checkSlug(slug: string) {
  const clean = slug.replace(/\.md$/, "").replace(/^\/+|\/+$/g, "");
  if (!SLUG.test(clean) || clean.split("/").some((p) => p === ".." || p === "." || !p)) throw new HttpError(400, `页面路径不合法：${slug}`);
  return clean;
}

const wikiDir = (app: App, spaceId: string) => join(spaceDir(app, spaceId), "wiki");
const pageFile = (app: App, spaceId: string, slug: string) => join(wikiDir(app, spaceId), `${slug}.md`);

export function parsePage(raw: string): { meta: PageMeta; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) {
    const title = /^#\s+(.+)$/m.exec(raw)?.[1] ?? "未命名";
    return { meta: { title }, body: raw };
  }
  let meta: PageMeta;
  try {
    meta = (YAML.parse(m[1]) ?? {}) as PageMeta;
  } catch {
    meta = { title: "未命名" };
  }
  if (!meta.title) meta.title = /^#\s+(.+)$/m.exec(raw.slice(m[0].length))?.[1] ?? "未命名";
  return { meta, body: raw.slice(m[0].length).replace(/^\n+/, "") };
}

export function serializePage(meta: PageMeta, body: string) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return `---\n${YAML.stringify(clean).trim()}\n---\n\n${body.trim()}\n`;
}

/** [[slug]] / [[slug|label]] wiki links and ](wiki:slug) markdown links. */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.add(m[1].trim());
  for (const m of body.matchAll(/\]\(wiki:([^)#\s]+)/g)) out.add(decodeURIComponent(m[1]));
  return [...out];
}

/** ](src:<id or path>#L10-L20) citations. */
export function extractCites(body: string): { ref: string; lineStart: number | null; lineEnd: number | null }[] {
  const out: { ref: string; lineStart: number | null; lineEnd: number | null }[] = [];
  for (const m of body.matchAll(/\]\(src:([^)#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?\)/g))
    out.push({ ref: decodeURIComponent(m[1]), lineStart: m[2] ? Number(m[2]) : null, lineEnd: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : null });
  return out;
}

export function resolveSourceRef(app: App, spaceId: string, ref: string): { id: string; hash: string } | null {
  const byId = one<{ id: string; hash: string }>(app.db, "select id, hash from sources where id = ?", canonicalSourceId(app, ref));
  if (byId) return byId;
  return (
    one<{ id: string; hash: string }>(app.db, "select id, hash from sources where space_id = ? and uri = ?", spaceId, ref) ??
    one<{ id: string; hash: string }>(app.db, "select id, hash from sources where uri = ? order by updated_at desc", ref) ??
    null
  );
}

/** A link's target as a page id: a page that moved is linked through its new path. */
function linkTarget(app: App, spaceId: string, to: string) {
  const id = to.includes(":") ? to.replace(":", "/") : `${spaceId}/${to}`;
  if (one(app.db, "select 1 from pages where id = ?", id)) return id;
  const sp = id.slice(0, id.indexOf("/"));
  const a = one<{ slug: string }>(app.db, "select slug from page_aliases where space_id = ? and alias = ?", sp, id.slice(sp.length + 1));
  return a ? `${sp}/${a.slug}` : id;
}

/** `keep`: a re-save that is not a re-check (a move, a rewritten link) keeps the original's recorded state of what each citation was when written. */
function indexPage(app: App, spaceId: string, slug: string, meta: PageMeta, body: string, mtime: string, keep?: { fromId: string }) {
  const id = `${spaceId}/${slug}`;
  const hash = sha256(serializePage(meta, body));
  const existing = one<{ hash: string }>(app.db, "select hash from pages where id = ?", id);
  if (existing?.hash === hash) return false;
  tx(app.db, () => {
    const was = new Map(keep ? all<{ source_id: string; hash: string }>(app.db, "select source_id, hash from page_cites where page_id = ?", keep.fromId).map((r) => [r.source_id, r.hash]) : []);
    run(
      app.db,
      `insert into pages(id,space_id,slug,title,summary,kind,body,hash,updated_at) values(?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set title=excluded.title, summary=excluded.summary, kind=excluded.kind, body=excluded.body, hash=excluded.hash, updated_at=excluded.updated_at`,
      id,
      spaceId,
      slug,
      meta.title,
      meta.summary ?? "",
      meta.kind ?? "page",
      body,
      hash,
      mtime,
    );
    const r = one<{ rowid: number }>(app.db, "select rowid from page_rowids where page_id = ?", id);
    if (r) run(app.db, "delete from pages_fts where rowid = ?", r.rowid);
    const rowid = r?.rowid ?? Number(run(app.db, "insert into page_rowids(page_id) values(?)", id).lastInsertRowid);
    run(app.db, "insert into pages_fts(rowid,title,body) values(?,?,?)", rowid, indexText(`${meta.title} ${meta.summary ?? ""} ${slug}`), indexText(body));
    run(app.db, "delete from page_links where from_id = ?", id);
    for (const to of extractLinks(body)) run(app.db, "insert or ignore into page_links(from_id,to_id) values(?,?)", id, linkTarget(app, spaceId, to));
    run(app.db, "delete from page_aliases where space_id = ? and slug = ?", spaceId, slug);
    for (const a of aliasesOf(meta)) if (a !== slug) run(app.db, "insert or replace into page_aliases(space_id,alias,slug) values(?,?,?)", spaceId, a, slug);
    run(app.db, "delete from page_cites where page_id = ?", id);
    for (const c of extractCites(body)) {
      const s = resolveSourceRef(app, spaceId, c.ref);
      if (s) run(app.db, "insert into page_cites(page_id,source_id,line_start,line_end,hash) values(?,?,?,?,?)", id, s.id, c.lineStart, c.lineEnd, was.get(s.id) ?? s.hash);
    }
  });
  app.emit({ type: "changed", entity: "page", id, spaceId });
  return true;
}

function removeIndex(app: App, id: string) {
  const r = one<{ rowid: number }>(app.db, "select rowid from page_rowids where page_id = ?", id);
  if (r) {
    run(app.db, "delete from pages_fts where rowid = ?", r.rowid);
    run(app.db, "delete from page_rowids where rowid = ?", r.rowid);
  }
  run(app.db, "delete from pages where id = ?", id);
  run(app.db, "delete from page_links where from_id = ?", id);
  run(app.db, "delete from page_cites where page_id = ?", id);
  const sp = id.slice(0, id.indexOf("/"));
  run(app.db, "delete from page_aliases where space_id = ? and slug = ?", sp, id.slice(sp.length + 1));
}

export function writePage(
  app: App,
  spaceId: string,
  slugInput: string,
  input: { meta: PageMeta; body: string },
  opts: { actor?: string; message?: string; commit?: boolean } = {},
): Page {
  const slug = checkSlug(slugInput);
  const file = pageFile(app, spaceId, slug);
  mkdirSync(dirname(file), { recursive: true });
  const meta = { ...input.meta, updated: now().slice(0, 10) };
  writeFileSync(file, serializePage(meta, input.body));
  indexPage(app, spaceId, slug, meta, input.body.trim() + "\n", now());
  if (opts.commit !== false) commitLibrary(app.libraryDir, opts.message ?? `${opts.actor ?? "agent"}: update ${spaceId}/${slug}`);
  return readPage(app, spaceId, slug);
}

export function deletePage(app: App, spaceId: string, slugInput: string, actor = "user") {
  const slug = checkSlug(slugInput);
  const file = pageFile(app, spaceId, slug);
  if (existsSync(file)) rmSync(file);
  removeIndex(app, `${spaceId}/${slug}`);
  commitLibrary(app.libraryDir, `${actor}: delete ${spaceId}/${slug}`);
  app.emit({ type: "changed", entity: "page", id: `${spaceId}/${slug}`, spaceId });
}

/** The page's current path: itself, or where it moved to (following old paths); null when no such page. */
export function resolveSlug(app: App, spaceId: string, slugInput: string): string | null {
  let slug = checkSlug(slugInput);
  for (let i = 0; i < 6; i++) {
    if (existsSync(pageFile(app, spaceId, slug))) return slug;
    const a = one<{ slug: string }>(app.db, "select slug from page_aliases where space_id = ? and alias = ?", spaceId, slug);
    if (!a || a.slug === slug) return null;
    slug = a.slug;
  }
  return null;
}

/** Reads a page; a path the page used to have opens it at its new path (`slug` in the result is the current one). */
export function readPage(app: App, spaceId: string, slugInput: string): Page {
  const asked = checkSlug(slugInput);
  const slug = resolveSlug(app, spaceId, asked) ?? asked;
  const file = pageFile(app, spaceId, slug);
  if (!existsSync(file)) throw new HttpError(404, `页面不存在：${spaceId}/${asked}`);
  const { meta, body } = parsePage(readFileSync(file, "utf8"));
  return { id: `${spaceId}/${slug}`, spaceId, slug, meta, body, updatedAt: statSync(file).mtime.toISOString() };
}

export function pageExists(app: App, spaceId: string, slug: string) {
  return existsSync(pageFile(app, spaceId, slug));
}

export function pageContext(app: App, spaceId: string, slugInput: string) {
  const slug = resolveSlug(app, spaceId, slugInput) ?? slugInput;
  const id = `${spaceId}/${slug}`;
  const backlinks = all<{ id: string; title: string; space_id: string; slug: string }>(
    app.db,
    "select p.id, p.title, p.space_id, p.slug from page_links l join pages p on p.id = l.from_id where l.to_id = ? order by p.title",
    id,
  );
  const cites = all<{ source_id: string; uri: string; title: string; line_start: number | null; line_end: number | null; hash: string; cur: string; deleted_at: string | null }>(
    app.db,
    `select c.source_id, s.uri, s.title, c.line_start, c.line_end, c.hash, s.hash cur, s.deleted_at from page_cites c join sources s on s.id = c.source_id where c.page_id = ?`,
    id,
  );
  const sources = new Map<string, PageCite>();
  for (const c of cites)
    if (!sources.has(c.source_id))
      sources.set(c.source_id, { sourceId: c.source_id, uri: c.uri, title: c.title, lineStart: c.line_start, lineEnd: c.line_end, stale: c.hash !== c.cur, deleted: !!c.deleted_at });
  const missing = all<{ to_id: string }>(app.db, "select l.to_id from page_links l left join pages p on p.id=l.to_id where l.from_id=? and p.id is null", id).map((r) => r.to_id);
  return {
    backlinks: backlinks.map((b) => ({ spaceId: b.space_id, slug: b.slug, title: b.title })),
    sources: [...sources.values()],
    missingLinks: missing,
    history: fileHistory(app.libraryDir, relative(app.libraryDir, pageFile(app, spaceId, slug)).split(sep).join("/"), 30),
  };
}

export function pageVersion(app: App, spaceId: string, slug: string, hash: string) {
  const rel = relative(app.libraryDir, pageFile(app, spaceId, checkSlug(slug))).split(sep).join("/");
  const raw = fileAt(app.libraryDir, hash, rel);
  if (raw === null) throw new HttpError(404, "没有这个版本");
  return { ...parsePage(raw), diff: fileDiff(app.libraryDir, hash, rel) };
}

const aliasesOf = (meta: PageMeta) => (Array.isArray(meta.aliases) ? meta.aliases.filter((a): a is string => typeof a === "string" && /^[\p{L}\p{N}][\p{L}\p{N}._\-/]*$/u.test(a)) : []);

export type PageSummary = { slug: string; title: string; summary: string; kind: string; order: number | null; updatedAt: string; staleSources: number };
export function listPages(app: App, spaceId: string): PageSummary[] {
  const rows = all<{ slug: string; title: string; summary: string; kind: string; updated_at: string; stale: number }>(
    app.db,
    `select p.slug, p.title, p.summary, p.kind, p.updated_at,
      (select count(distinct c.source_id) from page_cites c join sources s on s.id = c.source_id where c.page_id = p.id and (s.hash != c.hash or s.deleted_at is not null)) stale
     from pages p where p.space_id = ? order by p.slug`,
    spaceId,
  );
  return rows.map((r) => ({ slug: r.slug, title: r.title, summary: r.summary, kind: r.kind, order: null, updatedAt: r.updated_at, staleSources: r.stale }));
}

/** Re-read wiki files from disk (hand edits, git pulls) into the index. */
export function syncWiki(app: App, spaceId: string) {
  const dir = wikiDir(app, spaceId);
  if (!existsSync(dir)) return { indexed: 0, removed: 0 };
  const seen = new Set<string>();
  let indexed = 0;
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.name.endsWith(".md")) {
        const slug = relative(dir, full).split(sep).join("/").replace(/\.md$/, "");
        seen.add(`${spaceId}/${slug}`);
        const { meta, body } = parsePage(readFileSync(full, "utf8"));
        if (indexPage(app, spaceId, slug, meta, body, statSync(full).mtime.toISOString())) indexed++;
      }
    }
  };
  visit(dir);
  let removed = 0;
  for (const r of all<{ id: string }>(app.db, "select id from pages where space_id = ?", spaceId))
    if (!seen.has(r.id)) {
      removeIndex(app, r.id);
      removed++;
    }
  return { indexed, removed };
}

export type NavNode = {
  /** The page this entry opens: a page, or a folder's `index` page. */
  slug?: string;
  title: string;
  /** Set on folders: the path. */
  folder?: string;
  /** Pages in the folder and below (folder index pages not counted). */
  count?: number;
  /** Of those, pages whose cited originals changed. */
  stale?: number;
  children: NavNode[];
};

export const folderOf = (slug: string) => (slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : "");

/**
 * The folder tree of a space, from page paths: `a/b/c` is page `c` in folder `a/b`. A folder
 * takes its name from its own `index` page (`a/b/index`, which then opens when the folder is
 * clicked) and from the last path segment otherwise. The space's `index` page is the home and
 * not in the tree. At each level pages come first, then folders, both in path order.
 */
export function buildNav(pages: Pick<PageSummary, "slug" | "title" | "staleSources">[]): NavNode[] {
  const root: NavNode = { title: "", children: [] };
  const folders = new Map<string, NavNode>([["", root]]);
  const folder = (path: string): NavNode => {
    const have = folders.get(path);
    if (have) return have;
    const node: NavNode = { title: path.slice(path.lastIndexOf("/") + 1), folder: path, count: 0, stale: 0, children: [] };
    folders.set(path, node);
    folder(folderOf(path)).children.push(node);
    return node;
  };
  for (const p of [...pages].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    if (p.slug === "index") continue;
    const dir = folderOf(p.slug);
    if (p.slug.endsWith("/index")) {
      const f = folder(dir);
      f.title = p.title;
      f.slug = p.slug;
      continue;
    }
    folder(dir).children.push({ slug: p.slug, title: p.title, stale: p.staleSources, children: [] });
    for (let d = dir; d; d = folderOf(d)) {
      const f = folder(d);
      f.count = (f.count ?? 0) + 1;
      if (p.staleSources) f.stale = (f.stale ?? 0) + 1;
    }
  }
  const order = (n: NavNode) => {
    const pagesFirst = n.children.filter((c) => c.folder === undefined);
    const dirs = n.children.filter((c) => c.folder !== undefined).sort((a, b) => (a.folder! < b.folder! ? -1 : 1));
    n.children = [...pagesFirst, ...dirs];
    dirs.forEach(order);
  };
  order(root);
  return root.children;
}

export function wikiNav(app: App, spaceId: string): NavNode[] {
  return buildNav(listPages(app, spaceId));
}

/** How the folders are laid out (pages per folder), for agents that place or move pages. */
export function folderOverview(pages: Pick<PageSummary, "slug">[], maxLines = 60): string {
  const direct = new Map<string, number>();
  const total = new Map<string, number>();
  for (const p of pages) {
    if (p.slug === "index") continue;
    const dir = folderOf(p.slug);
    const n = p.slug.endsWith("/index") ? 0 : 1;
    direct.set(dir, (direct.get(dir) ?? 0) + n);
    for (let d = dir; d; d = folderOf(d)) total.set(d, (total.get(d) ?? 0) + n);
  }
  const dirs = [...new Set([...direct.keys(), ...total.keys()])].filter(Boolean).sort();
  const lines = [`顶层 ${direct.get("") ?? 0} 页（不含 index）`];
  for (const d of dirs) lines.push(`${"  ".repeat(d.split("/").length - 1)}${d}/ 共 ${total.get(d) ?? 0} 页${(direct.get(d) ?? 0) !== (total.get(d) ?? 0) ? `（直接 ${direct.get(d) ?? 0}）` : ""}`);
  return lines.slice(0, maxLines).join("\n") + (lines.length > maxLines ? `\n…另有 ${lines.length - maxLines} 个目录` : "");
}

/** What needs sorting into folders: pages left at the top level, and folders holding too many pages directly. */
export const LOOSE_PAGES = 6;
export const CROWDED_PAGES = 40;
export function organizeNeeds(pages: Pick<PageSummary, "slug">[]) {
  const direct = new Map<string, string[]>();
  for (const p of pages) {
    if (p.slug === "index" || p.slug.endsWith("/index")) continue;
    const d = folderOf(p.slug);
    direct.set(d, [...(direct.get(d) ?? []), p.slug]);
  }
  const loose = direct.get("") ?? [];
  const crowded = [...direct]
    .filter(([d, l]) => d && l.length > CROWDED_PAGES)
    .map(([folder, l]) => ({ folder, count: l.length }))
    .sort((a, b) => b.count - a.count);
  return { loose: loose.length >= LOOSE_PAGES ? loose : [], crowded };
}

// ------------------------------------------------------------------ moving pages

export type PageMove = { from: string; to: string };

/** Fix links to moved pages in `body` (`[[slug]]`, `[[space:slug]]`, `](wiki:slug)`); `here` is the page's own space. */
export function rewriteLinks(body: string, here: string, moved: { space: string; map: Map<string, string> }): string {
  const fix = (raw: string) => {
    const colon = raw.indexOf(":");
    const space = colon > 0 ? raw.slice(0, colon) : here;
    const slug = (colon > 0 ? raw.slice(colon + 1) : raw).trim();
    if (space !== moved.space) return raw;
    const to = moved.map.get(slug);
    return to ? (colon > 0 ? `${space}:${to}` : to) : raw;
  };
  return body
    .replace(/\[\[([^\]|#]+)((?:#[^\]|]*)?(?:\|[^\]]*)?)\]\]/g, (m, t: string, rest: string) => {
      const r = fix(t);
      return r === t ? m : `[[${r}${rest}]]`;
    })
    .replace(/\]\(wiki:([^)#\s]+)/g, (m, t: string) => {
      let raw = t;
      try {
        raw = decodeURIComponent(t);
      } catch {}
      const r = fix(raw);
      return r === raw ? m : `](wiki:${r}`;
    });
}

/** Folder moves (`from` and `to` ending in `/`) become one move per page. */
export function expandMoves(app: App, spaceId: string, moves: PageMove[]): PageMove[] {
  const slugs = all<{ slug: string }>(app.db, "select slug from pages where space_id = ?", spaceId).map((r) => r.slug);
  const out: PageMove[] = [];
  for (const m of moves) {
    if (m.from.endsWith("/") || m.to.endsWith("/")) {
      if (!(m.from.endsWith("/") && m.to.endsWith("/"))) throw new HttpError(400, `移动整个目录时 from 和 to 都以 / 结尾：${m.from} → ${m.to}`);
      const from = checkSlug(m.from) + "/";
      const to = checkSlug(m.to) + "/";
      const inside = slugs.filter((s) => s.startsWith(from));
      if (!inside.length) throw new HttpError(404, `目录 ${from} 下没有页面`);
      for (const s of inside) out.push({ from: s, to: to + s.slice(from.length) });
    } else out.push({ from: checkSlug(m.from), to: checkSlug(m.to) });
  }
  return out;
}

function pruneEmptyDirs(dir: string, root: string) {
  for (let d = dir; d.length > root.length && d.startsWith(root); d = dirname(d)) {
    try {
      if (readdirSync(d).length) return;
      rmSync(d, { recursive: true });
    } catch {
      return;
    }
  }
}

/**
 * Move or rename pages (and whole folders). Each page keeps its content and its recorded state
 * of what it cited; its old path is kept as an alias so links, memories and bookmarks that use it
 * still open the page, and `[[links]]` in other pages are rewritten to the new path. One commit.
 */
export function movePages(app: App, spaceId: string, input: PageMove[], opts: { actor?: string; message?: string } = {}) {
  const moves = expandMoves(app, spaceId, input);
  if (!moves.length) throw new HttpError(400, "没有要移动的页面");
  if (moves.length > 300) throw new HttpError(400, `一次最多移动 300 页（这次 ${moves.length} 页），分几次做`);
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const m of moves) {
    if (m.from === m.to) throw new HttpError(400, `${m.from} 已经在这个位置`);
    if (m.from === "index" || m.to === "index") throw new HttpError(400, "index 是空间的首页，不能移动，也不能把别的页面改成 index");
    if (froms.has(m.from)) throw new HttpError(400, `${m.from} 出现了两次`);
    if (tos.has(m.to)) throw new HttpError(400, `两个页面要移到同一个位置：${m.to}`);
    froms.add(m.from);
    tos.add(m.to);
    if (!existsSync(pageFile(app, spaceId, m.from))) throw new HttpError(404, `页面不存在：${spaceId}/${m.from}`);
  }
  const live = new Set(all<{ slug: string }>(app.db, "select slug from pages where space_id = ?", spaceId).map((r) => r.slug));
  for (const s of froms) live.delete(s);
  for (const m of moves) {
    if (live.has(m.to) || (existsSync(pageFile(app, spaceId, m.to)) && !froms.has(m.to))) throw new HttpError(409, `目标已有页面：${m.to}`);
    const parts = m.to.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (live.has(dir) || tos.has(dir)) throw new HttpError(409, `${dir} 是一个页面，不能再作为目录放 ${m.to}`);
    }
    if ([...live, ...tos].some((s) => s.startsWith(m.to + "/"))) throw new HttpError(409, `${m.to} 是一个目录，不能作为页面路径`);
  }
  const oldIds = moves.map((m) => `${spaceId}/${m.from}`);
  const linkers = new Set(all<{ from_id: string }>(app.db, `select distinct from_id from page_links where to_id in (${oldIds.map(() => "?").join(",")})`, ...oldIds).map((r) => r.from_id));
  // 1. Read everything first (a target may be another move's source).
  const read = moves.map((m) => {
    const { meta, body } = parsePage(readFileSync(pageFile(app, spaceId, m.from), "utf8"));
    const was = all<{ source_id: string; hash: string }>(app.db, "select source_id, hash from page_cites where page_id = ?", `${spaceId}/${m.from}`);
    return { ...m, meta, body, was };
  });
  const root = wikiDir(app, spaceId);
  // 2. Old files and index rows out, new files in.
  for (const r of read) {
    rmSync(pageFile(app, spaceId, r.from));
    removeIndex(app, `${spaceId}/${r.from}`);
  }
  const map = new Map(moves.map((m) => [m.from, m.to]));
  for (const r of read) {
    const aliases = [...new Set([...(r.meta.aliases ?? []), r.from])].filter((a) => a !== r.to && !tos.has(a));
    const meta: PageMeta = { ...r.meta, aliases };
    // A moved page's own links to other moved pages are fixed too.
    const body = rewriteLinks(r.body, spaceId, { space: spaceId, map });
    const file = pageFile(app, spaceId, r.to);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializePage(meta, body));
    indexPage(app, spaceId, r.to, meta, body.trim() + "\n", statSync(file).mtime.toISOString());
    // The page did not change, so what it cited was checked as long ago as before the move.
    for (const c of r.was) run(app.db, "update page_cites set hash = ? where page_id = ? and source_id = ?", c.hash, `${spaceId}/${r.to}`, c.source_id);
  }
  for (const r of read) pruneEmptyDirs(dirname(pageFile(app, spaceId, r.from)), root);
  // 3. Other pages that link to a moved page.
  let linksFixed = 0;
  for (const id of linkers) {
    const sp = id.slice(0, id.indexOf("/"));
    const slug0 = id.slice(sp.length + 1);
    const slug = sp === spaceId ? (map.get(slug0) ?? slug0) : slug0;
    const file = pageFile(app, sp, slug);
    if (!existsSync(file)) continue;
    const { meta, body } = parsePage(readFileSync(file, "utf8"));
    const next = rewriteLinks(body, sp, { space: spaceId, map });
    if (next === body) continue;
    writeFileSync(file, serializePage(meta, next));
    indexPage(app, sp, slug, meta, next.trim() + "\n", statSync(file).mtime.toISOString(), { fromId: `${sp}/${slug}` });
    linksFixed++;
  }
  commitLibrary(app.libraryDir, opts.message ?? `${opts.actor ?? "agent"}: move ${moves.length} pages in ${spaceId}`);
  return { moved: moves, linksFixed };
}

/** The page was checked and still holds: its recorded state of what it cited is brought up to date. Content is untouched. */
export function confirmPage(app: App, spaceId: string, slugInput: string) {
  const slug = resolveSlug(app, spaceId, slugInput);
  if (!slug) throw new HttpError(404, `页面不存在：${spaceId}/${slugInput}`);
  const id = `${spaceId}/${slug}`;
  run(app.db, "update page_cites set hash = (select s.hash from sources s where s.id = page_cites.source_id) where page_id = ? and source_id in (select id from sources)", id);
  const gone = all<{ uri: string }>(app.db, "select distinct s.uri from page_cites c join sources s on s.id = c.source_id where c.page_id = ? and s.deleted_at is not null", id).map((r) => r.uri);
  app.emit({ type: "changed", entity: "page", id, spaceId });
  return { id, deleted: gone };
}

/** Pages whose cited originals changed since they were written, with what changed. */
export function staleDetail(app: App, spaceId: string) {
  const rows = all<{ page_id: string; source_id: string; uri: string; title: string; kind: string; updated_at: string; deleted_at: string | null }>(
    app.db,
    `select distinct c.page_id, c.source_id, s.uri, s.title, s.kind, s.updated_at, s.deleted_at from page_cites c join sources s on s.id = c.source_id
     join pages p on p.id = c.page_id where p.space_id = ? and (s.hash != c.hash or s.deleted_at is not null)`,
    spaceId,
  );
  const by = new Map<string, { slug: string; sources: { id: string; uri: string; title: string; kind: string; updatedAt: string; deleted: boolean }[] }>();
  for (const r of rows) {
    const e = by.get(r.page_id) ?? { slug: r.page_id.slice(spaceId.length + 1), sources: [] };
    e.sources.push({ id: r.source_id, uri: r.uri, title: r.title, kind: r.kind, updatedAt: r.updated_at, deleted: !!r.deleted_at });
    by.set(r.page_id, e);
  }
  return [...by.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

export function spaceGuide(app: App, spaceId: string) {
  const file = join(spaceDir(app, spaceId), "SPACE.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function writeSpaceGuide(app: App, spaceId: string, text: string) {
  const file = join(spaceDir(app, spaceId), "SPACE.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  commitLibrary(app.libraryDir, `user: update ${spaceId}/SPACE.md`);
}

export function appendLog(app: App, spaceId: string, line: string) {
  const file = join(spaceDir(app, spaceId), "log.md");
  mkdirSync(dirname(file), { recursive: true });
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "# 整理日志\n\n";
  writeFileSync(file, prev + `- ${now().slice(0, 16).replace("T", " ")} ${line}\n`);
}

/**
 * Copy a space's wiki into a plain Markdown folder that reads well on GitHub or
 * in an editor: `[[slug]]` become relative links, citations to files of the
 * space's repository become relative links with line anchors (`#L10-L20`),
 * other internal links (memories, messages, non-file sources) keep their text.
 */
export function exportWiki(app: App, spaceId: string, outDir: string, opts: { repoRoot?: string } = {}) {
  const space = getSpace(app, spaceId);
  const root = wikiDir(app, spaceId);
  const repoRoot = opts.repoRoot ?? space.rootPath ?? null;
  const out = resolve(outDir);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) files.push(full);
    }
  };
  if (!existsSync(root)) throw new HttpError(404, `空间 ${spaceId} 还没有 Wiki`);
  walk(root);
  const uriOf = new Map(all<{ id: string; uri: string }>(app.db, "select id, uri from sources where space_id = ?", spaceId).map((r) => [r.id, r.uri]));
  let links = 0;
  for (const file of files) {
    const rel = relative(root, file);
    const target = join(out, rel);
    const here = dirname(target);
    const toPage = (slug: string) => {
      const [s, anchor] = slug.split("#");
      const p = relative(here, join(out, `${s.replace(/^[^:]+:/, "")}.md`)).split(sep).join("/");
      return (p.startsWith(".") ? p : `./${p}`) + (anchor ? `#${anchor}` : "");
    };
    let text = readFileSync(file, "utf8");
    text = text.replace(/\[([^\]]*)\]\(src:([^)#\s]+)(?:#L(\d+)(?:-L(\d+))?)?\)/g, (m, label, id, a, b) => {
      const uri = uriOf.get(id);
      if (!uri || !repoRoot || !existsSync(join(repoRoot, uri))) return label;
      links++;
      const p = relative(here, join(repoRoot, uri)).split(sep).join("/");
      return `[${label}](${p}${a ? `#L${a}${b && b !== a ? `-L${b}` : ""}` : ""})`;
    });
    text = text.replace(/\[([^\]]*)\]\((?:mem|msg|conv|wiki):[^)]+\)/g, "$1");
    text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, slug, label) => `[${label}](${toPage(slug)})`);
    text = text.replace(/\[\[([^\]]+)\]\]/g, (_, slug) => `[${slug}](${toPage(slug)})`);
    mkdirSync(here, { recursive: true });
    writeFileSync(target, text);
  }
  return { pages: files.length, links, outDir: out };
}
