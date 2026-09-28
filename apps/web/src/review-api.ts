/** Client for the repo-review knowledge-base API (/api/review/*). This surface is
 * read/browse/sync only, bound to loopback, and has no token gating, so unlike the
 * personal workspace api.ts it sends no Authorization header. Shapes mirror
 * apps/server/src/review/app.ts exactly. */

export type ReviewHealth = {
  mode: "review";
  dataDir: string;
  port: number;
  lastSyncCommit: string | null;
  sourceCount: number;
  fragmentCount: number;
};

export type ReviewCategory = {
  id: string;
  name: string;
  sourceCount: number;
  fragmentCount: number;
};

/** One row of GET /sources (head revision per source). */
export type ReviewSource = {
  sourceId: string;
  externalId: string;
  revisionId: string;
  title: string;
  version: number;
  createdAt: string;
  category: string | null;
  filePath: string | null;
  /** True when the source's backing file has been deleted on disk. Older
   * backends may omit it; the frontend treats absence as not-removed. */
  removed?: boolean;
};

/** One row of GET /sources/:id/versions — a historical revision of a source. */
export type ReviewSourceVersion = {
  id: string;
  version: number;
  current: boolean;
  createdAt: string;
  contentHash: string | null;
  /** Head commit captured when this revision was synced. May be absent on
   * backends that do not project it onto the versions list. */
  gitCommit?: string | null;
  dirty?: boolean;
};

/** Free-form context carried per revision (category, filePath, gitRevision,
 * symbols, reviewDate ...). The strict personal-workspace context schema does not
 * apply here, so keep it open. Snapshot fields written by the review sync are
 * typed explicitly so the read view can show them without casts. */
export type ReviewContext = {
  category?: string;
  filePath?: string;
  gitRevision?: string;
  symbols?: string[];
  reviewDate?: string;
  /** Real HEAD commit captured at sync time (not mtime). */
  gitCommit?: string | null;
  /** True when the working tree had uncommitted/untracked changes at sync time. */
  dirty?: boolean;
  /** SHA-256 of the captured file content. */
  contentHash?: string | null;
  /** ISO timestamp of the sync that minted this revision. */
  syncedAt?: string;
  [key: string]: unknown;
};

export type ReviewRevision = {
  id: string;
  sourceId: string;
  version: number;
  title: string;
  source: string;
  createdAt: string;
  context: ReviewContext;
  fragments: { id: string; revisionId: string; ordinal: number; text: string }[];
  previousId: string | null;
  current: boolean;
};

export type ReviewFragmentDetail = {
  id: string;
  revisionId: string;
  ordinal: number;
  text: string;
  revision: {
    id: string;
    title: string;
    version: number;
    source: string;
    createdAt: string;
    current: boolean;
    context: ReviewContext;
  };
  provenance: unknown;
};

export type ReviewSearchHit = {
  id: string;
  score: number;
  snippet: string;
  text: string;
  title: string;
  version: number;
  category: string | null;
  filePath: string | null;
};

/** One bidirectional relation touching a fragment. `relationType` is already
 * inverted when the queried fragment is the target (e.g. a decision fragment
 * sees "implemented_by"). `other` is null for unresolved (missing) links.
 *
 * `relationStatus` is the EFFECTIVE status shown in the UI: the stored status,
 * forced to "stale" when the other side no longer points at a current,
 * non-removed head. `otherCurrent`/`otherRemoved` explain why. */
export type ReviewRelation = {
  id: string;
  direction: "outgoing" | "incoming";
  relationType: string;
  relationStatus: "confirmed" | "candidate" | "missing" | "stale";
  otherCurrent: boolean;
  otherRemoved: boolean;
  evidence: string | null;
  other: {
    fragmentId: string;
    revisionId: string | null;
    text: string | null;
    title: string | null;
    version: number | null;
    filePath: string | null;
    category: string | null;
    externalId: string | null;
  } | null;
};

export type FragmentRelations = {
  fragmentId: string;
  relations: ReviewRelation[];
};

export type AssociationsSummary = {
  seedCount: number;
  total: number;
  confirmed: number;
  candidate: number;
  missing: number;
  byType: Record<string, number>;
};

