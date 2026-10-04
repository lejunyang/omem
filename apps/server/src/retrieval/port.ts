/**
 * Shared search for readers, assistants and Agent tools. Retrieval units preserve
 * original structure, derived explanations and applied state as distinct results.
 * Their fixed targets remain readable; explanations retain original references.
 * The source-only methods support processors that still require Fragment anchors.
 */

export type RetrievalScope = "project" | "topic" | "workspace";
import type {
  MaterialDescriptionRecord,
  MaterialRole,
} from "../../../../packages/contracts/src/material-description.js";

export const retrievalPurposes = [
  "balanced",
  "concept",
  "implementation",
  "background",
  "follow-up",
] as const;
export type RetrievalPurpose = (typeof retrievalPurposes)[number];
export const codeIntents = ["definition", "callers"] as const;
export type CodeIntent = (typeof codeIntents)[number];

export type SourceAnchor = {
  kind: "source";
  key: string;
  revisionId: string;
  digest: string;
  startLine: number;
  endLine: number;
  fragmentIds: string[];
};
export type RetrievalTarget =
  | SourceAnchor
  | {
      kind: "knowledge";
      key: string;
      revision: string;
      section: string;
      reviewState?: "needs-review";
    }
  | { kind: "memory" | "task"; id: string; version: number };

/** A readable explanation is a result, not merely an alias for its citations. */
export type RetrievalHit = {
  materialDescription?: MaterialDescriptionRecord;
  id: string;
  kind: RetrievalTarget["kind"];
  title: string;
  text: string;
  context: string;
  headingPath: string[];
  score: number;
  routes: string[];
  /** Name-level AST call sites, not type-resolved cross-file edges. */
  codeMatches?: {
    symbol: string;
    kind: "call";
    status: "candidate";
    lines: number[];
  }[];
  target: RetrievalTarget;
  references: SourceAnchor[];
  citations?: {
    key: string;
    label: string;
    reason: string;
    relation: string;
    target: {
      kind: "material" | "article";
      key: string;
      startLine?: number;
      endLine?: number;
      section?: string;
    };
    actionable: boolean;
  }[];
  provenance: ProvenanceRef;
  eventAt: string | null;
};

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
  /** False disables browse-only source caps and section/text deduplication.
   * Assistants and research tools use false, then assemble answer context.
   * Ranking, explicit scope and visibility filters still apply. */
  diversify?: boolean;
  /** Purpose is supplied by the reader/Agent, never inferred from repository paths. */
  purpose?: RetrievalPurpose;
  /** Explicit navigation overrides the conservative natural-language shortcut. */
  codeIntent?: CodeIntent;
  kinds?: RetrievalTarget["kind"][];
  /** Formal article classification, independent of citation/source directories. */
  topicPath?: string[];
  /** Explicit reader filters. Classification is persisted, never inferred from paths. */
  materialRoles?: MaterialRole[];
  /** Search an effective date only when the reader asks; not the capture timestamp. */
  effectiveAt?: string;
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
  /** Shared retrieval over original units, readable explanations and applied state. */
  search?(query: SearchQuery): Promise<RetrievalHit[]>;
  /** Keyword/vector search over imported source fragments. */
  searchSources(query: SearchQuery): SourceCandidate[];
  /** Optional local semantic branch; callers await this when supplied. */
  searchSourcesAsync?(query: SearchQuery): Promise<SourceCandidate[]>;
  /** Search over already-applied memories (for conflict / reuse recall). */
  searchMemories(query: SearchQuery): MemoryCandidate[];
  /** Read back the immutable fragment the candidates point at. */
  readEvidence(
    revisionId: string,
    fragmentId?: string,
  ): EvidenceFragment | null;
  health(): RetrievalHealth;
}
