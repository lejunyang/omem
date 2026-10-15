import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
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
  const byId = one<{ id: string; hash: string }>(app.db, "select id, hash from sources where id = ?", ref);
  if (byId) return byId;
  return (
    one<{ id: string; hash: string }>(app.db, "select id, hash from sources where space_id = ? and uri = ?", spaceId, ref) ??
    one<{ id: string; hash: string }>(app.db, "select id, hash from sources where uri = ? order by updated_at desc", ref) ??
    null
  );
}

function indexPage(app: App, spaceId: string, slug: string, meta: PageMeta, body: string, mtime: string) {
  const id = `${spaceId}/${slug}`;
  const hash = sha256(serializePage(meta, body));
  const existing = one<{ hash: string }>(app.db, "select hash from pages where id = ?", id);
  if (existing?.hash === hash) return false;
  tx(app.db, () => {
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
    for (const to of extractLinks(body)) run(app.db, "insert or ignore into page_links(from_id,to_id) values(?,?)", id, to.includes(":") ? to.replace(":", "/") : `${spaceId}/${to}`);
    run(app.db, "delete from page_cites where page_id = ?", id);
    for (const c of extractCites(body)) {
      const s = resolveSourceRef(app, spaceId, c.ref);
      if (s) run(app.db, "insert into page_cites(page_id,source_id,line_start,line_end,hash) values(?,?,?,?,?)", id, s.id, c.lineStart, c.lineEnd, s.hash);
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

export function readPage(app: App, spaceId: string, slugInput: string): Page {
  const slug = checkSlug(slugInput);
  const file = pageFile(app, spaceId, slug);
  if (!existsSync(file)) throw new HttpError(404, `页面不存在：${spaceId}/${slug}`);
  const { meta, body } = parsePage(readFileSync(file, "utf8"));
  return { id: `${spaceId}/${slug}`, spaceId, slug, meta, body, updatedAt: statSync(file).mtime.toISOString() };
}

export function pageExists(app: App, spaceId: string, slug: string) {
  return existsSync(pageFile(app, spaceId, slug));
}

export function pageContext(app: App, spaceId: string, slug: string) {
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

/** Navigation tree: parsed from index.md links when present, else all pages by slug. */
export function wikiNav(app: App, spaceId: string) {
  const pages = listPages(app, spaceId);
  const titles = new Map(pages.map((p) => [p.slug, p.title]));
  type Node = { slug?: string; title: string; children: Node[] };
  const root: Node[] = [];
  if (titles.has("index")) {
    const { body } = readPage(app, spaceId, "index");
    const stack: { indent: number; node: Node }[] = [];
    let section: Node | null = null;
    for (const line of body.split("\n")) {
      const head = /^#{2,3}\s+(.+)$/.exec(line);
      if (head) {
        section = { title: head[1].trim(), children: [] };
        root.push(section);
        stack.length = 0;
        continue;
      }
      const m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      if (!m) continue;
      const link = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/.exec(m[2]);
      const node: Node = link ? { slug: link[1].trim(), title: link[2]?.trim() || titles.get(link[1].trim()) || link[1].trim(), children: [] } : { title: m[2].replace(/[*_`]/g, "").trim(), children: [] };
      const indent = m[1].replace(/\t/g, "  ").length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1]?.node;
      (parent ? parent.children : section ? section.children : root).push(node);
      stack.push({ indent, node });
    }
    const listed = new Set<string>();
    const walk = (ns: Node[]) => ns.forEach((n) => (n.slug && listed.add(n.slug), walk(n.children)));
    walk(root);
    const rest = pages.filter((p) => p.slug !== "index" && !listed.has(p.slug));
    if (rest.length) root.push({ title: "其他页面", children: rest.map((p) => ({ slug: p.slug, title: p.title, children: [] })) });
    return root;
  }
  for (const p of pages.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.slug.localeCompare(b.slug))) root.push({ slug: p.slug, title: p.title, children: [] });
  return root;
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
