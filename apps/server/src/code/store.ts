/** Code Knowledge side tables. These live in the SAME isolated review SQLite as
 * review_source_meta / review_relations 鈥?they are additive, CREATE-IF-NOT-EXISTS
 * only, and never touch sources/revisions/fragments/review_relations rows. The
 * code graph is a deterministic projection over the already-captured fragments;
 * it stores no file bodies of its own.
 *
 * Identity rules (deterministic, content-addressed, idempotent):
 *   file_   = sha1(repo_id + ":" + repo-relative path)
 *   sym_    = sha1(repo_id + ":" + path + ":" + qualifiedName + ":" + kind)   -- NO range
 *   cedge_  = sha1(normalized endpoint+kind seed)
 *   snap_   = sha1(repo_id + ":" + commit + ":" + dirty + ":" + sorted content hashes)
 *
 * Symbols are upserted onto the head snapshot: range/fragment are per-snapshot,
 * so a symbol that disappears after an edit simply keeps its old snapshot_id and
 * is filtered out of the current head view. Edges not re-produced by the latest
 * parse, or touching a removed file, are flipped to stale (never deleted). */
import { revisionText } from "../source-text.js";
import { createHash } from "node:crypto";
import type { Store } from "../store.js";
import type {
  CodeEdge,
  CodeEdgeKind,
  CodeEdgeOrigin,
  CodeEdgeStatus,
  CodeFile,
  CodeRange,
  CodeRepository,
  CodeSnapshot,
  CodeSymbol,
  CodeSymbolKind,
  CodeUnderstanding,
} from "../../../../packages/contracts/src/index.js";

export const PARSER_VERSION = "ts-ast@1+vue-sfc@1+regex@1+capture@2";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

export function codeRepositoryId(): string {
  // PoC: single repo. Stable slug.
  return "omem";
}

export function fileIdFor(repoId: string, path: string): string {
  return "file_" + sha1(repoId + ":" + path).slice(0, 24);
}

export function symbolIdFor(
  repoId: string,
  path: string,
  qualifiedName: string,
  kind: string,
): string {
  return (
    "sym_" + sha1(`${repoId}:${path}:${qualifiedName}:${kind}`).slice(0, 24)
  );
}

export function edgeIdFor(seed: string): string {
  return "cedge_" + sha1(seed).slice(0, 24);
}

export function snapshotIdFor(
  repoId: string,
  commit: string | null,
  dirty: boolean,
  contentHashList: string[],
): string {
  const sorted = [...contentHashList].sort().join(",");
  return (
    "snap_" +
    sha1(`${PARSER_VERSION}:${repoId}:${commit ?? "none"}:${dirty ? 1 : 0}:${sorted}`).slice(0, 24)
  );
}

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function num(v: unknown): number {
  return v == null ? 0 : Number(v);
}
function bool(v: unknown): boolean {
  return Number(v) === 1;
}
function nullableStr(v: unknown): string | null {
  return v == null ? null : String(v);
}

