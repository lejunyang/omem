import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { json } from "../core/util.ts";
import { keepOriginal } from "../sources/import.ts";
import { sourceText, upsertSource, type UpsertResult } from "../sources/store.ts";
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
  wikiSpaceId?: string;
  wikiNodeToken?: string;
  wikiParentNodeToken?: string;
  parentUrl?: string;
  url: string;
  via: "lark-cli";
  revision?: string;
  documentId?: string;
  token?: string;
  /** media token → stored file name ("" when it could not be downloaded). */
  media?: Record<string, string>;
  /** Linked docs that could not be read, by normalized URL. */
  missing?: Record<string, { title: string; error: string }>;
  /**
   * How many levels of links this doc follows: `docLinkDepth` for a doc given to omem (a link in a
   * message, an import), one less for each level of links below it. Reading it again (refresh, update
   * check) follows only this many, so links of links do not start a new two levels each time.
   */
  depth?: number;
  /** When omem last read it, when its content last changed here, Feishu's last edit, the last update check. */
  fetchedAt?: string;
  changedAt?: string;
  modifiedAt?: string;
  checkedAt?: string;
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

const RATE_LIMITED = /rate|limit|frequen|too many|429|99991400/i;

/** lark-cli with a few waits when Feishu says the calls come too fast. */
async function patient(args: string[], timeoutMs: number, cwd: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await larkCli(args, timeoutMs, cwd);
    } catch (e) {
      if (attempt >= 3 || !RATE_LIMITED.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

async function downloadMedia(app: App, token: string, type: "media" | "whiteboard"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "omem-doc-"));
  try {
    try {
      await patient(["docs", "+media-download", "--token", token, "--type", type, "--output", `./${token}`, "--as", "user"], 600_000, dir);
    } catch (e) {
      // Media the owner may view but not download (e.g. copied from a doc without download permission): the preview still works.
      if (type !== "media") throw e;
      await patient(["docs", "+media-preview", "--token", token, "--output", `./${token}`, "--as", "user"], 600_000, dir).catch((p) => {
        throw new Error(`${(e as Error).message}；预览也失败：${(p as Error).message}`);
      });
    }
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
  /** Tokens already attempted in this read (a failure is not retried within it). */
  tried: Set<string>;
};

const PARALLEL_DOWNLOADS = 4;

/**
 * Download a doc's media a few at a time before the text is rewritten (one lark-cli call per item, each
 * about a second; one at a time made a doc with dozens of images take minutes). Rate limits back off in `patient`.
 */
async function prefetchMedia(ctx: Ctx, text: string) {
  const jobs: [string, "media" | "whiteboard"][] = [];
  for (const m of text.matchAll(/!\[(?:\\.|[^\]\\])*\]\(https?:\/\/[\w.-]+\/file\/([A-Za-z0-9]+)/g)) jobs.push([m[1], "media"]);
  for (const m of text.matchAll(/<img\b[^>]*?\/?>/g)) {
    const a = attrs(m[0]);
    const token = a.token ?? (a.src && /^[A-Za-z0-9]+$/.test(a.src) ? a.src : "");
    if (token) jobs.push([token, "media"]);
  }
  for (const m of text.matchAll(/<whiteboard\b[^>]*>/g)) if (attrs(m[0]).token) jobs.push([attrs(m[0]).token, "whiteboard"]);
  for (const m of text.matchAll(/<(?:source|file)\b[^>]*\btoken="[^"]+"[^>]*>/g)) {
    const a = attrs(m[0]);
    if (Number(a.size ?? 0) <= ctx.maxBytes) jobs.push([a.token, "media"]);
  }
  const todo = [...new Map(jobs.filter(([t]) => !ctx.media[t]).map((j) => [j[0], j])).values()];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_DOWNLOADS, todo.length) }, async () => {
      while (next < todo.length) {
        const [token, type] = todo[next++];
        await media(ctx, token, type);
      }
    }),
  );
}

async function media(ctx: Ctx, token: string, type: "media" | "whiteboard") {
  ctx.used.add(token);
  if (ctx.media[token] || ctx.tried.has(token)) return ctx.media[token] ?? "";
  ctx.tried.add(token);
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
  const csv = [d.annotated_csv, d.csv, d.content, d.text].find((x) => typeof x === "string");
  if (typeof csv !== "string") throw new Error("表格内容为空");
  return csvToTable(csv);
}

function attr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** An HTML link: most of these sit inside tables, lists and other HTML, where Markdown is not parsed. */
function anchor(href: string, text: string) {
  return `<a href="${attr(href)}">${text.replace(/</g, "&lt;")}</a>`;
}

/**
 * Media, sheets, synced blocks, mentions and layout blocks → what the page can show without Feishu.
 * Images, videos and links are written as HTML because they often sit inside DocxXML tables and lists.
 * Links to other docs are left for `rewriteLinks`.
 */
