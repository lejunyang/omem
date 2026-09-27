/** repo-review is a code-review-only knowledge base that shares omem's Store,
 * capture and retrieval primitives but points at an isolated data directory. It
 * never touches the personal workspace SQLite/state, runs no Lark/learning workers,
 * and never reads secrets.
 *
 * This module also owns the review-specific metadata that the shared Store schema
 * does not model: which path-identified sources have been deleted/renamed, and a
 * one-time migration that rewrites legacy content-hash external ids into stable
 * `omem:<repo-relative-path>` identities. The side table lives in the review's own
 * SQLite so the shared business Store is never altered. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Store } from "../store.js";

/** Relative (POSIX) directory, inside the repo, that holds both the SQLite/assets
 * and the sync state files. It is gitignored end-to-end. */
export const REVIEW_DIR = ".repo-review";

/** Stable external-id prefix. A source identity is `omem:<repo-relative-path>` so
 * that the same file across content edits accumulates revisions (head moves) while
 * two files that happen to share identical bytes stay independent sources. */
export const EXTERNAL_ID_PREFIX = "omem:";

export function reviewDataDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR, "data");
}

export function reviewStateDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR);
}

/** Build a Store bound to `.repo-review/data`: its own omem.sqlite and assets dir,
 * fully separate from the personal workspace under `.omem/`. */
export function createReviewStore(repoRoot: string): Store {
  return new Store(reviewDataDir(repoRoot));
}

// ---------------------------------------------------------------------------
// Review-side source metadata (deleted / moved / migrated).
// ---------------------------------------------------------------------------

export type SourceMeta = {
  removed: boolean;
  movedTo: string | null;
  migrated: boolean;
};

