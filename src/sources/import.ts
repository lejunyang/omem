import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCodeRefs } from "./callgraph.ts";
import { ensureGrammars } from "./treesitter.ts";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { App } from "../core/app.ts";
import { all, run } from "../core/db.ts";
import { headCommit, listRepoFiles } from "../core/git.ts";
import { getSpace, updateSpace } from "../core/spaces.ts";
import { toolCommand } from "../core/tools.ts";
import { HttpError, newId, sha256 } from "../core/util.ts";
import { hasStoredFile } from "../core/stored-files.ts";
import { classify } from "./chunk.ts";
import { deleteSource, upsertSource, type SourceKind, type UpsertResult } from "./store.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".next", ".nuxt", ".venv", "venv", "__pycache__", ".idea", ".vscode", "coverage", ".cache", ".turbo", ".gradle", "vendor", ".omem"]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".zip", ".gz", ".tgz", ".7z", ".rar", ".jar", ".war", ".class", ".so", ".dll", ".dylib", ".exe", ".bin", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi", ".webm", ".wav", ".flac", ".db", ".sqlite", ".lock", ".onnx", ".safetensors", ".gguf", ".pt", ".npy", ".parquet",
]);
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock|osdk\.lock)$/;
const MAX_TEXT_BYTES = 1_000_000;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const DOC_EXT = new Set([".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls", ".csv", ".html", ".htm", ".epub"]);
export const needsDocumentConversion = (file: string) => DOC_EXT.has(extname(file).toLowerCase());
const exec = promisify(execFile);

function looksBinary(buf: Buffer) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export type ImportReport = { created: number; updated: number; unchanged: number; removed: number; skipped: string[]; sourceIds: string[] };
const emptyReport = (): ImportReport => ({ created: 0, updated: 0, unchanged: 0, removed: 0, skipped: [], sourceIds: [] });
function tally(report: ImportReport, r: UpsertResult) {
  report[r.status]++;
  if (r.status !== "unchanged") report.sourceIds.push(r.id);
}

export function doclingScript(moduleUrl = import.meta.url) {
  // Source lives under src/, installed builds under dist/src/. The parser is packaged at the root.
  for (const prefix of ["../../", "../../../"]) {
    const script = fileURLToPath(new URL(`${prefix}scripts/document-parser/convert.py`, moduleUrl));
    if (existsSync(script)) return script;
  }
  return null;
}

/**
 * Convert supported documents to Markdown. Order: configured converter command,
 * bundled Docling script via uv, then pdftotext / pandoc when installed.
 */