async function localize(ctx: Ctx, text: string, synced = true): Promise<string> {
  await prefetchMedia(ctx, text);
  let out = text;
  // Markdown images pointing at Feishu file tokens; the alt text may contain escaped brackets (\[i\]).
  out = await replaceAsync(out, /!\[((?:\\.|[^\]\\])*)\]\(https?:\/\/[\w.-]+\/file\/([A-Za-z0-9]+)[^)]*\)/g, async (m) => {
    const file = await media(ctx, m[2], "media");
    return file ? `![${m[1].replace(/\s+/g, " ").trim()}](omem-file:${file})` : m[0];
  });
  // DocxXML images: <img name alt mime src="<token>"/> (or token="…").
  out = await replaceAsync(out, /<img\b[^>]*?\/?>/g, async (m) => {
    const a = attrs(m[0]);
    const token = a.token ?? (a.src && /^[A-Za-z0-9]+$/.test(a.src) ? a.src : "");
    if (!token) return m[0];
    const file = await media(ctx, token, "media");
    const alt = label(a.alt || a.name || "图片");
    return file ? `<img src="omem-file:${file}" alt="${attr(alt)}" />` : `［图片：${alt}］`;
  });
  out = await replaceAsync(out, /<whiteboard\b[^>]*?(?:\/>|>\s*<\/whiteboard>)/g, async (m) => {
    const token = attrs(m[0]).token;
    if (!token) return "";
    const file = await media(ctx, token, "whiteboard");
    return file ? `<img src="omem-file:${file}" alt="画板" />` : "［画板，未能下载缩略图］";
  });
  // Videos and attachments: <source …/> (usually inside <figure>) and <file …/>.
  out = await replaceAsync(out, /<(source|file)\b[^>]*\btoken="[^"]+"[^>]*?(?:\/>|>\s*<\/\1>)/g, async (m) => {
    const a = attrs(m[0]);
    const size = Number(a.size ?? 0);
    const isVideo = (a.mime ?? "").startsWith("video/");
    const name = label(a.name || (isVideo ? "视频" : "附件"));
    const kind = isVideo ? "视频" : "附件";
    if (size > ctx.maxBytes) return anchor(ctx.docUrl, `${kind}：${name}（${megabytes(size)}，未下载，在飞书中查看）`);
    const file = await media(ctx, a.token, "media");
    if (!file) return `［${kind}：${name}，未能下载］`;
    return isVideo ? `<video src="omem-file:${file}" controls preload="metadata" title="${attr(name)}"></video>` : anchor(`omem-file:${file}`, `${kind}：${name}`);
  });
  out = out.replace(/<\/?figure[^>]*>/g, "");
  out = await replaceAsync(out, /<sheet\b[^>]*?(?:\/>|>\s*<\/sheet>)/g, async (m) => {
    const a = attrs(m[0]);
    const link = `${ctx.origin}/sheets/${a.token}${a["sheet-id"] ? `?sheet=${a["sheet-id"]}` : ""}`;
    try {
      const table = a["sheet-id"] ? await sheetTable(a.token, a["sheet-id"]) : "";
      if (table) return `\n\n${table}\n\n${anchor(link, "在飞书中打开表格")}\n\n`;
    } catch (e) {
      console.warn(`[omem] 读取飞书文档内嵌表格失败 ${a.token}：${(e as Error).message}`);
    }
    return anchor(link, "电子表格");
  });
  out = out.replace(/<bitable\b[^>]*?(?:\/>|>\s*<\/bitable>)/g, (tag) => {
    const a = attrs(tag);
    return anchor(`${ctx.origin}/base/${a.token}${a["table-id"] ? `?table=${a["table-id"]}` : ""}`, "多维表格");
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
        return anchor(`${ctx.origin}/docx/${token}`, "同步块（来自另一篇文档）");
      }
    });
  out = out.replace(/<synced-source>|<\/synced-source>/g, "");
  out = out.replace(/<cite\b[^>]*\btype="user"[^>]*>\s*<\/cite>/g, (tag) => {
    const name = attrs(tag)["user-name"];
    return name ? `@${name}` : "";
  });
  return layout(out);
}

/**
 * DocxXML layout blocks → HTML. Markdown inside an HTML block is only parsed after a blank line,
 * so grids, columns and callouts get blank lines around their tags.
 */
