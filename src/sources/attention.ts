import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { archiveCondition, matchesArchive, type ArchiveCondition } from "./archive.ts";
import { hashOf, passageOf, quoteOf, locate } from "./anchor.ts";
import { catalog, nodePath, sourcesUnder } from "./catalog.ts";
import type { UpsertInput } from "./store.ts";

/**
 * How much an original matters to the owner. Not every collected document or chat deserves the same
 * treatment: some are what the owner works from, some only need to be findable, some are noise.
 *
 * - focus      重点关注：read first and in depth when digesting, ranked higher in search.
 * - normal     一般关注（no level set）.
 * - reference  仅检索：history and background; searchable at a lower rank, never digested.
 * - ignore     忽略：left out of search and digestion; still readable by id and cited where it was.
 *
 * Who set it matters: the owner's choice stands; an agent may refine a level a rule or another agent
 * gave; rules only fill levels nobody chose. Line notes (`source_notes`) mark what inside a document
 * is outdated, wrong or the key part, so a half-stale document stays useful.
 */

export const LEVELS = ["focus", "normal", "reference", "ignore"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_LABELS: Record<Level, string> = { focus: "重点关注", normal: "一般关注", reference: "仅检索", ignore: "忽略" };
export type SetBy = "owner" | "agent" | "rule";

/** Search weight by level (ignore is filtered out before ranking). */
export const LEVEL_WEIGHT: Record<Level, number> = { focus: 1.6, normal: 1, reference: 0.55, ignore: 0 };
/** Weight of a hit that falls on lines marked outdated or wrong, and on lines marked key. */
export const NOTE_WEIGHT = { outdated: 0.5, wrong: 0.35, key: 1.3, note: 1, exclude: 0.2 } as const;

const RANK: Record<SetBy, number> = { rule: 0, agent: 1, owner: 2 };

/**
 * The level that counts for a source: its own, unless a folder above it (a catalog node, see
 * `setNodeLevel`) was set by someone who ranks higher — the owner's folder level beats an agent's
 * guess on one doc, while a doc's own level beats a folder level of the same or a lower rank.
 * `sources.node_level` holds the nearest folder level, kept up to date by `applyNodeLevels`.
 */
export function effectiveLevel(r: { attention?: string | null; attention_by?: string | null; node_level?: string | null; node_level_by?: string | null }): { level: Level; by: SetBy | null; inherited: boolean } {
  const own = { level: (r.attention as Level | null) ?? "normal", by: (r.attention_by as SetBy | null) ?? null, inherited: false };
  if (!r.node_level) return own;
  const nodeBy = (r.node_level_by as SetBy | null) ?? "agent";
  if (r.attention && RANK[nodeBy] <= RANK[(r.attention_by as SetBy | null) ?? "agent"]) return own;
  return { level: r.node_level as Level, by: nodeBy, inherited: true };
}

/** SQL for the effective level of `sources <alias>` (null = normal), the same rule as `effectiveLevel`. */
export const levelSql = (a = "s") =>
  `(case when ${a}.node_level is not null and (${a}.attention is null or instr('rule,agent,owner', coalesce(${a}.node_level_by, 'agent')) > instr('rule,agent,owner', coalesce(${a}.attention_by, 'agent'))) then nullif(${a}.node_level, 'normal') else ${a}.attention end)`;

/**
 * Set the level of some sources. A lower-ranked setter never overrides a higher one (an agent cannot
 * undo the owner's choice). `null` clears it back to normal (owner only clears the owner's).
 */
export function setAttention(app: App, ids: string[], level: Level | null, by: SetBy): { changed: number; kept: number } {
  let changed = 0;
  let kept = 0;
  tx(app.db, () => {
    for (const id of new Set(ids)) {
      const row = one<{ attention: string | null; attention_by: SetBy | null }>(app.db, "select attention, attention_by from sources where id = ?", id);
      if (!row) continue;
      if (row.attention_by && RANK[row.attention_by] > RANK[by]) {
        kept++;
        continue;
      }
      const value = level === "normal" ? null : level;
      if (row.attention === value && (value === null || row.attention_by === by)) continue;
      run(app.db, "update sources set attention = ?, attention_by = ? where id = ?", value, value === null && by !== "owner" ? null : by, id);
      changed++;
    }
  });
  if (changed) app.emit({ type: "changed", entity: "source", id: ids[0] });
  return { changed, kept };
}

/** A source's own level (what `setAttention` set); `effective` also counts the folder level above it. */
export function levelOf(app: App, id: string, effective = false): { level: Level; by: SetBy | null; inherited?: boolean } {
  const r = one<{ attention: string | null; attention_by: SetBy | null; node_level: string | null; node_level_by: string | null }>(app.db, "select attention, attention_by, node_level, node_level_by from sources where id = ?", id);
  if (effective) return effectiveLevel(r ?? {});
  return { level: (r?.attention as Level | null) ?? "normal", by: r?.attention_by ?? null };
}

// ---- levels of whole folders ---------------------------------------------------------------------

export type NodeLevel = { spaceId: string; key: string; level: Level; by: SetBy; status: "active" | "confirmed" | "rejected"; reason: string; runId: string | null; at: string };
const toNodeLevel = (r: { space_id: string; node_key: string; level: string; by: string; status: string; reason: string; run_id: string | null; updated_at: string }): NodeLevel =>
  ({ spaceId: r.space_id, key: r.node_key, level: r.level as Level, by: r.by as SetBy, status: r.status as NodeLevel["status"], reason: r.reason, runId: r.run_id, at: r.updated_at });

export function nodeLevels(app: App, spaceId: string, opts: { all?: boolean } = {}): NodeLevel[] {
  return all<Parameters<typeof toNodeLevel>[0]>(app.db, `select * from source_node_levels where space_id = ? ${opts.all ? "" : "and status != 'rejected'"}`, spaceId).map(toNodeLevel);
}

/**
 * Set the level of a catalog node: it holds for everything below it, including sources that arrive
 * later, unless a source has its own level from the same or a higher rank (`effectiveLevel`). An agent
 * never changes the owner's folder level, and does not set again a level the owner rejected there.
 * `null` clears it.
 */
export function setNodeLevel(app: App, spaceId: string, key: string, level: Level | null, by: SetBy, opts: { reason?: string; runId?: string | null; future?: boolean } = {}) {
  const cat = catalog(app, spaceId);
  // `future`: a node its sources will bring (a knowledge base mapped to the space before its first page is read).
  if (!cat.nodes.has(key) && !opts.future) throw new HttpError(404, `目录里没有这个节点：${key}（用 list_sources 看节点）`);
  const have = one<{ level: string; by: SetBy; status: string }>(app.db, "select level, by, status from source_node_levels where space_id = ? and node_key = ?", spaceId, key);
  if (have && have.status !== "rejected" && RANK[have.by] > RANK[by]) return { changed: false, kept: true, sources: 0 };
  if (have?.status === "rejected" && by !== "owner" && have.level === (level ?? "normal")) return { changed: false, kept: true, rejected: true, sources: 0 };
  if (level === null) {
    if (!have) return { changed: false, kept: false, sources: 0 };
    run(app.db, "delete from source_node_levels where space_id = ? and node_key = ?", spaceId, key);
  } else
    run(app.db, `insert into source_node_levels(space_id, node_key, level, by, status, reason, run_id, updated_at) values(?,?,?,?,?,?,?,?)
      on conflict(space_id, node_key) do update set level = excluded.level, by = excluded.by, status = excluded.status, reason = excluded.reason, run_id = excluded.run_id, updated_at = excluded.updated_at`,
      spaceId, key, level, by, by === "owner" ? "confirmed" : "active", opts.reason ?? "", opts.runId ?? null, now());
  const sources = applyNodeLevels(app, spaceId).changed;
  app.emit({ type: "changed", entity: "source", id: key, spaceId });
  return { changed: true, kept: false, sources };
}

/** The owner's call on a folder level an agent set: confirm (it becomes the owner's) or reject (removed, and the agent cannot set it again). */
export function reviewNodeLevel(app: App, spaceId: string, key: string, decision: "confirm" | "reject") {
  const have = one<{ level: string }>(app.db, "select level from source_node_levels where space_id = ? and node_key = ?", spaceId, key);
  if (!have) throw new HttpError(404, "这个节点没有定级");
  if (decision === "confirm") run(app.db, "update source_node_levels set by = 'owner', status = 'confirmed', updated_at = ? where space_id = ? and node_key = ?", now(), spaceId, key);
  else run(app.db, "update source_node_levels set status = 'rejected', updated_at = ? where space_id = ? and node_key = ?", now(), spaceId, key);
  applyNodeLevels(app, spaceId);
  app.emit({ type: "changed", entity: "source", id: key, spaceId });
}

/** Write each source's nearest folder level (`sources.node_level`) for a space. */
export function applyNodeLevels(app: App, spaceId: string) {
  const levels = new Map(nodeLevels(app, spaceId).map((l) => [l.key, l]));
  const cat = catalog(app, spaceId);
  let changed = 0;
  tx(app.db, () => {
    const up = app.db.prepare("update sources set node_level = ?, node_level_by = ? where id = ?");
    for (const r of cat.rows.values()) {
      let found: NodeLevel | undefined;
      if (levels.size)
        for (let k = cat.nodeOf.get(r.id); k && !found; k = cat.nodes.get(k)?.parent) found = levels.get(k);
      const level = found?.level ?? null;
      const by = found?.by ?? null;
      if (level === r.node_level && by === r.node_level_by) continue;
      up.run(level, by, r.id);
      r.node_level = level;
      r.node_level_by = by;
      changed++;
    }
  });
  return { changed };
}

const pending = new WeakMap<App, Set<string>>();
/** Sources arrived or moved in a space with folder levels: give them theirs shortly (several changes, one pass). */
export function scheduleNodeLevels(app: App, spaceId?: string) {
  const spaces = spaceId ? [spaceId] : all<{ space_id: string }>(app.db, "select distinct space_id from source_node_levels").map((r) => r.space_id);
  const todo = pending.get(app);
  const fresh = spaces.filter((s) => !todo?.has(s) && one(app.db, "select 1 from source_node_levels where space_id = ? limit 1", s));
  if (!fresh.length) return;
  if (todo) return void fresh.forEach((s) => todo.add(s));
  const set = new Set(fresh);
  pending.set(app, set);
  setTimeout(() => {
    pending.delete(app);
    for (const s of set) {
      try {
        applyNodeLevels(app, s);
      } catch (e) {
        console.warn(`[omem] 目录关注程度没有更新（${s}）：${(e as Error).message}`);
      }
    }
  }, 3000).unref?.();
}

// ---- selecting many at once --------------------------------------------------------------------

export const sourceFilter = z.object({
  space: z.string().optional(),
  ids: z.array(z.string()).max(2000).optional(),
  kind: z.string().optional(),
  /** Sources of one captured chat (every monthly archive of it). */
  chat_id: z.string().optional(),
  title_contains: z.string().optional(),
  uri_prefix: z.string().optional(),
  /** Feishu wiki path or space name contains this. */
  wiki_path_contains: z.string().optional(),
  /** Everything below a catalog node of `space` (sources/catalog.ts keys, e.g. `wiki:<id>`, `chat:<chatId>`). */
  under: z.string().optional(),
  level: z.enum(LEVELS).optional(),
  updated_before: z.string().optional(),
  updated_after: z.string().optional(),
});
export type SourceFilter = z.infer<typeof sourceFilter>;

/** Where-clause for a filter over `sources s`; `spaces` limits to what the caller may read. `under` needs `app` and `space`. */
export function filterSql(f: SourceFilter, spaces?: string[] | null, app?: App) {
  const where = ["s.deleted_at is null", "s.kind not in ('code','conversation','activity','work')"];
  const params: (string | number)[] = [];
  if (spaces) {
    where.push(`s.space_id in (${spaces.map(() => "?").join(",") || "''"})`);
    params.push(...spaces);
  }
  if (f.space) (where.push("s.space_id = ?"), params.push(f.space));
  if (f.ids?.length) (where.push(`s.id in (${f.ids.map(() => "?").join(",")})`), params.push(...f.ids));
  if (f.kind) (where.push("s.kind = ?"), params.push(f.kind));
  if (f.chat_id) (where.push("json_extract(s.meta, '$.chatId') = ?"), params.push(f.chat_id));
  if (f.title_contains) (where.push("instr(s.title, ?) > 0"), params.push(f.title_contains));
  if (f.uri_prefix) (where.push("substr(s.uri, 1, ?) = ?"), params.push(f.uri_prefix.length, f.uri_prefix));
  if (f.wiki_path_contains)
    (where.push("(instr(coalesce(json_extract(s.meta, '$.wikiPath'), ''), ?) > 0 or instr(coalesce(json_extract(s.meta, '$.wikiSpaceName'), ''), ?) > 0)"), params.push(f.wiki_path_contains, f.wiki_path_contains));
  if (f.level) where.push(f.level === "normal" ? `${levelSql()} is null` : `${levelSql()} = '${f.level}'`);
  if (f.under) {
    if (!app || !f.space) throw new HttpError(400, "under 要和 space 一起给出");
    where.push("s.id in (select value from json_each(?))");
    params.push(JSON.stringify(sourcesUnder(catalog(app, f.space), f.under)));
  }
  if (f.updated_before) (where.push("s.updated_at < ?"), params.push(f.updated_before));
  if (f.updated_after) (where.push("s.updated_at >= ?"), params.push(f.updated_after));
  return { sql: where.join(" and "), params };
}

export function selectSources(app: App, f: SourceFilter, spaces?: string[] | null, limit = 5000) {
  const w = filterSql(f, spaces, app);
  return all<{ id: string; space_id: string; kind: string; title: string; uri: string; attention: string | null; attention_by: string | null; updated_at: string; size: number }>(
    app.db,
    `select s.id, s.space_id, s.kind, s.title, s.uri, s.attention, s.attention_by, s.updated_at, length(s.text) size from sources s where ${w.sql} order by s.updated_at desc limit ?`,
    ...w.params,
    limit,
  );
}

/** Counts by level for a space (or all), for the sources page. */
export function levelCounts(app: App, spaces?: string[] | null, space?: string) {
  const w = filterSql({ space }, spaces);
  const rows = all<{ attention: string | null; n: number }>(app.db, `select ${levelSql()} attention, count(*) n from sources s where ${w.sql} group by 1`, ...w.params);
  const out: Record<Level, number> = { focus: 0, normal: 0, reference: 0, ignore: 0 };
  for (const r of rows) out[(r.attention as Level | null) ?? "normal"] += r.n;
  return out;
}

// ---- rules ---------------------------------------------------------------------------------------

export const attentionRuleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(2000).default(""),
  enabled: z.boolean().default(true),
  level: z.enum(LEVELS),
  conditions: z.lazy(() => archiveCondition),
});
export type AttentionRule = z.infer<typeof attentionRuleSchema> & { id: string };