export async function convertDocument(app: App, file: string, signal?: AbortSignal): Promise<string> {
  const ext = extname(file).toLowerCase();
  const attempts: [string, string[], "json"?][] = [];
  const errors: string[] = [];
  const configured = app.config.documents.converter;
  if (configured) {
    // Quotes keep a path with spaces (C:\Program Files\…) in one piece.
    const parts = [...configured.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).replace("{file}", file));
    attempts.push([parts[0], parts.slice(1)]);
  }
  for (const engine of app.config.documents.engines) {
    if (engine === "docling") {
      const script = doclingScript();
      const artifacts = app.config.documents.doclingArtifacts;
      // Structured Office/HTML formats do not require the PDF layout models.
      if (script && ([".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".csv", ".html", ".htm"].includes(ext) || (ext === ".pdf" && artifacts && existsSync(artifacts)))) {
        const uv = toolCommand("uv");
        if (uv) attempts.push([uv[0], [...uv.slice(1), "run", "--project", resolve(script, ".."), "--quiet", "python", script, file, artifacts ?? ""], "json"]);
        else errors.push("docling: 没有 uv（运行 omem setup 选择文档解析，会经 osdk 安装）");
      }
    } else if (engine === "pdftotext" && ext === ".pdf") attempts.push(["pdftotext", ["-layout", file, "-"]]);
    else if (engine === "pandoc" && ![".pdf", ".doc", ".ppt", ".xls"].includes(ext)) attempts.push(["pandoc", [file, "-t", "gfm", "--wrap=none"]]);
  }
  for (const [cmd, args, format] of attempts) {
    signal?.throwIfAborted();
    try {
      const r = await exec(cmd, args, { encoding: "utf8", maxBuffer: 200 * 1024 * 1024, windowsHide: true, timeout: 10 * 60_000, signal });
      // Toolchain launchers may print setup status. The bundled parser emits one final JSON line.
      const out = format === "json" ? r.stdout.trim().split("\n").at(-1)!.trim() : r.stdout.trim();
      if (!out) throw new Error("没有可读正文");
      if (format === "json" || out.startsWith("{")) {
        const parsed = JSON.parse(out) as { markdown?: unknown };
        if (typeof parsed.markdown !== "string" || !parsed.markdown.trim()) throw new Error("解析器未返回 Markdown 正文");
        return parsed.markdown;
      }
      return out;
    } catch (e) {
      signal?.throwIfAborted();
      errors.push(`${cmd}: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim().slice(0, 300)}`);
    }
  }
  throw new HttpError(422, `无法解析 ${basename(file)}。运行 omem setup 选择文档解析方式（Docling / pdftotext / pandoc），或配置转换命令。\n${errors.join("\n")}`);
}

/** Import one file into a space. Binary documents are converted; originals are kept in files/. */
export async function importFile(app: App, spaceId: string, file: string, uri?: string, signal?: AbortSignal, archive = false): Promise<UpsertResult | null> {
  const path = resolve(file);
  await ensureGrammars([path]);
  const ext = extname(path).toLowerCase();
  const id = uri ?? basename(path);
  if (DOC_EXT.has(ext)) {
    const stored = keepOriginal(app, path);
    const text = await convertDocument(app, path, signal);
    return upsertSource(app, { archive, spaceId, kind: "doc", uri: id, title: basename(path, ext), text, mime: ext.slice(1), meta: { original: stored } });
  }
  if (IMAGE_EXT.has(ext)) {
    const stored = keepOriginal(app, path);
    return upsertSource(app, {
      archive, spaceId,
      kind: "image",
      uri: id,
      title: basename(path),
      text: `![${basename(path)}](omem-file:${stored})`,
      mime: `image/${ext.slice(1)}`,
      meta: { original: stored },
    });
  }
  const buf = readFileSync(path);
  if (buf.length > MAX_TEXT_BYTES || looksBinary(buf)) return null;
  const kind: SourceKind = classify(path) === "doc" ? "doc" : "code";
  return upsertSource(app, { archive, spaceId, kind, uri: id, title: basename(path), text: buf.toString("utf8") });
}

export function keepOriginal(app: App, path: string) {
  const buf = readFileSync(path);
  const name = `${sha256(buf).slice(0, 16)}${extname(path).toLowerCase()}`;
  mkdirSync(app.filesDir, { recursive: true });
  // A compressed copy (core/media.ts) stands in for the original: do not bring the large file back.
  if (!hasStoredFile(app, name)) copyFileSync(path, join(app.filesDir, name));
  return name;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(full);
      } else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  visit(root);
  return out;
}

export function repoFiles(root: string): string[] {
  const listed = listRepoFiles(root) ?? walk(root);
  return listed.filter((p) => {
    const parts = p.split("/");
    if (parts.some((s) => SKIP_DIRS.has(s))) return false;
    if (LOCKFILES.test(p)) return false;
    const ext = extname(p).toLowerCase();
    if (BINARY_EXT.has(ext)) return false;
    if (/\.min\.(js|css)$/.test(p) || /\.map$/.test(p)) return false;
    return true;
  });
}

