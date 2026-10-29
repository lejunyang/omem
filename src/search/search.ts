import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { matchQuery, terms } from "./tokenize.ts";
import { vectorSearch } from "./embeddings.ts";
import { countNoteHits, LEVEL_WEIGHT, levelSql, noteFactor, notesOf, notesOn, noteText, type Level, type SourceNote } from "../sources/attention.ts";
import { citeBoost, citeCounts } from "../sources/cites.ts";
import { catalog, sourcesUnder } from "../sources/catalog.ts";

export type HitType = "chunk" | "page" | "memory" | "symbol";
export type Hit = {
  type: HitType;
  /** chunk: chunk id; page: space/slug; memory: memory id; symbol: source id#qname */
  id: string;
  spaceId: string;
  title: string;
  /** heading path, symbol qname or page slug */
  path: string;
  sourceId?: string;
  uri?: string;
  sourceKind?: string;
  lineStart?: number;
  lineEnd?: number;
  snippet: string;
  score: number;
  via: string[];
  status?: string;
  /** The source's level when it is not normal (focus / reference). */
  attention?: string;
  /** Notes on the hit's lines: outdated, wrong, key (sources/attention.ts). */
  notes?: string[];
  /** Ids of those notes (counted for the review list, not returned). */
  noteIds?: number[];
  /** Other sources with exactly the same text, folded into this hit (“另有 N 份相同内容”). */
  sameAs?: { sourceId: string; uri: string; title: string; spaceId: string }[];
  /** The source's text hash (for folding identical documents; not returned). */
  hash?: string;
};

export type SearchOptions = {
  spaces?: string[];
  types?: HitType[];
  limit?: number;
  /** Max hits from one source (keeps result lists diverse). 0 = unlimited. */
  perSource?: number;
  includeHistory?: boolean;
  sourceKinds?: string[];
  /** Also return sources marked “ignore” (looking for one on purpose). */
  includeIgnored?: boolean;
  /** Disable individual recall routes (evaluation and debugging). */
  routes?: { fts?: boolean; vector?: boolean; symbol?: boolean };
  /** RRF weight of the full-text route when dense vectors are also used. */
  ftsWeight?: number;
  /** Only sources below this catalog node of a space (sources/catalog.ts); pages and memories are left out. */
  under?: { space: string; node: string };
};

const RRF_K = 60;

function spaceFilter(column: string, spaces?: string[]) {
  if (!spaces?.length) return { sql: "", params: [] as string[] };
  return { sql: ` and ${column} in (${spaces.map(() => "?").join(",")})`, params: spaces };
}

