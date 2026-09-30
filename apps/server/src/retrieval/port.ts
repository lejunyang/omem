/**
 * Unified retrieval port (processing-policy.md §8). Today it has a keyword baseline
 * over the fixed SQLite fragments and applied memories. A later MemPalace sidecar can
 * implement the same interface without changing callers (pipeline / assistant tools).
 *
 * Everything returned here points back at immutable fragment ids, so higher layers can
 * always quote the original evidence instead of trusting a reranked summary.
 */

export type RetrievalScope = "project" | "topic" | "workspace";

export type TimeRange = {
  from?: string;
  to?: string;
};

/**
 * A project relationship is never inferred from context carriers like
 * `application` / `conversationId` / `runId`. Those only describe where a capture
 * happened. A real project link is a separate ContextLink record that carries its
 * own source evidence, candidate confidence and a confirmed flag. Until such a
 * link is confirmed, callers MUST pass project_id=null and project_trusted=false,
 * and ports MUST return workspace-wide results without project filtering.
 */
export type SearchQuery = {
  text: string;
  scope?: RetrievalScope;
  /** Confirmed project id (from a confirmed ContextLink). Null when unknown. */
  project_id?: string | null;
  /**
   * False unless project_id comes from a confirmed/trusted ContextLink. When false
   * or absent, implementations MUST NOT filter by project (workspace-wide recall).
   */
  project_trusted?: boolean;
  limit?: number;
  /** Filter by captured revision time (not event time or historical as-of). */
  timeRange?: TimeRange;
  /** Host visibility policy, applied before final ranking/limit. */
  visible?: (fragmentId: string) => boolean;
};

export type ProvenanceRef = {
  actor: string | null;
  time: string | null;
  source: string;
};

export type SourceCandidate = {
  /** Fragment id (fixed evidence anchor). */
  id: string;
  score: number;
  snippet: string;
  sourceRevisionId: string;
  fragmentId: string;
  provenance: ProvenanceRef;
  routes?: string[];
};

export type MemoryCandidate = {
  /** memory id from the memories table. */
  id: string;
  score: number;
  snippet: string;
  kind: string;
  status: string;
  provenance: ProvenanceRef;
};

export type EvidenceFragment = {
  fragmentId: string;
  revisionId: string;
  ordinal: number;
  text: string;
};

export type RetrievalHealth = {
  available: boolean;
  backend: string;
};

export interface RetrievalPort {
  /** Keyword/vector search over imported source fragments. */
  searchSources(query: SearchQuery): SourceCandidate[];
  /** Search over already-applied memories (for conflict / reuse recall). */
  searchMemories(query: SearchQuery): MemoryCandidate[];
  /** Read back the immutable fragment the candidates point at. */
  readEvidence(
    revisionId: string,
    fragmentId?: string,
  ): EvidenceFragment | null;
  health(): RetrievalHealth;
}
