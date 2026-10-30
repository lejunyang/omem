import { lstatSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * Disk usage of a data directory: top-level entries, the files/ store by origin and media type,
 * and the database by table, module and source category. Runs as a child process with its own
 * read-only connection: `dbstat` and the size queries read every page, minutes on a large library.
 */
export type StorageReport = {
  home: string;
  scannedAt: string;
  ms: number;
  dirs: { name: string; bytes: number; files: number }[];
  files: {
    total: { bytes: number; files: number };
    /** origin × media type. */
    groups: { origin: FileOrigin; type: MediaType; bytes: number; files: number }[];
    largest: { name: string; bytes: number; origin: FileOrigin; type: MediaType; label?: string }[];
  };
  db: {
    fileBytes: number;
    walBytes: number;
    freeBytes: number;
    tables: { name: string; module: DbModule; bytes: number; indexBytes: number; rows: number | null }[];
    /** Sources split by kind and where they came from: text, chunks and vectors. */
    sources: { category: string; count: number; textBytes: number; chunkBytes: number; vectorBytes: number }[];
  };
};
export type FileOrigin = "chat" | "doc-media" | "import" | "unreferenced";
export type MediaType = "image" | "video" | "audio" | "document" | "archive" | "other";
export type DbModule = "sources" | "chunks" | "fts" | "code" | "lark" | "runs" | "chat" | "memory" | "wiki" | "items" | "other";

const MEDIA: [MediaType, RegExp][] = [
  ["image", /^\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico)$/],
  ["video", /^\.(mp4|mov|m4v|webm|mkv|avi|flv|wmv|3gp)$/],
  ["audio", /^\.(mp3|m4a|aac|ogg|opus|wav|flac|amr|silk)$/],
  ["document", /^\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|rtf|odt|ods|odp|key|pages|numbers)$/],
  ["archive", /^\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/],
];
export const mediaType = (name: string): MediaType => MEDIA.find(([, re]) => re.test(extname(name).toLowerCase()))?.[0] ?? "other";

/** Tables are grouped by name; FTS shadow tables (`x_fts_data`…) count as search indexes. */
export function dbModule(table: string): DbModule {
  if (/_fts(_|$)/.test(table)) return "fts";
  if (/^(sources|source_\w+|sqlite_\w+)$/.test(table)) return table.startsWith("sqlite_") ? "other" : "sources";
  if (table === "chunks") return "chunks";
  if (/^(symbols|code_refs)$/.test(table)) return "code";
  if (/^(lark_\w+|handled_messages|card_\w+|cards|chat_settings|identities)$/.test(table)) return "lark";
  if (/^(runs|run_events|shadow_writes|reviews|review_findings|asks|digest_\w+|rule_\w+|profile_proposals)$/.test(table)) return "runs";
  if (/^(conversations|messages|plugin_\w+|notifications)$/.test(table)) return "chat";
  if (/^(memories|memory_\w+)$/.test(table)) return "memory";
  if (/^(pages|page_\w+)$/.test(table)) return "wiki";
  if (/^(items|item_\w+)$/.test(table)) return "items";
  return "other";
}

function walk(path: string): { bytes: number; files: number } {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return { bytes: 0, files: 0 };
  if (!st.isDirectory()) return { bytes: st.isSymbolicLink() ? 0 : st.size, files: st.isSymbolicLink() ? 0 : 1 };
  let bytes = 0, files = 0;
  let entries: string[] = [];
  try { entries = readdirSync(path); } catch { return { bytes, files }; }
  for (const e of entries) {
    const r = walk(join(path, e));
    bytes += r.bytes;
    files += r.files;
  }
  return { bytes, files };
}

const hasTable = (db: DatabaseSync, name: string) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);

/** Which stored file each origin references (first match wins: chat, then doc media, then imports). */
function fileOrigins(db: DatabaseSync) {
  const origins = new Map<string, { origin: FileOrigin; label?: string }>();
  const put = (file: unknown, origin: FileOrigin, label?: string) => {
    if (typeof file === "string" && file && !origins.has(file)) origins.set(file, { origin, label });
  };
  if (hasTable(db, "lark_messages"))
    for (const r of db.prepare("select json_extract(r.value, '$.file') file, json_extract(r.value, '$.name') name from lark_messages m, json_each(m.resources) r where m.resources != '{}'").iterate() as Iterable<{ file: string; name: string | null }>)
      put(r.file, "chat", r.name ?? undefined);
  for (const r of db.prepare("select value from kv where key like 'lark_res:%'").iterate() as Iterable<{ value: string }>) put(r.value, "chat");
  for (const r of db.prepare("select s.title, m.value file from sources s, json_each(s.meta, '$.media') m where json_type(s.meta, '$.media') = 'object'").iterate() as Iterable<{ title: string; file: string }>)
    put(r.file, "doc-media", r.title);
  for (const r of db.prepare("select title, uri, json_extract(meta, '$.original') file from sources where json_extract(meta, '$.original') is not null").iterate() as Iterable<{ title: string; uri: string; file: string }>)
    put(r.file, r.uri.startsWith("lark:") ? "chat" : "import", r.title);
  // A compressed copy (media.ts) belongs where its original is referenced.
  if (hasTable(db, "file_variants"))
    for (const r of db.prepare("select original, file from file_variants where status = 'done' and file is not null").iterate() as Iterable<{ original: string; file: string }>) {
      const o = origins.get(r.original);
      if (o) put(r.file, o.origin, o.label);
    }
  return origins;
}

