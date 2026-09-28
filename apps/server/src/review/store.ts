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
import { existsSync, mkdirSync, writeFileSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep as pathSep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../store.js";

/** Relative (POSIX) directory, inside the repo, that holds review runtime data.
 *
 * Layout:
 *   .repo-review/runtime/   gitignored live runtime: omem.sqlite WAL, sync state,
 *                           assets. Created on demand and seeded once from the
 *                           tracked legacy snapshot below.
 *   .repo-review/data/      tracked frozen seed snapshot (omem.sqlite). Kept in
 *                           Git as a reproducible baseline; after migration the
 *                           running server never writes here again.
 *   .repo-review/knowledge/ tracked curated seeds (understandings, manifests). */
export const REVIEW_DIR = ".repo-review";

/** Stable external-id prefix. A source identity is `omem:<repo-relative-path>` so
 * that the same file across content edits accumulates revisions (head moves) while
 * two files that happen to share identical bytes stay independent sources. */
export const EXTERNAL_ID_PREFIX = "omem:";

export function reviewDataDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR, "runtime", "data");
}

export function reviewStateDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR, "runtime");
}

/** Pre-runtime tracked snapshot locations. Read-only seed source; the running
 * server never writes to these after the one-time seed. */
function legacyReviewDataDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR, "data");
}
function legacyReviewStateDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR);
}

/** One-time, idempotent seed: if the ignored runtime DB does not exist yet but the
 * tracked legacy snapshot does, take a consistent read-only SQLite backup
 * (`VACUUM INTO`, which captures WAL frames without writing the source) and
 * project the sync-state files. The legacy files are never modified, deleted, or
 * untracked. On failure any partial destination is removed so the next boot can
 * retry; the legacy snapshot stays intact. */
export function ensureReviewRuntimeSeeded(repoRoot: string): void {
  const runtimeData = reviewDataDir(repoRoot);
  const runtimeDb = join(runtimeData, "omem.sqlite");
  if (existsSync(runtimeDb)) return; // already seeded: runtime is authoritative
  const legacyDb = join(legacyReviewDataDir(repoRoot), "omem.sqlite");
  if (!existsSync(legacyDb)) return; // no legacy snapshot: start empty

  mkdirSync(runtimeData, { recursive: true });
  mkdirSync(reviewStateDir(repoRoot), { recursive: true });

  let src: DatabaseSync | null = null;
  try {
    src = new DatabaseSync(legacyDb, { readOnly: true });
    // VACUUM INTO reads a consistent snapshot; the destination must not exist.
    // SQLite SQL literals use forward slashes on all platforms.
    src.exec(`VACUUM INTO '${runtimeDb.split(pathSep).join("/")}'`);
  } catch (err) {
    try { rmSync(runtimeDb, { force: true }); } catch { /* ignore */ }
    throw err;
  } finally {
    try { src?.close(); } catch { /* ignore */ }
  }

  // Project sync state + migration marker so incremental sync resumes from the
  // recorded commit and the v2 migration does not re-run.
  const stateFiles = ["last-sync.txt", "last-sync.json", MIGRATION_MARKER] as const;
  for (const name of stateFiles) {
    const from = join(legacyReviewStateDir(repoRoot), name);
    if (existsSync(from))
      copyFileSync(from, join(reviewStateDir(repoRoot), name));
  }
  // Project any already-captured asset blobs (review is text-only today, but keep
  // the projection lossless).
  const legacyAssets = join(legacyReviewDataDir(repoRoot), "assets");
  if (existsSync(legacyAssets))
    cpSync(legacyAssets, join(runtimeData, "assets"), { recursive: true });
}

/** Build a Store bound to `.repo-review/runtime/data`: its own omem.sqlite and
 * assets dir, fully separate from the personal workspace under `.omem/`. On first
 * boot the runtime is seeded from the tracked legacy snapshot (see
 * {@link ensureReviewRuntimeSeeded}). */
export function createReviewStore(repoRoot: string): Store {
  ensureReviewRuntimeSeeded(repoRoot);
  return new Store(reviewDataDir(repoRoot));
}

// ---------------------------------------------------------------------------
// Review-side source metadata (deleted / moved / migrated).
// ---------------------------------------------------------------------------

