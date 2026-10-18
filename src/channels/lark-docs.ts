import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { json } from "../core/util.ts";
import { keepOriginal } from "../sources/import.ts";
import { upsertSource, type UpsertResult } from "../sources/store.ts";
import { larkCli } from "./lark-cli.ts";
import { withExtension } from "./lark-messages.ts";

/**
 * Feishu/Lark docs as originals, read through lark-cli with the owner's identity.
 *
 * `docs +fetch --doc-format markdown` returns Markdown with leftover DocxXML for
 * blocks Markdown has no form for. Everything that would need a Feishu login to
 * view is made local:
 * - images (`![](https://…/file/<token>)`, `<img src="<token>">`), whiteboards
 *   (thumbnail) and videos/attachments up to `lark.capture.docMediaMaxMB` are downloaded into
 *   files/ and referenced as `omem-file:<name>`; downloads are cached per token in
 *   the source's meta, so a re-read only fetches new media;
 * - embedded sheets become Markdown tables; bitables stay links;
 * - synced blocks are read from their source document;
 * - linked docs (`<cite>` and plain links) are imported into the same space and the
 *   link becomes `src:<id>`, `lark.capture.docLinkDepth` levels deep (at most
 *   `docMaxLinked` per doc); beyond that, links point at local copies when those exist.
 *   Docs that cannot be read are kept as Feishu links, the owner is told once, and
 *   they are retried later (`retryMissingDocs`); when one becomes readable only the
 *   link in the parent is rewritten, so the parent is not understood again.
 */

const SHEET_ROWS = 200;
const MISSING_KEY = "lark_doc_missing";
const DOC_PATH = /^\/(docx|wiki|docs)\/([A-Za-z0-9]+)/;
const DOC_URL = /https?:\/\/[\w.-]*(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki)\/[A-Za-z0-9]+[^\s)"'<>\]]*/g;

export type LarkDocMeta = {
  url: string;
  via: "lark-cli";
  revision?: string;
  documentId?: string;
  token?: string;
  /** media token → stored file name ("" when it could not be downloaded). */
  media?: Record<string, string>;
  /** Linked docs that could not be read, by normalized URL. */
  missing?: Record<string, { title: string; error: string }>;
};

export type LarkDocResult = UpsertResult & {
  /** Linked docs that were created or changed (to be understood as well). */
  related: string[];
  /** Linked docs that could not be read. */
  missing: { url: string; title: string; error: string }[];
};

type Fetched = { title: string; content: string; revision: string; documentId: string };

/** Canonical form of a doc link: same host, `/docx|wiki|docs/<token>`, no query or anchor. */
export function normalizeDocUrl(url: string) {
  const u = new URL(url);
  const m = DOC_PATH.exec(u.pathname);
  if (!m) throw new Error("只支持飞书 docx / wiki 文档链接");
  return { url: `${u.protocol}//${u.host}/${m[1]}/${m[2]}`, type: m[1], token: m[2], origin: `${u.protocol}//${u.host}` };
}