function layout(text: string) {
  return boldAsHtml(text)
    .replace(/<grid\b[^>]*>/g, '\n\n<div class="doc-grid">\n\n')
    .replace(/<\/grid>/g, "\n\n</div>\n\n")
    .replace(/<column\b[^>]*>/g, (tag) => {
      const ratio = Number(attrs(tag)["width-ratio"]);
      return `\n\n<div class="doc-col"${ratio > 0 ? ` style="flex-grow: ${Math.round(ratio * 100)}"` : ""}>\n\n`;
    })
    .replace(/<\/column>/g, "\n\n</div>\n\n")
    .replace(/<callout\b[^>]*>/g, (tag) => `\n\n<blockquote class="doc-callout">\n\n${attrs(tag).emoji ? `${attrs(tag).emoji} ` : ""}`)
    .replace(/<\/callout>/g, "\n\n</blockquote>\n\n")
    .replace(/<button\b[^>]*?\bsrc="([^"]*)"[^>]*>/g, '<a href="$1">')
    .replace(/<\/button>/g, "</a>")
    .replace(/<bookmark\b[^>]*?\/?>(?:\s*<\/bookmark>)?/g, (tag) => {
      const a = attrs(tag);
      return a.href ? anchor(a.href, a.name || a.href) : "";
    })
    .replace(/<readonly-block\b[^>]*>/g, (tag) => (attrs(tag).href ? anchor(attrs(tag).href, "嵌入内容") : ""))
    .replace(/<\/readonly-block>/g, "")
    .replace(/<html5-block\b[^>]*>/g, (tag) => `［网页组件：${attrs(tag).alt || "未命名"}］`)
    .replace(/<\/html5-block>/g, "")
    .replace(/<chat_card\b[^>]*>/g, (tag) => `［群：${attrs(tag).name || "飞书群"}］`)
    .replace(/<\/chat_card>/g, "")
    .replace(/<checkbox\b[^>]*>/g, (tag) => (attrs(tag).done === "true" ? "☑ " : "☐ "))
    .replace(/<\/checkbox>/g, "")
    .replace(/<task\b[^>]*>/g, (tag) => (attrs(tag).status === "success" ? "☑ " : "☐ "))
    .replace(/<\/task>/g, "")
    // Sub-page lists: each page is a doc link, imported like any other.
    .replace(/<sub-page\b([^>]*?)\/?>(?:\s*<\/sub-page>)?/g, (_, rest: string) => `\n- <cite${rest}></cite>`)
    .replace(/<\/?sub-page-list[^>]*>/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
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

/** A wiki page's child pages that are docs (other kinds stay where they are); errors leave the page without them. */
async function childPages(app: App, url: string, origin: string, max: number, node: import("./lark-wiki.ts").WikiNode | null): Promise<Link[]> {
  try {
    const { wikiChildren, nodeUrl, isReadableNode } = await import("./lark-wiki.ts");
    if (!node?.hasChild || node.nodeType === "shortcut") return [];
    const { nodes } = await wikiChildren(app, node, max);
    return nodes.filter(isReadableNode).map((n) => ({ url: nodeUrl(origin, n), title: n.title }));
  } catch (e) {
    console.warn(`[omem] 读取飞书知识库子页面失败 ${url}：${(e as Error).message}`);
    return [];
  }
}

/** A doc already in the space, found by its link, its token or its document id. */
export function findLarkDoc(app: App, spaceId: string, url: string, includeMoved = false) {
  const { token, type } = normalizeDocUrl(url);
  return one<{ id: string; title: string; updated_at: string; meta: string }>(
    app.db,
    `select id, title, updated_at, meta from sources where (space_id = ? or id in (select source_id from source_locations where origin_space = ?)) and deleted_at is null and kind = 'doc'
       and (uri like ? or uri like ? or uri like ? or json_extract(meta, '$.token') = ? or json_extract(meta, '$.documentId') = ?) order by updated_at desc limit 1`,
    spaceId,
    includeMoved ? spaceId : "",
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
    return l ? anchor(`src:${l.id}`, label(title || l.title)) : anchor(url, label(title || "飞书文档"));
  };
  let out = text.replace(/<cite\b[^>]*?>\s*<\/cite>/g, (tag) => {
    const a = attrs(tag);
    const type = { wiki: "wiki", docx: "docx", doc: "docs" }[a["file-type"] ?? ""];
    if (type && a["doc-id"]) return linkFor(`${origin}/${type}/${a["doc-id"]}`, a.title ?? "");
    const kind = { sheets: "sheets", sheet: "sheets", bitable: "base", mindnote: "mindnotes", file: "file", slides: "slides" }[a["file-type"] ?? ""];
    if (kind && a["doc-id"]) return anchor(`${origin}/${kind}/${a["doc-id"]}`, label(a.title || "飞书文件"));
    return a.title ? label(a.title) : "";
  });
  // <a href="feishu doc url"> → <a href="src:id">.
  out = out.replace(/(<a\b[^>]*\bhref=")([^"]+)"/g, (whole, pre: string, href: string) => {
    try {
      const l = local.get(normalizeDocUrl(href.replace(/&amp;/g, "&")).url);
      return l ? `${pre}src:${l.id}"` : whole;
    } catch {
      return whole;
    }
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
  /** Automatic collection may follow a previously moved original. */
  archive?: boolean;
  /** Re-process even when the revision did not change (e.g. to fetch media for old copies). */
  force?: boolean;
  /** A wiki page's child nodes count as its links (default); a crawl queues them itself. */
  wikiChildren?: boolean;
  /** Docs this whole import may still read (`docMaxPerImport`), shared down the chain. */
  budget?: { left: number };
};

export async function importLarkDocument(app: App, spaceId: string, input: string, opts: ImportOpts = {}): Promise<LarkDocResult> {
  const cfg = app.config.lark.capture;
  const given = opts.depth ?? cfg.docLinkDepth;
  const { url, origin, token, type } = normalizeDocUrl(input);
  const chain = new Set(opts.chain ?? []).add(url);
  const unreadable = opts.unreadable ?? [];
  const budget = opts.budget ?? { left: cfg.docMaxPerImport };
  const existing = findLarkDoc(app, spaceId, url, !!opts.archive);
  const prev = json<Partial<LarkDocMeta>>(existing?.meta, {});
  // Reached by several routes (given directly and as someone's link): the deepest reach wins.
  const depth = Math.max(given, prev.depth ?? -1);
  const doc = await fetchDoc(url);
  let wiki: import("./lark-wiki.ts").WikiNode | null = null;
  let wikiResolved = false;
  try {
    wiki = await (await import("./lark-wiki.ts")).wikiNode(app, url);
    wikiResolved = true;
  } catch (e) {
    console.warn(`[omem] 读取飞书知识库节点失败 ${url}：${(e as Error).message}`);
  }
  const wikiMeta = wikiResolved
    ? { wikiSpaceId: wiki?.spaceId || undefined, wikiNodeToken: wiki?.nodeToken || undefined, wikiParentNodeToken: wiki?.parentNodeToken || undefined }
    : { wikiSpaceId: prev.wikiSpaceId, wikiNodeToken: prev.wikiNodeToken, wikiParentNodeToken: prev.wikiParentNodeToken };
  const uri = existing ? (one<{ uri: string }>(app.db, "select uri from sources where id = ?", existing.id)?.uri ?? url) : url;
  const fetchedAt = new Date().toISOString();
  // Refresh routing metadata even when the document body has not changed.
  const deeper = given > (prev.depth ?? -1);
  if (existing && !opts.force && !deeper && prev.revision && prev.revision === doc.revision && prev.media && !Object.keys(prev.missing ?? {}).length) {
    const meta = { ...prev, ...wikiMeta, fetchedAt, depth };
    if (opts.archive) upsertSource(app, { archive: true, spaceId, kind: "doc", uri, title: existing.title, text: sourceText(app, existing.id), meta });
    run(app.db, "update sources set meta = ? where id = ?", JSON.stringify(meta), existing.id);
    return { id: existing.id, status: "unchanged", related: [], missing: [] };
  }

  const ctx: Ctx = { app, origin, docUrl: url, media: { ...(prev.media ?? {}) }, used: new Set(), maxBytes: cfg.docMediaMaxMB * 1024 * 1024, tried: new Set() };
  let text = await localize(ctx, doc.content);

  const related: string[] = [];
  const missing: LarkDocResult["missing"] = [];
  const nestedMissing: LarkDocResult["missing"] = [];
  const local = new Map<string, { id: string; title: string }>();
  const links = docLinks(text, origin, url);
  // Child pages of a wiki page, as links of the same level; those the text does not link get a list at the end.
  const children = type === "wiki" && depth > 0 && opts.wikiChildren !== false && cfg.docWikiChildren > 0 ? await childPages(app, url, origin, cfg.docWikiChildren, wiki) : [];
  const listed = children.filter((c) => !links.has(c.url));
  if (listed.length) text += `\n\n---\n\n**知识库子页面**\n\n${listed.map((c) => `- [${label(c.title) || "子页面"}](${c.url})`).join("\n")}\n`;
  for (const c of listed) links.set(c.url, c);
  let followed = 0;
  const childUrls = new Set(children.map((c) => c.url));
  for (const link of links.values()) {
    const have = findLarkDoc(app, spaceId, link.url, !!opts.archive);
    const fresh = have && Date.now() - Date.parse(have.updated_at) < (opts.freshMs ?? 86400_000);
    if (have && (fresh || depth <= 0)) {
      local.set(link.url, { id: have.id, title: have.title });
      continue;
    }
    // A link back up the chain is filled in once that doc is saved (see below).
    if (depth <= 0 || chain.has(link.url) || budget.left <= 0) continue;
    // Children have their own cap (docWikiChildren, applied when listing them); links share docMaxLinked.
    if (!childUrls.has(link.url) && followed++ >= cfg.docMaxLinked) continue;
    budget.left--;
    try {
      const r = await importLarkDocument(app, spaceId, link.url, { depth: depth - 1, chain, unreadable, budget, archive: opts.archive });
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
    ...wikiMeta,
    url,
    ...(prev.parentUrl || opts.chain?.size ? { parentUrl: prev.parentUrl ?? [...opts.chain!].at(-1) } : {}),
    via: "lark-cli",
    fetchedAt,
    depth,
    changedAt: prev.revision && prev.revision === doc.revision ? (prev.changedAt ?? fetchedAt) : fetchedAt,
    ...(prev.modifiedAt ? { modifiedAt: prev.modifiedAt } : {}),
    ...(prev.checkedAt ? { checkedAt: prev.checkedAt } : {}),
    revision: doc.revision,
    documentId: doc.documentId || undefined,
    token,
    media: keptMedia,
    ...(missing.length ? { missing: Object.fromEntries(missing.map((m) => [m.url, { title: m.title, error: m.error }])) } : {}),
  };
  const r = upsertSource(app, { archive: opts.archive, spaceId, kind: "doc", uri, title: doc.title, text, meta });
  if (r.status === "unchanged") run(app.db, "update sources set meta = ? where id = ?", JSON.stringify(meta), r.id);
  if (missing.length) unreadable.push(...recordMissing(app, spaceId, r.id, doc.title, missing));
  // Linked docs that link back were saved before this one existed.
  if (r.status === "created") for (const id of related) relinkParent(app, id, url, r.id, doc.title);
  if (!opts.unreadable && unreadable.length) tellUnreadable(app, `《${doc.title}》`, r.id, unreadable);
  const every = [...missing, ...nestedMissing].filter((m, i, list) => list.findIndex((x) => x.url === m.url) === i);
  return { ...r, related: [...new Set(related)], missing: every };
}

// ---- docs that could not be read --------------------------------------------------------

type Missing = {
  url: string;
  title: string;
  error: string;
  spaceId: string;
  parents: string[];
  parentTitle?: string;
  since: string;
  tries: number;
  lastTry: number;
  /** No more retries: too many failures, or the owner said not to bother. */
  gaveUp?: "tries" | "owner" | "gone";
};

/**
 * Failures that retrying cannot fix: the doc was deleted or does not exist, or the link is not a docx
 * (a sheet or bitable inside the wiki, an old-style /docs/ link lark-cli cannot read). Codes from lark-cli.
 */
export function isPermanent(error: string) {
  return /\b338000[23]\b|deleted|not found|Unsupported document type|unsupported --doc input/i.test(error);
}

function missingList(app: App): Missing[] {
  return json(one<{ value: string }>(app.db, "select value from kv where key = ?", MISSING_KEY)?.value, []);
}
function saveMissing(app: App, list: Missing[]) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", MISSING_KEY, JSON.stringify(list));
}

export function missingDocs(app: App, opts: { all?: boolean } = {}) {
  return missingList(app).filter((m) => opts.all || !m.gaveUp);
}

/** Stop retrying some (or all) unreadable docs; they stay Feishu links and are not reported again. */
export function ignoreMissingDocs(app: App, urls: string[] | "all") {
  const list = missingList(app);
  let n = 0;
  for (const m of list)
    if (!m.gaveUp && (urls === "all" || urls.includes(m.url))) {
      m.gaveUp = "owner";
      n++;
    }
  saveMissing(app, list);
  return n;
}

/** Remember unreadable linked docs; returns the ones not known before (only those are reported). */
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
    const gone = isPermanent(f.error);
    const added: Missing = { ...f, spaceId, parents: [parentId], parentTitle, since: new Date().toISOString(), tries: 0, lastTry: Date.now(), ...(gone ? { gaveUp: "gone" as const } : {}) };
    list.push(added);
    // Deleted docs and links lark-cli cannot read as docs stay Feishu links without a word: nothing the owner can do.
    if (!gone) fresh.push(added);
  }
  saveMissing(app, list);
  return fresh;
}

