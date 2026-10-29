import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import { archiveCondition, matchesArchive, type ArchiveCondition } from "./archive.ts";
import { catalog, sourcesUnder } from "./catalog.ts";
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
export const NOTE_WEIGHT = { outdated: 0.5, wrong: 0.35, key: 1.3 } as const;

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
export function setNodeLevel(app: App, spaceId: string, key: string, level: Level | null, by: SetBy, opts: { reason?: string; runId?: string | null } = {}) {
  const cat = catalog(app, spaceId);
  if (!cat.nodes.has(key)) throw new HttpError(404, `目录里没有这个节点：${key}（用 list_sources 看节点）`);
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

/** Notes that still take part in ranking and counts. */
export const NOTE_ACTIVE_SQL = (_a = "n") => "1=1";

export const NOTE_KINDS = ["outdated", "wrong", "key", "note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_LABELS: Record<NoteKind, string> = { outdated: "已过时", wrong: "有误", key: "关键", note: "备注" };
export type SourceNote = { id: number; sourceId: string; lineStart: number | null; lineEnd: number | null; kind: NoteKind; note: string; ref: string | null; by: string; runId: string | null; createdAt: string };

const toNote = (r: { id: number; source_id: string; line_start: number | null; line_end: number | null; kind: string; note: string; ref: string | null; by: string; run_id: string | null; created_at: string }): SourceNote => ({
  id: r.id, sourceId: r.source_id, lineStart: r.line_start, lineEnd: r.line_end, kind: r.kind as NoteKind, note: r.note, ref: r.ref, by: r.by, runId: r.run_id, createdAt: r.created_at,
});

/** Mark lines (or the whole source when no lines) as outdated / wrong / key, with what to read instead. */
export function addSourceNote(app: App, n: { sourceId: string; lineStart?: number | null; lineEnd?: number | null; kind: NoteKind; note: string; ref?: string | null; by: "owner" | "agent"; runId?: string | null }) {
  if (!one(app.db, "select 1 from sources where id = ?", n.sourceId)) throw new HttpError(404, `原件不存在：${n.sourceId}`);
  const start = n.lineStart ?? null;
  const end = n.lineEnd ?? start;
  if (start !== null && (end === null || end < start)) throw new HttpError(400, "行号范围不对");
  // The same range and kind is one note: a later judgement replaces the earlier one (an agent never replaces the owner's).
  const same = one<{ id: number; by: string }>(app.db, "select id, by from source_notes where source_id = ? and kind = ? and coalesce(line_start, 0) = ? and coalesce(line_end, 0) = ?", n.sourceId, n.kind, start ?? 0, end ?? 0);
  if (same && same.by === "owner" && n.by !== "owner") return { id: same.id, kept: true };
  if (same) run(app.db, "delete from source_notes where id = ?", same.id);
  const r = run(app.db, "insert into source_notes(source_id, line_start, line_end, kind, note, ref, by, run_id, created_at) values(?,?,?,?,?,?,?,?,?)", n.sourceId, start, end, n.kind, n.note, n.ref ?? null, n.by, n.runId ?? null, now());
  return { id: Number(r.lastInsertRowid), kept: false };
}

export function removeSourceNote(app: App, id: number, by: "owner" | "agent") {
  const r = one<{ by: string }>(app.db, "select by from source_notes where id = ?", id);
  if (!r) throw new HttpError(404, "没有这条标注");
  if (r.by === "owner" && by !== "owner") throw new HttpError(403, "本人加的标注只有本人能删");
  run(app.db, "delete from source_notes where id = ?", id);
}

export function sourceNotes(app: App, sourceId: string): SourceNote[] {
  return all<Parameters<typeof toNote>[0]>(app.db, "select * from source_notes where source_id = ? order by coalesce(line_start, 0), id", sourceId).map(toNote);
}

/** Notes of several sources, for ranking search hits. */
export function notesOf(app: App, sourceIds: string[]): Map<string, SourceNote[]> {
  const out = new Map<string, SourceNote[]>();
  if (!sourceIds.length) return out;
  const ids = [...new Set(sourceIds)];
  for (const r of all<Parameters<typeof toNote>[0]>(app.db, `select * from source_notes where source_id in (${ids.map(() => "?").join(",")})`, ...ids)) {
    const n = toNote(r);
    out.set(n.sourceId, [...(out.get(n.sourceId) ?? []), n]);
  }
  return out;
}

/** Notes that cover lines a..b of a source (whole-source notes always do). */
export const notesOn = (notes: SourceNote[] | undefined, a?: number, b?: number) =>
  (notes ?? []).filter((n) => n.lineStart === null || a === undefined || b === undefined || (n.lineStart <= b && (n.lineEnd ?? n.lineStart) >= a));

export const noteText = (n: SourceNote) => `〔${NOTE_LABELS[n.kind]}${n.lineStart !== null ? ` L${n.lineStart}${n.lineEnd !== n.lineStart ? `-${n.lineEnd}` : ""}` : ""}${n.note ? `：${n.note}` : ""}${n.ref ? `；以 ${n.ref} 为准` : ""}〕`;
