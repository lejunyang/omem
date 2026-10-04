import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contextInputSchema, contextIdsSchema, type ContextInput, type MaterialContext, type ContextResolution, type ContextAssignment } from "../../../../packages/contracts/src/contexts.js";

/** Persistent source membership, separate from article categories and citations.
 * Model filing decisions keep their origin and cannot replace manual choices. */
export class MaterialContexts {
  constructor(private readonly db: DatabaseSync) {
    const initializeAssignments = !db.prepare("SELECT 1 FROM sqlite_master WHERE name='material_context_assignments'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS material_contexts(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'personal',
      name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_context_sources(
      context_id TEXT NOT NULL REFERENCES material_contexts(id), source_id TEXT NOT NULL REFERENCES sources(id),
      linked_at TEXT NOT NULL, PRIMARY KEY(context_id,source_id));
      CREATE INDEX IF NOT EXISTS material_context_source_idx ON material_context_sources(source_id);
      CREATE TABLE IF NOT EXISTS material_context_assignments(
        source_id TEXT PRIMARY KEY REFERENCES sources(id), version INTEGER NOT NULL,
        revision_id TEXT, status TEXT NOT NULL, details TEXT NOT NULL, updated_at TEXT NOT NULL);`);
    if (initializeAssignments) db.exec(`INSERT OR IGNORE INTO material_context_assignments
      SELECT DISTINCT source_id,1,NULL,'manual','{}',linked_at FROM material_context_sources`);
  }
  list(): MaterialContext[] {
    return this.db.prepare(`SELECT c.id,c.name,c.kind,c.description,count(s.source_id) AS sourceCount
      FROM material_contexts c LEFT JOIN material_context_sources s ON s.context_id=c.id
      WHERE c.workspace_id='personal' GROUP BY c.id ORDER BY c.created_at,c.id`).all() as MaterialContext[];
  }
  create(input: ContextInput) {
    const value = contextInputSchema.parse(input), id = randomUUID();
    this.db.prepare("INSERT INTO material_contexts VALUES(?,'personal',?,?,?,?)")
      .run(id, value.name, value.kind, value.description, new Date().toISOString());
    return this.list().find(c => c.id === id)!;
  }
  validate(ids: string[]) {
    const wanted = new Set(contextIdsSchema.parse(ids)), known = new Set(this.list().map(c => c.id));
    for (const id of wanted) if (!known.has(id)) throw Error("所选项目或主题已不可用，请重新选择");
    return [...wanted];
  }
  forSource(sourceId: string): string[] {
    return this.db.prepare("SELECT context_id FROM material_context_sources WHERE source_id=? ORDER BY context_id")
      .all(sourceId).map(r => String(r.context_id));
  }
  /** The caller owns the transaction, including capture when supplied there. */
  setForSource(sourceId: string, ids: string[]) {
    const selected = this.validate(ids);
    if (!this.db.prepare("SELECT 1 FROM sources WHERE id=?").get(sourceId)) throw Error("原始材料不存在");
    this.replaceMembership(sourceId, selected);
    this.recordAssignment(sourceId, null, "manual", { reason: "用户指定的归属", question: null, candidateIds: [] });
    return selected;
  }
  private replaceMembership(sourceId: string, selected: string[]) {
    this.db.prepare("DELETE FROM material_context_sources WHERE source_id=?").run(sourceId);
    for (const id of selected) this.db.prepare("INSERT INTO material_context_sources VALUES(?,?,?)")
      .run(id, sourceId, new Date().toISOString());
  }
  assignment(sourceId: string): ContextAssignment | null {
    const row = this.db.prepare("SELECT * FROM material_context_assignments WHERE source_id=?").get(sourceId);
    if (!row) return null;
    const details = JSON.parse(String(row.details));
    return { version: Number(row.version), revisionId: row.revision_id ? String(row.revision_id) : null,
      status: row.status as ContextAssignment["status"], reason: details.reason ?? "用户指定的归属",
      question: details.question ?? null, candidateIds: details.candidateIds ?? [] };
  }
  private recordAssignment(sourceId: string, revisionId: string | null, status: ContextAssignment["status"], details: Record<string, unknown>) {
    this.db.prepare(`INSERT INTO material_context_assignments VALUES(?,1,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET version=version+1,revision_id=excluded.revision_id,
      status=excluded.status,details=excluded.details,updated_at=excluded.updated_at`)
      .run(sourceId, revisionId, status, JSON.stringify(details), new Date().toISOString());
  }
  /** Caller owns the transaction; compare against the human choice at research start. */
  saveResolution(sourceId: string, revisionId: string, expectedVersion: number,
    proposal: ContextResolution, review: ContextResolution | null, outputIds: string[]) {
    const current = this.assignment(sourceId);
    const source = this.db.prepare("SELECT head FROM sources WHERE id=?").get(sourceId);
    if (source?.head !== revisionId || (current?.version ?? 0) !== expectedVersion || current?.status === "manual")
      throw Error("STALE_JOB_INPUT: material or project choice changed during investigation");
    for (const result of [proposal, review].filter((r): r is ContextResolution => !!r)) {
      this.validate([...result.contextIds, ...result.candidateIds]);
      if ((result.status === "matched") !== (result.contextIds.length > 0)) throw Error("ROLE_OUTPUT_CONTEXT_MATCH");
    }
    const agreed = proposal.status === "matched" && review?.status === "matched" &&
      JSON.stringify([...new Set(proposal.contextIds)].sort()) === JSON.stringify([...new Set(review.contextIds)].sort());
    const status = agreed ? "automatic" : proposal.status === "unrelated" ? "unrelated" : "ambiguous";
    const final = review ?? proposal;
    const candidateIds = status === "ambiguous"
      ? [...new Set([...proposal.contextIds, ...proposal.candidateIds, ...(review?.contextIds ?? []), ...(review?.candidateIds ?? [])])] : [];
    if (agreed) this.replaceMembership(sourceId, this.validate(proposal.contextIds));
    this.recordAssignment(sourceId, revisionId, status, { proposal, review, outputIds,
      reason: final.reason, question: status === "ambiguous" ? final.question ?? "这份材料属于哪个项目或主题？" : null, candidateIds });
    return this.assignment(sourceId)!;
  }
  needsInvestigation(sourceId: string, revisionId: string) {
    const assignment = this.assignment(sourceId);
    return !this.forSource(sourceId).length && assignment?.status !== "manual" && assignment?.revisionId !== revisionId;
  }
  sourceIds(ids: string[]) {
    const selected = this.validate(ids), result = new Set<string>();
    for (const id of selected) for (const r of this.db.prepare("SELECT source_id FROM material_context_sources WHERE context_id=?").all(id)) result.add(String(r.source_id));
    return result;
  }
}