function retryNote(app: App) {
  const { docRetryHours, docRetryMax } = app.config.lark.capture;
  return docRetryMax > 0
    ? `多半是没有权限。在飞书里申请到权限后 omem 会重试（每 ${docRetryHours} 小时，最多 ${docRetryMax} 次，之后不再尝试），读到后只整理新读到的文档并更新原文里的链接。不需要的话：omem lark docs-missing --ignore all。`
    : "多半是没有权限。按设置不会重试（lark.capture.docRetryMax 为 0）；申请到权限后可以用 omem lark docs-missing --retry 读一次。";
}

function tellUnreadable(app: App, title: string, id: string | null, docs: Missing[]) {
  const shown = docs.slice(0, 30);
  notify(app, {
    title: `${title}：链接的飞书文档中有 ${docs.length} 篇读不到`,
    body: `${shown.map((f) => `- ${f.title || "（无标题）"}：${f.url}${f.parentTitle && !title.includes(f.parentTitle) ? `（在《${f.parentTitle}》里）` : ""}（${f.error}）`).join("\n")}${docs.length > shown.length ? `\n- ……另有 ${docs.length - shown.length} 篇，见 omem lark docs-missing` : ""}\n\n${retryNote(app)}`,
    link: id ? `#/sources/${id}` : null,
  });
}

