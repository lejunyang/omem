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

/**
 * Keyword baseline over the fixed fragments and applied memories. It intentionally
 * avoids embedding/third-party engines (V3-03 scope) while keeping the same surface a
 * future MemPalace sidecar will implement. CJK queries are matched as substrings, so
 * multi-Chinese-term queries score by how many distinct terms hit.
 */
export class KeywordRetrieval implements RetrievalPort {
  constructor(private readonly db: DatabaseSync) {}

  health(): RetrievalHealth {
    return { available: true, backend: "sqlite-like-keyword@1" };
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
    const best = new Map<
      string,
      { row: Row; score: number; matched: Set<string> }
    >();
    for (const term of terms) {
      const rows = this.searchFragmentsForTerm(term);
      for (const row of rows) {
        // Project filtering is intentionally NOT applied here: there is no persisted
        // trusted project association (ContextLink) on fragments yet, and context
        // carriers (application/conversationId/runId) must never be promoted to a
        // project. When project_id is unknown or untrusted we return workspace-wide
        // results. A future ContextLink table will gate this on a confirmed join.
        const id = String(row.fragment_id);
        const current =
          best.get(id) ?? { row, score: 0, matched: new Set<string>() };
        if (!current.matched.has(term)) {
          current.matched.add(term);
          // Longer terms are more specific → higher score. Full CJK runs (>=3)
          // score more than 2-grams; ASCII words >=4 chars score more.
          current.score +=
            term.length >= 4 ? 4 : term.length >= 3 ? 3 : term.length >= 2 ? 2 : 1;
        }
        best.set(id, current);
      }
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score }) => ({
        id: String(row.fragment_id),
        score,
        snippet: snippetFor(String(row.fragment_text), query),
        sourceRevisionId: String(row.revision_id),
        fragmentId: String(row.fragment_id),
        provenance: {
          actor: row.actor_id ? String(row.actor_id) : null,
          time: String(row.revision_created_at),
          source: String(row.namespace),
        } satisfies ProvenanceRef,
      }));
  }

  private searchFragmentsForTerm(term: string): Row[] {
    const escaped = "%" + term.replace(/[!%_]/g, "!$&") + "%";
    return this.db
      .prepare(
        `SELECT f.id AS fragment_id, f.revision_id, f.text AS fragment_text,
                r.title, r.created_at AS revision_created_at,
                s.namespace,
                json_extract(r.body, '$.provenance.actorId') AS actor_id
         FROM fragments f
         JOIN revisions r ON r.id = f.revision_id
         JOIN sources s ON s.head = r.id
         WHERE f.text LIKE ? ESCAPE '!'
         LIMIT 200`,
      )
      .all(escaped) as Row[];
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

/**
 * Split a query into matchable terms: whitespace/punctuation chunks; ASCII words.
 * For CJK runs of length >= 2, also emit overlapping 2-gram substrings so that
 * short follow-up queries like "按这个" or "刚才说的" match fragments that
 * contain individual character pairs, instead of requiring the whole phrase.
 */
export function tokenize(text: string): string[] {
  const terms = new Set<string>();
  for (const chunk of text.split(/[\s,;，。；、|/\\()（）\[\]{}]+/)) {
    if (!chunk) continue;
    const ascii = chunk.match(/[A-Za-z0-9_.\-]+/g);
    if (ascii) for (const word of ascii) terms.add(word.toLowerCase());
    const cjk = chunk.match(/[一-鿿][一-鿿0-9A-Za-z_.\-]*/g);
    if (cjk) {
      for (const run of cjk) {
        if (!run.replace(/[0-9A-Za-z_.\-]+/g, "")) continue;
        // Keep the full run as a term (exact phrase match, higher score).
        terms.add(run);
        // Also emit 2-grams for short follow-ups ("按这个" → "按这","这个").
        // Skip generic stopword 2-grams that match everything.
        const cleaned = run.replace(/[0-9A-Za-z_.\-]+/g, "");
        if (cleaned.length >= 2) {
          for (let i = 0; i < cleaned.length - 1; i++) {
            const gram = cleaned.slice(i, i + 2);
            if (!STOP_BIGRAMS.has(gram)) terms.add(gram);
          }
        }
      }
    }
  }
  return [...terms].filter((term) => term.trim().length > 0);
}

/** Common Chinese function-word bigrams that would over-recall if matched. */
const STOP_BIGRAMS = new Set([
  "这个", "那个", "我们", "你们", "他们", "什么", "怎么", "为什么",
  "可以", "应该", "需要", "已经", "还是", "或者", "但是", "因为",
  "所以", "如果", "虽然", "然后", "现在", "之前", "之后", "时候",
  "一下", "一些", "一样", "这样", "那样", "这里", "那里", "的话",
  "是不", "不是", "没有", "为什",
]);

function snippetFor(text: string, query: SearchQuery, radius = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const terms = tokenize(query.text);
  const hit = terms
    .map((term) => flat.toLowerCase().indexOf(term.toLowerCase()))
    .find((index) => index >= 0);
  if (hit === undefined) return flat.slice(0, radius * 2);
  const start = Math.max(0, hit - radius);
  return (start > 0 ? "…" : "") + flat.slice(start, start + radius * 2);
}
