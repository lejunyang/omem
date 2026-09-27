import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;

export type SourceRefreshInputRef = {
  sourceId?: string;
  previousRevisionId?: string;
  revisionId?: string;
};

/**
 * refresh_dependents does NOT re-verify the invalidated memories yet. It only
 * records the real blast radius so the auditable refresh_records row exists. The
 * caller (pipeline handler) MUST treat this as blocked / not_implemented and never
 * report the job as reviewed or succeeded.
 */
export type SourceRefreshResult = {
  status: "blocked";
  reason: "not_implemented";
  affectedCount: number;
  affectedMemoryIds: string[];
};

/**
 * F8: record the real blast radius of a source revision update. The deterministic
 * invalidation already happened in store.capture (dependencies -> stale, memories
 * -> invalidated, and KeywordRetrieval only recalls active rows). This writes an
 * auditable refresh_records row, but it does NOT re-verify or "review" anything:
 * that step is not implemented. Callers must surface the blocked/not_implemented
 * status instead of counting affected memories as reviewed.
 */
export function recordSourceRefresh(
  db: DatabaseSync,
  workspaceId: string,
  inputRefs: SourceRefreshInputRef[],
): SourceRefreshResult {
  const ref = inputRefs[0];
  if (!ref || typeof ref.sourceId !== "string" || typeof ref.revisionId !== "string")
    throw new Error("REFRESH_MISSING_SOURCE_REF");
  const sourceId: string = ref.sourceId;
  const newRevisionId: string = ref.revisionId;
  const previousRevisionId: string | null =
    typeof ref.previousRevisionId === "string" ? ref.previousRevisionId : null;
  const affected = db
    .prepare(
      `SELECT DISTINCT m.id FROM memories m
       JOIN memory_dependencies md ON md.memory_revision_id = m.head_revision_id
       WHERE md.source_id = ?`,
    )
    .all(sourceId) as Row[];
  const affectedMemoryIds = affected.map((row) => String(row.id));
  // Record the invalidation honestly. There is no verified re-review here:
  // affected memories need review; an empty blast radius is simply no_effect.
  const recordStatus = affectedMemoryIds.length
    ? "needs_review"
    : "no_effect";
  db.prepare(
    `INSERT INTO refresh_records(
       id,workspace_id,source_id,previous_revision_id,new_revision_id,
       affected_count,affected_memory_ids,status,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(),
    workspaceId,
    sourceId,
    previousRevisionId,
    newRevisionId,
    affectedMemoryIds.length,
    JSON.stringify(affectedMemoryIds),
    recordStatus,
    new Date().toISOString(),
  );
  // The job itself stays blocked: we have not re-verified anything.
  return {
    status: "blocked",
    reason: "not_implemented",
    affectedCount: affectedMemoryIds.length,
    affectedMemoryIds,
  };
}