/**
 * Try the linked docs that could not be read before (every `docRetryHours`, at most `docRetryMax`
 * times; then they are given up quietly). A doc that can be read now is imported (and returned for
 * understanding); in each parent only the Feishu link is replaced by the local one, without marking
 * the parent for understanding again.
 */
export async function retryMissingDocs(app: App, opts: { force?: boolean } = {}) {
  const { docRetryHours, docRetryMax, docLinkDepth } = app.config.lark.capture;
  const list = missingList(app);
  const imported: { spaceId: string; id: string }[] = [];
  const still: Missing[] = [];
  let tried = 0;
  for (const m of list) {
    // Recorded before failures were told apart.
    if (!m.gaveUp && isPermanent(m.error)) m.gaveUp = "gone";
    // Asked explicitly: also the ones given up after too many tries, but never the ones the owner dismissed.
    if (m.gaveUp === "owner" || (!opts.force && (m.gaveUp || m.tries >= docRetryMax || Date.now() - (m.lastTry ?? 0) < docRetryHours * 3600_000))) {
      still.push(m);
      continue;
    }
    tried++;
    try {
      const r = await importLarkDocument(app, m.spaceId, m.url, { depth: Math.max(0, docLinkDepth - 1), force: true, unreadable: [] });
      imported.push({ spaceId: m.spaceId, id: r.id });
      const row = one<{ title: string }>(app.db, "select title from sources where id = ?", r.id);
      for (const parent of m.parents) relinkParent(app, parent, m.url, r.id, row?.title ?? m.title);
    } catch (e) {
      const tries = m.tries + 1;
      const error = (e as Error).message.slice(0, 200);
      still.push({ ...m, tries, error, lastTry: Date.now(), ...(isPermanent(error) ? { gaveUp: "gone" as const } : tries >= docRetryMax ? { gaveUp: "tries" as const } : {}) });
    }
  }
  saveMissing(app, still);
  return { tried, imported };
}

export function relinkParent(app: App, parentId: string, url: string, id: string, title: string) {
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
  const linked = text.replace(new RegExp(`href="${esc}[^"]*"`, "g"), `href="src:${id}"`);
  if (linked === p.text) return;
  const meta = json<LarkDocMeta>(p.meta, {} as LarkDocMeta);
  if (meta.missing) delete meta.missing[url];
  upsertSource(app, { spaceId: p.space_id, kind: p.kind as "doc", uri: p.uri, title: p.title, text: linked, meta });
}

