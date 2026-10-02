/** A research snapshot contains offered evidence and permitted state, never
 * credentials, conversations, outboxes or unrelated personal captures. */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import type { KnowledgeArticle, KnowledgeRepository } from "./repository.js";
import { migrateDatabase } from "../storage/migrations.js";
import { RetrievalProjection } from "../retrieval/units.js";
import { materialFromRevision } from "./repository.js";

type Row = Record<string, SQLInputValue>;
export function researchSnapshot(input: {
  repository: KnowledgeRepository;
  materials: KnowledgeMaterial[];
  articles: KnowledgeArticle[];
  file: string;
  visible?: (fragmentId: string) => boolean;
  includeUnanchoredState?: boolean;
}) {
  const original = input.repository.store.db;
  const db = new DatabaseSync(input.file);
  try {
    migrateDatabase(db);
    db.exec("PRAGMA foreign_keys=OFF; BEGIN");
    const exists = (name: string) =>
      !!original
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    const schema = (name: string) => {
      if (!exists(name)) return false;
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name)) {
        const row = original
          .prepare("SELECT sql FROM sqlite_master WHERE name=?")
          .get(name)!;
        db.exec(String(row.sql));
      }
      return true;
    };
    const copy = (name: string, rows: Row[]) => {
      if (!schema(name) || !rows.length) return;
      const columns = Object.keys(rows[0]!);
      const sql = db.prepare(
        `INSERT OR REPLACE INTO "${name}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      );
      for (const row of rows) sql.run(...columns.map((c) => row[c]!));
    };
    const all = (name: string) =>
      exists(name)
        ? (original.prepare(`SELECT * FROM "${name}"`).all() as Row[])
        : [];
    const sourceIds = new Set(input.materials.map((m) => m.sourceId));
    const revisionIds = new Set<string>(),
      fragmentIds = new Set<string>();
    const visible = input.visible ?? (() => true);
    const revisions = all("revisions").filter((r) => {
      if (!sourceIds.has(String(r.source_id))) return false;
      const fragments = original
        .prepare("SELECT id FROM fragments WHERE revision_id=?")
        .all(r.id!);
      if (!fragments.every((f) => visible(String(f.id)))) return false;
      if (!fragments.length && !input.includeUnanchoredState) return false;
      revisionIds.add(String(r.id));
      fragments.forEach((f) => fragmentIds.add(String(f.id)));
      return true;
    });
    copy(
      "sources",
      all("sources").filter((r) => sourceIds.has(String(r.id))),
    );
    copy("revisions", revisions);
    copy(
      "fragments",
      all("fragments").filter((r) => fragmentIds.has(String(r.id))),
    );
    copy(
      "source_state",
      all("source_state").filter((r) => sourceIds.has(String(r.source_id))),
    );
    copy(
      "knowledge_material_aliases",
      all("knowledge_material_aliases").filter((r) =>
        sourceIds.has(String(r.source_id)),
      ),
    );
    copy(
      "review_relations",
      all("review_relations").filter(
        (r) =>
          fragmentIds.has(String(r.source_fragment_id)) &&
          fragmentIds.has(String(r.target_fragment_id)),
      ),
    );
    const knowledge = new Map<string, Row>();
    const materialKeys = new Map(
      input.materials.map((m) => [m.sourceId, m.key]),
    );
    const permittedMaterialVersions = new Set(
      revisions.flatMap((r) => {
        const material = materialFromRevision(
          input.repository.store,
          String(r.id),
        );
        return material
          ? [`${materialKeys.get(material.sourceId)}\n${material.digest}`]
          : [];
      }),
    );
    const checked = new Map<string, boolean>();
    const visit = (revision: string): boolean => {
      if (checked.has(revision)) return checked.get(revision)!;
      if (!exists("knowledge_revisions")) return false;
      const row = original
        .prepare("SELECT * FROM knowledge_revisions WHERE id=?")
        .get(revision) as Row | undefined;
      if (!row) return false;
      checked.set(revision, false);
      const dependencies = JSON.parse(String(row.artifact)).dependencies as {
        kind: string;
        key: string;
        digest: string;
      }[];
      if (
        !dependencies.every((d) =>
          d.kind === "material"
            ? permittedMaterialVersions.has(`${d.key}\n${d.digest}`)
            : visit(d.digest),
        )
      )
        return false;
      checked.set(revision, true);
      knowledge.set(revision, row);
      return true;
    };
    input.articles.forEach((a) => visit(a.revision));
    copy("knowledge_revisions", [...knowledge.values()]);
    copy(
      "knowledge_heads",
      all("knowledge_heads").filter((r) =>
        knowledge.has(String(r.revision_id)),
      ),
    );
    copy(
      "knowledge_invalidations",
      all("knowledge_invalidations").filter((r) =>
        input.articles.some((a) => a.document.key === r.document_key),
      ),
    );
    const allowedEvidence = (raw: SQLInputValue) => {
      const refs = JSON.parse(String(raw)) as {
        fragment_revision_id?: string;
        source_revision_id?: string;
      }[];
      return refs.length
        ? refs.every((r) =>
            r.fragment_revision_id
              ? fragmentIds.has(r.fragment_revision_id)
              : !!r.source_revision_id && revisionIds.has(r.source_revision_id),
          )
        : !!input.includeUnanchoredState;
    };
    const memoryIds = new Set<string>();
    const memoryRevisions = all("memory_revisions").filter((r) =>
      allowedEvidence(r.evidence_set!),
    );
    const memoryRevisionIds = new Set(memoryRevisions.map((r) => String(r.id)));
    const memories = all("memories").filter((r) =>
      memoryRevisionIds.has(String(r.head_revision_id)),
    );
    memories.forEach((r) => memoryIds.add(String(r.id)));
    copy("memories", memories);
    copy(
      "memory_revisions",
      memoryRevisions.filter((r) => memoryIds.has(String(r.memory_id))),
    );
    const tasks = all("tasks").filter((r) =>
      r.evidence_id
        ? fragmentIds.has(String(r.evidence_id))
        : !!input.includeUnanchoredState,
    );
    const taskIds = new Set(tasks.map((r) => String(r.id)));
    copy("tasks", tasks);
    copy(
      "task_revisions",
      all("task_revisions").filter(
        (r) =>
          taskIds.has(String(r.task_id)) && allowedEvidence(r.evidence_set!),
      ),
    );
    db.exec("COMMIT; PRAGMA foreign_keys=ON");
    new RetrievalProjection(db).sync();
    // Reuse only vectors whose immutable unit IDs are actually in this scope.
    const unitIds = new Set(
      db
        .prepare("SELECT id FROM retrieval_units")
        .all()
        .map((r) => String(r.id)),
    );
    for (const name of [
      "retrieval_unit_vectors",
      "retrieval_unit_vector_heads",
    ])
      copy(
        name,
        all(name).filter((r) => unitIds.has(String(r.unit_id))),
      );
  } catch (error) {
    db.close();
    throw error;
  }
  // A sealed snapshot has no writers. Avoid read-only WAL sidecar creation
  // when its first SQL read happens later inside an Agent tool request.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
  db.close();
  return new DatabaseSync(input.file, { readOnly: true });
}
