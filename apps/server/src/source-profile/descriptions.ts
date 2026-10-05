import type { DatabaseSync } from "node:sqlite";
import {
  materialDescriptionSchema,
  type MaterialDescriptionRecord,
} from "../../../../packages/contracts/src/material-description.js";

/** Versioned annotations are tied to a fixed revision. A new source version must
 * be described again; user corrections never get overwritten by an old job. */
export class MaterialDescriptions {
  constructor(readonly db: DatabaseSync) {}
  get(revisionId: string): MaterialDescriptionRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM material_descriptions WHERE revision_id=? ORDER BY version DESC LIMIT 1",
      )
      .get(revisionId);
    return row
      ? {
          revisionId,
          version: Number(row.version),
          author: String(row.author) as "model" | "user",
          description: JSON.parse(String(row.description)),
          updatedAt: String(row.created_at),
        }
      : null;
  }
  previous(revisionId: string): MaterialDescriptionRecord | null {
    const row = this.db.prepare(`SELECT older.id FROM revisions current
      JOIN revisions older ON older.source_id=current.source_id AND older.version<current.version
      WHERE current.id=? AND EXISTS(SELECT 1 FROM material_descriptions d WHERE d.revision_id=older.id)
      ORDER BY older.version DESC LIMIT 1`).get(revisionId);
    return row ? this.get(String(row.id)) : null;
  }
  save(
    revisionId: string,
    value: unknown,
    author: "model" | "user",
    expectedVersion: number,
    trace: unknown = null,
  ): MaterialDescriptionRecord {
    const description = materialDescriptionSchema.parse(value);
    const revision = this.db
      .prepare("SELECT body FROM revisions WHERE id=?")
      .get(revisionId);
    if (!revision) throw Error("材料版本不存在");
    const body = JSON.parse(String(revision.body));
    const text = body.parts
      .filter((p: { type: string }) => p.type === "text" || p.type === "link")
      .map(
        (p: { type: string; text?: string; label?: string; url?: string }) =>
          p.type === "text" ? (p.text ?? "") : `${p.label ?? ""}\n${p.url}`,
      )
      .join(body.context?.captureFormat === "verbatim-v1" ? "" : "\n\n");
    const lines = text.split("\n").length;
    if (
      description.concepts.some(
        (c) => c.endLine < c.startLine || c.endLine > lines,
      )
    )
      throw Error("概念对应的原文行范围无效");
    if (
      description.validFrom &&
      description.validUntil &&
      Date.parse(description.validFrom) >= Date.parse(description.validUntil)
    )
      throw Error("适用时间结束必须晚于开始");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.get(revisionId);
      if ((previous?.version ?? 0) !== expectedVersion)
        throw Error("材料说明已被更新，请重新读取后修改");
      if (author === "model" && previous?.author === "user")
        throw Error("保留用户修正，请在页面明确重新分析");
      const version = expectedVersion + 1,
        updatedAt = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO material_descriptions(revision_id,version,author,description,trace,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          revisionId,
          version,
          author,
          JSON.stringify(description),
          JSON.stringify(trace),
          updatedAt,
        );
      this.db.exec("COMMIT");
      return { revisionId, version, author, description, updatedAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