// ---- reading all docs again -------------------------------------------------------------

/** Docs captured before omem followed links were all given to it directly. */
const LINKS_FOLLOWED_SINCE = "2026-10-18T12:00:00Z";

/**
 * How many levels a doc follows when read again: what it was imported with. Docs from before that was
 * recorded: given directly if captured before links were followed at all, else reached as a link (0).
 */
function storedDepth(app: App, id: string) {
  const r = one<{ meta: string; captured_at: string }>(app.db, "select meta, captured_at from sources where id = ?", id);
  const d = json<Partial<LarkDocMeta>>(r?.meta, {}).depth;
  if (typeof d === "number") return d;
  return r && r.captured_at < LINKS_FOLLOWED_SINCE ? app.config.lark.capture.docLinkDepth : 0;
}

const REFRESH_KEY = "lark_docs_refresh";

/** A refresh in progress, kept in the database so a restart picks it up where it stopped. */
type RefreshState = {
  startedAt: string;
  space?: string;
  total: number;
  /** Source ids still to read, in order. */
  todo: string[];
  done: number;
  failed: number;
  skipped: number;
  /** Space → ids that need understanding. */
  changed: Record<string, string[]>;
  errors: string[];
  unreadable: Missing[];
};

function refreshState(app: App): RefreshState | null {
  return json(one<{ value: string }>(app.db, "select value from kv where key = ?", REFRESH_KEY)?.value, null);
}
function saveRefresh(app: App, s: RefreshState | null) {
  if (!s) run(app.db, "delete from kv where key = ?", REFRESH_KEY);
  else run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", REFRESH_KEY, JSON.stringify(s));
}

export function startRefresh(app: App, opts: { space?: string; limit?: number } = {}): RefreshState {
  const rows = all<{ id: string }>(
    app.db,
    `select id from sources where kind = 'doc' and deleted_at is null and json_extract(meta, '$.via') = 'lark-cli'
       ${opts.space ? "and space_id = ?" : ""} order by updated_at desc limit ?`,
    ...(opts.space ? [opts.space] : []),
    opts.limit ?? 100_000,
  );
  const s: RefreshState = { startedAt: new Date().toISOString(), space: opts.space, total: rows.length, todo: rows.map((r) => r.id), done: 0, failed: 0, skipped: 0, changed: {}, errors: [], unreadable: [] };
  saveRefresh(app, s);
  return s;
}

/**
 * Read the docs of a refresh one by one (old copies have Feishu image links; this makes them local).
 * Progress is saved after every doc. A doc already read during this refresh — imported as a link of an
 * earlier one — is skipped. What needs understanding: docs whose content changed in Feishu and newly
 * linked docs, not docs that only changed because their media became local.
 */
export async function continueRefresh(app: App, opts: { log?: (s: string) => void; stop?: () => boolean } = {}) {
  const s = refreshState(app);
  if (!s) return null;
  while (s.todo.length) {
    if (opts.stop?.()) return s;
    const id = s.todo[0];
    const row = one<{ space_id: string; uri: string; meta: string; deleted_at: string | null }>(app.db, "select space_id, uri, meta, deleted_at from sources where id = ?", id);
    const meta = json<Partial<LarkDocMeta>>(row?.meta, {});
    if (!row || row.deleted_at || (meta.fetchedAt && meta.fetchedAt >= s.startedAt)) s.skipped++;
    else {
      try {
        const r = await importLarkDocument(app, row.space_id, meta.url ?? row.uri, { force: true, unreadable: s.unreadable, depth: storedDepth(app, id) });
        const after = json<Partial<LarkDocMeta>>(one<{ meta: string }>(app.db, "select meta from sources where id = ?", r.id)?.meta, {}).revision;
        const ids = new Set(s.changed[row.space_id] ?? []);
        if (r.status !== "unchanged" && meta.revision && meta.revision !== after) ids.add(r.id);
        for (const x of r.related) ids.add(x);
        s.changed[row.space_id] = [...ids];
        s.done++;
      } catch (e) {
        s.failed++;
        if (s.errors.length < 50) s.errors.push(`${row.uri}：${(e as Error).message}`);
        opts.log?.(`读取失败 ${row.uri}：${(e as Error).message}`);
      }
    }
    s.todo.shift();
    saveRefresh(app, s);
    opts.log?.(`${s.total - s.todo.length}/${s.total}`);
  }
  saveRefresh(app, null);
  return s;
}

/** Synchronous form for the CLI: start and read everything. */
export async function refreshLarkDocs(app: App, opts: { space?: string; limit?: number; log?: (s: string) => void } = {}) {
  startRefresh(app, opts);
  const s = (await continueRefresh(app, { log: opts.log }))!;
  if (s.unreadable.length) tellUnreadable(app, "重新读取飞书文档", null, s.unreadable);
  return { total: s.total, done: s.done, failed: s.failed, skipped: s.skipped, changed: Object.entries(s.changed).filter(([, ids]) => ids.length).map(([spaceId, ids]) => ({ spaceId, ids })) };
}

let refreshing: Promise<unknown> | null = null;
let stopRequested = false;

/**
 * Run (or resume) a refresh without waiting; the owner gets one notification when it is done,
 * including the linked docs that could not be read. `stop` cancels it after the current doc.
 */
