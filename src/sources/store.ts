import { prepareArchive, finishArchive, moveSource } from "./archive.ts";
import { applyAttentionRules, effectiveLevel, levelSql, relocateNotes } from "./attention.ts";
import { watchCatalog } from "./catalog.ts";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now, sha256, sliceLines } from "../core/util.ts";
import { indexText } from "../search/tokenize.ts";
import { vectorIndex } from "../search/vectors.ts";
import { chunkSource } from "./chunk.ts";

export type SourceKind = "doc" | "code" | "chat" | "note" | "web" | "image" | "conversation" | "event" | "meeting" | "activity" | "work";
export type Source = {
  id: string;
  spaceId: string;
  kind: SourceKind;
  uri: string;
  title: string;
  mime: string | null;
  hash: string;
  meta: Record<string, unknown>;
  capturedAt: string;
  updatedAt: string;
  deletedAt: string | null;
  lines?: number;
  /** focus / reference / ignore (null = normal), and who set it (sources/attention.ts). */
  attention?: string | null;
  attentionBy?: string | null;
  /** The level of the nearest folder above it (catalog node), and the level that counts. */
  nodeLevel?: string | null;
  nodeLevelBy?: string | null;
  level?: { level: string; by: string | null; inherited: boolean };
};
type Row = {
  attention?: string | null;
  attention_by?: string | null;
  node_level?: string | null;
  node_level_by?: string | null;
  id: string;
  space_id: string;
  kind: string;
  uri: string;
  title: string;
  mime: string | null;
  hash: string;
  text?: string;
  meta: string;
  captured_at: string;
  updated_at: string;
  deleted_at: string | null;
};
const toSource = (r: Row): Source => ({
  id: r.id,
  spaceId: r.space_id,
  kind: r.kind as SourceKind,
  uri: r.uri,
  title: r.title,
  mime: r.mime,
  hash: r.hash,
  meta: json(r.meta, {}),
  capturedAt: r.captured_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  lines: r.text === undefined ? undefined : r.text.split("\n").length,
  attention: r.attention ?? null,
  attentionBy: r.attention_by ?? null,
  nodeLevel: r.node_level ?? null,
  nodeLevelBy: r.node_level_by ?? null,
  level: effectiveLevel(r),
});
const COLS = "id,space_id,kind,uri,title,mime,hash,meta,captured_at,updated_at,deleted_at,attention,attention_by,node_level,node_level_by";

export type UpsertInput = {
  /** Automatic collection; explicit imports leave this unset. */
  archive?: boolean;
  spaceId: string;
  kind: SourceKind;
  uri: string;
  title: string;
  text: string;
  mime?: string | null;
  meta?: Record<string, unknown>;
};
export type UpsertResult = { id: string; status: "created" | "updated" | "unchanged" };

/**
 * Store the latest version of a source and rebuild its chunks/index. Code and
 * documents keep only the newest original; conversation sources append.
 */
export function upsertSource(app: App, input: UpsertInput): UpsertResult {
  watchCatalog(app);
  const prepared = prepareArchive(app, input);
  if (prepared) {
    if (prepared.sourceId && getSource(app, prepared.sourceId).spaceId !== prepared.input.spaceId)
      moveSource(app, prepared.sourceId, prepared.input.spaceId, prepared.reason, prepared.mode, prepared.ruleId);
    input = prepared.input;
  }
  const text = input.text.replace(/\r\n?/g, "\n");
  const hash = sha256(text);
  const existing = one<{ id: string; hash: string; deleted_at: string | null }>(
    app.db,
    "select id, hash, deleted_at from sources where space_id = ? and uri = ?",
    input.spaceId,
    input.uri,
  );
  if (existing && existing.hash === hash && !existing.deleted_at) {
    if (prepared) finishArchive(app, existing.id, prepared);
    return { id: existing.id, status: "unchanged" };
  }
  const id = existing?.id ?? newId("s");
  const at = now();
  // Notes follow their passage when a document changed (chats only grow, their lines stay).
  const before = existing && !existing.deleted_at && !["chat", "conversation", "activity"].includes(input.kind) && one(app.db, "select 1 from source_notes where source_id = ? and line_start is not null limit 1", id)
    ? sourceText(app, id)
    : null;
  tx(app.db, () => {
    if (existing) {
      clearIndex(app, id);
      run(
        app.db,
        "update sources set kind=?, title=?, mime=?, hash=?, text=?, meta=?, updated_at=?, deleted_at=null where id=?",
        input.kind,
        input.title,
        input.mime ?? null,
        hash,
        text,
        JSON.stringify(input.meta ?? {}),
        at,
        id,
      );
    } else {
      run(
        app.db,
        "insert into sources(id,space_id,kind,uri,title,mime,hash,text,meta,captured_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?)",
        id,
        input.spaceId,
        input.kind,
        input.uri,
        input.title,
        input.mime ?? null,
        hash,
        text,
        JSON.stringify(input.meta ?? {}),
        at,
        at,
      );
    }
    writeIndex(app, id, input.spaceId, input.kind, input.uri, input.title, text);
    if (before !== null) relocateNotes(app, id, before, text);
  });
  if (!["code", "conversation", "activity", "work"].includes(input.kind)) applyAttentionRules(app, id, { ...input, text });
  if (prepared) finishArchive(app, id, prepared);
  else if (!existing &&!["code", "conversation", "activity", "work", "chat"].includes(input.kind)) {
    run(app.db, "insert or ignore into source_routes(source_id,origin_space,mode,reason,decision_hash) values(?,?,'manual','导入时指定空间',?)", id, input.spaceId, hash);
  }
  app.emit({ type: "changed", entity: "source", id, spaceId: input.spaceId });
  return { id, status: existing ? "updated" : "created" };
}