export function ensureCodeTables(store: Store): void {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS code_repositories(
    repo_id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL,
    remote TEXT,
    default_branch TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS code_snapshots(
    snapshot_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES code_repositories(repo_id),
    commit_hash TEXT,
    dirty INTEGER NOT NULL DEFAULT 0,
    baseline_commit TEXT,
    captured_at TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    changed_count INTEGER NOT NULL DEFAULT 0,
    partial INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS code_files(
    file_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES code_repositories(repo_id),
    path TEXT NOT NULL UNIQUE,
    language TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT,
    head_snapshot_id TEXT,
    removed INTEGER NOT NULL DEFAULT 0,
    moved_to TEXT
  )`);
  // Migration: symbols/edges must be immutable PER SNAPSHOT. The earlier PoC
  // keyed them by id alone and ON CONFLICT overwrote snapshot_id/range/fragment,
  // so revisiting an old state (A->B->A) erased that snapshot's rows. We do NOT
  // drop history: rename the old table, create the composite-schema table, copy
  // every old row (id/snapshot/body), verify counts, then remove the temp table.
  // This preserves rows for snapshots the parser can no longer re-derive.
  const symCols = db.prepare("PRAGMA table_info(code_symbols)").all() as {
    name: string; pk: number;
  }[];
  const edgesCols = db.prepare("PRAGMA table_info(code_edges)").all() as {
    name: string; pk: number;
  }[];
  const symNeedsRebuild =
    symCols.length > 0 && !symCols.some((c) => c.name === "snapshot_id" && c.pk > 0);
  const edgesNeedsRebuild =
    edgesCols.length > 0 && !edgesCols.some((c) => c.name === "snapshot_id" && c.pk > 0);
  if (symNeedsRebuild) {
    db.exec("ALTER TABLE code_symbols RENAME TO code_symbols_legacy");
  }
  if (edgesNeedsRebuild) {
    db.exec("ALTER TABLE code_edges RENAME TO code_edges_legacy");
  }

  db.exec(`CREATE TABLE IF NOT EXISTS code_symbols(
    symbol_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
    file_id TEXT NOT NULL REFERENCES code_files(file_id),
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    range_start TEXT,
    range_end TEXT,
    fragment_id TEXT,
    exported INTEGER NOT NULL DEFAULT 0,
    signature TEXT,
    PRIMARY KEY (symbol_id, snapshot_id)
  )`);
  if (symNeedsRebuild) {
    db.exec(`INSERT INTO code_symbols
      (symbol_id,snapshot_id,file_id,name,qualified_name,kind,range_start,range_end,fragment_id,exported,signature)
      SELECT symbol_id,snapshot_id,file_id,name,qualified_name,kind,range_start,range_end,fragment_id,exported,signature
      FROM code_symbols_legacy`);
    const copied = Number((db.prepare("SELECT COUNT(*) AS n FROM code_symbols").get() as { n: number }).n);
    const oldN = Number((db.prepare("SELECT COUNT(*) AS n FROM code_symbols_legacy").get() as { n: number }).n);
    if (copied !== oldN) throw new Error(`code_symbols migration copied ${copied} of ${oldN}`);
    db.exec("DROP TABLE code_symbols_legacy");
  }
  db.exec(`CREATE INDEX IF NOT EXISTS code_symbols_file_idx ON code_symbols(file_id, snapshot_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS code_symbols_frag_idx ON code_symbols(fragment_id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS code_edges(
    edge_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
    edge_kind TEXT NOT NULL,
    from_symbol_id TEXT,
    from_file_id TEXT,
    to_symbol_id TEXT,
    to_file_id TEXT,
    status TEXT NOT NULL,
    origin TEXT NOT NULL,
    evidence TEXT,
    seed TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (edge_id, snapshot_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS code_snapshot_sources(
    snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
    path TEXT NOT NULL,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    content_hash TEXT NOT NULL,
    PRIMARY KEY (snapshot_id,path)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS code_snapshot_files(
    snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
    file_id TEXT NOT NULL REFERENCES code_files(file_id),
    path TEXT NOT NULL,
    review_revision_id TEXT,
    content_hash TEXT,
    content_text TEXT,
    PRIMARY KEY (snapshot_id, file_id)
  )`);
  // Edge table rename/copy (same history-preserving migration as symbols).
  if (edgesNeedsRebuild) {
    db.exec(`INSERT INTO code_edges
      (edge_id,snapshot_id,edge_kind,from_symbol_id,from_file_id,to_symbol_id,to_file_id,
       status,origin,evidence,seed,created_at,updated_at)
      SELECT edge_id,snapshot_id,edge_kind,from_symbol_id,from_file_id,to_symbol_id,to_file_id,
       status,origin,evidence,seed,created_at,updated_at
      FROM code_edges_legacy`);
    const copied = Number((db.prepare("SELECT COUNT(*) AS n FROM code_edges").get() as { n: number }).n);
    const oldN = Number((db.prepare("SELECT COUNT(*) AS n FROM code_edges_legacy").get() as { n: number }).n);
    if (copied !== oldN) throw new Error(`code_edges migration copied ${copied} of ${oldN}`);
    db.exec("DROP TABLE code_edges_legacy");
  }
  // Additive column: immutable per-snapshot source text blob.
  const sfCols = (db.prepare("PRAGMA table_info(code_snapshot_files)").all() as { name: string }[]).map((c) => c.name);
  if (!sfCols.includes("content_text"))
    db.exec("ALTER TABLE code_snapshot_files ADD COLUMN content_text TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS code_edges_from_idx ON code_edges(from_symbol_id, from_file_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS code_edges_to_idx ON code_edges(to_symbol_id, to_file_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS code_edges_status_idx ON code_edges(status, edge_kind)`);
  db.exec(`CREATE TABLE IF NOT EXISTS code_understandings(
    understanding_id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL REFERENCES code_snapshots(snapshot_id),
    role_id TEXT NOT NULL,
    role_version TEXT NOT NULL,
    prompt_hash TEXT,
    input_hash TEXT NOT NULL,
    output_schema TEXT NOT NULL,
    output_json TEXT,
    confidence REAL,
    unknowns TEXT,
    evidence_refs TEXT,
    status TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    generated_at TEXT NOT NULL,
    supersedes_id TEXT
  )`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS code_understandings_target_idx ON code_understandings(target_type, target_id, snapshot_id)`,
  );

  // Additive migration: databases created before the CodeUnderstanding.v1
  // provenance/honesty fields existed get the columns back-filled with safe
  // defaults. Old deterministic rows keep role_id='deterministic', seed=0 and
  // are never reinterpreted as curated/model output.
  const cuCols = (
    db.prepare("PRAGMA table_info(code_understandings)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  const addCu = (col: string, ddl: string) => {
    if (!cuCols.includes(col)) db.exec(`ALTER TABLE code_understandings ADD COLUMN ${ddl}`);
  };
  addCu("generation_budget", "generation_budget TEXT");
  addCu("schema_digest", "schema_digest TEXT");
  addCu("seed", "seed INTEGER NOT NULL DEFAULT 0");
  addCu("verified_by_agent", "verified_by_agent INTEGER NOT NULL DEFAULT 0");
  addCu("verified_by", "verified_by TEXT");
  addCu("stale", "stale INTEGER NOT NULL DEFAULT 0");
  addCu("source", "source TEXT NOT NULL DEFAULT 'parser'");
  addCu("curated_by", "curated_by TEXT");
  addCu("curated_at", "curated_at TEXT");
  addCu("curated_note", "curated_note TEXT");

  // Additive migration: explicit head pointer on the repository. We must NOT
  // infer "latest" from captured_at: when the tree returns to a previously
  // seen state the same snapshot row is reused, but a later snapshot row still
  // has a more recent captured_at and would wrongly win. The head pointer is
  // flipped explicitly by every sync (both reused and new branches); old
  // snapshots stay readable via their own ids.
  const repoCols = (
    db.prepare("PRAGMA table_info(code_repositories)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!repoCols.includes("current_snapshot_id")) {
    db.exec(`ALTER TABLE code_repositories ADD COLUMN current_snapshot_id TEXT`);
  }

  // Normalized reference side table. output_json stays the derived, sealed
  // CodeUnderstanding.v1 payload (never raw graph); this table is the indexed
  // projection of every node/edge/evidence id it cites, so the API can expand
  // references without re-parsing JSON and so the references themselves survive
  // even when output_json is replaced.
  db.exec(`CREATE TABLE IF NOT EXISTS code_understanding_refs(
    understanding_id TEXT NOT NULL REFERENCES code_understandings(understanding_id),
    ref_kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    selector TEXT,
    note TEXT,
    PRIMARY KEY (understanding_id, ref_kind, ref_id)
  )`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS code_understandings_status_idx ON code_understandings(stale, status)`,
  );
}

// ---------------------------------------------------------------------------
// Row mappers.
// ---------------------------------------------------------------------------

function repoFromRow(r: Row): CodeRepository {
  return {
    repoId: str(r.repo_id),
    rootPath: str(r.root_path),
    remote: nullableStr(r.remote),
    defaultBranch: nullableStr(r.default_branch),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function snapshotFromRow(r: Row): CodeSnapshot {
  return {
    snapshotId: str(r.snapshot_id),
    repoId: str(r.repo_id),
    commit: nullableStr(r.commit_hash),
    dirty: bool(r.dirty),
    baselineCommit: nullableStr(r.baseline_commit),
    capturedAt: str(r.captured_at),
    parserVersion: str(r.parser_version),
    fileCount: num(r.file_count),
    changedCount: num(r.changed_count),
    partial: bool(r.partial),
  };
}

function fileFromRow(r: Row): CodeFile {
  return {
    fileId: str(r.file_id),
    repoId: str(r.repo_id),
    path: str(r.path),
    language: nullableStr(r.language) ?? "",
    sizeBytes: num(r.size_bytes),
    contentHash: nullableStr(r.content_hash),
    headSnapshotId: nullableStr(r.head_snapshot_id),
    removed: bool(r.removed),
    movedTo: nullableStr(r.moved_to),
  };
}

function rangeFromJson(s: unknown): CodeRange | null {
  if (s == null) return null;
  try {
    const o = JSON.parse(String(s)) as CodeRange;
    return typeof o.line === "number" ? o : null;
  } catch {
    return null;
  }
}

function symbolFromRow(r: Row): CodeSymbol {
  return {
    symbolId: str(r.symbol_id),
    fileId: str(r.file_id),
    snapshotId: str(r.snapshot_id),
    name: str(r.name),
    qualifiedName: str(r.qualified_name),
    kind: str(r.kind) as CodeSymbolKind,
    rangeStart: rangeFromJson(r.range_start),
    rangeEnd: rangeFromJson(r.range_end),
    fragmentId: nullableStr(r.fragment_id),
    exported: bool(r.exported),
    signature: nullableStr(r.signature),
  };
}

function edgeFromRow(r: Row): CodeEdge {
  return {
    edgeId: str(r.edge_id),
    snapshotId: str(r.snapshot_id),
    edgeKind: str(r.edge_kind) as CodeEdgeKind,
    fromSymbolId: nullableStr(r.from_symbol_id),
    fromFileId: nullableStr(r.from_file_id),
    toSymbolId: nullableStr(r.to_symbol_id),
    toFileId: nullableStr(r.to_file_id),
    status: str(r.status) as CodeEdgeStatus,
    origin: str(r.origin) as CodeEdgeOrigin,
    evidence: nullableStr(r.evidence),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Read queries.
// ---------------------------------------------------------------------------

export function listRepositories(store: Store): CodeRepository[] {
  ensureCodeTables(store);
  return (store.db
    .prepare("SELECT * FROM code_repositories ORDER BY repo_id")
    .all() as Row[]).map(repoFromRow);
}

export function listSnapshots(
  store: Store,
  repoId?: string,
): CodeSnapshot[] {
  ensureCodeTables(store);
  const sql = "SELECT * FROM code_snapshots ORDER BY captured_at DESC, rowid DESC";
  const rows = repoId
    ? (store.db.prepare(sql.replace("ORDER BY", "WHERE repo_id=? ORDER BY")).all(repoId) as Row[])
    : (store.db.prepare(sql).all() as Row[]);
  return rows.map(snapshotFromRow);
}

export function currentSnapshotId(store: Store): string | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare("SELECT current_snapshot_id FROM code_repositories ORDER BY repo_id LIMIT 1")
    .get() as { current_snapshot_id: string | null } | undefined;
  return row?.current_snapshot_id ?? null;
}

export function setCurrentSnapshot(store: Store, repoId: string, snapshotId: string): void {
  ensureCodeTables(store);
  store.db
    .prepare(
      "UPDATE code_repositories SET current_snapshot_id=?, updated_at=? WHERE repo_id=?",
    )
    .run(snapshotId, new Date().toISOString(), repoId);
}

export function latestSnapshot(store: Store): CodeSnapshot | null {
  ensureCodeTables(store);
  const cur = currentSnapshotId(store);
  if (cur) {
    const row = store.db
      .prepare("SELECT * FROM code_snapshots WHERE snapshot_id=?")
      .get(cur) as Row | undefined;
    if (row) return snapshotFromRow(row);
  }
  const row = store.db
    .prepare("SELECT * FROM code_snapshots ORDER BY captured_at DESC, rowid DESC LIMIT 1")
    .get() as Row | undefined;
  return row ? snapshotFromRow(row) : null;
}

/** Immutable per-snapshot file pin: the review revision that supplied this
 * file's bytes when the snapshot was built. Used to serve fixed historical
 * source text instead of the live working tree. */
export function upsertSnapshotFile(
  store: Store,
  row: {
    snapshotId: string;
    fileId: string;
    path: string;
    reviewRevisionId: string | null;
    contentHash: string | null;
    contentText: string | null;
  },
): void {
  ensureCodeTables(store);
  store.db
    .prepare(
      `INSERT INTO code_snapshot_files(snapshot_id,file_id,path,review_revision_id,content_hash,content_text)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(snapshot_id,file_id) DO NOTHING`,
    )
    .run(row.snapshotId, row.fileId, row.path, row.reviewRevisionId, row.contentHash, row.contentText);
}

export type SnapshotFileBinding = {
  reviewRevisionId: string | null;
  contentHash: string | null;
  /** Immutable bytes captured when the snapshot was built. null when this file
   * was never part of the snapshot (no binding -> source unavailable). */
  contentText: string | null;
};

export function snapshotFileBinding(
  store: Store,
  snapshotId: string,
  fileId: string,
): SnapshotFileBinding | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare(
      "SELECT review_revision_id, content_hash, content_text FROM code_snapshot_files WHERE snapshot_id=? AND file_id=?",
    )
    .get(snapshotId, fileId) as {
      review_revision_id: string | null;
      content_hash: string | null;
      content_text: string | null;
    } | undefined;
  if (!row) return null;
  return {
    reviewRevisionId: row.review_revision_id ?? null,
    contentHash: row.content_hash ?? null,
    contentText: (row.review_revision_id ? revisionText(store, row.review_revision_id) : null) ?? row.content_text ?? null,
  };
}

export function getSnapshot(store: Store, snapshotId: string): CodeSnapshot | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare("SELECT * FROM code_snapshots WHERE snapshot_id=?")
    .get(snapshotId) as Row | undefined;
  return row ? snapshotFromRow(row) : null;
}

export function listFiles(
  store: Store,
  filter: { language?: string; includeRemoved?: boolean } = {},
): CodeFile[] {
  ensureCodeTables(store);
  const where: string[] = [];
  const params: unknown[] = [];
  if (!filter.includeRemoved) where.push("COALESCE(removed,0)=0");
  if (filter.language) {
    where.push("language=?");
    params.push(filter.language);
  }
  const sql = `SELECT * FROM code_files ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY path`;
  return (store.db.prepare(sql).all(...(params as never[])) as Row[]).map(fileFromRow);
}

export function fileByPath(store: Store, path: string): CodeFile | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare("SELECT * FROM code_files WHERE path=?")
    .get(path) as Row | undefined;
  return row ? fileFromRow(row) : null;
}

export function fileById(store: Store, fileId: string): CodeFile | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare("SELECT * FROM code_files WHERE file_id=?")
    .get(fileId) as Row | undefined;
  return row ? fileFromRow(row) : null;
}

/** Symbols anchored to the CURRENT head snapshot of this file (symbols from
 * superseded snapshots are naturally excluded). Pass snapshotId to read an
 * older snapshot's view. */
export function symbolsOfFile(
  store: Store,
  fileId: string,
  snapshotId?: string,
): CodeSymbol[] {
  ensureCodeTables(store);
  const head = snapshotId ?? currentSnapshotId(store);
  if (!head) return [];
  return (store.db
    .prepare(
      "SELECT * FROM code_symbols WHERE file_id=? AND snapshot_id=? ORDER BY range_start",
    )
    .all(fileId, head) as Row[]).map(symbolFromRow);
}

export function symbolsOfSnapshot(store: Store, snapshotId: string): CodeSymbol[] {
  ensureCodeTables(store);
  return (store.db
    .prepare("SELECT * FROM code_symbols WHERE snapshot_id=? ORDER BY file_id, range_start")
    .all(snapshotId) as Row[]).map(symbolFromRow);
}

export function symbolById(store: Store, symbolId: string): CodeSymbol | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare("SELECT * FROM code_symbols WHERE symbol_id=?")
    .get(symbolId) as Row | undefined;
  return row ? symbolFromRow(row) : null;
}

export function edgesTouching(
  store: Store,
  ref: { symbolId?: string; fileId?: string },
  opts: { includeStale?: boolean; snapshotId?: string } = {},
): CodeEdge[] {
  ensureCodeTables(store);
  const where: string[] = [];
  const params: unknown[] = [];
  const snap = opts.snapshotId ?? currentSnapshotId(store);
  if (!snap) return [];
  where.push("snapshot_id=?");
  params.push(snap);
  if (ref.symbolId) {
    where.push("(from_symbol_id=? OR to_symbol_id=?)");
    params.push(ref.symbolId, ref.symbolId);
  }
  if (ref.fileId) {
    where.push("(from_file_id=? OR to_file_id=?)");
    params.push(ref.fileId, ref.fileId);
  }
  if (!opts.includeStale) where.push("status <> 'stale'");
  const sql = `SELECT * FROM code_edges WHERE ${where.join(" AND ")} ORDER BY edge_kind, edge_id`;
  return (store.db.prepare(sql).all(...(params as never[])) as Row[]).map(edgeFromRow);
}

export function graphView(
  store: Store,
  opts: { snapshotId?: string; includeStale?: boolean } = {},
): { files: CodeFile[]; symbols: CodeSymbol[]; edges: CodeEdge[] } {
  ensureCodeTables(store);
  const current = currentSnapshotId(store);
  const snap = opts.snapshotId ?? current;
  if (!snap) return { files: [], symbols: [], edges: [] };
  // Historical snapshots keep their deleted files; the live head view hides them.
  const isCurrent = snap === current;
  let filesSql = `SELECT cf.* FROM code_files cf
    JOIN code_snapshot_files csf ON csf.file_id = cf.file_id
    WHERE csf.snapshot_id=?`;
  if (isCurrent) filesSql += " AND COALESCE(cf.removed,0)=0";
  const files = (store.db.prepare(filesSql).all(snap) as Row[]).map(fileFromRow);
  const symbols = (store.db
    .prepare("SELECT * FROM code_symbols WHERE snapshot_id=?")
    .all(snap) as Row[]).map(symbolFromRow);
  let edgeSql = "SELECT * FROM code_edges WHERE snapshot_id=?";
  if (!opts.includeStale) edgeSql += " AND status <> 'stale'";
  const edges = (store.db.prepare(edgeSql).all(snap) as Row[]).map(edgeFromRow);
  return { files, symbols, edges };
}

export function understandingOf(
  store: Store,
  target: { type: "file" | "symbol"; id: string },
): CodeUnderstanding | null {
  ensureCodeTables(store);
  const row = store.db
    .prepare(
      `SELECT * FROM code_understandings WHERE target_type=? AND target_id=?
       ORDER BY generated_at DESC, rowid DESC LIMIT 1`,
    )
    .all(target.type, target.id)[0] as Row | undefined;
  if (!row) return null;
  let unknowns: string[] = [];
  let evidenceRefs: string[] = [];
  try {
    unknowns = JSON.parse(str(row.unknowns) || "[]") as string[];
  } catch {
    unknowns = [];
  }
  try {
    evidenceRefs = JSON.parse(str(row.evidence_refs) || "[]") as string[];
  } catch {
    evidenceRefs = [];
  }
  return {
    understandingId: str(row.understanding_id),
    targetType: row.target_type === "repository" ? "repository" : target.type,
    targetId: str(row.target_id),
    snapshotId: str(row.snapshot_id),
    roleId: str(row.role_id),
    roleVersion: str(row.role_version),
    promptHash: nullableStr(row.prompt_hash),
    inputHash: str(row.input_hash),
    outputSchema: str(row.output_schema),
    outputJson: str(row.output_json),
    confidence:
      row.confidence == null ? null : Number(row.confidence),
    unknowns,
    evidenceRefs,
    status: str(row.status) as CodeUnderstanding["status"],
    model: nullableStr(row.model),
    effort: nullableStr(row.effort),
    generatedAt: str(row.generated_at),
    supersedesId: nullableStr(row.supersedes_id),
  };
}

// ---------------------------------------------------------------------------
// Write path (used by sync).
// ---------------------------------------------------------------------------

export function upsertRepository(
  store: Store,
  row: { repoId: string; rootPath: string; remote: string | null; defaultBranch: string | null },
): void {
  ensureCodeTables(store);
  const existing = store.db
    .prepare("SELECT created_at FROM code_repositories WHERE repo_id=?")
    .get(row.repoId) as { created_at: string } | undefined;
  const ts = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO code_repositories(repo_id,root_path,remote,default_branch,created_at,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(repo_id) DO UPDATE SET
         root_path=excluded.root_path, remote=excluded.remote,
         default_branch=excluded.default_branch, updated_at=excluded.updated_at`,
    )
    .run(row.repoId, row.rootPath, row.remote, row.defaultBranch, existing?.created_at ?? ts, ts);
}

export function insertSnapshot(
  store: Store,
  row: {
    snapshotId: string;
    repoId: string;
    commit: string | null;
    dirty: boolean;
    baselineCommit: string | null;
    parserVersion: string;
    fileCount: number;
    changedCount: number;
    partial: boolean;
  },
): void {
  ensureCodeTables(store);
  const ts = new Date().toISOString();
  // Idempotent: same identity = same row. captured_at stays the first time.
  const existing = store.db
    .prepare("SELECT captured_at FROM code_snapshots WHERE snapshot_id=?")
    .get(row.snapshotId) as { captured_at: string } | undefined;
  store.db
    .prepare(
      `INSERT INTO code_snapshots(snapshot_id,repo_id,commit_hash,dirty,baseline_commit,captured_at,
         parser_version,file_count,changed_count,partial)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(snapshot_id) DO UPDATE SET
         file_count=excluded.file_count, changed_count=excluded.changed_count,
         partial=excluded.partial, baseline_commit=excluded.baseline_commit`,
    )
    .run(
      row.snapshotId,
      row.repoId,
      row.commit,
      row.dirty ? 1 : 0,
      row.baselineCommit,
      existing?.captured_at ?? ts,
      row.parserVersion,
      row.fileCount,
      row.changedCount,
      row.partial ? 1 : 0,
    );
}

export function upsertFile(
  store: Store,
  row: {
    fileId: string;
    repoId: string;
    path: string;
    language: string;
    sizeBytes: number;
    contentHash: string | null;
    headSnapshotId: string;
    removed: boolean;
    movedTo: string | null;
  },
): void {
  ensureCodeTables(store);
  store.db
    .prepare(
      `INSERT INTO code_files(file_id,repo_id,path,language,size_bytes,content_hash,
         head_snapshot_id,removed,moved_to)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(file_id) DO UPDATE SET
         language=excluded.language, size_bytes=excluded.size_bytes,
         content_hash=excluded.content_hash, head_snapshot_id=excluded.head_snapshot_id,
         removed=excluded.removed, moved_to=excluded.moved_to`,
    )
    .run(
      row.fileId,
      row.repoId,
      row.path,
      row.language,
      row.sizeBytes,
      row.contentHash,
      row.headSnapshotId,
      row.removed ? 1 : 0,
      row.movedTo,
    );
}

export type UpsertSymbolInput = {
  symbolId: string;
  fileId: string;
  snapshotId: string;
  name: string;
  qualifiedName: string;
  kind: CodeSymbolKind;
  rangeStart: CodeRange;
  rangeEnd: CodeRange;
  fragmentId: string | null;
  exported: boolean;
  signature: string | null;
};

export function upsertSymbol(store: Store, s: UpsertSymbolInput): void {
  ensureCodeTables(store);
  store.db
    .prepare(
      `INSERT INTO code_symbols(symbol_id,file_id,snapshot_id,name,qualified_name,kind,
         range_start,range_end,fragment_id,exported,signature)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(symbol_id, snapshot_id) DO UPDATE SET
         file_id=excluded.file_id,
         range_start=excluded.range_start, range_end=excluded.range_end,
         fragment_id=excluded.fragment_id, exported=excluded.exported,
         signature=excluded.signature`,
    )
    .run(
      s.symbolId,
      s.fileId,
      s.snapshotId,
      s.name,
      s.qualifiedName,
      s.kind,
      JSON.stringify(s.rangeStart),
      JSON.stringify(s.rangeEnd),
      s.fragmentId,
      s.exported ? 1 : 0,
      s.signature,
    );
}

export type UpsertEdgeInput = {
  seed: string;
  snapshotId: string;
  edgeKind: CodeEdgeKind;
  fromSymbolId: string | null;
  fromFileId: string | null;
  toSymbolId: string | null;
  toFileId: string | null;
  status: CodeEdgeStatus;
  origin: CodeEdgeOrigin;
  evidence: string | null;
};

export function upsertEdge(store: Store, e: UpsertEdgeInput): string {
  ensureCodeTables(store);
  const id = edgeIdFor(e.seed);
  const ts = new Date().toISOString();
  store.db
    .prepare(
      `INSERT INTO code_edges(edge_id,snapshot_id,edge_kind,from_symbol_id,from_file_id,
         to_symbol_id,to_file_id,status,origin,evidence,seed,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(edge_id, snapshot_id) DO UPDATE SET
         edge_kind=excluded.edge_kind,
         from_symbol_id=excluded.from_symbol_id, from_file_id=excluded.from_file_id,
         to_symbol_id=excluded.to_symbol_id, to_file_id=excluded.to_file_id,
         status=excluded.status, evidence=excluded.evidence, updated_at=excluded.updated_at`,
    )
    .run(
      id,
      e.snapshotId,
      e.edgeKind,
      e.fromSymbolId,
      e.fromFileId,
      e.toSymbolId,
      e.toFileId,
      e.status,
      e.origin,
      e.evidence,
      e.seed,
      ts,
      ts,
    );
  return id;
}

/** Flip every edge not produced by this run's parse to stale (removed symbols /
 * deleted imports). Edges touching a removed file are also flipped. Returns the
 * number newly flipped. */
export function invalidateStaleEdges(
  store: Store,
  liveSeeds: Set<string>,
  snapshotId: string,
): number {
  ensureCodeTables(store);
  let flipped = 0;
  store.tx(() => {
    // 1) Seeds not re-emitted this run, within THIS snapshot, are stale.
    // Other snapshots keep their own edge rows untouched.
    const rows = store.db
      .prepare("SELECT edge_id, seed FROM code_edges WHERE snapshot_id=? AND status <> 'stale'")
      .all(snapshotId) as { edge_id: string; seed: string }[];
    const staleIds: string[] = [];
    for (const r of rows) if (!liveSeeds.has(str(r.seed))) staleIds.push(str(r.edge_id));
    for (const id of staleIds)
      store.db.prepare("UPDATE code_edges SET status='stale', updated_at=? WHERE edge_id=? AND snapshot_id=?").run(new Date().toISOString(), id, snapshotId);
    flipped += staleIds.length;

    // 2) Edges of THIS snapshot touching a removed file are stale.
    const res = store.db
      .prepare(
        `UPDATE code_edges SET status='stale', updated_at=?
         WHERE snapshot_id=? AND status <> 'stale'
           AND (from_file_id IN (SELECT file_id FROM code_files WHERE removed=1)
             OR to_file_id IN (SELECT file_id FROM code_files WHERE removed=1))`,
      )
      .run(new Date().toISOString(), snapshotId);
    flipped += Number(res.changes ?? 0);
  });
  return flipped;
}

/** Deterministic profiler understanding written without any model. Records what
 * was actually parsed and explicitly lists unknowns; never fakes a summary. */
export function writeDeterministicUnderstanding(
  store: Store,
  row: {
    targetType: "repository" | "file" | "symbol";
    targetId: string;
    snapshotId: string;
    inputHash: string;
    outputJson: string;
    unknowns: string[];
    evidenceRefs: string[];
  },
): void {
  ensureCodeTables(store);
  const ts = new Date().toISOString();
  const id = "cu_" + sha1(`${row.targetType}:${row.targetId}:${row.inputHash}`).slice(0, 24);
  store.db
    .prepare(
      `INSERT INTO code_understandings(
         understanding_id,target_type,target_id,snapshot_id,role_id,role_version,
         prompt_hash,input_hash,output_schema,output_json,confidence,unknowns,
         evidence_refs,status,model,effort,generated_at,supersedes_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(understanding_id) DO UPDATE SET
         output_json=excluded.output_json, unknowns=excluded.unknowns,
         evidence_refs=excluded.evidence_refs, status=excluded.status,
         generated_at=excluded.generated_at`,
    )
    .run(
      id,
      row.targetType,
      row.targetId,
      row.snapshotId,
      "deterministic",
      "1",
      null,
      row.inputHash,
      "CodeUnderstanding.v1",
      row.outputJson,
      null,
      JSON.stringify(row.unknowns),
      JSON.stringify(row.evidenceRefs),
      "ok",
      null,
      null,
      ts,
      null,
    );
}

export function snapshotSourceText(store: Store, snapshotId: string, path: string): string | null {
  const row = store.db.prepare("SELECT revision_id FROM code_snapshot_sources WHERE snapshot_id=? AND path=?").get(snapshotId, path) as { revision_id: string } | undefined;
  return row ? revisionText(store, row.revision_id) : snapshotFileBinding(store, snapshotId, fileIdFor(codeRepositoryId(), path))?.contentText ?? null;
}