export function refreshInBackground(app: App, opts: { space?: string; limit?: number; stop?: boolean; resume?: boolean } = {}) {
  if (opts.stop) {
    stopRequested = !!refreshing;
    if (!refreshing) saveRefresh(app, null);
    return { stopping: stopRequested };
  }
  if (refreshing) return { started: false, reason: "上一次刷新还没结束", progress: refreshProgress(app) };
  if (!opts.resume || !refreshState(app)) startRefresh(app, opts);
  stopRequested = false;
  refreshing = continueRefresh(app, { stop: () => stopRequested })
    .then(async (s) => {
      if (!s) return;
      if (stopRequested) return saveRefresh(app, null);
      const { scheduleIngest } = await import("../agents/jobs.ts");
      const changed = Object.entries(s.changed).filter(([, ids]) => ids.length);
      for (const [spaceId, ids] of changed) scheduleIngest(app, spaceId, ids, "飞书文档有新内容或新链接的文档");
      lastResult = { ...s, todo: [], finishedAt: new Date().toISOString() };
      const n = changed.reduce((k, [, ids]) => k + ids.length, 0);
      notify(app, { title: `飞书文档重新读取完成：${s.done}/${s.total}`, body: `${s.failed ? `${s.failed} 篇读取失败。` : ""}${s.skipped ? `${s.skipped} 篇在本次已作为链接读过，跳过。` : ""}有新内容或新导入的 ${n} 篇已交给整理。` });
      if (s.unreadable.length) tellUnreadable(app, "重新读取飞书文档", null, s.unreadable);
    })
    .catch((e) => console.warn("[omem] 刷新飞书文档失败：", (e as Error).message))
    .finally(() => (refreshing = null));
  return { started: true, progress: refreshProgress(app) };
}

let lastResult: (RefreshState & { finishedAt: string }) | null = null;

function refreshProgress(app: App) {
  const s = refreshState(app);
  if (s) return { running: !!refreshing, startedAt: s.startedAt, at: `${s.total - s.todo.length}/${s.total}`, done: s.done, failed: s.failed, skipped: s.skipped, errors: s.errors.slice(-10) };
  return lastResult ? { running: false, startedAt: lastResult.startedAt, finishedAt: lastResult.finishedAt, at: `${lastResult.total}/${lastResult.total}`, done: lastResult.done, failed: lastResult.failed, skipped: lastResult.skipped, errors: lastResult.errors.slice(-10) } : null;
}

/** At startup: a refresh interrupted by a restart carries on. */
export function resumeRefresh(app: App) {
  const s = refreshState(app);
  if (!s) return false;
  console.log(`[omem] 继续重新读取飞书文档：${s.total - s.todo.length}/${s.total}`);
  refreshInBackground(app, { resume: true });
  return true;
}

// ---- checking for updates -----------------------------------------------------------------

const DAY = 86400_000;

/** Feishu's own last-edit time for docs, 200 at a time (`drive metas batch_query`). Keyed by token. */
async function lastEdits(tokens: { token: string; type: string }[]) {
  const out = new Map<string, number>();
  for (let i = 0; i < tokens.length; i += 200) {
    const batch = tokens.slice(i, i + 200);
    const v = await larkCli(["drive", "metas", "batch_query", "--data", JSON.stringify({ request_docs: batch.map((t) => ({ doc_token: t.token, doc_type: t.type === "docs" ? "doc" : t.type })) }), "--as", "user"], 60_000);
    for (const m of (v.data?.metas ?? []) as { doc_token?: string; latest_modify_time?: string; request_doc_info?: { doc_token?: string } }[]) {
      const t = Number(m.latest_modify_time) * 1000;
      if (!t) continue;
      for (const k of [m.doc_token, m.request_doc_info?.doc_token]) if (k) out.set(k, t);
    }
  }
  return out;
}

/**
 * When a doc is due for a check: at each of `docRecheckDays` after its last change (7 days, a month, …),
 * once. A doc not changed for longer than the last step is no longer checked. Docs never checked are due.
 */
export function docDue(meta: Partial<LarkDocMeta>, now: number, steps: number[]) {
  const last = Date.parse(meta.modifiedAt ?? meta.changedAt ?? meta.fetchedAt ?? "");
  if (!meta.checkedAt || !last) return true;
  const checked = Date.parse(meta.checkedAt);
  return steps.some((d) => last + d * DAY <= now && checked < last + d * DAY);
}

/**
 * Check docs for updates: ask Feishu for the last-edit time of the docs that are due, and read again only
 * those edited since they were read. Returns what changed, for understanding.
 */