/** Chunks, full-text rows, symbols and references for one source (caller holds the transaction). */
function writeIndex(app: App, id: string, spaceId: string, kind: SourceKind, uri: string, title: string, text: string) {
  const { chunks, outline } = chunkSource(kind, uri, title, text);
  const insChunk = app.db.prepare("insert into chunks(source_id,space_id,ord,kind,title,path,line_start,line_end,text) values(?,?,?,?,?,?,?,?,?)");
  const insFts = app.db.prepare("insert into chunks_fts(rowid,title,body) values(?,?,?)");
  chunks.forEach((c, i) => {
    const r = insChunk.run(id, spaceId, i, c.kind, c.title, c.path, c.lineStart, c.lineEnd, c.text);
    insFts.run(r.lastInsertRowid, indexText(`${title} ${c.title} ${c.path} ${uri}`), indexText(c.text));
  });
  if (outline) {
    const insSym = app.db.prepare("insert into symbols(source_id,space_id,name,qname,kind,line_start,line_end,signature,exported) values(?,?,?,?,?,?,?,?,?)");
    for (const s of outline.symbols) insSym.run(id, spaceId, s.name, s.qname, s.kind, s.lineStart, s.lineEnd, s.signature, s.exported ? 1 : 0);
    const insRef = app.db.prepare("insert into code_refs(source_id,space_id,from_qname,to_name,kind,line,qualifier,bindings) values(?,?,?,?,?,?,?,?)");
    for (const r of outline.refs) insRef.run(id, spaceId, r.fromQname, r.toName, r.kind, r.line, r.qualifier ?? null, r.bindings ? JSON.stringify(r.bindings) : null);
  }
}

/** Rebuild one stored source's index from its text, inside the caller's transaction (merging libraries). */
export function reindexSource(app: App, id: string) {
  const s = one<{ space_id: string; kind: string; uri: string; title: string; text: string; deleted_at: string | null }>(app.db, "select space_id, kind, uri, title, text, deleted_at from sources where id = ?", id);
  clearIndex(app, id);
  if (s && !s.deleted_at) writeIndex(app, id, s.space_id, s.kind as SourceKind, s.uri, s.title, s.text);
}

function clearIndex(app: App, id: string) {
  const rows = all<{ id: number }>(app.db, "select id from chunks where source_id = ?", id);
  vectorIndex().forget(rows.map((r) => r.id));
  const del = app.db.prepare("delete from chunks_fts where rowid = ?");
  for (const r of rows) del.run(r.id);
  run(app.db, "delete from chunks where source_id = ?", id);
  run(app.db, "delete from symbols where source_id = ?", id);
  run(app.db, "delete from code_refs where source_id = ?", id);
}

/** Removing an original keeps a small tombstone so old citations explain themselves. */
export function deleteSource(app: App, id: string) {
  const s = getSource(app, id);
  tx(app.db, () => {
    clearIndex(app, id);
    run(app.db, "update sources set text = '', deleted_at = ?, updated_at = ? where id = ?", now(), now(), id);
  });
  app.emit({ type: "changed", entity: "source", id, spaceId: s.spaceId });
}

/** Remove an original and its index without a tombstone (temporary copies nothing cites for long). */
export function purgeSource(app: App, id: string) {
  tx(app.db, () => {
    clearIndex(app, id);
    run(app.db, "delete from sources where id = ?", id);
  });
}