function scanFiles(filesDir: string, db: DatabaseSync): StorageReport["files"] {
  const origins = fileOrigins(db);
  const groups = new Map<string, { origin: FileOrigin; type: MediaType; bytes: number; files: number }>();
  const all: StorageReport["files"]["largest"] = [];
  let names: string[] = [];
  try { names = readdirSync(filesDir); } catch { /* no files yet */ }
  for (const name of names) {
    const st = lstatSync(join(filesDir, name), { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    const o = origins.get(name) ?? { origin: "unreferenced" as const };
    const type = mediaType(name);
    const key = `${o.origin}/${type}`;
    const g = groups.get(key) ?? { origin: o.origin, type, bytes: 0, files: 0 };
    g.bytes += st.size;
    g.files++;
    groups.set(key, g);
    all.push({ name, bytes: st.size, origin: o.origin, type, label: o.label });
  }
  const list = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  return {
    total: { bytes: list.reduce((s, g) => s + g.bytes, 0), files: list.reduce((s, g) => s + g.files, 0) },
    groups: list,
    largest: all.sort((a, b) => b.bytes - a.bytes).slice(0, 30),
  };
}

function scanDb(path: string, db: DatabaseSync): StorageReport["db"] {
  const owner = new Map((db.prepare("select name, tbl_name from sqlite_master where type in ('table', 'index')").all() as { name: string; tbl_name: string }[]).map((r) => [r.name, r.tbl_name]));
  const types = new Map((db.prepare("select name, type from sqlite_master").all() as { name: string; type: string }[]).map((r) => [r.name, r.type]));
  const tables = new Map<string, { name: string; module: DbModule; bytes: number; indexBytes: number; rows: number | null }>();
  for (const r of db.prepare("select name, sum(pgsize) bytes from dbstat group by name").all() as { name: string; bytes: number }[]) {
    const table = owner.get(r.name) ?? r.name;
    const t = tables.get(table) ?? { name: table, module: dbModule(table), bytes: 0, indexBytes: 0, rows: null };
    if (types.get(r.name) === "index" || r.name.startsWith("sqlite_autoindex_")) t.indexBytes += r.bytes;
    else t.bytes += r.bytes;
    tables.set(table, t);
  }
  for (const t of tables.values())
    if (types.get(t.name) === "table" && !/_fts_|^sqlite_/.test(t.name))
      try { t.rows = (db.prepare(`select count(*) n from "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n; } catch { /* virtual or unreadable */ }
  const category = `s.kind || case
      when s.uri like 'lark:%' then ':lark'
      when json_extract(s.meta, '$.directoryRoot') is not null then ':dir'
      when json_extract(s.meta, '$.url') is not null or s.uri like 'http%' then ':url'
      else '' end`;
  const text = new Map((db.prepare(`select ${category} category, count(*) count, sum(length(cast(s.text as blob))) bytes from sources s group by 1`).all() as { category: string; count: number; bytes: number }[]).map((r) => [r.category, r]));
  const chunks = new Map((db.prepare(`select ${category} category, sum(length(cast(c.text as blob))) bytes, sum(coalesce(length(c.embedding), 0)) vectors from chunks c join sources s on s.id = c.source_id group by 1`).all() as { category: string; bytes: number; vectors: number }[]).map((r) => [r.category, r]));
  const sources = [...new Set([...text.keys(), ...chunks.keys()])].map((category) => ({
    category,
    count: text.get(category)?.count ?? 0,
    textBytes: text.get(category)?.bytes ?? 0,
    chunkBytes: chunks.get(category)?.bytes ?? 0,
    vectorBytes: chunks.get(category)?.vectors ?? 0,
  }));
  const pageSize = (db.prepare("pragma page_size").get() as { page_size: number }).page_size;
  const free = (db.prepare("pragma freelist_count").get() as { freelist_count: number }).freelist_count;
  return {
    fileBytes: lstatSync(path, { throwIfNoEntry: false })?.size ?? 0,
    walBytes: lstatSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0,
    freeBytes: free * pageSize,
    tables: [...tables.values()].sort((a, b) => b.bytes + b.indexBytes - a.bytes - a.indexBytes),
    sources: sources.sort((a, b) => b.textBytes + b.chunkBytes + b.vectorBytes - a.textBytes - a.chunkBytes - a.vectorBytes),
  };
}

export function scanStorage(home: string): StorageReport {
  const started = Date.now();
  const dbPath = join(home, "omem.db");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let names: string[] = [];
    try { names = readdirSync(home); } catch { /* empty home */ }
    const dirs = names.map((name) => ({ name, ...walk(join(home, name)) })).sort((a, b) => b.bytes - a.bytes);
    const files = scanFiles(join(home, "files"), db);
    const report = scanDb(dbPath, db);
    return { home, scannedAt: new Date().toISOString(), ms: Date.now() - started, dirs, files, db: report };
  } finally {
    db.close();
  }
}

// `node storage-scan.ts <home>`: the report as JSON on stdout.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.stdout.write(JSON.stringify(scanStorage(process.argv[2])));
