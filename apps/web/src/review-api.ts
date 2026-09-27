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
};

/** Free-form context carried per revision (category, filePath, gitRevision,
 * symbols, reviewDate ...). The strict personal-workspace context schema does not
 * apply here, so keep it open. */
export type ReviewContext = {
  category?: string;
  filePath?: string;
  gitRevision?: string;
  symbols?: string[];
  reviewDate?: string;
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
export async function reviewSources(category?: string): Promise<ReviewSource[]> {
  return get("/sources" + (category ? "?category=" + encodeURIComponent(category) : ""));
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