export function listAttentionRules(app: App): AttentionRule[] {
  return all<{ id: string; body: string }>(app.db, "select id, body from attention_rules order by rowid").flatMap((r) => {
    const parsed = attentionRuleSchema.safeParse(json(r.body, {}));
    return parsed.success ? [{ ...parsed.data, id: r.id }] : [];
  });
}

export function saveAttentionRule(app: App, input: unknown, id = newId("atr")) {
  const body = attentionRuleSchema.parse(input);
  run(app.db, "insert into attention_rules(id, body) values(?, ?) on conflict(id) do update set body = excluded.body", id, JSON.stringify(body));
  return { ...body, id };
}

export function deleteAttentionRule(app: App, id: string) {
  run(app.db, "delete from attention_rules where id = ?", id);
}

/** The first enabled rule that matches (top-down). */
export function matchAttention(app: App, input: Pick<UpsertInput, "kind" | "title" | "uri" | "text" | "meta">, rules = listAttentionRules(app)): AttentionRule | null {
  return rules.find((r) => r.enabled && matchesArchive(r.conditions as ArchiveCondition, input as UpsertInput)) ?? null;
}

/** Give a stored source the level of the first matching rule, unless someone chose one. */
export function applyAttentionRules(app: App, id: string, input: Pick<UpsertInput, "kind" | "title" | "uri" | "text" | "meta">, rules = listAttentionRules(app)) {
  if (!rules.length) return;
  const r = matchAttention(app, input, rules);
  const row = one<{ attention_by: string | null }>(app.db, "select attention_by from sources where id = ?", id);
  if (!row || (row.attention_by && row.attention_by !== "rule")) return;
  run(app.db, "update sources set attention = ?, attention_by = ? where id = ?", r && r.level !== "normal" ? r.level : null, r && r.level !== "normal" ? "rule" : null, id);
}

