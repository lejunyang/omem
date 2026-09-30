import type { DatabaseSync } from "node:sqlite";
import { stableDigest } from "../storage/digest.js";
type Row = Record<string, unknown>;
export type SourceRefreshInputRef = { sourceId?: string; previousRevisionId?: string; revisionId?: string };

/** Freeze the invalidation set before reprocessing. Repeated delivery cannot
 * erase affected memories merely because some have already been repaired. */
export function recordSourceRefresh(db: DatabaseSync, workspaceId: string, inputRefs: SourceRefreshInputRef[]) {
  const ref = inputRefs.find(r => r.sourceId && r.revisionId);
  if (!ref?.sourceId || !ref.revisionId) throw Error("REFRESH_MISSING_SOURCE_REF");
  const id = `refresh-${stableDigest({ workspaceId, sourceId: ref.sourceId, revisionId: ref.revisionId })}`;
  let row = db.prepare("SELECT * FROM refresh_records WHERE id=?").get(id) as Row | undefined;
  if (!row) {
    const affected = db.prepare(`SELECT DISTINCT m.id FROM memories m
      JOIN memory_dependencies md ON md.memory_revision_id=m.head_revision_id
      WHERE md.source_id=? AND md.state='stale' AND m.status='invalidated'`).all(ref.sourceId) as Row[];
    const ids = affected.map(r => String(r.id));
    db.prepare(`INSERT INTO refresh_records(id,workspace_id,source_id,previous_revision_id,new_revision_id,
      affected_count,affected_memory_ids,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        id,workspaceId,ref.sourceId,ref.previousRevisionId ?? null,ref.revisionId,ids.length,JSON.stringify(ids),ids.length ? "needs_review" : "no_effect",new Date().toISOString());
    row = db.prepare("SELECT * FROM refresh_records WHERE id=?").get(id) as Row;
  }
  return { recordId: id, status: String(row.status), affectedCount: Number(row.affected_count),
    affectedMemoryIds: JSON.parse(String(row.affected_memory_ids)) as string[] };
}

/** The dispatcher succeeding means only 'queued'. Reconciliation is based on
 * current dependencies and real application state after independent verification. */
export function reconcileSourceRefresh(db: DatabaseSync, revisionId: string, detail: Record<string, unknown>) {
  const records = db.prepare("SELECT * FROM refresh_records WHERE new_revision_id=? AND affected_count>0").all(revisionId) as Row[];
  for (const row of records) {
    const ids = JSON.parse(String(row.affected_memory_ids)) as string[];
    const repaired = ids.filter(id => !!db.prepare(`SELECT 1 FROM memories m
      JOIN memory_dependencies md ON md.memory_revision_id=m.head_revision_id
      JOIN sources s ON s.id=md.source_id
      WHERE m.id=? AND m.status='active' AND md.source_revision_id=? AND md.state='current' AND s.head=md.source_revision_id`).get(id, revisionId));
    const stale = !db.prepare("SELECT 1 FROM sources WHERE id=? AND head=?").get(String(row.source_id), revisionId);
    db.prepare("UPDATE refresh_records SET status=?,result_json=? WHERE id=?").run(
      stale ? "superseded" : repaired.length === ids.length ? "applied" : "needs_review",
      JSON.stringify({ ...detail, repaired, unresolved: ids.filter(id => !repaired.includes(id)) }), String(row.id));
  }
}