function globToRegex(pattern: string) {
  const p = pattern.replace(/^\.\//, "").replace(/\/$/, "/**");
  const re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}${p.includes("*") ? "" : "(/.*)?"}$`);
}

/**
 * Bring a repo/directory space up to date with its working tree. Only changed
 * files are re-chunked; files that disappeared become tombstones.
 */
export async function syncDirectorySpace(app: App, spaceId: string, onProgress?: (done: number, total: number) => void): Promise<ImportReport> {
  const space = getSpace(app, spaceId);
  if (!space.rootPath) throw new HttpError(400, "这个空间没有关联目录");
  const report = emptyReport();
  // Space settings may exclude paths (archives, vendored docs): prefixes or simple globs.
  const exclude = ((space.settings.exclude as string[] | undefined) ?? []).map(globToRegex);
  const files = repoFiles(space.rootPath).filter((f) => !exclude.some((re) => re.test(f)));
  await ensureGrammars(files);
  const seen = new Set<string>();
  files.forEach((rel, i) => {
    const full = join(space.rootPath!, rel);
    try {
      const st = statSync(full);
      if (st.size > MAX_TEXT_BYTES) return void report.skipped.push(rel);
      const buf = readFileSync(full);
      if (looksBinary(buf)) return void report.skipped.push(rel);
      seen.add(rel);
      const kind: SourceKind = /\.(md|markdown|mdx|txt|rst|adoc)$/i.test(rel) ? "doc" : "code";
      const result = upsertSource(app, { spaceId, kind, uri: rel, title: rel, text: buf.toString("utf8"), meta: { directoryRoot: space.rootPath } });
      // Unchanged files imported before directory ownership was recorded: adopt them (once, not on every sync).
      if (result.status === "unchanged")
        run(app.db, "update sources set meta=json_set(meta, '$.directoryRoot', ?) where id=? and json_extract(meta, '$.directoryRoot') is not ?", space.rootPath, result.id, space.rootPath);
      tally(report, result);
    } catch {
      report.skipped.push(rel);
    }
    if (onProgress && i % 50 === 0) onProgress(i, files.length);
  });
  for (const row of all<{ id: string; uri: string; kind: string; meta: string }>(app.db, "select id, uri, kind, meta from sources where space_id = ? and deleted_at is null and kind in ('code','doc')", spaceId)) {
    // Only prune files that came from the directory; other project materials belong to the same space.
    // Code files from before ownership was recorded carry no directoryRoot: in a repo space a relative
    // path is a directory file too, otherwise files deleted from the repo would never go away.
    const meta = JSON.parse(row.meta || "{}") as { directoryRoot?: string };
    const legacy = meta.directoryRoot === undefined && space.kind === "repo" && row.kind === "code" && !/^[a-z][a-z\d+.-]*:/i.test(row.uri) && !isAbsolute(row.uri);
    const managed = meta.directoryRoot === space.rootPath || legacy;
    if (managed && !seen.has(row.uri)) {
      deleteSource(app, row.id);
      report.removed++;
    }
  }
  if (report.created || report.updated || report.removed || !space.settings.lastSync) resolveCodeRefs(app, spaceId);
  updateSpace(app, spaceId, { settings: { ...space.settings, lastSync: new Date().toISOString(), commit: headCommit(space.rootPath) } });
  return report;
}

/** Import an arbitrary directory into a non-repo space (uri = path relative to that directory). */
export async function importDirectory(app: App, spaceId: string, dir: string): Promise<ImportReport> {
  const root = resolve(dir);
  const report = emptyReport();
  const files = repoFiles(root);
  await ensureGrammars(files);
  for (const rel of files) {
    try {
      const r = await importFile(app, spaceId, join(root, rel), `${basename(root)}/${rel}`);
      if (r) tally(report, r);
      else report.skipped.push(rel);
    } catch {
      report.skipped.push(rel);
    }
  }
  resolveCodeRefs(app, spaceId);
  return report;
}

export function importText(app: App, spaceId: string, input: { title?: string; text: string; kind?: SourceKind; uri?: string }) {
  const title = input.title?.trim() || input.text.trim().split("\n")[0].slice(0, 60) || "笔记";
  return upsertSource(app, { spaceId, kind: input.kind ?? "note", uri: input.uri ?? `note/${newId()}`, title, text: input.text });
}

function htmlToText(html: string) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<(p|div|section|article|li|tr|br|pre|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, body };
}

/**
 * A web page or a Feishu doc as an original. For Feishu docs, `related` lists linked docs that were
 * imported or changed along with it (they need understanding too) and `missing` those that could not be read.
 */
export async function importUrl(app: App, spaceId: string, url: string, opts: { depth?: number; archive?: boolean } = {}): Promise<UpsertResult & { related?: string[]; missing?: { url: string; title: string; error: string }[] }> {
  if (/feishu\.cn|larksuite\.com|larkoffice\.com/.test(url)) {
    const { importLarkDocument } = await import("../channels/lark-docs.ts");
    return importLarkDocument(app, spaceId, url, { depth: opts.depth, archive: opts.archive });
  }
  const res = await fetch(url, { headers: { "user-agent": "omem/0.2 (+personal knowledge capture)" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new HttpError(502, `抓取失败：HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const { title, body } = type.includes("html") ? htmlToText(raw) : { title: url, body: raw };
  return upsertSource(app, { archive: opts.archive, spaceId, kind: "web", uri: url, title: title || url, text: body, meta: { url } });
}

export function recordImport(app: App, spaceId: string, label: string, report: ImportReport) {
  run(app.db, "update spaces set updated_at = datetime('now') where id = ?", spaceId);
  return { label, ...report };
}