export type SourceMeta = {
  removed: boolean;
  movedTo: string | null;
  migrated: boolean;
  /** For a legacy content-hash source that lost its path to a newer snapshot:
   * the `omem:<path>` it was demoted as an alias of. Null for path-identified
   * sources and un-aliased legacy rows. */
  legacyAliasOf: string | null;
};

export function ensureReviewMetaTable(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS review_source_meta(
    source_id TEXT PRIMARY KEY,
    removed INTEGER NOT NULL DEFAULT 0,
    moved_to TEXT,
    migrated INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  // Idempotent column addition for databases created before aliases existed.
  const cols = store.db
    .prepare("PRAGMA table_info(review_source_meta)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "legacy_alias_of"))
    store.db.exec(
      "ALTER TABLE review_source_meta ADD COLUMN legacy_alias_of TEXT",
    );
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
      "SELECT removed, moved_to, migrated, legacy_alias_of FROM review_source_meta WHERE source_id=?",
    )
    .get(sourceId) as
    | {
        removed: number;
        moved_to: string | null;
        migrated: number;
        legacy_alias_of: string | null;
      }
    | undefined;
  return {
    removed: Boolean(row?.removed),
    movedTo: row?.moved_to ?? null,
    migrated: Boolean(row?.migrated),
    legacyAliasOf: row?.legacy_alias_of ?? null,
  };
}

export function setSourceMeta(
  store: Store,
  sourceId: string,
  patch: Partial<{
    removed: boolean;
    movedTo: string | null;
    migrated: boolean;
    legacyAliasOf: string | null;
  }>,
): void {
  ensureReviewMetaTable(store);
  const current = getSourceMeta(store, sourceId);
  const removed = patch.removed ?? current.removed;
  const movedTo =
    patch.movedTo !== undefined ? patch.movedTo : current.movedTo;
  const migrated = patch.migrated ?? current.migrated;
  const legacyAliasOf =
    patch.legacyAliasOf !== undefined
      ? patch.legacyAliasOf
      : current.legacyAliasOf;
  store.db
    .prepare(
      `INSERT INTO review_source_meta(source_id,removed,moved_to,migrated,legacy_alias_of,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(source_id) DO UPDATE SET
         removed=excluded.removed,
         moved_to=excluded.moved_to,
         migrated=excluded.migrated,
         legacy_alias_of=excluded.legacy_alias_of,
         updated_at=excluded.updated_at`,
    )
    .run(
      sourceId,
      removed ? 1 : 0,
      movedTo,
      migrated ? 1 : 0,
      legacyAliasOf,
      new Date().toISOString(),
    );
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

/** Detach a legacy source from current browsing/retrieval without touching its
 * revisions/fragments, and record which path identity it aliases. Idempotent:
 * a no-op once the source is already detached and aliased correctly. */
function demoteLegacySource(
  store: Store,
  sourceId: string,
  aliasOf: string,
): void {
  const headRow = store.db
    .prepare("SELECT head FROM sources WHERE id=?")
    .get(sourceId) as { head: string | null } | undefined;
  const meta = getSourceMeta(store, sourceId);
  const alreadyDetached = headRow?.head == null;
  if (alreadyDetached && meta.legacyAliasOf === aliasOf) return;
  store.db
    .prepare("UPDATE sources SET head=NULL WHERE id=?")
    .run(sourceId);
  setSourceMeta(store, sourceId, {
    migrated: true,
    legacyAliasOf: aliasOf,
  });
}

export function migrateLegacySources(
  store: Store,
  stateDir: string,
): number {
  ensureReviewMetaTable(store);
  mkdirSync(stateDir, { recursive: true });
  const marker = join(stateDir, MIGRATION_MARKER);

  // Fast path: once migrated, only re-run if an earlier broken migration left a
  // legacy (content-hash) source still attached to a live head. Otherwise every
  // sync start would re-scan for nothing.
  if (existsSync(marker)) {
    const live = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sources s
         WHERE s.namespace='file' AND s.external_id NOT LIKE ? AND s.head IS NOT NULL`,
      )
      .get(EXTERNAL_ID_PREFIX + "%") as { n: number };
    if (Number(live.n) === 0) return 0;
  }

  // Collect every legacy content-hash source, grouped by the filePath recorded
  // on its MOST RECENT revision. Revisions are immutable, so filePath stays
  // available even after a source's head is detached for history.
  const legacy = store.db
    .prepare(
      `SELECT s.id AS id, s.external_id AS oldId,
              (SELECT r.version FROM revisions r WHERE r.source_id=s.id
                 ORDER BY r.version DESC, r.created_at DESC LIMIT 1) AS latest_version,
              (SELECT r.created_at FROM revisions r WHERE r.source_id=s.id
                 ORDER BY r.version DESC, r.created_at DESC LIMIT 1) AS latest_created,
              (SELECT r.body FROM revisions r WHERE r.source_id=s.id
                 ORDER BY r.version DESC, r.created_at DESC LIMIT 1) AS latest_body
       FROM sources s
       WHERE s.namespace='file' AND s.external_id NOT LIKE ?`,
    )
    .all(EXTERNAL_ID_PREFIX + "%") as {
    id: string;
    oldId: string;
    latest_version: number | null;
    latest_created: string | null;
    latest_body: string | null;
  }[];

  type LegacyRow = (typeof legacy)[number];
  const groups = new Map<string, LegacyRow[]>();
  for (const row of legacy) {
    let filePath: string | null = null;
    if (row.latest_body) {
      try {
        filePath = (JSON.parse(row.latest_body) as {
          context?: { filePath?: string };
        }).context?.filePath ?? null;
      } catch {
        filePath = null;
      }
    }
    if (!filePath) continue;
    const arr = groups.get(filePath) ?? [];
    arr.push(row);
    groups.set(filePath, arr);
  }

  let moved = 0;
  store.tx(() => {
    for (const [filePath, rows] of groups) {
      const newId = EXTERNAL_ID_PREFIX + filePath;
      // An already-migrated path source keeps the current head; every legacy row
      // for this path becomes a historical alias instead of colliding live.
      const existing = store.db
        .prepare(
          "SELECT id FROM sources WHERE namespace='file' AND external_id=?",
        )
        .get(newId) as { id: string } | undefined;

      if (!existing) {
        // Pick the newest snapshot as the current head and re-point its identity.
        rows.sort((a, b) =>
          Number(b.latest_version ?? 0) - Number(a.latest_version ?? 0) ||
          String(b.latest_created ?? "").localeCompare(
            String(a.latest_created ?? ""),
          ),
        );
        const winner = rows[0]!;
        store.db
          .prepare("UPDATE sources SET external_id=? WHERE id=?")
          .run(newId, winner.id);
        setSourceMeta(store, String(winner.id), {
          migrated: true,
          legacyAliasOf: null,
        });
        moved++;
        for (const loser of rows.slice(1))
          demoteLegacySource(store, String(loser.id), newId);
      } else {
        for (const row of rows)
          demoteLegacySource(store, String(row.id), newId);
      }
    }
  });

  if (!existsSync(marker))
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

export type RelationStatus = "confirmed" | "candidate" | "missing" | "stale";

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
  // Older derived tables (pre seed_identity) are disposable: relations are rebuilt
  // from the seed on every sync, so dropping a stale-shaped table loses nothing.
  const cols = store.db
    .prepare("PRAGMA table_info(review_relations)")
    .all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === "seed_identity"))
    store.db.exec("DROP TABLE review_relations");
  store.db.exec(`CREATE TABLE IF NOT EXISTS review_relations(
    id TEXT PRIMARY KEY,
    seed_identity TEXT,
    source_fragment_id TEXT NOT NULL,
    target_fragment_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT,
    source_revision_id TEXT,
    target_revision_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(seed_identity)
  )`);
}

/** Deterministic relation id so repeated syncs never mint a duplicate row and
 * ids stay stable across restarts. seedIdentity makes each seed-derived edge
 * unique even when both fragment endpoints are unresolved (missing links). */
export function relationId(seedIdentity: string): string {
  return (
    "rel_" +
    createHash("sha1").update(seedIdentity).digest("hex").slice(0, 24)
  );
}

export function upsertReviewRelation(
  store: Store,
  row: {
    seedIdentity: string;
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
  const id = relationId(row.seedIdentity);
  store.db
    .prepare(
      `INSERT INTO review_relations(
         id, seed_identity, source_fragment_id, target_fragment_id, relation_type,
         status, evidence, source_revision_id, target_revision_id, created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         source_fragment_id=excluded.source_fragment_id,
         target_fragment_id=excluded.target_fragment_id,
         relation_type=excluded.relation_type,
         status=excluded.status,
         evidence=excluded.evidence,
         source_revision_id=excluded.source_revision_id,
         target_revision_id=excluded.target_revision_id`,
    )
    .run(
      id,
      row.seedIdentity,
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

/** After a sync, any seed-derived edge whose assoc id is no longer in the seed
 * list is flipped to stale (never silently kept green). */
export function invalidateRemovedSeeds(
  store: Store,
  validAssocIds: Set<string>,
): number {
  ensureReviewRelationsTable(store);
  if (validAssocIds.size === 0) return 0;
  const marks: string[] = [];
  for (const id of validAssocIds) marks.push(id);
  const placeholders = marks.map(() => "?").join(",");
  const res = store.db
    .prepare(
      `UPDATE review_relations SET status='stale'
       WHERE status <> 'stale' AND seed_identity IS NOT NULL
       AND substr(seed_identity, 1, instr(seed_identity, '#') - 1) NOT IN (${placeholders})`,
    )
    .run(...marks);
  return Number(res.changes ?? 0);
}

/** One relation as returned to the API. `direction` is "outgoing" when the
 * queried fragment is the source, "incoming" when it is the target (and
 * relationType is then the inverse display name). For unresolved (missing)
 * links the other-side fields are null.
 *
 * `status` is the stored row; `relationStatus` is the EFFECTIVE status shown to
 * users: it is forced to "stale" whenever the other side no longer resolves to a
 * current, non-removed source. `otherCurrent`/`otherRemoved` expose why. */
export type RelationView = {
  id: string;
  direction: "outgoing" | "incoming";
  relationType: string;
  status: RelationStatus;
  relationStatus: RelationStatus;
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
  // Other side is "current" when its revision is still the source's head.
  const otherCurrent =
    row.other_current != null && Number(row.other_current) === 1;
  const otherRemoved =
    row.other_removed != null && Number(row.other_removed) === 1;
  // A live-but-non-current or removed other side must never read as green.
  const storedStatus = String(row.status);
  const relationStatus: RelationStatus =
    hasOther && (!otherCurrent || otherRemoved)
      ? "stale"
      : (storedStatus as RelationStatus);
  return {
    id: String(row.id),
    direction,
    relationType,
    status: storedStatus as RelationStatus,
    relationStatus,
    otherCurrent,
    otherRemoved,
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

/** Options for relation reads. Default (both false) hides dead links: rows whose
 * stored status is "stale", plus rows whose other side is on a non-head revision
 * or a removed source. Set `includeStale` for the historical view. */
export type RelationReadOptions = {
  includeStale?: boolean;
};

/** Shared SELECT columns for the "other" side, used by both directions. */
const OTHER_SELECT = `f.id AS other_fragment_id, f.text AS other_text,
      rev.id AS other_revision_id, rev.title AS other_title, rev.version AS other_version,
      s.external_id AS other_external_id,
      json_extract(rev.body,'$.context.filePath') AS other_filepath,
      json_extract(rev.body,'$.context.category') AS other_category,
      (s.head = rev.id) AS other_current,
      COALESCE(sm.removed, 0) AS other_removed`;

const OTHER_JOIN = `LEFT JOIN fragments f ON f.id = {other_join_col}
       LEFT JOIN revisions rev ON rev.id = f.revision_id
       LEFT JOIN sources s ON s.id = rev.source_id
       LEFT JOIN review_source_meta sm ON sm.source_id = s.id`;

/** All relations touching a fragment, both directions. LEFT JOIN keeps missing
 * links (empty target/source) visible as `other: null`. */
export function relationsForFragment(
  store: Store,
  fragmentId: string,
  options: RelationReadOptions = {},
): RelationView[] {
  ensureReviewRelationsTable(store);
  ensureReviewMetaTable(store);
  const includeStale = options.includeStale === true;
  const outgoingSql = `SELECT r.id AS id, r.relation_type AS relation_type, r.status AS status,
              r.evidence AS evidence,
              ${OTHER_SELECT}
       FROM review_relations r
       ${OTHER_JOIN.replace("{other_join_col}", "r.target_fragment_id")}
       WHERE r.source_fragment_id = ?`;
  const incomingSql = `SELECT r.id AS id, r.relation_type AS relation_type, r.status AS status,
              r.evidence AS evidence,
              ${OTHER_SELECT}
       FROM review_relations r
       ${OTHER_JOIN.replace("{other_join_col}", "r.source_fragment_id")}
       WHERE r.target_fragment_id = ?`;
  const outgoing = store.db
    .prepare(outgoingSql)
    .all(fragmentId) as Record<string, unknown>[];
  const incoming = store.db
    .prepare(incomingSql)
    .all(fragmentId) as Record<string, unknown>[];
  const view = [
    ...outgoing.map((r) => rowToView(r, "outgoing")),
    ...incoming.map((r) => rowToView(r, "incoming")),
  ];
  if (includeStale) return view;
  // Default: drop dead links. Missing links (other === null) are kept — they are
  // an explicit unresolved seed, never a stale green reference.
  return view.filter(
    (v) => v.relationStatus !== "stale",
  );
}

export function listReviewRelations(
  store: Store,
  filter: { status?: string; type?: string },
): RelationView[] {
  ensureReviewRelationsTable(store);
  ensureReviewMetaTable(store);
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
           json_extract(srev.body,'$.context.category') AS other_category,
           (ss.head = srev.id) AS other_current,
           COALESCE(osm.removed, 0) AS other_removed
    FROM review_relations r
    LEFT JOIN fragments sf ON sf.id = r.target_fragment_id
    LEFT JOIN revisions srev ON srev.id = sf.revision_id
    LEFT JOIN sources ss ON ss.id = srev.source_id
    LEFT JOIN review_source_meta osm ON osm.source_id = ss.id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.created_at DESC LIMIT 500`;
  const rows = store.db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => rowToView(r, "outgoing"));
}

/** Options for the code-path trace view. Default (both false) only shows
 * relations anchored to the CURRENT head of the file and to live, non-removed
 * targets. `includeHistorical` also surfaces relations built against older
 * revisions; `includeStale` additionally keeps dead/stale links. */
export type CodePathRelationOptions = {
  includeHistorical?: boolean;
  includeStale?: boolean;
};

/** All relations on the trace chain for one code file: the code fragment's own
 * outgoing edges (implements → its intent fragment) PLUS every outgoing edge of
 * the reachable intent fragments (requires/decided_by/researched_by/tested_by →
 * the raw docs/tests). That yields the full intent→decision→research→test chain
 * without a second round-trip. */
export function relationsForCodePath(
  store: Store,
  filePath: string,
  options: CodePathRelationOptions = {},
): RelationView[] {
  ensureReviewRelationsTable(store);
  ensureReviewMetaTable(store);
  const includeHistorical = options.includeHistorical === true;
  const includeStale = options.includeStale === true;
  const where: string[] = ["json_extract(srev.body,'$.context.filePath') = ?"];
  if (!includeHistorical)
    where.push("ss.head = srev.id");
  if (!includeStale)
    where.push(
      `(r.status <> 'stale'
        AND (tf.id IS NULL
             OR (ts.head = trev.id AND COALESCE(tsm.removed, 0) = 0)))`,
    );
  const rows = store.db
    .prepare(
      `WITH code_frags AS (
         SELECT sf.id AS fid FROM fragments sf
         JOIN revisions srev ON srev.id = sf.revision_id
         JOIN sources ss ON ss.id = srev.source_id
         WHERE json_extract(srev.body,'$.context.filePath') = ?
           ${includeHistorical ? "" : "AND ss.head = srev.id"}
       ),
       intent_frags AS (
         SELECT r.target_fragment_id AS iid FROM review_relations r
         WHERE r.relation_type='implements'
           AND r.source_fragment_id IN (SELECT fid FROM code_frags)
           AND r.target_fragment_id <> ''
       )
       SELECT r.id AS id, r.relation_type AS relation_type, r.status AS status,
              r.evidence AS evidence,
              tf.id AS other_fragment_id, tf.text AS other_text,
              trev.id AS other_revision_id, trev.title AS other_title, trev.version AS other_version,
              ts.external_id AS other_external_id,
              json_extract(trev.body,'$.context.filePath') AS other_filepath,
              json_extract(trev.body,'$.context.category') AS other_category,
              (ts.head = trev.id) AS other_current,
              COALESCE(tsm.removed, 0) AS other_removed
       FROM review_relations r
       JOIN fragments sf ON sf.id = r.source_fragment_id
       JOIN revisions srev ON srev.id = sf.revision_id
       JOIN sources ss ON ss.id = srev.source_id
       LEFT JOIN fragments tf ON tf.id = r.target_fragment_id
       LEFT JOIN revisions trev ON trev.id = tf.revision_id
       LEFT JOIN sources ts ON ts.id = trev.source_id
       LEFT JOIN review_source_meta tsm ON tsm.source_id = ts.id
       WHERE (r.source_fragment_id IN (SELECT fid FROM code_frags)
              OR r.source_fragment_id IN (SELECT iid FROM intent_frags))
         ${includeStale ? "" : "AND r.status <> 'stale'"}
       ORDER BY r.relation_type, r.created_at`,
    )
    .all(filePath) as Record<string, unknown>[];
  return rows.map((r) => rowToView(r, "outgoing"));
}

/** Mark relations touching a source as stale (without deleting them) so that
 * links built against superseded fragments stop reading as live. Called by sync
 * before rebuild: a head bump, a seed removal, a deleted target or a replaced
 * head leaves old relation rows pointed at non-current fragments. We flip them to
 * status='stale'; the rebuild then re-upserts the still-live edges against the new
 * head fragments.
 *
 * A row becomes stale when EITHER side's fragment no longer lives:
 *  - the fragment belonging to THIS source is not its head revision (or the
 *    source has no head at all), OR
 *  - the other fragment is on a non-head revision or its source is removed.
 * Rows with an unresolved empty side (missing links) are left untouched. */
export function invalidateStaleRelations(
  store: Store,
  sourceExternalId: string,
): number {
  ensureReviewRelationsTable(store);
  ensureReviewMetaTable(store);
  const sourceId = sourceIdForExternalId(store, sourceExternalId);
  if (!sourceId) return 0;

  // Relations where this source's fragment is the forward side.
  const outgoing = store.db
    .prepare(
      `UPDATE review_relations
       SET status='stale'
       WHERE status <> 'stale'
       AND source_fragment_id IN (
         SELECT f.id FROM fragments f
         JOIN revisions rev ON rev.id = f.revision_id
         WHERE rev.source_id = ?
       )
       AND (
         NOT EXISTS (
           SELECT 1 FROM fragments f
           JOIN revisions rev ON rev.id = f.revision_id
           WHERE f.id = review_relations.source_fragment_id
             AND rev.source_id = ?
             AND rev.id = (SELECT head FROM sources WHERE id = ?)
         )
         OR (
           target_fragment_id <> ''
           AND NOT EXISTS (
             SELECT 1 FROM fragments of
             JOIN revisions orev ON orev.id = of.revision_id
             JOIN sources os ON os.id = orev.source_id
             LEFT JOIN review_source_meta osm ON osm.source_id = os.id
             WHERE of.id = review_relations.target_fragment_id
               AND os.head = orev.id
               AND COALESCE(osm.removed, 0) = 0
           )
         )
       )`,
    )
    .run(sourceId, sourceId, sourceId);

  // Relations where this source's fragment is the inverse (target) side.
  const incoming = store.db
    .prepare(
      `UPDATE review_relations
       SET status='stale'
       WHERE status <> 'stale'
       AND target_fragment_id IN (
         SELECT f.id FROM fragments f
         JOIN revisions rev ON rev.id = f.revision_id
         WHERE rev.source_id = ?
       )
       AND (
         NOT EXISTS (
           SELECT 1 FROM fragments f
           JOIN revisions rev ON rev.id = f.revision_id
           WHERE f.id = review_relations.target_fragment_id
             AND rev.source_id = ?
             AND rev.id = (SELECT head FROM sources WHERE id = ?)
         )
         OR (
           source_fragment_id <> ''
           AND NOT EXISTS (
             SELECT 1 FROM fragments of
             JOIN revisions orev ON orev.id = of.revision_id
             JOIN sources os ON os.id = orev.source_id
             LEFT JOIN review_source_meta osm ON osm.source_id = os.id
             WHERE of.id = review_relations.source_fragment_id
               AND os.head = orev.id
               AND COALESCE(osm.removed, 0) = 0
           )
         )
       )`,
    )
    .run(sourceId, sourceId, sourceId);

  return Number(outgoing.changes ?? 0) + Number(incoming.changes ?? 0);
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