/** Apply the rules to material already stored (sources nobody chose a level for). */
export function applyAttentionRulesToExisting(app: App, space?: string) {
  const rules = listAttentionRules(app);
  let changed = 0;
  const rows = all<{ id: string; kind: string; title: string; uri: string; text: string; meta: string; attention: string | null }>(
    app.db,
    `select id, kind, title, uri, text, meta, attention from sources where deleted_at is null and kind not in ('code','conversation','activity','work') and (attention_by is null or attention_by = 'rule') ${space ? "and space_id = ?" : ""}`,
    ...(space ? [space] : []),
  );
  tx(app.db, () => {
    for (const s of rows) {
      const r = matchAttention(app, { ...s, kind: s.kind as UpsertInput["kind"], meta: json(s.meta, {}) }, rules);
      const level = r && r.level !== "normal" ? r.level : null;
      if (level === s.attention) continue;
      run(app.db, "update sources set attention = ?, attention_by = ? where id = ?", level, level ? "rule" : null, s.id);
      changed++;
    }
  });
  return { checked: rows.length, changed };
}

// ---- notes on parts of a source ----------------------------------------------------------------
//
// A note marks lines (or the whole source) as outdated, wrong, key, a remark, or not to be searched.
// It is anchored to its passage (`quote`, `quote_hash`, sources/anchor.ts) and follows it when the
// document is read again; a passage that is gone makes the note stale. Agents' notes start `pending`
// and weigh at half strength until the owner confirms them; rejected notes weigh nothing, and the
// agent cannot add the same note again. The owner's notes are confirmed from the start.

