import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { contextInputSchema, contextIdsSchema, type ContextInput, type MaterialContext } from "../../../../packages/contracts/src/contexts.js";

/** Explicit source membership, independent of article categories and citations.
 * No project is inferred from a filename, a conversation id, or material text. */
export class MaterialContexts {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS material_contexts(
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'personal',
      name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_context_sources(
      context_id TEXT NOT NULL REFERENCES material_contexts(id), source_id TEXT NOT NULL REFERENCES sources(id),
      linked_at TEXT NOT NULL, PRIMARY KEY(context_id,source_id));
      CREATE INDEX IF NOT EXISTS material_context_source_idx ON material_context_sources(source_id);`);
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
    this.db.prepare("DELETE FROM material_context_sources WHERE source_id=?").run(sourceId);
    for (const id of selected) this.db.prepare("INSERT INTO material_context_sources VALUES(?,?,?)")
      .run(id, sourceId, new Date().toISOString());
    return selected;
  }
  sourceIds(ids: string[]) {
    const selected = this.validate(ids), result = new Set<string>();
    for (const id of selected) for (const r of this.db.prepare("SELECT source_id FROM material_context_sources WHERE context_id=?").all(id)) result.add(String(r.source_id));
    return result;
  }
}