export function getSource(app: App, id: string): Source {
  const r = one<Row>(app.db, `select ${COLS} from sources where id = ?`, id);
  if (!r) throw new HttpError(404, `原件不存在：${id}`);
  return toSource(r);
}

export function findSourceByUri(app: App, spaceId: string, uri: string): Source | null {
  const r = one<Row>(app.db, `select ${COLS} from sources where space_id = ? and uri = ?`, spaceId, uri);
  return r ? toSource(r) : null;
}

export function sourceText(app: App, id: string): string {
  return one<{ text: string }>(app.db, "select text from sources where id = ?", id)?.text ?? "";
}

/** Lines `from`–`to` (default: all); `last` takes the last that many lines instead (a chat's latest). */
export function readSource(app: App, id: string, from?: number, to?: number, last?: number) {
  const source = getSource(app, id);
  const text = sourceText(app, id);
  const total = text ? text.split("\n").length : 0;
  const start = Math.max(1, last ? total - last + 1 : (from ?? 1));
  const end = Math.min(total, to ?? total);
  return { source: { ...source, lines: total }, lineStart: start, lineEnd: end, text: total ? sliceLines(text, start, end) : "" };
}

export function listSources(app: App, opts: { spaceId?: string; kind?: string; q?: string; limit?: number; offset?: number; includeDeleted?: boolean; level?: string }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.spaceId) {
    where.push("space_id = ?");
    params.push(opts.spaceId);
  }
  if (opts.level) {
    where.push(opts.level === "normal" ? `${levelSql("sources")} is null` : `${levelSql("sources")} = ?`);
    if (opts.level !== "normal") params.push(opts.level);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (!opts.includeDeleted) where.push("deleted_at is null");
  if (opts.q) {
    where.push("(title like ? or uri like ?)");
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const sql = `select ${COLS}, length(text) - length(replace(text, char(10), '')) + 1 as line_count
    from sources ${where.length ? "where " + where.join(" and ") : ""} order by uri limit ? offset ?`;
  const lim = Math.min(opts.limit ?? 500, 5000);
  const rows = all<Row & { line_count: number }>(app.db, sql, ...params, lim, opts.offset ?? 0);
  const total = one<{ n: number }>(app.db, `select count(*) n from sources ${where.length ? "where " + where.join(" and ") : ""}`, ...params)?.n ?? 0;
  return { total, sources: rows.map((r) => ({ ...toSource(r), lines: r.line_count })) };
}

/**
 * Every path of a space at once, for the directory tree of a repository: a tree built from one
 * page is wrong (folder counts, missing folders), and paging a collapsed tree never scrolls.
 * Only what the tree shows, no line counts (those scan every text).
 */
export function listSourcePaths(app: App, opts: { spaceId: string; kind?: string; q?: string }) {
  const where = ["space_id = ?", "deleted_at is null"];
  const params: string[] = [opts.spaceId];
  if (opts.kind) where.push("kind = ?"), params.push(opts.kind);
  if (opts.q) where.push("(title like ? or uri like ?)"), params.push(`%${opts.q}%`, `%${opts.q}%`);
  return all<{ id: string; kind: string; uri: string; title: string; updatedAt: string }>(
    app.db,
    `select id, kind, uri, title, updated_at as updatedAt from sources where ${where.join(" and ")} order by uri limit 200000`,
    ...params,
  );
}

export function sourceOutline(app: App, id: string) {
  const symbols = all<{ name: string; qname: string; kind: string; line_start: number; line_end: number; signature: string; exported: number }>(
    app.db,
    "select name,qname,kind,line_start,line_end,signature,exported from symbols where source_id = ? order by line_start",
    id,
  );
  const sections = all<{ title: string; path: string; line_start: number; line_end: number; kind: string }>(
    app.db,
    "select title,path,line_start,line_end,kind from chunks where source_id = ? order by ord",
    id,
  );
  return { symbols, sections };
}

/** Append lines to a conversation-like source (chat transcripts). */
export function appendToSource(app: App, input: Omit<UpsertInput, "text"> & { lines: string[] }) {
  const existing = findSourceByUri(app, input.spaceId, input.uri);
  const prev = existing && !existing.deletedAt ? sourceText(app, existing.id) : "";
  const text = (prev ? prev + "\n" : "") + input.lines.join("\n");
  const appendedFrom = prev ? prev.split("\n").length + 1 : 1;
  return { ...upsertSource(app, { ...input, text, meta: { ...(existing?.meta ?? {}), ...(input.meta ?? {}), appendedFrom } }), appendedFrom };
}