export function ensureReviewMetaTable(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS review_source_meta(
    source_id TEXT PRIMARY KEY,
    removed INTEGER NOT NULL DEFAULT 0,
    moved_to TEXT,
    migrated INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
}

export function sourceIdForExternalId(
  store: Store,
  externalId: string,
): string | null {
  ensureReviewMetaTable(store);
  const row = store.db
    .prepare(
      "SELECT id FROM sources WHERE namespace='file' AND external_id=?",
    )
    .get(externalId) as { id: string } | undefined;
  return row ? String(row.id) : null;
}

export function getSourceMeta(store: Store, sourceId: string): SourceMeta {
  ensureReviewMetaTable(store);
  const row = store.db
    .prepare(
      "SELECT removed, moved_to, migrated FROM review_source_meta WHERE source_id=?",
    )
    .get(sourceId) as
    | { removed: number; moved_to: string | null; migrated: number }
    | undefined;
  return {
    removed: Boolean(row?.removed),
    movedTo: row?.moved_to ?? null,
    migrated: Boolean(row?.migrated),
  };
}

export function setSourceMeta(
  store: Store,
  sourceId: string,
  patch: Partial<{ removed: boolean; movedTo: string | null; migrated: boolean }>,
): void {
  ensureReviewMetaTable(store);
  const current = getSourceMeta(store, sourceId);
  const removed = patch.removed ?? current.removed;
  const movedTo =
    patch.movedTo !== undefined ? patch.movedTo : current.movedTo;
  const migrated = patch.migrated ?? current.migrated;
  store.db
    .prepare(
      `INSERT INTO review_source_meta(source_id,removed,moved_to,migrated,updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(source_id) DO UPDATE SET
         removed=excluded.removed,
         moved_to=excluded.moved_to,
         migrated=excluded.migrated,
         updated_at=excluded.updated_at`,
    )
    .run(sourceId, removed ? 1 : 0, movedTo, migrated ? 1 : 0, new Date().toISOString());
}

/** Set of source ids marked removed. Used by search to exclude stale/deleted
 * evidence unless the caller explicitly opts back in. */
export function removedSourceIds(store: Store): Set<string> {
  ensureReviewMetaTable(store);
  const rows = store.db
    .prepare("SELECT source_id FROM review_source_meta WHERE removed=1")
    .all() as { source_id: string }[];
  return new Set(rows.map((r) => String(r.source_id)));
}

// ---------------------------------------------------------------------------
// One-time migration: legacy sources keyed by content-hash external id are
// re-pointed at their path identity (derived from the head revision's context).
// Revisions and fragments stay attached to the same source row; nothing is
// deleted. Runs at most once per state dir, marked by a flag file.
// ---------------------------------------------------------------------------

const MIGRATION_MARKER = "migrated-v2.flag";

export function migrateLegacySources(
  store: Store,
  stateDir: string,
): number {
  ensureReviewMetaTable(store);
  const marker = join(stateDir, MIGRATION_MARKER);
  if (existsSync(marker)) return 0;
  mkdirSync(stateDir, { recursive: true });
  let moved = 0;
  const rows = store.db
    .prepare(
      `SELECT s.id AS id, s.external_id AS oldId, r.body AS body
       FROM sources s LEFT JOIN revisions r ON s.head = r.id
       WHERE s.namespace='file'`,
    )
    .all() as { id: string; oldId: string; body: string | null }[];
  for (const row of rows) {
    if (!row.oldId || row.oldId.startsWith(EXTERNAL_ID_PREFIX)) continue;
    let filePath: string | null = null;
    if (row.body) {
      try {
        const parsed = JSON.parse(row.body) as {
          context?: { filePath?: string };
        };
        filePath = parsed.context?.filePath ?? null;
      } catch {
        filePath = null;
      }
    }
    if (!filePath) continue;
    const newId = EXTERNAL_ID_PREFIX + filePath;
    const collision = store.db
      .prepare(
        "SELECT id FROM sources WHERE namespace='file' AND external_id=?",
      )
      .get(newId) as { id: string } | undefined;
    if (collision) continue; // another path already owns this identity; leave as-is
    store.db
      .prepare("UPDATE sources SET external_id=? WHERE id=?")
      .run(newId, row.id);
    setSourceMeta(store, String(row.id), { migrated: true });
    moved++;
  }
  writeFileSync(marker, new Date().toISOString() + "\n", "utf8");
  return moved;
}

// ---------------------------------------------------------------------------
// Review relations: hand-maintained, bidirectional code↔intent↔decision↔
// research↔test links. Forward relation types are stored; the inverse direction
// is derived at query time (e.g. implements → implemented_by). Rows are
// upserted from docs/repo-review/associations.json during sync and are idempotent.
// ---------------------------------------------------------------------------

export type RelationType =
  | "implements"
  | "requires"
  | "decided_by"
  | "researched_by"
  | "tested_by"
  | "candidate_for";

export type RelationStatus = "confirmed" | "candidate" | "missing";

export type ReviewRelationRow = {
  id: string;
  sourceFragmentId: string;
  targetFragmentId: string;
  relationType: RelationType;
  status: RelationStatus;
  evidence: string | null;
  sourceRevisionId: string | null;
  targetRevisionId: string | null;
  createdAt: string;
};

/** Inverse display name for a forward relation type, used when the "other" side
 * is queried (a decision fragment sees "implemented_by", not "implements"). */
export const RELATION_INVERSES: Record<RelationType, string> = {
  implements: "implemented_by",
  requires: "required_by",
  decided_by: "decided_for",
  researched_by: "researched_for",
  tested_by: "tested_for",
  candidate_for: "candidate_of",
};

export function ensureReviewRelationsTable(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS review_relations(
    id TEXT PRIMARY KEY,
    source_fragment_id TEXT NOT NULL,
    target_fragment_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT,
    source_revision_id TEXT,
    target_revision_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(source_fragment_id, target_fragment_id, relation_type)
  )`);
}

/** Deterministic relation id so repeated syncs never mint a duplicate row and
 * ids stay stable across restarts. */
export function relationId(
  sourceFragmentId: string,
  targetFragmentId: string,
  relationType: string,
): string {
  return (
    "rel_" +
    createHash("sha1")
      .update([sourceFragmentId, targetFragmentId, relationType].join("|"))
      .digest("hex")
      .slice(0, 24)
  );
}

export function upsertReviewRelation(
  store: Store,
  row: {
    sourceFragmentId: string;
    targetFragmentId: string;
    relationType: RelationType;
    status: RelationStatus;
    evidence?: string | null;
    sourceRevisionId?: string | null;
    targetRevisionId?: string | null;
  },
): string {
  ensureReviewRelationsTable(store);
  const id = relationId(
    row.sourceFragmentId,
    row.targetFragmentId,
    row.relationType,
  );
  store.db
    .prepare(
      `INSERT INTO review_relations(
         id, source_fragment_id, target_fragment_id, relation_type, status,
         evidence, source_revision_id, target_revision_id, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_fragment_id, target_fragment_id, relation_type) DO UPDATE SET
         status=excluded.status,
         evidence=excluded.evidence,
         source_revision_id=excluded.source_revision_id,
         target_revision_id=excluded.target_revision_id`,
    )
    .run(
      id,
      row.sourceFragmentId,
      row.targetFragmentId,
      row.relationType,
      row.status,
      row.evidence ?? null,
      row.sourceRevisionId ?? null,
      row.targetRevisionId ?? null,
      new Date().toISOString(),
    );
  return id;
}

/** One relation as returned to the API. `direction` is "outgoing" when the
 * queried fragment is the source, "incoming" when it is the target (and
 * relationType is then the inverse display name). For unresolved (missing)
 * links the other-side fields are null. */
export type RelationView = {
  id: string;
  direction: "outgoing" | "incoming";
  relationType: string;
  status: RelationStatus;
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

function rowToView(
  row: Record<string, unknown>,
  direction: "outgoing" | "incoming",
): RelationView {
  const stored = String(row.relation_type);
  const relationType =
    direction === "outgoing"
      ? stored
      : (RELATION_INVERSES as Record<string, string>)[stored] ?? stored;
  const hasOther = row.other_fragment_id != null;
  return {
    id: String(row.id),
    direction,
    relationType,
    status: row.status as RelationStatus,
    evidence: row.evidence != null ? String(row.evidence) : null,
    other: hasOther
      ? {
          fragmentId: String(row.other_fragment_id),
          revisionId: row.other_revision_id ? String(row.other_revision_id) : null,
          text: row.other_text != null ? String(row.other_text) : null,
          title: row.other_title != null ? String(row.other_title) : null,
          version: row.other_version != null ? Number(row.other_version) : null,
          filePath: row.other_filepath != null ? String(row.other_filepath) : null,
          category:
            row.other_category != null ? String(row.other_category) : null,
          externalId:
            row.other_external_id != null ? String(row.other_external_id) : null,
        }
      : null,
  };
}

/** All relations touching a fragment, both directions. LEFT JOIN keeps missing
 * links (empty target/source) visible as `other: null`. */
export function relationsForFragment(
  store: Store,
  fragmentId: string,
): RelationView[] {
  ensureReviewRelationsTable(store);
  const outgoing = store.db
    .prepare(
      `SELECT r.id AS id, r.relation_type AS relation_type, r.status AS status,
              r.evidence AS evidence,
              f.id AS other_fragment_id, f.text AS other_text,
              rev.id AS other_revision_id, rev.title AS other_title, rev.version AS other_version,
              s.external_id AS other_external_id,
              json_extract(rev.body,'$.context.filePath') AS other_filepath,
              json_extract(rev.body,'$.context.category') AS other_category
       FROM review_relations r
       LEFT JOIN fragments f ON f.id = r.target_fragment_id
       LEFT JOIN revisions rev ON rev.id = f.revision_id
       LEFT JOIN sources s ON s.id = rev.source_id
       WHERE r.source_fragment_id = ?`,
    )
    .all(fragmentId) as Record<string, unknown>[];
  const incoming = store.db
    .prepare(
      `SELECT r.id AS id, r.relation_type AS relation_type, r.status AS status,
              r.evidence AS evidence,
              f.id AS other_fragment_id, f.text AS other_text,
              rev.id AS other_revision_id, rev.title AS other_title, rev.version AS other_version,
              s.external_id AS other_external_id,
              json_extract(rev.body,'$.context.filePath') AS other_filepath,
              json_extract(rev.body,'$.context.category') AS other_category
       FROM review_relations r
       LEFT JOIN fragments f ON f.id = r.source_fragment_id
       LEFT JOIN revisions rev ON rev.id = f.revision_id
       LEFT JOIN sources s ON s.id = rev.source_id
       WHERE r.target_fragment_id = ?`,
    )
    .all(fragmentId) as Record<string, unknown>[];
  return [
    ...outgoing.map((r) => rowToView(r, "outgoing")),
    ...incoming.map((r) => rowToView(r, "incoming")),
  ];
}

export function listReviewRelations(
  store: Store,
  filter: { status?: string; type?: string },
): RelationView[] {
  ensureReviewRelationsTable(store);
  const where: string[] = [];
  const params: string[] = [];
  if (filter.status) {
    where.push("r.status = ?");
    params.push(filter.status);
  }
  if (filter.type) {
    where.push("r.relation_type = ?");
    params.push(filter.type);
  }
  const sql = `
    SELECT r.id AS id, r.relation_type AS relation_type, r.status AS status,
           r.evidence AS evidence,
           sf.id AS other_fragment_id, sf.text AS other_text,
           srev.id AS other_revision_id, srev.title AS other_title, srev.version AS other_version,
           ss.external_id AS other_external_id,
           json_extract(srev.body,'$.context.filePath') AS other_filepath,
           json_extract(srev.body,'$.context.category') AS other_category
    FROM review_relations r
    LEFT JOIN fragments sf ON sf.id = r.target_fragment_id
    LEFT JOIN revisions srev ON srev.id = sf.revision_id
    LEFT JOIN sources ss ON ss.id = srev.source_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.created_at DESC LIMIT 500`;
  const rows = store.db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => rowToView(r, "outgoing"));
}

/** All outgoing relations whose source fragment lives in the head revision of
 * the given code file. Powers the trace chain view (intent→decision→research→
 * test for one file). */
export function relationsForCodePath(
  store: Store,
  filePath: string,
): RelationView[] {
  ensureReviewRelationsTable(store);
  const rows = store.db
    .prepare(
      `SELECT r.id AS id, r.relation_type AS relation_type, r.status AS status,
              r.evidence AS evidence,
              tf.id AS other_fragment_id, tf.text AS other_text,
              trev.id AS other_revision_id, trev.title AS other_title, trev.version AS other_version,
              ts.external_id AS other_external_id,
              json_extract(trev.body,'$.context.filePath') AS other_filepath,
              json_extract(trev.body,'$.context.category') AS other_category
       FROM review_relations r
       JOIN fragments sf ON sf.id = r.source_fragment_id
       JOIN revisions srev ON srev.id = sf.revision_id
       LEFT JOIN fragments tf ON tf.id = r.target_fragment_id
       LEFT JOIN revisions trev ON trev.id = tf.revision_id
       LEFT JOIN sources ts ON ts.id = trev.source_id
       WHERE json_extract(srev.body,'$.context.filePath') = ?
       ORDER BY r.relation_type, r.created_at`,
    )
    .all(filePath) as Record<string, unknown>[];
  return rows.map((r) => rowToView(r, "outgoing"));
}

/** Counts for GET /associations: total relation rows plus per-status buckets. */
export function relationsSummary(store: Store): {
  total: number;
  confirmed: number;
  candidate: number;
  missing: number;
  byType: Record<string, number>;
} {
  ensureReviewRelationsTable(store);
  const rows = store.db
    .prepare("SELECT status, relation_type FROM review_relations")
    .all() as { status: string; relation_type: string }[];
  const out = {
    total: rows.length,
    confirmed: 0,
    candidate: 0,
    missing: 0,
    byType: {} as Record<string, number>,
  };
  for (const r of rows) {
    if (r.status === "confirmed") out.confirmed++;
    else if (r.status === "candidate") out.candidate++;
    else out.missing++;
    out.byType[r.relation_type] = (out.byType[r.relation_type] ?? 0) + 1;
  }
  return out;
}
