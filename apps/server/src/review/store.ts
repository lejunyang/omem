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