export type SyncStats = {
  totalScanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

export type SyncResult = SyncStats & {
  lastSyncCommit: string | null;
  lastSyncAt: string;
};

export type SyncStatus = {
  lastSyncCommit: string | null;
  lastSyncAt: string | null;
  stats: SyncStats | null;
  running?: boolean;
  lastResult?: SyncResult | null;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch("/api/review" + path);
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw Error((value && (value as { error?: string }).error) || "请求失败");
  return value as T;
}

async function post<T>(path: string): Promise<T> {
  const r = await fetch("/api/review" + path, { method: "POST" });
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw Error((value && (value as { error?: string }).error) || "请求失败");
  return value as T;
}

export async function reviewHealth(): Promise<ReviewHealth> {
  return get("/health");
}
export async function reviewCategories(): Promise<ReviewCategory[]> {
  return get("/categories");
}
export async function reviewSources(
  category?: string,
  includeRemoved = false,
): Promise<ReviewSource[]> {
  let path = "/sources";
  const params: string[] = [];
  if (category) params.push("category=" + encodeURIComponent(category));
  if (includeRemoved) params.push("includeRemoved=true");
  if (params.length) path += "?" + params.join("&");
  return get(path);
}
/** All historical revisions of one source, newest version first. */
export async function getSourceVersions(
  sourceId: string,
): Promise<ReviewSourceVersion[]> {
  return get("/sources/" + encodeURIComponent(sourceId) + "/versions");
}
export async function reviewRevision(id: string): Promise<ReviewRevision> {
  return get("/revisions/" + encodeURIComponent(id));
}
export async function reviewFragment(id: string): Promise<ReviewFragmentDetail> {
  return get("/fragments/" + encodeURIComponent(id));
}
export async function reviewSearch(
  q: string,
  category?: string,
): Promise<ReviewSearchHit[]> {
  let path = "/search?q=" + encodeURIComponent(q);
  if (category) path += "&category=" + encodeURIComponent(category);
  return get(path);
}
export async function reviewSyncStatus(): Promise<SyncStatus> {
  return get("/sync/status");
}
export async function reviewRunSync(): Promise<SyncResult> {
  return post("/sync");
}
/** 404 resolves to null instead of throwing, so the trace view can show a friendly
 * "no material for this file" state. */
export async function reviewCode(path: string): Promise<ReviewSource | null> {
  const r = await fetch("/api/review/code?path=" + encodeURIComponent(path));
  if (r.status === 404) return null;
  const value = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Error((value && (value as { error?: string }).error) || "请求失败");
  return value as ReviewSource;
}

export async function reviewFragmentRelations(
  fragmentId: string,
): Promise<FragmentRelations> {
  return get("/fragments/" + encodeURIComponent(fragmentId) + "/relations");
}

/** All outgoing relations for a code file's head fragments (trace chain view). */
export async function reviewCodeRelations(path: string): Promise<ReviewRelation[]> {
  return get("/code-relations?path=" + encodeURIComponent(path));
}

export async function reviewAssociations(): Promise<AssociationsSummary> {
  return get("/associations");
}

// ---------------------------------------------------------------------------
// Code Knowledge read surface (/api/review/code/*). Shapes mirror
// packages/contracts/src/index.ts (Code* types) and apps/server/src/code/*.
// ---------------------------------------------------------------------------

export type CodeSnapshot = {
  snapshotId: string;
  repoId: string;
  commit: string | null;
  dirty: boolean;
  capturedAt: string;
  parserVersion: string;
  fileCount: number;
  changedCount: number;
  partial: boolean;
};

export type CodeFile = {
  fileId: string;
  repoId: string;
  path: string;
  language: string;
  sizeBytes: number;
  contentHash: string | null;
  headSnapshotId: string | null;
  removed: boolean;
};

export type CodeRange = { line: number; col: number };

export type CodeSymbol = {
  symbolId: string;
  fileId: string;
  snapshotId: string;
  name: string;
  qualifiedName: string;
  kind: string;
  rangeStart: CodeRange | null;
  rangeEnd: CodeRange | null;
  fragmentId: string | null;
  exported: boolean;
  signature: string | null;
};

export type CodeEdge = {
  edgeId: string;
  snapshotId: string;
  edgeKind: string;
  fromSymbolId: string | null;
  fromFileId: string | null;
  toSymbolId: string | null;
  toFileId: string | null;
  status: "confirmed" | "candidate" | "stale" | "missing";
  origin: string;
  evidence: string | null;
};

export type CodeGraph = { files: CodeFile[]; symbols: CodeSymbol[]; edges: CodeEdge[] };

export type CodeUnderstanding = {
  understandingId: string;
  targetType: string;
  targetId: string;
  roleId: string;
  status: string;
  model: string | null;
  effort: string | null;
  confidence: number | null;
  unknowns: string[];
  evidenceRefs: string[];
  outputJson: string;
  generatedAt: string;
};

export type SourceSlice = {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
};

export type CodeSyncResult = {
  snapshotId: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  staleEdgeCount: number;
  reused: boolean;
};

async function codeGet<T>(path: string): Promise<T> {
  return get("/code" + path);
}

export async function codeCurrentSnapshot(): Promise<CodeSnapshot | null> {
  return codeGet("/current-snapshot");
}
export async function codeGraph(): Promise<CodeGraph> {
  return codeGet("/graph");
}
export async function codeFileById(id: string): Promise<CodeFile> {
  return codeGet("/files/" + encodeURIComponent(id));
}
export async function codeSymbolsOfFile(id: string): Promise<CodeSymbol[]> {
  return codeGet("/files/" + encodeURIComponent(id) + "/symbols");
}
export async function codeEdgesForFile(fileId: string): Promise<CodeEdge[]> {
  return codeGet("/edges?fileId=" + encodeURIComponent(fileId));
}
export async function codeUnderstandingFile(id: string): Promise<{ understanding: CodeUnderstanding | null }> {
  return codeGet("/understanding?type=file&id=" + encodeURIComponent(id));
}
export async function codeSourceSlice(
  id: string,
  startLine: number,
  endLine: number,
): Promise<SourceSlice> {
  return codeGet(
    "/files/" + encodeURIComponent(id) + "/source?startLine=" + startLine + "&endLine=" + endLine,
  );
}
/** Fetch the whole file: probe totalLines with a 1-line request, then fetch all. */
export async function codeSourceFull(id: string): Promise<SourceSlice> {
  const probe = await codeSourceSlice(id, 1, 1);
  if (probe.totalLines <= 1) return probe;
  return codeSourceSlice(id, 1, probe.totalLines);
}
export async function codeRunSync(): Promise<CodeSyncResult> {
  const r = await fetch("/api/review/code/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw Error((value && (value as { error?: string }).error) || "code sync failed");
  return value as CodeSyncResult;
}
