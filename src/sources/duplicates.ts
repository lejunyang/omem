import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { json, now } from "../core/util.ts";
import { vectorIndex } from "../search/vectors.ts";
import { hashOf, locate, passageOf, quoteOf } from "./anchor.ts";
import { catalogChanged } from "./catalog.ts";

/**
 * The same Feishu document captured twice: once by its /docx/ link and once as a knowledge-base page
 * (/wiki/). The wiki copy stays; the docx copy becomes an alias of it (`source_aliases`), so old ids in
 * citations (`src:<old>` in memories, pages, messages, notes, share snapshots) keep resolving
 * (`aliasTarget`, used by `getSource` and the tools). Captures resolve a docx link to the wiki copy
 * first (lark-docs.ts), so new pairs do not appear.
 *
 * Merging is an explicit job (`mergeDuplicateDocs`, remote `sources-merge-duplicates`), dry run by
 * default. Each pair is merged in its own transaction and is idempotent (a merged copy is a tombstone
 * and no longer pairs). What moved is written in the alias row's `detail`: the notes moved (with their
 * old lines), the docx copy's level, and the rows of other tables that pointed at it. The docx copy is
 * kept as a tombstone with its text (only its index is dropped), so a merge can be inspected or undone
 * by hand. Docs with identical text that are different documents are not merged: search shows one of
 * them and says how many others have the same content (search.ts).
 */

export type DuplicatePair = { spaceId: string; docx: { id: string; title: string; uri: string }; wiki: { id: string; title: string; uri: string } };

const TOKEN = /\/(docx|wiki|docs)\/([A-Za-z0-9_-]+)/;

/** Where an old source id now lives (merged duplicates), following chains; null when it is not an alias. */
export function aliasTarget(app: App, id: string): string | null {
  let target: string | null = null;
  for (let i = 0, at = id; i < 5; i++) {
    const r = one<{ source_id: string }>(app.db, "select source_id from source_aliases where alias_id = ?", at);
    if (!r) break;
    target = at = r.source_id;
  }
  return target;
}

/** The id to use for a source reference: its merge target when it was merged, else itself. */
export const canonicalSourceId = (app: App, id: string) => aliasTarget(app, id) ?? id;

/** /docx/ copies of docs that also have a /wiki/ copy in the same space (same document id or knowledge-base node). */
export function findDuplicateDocs(app: App, space?: string): DuplicatePair[] {
  const rows = all<{ id: string; space_id: string; uri: string; title: string; document_id: string | null; token: string | null; node: string | null }>(
    app.db,
    `select id, space_id, uri, title, json_extract(meta, '$.documentId') document_id, json_extract(meta, '$.token') token, json_extract(meta, '$.wikiNodeToken') node
     from sources where kind = 'doc' and deleted_at is null and (uri like '%/docx/%' or uri like '%/wiki/%') ${space ? "and space_id = ?" : ""}`,
    ...(space ? [space] : []),
  );
  const objOf = new Map(all<{ token: string; obj_token: string }>(app.db, "select token, obj_token from wiki_nodes where obj_token is not null").map((r) => [r.token, r.obj_token]));
  const wikiBy = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const m = TOKEN.exec(r.uri);
    if (m?.[1] !== "wiki") continue;
    const node = r.node || m[2];
    for (const k of [r.document_id, objOf.get(node)].filter(Boolean)) wikiBy.set(`${r.space_id}|obj:${k}`, r);
    wikiBy.set(`${r.space_id}|node:${node}`, r);
  }
  const out: DuplicatePair[] = [];
  for (const d of rows) {
    const m = TOKEN.exec(d.uri);
    if (m?.[1] !== "docx") continue;
    const w = wikiBy.get(`${d.space_id}|obj:${d.document_id || d.token || m[2]}`) ?? (d.node ? wikiBy.get(`${d.space_id}|node:${d.node}`) : undefined);
    if (w && w.id !== d.id) out.push({ spaceId: d.space_id, docx: { id: d.id, title: d.title, uri: d.uri }, wiki: { id: w.id, title: w.title, uri: w.uri } });
  }
  return out;
}

const RANK: Record<string, number> = { rule: 0, agent: 1, owner: 2 };
/** Tables whose rows point at a source by `source_id` and are moved to the kept copy (the index is dropped instead). */
function refTables(app: App) {
  const skip = new Set(["sources", "chunks", "symbols", "code_refs", "source_notes", "source_aliases", "source_routes"]);
  return all<{ name: string }>(app.db, "select m.name from sqlite_master m join pragma_table_info(m.name) p on p.name = 'source_id' where m.type = 'table'")
    .map((r) => r.name).filter((n) => !skip.has(n) && !n.includes("_fts"));
}

