import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { matchQuery, terms } from "./tokenize.ts";
import { vectorSearch } from "./embeddings.ts";

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
};

export type SearchOptions = {
  spaces?: string[];
  types?: HitType[];
  limit?: number;
  /** Max hits from one source (keeps result lists diverse). 0 = unlimited. */
  perSource?: number;
  includeHistory?: boolean;
  sourceKinds?: string[];
  /** Disable individual recall routes (evaluation and debugging). */
  routes?: { fts?: boolean; vector?: boolean; symbol?: boolean };
  /** RRF weight of the full-text route when dense vectors are also used. */
  ftsWeight?: number;
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

type Ranked = { key: string; hit: Omit<Hit, "score" | "via">; rank: number; via: string; weight?: number };

export async function search(app: App, query: string, opts: SearchOptions = {}): Promise<Hit[]> {
  const limit = opts.limit ?? 20;
  const pool = Math.max(60, limit * 4);
  const types = new Set(opts.types ?? ["chunk", "page", "memory", "symbol"]);
  const lists: Ranked[][] = [];
  const match = matchQuery(query);

  const route = { fts: true, vector: true, symbol: true, ...opts.routes };
  if (match && types.has("chunk") && route.fts) {
    const sf = spaceFilter("c.space_id", opts.spaces);
    const kinds = opts.sourceKinds?.length ? ` and s.kind in (${opts.sourceKinds.map(() => "?").join(",")})` : "";
    const rows = all<{ id: number; space_id: string; title: string; path: string; source_id: string; uri: string; kind: string; line_start: number; line_end: number; text: string; stitle: string }>(
      app.db,
      `select c.id, c.space_id, c.title, c.path, c.source_id, s.uri, s.kind, s.title stitle, c.line_start, c.line_end, c.text
       from chunks_fts f join chunks c on c.id = f.rowid join sources s on s.id = c.source_id
       where chunks_fts match ? ${sf.sql} ${kinds} and s.deleted_at is null
       order by bm25(chunks_fts, 4.0, 1.0) limit ?`,
      match,
      ...sf.params,
      ...(opts.sourceKinds ?? []),
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
         where lower(y.name) in (${idents.map(() => "?").join(",")}) ${sf.sql} and s.deleted_at is null
         order by y.exported desc, (y.line_end - y.line_start) desc limit 30`,
        ...idents.map((i) => i.toLowerCase()),
        ...sf.params,
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
    const vec = await vectorSearch(app, query, opts.spaces, pool).catch(() => []);
    if (vec.length) {
      const ids = vec.map((v) => v.chunkId);
      const rows = all<{ id: number; space_id: string; title: string; path: string; source_id: string; uri: string; kind: string; stitle: string; line_start: number; line_end: number; text: string; deleted_at: string | null }>(
        app.db,
        `select c.id, c.space_id, c.title, c.path, c.source_id, s.uri, s.kind, s.title stitle, c.line_start, c.line_end, c.text, s.deleted_at
         from chunks c join sources s on s.id = c.source_id where c.id in (${ids.map(() => "?").join(",")})`,
        ...ids,
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      const kinds = opts.sourceKinds ? new Set(opts.sourceKinds) : null;
      lists.push(
        vec
          .map((v) => byId.get(v.chunkId))
          .filter((r): r is NonNullable<typeof r> => !!r && !r.deleted_at && (!kinds || kinds.has(r.kind)))
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
  // A symbol hit and a chunk covering the same lines are the same evidence.
  const hits = [...fused.values()].sort((a, b) => b.score - a.score);
  const out: Hit[] = [];
  const perSource = new Map<string, number>();
  const cap = opts.perSource ?? 3;
  for (const h of hits) {
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
    if (out.length >= limit) break;
  }
  return out;
}
