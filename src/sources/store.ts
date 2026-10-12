import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now, sha256, sliceLines } from "../core/util.ts";
import { indexText } from "../search/tokenize.ts";
import { chunkSource } from "./chunk.ts";

export type SourceKind = "doc" | "code" | "chat" | "note" | "web" | "image" | "conversation";
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
};
type Row = {
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
});

export type UpsertInput = {
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
  const text = input.text.replace(/\r\n?/g, "\n");
  const hash = sha256(text);
  const existing = one<{ id: string; hash: string; deleted_at: string | null }>(
    app.db,
    "select id, hash, deleted_at from sources where space_id = ? and uri = ?",
    input.spaceId,
    input.uri,
  );
  if (existing && existing.hash === hash && !existing.deleted_at) return { id: existing.id, status: "unchanged" };
  const id = existing?.id ?? newId("s");
  const at = now();
  const { chunks, outline } = chunkSource(input.kind, input.uri, input.title, text);
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
    const insChunk = app.db.prepare(
      "insert into chunks(source_id,space_id,ord,kind,title,path,line_start,line_end,text) values(?,?,?,?,?,?,?,?,?)",
    );
    const insFts = app.db.prepare("insert into chunks_fts(rowid,title,body) values(?,?,?)");
    chunks.forEach((c, i) => {
      const r = insChunk.run(id, input.spaceId, i, c.kind, c.title, c.path, c.lineStart, c.lineEnd, c.text);
      const titleTerms = indexText(`${input.title} ${c.title} ${c.path} ${input.uri}`);
      insFts.run(r.lastInsertRowid, titleTerms, indexText(c.text));
    });
    if (outline) {
      const insSym = app.db.prepare(
        "insert into symbols(source_id,space_id,name,qname,kind,line_start,line_end,signature,exported) values(?,?,?,?,?,?,?,?,?)",
      );
      for (const s of outline.symbols)
        insSym.run(id, input.spaceId, s.name, s.qname, s.kind, s.lineStart, s.lineEnd, s.signature, s.exported ? 1 : 0);
      const insRef = app.db.prepare("insert into code_refs(source_id,space_id,from_qname,to_name,kind,line) values(?,?,?,?,?,?)");
      for (const r of outline.refs) insRef.run(id, input.spaceId, r.fromQname, r.toName, r.kind, r.line);
    }
  });
  app.emit({ type: "changed", entity: "source", id, spaceId: input.spaceId });
  return { id, status: existing ? "updated" : "created" };
}

function clearIndex(app: App, id: string) {
  const rows = all<{ id: number }>(app.db, "select id from chunks where source_id = ?", id);
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

export function getSource(app: App, id: string): Source {
  const r = one<Row>(app.db, "select id,space_id,kind,uri,title,mime,hash,meta,captured_at,updated_at,deleted_at from sources where id = ?", id);
  if (!r) throw new HttpError(404, `原件不存在：${id}`);
  return toSource(r);
}

export function findSourceByUri(app: App, spaceId: string, uri: string): Source | null {
  const r = one<Row>(app.db, "select id,space_id,kind,uri,title,mime,hash,meta,captured_at,updated_at,deleted_at from sources where space_id = ? and uri = ?", spaceId, uri);
  return r ? toSource(r) : null;
}

export function sourceText(app: App, id: string): string {
  return one<{ text: string }>(app.db, "select text from sources where id = ?", id)?.text ?? "";
}

export function readSource(app: App, id: string, from?: number, to?: number) {
  const source = getSource(app, id);
  const text = sourceText(app, id);
  const total = text ? text.split("\n").length : 0;
  const start = Math.max(1, from ?? 1);
  const end = Math.min(total, to ?? total);
  return { source: { ...source, lines: total }, lineStart: start, lineEnd: end, text: total ? sliceLines(text, start, end) : "" };
}

export function listSources(app: App, opts: { spaceId?: string; kind?: string; q?: string; limit?: number; offset?: number; includeDeleted?: boolean }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.spaceId) {
    where.push("space_id = ?");
    params.push(opts.spaceId);
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
  const sql = `select id,space_id,kind,uri,title,mime,hash,meta,captured_at,updated_at,deleted_at, length(text) - length(replace(text, char(10), '')) + 1 as line_count
    from sources ${where.length ? "where " + where.join(" and ") : ""} order by uri limit ? offset ?`;
  const rows = all<Row & { line_count: number }>(app.db, sql, ...params, opts.limit ?? 500, opts.offset ?? 0);
  const total = one<{ n: number }>(app.db, `select count(*) n from sources ${where.length ? "where " + where.join(" and ") : ""}`, ...params)?.n ?? 0;
  return { total, sources: rows.map((r) => ({ ...toSource(r), lines: r.line_count })) };
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
  return upsertSource(app, { ...input, text, meta: { ...(existing?.meta ?? {}), ...(input.meta ?? {}), appendedFrom } });
}