async function fetchDoc(doc: string, extra: string[] = []): Promise<Fetched> {
  const response = await larkCli(["docs", "+fetch", "--doc", doc, "--as", "user", "--doc-format", "markdown", ...extra], 60_000);
  const d = response.data?.document;
  if (typeof d?.content !== "string") throw new Error("飞书返回内容为空");
  const content: string = d.content;
  const title = content.match(/<title>(.*?)<\/title>/)?.[1] || content.split("\n").find((l: string) => l.trim())?.replace(/^#+\s*/, "").slice(0, 120) || "飞书文档";
  return { title: unescapeXml(title), content: content.replace(/<title>.*?<\/title>\n?/, ""), revision: String(d.revision_id ?? ""), documentId: String(d.document_id ?? "") };
}

/** Read a Feishu/Lark docx or wiki page as Markdown (no media handling). */
export async function readLarkDocument(url: string): Promise<{ title: string; markdown: string; revision: string }> {
  const d = await fetchDoc(normalizeDocUrl(url).url);
  return { title: d.title, markdown: d.content, revision: d.revision };
}

// ---- media ---------------------------------------------------------------------------

async function downloadMedia(app: App, token: string, type: "media" | "whiteboard"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "omem-doc-"));
  try {
    await larkCli(["docs", "+media-download", "--token", token, "--type", type, "--output", `./${token}`, "--as", "user"], 600_000, dir);
    const name = readdirSync(dir).find((n) => n.startsWith(token));
    if (!name) throw new Error("没有下载到文件");
    return keepOriginal(app, withExtension(join(dir, name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function attrs(tag: string) {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function unescapeXml(s: string) {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Text that is safe inside `[...]` / `![...]`. */
function label(s: string) {
  return s.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim();
}

function megabytes(n: number) {
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

type Ctx = {
  app: App;
  origin: string;
  /** The doc's own link (for media too large to keep). */
  docUrl: string;
  media: Record<string, string>;
  /** Tokens seen in this version, so the cache only keeps what the doc still uses. */
  used: Set<string>;
  /** Videos and attachments larger than this stay in Feishu. */
  maxBytes: number;
};

async function media(ctx: Ctx, token: string, type: "media" | "whiteboard") {
  ctx.used.add(token);
  if (ctx.media[token] !== undefined && ctx.media[token] !== "") return ctx.media[token];
  try {
    ctx.media[token] = await downloadMedia(ctx.app, token, type);
  } catch (e) {
    console.warn(`[omem] 下载飞书文档素材失败 ${token}：${(e as Error).message}`);
    ctx.media[token] = "";
  }
  return ctx.media[token];
}

/** Replace every match of `re` with the result of an async function, one at a time (lark-cli calls are rate limited). */
async function replaceAsync(text: string, re: RegExp, fn: (m: RegExpExecArray) => Promise<string>) {
  let out = "";
  let last = 0;
  for (const m of [...text.matchAll(re)]) {
    out += text.slice(last, m.index) + (await fn(m as RegExpExecArray));
    last = m.index! + m[0].length;
  }
  return out + text.slice(last);
}

function csvRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

export function csvToTable(csv: string, maxRows = SHEET_ROWS) {
  const rows = csvRows(csv);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (s = "") => s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  const body = rows.slice(1, maxRows + 1).map(line);
  const more = rows.length - 1 > maxRows ? `\n\n（另有 ${rows.length - 1 - maxRows} 行未展开）` : "";
  return [line(rows[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...body].join("\n") + more;
}

async function sheetTable(token: string, sheetId: string) {
  const v = await larkCli(["sheets", "+csv-get", "--spreadsheet-token", token, "--sheet-id", sheetId, "--include-row-prefix=false", "--max-chars", "200000", "--as", "user"], 60_000);
  const d = v.data ?? v;
  const csv = [d.csv, d.content, d.text, d.data].find((x) => typeof x === "string") ?? Object.values(d).find((x) => typeof x === "string" && x.includes(","));
  if (typeof csv !== "string") throw new Error("表格内容为空");
  return csvToTable(csv);
}

/** Media, sheets, synced blocks and mentions → local Markdown. Links to other docs are left for `linkDocs`. */
async function localize(ctx: Ctx, text: string, synced = true): Promise<string> {
  let out = text;
  // Markdown images pointing at Feishu file tokens.
  out = await replaceAsync(out, /!\[([^\]]*)\]\(https?:\/\/[\w.-]+\/file\/([A-Za-z0-9]+)[^)]*\)/g, async (m) => {
    const file = await media(ctx, m[2], "media");
    return file ? `![${label(m[1])}](omem-file:${file})` : m[0];
  });
  // DocxXML images: <img name alt mime src="<token>"/> (or token="…").
  out = await replaceAsync(out, /<img\b[^>]*?\/?>/g, async (m) => {
    const a = attrs(m[0]);
    const token = a.token ?? (a.src && /^[A-Za-z0-9]+$/.test(a.src) ? a.src : "");
    if (!token) return m[0];
    const file = await media(ctx, token, "media");
    const alt = label(a.alt || a.name || "图片");
    return file ? `![${alt}](omem-file:${file})` : `［图片：${alt}］`;
  });
  out = await replaceAsync(out, /<whiteboard\b[^>]*?(?:\/>|>\s*<\/whiteboard>)/g, async (m) => {
    const token = attrs(m[0]).token;
    if (!token) return "";
    const file = await media(ctx, token, "whiteboard");
    return file ? `![画板](omem-file:${file})` : "［画板，未能下载缩略图］";
  });
  // Videos and attachments: <source …/> (usually inside <figure>) and <file …/>.
  out = await replaceAsync(out, /<(source|file)\b[^>]*\btoken="[^"]+"[^>]*?(?:\/>|>\s*<\/\1>)/g, async (m) => {
    const a = attrs(m[0]);
    const size = Number(a.size ?? 0);
    const isVideo = (a.mime ?? "").startsWith("video/");
    const name = label(a.name || (isVideo ? "视频" : "附件"));
    const kind = isVideo ? "视频" : "附件";
    if (size > ctx.maxBytes) return `[${kind}：${name}（${megabytes(size)}，未下载，在飞书中查看）](${ctx.docUrl})`;
    const file = await media(ctx, a.token, "media");
    if (!file) return `［${kind}：${name}，未能下载］`;
    return isVideo ? `![${kind}：${name}](omem-file:${file})` : `[${kind}：${name}](omem-file:${file})`;
  });
  out = out.replace(/<\/?figure[^>]*>/g, "");
  out = await replaceAsync(out, /<sheet\b[^>]*?(?:\/>|>\s*<\/sheet>)/g, async (m) => {
    const a = attrs(m[0]);
    const link = `${ctx.origin}/sheets/${a.token}${a["sheet-id"] ? `?sheet=${a["sheet-id"]}` : ""}`;
    try {
      const table = a["sheet-id"] ? await sheetTable(a.token, a["sheet-id"]) : "";
      if (table) return `\n\n${table}\n\n[在飞书中打开表格](${link})\n\n`;
    } catch (e) {
      console.warn(`[omem] 读取飞书文档内嵌表格失败 ${a.token}：${(e as Error).message}`);
    }
    return `[电子表格](${link})`;
  });
  out = out.replace(/<bitable\b[^>]*?(?:\/>|>\s*<\/bitable>)/g, (tag) => {
    const a = attrs(tag);
    return `[多维表格](${ctx.origin}/base/${a.token}${a["table-id"] ? `?table=${a["table-id"]}` : ""})`;
  });
  if (synced)
    out = await replaceAsync(out, /<synced_reference\b[^>]*?(?:\/>|>\s*<\/synced_reference>)/g, async (m) => {
      const a = attrs(m[0]);
      const token = a["src-token"];
      const block = a["src-block-id"];
      if (!token || !block) return "";
      try {
        const d = await fetchDoc(token, ["--scope", "range", "--start-block-id", block, "--end-block-id", block]);
        return await localize(ctx, d.content.replace(/<\/?fragment[^>]*>/g, ""), false);
      } catch (e) {
        console.warn(`[omem] 读取飞书同步块失败 ${token}#${block}：${(e as Error).message}`);
        return `[同步块（来自另一篇文档）](${ctx.origin}/docx/${token})`;
      }
    });
  out = out.replace(/<synced-source>|<\/synced-source>/g, "");
  out = out.replace(/<cite\b[^>]*\btype="user"[^>]*>\s*<\/cite>/g, (tag) => {
    const name = attrs(tag)["user-name"];
    return name ? `@${name}` : "";
  });
  return out;
}

// ---- linked docs ---------------------------------------------------------------------

type Link = { url: string; title: string };

/** `<cite doc-id … file-type="wiki|docx|doc">` and plain doc links, by normalized URL. */
function docLinks(text: string, origin: string, self: string) {
  const links = new Map<string, Link>();
  for (const m of text.matchAll(/<cite\b[^>]*?>\s*<\/cite>/g)) {
    const a = attrs(m[0]);
    const type = { wiki: "wiki", docx: "docx", doc: "docs" }[a["file-type"] ?? ""];
    if (!type || !a["doc-id"]) continue;
    const url = `${origin}/${type}/${a["doc-id"]}`;
    if (url !== self && !links.has(url)) links.set(url, { url, title: a.title || "飞书文档" });
  }
  for (const m of text.matchAll(DOC_URL)) {
    try {
      const url = normalizeDocUrl(m[0]).url;
      if (url !== self && !links.has(url)) links.set(url, { url, title: "" });
    } catch {}
  }
  return links;
}

/** A doc already in the space, found by its link, its token or its document id. */
export function findLarkDoc(app: App, spaceId: string, url: string) {
  const { token, type } = normalizeDocUrl(url);
  return one<{ id: string; title: string; updated_at: string; meta: string }>(
    app.db,
    `select id, title, updated_at, meta from sources where space_id = ? and deleted_at is null and kind = 'doc'
       and (uri like ? or uri like ? or uri like ? or json_extract(meta, '$.token') = ? or json_extract(meta, '$.documentId') = ?) order by updated_at desc limit 1`,
    spaceId,
    `%/${type}/${token}`,
    `%/${type}/${token}?%`,
    `%/${type}/${token}#%`,
    token,
    token,
  );
}

/** Rewrite cites and doc links: local copies become `src:` links, the rest stay Feishu links. */
function rewriteLinks(text: string, origin: string, local: Map<string, { id: string; title: string }>) {
  const linkFor = (url: string, title: string) => {
    const l = local.get(url);
    return l ? `[${label(title || l.title)}](src:${l.id})` : `[${label(title || "飞书文档")}](${url})`;
  };
  let out = text.replace(/<cite\b[^>]*?>\s*<\/cite>/g, (tag) => {
    const a = attrs(tag);
    const type = { wiki: "wiki", docx: "docx", doc: "docs" }[a["file-type"] ?? ""];
    if (type && a["doc-id"]) return linkFor(`${origin}/${type}/${a["doc-id"]}`, a.title ?? "");
    const kind = { sheets: "sheets", sheet: "sheets", bitable: "base", mindnote: "mindnotes", file: "file", slides: "slides" }[a["file-type"] ?? ""];
    if (kind && a["doc-id"]) return `[${label(a.title || "飞书文件")}](${origin}/${kind}/${a["doc-id"]})`;
    return a.title ? label(a.title) : "";
  });
  // [text](feishu doc url) → [text](src:id); bare URLs → [title](src:id).
  out = out.replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (whole, text: string, href: string) => {
    try {
      const l = local.get(normalizeDocUrl(href).url);
      return l ? `[${text || l.title}](src:${l.id})` : whole;
    } catch {
      return whole;
    }
  });
  out = out.replace(new RegExp(`(?<![(\\[<"])${DOC_URL.source}`, "g"), (href) => {
    try {
      const l = local.get(normalizeDocUrl(href).url);
      return l ? `[${label(l.title)}](src:${l.id})` : href;
    } catch {
      return href;
    }
  });
  return out;
}

// ---- import ----------------------------------------------------------------------------

type ImportOpts = {
  /** How many levels of linked docs to import (default `lark.capture.docLinkDepth`; 0 = none). */
  depth?: number;
  /** Docs being imported further up this chain (a link back to one of them is not followed). */
  chain?: Set<string>;
  /** Unreadable docs first seen in this chain; the top of the chain tells the owner once. */
  unreadable?: Missing[];
  /** A linked doc read within this many ms is not read again. */
  freshMs?: number;
  /** Re-process even when the revision did not change (e.g. to fetch media for old copies). */
  force?: boolean;
};

export async function importLarkDocument(app: App, spaceId: string, input: string, opts: ImportOpts = {}): Promise<LarkDocResult> {
  const cfg = app.config.lark.capture;
  const depth = opts.depth ?? cfg.docLinkDepth;
  const { url, origin, token } = normalizeDocUrl(input);
  const chain = new Set(opts.chain ?? []).add(url);
  const unreadable = opts.unreadable ?? [];
  const existing = findLarkDoc(app, spaceId, url);
  const prev = json<Partial<LarkDocMeta>>(existing?.meta, {});
  const doc = await fetchDoc(url);
  const uri = existing ? (one<{ uri: string }>(app.db, "select uri from sources where id = ?", existing.id)?.uri ?? url) : url;
  if (existing && !opts.force && prev.revision && prev.revision === doc.revision && prev.media && !Object.keys(prev.missing ?? {}).length)
    return { id: existing.id, status: "unchanged", related: [], missing: [] };

  const ctx: Ctx = { app, origin, docUrl: url, media: { ...(prev.media ?? {}) }, used: new Set(), maxBytes: cfg.docMediaMaxMB * 1024 * 1024 };
  let text = await localize(ctx, doc.content);

  const related: string[] = [];
  const missing: LarkDocResult["missing"] = [];
  const nestedMissing: LarkDocResult["missing"] = [];
  const local = new Map<string, { id: string; title: string }>();
  let followed = 0;
  for (const link of docLinks(text, origin, url).values()) {
    const have = findLarkDoc(app, spaceId, link.url);
    const fresh = have && Date.now() - Date.parse(have.updated_at) < (opts.freshMs ?? 86400_000);
    if (have && (fresh || depth <= 0)) {
      local.set(link.url, { id: have.id, title: have.title });
      continue;
    }
    // A link back up the chain is filled in once that doc is saved (see below).
    if (depth <= 0 || chain.has(link.url) || followed >= cfg.docMaxLinked) continue;
    followed++;
    try {
      const r = await importLarkDocument(app, spaceId, link.url, { depth: depth - 1, chain, unreadable });
      const row = one<{ title: string }>(app.db, "select title from sources where id = ?", r.id);
      local.set(link.url, { id: r.id, title: row?.title ?? link.title });
      if (r.status !== "unchanged") related.push(r.id);
      related.push(...r.related);
      nestedMissing.push(...r.missing);
    } catch (e) {
      if (have) local.set(link.url, { id: have.id, title: have.title });
      else missing.push({ url: link.url, title: link.title, error: (e as Error).message.slice(0, 200) });
    }
  }
  text = rewriteLinks(text, origin, local);

  const keptMedia = Object.fromEntries(Object.entries(ctx.media).filter(([t]) => ctx.used.has(t)));
  const meta: LarkDocMeta = {
    url,
    via: "lark-cli",
    revision: doc.revision,
    documentId: doc.documentId || undefined,
    token,
    media: keptMedia,
    ...(missing.length ? { missing: Object.fromEntries(missing.map((m) => [m.url, { title: m.title, error: m.error }])) } : {}),
  };
  const r = upsertSource(app, { spaceId, kind: "doc", uri, title: doc.title, text, meta });
  if (r.status === "unchanged") run(app.db, "update sources set meta = ? where id = ?", JSON.stringify(meta), r.id);
  if (missing.length) unreadable.push(...recordMissing(app, spaceId, r.id, doc.title, missing));
  // Linked docs that link back were saved before this one existed.
  if (r.status === "created") for (const id of related) relinkParent(app, id, url, r.id, doc.title);
  if (!opts.unreadable && unreadable.length) tellUnreadable(app, doc.title, r.id, unreadable);
  const every = [...missing, ...nestedMissing].filter((m, i, list) => list.findIndex((x) => x.url === m.url) === i);
  return { ...r, related: [...new Set(related)], missing: every };
}

// ---- docs that could not be read --------------------------------------------------------

type Missing = { url: string; title: string; error: string; spaceId: string; parents: string[]; parentTitle?: string; since: string; tries: number; lastTry: number };

function missingList(app: App): Missing[] {
  return json(one<{ value: string }>(app.db, "select value from kv where key = ?", MISSING_KEY)?.value, []);
}
function saveMissing(app: App, list: Missing[]) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", MISSING_KEY, JSON.stringify(list));
}

export function missingDocs(app: App) {
  return missingList(app);
}

/** Remember unreadable linked docs; returns the ones not known before. */
function recordMissing(app: App, spaceId: string, parentId: string, parentTitle: string, found: LarkDocResult["missing"]) {
  const list = missingList(app);
  const fresh: Missing[] = [];
  for (const f of found) {
    const m = list.find((x) => x.url === f.url && x.spaceId === spaceId);
    if (m) {
      if (!m.parents.includes(parentId)) m.parents.push(parentId);
      m.error = f.error;
      continue;
    }
    const added = { ...f, spaceId, parents: [parentId], parentTitle, since: new Date().toISOString(), tries: 0, lastTry: Date.now() };
    list.push(added);
    fresh.push(added);
  }
  saveMissing(app, list);
  return fresh;
}

function tellUnreadable(app: App, title: string, id: string, docs: Missing[]) {
  notify(app, {
    title: `《${title}》链接的飞书文档中有 ${docs.length} 篇读不到`,
    body: `${docs.map((f) => `- ${f.title || "（无标题）"}：${f.url}${f.parentTitle && f.parentTitle !== title ? `（在《${f.parentTitle}》里）` : ""}（${f.error}）`).join("\n")}\n\n多半是没有权限。在飞书里申请权限后 omem 会自动重试（每 6 小时），读到后只整理新读到的文档并更新原文里的链接。`,
    link: `#/sources/${id}`,
  });
}

/**
 * Try the linked docs that could not be read before. A doc that can be read now is
 * imported (and returned for understanding); in each parent only the Feishu link is
 * replaced by the local one, without marking the parent for understanding again.
 */
export async function retryMissingDocs(app: App, opts: { force?: boolean } = {}) {
  const list = missingList(app);
  const imported: { spaceId: string; id: string }[] = [];
  const still: Missing[] = [];
  let tried = 0;
  for (const m of list) {
    // At most every 6 hours per doc, unless asked.
    if (!opts.force && Date.now() - (m.lastTry ?? 0) < 6 * 3600_000) {
      still.push(m);
      continue;
    }
    tried++;
    try {
      const r = await importLarkDocument(app, m.spaceId, m.url, { depth: Math.max(0, app.config.lark.capture.docLinkDepth - 1), force: true });
      imported.push({ spaceId: m.spaceId, id: r.id });
      const row = one<{ title: string }>(app.db, "select title from sources where id = ?", r.id);
      for (const parent of m.parents) relinkParent(app, parent, m.url, r.id, row?.title ?? m.title);
    } catch (e) {
      // Stop after a month of failures.
      if (++m.tries < 120) still.push({ ...m, error: (e as Error).message.slice(0, 200), lastTry: Date.now() });
    }
  }
  saveMissing(app, still);
  return { tried, imported };
}

function relinkParent(app: App, parentId: string, url: string, id: string, title: string) {
  const p = one<{ space_id: string; uri: string; title: string; kind: string; text: string; meta: string; deleted_at: string | null }>(
    app.db,
    "select space_id, uri, title, kind, text, meta, deleted_at from sources where id = ?",
    parentId,
  );
  if (!p || p.deleted_at) return;
  const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = p.text
    .replace(new RegExp(`\\[([^\\]]*)\\]\\(${esc}[^)\\s]*\\)`, "g"), (_, t: string) => `[${t || label(title)}](src:${id})`)
    .replace(new RegExp(`(?<![(\\[<"])${esc}[^\\s)"'<>\\]]*`, "g"), () => `[${label(title)}](src:${id})`);
  if (text === p.text) return;
  const meta = json<LarkDocMeta>(p.meta, {} as LarkDocMeta);
  if (meta.missing) delete meta.missing[url];
  upsertSource(app, { spaceId: p.space_id, kind: p.kind as "doc", uri: p.uri, title: p.title, text, meta });
}

/**
 * Read all Feishu docs again (old copies have Feishu image links; this makes them local).
 * Returns what needs understanding: docs whose content changed in Feishu and newly linked docs —
 * not docs that only changed because their media became local.
 */
export async function refreshLarkDocs(app: App, opts: { space?: string; limit?: number; log?: (s: string) => void } = {}) {
  const rows = all<{ id: string; space_id: string; uri: string; meta: string }>(
    app.db,
    `select id, space_id, uri, meta from sources where kind = 'doc' and deleted_at is null and json_extract(meta, '$.via') = 'lark-cli'
       ${opts.space ? "and space_id = ?" : ""} order by updated_at desc limit ?`,
    ...(opts.space ? [opts.space] : []),
    opts.limit ?? 10_000,
  );
  const changed = new Map<string, Set<string>>();
  const add = (space: string, id: string) => changed.set(space, (changed.get(space) ?? new Set()).add(id));
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    const before = json<Partial<LarkDocMeta>>(row.meta, {}).revision;
    try {
      const r = await importLarkDocument(app, row.space_id, json<{ url?: string }>(row.meta, {}).url ?? row.uri, { force: true });
      const after = json<Partial<LarkDocMeta>>(one<{ meta: string }>(app.db, "select meta from sources where id = ?", r.id)?.meta, {}).revision;
      if (r.status !== "unchanged" && before && before !== after) add(row.space_id, r.id);
      for (const id of r.related) add(row.space_id, id);
      done++;
    } catch (e) {
      failed++;
      opts.log?.(`读取失败 ${row.uri}：${(e as Error).message}`);
    }
    opts.log?.(`${done + failed}/${rows.length}`);
  }
  return { total: rows.length, done, failed, changed: [...changed].map(([spaceId, ids]) => ({ spaceId, ids: [...ids] })) };
}

let refreshing: Promise<unknown> | null = null;
let progress: { startedAt: string; finishedAt?: string; at: string; errors: string[]; result?: unknown } | null = null;

/** `refreshLarkDocs` without waiting (it can take a while); the owner gets a notification when it is done. */
export function refreshInBackground(app: App, opts: { space?: string; limit?: number } = {}) {
  if (refreshing) return { started: false, reason: "上一次刷新还没结束", progress };
  const p: NonNullable<typeof progress> = { startedAt: new Date().toISOString(), at: "", errors: [] };
  progress = p;
  const log = (s: string) => (s.startsWith("读取失败") ? p.errors.length < 50 && p.errors.push(s) : (p.at = s));
  refreshing = refreshLarkDocs(app, { ...opts, log })
    .then(async (r) => {
      const { scheduleIngest } = await import("../agents/jobs.ts");
      for (const c of r.changed) scheduleIngest(app, c.spaceId, c.ids, "飞书文档有新内容或新链接的文档");
      Object.assign(p, { result: r });
      notify(app, { title: `飞书文档重新读取完成：${r.done}/${r.total}`, body: `${r.failed ? `${r.failed} 篇读取失败。` : ""}有新内容或新导入的 ${r.changed.reduce((n, c) => n + c.ids.length, 0)} 篇已交给整理。` });
    })
    .catch((e) => {
      p.errors.push((e as Error).message);
      console.warn("[omem] 刷新飞书文档失败：", (e as Error).message);
    })
    .finally(() => {
      p.finishedAt = new Date().toISOString();
      refreshing = null;
    });
  return { started: true };
}

/** Where Feishu docs stand: refresh progress, docs still pointing at Feishu media, local media, unreadable links. */
export function larkDocsStatus(app: App) {
  const docs = all<{ text: string; meta: string }>(app.db, "select text, meta from sources where kind = 'doc' and deleted_at is null and json_extract(meta, '$.via') = 'lark-cli'");
  const remote = /\]\(https?:\/\/[\w.-]+\/file\/|<(?:img|whiteboard|source|sheet)\b/;
  const media = new Set<string>();
  let failedMedia = 0;
  for (const d of docs)
    for (const f of Object.values(json<Partial<LarkDocMeta>>(d.meta, {}).media ?? {})) f ? media.add(f) : failedMedia++;
  return {
    docs: docs.length,
    withoutLocalMedia: docs.filter((d) => remote.test(d.text)).length,
    neverLocalized: docs.filter((d) => !json<Partial<LarkDocMeta>>(d.meta, {}).media).length,
    mediaFiles: media.size,
    missingMediaFiles: [...media].filter((f) => !existsSync(join(app.filesDir, f))).length,
    failedMedia,
    unreadableLinks: missingList(app).length,
    refresh: progress ? { running: !!refreshing, ...progress } : null,
  };
}