/** Notes that still take part in ranking and counts. */
export const NOTE_ACTIVE_SQL = (a = "n") => `${a}.status != 'rejected' and ${a}.stale_at is null`;

export const NOTE_KINDS = ["outdated", "wrong", "key", "note", "exclude"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_LABELS: Record<NoteKind, string> = { outdated: "已过时", wrong: "有误", key: "关键", note: "备注", exclude: "不检索" };
export type NoteStatus = "pending" | "confirmed" | "rejected";
export type SourceNote = {
  id: number; sourceId: string; lineStart: number | null; lineEnd: number | null; kind: NoteKind; note: string; ref: string | null; by: string; runId: string | null; createdAt: string;
  quote: string | null; status: NoteStatus; staleAt: string | null;
};
type NoteRow = { id: number; source_id: string; line_start: number | null; line_end: number | null; kind: string; note: string; ref: string | null; by: string; run_id: string | null; created_at: string; quote: string | null; quote_hash?: string | null; status: string; stale_at: string | null };

const toNote = (r: NoteRow): SourceNote => ({
  id: r.id, sourceId: r.source_id, lineStart: r.line_start, lineEnd: r.line_end, kind: r.kind as NoteKind, note: r.note, ref: r.ref, by: r.by, runId: r.run_id, createdAt: r.created_at,
  quote: r.quote, status: (r.status as NoteStatus) ?? "pending", staleAt: r.stale_at,
});

/**
 * Mark lines (or the whole source when no lines) as outdated / wrong / key / note / exclude, with what
 * to read instead. `quote` may stand in for the lines: the passage is found in the text.
 */
export function addSourceNote(app: App, n: { sourceId: string; lineStart?: number | null; lineEnd?: number | null; quote?: string | null; kind: NoteKind; note: string; ref?: string | null; by: "owner" | "agent"; runId?: string | null }) {
  const src = one<{ text: string }>(app.db, "select text from sources where id = ?", n.sourceId);
  if (!src) throw new HttpError(404, `原件不存在：${n.sourceId}`);
  let start = n.lineStart ?? null;
  let end = n.lineEnd ?? start;
  if (n.quote?.trim()) {
    const q = n.quote.replace(/\s+/g, " ").trim();
    const lines = src.text.split("\n");
    const at = lineOfQuote(lines, q, start ?? 1);
    if (!at) throw new HttpError(400, `quote 在原件里找不到：“${truncate(q, 40)}”。照原文抄一段（可以只抄开头）或改用 from/to 行号`);
    start = at;
    end = Math.max(at + lineSpan(lines, at, q) - 1, n.lineEnd && n.lineStart === at ? n.lineEnd : at);
  }
  if (start !== null && (end === null || end < start)) throw new HttpError(400, "行号范围不对");
  // The same range and kind is one note: a later judgement replaces the earlier one (an agent never replaces the owner's, nor adds back a rejected one).
  const same = one<{ id: number; by: string; status: string }>(app.db, "select id, by, status from source_notes where source_id = ? and kind = ? and coalesce(line_start, 0) = ? and coalesce(line_end, 0) = ?", n.sourceId, n.kind, start ?? 0, end ?? 0);
  if (same && n.by !== "owner" && same.status === "rejected") return { id: same.id, kept: true, rejected: true, lineStart: start, lineEnd: end };
  if (same && same.by === "owner" && n.by !== "owner") return { id: same.id, kept: true, lineStart: start, lineEnd: end };
  if (same) run(app.db, "delete from source_notes where id = ?", same.id);
  const passage = start !== null ? passageOf(src.text, start, end ?? start) : "";
  const r = run(app.db, "insert into source_notes(source_id, line_start, line_end, kind, note, ref, by, run_id, created_at, quote, quote_hash, status) values(?,?,?,?,?,?,?,?,?,?,?,?)",
    n.sourceId, start, end, n.kind, n.note, n.ref ?? null, n.by, n.runId ?? null, now(), start !== null ? quoteOf(passage) : null, start !== null ? hashOf(passage) : null, n.by === "owner" ? "confirmed" : "pending");
  return { id: Number(r.lastInsertRowid), kept: false, lineStart: start, lineEnd: end };
}

/** The line where a quote starts (whitespace ignored), nearest to `near`; it may continue over the next lines. */
function lineOfQuote(lines: string[], q: string, near: number) {
  const flat = lines.map((l) => l.replace(/\s+/g, " ").trim());
  let best: number | null = null;
  for (let i = 0; i < flat.length; i++) {
    if (!flat[i] || (best !== null && Math.abs(i + 1 - near) >= Math.abs(best - near))) continue;
    const window = flat.slice(i, i + 40).join(" ");
    if (window.startsWith(q) || flat[i].includes(q) || (q.startsWith(flat[i]) && window.startsWith(q.slice(0, Math.min(q.length, window.length))))) best = i + 1;
  }
  return best;
}
/** How many lines from `start` the quote covers. */
function lineSpan(lines: string[], start: number, q: string) {
  let len = 0;
  for (let i = start - 1, n = 1; i < lines.length; i++, n++) {
    len += lines[i].replace(/\s+/g, " ").trim().length + 1;
    if (len >= q.length) return n;
  }
  return 1;
}

export function removeSourceNote(app: App, id: number, by: "owner" | "agent") {
  const r = one<{ by: string }>(app.db, "select by from source_notes where id = ?", id);
  if (!r) throw new HttpError(404, "没有这条标注");
  if (r.by === "owner" && by !== "owner") throw new HttpError(403, "本人加的标注只有本人能删");
  run(app.db, "delete from source_notes where id = ?", id);
}

/** The owner's call on an agent's note: confirmed notes weigh in full, rejected ones not at all. */
export function reviewSourceNote(app: App, id: number, decision: "confirm" | "reject") {
  const r = one<{ source_id: string }>(app.db, "select source_id from source_notes where id = ?", id);
  if (!r) throw new HttpError(404, "没有这条标注");
  run(app.db, "update source_notes set status = ? where id = ?", decision === "confirm" ? "confirmed" : "rejected", id);
  app.emit({ type: "changed", entity: "source", id: r.source_id });
}

export function sourceNotes(app: App, sourceId: string): SourceNote[] {
  return all<NoteRow>(app.db, "select * from source_notes where source_id = ? order by coalesce(line_start, 0), id", sourceId).map(toNote);
}

/** Notes of several sources that take part in ranking (not rejected, not stale). */
export function notesOf(app: App, sourceIds: string[]): Map<string, SourceNote[]> {
  const out = new Map<string, SourceNote[]>();
  if (!sourceIds.length) return out;
  const ids = [...new Set(sourceIds)];
  for (const r of all<NoteRow>(app.db, `select * from source_notes n where n.source_id in (select value from json_each(?)) and ${NOTE_ACTIVE_SQL("n")}`, JSON.stringify(ids))) {
    const n = toNote(r);
    out.set(n.sourceId, [...(out.get(n.sourceId) ?? []), n]);
  }
  return out;
}

/** Notes that cover lines a..b of a source (whole-source notes always do). */
export const notesOn = (notes: SourceNote[] | undefined, a?: number, b?: number) =>
  (notes ?? []).filter((n) => n.lineStart === null || a === undefined || b === undefined || (n.lineStart <= b && (n.lineEnd ?? n.lineStart) >= a));

export const noteText = (n: SourceNote) =>
  `〔${NOTE_LABELS[n.kind]}${n.lineStart !== null ? ` L${n.lineStart}${n.lineEnd !== n.lineStart ? `-${n.lineEnd}` : ""}` : ""}${n.note ? `：${n.note}` : ""}${n.ref ? `；以 ${n.ref} 为准` : ""}${n.staleAt ? "；原文已改动，位置可能不对" : n.by !== "owner" && n.status === "pending" ? "；Agent 标的，待本人确认" : ""}〕`;

/** How strongly a note acts: the owner's or a confirmed one fully, an agent's pending one at half, rejected or stale ones not at all. */
export const noteStrength = (n: Pick<SourceNote, "by" | "status" | "staleAt">) =>
  n.staleAt || n.status === "rejected" ? 0 : n.by === "owner" || n.status === "confirmed" ? 1 : 0.5;

/**
 * A note's factor on a hit of lines a..b: `w ^ (strength × share)`, where share is the part of the hit's
 * lines it covers (at least 0.25, so one line in a long chunk still counts; a whole-source note is 1).
 * `drop`: the hit is left out — a passage the owner marks (or confirms) wrong or not to search covering
 * at least half of the hit, or the whole source.
 */
export function noteFactor(n: SourceNote, a?: number, b?: number): { factor: number; drop: boolean } {
  const strength = noteStrength(n);
  if (!strength || n.kind === "note") return { factor: 1, drop: false };
  let share = 1;
  if (n.lineStart !== null && a !== undefined && b !== undefined) {
    const overlap = Math.max(0, Math.min(b, n.lineEnd ?? n.lineStart) - Math.max(a, n.lineStart) + 1);
    share = Math.min(1, Math.max(0.25, overlap / Math.max(1, b - a + 1)));
  }
  if (strength === 1 && (n.kind === "wrong" || n.kind === "exclude") && (n.lineStart === null || share >= 0.5)) return { factor: 0, drop: true };
  return { factor: Math.pow(NOTE_WEIGHT[n.kind], strength * share), drop: false };
}

/**
 * Move notes with their passage after a document's text changed (`old` → `text`). A note whose passage
 * cannot be found is marked stale; one found again is no longer stale. Chats only grow and are skipped.
 */
export function relocateNotes(app: App, sourceId: string, old: string, text: string) {
  const notes = all<NoteRow>(app.db, "select * from source_notes where source_id = ? and line_start is not null", sourceId);
  let moved = 0, stale = 0;
  for (const n of notes) {
    const a = n.line_start!, b = n.line_end ?? a;
    const before = passageOf(old, a, b);
    // A note that had already drifted (stale) is looked for by its stored anchor, not by the lines it points at.
    const useStored = !!(n.stale_at && n.quote_hash);
    const hash = useStored ? n.quote_hash! : hashOf(before);
    const quote = useStored ? n.quote : quoteOf(before);
    const at = locate(text, { hash, quote, len: b - a + 1, near: a });
    if (at) {
      if (at.lineStart !== a || at.lineEnd !== b || n.stale_at) moved++;
      const now_ = passageOf(text, at.lineStart, at.lineEnd);
      run(app.db, "update source_notes set line_start = ?, line_end = ?, quote = ?, quote_hash = ?, stale_at = null where id = ?", at.lineStart, at.lineEnd, quoteOf(now_), hashOf(now_), n.id);
    } else if (!n.stale_at) {
      run(app.db, "update source_notes set stale_at = ?, quote = coalesce(quote, ?), quote_hash = coalesce(quote_hash, ?) where id = ?", now(), quoteOf(before), hashOf(before), n.id);
      stale++;
    }
  }
  return { moved, stale };
}

// ---- review: agents' judgements the owner has not looked at ---------------------------------------

/** Count notes that shaped search results (device-local, for ordering the review list by impact). */
export function countNoteHits(app: App, ids: number[]) {
  if (!ids.length) return;
  const at = now();
  const up = app.db.prepare("insert into source_note_hits(note_id, n, at) values(?, 1, ?) on conflict(note_id) do update set n = n + 1, at = excluded.at");
  for (const id of new Set(ids)) up.run(id, at);
}

/**
 * What waits for the owner in a space: agents' notes that change ranking (outdated / wrong / not to
 * search) still pending, notes whose passage is gone, and folder levels agents set — each with its
 * impact (search hits it shaped; sources below a folder), largest first.
 */
export function reviewQueue(app: App, spaceId: string, limit = 200) {
  const notes = all<NoteRow & { title: string; hits: number | null }>(
    app.db,
    `select n.*, s.title, h.n hits from source_notes n join sources s on s.id = n.source_id left join source_note_hits h on h.note_id = n.id
     where s.space_id = ? and s.deleted_at is null and n.status != 'rejected'
       and ((n.status = 'pending' and n.by != 'owner' and n.kind in ('outdated', 'wrong', 'exclude')) or n.stale_at is not null)
     order by coalesce(h.n, 0) desc, n.created_at desc limit ?`,
    spaceId, limit,
  ).map((r) => ({ ...toNote(r), title: r.title, hits: r.hits ?? 0 }));
  const cat = catalog(app, spaceId);
  const levels = nodeLevels(app, spaceId)
    .filter((l) => l.by === "agent" && l.status === "active" && cat.nodes.has(l.key))
    .map((l) => ({ ...l, title: cat.nodes.get(l.key)!.title, path: nodePath(cat, l.key), sources: sourcesUnder(cat, l.key).length }))
    .sort((a, b) => b.sources - a.sources);
  return { notes, levels };
}

