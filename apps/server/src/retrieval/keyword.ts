import { knowledgeEvidenceCandidates } from "../knowledge/retrieval.js";
import { queryTerms, relevance, bestSnippet } from "./relevance.js";
import { rankEvidence } from "./ranking.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProvenanceRef,
  RetrievalHealth,
  RetrievalPort,
  SearchQuery,
  SourceCandidate,
  MemoryCandidate,
  EvidenceFragment,
} from "./port.js";

type Row = Record<string, unknown>;

export const ORIGINAL = "COALESCE(json_extract(r.body, '$.provenance.producerKind'),'original') != 'derived' AND COALESCE(json_extract(r.body, '$.context.derived'),0) != 1";
const SOURCE_COLUMNS = `f.id AS fragment_id,f.revision_id,f.text AS fragment_text,
  r.title,r.created_at AS revision_created_at,s.namespace,
  json_extract(r.body, '$.provenance.actorId') AS actor_id`;

/** Indexed lexical + memory + knowledge retrieval, always returning original evidence. */
export class KeywordRetrieval implements RetrievalPort {
  constructor(private readonly db: DatabaseSync) {}

  health(): RetrievalHealth {
    return { available: true, backend: "sqlite-fts5-relevance@3" };
  }

  readEvidence(
    revisionId: string,
    fragmentId?: string,
  ): EvidenceFragment | null {
    const row = fragmentId
      ? (this.db
          .prepare(
            "SELECT * FROM fragments WHERE id=? AND revision_id=?",
          )
          .get(fragmentId, revisionId) as Row | undefined)
      : (this.db
          .prepare(
            "SELECT * FROM fragments WHERE revision_id=? ORDER BY ordinal LIMIT 1",
          )
          .get(revisionId) as Row | undefined);
    if (!row) return null;
    return {
      fragmentId: String(row.id),
      revisionId: String(row.revision_id),
      ordinal: Number(row.ordinal),
      text: String(row.text),
    };
  }