export async function checkLarkDocs(app: App, opts: { force?: boolean; log?: (s: string) => void; progress?: (p: { checked: number; edited: number; read: number }) => void } = {}) {
  const steps = [...app.config.lark.capture.docRecheckDays].sort((a, b) => a - b);
  const now = Date.now();
  const rows = all<{ id: string; space_id: string; uri: string; meta: string; updated_at: string }>(
    app.db,
    "select id, space_id, uri, meta, updated_at from sources where kind = 'doc' and deleted_at is null and json_extract(meta, '$.via') = 'lark-cli'",
  );
  const due = rows
    .map((r) => ({ ...r, m: json<Partial<LarkDocMeta>>(r.meta, {}) }))
    .filter((r) => opts.force || docDue(r.m, now, steps))
    .map((r) => ({ ...r, ...normalizeDocUrl(r.m.url ?? r.uri) }));
  if (!due.length) return { checked: 0, edited: 0, changed: [] as { spaceId: string; ids: string[] }[] };
  const edits = await lastEdits(due.map((d) => ({ token: d.token, type: d.type })));
  const stampOf = (d: (typeof due)[number]) => {
    const at = edits.get(d.token);
    return { checkedAt: new Date().toISOString(), ...(at ? { modifiedAt: new Date(at).toISOString() } : {}) };
  };
  const stamp = (d: (typeof due)[number]) => {
    const cur = json<Partial<LarkDocMeta>>(one<{ meta: string }>(app.db, "select meta from sources where id = ?", d.id)?.meta, {});
    run(app.db, "update sources set meta = ? where id = ?", JSON.stringify({ ...cur, ...stampOf(d) }), d.id);
  };
  // Not edited since it was read: just note the check. Edited ones are read again below, one by one.
  const edited = due.filter((d) => {
    const at = edits.get(d.token);
    if (at && at > Date.parse(d.m.modifiedAt ?? d.m.fetchedAt ?? d.updated_at)) return true;
    stamp(d);
    return false;
  });
  opts.progress?.({ checked: due.length, edited: edited.length, read: 0 });
  const changed = new Map<string, Set<string>>();
  let read = 0;
  for (const d of edited) {
    try {
      const r = await importLarkDocument(app, d.space_id, d.url, { depth: storedDepth(app, d.id) });
      const ids = changed.get(d.space_id) ?? new Set();
      if (r.status !== "unchanged") ids.add(r.id);
      for (const x of r.related) ids.add(x);
      changed.set(d.space_id, ids);
      stamp(d);
      opts.log?.(`有更新：${d.uri}`);
    } catch (e) {
      // Left unstamped: tried again next time.
      opts.log?.(`读取失败 ${d.uri}：${(e as Error).message}`);
    }
    opts.progress?.({ checked: due.length, edited: edited.length, read: ++read });
  }
  return { checked: due.length, edited: edited.length, changed: [...changed].filter(([, ids]) => ids.size).map(([spaceId, ids]) => ({ spaceId, ids: [...ids] })) };
}

let checking: Promise<unknown> | null = null;
let checkProgress: { startedAt: string; finishedAt?: string; checked?: number; edited?: number; read?: number; error?: string } | null = null;

/** `checkLarkDocs` without waiting; what changed goes to understanding. */
export function checkInBackground(app: App, opts: { force?: boolean } = {}) {
  if (checking) return { started: false, reason: "上一次检查还没结束", progress: checkProgress };
  const p: NonNullable<typeof checkProgress> = { startedAt: new Date().toISOString() };
  checkProgress = p;
  checking = checkLarkDocs(app, { ...opts, progress: (x) => Object.assign(p, x) })
    .then(async (r) => {
      if (!r.changed.length) return;
      const { scheduleIngest } = await import("../agents/jobs.ts");
      for (const c of r.changed) scheduleIngest(app, c.spaceId, c.ids, "飞书文档有更新");
    })
    .catch((e) => {
      p.error = (e as Error).message;
      console.warn("[omem] 检查飞书文档更新失败：", p.error);
    })
    .finally(() => {
      p.finishedAt = new Date().toISOString();
      checking = null;
    });
  return { started: true };
}

/** Where Feishu docs stand: refresh progress, docs still pointing at Feishu media, local media, unreadable links, checks. */
export function larkDocsStatus(app: App) {
  const docs = all<{ text: string; meta: string }>(app.db, "select text, meta from sources where kind = 'doc' and deleted_at is null and json_extract(meta, '$.via') = 'lark-cli'");
  const remote = /\]\(https?:\/\/[\w.-]+\/file\/|<img\s(?![^>]*omem-file:)|<(?:whiteboard|source|sheet)\b/;
  const media = new Set<string>();
  let failedMedia = 0;
  const metas = docs.map((d) => json<Partial<LarkDocMeta>>(d.meta, {}));
  for (const m of metas) for (const f of Object.values(m.media ?? {})) f ? media.add(f) : failedMedia++;
  const steps = app.config.lark.capture.docRecheckDays;
  const missing = missingList(app);
  return {
    docs: docs.length,
    withoutLocalMedia: docs.filter((d) => remote.test(d.text)).length,
    neverLocalized: metas.filter((m) => !m.media).length,
    mediaFiles: media.size,
    missingMediaFiles: [...media].filter((f) => !existsSync(join(app.filesDir, f))).length,
    failedMedia,
    unreadableLinks: {
      retrying: missing.filter((m) => !m.gaveUp).length,
      gaveUpAfterTries: missing.filter((m) => m.gaveUp === "tries").length,
      dismissed: missing.filter((m) => m.gaveUp === "owner").length,
      deletedOrNotDocx: missing.filter((m) => m.gaveUp === "gone").length,
    },
    updateChecks: { dueNow: metas.filter((m) => docDue(m, Date.now(), steps)).length, neverChecked: metas.filter((m) => !m.checkedAt).length },
    refresh: refreshProgress(app),
    check: checkProgress ? { running: !!checking, ...checkProgress } : null,
  };
}

/**
 * `**AI：**为…` is not bold in CommonMark (the closing `**` follows punctuation and precedes a letter), and
 * Feishu writes bold that way all the time. Outside code, bold becomes `<b>`.
 */
export function boldAsHtml(text: string) {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "<b>$1</b>")))
    .join("");
}