/** Merge one pair: the docx copy's notes, level and references move to the wiki copy; it becomes an alias. */
function mergePair(app: App, p: DuplicatePair) {
  const d = one<{ text: string; attention: string | null; attention_by: string | null; deleted_at: string | null }>(app.db, "select text, attention, attention_by, deleted_at from sources where id = ?", p.docx.id);
  const w = one<{ text: string; attention: string | null; attention_by: string | null; deleted_at: string | null }>(app.db, "select text, attention, attention_by, deleted_at from sources where id = ?", p.wiki.id);
  if (!d || !w || d.deleted_at || w.deleted_at) return null;
  const detail: Record<string, unknown> = { docx: p.docx, at: now() };
  const notes: unknown[] = [];
  for (const n of all<{ id: number; kind: string; line_start: number | null; line_end: number | null; quote: string | null; quote_hash: string | null }>(
    app.db, "select id, kind, line_start, line_end, quote, quote_hash from source_notes where source_id = ?", p.docx.id)) {
    let lines: { lineStart: number; lineEnd: number } | null = null;
    let quote = n.quote, hash = n.quote_hash;
    if (n.line_start !== null) {
      const passage = passageOf(d.text, n.line_start, n.line_end ?? n.line_start);
      quote ??= quoteOf(passage);
      hash ??= hashOf(passage);
      lines = locate(w.text, { hash, quote, len: (n.line_end ?? n.line_start) - n.line_start + 1, near: n.line_start });
    }
    const same = one<{ id: number }>(app.db, "select id from source_notes where source_id = ? and kind = ? and coalesce(line_start, 0) = ? and coalesce(line_end, 0) = ?",
      p.wiki.id, n.kind, lines?.lineStart ?? n.line_start ?? 0, lines?.lineEnd ?? n.line_end ?? 0);
    if (same) {
      notes.push({ id: n.id, dropped: "同一段已有同类标注", lines: [n.line_start, n.line_end] });
      run(app.db, "delete from source_notes where id = ?", n.id);
      continue;
    }
    const stale = n.line_start !== null && !lines;
    run(app.db, "update source_notes set source_id = ?, line_start = ?, line_end = ?, quote = ?, quote_hash = ?, stale_at = case when ? then ? else stale_at end where id = ?",
      p.wiki.id, lines?.lineStart ?? n.line_start, lines?.lineEnd ?? n.line_end, quote, hash, stale ? 1 : 0, now(), n.id);
    notes.push({ id: n.id, from: [n.line_start, n.line_end], to: lines ? [lines.lineStart, lines.lineEnd] : null, ...(stale ? { stale: true } : {}) });
  }
  detail.notes = notes;
  // The docx copy's level counts when the wiki copy has none from someone as high.
  const rank = (by: string | null, level: string | null) => (level ? (RANK[by ?? "agent"] ?? 0) : -1);
  if (d.attention && rank(d.attention_by, d.attention) > rank(w.attention_by, w.attention)) {
    detail.level = { from: { level: w.attention, by: w.attention_by }, to: { level: d.attention, by: d.attention_by } };
    run(app.db, "update sources set attention = ?, attention_by = ? where id = ?", d.attention, d.attention_by, p.wiki.id);
  }
  const moved: Record<string, number> = {};
  for (const t of refTables(app)) {
    const n = Number(run(app.db, `update or ignore ${t} set source_id = ? where source_id = ?`, p.wiki.id, p.docx.id).changes);
    const left = Number(run(app.db, `delete from ${t} where source_id = ?`, p.docx.id).changes);
    if (n || left) moved[t] = n;
  }
  const materials = Number(run(app.db, "update or ignore item_materials set ref = ? where kind = 'source' and ref = ?", p.wiki.id, p.docx.id).changes);
  if (materials) moved.item_materials = materials;
  run(app.db, "delete from source_routes where source_id = ?", p.docx.id);
  detail.moved = moved;
  // A tombstone that keeps its text: out of search and listings, there to inspect or undo the merge.
  const chunks = all<{ id: number }>(app.db, "select id from chunks where source_id = ?", p.docx.id);
  vectorIndex().forget(chunks.map((c) => c.id));
  const del = app.db.prepare("delete from chunks_fts where rowid = ?");
  for (const c of chunks) del.run(c.id);
  for (const t of ["chunks", "symbols", "code_refs"]) run(app.db, `delete from ${t} where source_id = ?`, p.docx.id);
  run(app.db, "update sources set deleted_at = ?, updated_at = ? where id = ?", now(), now(), p.docx.id);
  run(app.db, "update source_aliases set source_id = ? where source_id = ?", p.wiki.id, p.docx.id);
  run(app.db, "insert or replace into source_aliases(alias_id, source_id, reason, detail, created_at) values(?, ?, 'docx-wiki', ?, ?)", p.docx.id, p.wiki.id, JSON.stringify(detail), now());
  return detail;
}

/**
 * Merge every docx/wiki pair (of one space, or all). `dryRun` (the default) only lists them.
 * Returns what was (or would be) merged; each merge is also logged.
 */
export function mergeDuplicateDocs(app: App, opts: { space?: string; dryRun?: boolean; limit?: number } = {}) {
  const pairs = findDuplicateDocs(app, opts.space).slice(0, opts.limit ?? 10_000);
  if (opts.dryRun !== false) return { dryRun: true, pairs: pairs.length, sample: pairs.slice(0, 50) };
  const merged: { docx: string; wiki: string; title: string; notes: number; moved: Record<string, number> }[] = [];
  for (const p of pairs) {
    const detail = tx(app.db, () => mergePair(app, p));
    if (!detail) continue;
    merged.push({ docx: p.docx.id, wiki: p.wiki.id, title: p.wiki.title, notes: (detail.notes as unknown[]).length, moved: detail.moved as Record<string, number> });
    console.log(`[omem] 合并重复文档：${p.docx.id}（docx）→ ${p.wiki.id}（知识库）《${p.wiki.title}》`);
    app.emit({ type: "changed", entity: "source", id: p.wiki.id, spaceId: p.spaceId });
  }
  if (merged.length) catalogChanged(app);
  return { dryRun: false, pairs: pairs.length, merged: merged.length, items: merged.slice(0, 200) };
}

/** Merges done so far (newest first), for the owner to look at. */
export function listAliases(app: App, limit = 200) {
  return all<{ alias_id: string; source_id: string; reason: string; detail: string; created_at: string }>(app.db, "select * from source_aliases order by created_at desc limit ?", limit)
    .map((r) => ({ alias: r.alias_id, source: r.source_id, reason: r.reason, at: r.created_at, detail: json(r.detail, {}) }));
}