  searchSources(query: SearchQuery): SourceCandidate[] {
    const limit = Math.max(1, Math.min(query.limit ?? 20, 100));
    const terms = tokenize(query.text);
    if (!terms.length) return [];
    const eligible = (row: Row) => {
      const time = Date.parse(String(row.revision_created_at));
      if (query.timeRange?.from && time < Date.parse(query.timeRange.from)) return false;
      if (query.timeRange?.to && time > Date.parse(query.timeRange.to)) return false;
      return !query.visible || query.visible(String(row.fragment_id));
    };
    const lexical = new Map<string, { row: Row; score: number }>();
    // Trigram MATCH covers long Chinese terms and exact code/path substrings.
    // Two-character Chinese terms keep their LIKE path: FTS5 cannot match them.
    const long = terms.filter(t => Array.from(t).length >= 3);
    const fts = long.length ? this.db.prepare(`
      SELECT ${SOURCE_COLUMNS} FROM fragment_search
      JOIN fragments f ON f.rowid=fragment_search.rowid
      JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id
      WHERE fragment_search MATCH ? AND ${ORIGINAL}
      ORDER BY bm25(fragment_search,1,2),f.id
    `).all(long.map(t => '"' + t.replaceAll('"', '""') + '"').join(' OR ')) as Row[] : [];
    for (const term of terms.filter(t => Array.from(t).length < 3)) {
      for (const row of this.searchFragmentsForTerm(term)) {
        const id = String(row.fragment_id), hit = lexical.get(id) ?? { row, score: 0 };
        hit.score += term.length;
        lexical.set(id, hit);
      }
    }
    // Active memory prose routes back to its evidence; never quote the memory
    // itself as an additional independent source.
    const memoryRows: Row[] = [];
    for (const memory of this.searchMemories({ ...query, limit: 50 })) {
      const refs = this.db.prepare(`SELECT COALESCE(p.evidence,mr.evidence_set) AS evidence_set FROM memories m
        JOIN memory_revisions mr ON mr.id=m.head_revision_id
        LEFT JOIN application_receipts a ON a.entity_type='memory' AND a.entity_id=m.id AND a.entity_version=m.version
        LEFT JOIN proposals p ON p.id=a.proposal_id WHERE m.id=?`).get(memory.id) as Row;
      for (const ref of JSON.parse(String(refs.evidence_set)) as { fragment_revision_id?: string; source_revision_id?: string }[]) {
        if (!ref.fragment_revision_id || !ref.source_revision_id) continue;
        const row = this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM fragments f
          JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id
          WHERE f.id=? AND r.id=? AND ${ORIGINAL}`).get(ref.fragment_revision_id, ref.source_revision_id) as Row | undefined;
        if (row) memoryRows.push({ ...row, guide_score: Math.min(1, memory.score / (2 * terms.length)) });
      }
    }
    const branches: [string, Row[]][] = [
      ["code-symbol", this.exactSymbols(query.text)],
      ["fulltext", fts],
      ["short-keyword", [...lexical.values()].sort((a,b) => b.score-a.score).map(v => v.row)],
      ["memory", memoryRows],
      ["knowledge", knowledgeEvidenceCandidates(this.db, terms)],
    ];
    // Preserve relevance magnitude within lexical routes. Fusion with dense
    // retrieval happens once, downstream; route count is not evidence quality.
    const fused = new Map<string, { row: Row; score: number; routes: string[] }>();
    const titleSources = new Set<string>();
    for (const [route, rows] of branches) {
      for (const row of rows.filter(eligible)) {
        let score = Math.max(relevance(String(row.fragment_text), terms, String(row.title)), Number(row.guide_score ?? 0));
        if (!score && terms.length <= 2 && terms.every(t => String(row.title).toLowerCase().includes(t)) && !titleSources.has(String(row.revision_id))) {
          score = .4; titleSources.add(String(row.revision_id));
        }
        if (!score && route !== "code-symbol") continue;
        const id = String(row.fragment_id), hit = fused.get(id) ?? { row, score: 0, routes: [] };
        hit.score = Math.max(hit.score, score || 1);
        if (!hit.routes.includes(route)) hit.routes.push(route);
        fused.set(id, hit);
      }
    }
    return rankEvidence([...fused.values()].map(({ row, score, routes }) => ({
        id: String(row.fragment_id), score, routes,
        snippet: snippetFor(String(row.fragment_text), query),
        sourceRevisionId: String(row.revision_id), fragmentId: String(row.fragment_id),
        provenance: { actor: row.actor_id ? String(row.actor_id) : null,
          time: String(row.revision_created_at), source: String(row.namespace) },
      })), { ...query, limit });
  }

  private exactSymbols(query: string): Row[] {
    // Optional AST projection: never create a separate code evidence store.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='code_symbols'").get()) return [];
    const names = [...new Set((query.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) ?? [])
      .filter(name => name.length >= 3 && (/[A-Z_$\.]/.test(name) || query.trim() === name)).map(name => name.toLowerCase()))];
    if (!names.length) return [];
    const placeholders = names.map(() => "?").join(",");
    return this.db.prepare(`SELECT DISTINCT ${SOURCE_COLUMNS} FROM code_symbols cs
      JOIN code_files cf ON cf.file_id=cs.file_id AND cf.removed=0
      JOIN code_repositories cr ON cr.repo_id=cf.repo_id AND cr.current_snapshot_id=cs.snapshot_id
      JOIN fragments f ON f.id=cs.fragment_id JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id
      WHERE ${ORIGINAL} AND (lower(cs.name) IN (${placeholders}) OR lower(cs.qualified_name) IN (${placeholders}))
      ORDER BY f.id`).all(...names,...names) as Row[];
  }

  private searchFragmentsForTerm(term: string): Row[] {
    const escaped = "%" + term.replace(/[!%_]/g, "!$&") + "%";
    return this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM fragments f
      JOIN revisions r ON r.id=f.revision_id JOIN sources s ON s.head=r.id
      WHERE (f.text LIKE ? ESCAPE '!' OR r.title LIKE ? ESCAPE '!') AND ${ORIGINAL}
      ORDER BY r.created_at DESC,f.ordinal`).all(escaped,escaped) as Row[];
  }

  searchMemories(query: SearchQuery): MemoryCandidate[] {
    const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
    const terms = tokenize(query.text);
    if (!terms.length) return [];
    const rows = this.db
      .prepare(
        `SELECT m.id, m.kind, m.status, m.scope, mr.body, mr.created_at
         FROM memories m
         JOIN memory_revisions mr ON mr.id = m.head_revision_id
         WHERE m.status = 'active'`,
      )
      .all() as Row[];
    const scored: { row: Row; score: number; snippet: string }[] = [];
    for (const row of rows) {
      const scope = safeJson(String(row.scope));
      // Only filter by project when project_id is a confirmed/trusted link. A
      // conversationId/application is not a project, so an unknown or untrusted
      // project_id must not exclude workspace memories. Memories without a project
      // association are always workspace-visible.
      if (
        query.project_id &&
        query.project_trusted &&
        typeof scope?.project_id === "string" &&
        scope.project_id !== query.project_id
      )
        continue;
      const bodyText = JSON.stringify(row.body ?? {});
      let score = 0;
      for (const term of terms)
        if (bodyText.toLowerCase().includes(term.toLowerCase()))
          score += term.length >= 2 ? 2 : 1;
      if (score > 0)
        scored.push({
          row,
          score,
          snippet: snippetFor(bodyText, query),
        });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score, snippet }) => ({
        id: String(row.id),
        score,
        snippet,
        kind: String(row.kind),
        status: String(row.status),
        provenance: {
          actor: null,
          time: String(row.created_at),
          source: "memory",
        } satisfies ProvenanceRef,
      }));
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function tokenize(text: string): string[] { return queryTerms(text); }
function snippetFor(text: string, query: SearchQuery): string {
  return bestSnippet(text, queryTerms(query.text));
}