/** Pick the most query-dense window of a chunk as a readable snippet. */
export function snippet(text: string, query: string, size = 360): string {
  const qs = new Set(terms(query));
  if (text.length <= size) return text.trim();
  const lines = text.split("\n");
  let best = 0;
  let bestScore = -1;
  lines.forEach((line, i) => {
    const window = lines.slice(i, i + 4).join(" ");
    const score = terms(window).filter((t) => qs.has(t)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  const out = lines.slice(Math.max(0, best - 1)).join("\n");
  return (best > 1 ? "…" : "") + out.slice(0, size).trim() + (out.length > size ? "…" : "");
}

/**
 * Repository files a branch or delegation index stands in for, by repository space: when both are
 * searched, the index has the file as it is on the branch (or says it was deleted there), so the
 * repository's copy is left out. Only for indexes named in `spaces` (searching everything mixes
 * every branch and must not hide the checked-out code).
 */
export function shadowedFiles(app: App, spaces?: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!spaces?.length) return out;
  const rows = all<{ id: string; settings: string }>(app.db, `select id, settings from spaces where kind = 'worktree' and id in (${spaces.map(() => "?").join(",")})`, ...spaces);
  for (const r of rows) {
    const st = JSON.parse(r.settings || "{}") as { repo?: string; deleted?: string[] };
    if (!st.repo || !spaces.includes(st.repo)) continue;
    const set = out.get(st.repo) ?? new Set<string>();
    for (const f of all<{ uri: string }>(app.db, "select uri from sources where space_id = ? and deleted_at is null", r.id)) set.add(f.uri);
    for (const f of st.deleted ?? []) set.add(f);
    out.set(st.repo, set);
  }
  return out;
}

/**
 * How much the owner cares about the source (focus up, reference down), what is marked on the hit's
 * lines and how often the source was cited. A note acts in proportion to the part of the hit it covers,
 * an agent's at half strength until the owner confirms it (`noteFactor`); passages the owner marks (or
 * confirms) wrong or not to search are left out. The notes travel with the hit, with the first lines of
 * the correction they point at, so the reader sees “this part is outdated, read X instead” next to the
 * snippet. Citations give at most ×1.1 (sources/cites.ts).
 */
function weigh(app: App, hits: Hit[], spaces?: string[]): Hit[] {
  const ids = hits.flatMap((h) => (h.sourceId && h.type !== "symbol" ? [h.sourceId] : []));
  const notes = notesOf(app, ids);
  const cites = citeCounts(app, hits.flatMap((h) => (h.sourceId ? [h.sourceId] : [])));
  const kept: Hit[] = [];
  for (const h of hits) {
    if (h.attention) h.score *= LEVEL_WEIGHT[h.attention as Level] ?? 1;
    const cited = h.sourceId ? cites.get(h.sourceId) : 0;
    if (cited) h.score *= citeBoost(cited);
    const on = notesOn(notes.get(h.sourceId ?? ""), h.lineStart, h.lineEnd).filter((n) => n.kind !== "note" || n.lineStart !== null);
    if (!on.length) {
      kept.push(h);
      continue;
    }
    let drop = false;
    for (const n of on) {
      const f = noteFactor(n, h.lineStart, h.lineEnd);
      if (f.drop) drop = true;
      h.score *= f.factor;
    }
    if (drop) continue;
    h.notes = on.map((n) => noteText(n) + correction(app, n, spaces));
    h.noteIds = on.map((n) => n.id);
    kept.push(h);
  }
  return kept;
}

/** The first lines a wrong or outdated note points at (readable spaces only), so the reader need not look them up. */
function correction(app: App, n: SourceNote, spaces?: string[]) {
  if ((n.kind !== "wrong" && n.kind !== "outdated") || !n.ref) return "";
  const m = /src:([\w-]+)(?:#L(\d+)(?:-L?(\d+))?)?/.exec(n.ref);
  if (!m) return "";
  const s = one<{ space_id: string; text: string; deleted_at: string | null }>(app.db, "select space_id, text, deleted_at from sources where id = ?", m[1]);
  if (!s || s.deleted_at || (spaces?.length && !spaces.includes(s.space_id))) return "";
  const from = m[2] ? Number(m[2]) : 1;
  const text = s.text.split("\n").slice(from - 1, m[3] ? Number(m[3]) : from + 4).join(" ").replace(/\s+/g, " ").trim();
  return text ? ` 更正原文：“${text.slice(0, 200)}${text.length > 200 ? "…" : ""}”` : "";
}

type Ranked = { key: string; hit: Omit<Hit, "score" | "via">; rank: number; via: string; weight?: number };

export async function search(app: App, query: string, opts: SearchOptions = {}): Promise<Hit[]> {
  const limit = opts.limit ?? 20;
  const pool = Math.max(60, limit * 4);
  const types = new Set(opts.types ?? ["chunk", "page", "memory", "symbol"]);
  const lists: Ranked[][] = [];
  const match = matchQuery(query);

  const route = { fts: true, vector: true, symbol: true, ...opts.routes };
  // A folder of the catalog: its sources only.
  const underIds = opts.under ? sourcesUnder(catalog(app, opts.under.space), opts.under.node) : null;
  if (underIds) for (const t of ["page", "memory"] as const) types.delete(t);
  const inUnder = underIds ? new Set(underIds) : null;
  const underSql = underIds ? " and c.source_id in (select value from json_each(?))" : "";
  const underParams = underIds ? [JSON.stringify(underIds)] : [];
  if (match && types.has("chunk") && route.fts) {
    const sf = spaceFilter("c.space_id", opts.spaces);
    const kinds = opts.sourceKinds?.length ? ` and s.kind in (${opts.sourceKinds.map(() => "?").join(",")})` : "";
    const rows = all<{ id: number; space_id: string; title: string; path: string; source_id: string; uri: string; kind: string; line_start: number; line_end: number; text: string; stitle: string; attention: string | null; hash: string }>(
      app.db,
      `select c.id, c.space_id, c.title, c.path, c.source_id, s.uri, s.kind, s.title stitle, c.line_start, c.line_end, c.text, ${levelSql()} attention, s.hash
       from chunks_fts f join chunks c on c.id = f.rowid join sources s on s.id = c.source_id
       where chunks_fts match ? ${sf.sql} ${kinds}${underSql} and s.deleted_at is null ${opts.includeIgnored ? "" : `and coalesce(${levelSql()}, '') != 'ignore'`}
       order by bm25(chunks_fts, 4.0, 1.0) limit ?`,
      match,
      ...sf.params,
      ...(opts.sourceKinds ?? []),
      ...underParams,
      pool,
    );
    lists.push(
      rows.map((r, i) => ({
        key: `chunk:${r.id}`,
        rank: i,
        via: "全文",
        hit: {
          type: "chunk",
          id: String(r.id),
          spaceId: r.space_id,
          title: r.stitle,
          path: r.path || r.title,
          sourceId: r.source_id,
          uri: r.uri,
          sourceKind: r.kind,
          lineStart: r.line_start,
          lineEnd: r.line_end,
          snippet: snippet(r.text, query),
          ...(r.attention ? { attention: r.attention } : {}),
          hash: r.hash,
        },
      })),
    );
  }

  if ((types.has("chunk") || types.has("symbol")) && route.symbol) {
    const idents = [...new Set(query.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])];
    if (idents.length) {
      const sf = spaceFilter("y.space_id", opts.spaces);
      const rows = all<{ source_id: string; space_id: string; name: string; qname: string; kind: string; line_start: number; line_end: number; signature: string; uri: string }>(
        app.db,
        `select y.source_id, y.space_id, y.name, y.qname, y.kind, y.line_start, y.line_end, y.signature, s.uri
         from symbols y join sources s on s.id = y.source_id
         where lower(y.name) in (${idents.map(() => "?").join(",")}) ${sf.sql}${underIds ? " and y.source_id in (select value from json_each(?))" : ""} and s.deleted_at is null
         order by y.exported desc, (y.line_end - y.line_start) desc limit 30`,
        ...idents.map((i) => i.toLowerCase()),
        ...sf.params,
        ...underParams,
      );
      lists.push(
        rows.map((r, i) => ({
          key: `symbol:${r.source_id}#${r.qname}`,
          rank: i,
          via: "符号",
          hit: {
            type: "symbol",
            id: `${r.source_id}#${r.qname}`,
            spaceId: r.space_id,
            title: r.uri,
            path: r.qname,
            sourceId: r.source_id,
            uri: r.uri,
            sourceKind: "code",
            lineStart: r.line_start,
            lineEnd: r.line_end,
            snippet: `${r.kind} ${r.signature}`,
          },
        })),
      );
    }
  }

  if (match && types.has("page")) {
    const sf = spaceFilter("p.space_id", opts.spaces);
    const rows = all<{ id: string; space_id: string; slug: string; title: string; summary: string; body: string }>(
      app.db,
      `select p.id, p.space_id, p.slug, p.title, p.summary, p.body from pages_fts f join page_rowids r on r.rowid = f.rowid join pages p on p.id = r.page_id
       where pages_fts match ? ${sf.sql} order by bm25(pages_fts, 4.0, 1.0) limit ?`,
      match,
      ...sf.params,
      pool,
    );
    lists.push(
      rows.map((r, i) => ({
        key: `page:${r.id}`,
        rank: i,
        via: "知识页",
        hit: { type: "page", id: r.id, spaceId: r.space_id, title: r.title, path: r.slug, snippet: r.summary || snippet(r.body, query) },
      })),
    );
  }

  if (match && types.has("memory")) {
    const sf = spaceFilter("m.space_id", opts.spaces);
    const status = opts.includeHistory ? "" : " and m.status = 'active'";
    const rows = all<{ id: string; space_id: string; kind: string; subject: string; content: string; status: string }>(
      app.db,
      `select m.id, m.space_id, m.kind, m.subject, m.content, m.status from memories_fts f join memory_rowids r on r.rowid = f.rowid join memories m on m.id = r.memory_id
       where memories_fts match ? ${sf.sql} ${status} order by bm25(memories_fts, 2.0, 1.0) limit ?`,
      match,
      ...sf.params,
      pool,
    );
    lists.push(
      rows.map((r, i) => ({
        key: `memory:${r.id}`,
        rank: i,
        via: "记忆",
        hit: { type: "memory", id: r.id, spaceId: r.space_id, title: r.subject || r.kind, path: r.kind, snippet: r.content, status: r.status },
      })),
    );
  }

  if (types.has("chunk") && route.vector) {
    const vec = await vectorSearch(app, query, opts.spaces, underIds ? pool * 5 : pool).catch(() => []);
    if (vec.length) {
      const ids = vec.map((v) => v.chunkId);
      const rows = all<{ id: number; space_id: string; title: string; path: string; source_id: string; uri: string; kind: string; stitle: string; line_start: number; line_end: number; text: string; deleted_at: string | null; attention: string | null; hash: string }>(
        app.db,
        `select c.id, c.space_id, c.title, c.path, c.source_id, s.uri, s.kind, s.title stitle, c.line_start, c.line_end, c.text, s.deleted_at, ${levelSql()} attention, s.hash
         from chunks c join sources s on s.id = c.source_id where c.id in (${ids.map(() => "?").join(",")})`,
        ...ids,
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const kinds = opts.sourceKinds ? new Set(opts.sourceKinds) : null;
      lists.push(
        vec
          .map((v) => byId.get(v.chunkId))
          .filter((r): r is NonNullable<typeof r> => !!r && !r.deleted_at && (!kinds || kinds.has(r.kind)) && (opts.includeIgnored || r.attention !== "ignore") && (!inUnder || inUnder.has(r.source_id)))
          .map((r, i) => ({
            key: `chunk:${r.id}`,
            rank: i,
            via: "语义",
            hit: {
              type: "chunk" as const,
              id: String(r.id),
              spaceId: r.space_id,
              title: r.stitle,
              path: r.path || r.title,
              sourceId: r.source_id,
              uri: r.uri,
              sourceKind: r.kind,
              lineStart: r.line_start,
              lineEnd: r.line_end,
              snippet: snippet(r.text, query),
              ...(r.attention ? { attention: r.attention } : {}),
              hash: r.hash,
            },
          })),
      );
    }
  }

  // Reciprocal rank fusion: robust, parameter-light, explains itself ("via").
  // Dense retrieval is markedly stronger on natural-language questions, so the
  // lexical list gets a lower weight when both exist; it still decides exact
  // names, rare terms and code identifiers (the symbol route keeps full weight).
  const hasVector = lists.some((l) => l[0]?.via === "语义");
  const ftsWeight = hasVector ? (opts.ftsWeight ?? 0.5) : 1;
  const fused = new Map<string, Hit>();
  for (const list of lists)
    for (const item of list) {
      const prev = fused.get(item.key);
      const add = (item.via === "全文" ? ftsWeight : 1) / (RRF_K + item.rank + 1);
      if (prev) {
        prev.score += add;
        if (!prev.via.includes(item.via)) prev.via.push(item.via);
      } else fused.set(item.key, { ...item.hit, score: add, via: [item.via] });
    }
  const shadow = shadowedFiles(app, opts.spaces);
  const hits = weigh(app, [...fused.values()].filter((h) => !(h.uri && shadow.get(h.spaceId)?.has(h.uri))), opts.spaces).sort((a, b) => b.score - a.score);
  // A symbol hit and a chunk covering the same lines are the same evidence.
  const out: Hit[] = [];
  const perSource = new Map<string, number>();
  const cap = opts.perSource ?? 3;
  // Different documents with identical text (copies, templates filled the same way): one is shown, the others are named on it.
  const same = new Map<string, Hit>();
  for (const h of hits) {
    const twin = h.type === "chunk" && h.hash && h.sourceKind !== "code" ? `${h.hash}#${h.lineStart}` : null;
    const first = twin ? same.get(twin) : undefined;
    if (first && first.sourceId !== h.sourceId) {
      if (!first.sameAs?.some((s) => s.sourceId === h.sourceId)) (first.sameAs ??= []).push({ sourceId: h.sourceId!, uri: h.uri!, title: h.title, spaceId: h.spaceId });
      continue;
    }
    if (h.type === "chunk" || h.type === "symbol") {
      const dup = out.find(
        (o) => (o.type === "chunk" || o.type === "symbol") && o.sourceId === h.sourceId && o.lineStart! <= h.lineEnd! && h.lineStart! <= o.lineEnd!,
      );
      if (dup) {
        dup.score += h.score / 2;
        for (const v of h.via) if (!dup.via.includes(v)) dup.via.push(v);
        if (h.type === "symbol" && dup.type === "chunk") dup.path = h.path;
        continue;
      }
      const n = perSource.get(h.sourceId!) ?? 0;
      if (cap && n >= cap) continue;
      perSource.set(h.sourceId!, n + 1);
    }
    out.push(h);
    if (twin) same.set(twin, h);
    if (out.length >= limit) break;
  }
  // Which notes shaped what was returned (the review list is ordered by this).
  countNoteHits(app, out.flatMap((h) => h.noteIds ?? []));
  for (const h of out) {
    delete h.noteIds;
    delete h.hash;
  }
  return out;
}
