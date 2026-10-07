import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import { stableDigest } from "./digest.js";
import { coldDirectory } from "./cold.js";

export type SourceRetentionPolicy = "latest" | "event";
const removedReason = "此可变材料只保留最新原件，引用所指的旧原件已移除。";
const now = () => new Date().toISOString();
const table = (store: Store, name: string) =>
  !!store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);

function defaultPolicy(
  source: string,
  body: Record<string, any>,
): SourceRetentionPolicy {
  if (source === "file" || source === "git") return "latest";
  if (source !== "lark") return "event";
  if (body.context?.document) return "latest";
  if (
    body.context?.chat ||
    body.context?.conversationId ||
    body.context?.aggregation ||
    body.provenance?.eventId
  )
    return "event";
  return "latest";
}
function assetIds(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    found.add(value);
  else if (Array.isArray(value)) value.forEach((item) => assetIds(item, found));
  else if (value && typeof value === "object")
    Object.values(value).forEach((item) => assetIds(item, found));
  return found;
}

/** Raw bodies and fragments are removed; small identity tombstones keep old
 * references honest. Chat/feedback records remain chronological event inputs. */
export class MaterialRetention {
  constructor(readonly store: Store) {}
  policy(sourceId: string) {
    const current = this.store.db
      .prepare(
        "SELECT policy,reason,updated_at FROM source_retention WHERE source_id=?",
      )
      .get(sourceId);
    if (current)
      return {
        policy: String(current.policy) as SourceRetentionPolicy,
        reason: String(current.reason),
        updatedAt: String(current.updated_at),
      };
    const source = this.store.db
      .prepare(
        "SELECT s.namespace,r.body FROM sources s LEFT JOIN revisions r ON r.id=s.head WHERE s.id=?",
      )
      .get(sourceId);
    if (!source) throw Error("原始材料不存在");
    const policy = defaultPolicy(
      String(source.namespace),
      source.body ? JSON.parse(String(source.body)) : {},
    );
    return this.setPolicy(sourceId, policy, "按输入类型建立的正式保留策略");
  }
  setPolicy(
    sourceId: string,
    policy: SourceRetentionPolicy,
    reason = "用户调整原件保留方式",
  ) {
    if (!["latest", "event"].includes(policy))
      throw Error("原件保留策略应为 latest 或 event");
    const at = now();
    this.store.db
      .prepare(
        `INSERT INTO source_retention VALUES(?,?,?,?) ON CONFLICT(source_id)
      DO UPDATE SET policy=excluded.policy,reason=excluded.reason,updated_at=excluded.updated_at`,
      )
      .run(sourceId, policy, reason, at);
    return { policy, reason, updatedAt: at };
  }
  register(sourceId: string, input: CaptureInput) {
    if (
      !this.store.db
        .prepare("SELECT 1 FROM source_retention WHERE source_id=?")
        .get(sourceId)
    )
      this.setPolicy(
        sourceId,
        defaultPolicy(input.source, input),
        "按输入类型建立的正式保留策略",
      );
  }
  revisionAvailability(revisionId: string) {
    const row = this.store.db
      .prepare(
        `SELECT r.id,r.source_id,r.title,r.version,r.created_at,t.removed_at,t.reason,t.replacement_revision_id
      FROM revisions r LEFT JOIN revision_tombstones t ON t.revision_id=r.id WHERE r.id=?`,
      )
      .get(revisionId);
    return row
      ? {
          revisionId,
          sourceId: String(row.source_id),
          title: String(row.title),
          version: Number(row.version),
          createdAt: String(row.created_at),
          available: !row.removed_at,
          removedAt: row.removed_at ? String(row.removed_at) : null,
          reason: row.reason ? String(row.reason) : null,
          replacementRevisionId: row.replacement_revision_id
            ? String(row.replacement_revision_id)
            : null,
        }
      : null;
  }
  fragmentAvailability(fragmentId: string) {
    const row = this.store.db
      .prepare("SELECT revision_id FROM fragments WHERE id=?")
      .get(fragmentId);
    return row ? this.revisionAvailability(String(row.revision_id)) : null;
  }
  private indexRevision(revisionId: string, body?: unknown) {
    const value =
      body ??
      JSON.parse(
        String(
          this.store.db
            .prepare("SELECT body FROM revisions WHERE id=?")
            .get(revisionId)!.body,
        ),
      );
    this.store.db
      .prepare("DELETE FROM revision_asset_refs WHERE revision_id=?")
      .run(revisionId);
    for (const assetId of assetIds(value))
      this.store.db
        .prepare("INSERT OR IGNORE INTO revision_asset_refs VALUES(?,?)")
        .run(revisionId, assetId);
  }
  compactSource(sourceId: string) {
    const head = this.store.db
      .prepare("SELECT head FROM sources WHERE id=?")
      .get(sourceId)?.head;
    if (head) this.indexRevision(String(head));
    if (this.policy(sourceId).policy !== "latest")
      return {
        sourceId,
        removedRevisions: [] as string[],
        assets: { removed: [] as string[], deferred: false },
      };
    const source = this.store.db
      .prepare("SELECT head FROM sources WHERE id=?")
      .get(sourceId)!;
    const ids = this.store.db
      .prepare(
        `SELECT id FROM revisions WHERE source_id=? AND id<>COALESCE(?,'')
      AND id NOT IN (SELECT revision_id FROM revision_tombstones)`,
      )
      .all(sourceId, source.head ?? null)
      .map((row) => String(row.id));
    this.store.tx(() =>
      this.removeRaw(
        ids,
        removedReason,
        source.head ? String(source.head) : null,
      ),
    );
    return {
      sourceId,
      removedRevisions: ids,
      assets: ids.length
        ? this.sweepAssets()
        : { removed: [] as string[], deferred: false },
    };
  }
  compactAllMutable() {
    const result = { sources: 0, revisions: 0, assets: 0 };
    this.store.tx(() => {
      if (
        !this.store.db
          .prepare("SELECT 1 FROM retention_state WHERE key='assets-indexed'")
          .get()
      ) {
        for (const row of this.store.db
          .prepare(
            "SELECT id,body FROM revisions WHERE id NOT IN (SELECT revision_id FROM revision_tombstones)",
          )
          .all())
          this.indexRevision(String(row.id), JSON.parse(String(row.body)));
        this.store.db
          .prepare("INSERT INTO retention_state VALUES('assets-indexed','1')")
          .run();
      }

      for (const row of this.store.db
        .prepare("SELECT id,head FROM sources")
        .all()) {
        const sourceId = String(row.id);
        if (this.policy(sourceId).policy !== "latest") continue;
        const ids = this.store.db
          .prepare(
            `SELECT id FROM revisions WHERE source_id=? AND id<>COALESCE(?,'')
          AND id NOT IN (SELECT revision_id FROM revision_tombstones)`,
          )
          .all(sourceId, row.head ?? null)
          .map((r) => String(r.id));
        if (ids.length) result.sources++;
        result.revisions += ids.length;
        this.removeRaw(ids, removedReason, row.head ? String(row.head) : null);
      }
    });
    if (
      result.revisions ||
      this.store.db
        .prepare("SELECT 1 FROM retention_asset_candidates LIMIT 1")
        .get()
    )
      result.assets = this.sweepAssets().removed.length;
    return result;
  }
  private removeRaw(ids: string[], reason: string, replacement: string | null) {
    const invalidationRefs: string[] = [...ids];
    for (const revisionId of ids) {
      const revision = this.store.db
        .prepare("SELECT * FROM revisions WHERE id=?")
        .get(revisionId)!;
      const body = JSON.parse(String(revision.body));
      const text =
        body.parts
          ?.filter((part: any) => part.type === "text" || part.type === "link")
          .map((part: any) =>
            part.type === "text" ? part.text : `${part.label}\n${part.url}`,
          )
          .join(body.context?.captureFormat === "verbatim-v1" ? "" : "\n\n") ??
        "";
      const images =
        body.parts
          ?.filter((part: any) => part.type === "image")
          .map((part: any) => ({
            assetId: part.assetId,
            mimeType: part.mimeType,
            label: part.label ?? revision.title,
          })) ?? [];
      const materialDigest = stableDigest({
        text,
        images,
        actor: body.provenance?.actorId ?? null,
        quoted: body.provenance?.quoted ?? false,
        forwarded: body.provenance?.forwarded ?? false,
      });
      invalidationRefs.push(materialDigest);
      for (const assetId of assetIds(body))
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO retention_asset_candidates VALUES(?,?)",
          )
          .run(assetId, now());
      this.store.db
        .prepare(
          "INSERT OR IGNORE INTO revision_tombstones VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          revisionId,
          String(revision.source_id),
          Number(revision.version),
          String(revision.title),
          String(revision.fingerprint),
          materialDigest,
          now(),
          reason,
          replacement,
        );
      this.store.db
        .prepare("DELETE FROM revision_asset_refs WHERE revision_id=?")
        .run(revisionId);
      this.clearProjection("source:" + revision.source_id);
      this.store.db
        .prepare("DELETE FROM retrieval_contexts WHERE revision_id=?")
        .run(revisionId);
      this.store.db
        .prepare("DELETE FROM source_profiles WHERE source_revision_id=?")
        .run(revisionId);
      this.store.db
        .prepare("DELETE FROM material_descriptions WHERE revision_id=?")
        .run(revisionId);
      this.store.db
        .prepare(
          "DELETE FROM fragment_embeddings WHERE fragment_id IN (SELECT id FROM fragments WHERE revision_id=?)",
        )
        .run(revisionId);
      this.store.db
        .prepare(
          "DELETE FROM fragment_embedding_heads WHERE fragment_id IN (SELECT id FROM fragments WHERE revision_id=?)",
        )
        .run(revisionId);
      this.store.db
        .prepare("UPDATE fragments SET text='' WHERE revision_id=?")
        .run(revisionId);
      this.store.db
        .prepare(
          "DELETE FROM fragment_search WHERE rowid IN (SELECT rowid FROM fragments WHERE revision_id=?)",
        )
        .run(revisionId);
      this.store.db.prepare("UPDATE revisions SET body=? WHERE id=?").run(
        JSON.stringify({
          parts: [],
          unavailable: { reason, removedAt: now() },
        }),
        revisionId,
      );
      if (table(this.store, "code_snapshot_files"))
        this.store.db
          .prepare(
            "UPDATE code_snapshot_files SET content_text=NULL WHERE review_revision_id=?",
          )
          .run(revisionId);
      if (table(this.store, "code_symbols"))
        this.store.db
          .prepare(
            "UPDATE code_symbols SET signature=NULL WHERE fragment_id IN (SELECT id FROM fragments WHERE revision_id=?)",
          )
          .run(revisionId);
      if (table(this.store, "review_relations"))
        this.store.db
          .prepare(
            "UPDATE review_relations SET status='missing' WHERE source_revision_id=? OR target_revision_id=?",
          )
          .run(revisionId, revisionId);
    }
    if (ids.length) this.store.jobs.invalidateInputs(invalidationRefs, reason);
  }
  clearProjection(owner: string) {
    this.store.db
      .prepare(
        "DELETE FROM retrieval_units_fts WHERE id IN (SELECT id FROM retrieval_units WHERE owner=?)",
      )
      .run(owner);
    this.store.db
      .prepare("DELETE FROM retrieval_units WHERE owner=?")
      .run(owner);
    this.store.db
      .prepare("DELETE FROM retrieval_contexts WHERE owner=?")
      .run(owner);
    this.store.db
      .prepare("DELETE FROM retrieval_projection_heads WHERE owner=?")
      .run(owner);
  }
  clearDerived(
    sourceId: string,
    selection: {
      descriptions?: boolean;
      articles?: boolean;
      learning?: boolean;
    } = {},
  ) {
    return this.store.tx(() => {
      const source = this.store.db
        .prepare("SELECT namespace,external_id,head FROM sources WHERE id=?")
        .get(sourceId);
      if (!source) throw Error("原始材料不存在");
      const revisions = this.store.db
        .prepare("SELECT id FROM revisions WHERE source_id=?")
        .all(sourceId)
        .map((row) => String(row.id));
      const key = `${source.namespace}:${source.external_id}`;
      const aliases = table(this.store, "knowledge_material_aliases")
        ? this.store.db
            .prepare(
              "SELECT material_key FROM knowledge_material_aliases WHERE source_id=?",
            )
            .all(sourceId)
            .map((row) => String(row.material_key))
        : [];
      const refs = [sourceId, key, ...aliases, ...revisions];
      const kinds =
        selection.learning && !selection.descriptions && !selection.articles
          ? ["extract_claims", "verify_proposals", "refresh_dependents"]
          : selection.descriptions && !selection.learning && !selection.articles
            ? ["material:maintain-description", "knowledge:material-cataloger"]
            : undefined;
      const jobs = this.store.jobs.invalidateInputs(
        refs,
        "材料重新处理，旧结果已清除",
        kinds,
      );
      const cleared = {
        descriptions: 0,
        articles: [] as string[],
        memories: [] as string[],
        tasks: [] as string[],
      };
      const preserved = {
        descriptions: 0,
        memories: [] as string[],
        tasks: [] as string[],
      };
      if (selection.descriptions) {
        for (const revisionId of revisions)
          this.store.db
            .prepare(
              "INSERT INTO description_clear_epochs VALUES(?,?) ON CONFLICT(revision_id) DO UPDATE SET removed_at=excluded.removed_at",
            )
            .run(revisionId, now());
        preserved.descriptions = Number(
          this.store.db
            .prepare(
              "SELECT count(*) n FROM material_descriptions WHERE author='user' AND revision_id IN (SELECT id FROM revisions WHERE source_id=?)",
            )
            .get(sourceId)!.n,
        );
        cleared.descriptions = Number(
          this.store.db
            .prepare(
              "DELETE FROM material_descriptions WHERE author='model' AND revision_id IN (SELECT id FROM revisions WHERE source_id=?)",
            )
            .run(sourceId).changes,
        );
      }
      if (selection.learning) {
        this.store.db
          .prepare(
            "UPDATE source_state SET validity_epoch=validity_epoch+1,updated_at=? WHERE source_id=?",
          )
          .run(now(), sourceId);
        this.clearLearning(sourceId, cleared, preserved);
      }
      if (selection.articles && table(this.store, "knowledge_revisions")) {
        const keys = new Set([key, ...aliases]);
        for (const row of this.store.db
          .prepare("SELECT document_key,artifact FROM knowledge_revisions")
          .all()) {
          const artifact = JSON.parse(String(row.artifact));
          if (
            artifact.dependencies?.some(
              (dependency: any) =>
                dependency.kind === "material" && keys.has(dependency.key),
            )
          )
            cleared.articles.push(String(row.document_key));
        }
        cleared.articles = [...new Set(cleared.articles)];
        for (const articleKey of cleared.articles)
          jobs.push(...this.clearArticle(articleKey).jobs);
      }
      return { sourceId, jobs: [...new Set(jobs)], cleared, preserved };
    });
  }
  private modelOwned(kind: "memory" | "task", id: string, version: number) {
    const receipt = this.store.db
      .prepare(
        "SELECT application_id FROM application_receipts WHERE entity_type=? AND entity_id=? AND entity_version=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(kind, id, version);
    if (!String(receipt?.application_id ?? "").startsWith("proposal:"))
      return false;
    if (
      kind === "task" &&
      table(this.store, "requirement_tasks") &&
      this.store.db
        .prepare("SELECT 1 FROM requirement_tasks WHERE task_id=?")
        .get(id)
    )
      return false;
    return !this.store.db
      .prepare(
        "SELECT 1 FROM feedback_constraints WHERE subject_id=? AND active=1",
      )
      .get(id);
  }
  private clearLearning(
    sourceId: string,
    cleared: { memories: string[]; tasks: string[] },
    preserved: { memories: string[]; tasks: string[] },
  ) {
    // Keep proposal identity, decisions and reviewer verdicts as a small audit.
    // Removed learning prose cannot remain hidden in model proposals/reviews.
    for (const row of this.store.db
      .prepare(
        `SELECT DISTINCT p.id,p.digest,p.evidence FROM proposals p JOIN proposal_source_reads r ON r.proposal_id=p.id WHERE r.source_id=?`,
      )
      .all(sourceId)) {
      const evidence = JSON.parse(String(row.evidence)).map(
        (item: Record<string, unknown>) => {
          const { exact_quote: _quote, ...locator } = item;
          return locator;
        },
      );
      const reason = "材料重新处理，旧学习内容已清除。";
      this.store.db
        .prepare(
          "UPDATE proposals SET body=?,evidence=?,reason=?,state='stale',updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify({ removed: true, title: "已清除的旧学习建议" }),
          JSON.stringify(evidence),
          reason,
          now(),
          String(row.id),
        );
      this.store.db
        .prepare(
          "UPDATE evidence_assessments SET details=? WHERE proposal_digest=?",
        )
        .run(reason, String(row.digest));
      this.store.db
        .prepare(
          "UPDATE decisions SET state='stale' WHERE proposal_digest=? AND state IN ('pending','context_requested')",
        )
        .run(String(row.digest));
    }
    for (const row of this.store.db
      .prepare(
        `SELECT DISTINCT m.* FROM memories m JOIN memory_dependencies d ON d.memory_revision_id=m.head_revision_id WHERE d.source_id=?`,
      )
      .all(sourceId)) {
      const memoryId = String(row.id);
      const corroborated = this.store.db
        .prepare(
          "SELECT 1 FROM memory_dependencies WHERE memory_revision_id=? AND source_id<>?",
        )
        .get(String(row.head_revision_id), sourceId);
      if (
        !this.modelOwned("memory", memoryId, Number(row.version)) ||
        corroborated
      ) {
        this.store.db
          .prepare(
            "DELETE FROM memory_dependencies WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id=?) AND source_id=?",
          )
          .run(memoryId, sourceId);
        preserved.memories.push(memoryId);
        continue;
      }
      this.store.db
        .prepare(
          "INSERT OR REPLACE INTO derived_result_tombstones VALUES('memory',?,?,?,?,?)",
        )
        .run(
          memoryId,
          sourceId,
          "已移除的材料学习记忆",
          now(),
          "材料重新处理时清除旧生成记忆",
        );
      this.store.db
        .prepare(
          "DELETE FROM memory_dependencies WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id=?)",
        )
        .run(memoryId);
      this.store.db
        .prepare(
          "UPDATE memory_revisions SET supersedes_revision_id=NULL WHERE memory_id=?",
        )
        .run(memoryId);
      this.store.db
        .prepare("DELETE FROM memory_revisions WHERE memory_id=?")
        .run(memoryId);
      this.store.db
        .prepare(
          "UPDATE memories SET head_revision_id=NULL,status='archived',version=version+1,updated_at=? WHERE id=?",
        )
        .run(now(), memoryId);
      this.clearProjection("memory:" + memoryId);
      cleared.memories.push(memoryId);
    }
    for (const row of this.store.db
      .prepare(
        "SELECT t.* FROM tasks t JOIN fragments f ON f.id=t.evidence_id JOIN revisions r ON r.id=f.revision_id WHERE r.source_id=?",
      )
      .all(sourceId)) {
      const taskId = String(row.id);
      if (
        !this.modelOwned("task", taskId, Number(row.version)) ||
        String(row.status) !== "open"
      ) {
        this.store.db
          .prepare("UPDATE tasks SET evidence_id=NULL WHERE id=?")
          .run(taskId);
        preserved.tasks.push(taskId);
        continue;
      }
      this.store.db
        .prepare(
          "INSERT OR REPLACE INTO derived_result_tombstones VALUES('task',?,?,?,?,?)",
        )
        .run(
          taskId,
          sourceId,
          "已移除的材料学习事项",
          now(),
          "材料重新处理时清除旧生成事项",
        );
      this.store.db
        .prepare("DELETE FROM task_reminder_receipts WHERE task_id=?")
        .run(taskId);
      this.store.db
        .prepare("DELETE FROM task_revisions WHERE task_id=?")
        .run(taskId);
      this.store.db.prepare("DELETE FROM tasks WHERE id=?").run(taskId);
      this.clearProjection("task:" + taskId);
      cleared.tasks.push(taskId);
    }
  }
  articleAvailability(key: string, revisionId?: string) {
    const removed = revisionId
      ? this.store.db
          .prepare(
            "SELECT * FROM knowledge_revision_tombstones WHERE document_key=? AND revision_id=?",
          )
          .get(key, revisionId)
      : this.store.db
          .prepare(
            "SELECT * FROM knowledge_revision_tombstones WHERE document_key=? ORDER BY removed_at DESC LIMIT 1",
          )
          .get(key);
    return removed
      ? {
          key,
          revisionId: String(removed.revision_id),
          title: String(removed.title),
          available: false as const,
          removedAt: String(removed.removed_at),
          reason: String(removed.reason),
        }
      : null;
  }
  clearArticle(key: string) {
    const reason = "此文章的旧生成正文已清除，等待重新写作。";
    return this.store.tx(() => {
      const at = now();
      const revisions = table(this.store, "knowledge_revisions")
        ? this.store.db
            .prepare(
              "SELECT id,artifact FROM knowledge_revisions WHERE document_key=?",
            )
            .all(key)
        : [];
      const removedRevisions = revisions.map((row) => String(row.id));
      for (const row of revisions) {
        const artifact = JSON.parse(String(row.artifact));
        this.store.db
          .prepare(
            "INSERT OR REPLACE INTO knowledge_revision_tombstones VALUES(?,?,?,?,?)",
          )
          .run(
            String(row.id),
            key,
            artifact.document?.title ?? key,
            at,
            reason,
          );
      }
      this.store.db
        .prepare(
          "INSERT INTO knowledge_clear_epochs VALUES(?,?) ON CONFLICT(document_key) DO UPDATE SET removed_at=excluded.removed_at",
        )
        .run(key, at);
      if (table(this.store, "knowledge_heads"))
        this.store.db
          .prepare("DELETE FROM knowledge_heads WHERE document_key=?")
          .run(key);
      if (table(this.store, "knowledge_questions"))
        this.store.db
          .prepare("DELETE FROM knowledge_questions WHERE document_key=?")
          .run(key);
      if (table(this.store, "knowledge_invalidations"))
        this.store.db
          .prepare("DELETE FROM knowledge_invalidations WHERE document_key=?")
          .run(key);
      if (table(this.store, "knowledge_revisions"))
        this.store.db
          .prepare("DELETE FROM knowledge_revisions WHERE document_key=?")
          .run(key);
      if (table(this.store, "knowledge_pages"))
        this.store.db
          .prepare(
            "UPDATE knowledge_pages SET state='planned',error=NULL,updated_at=? WHERE document_key=?",
          )
          .run(at, key);
      this.clearProjection("knowledge:" + key);
      const jobs = this.store.jobs.invalidateInputs(
        [key, ...removedRevisions],
        reason,
      );
      return { key, removedRevisions, jobs };
    });
  }
  deleteSource(sourceId: string) {
    const result = this.clearDerived(sourceId, {
      descriptions: true,
      articles: true,
      learning: true,
    });
    this.store.tx(() => {
      const ids = this.store.db
        .prepare(
          "SELECT id FROM revisions WHERE source_id=? AND id NOT IN (SELECT revision_id FROM revision_tombstones)",
        )
        .all(sourceId)
        .map((row) => String(row.id));
      this.removeRaw(ids, "用户已删除此材料的原件。", null);
      this.clearProjection("source:" + sourceId);
      this.store.db
        .prepare("UPDATE sources SET head=NULL WHERE id=?")
        .run(sourceId);
      this.store.db
        .prepare(
          "UPDATE source_state SET head_revision_id=NULL,validity_epoch=validity_epoch+1,updated_at=? WHERE source_id=?",
        )
        .run(now(), sourceId);
    });
    return { ...result, assets: this.sweepAssets() };
  }
  sweepAssets() {
    if (this.store.db.isTransaction)
      return { removed: [] as string[], deferred: true };
    const candidates = this.store.db
      .prepare("SELECT asset_id FROM retention_asset_candidates")
      .all();
    if (!candidates.length) return { removed: [] as string[], deferred: false };
    const referenceTables = [
      "document_imports",
      "lark_message_materials",
      "event_inbox",
      "personal_lark_messages",
      "lark_resource_cache",
    ]
      .filter((name) => table(this.store, name))
      .map((name) => ({
        name,
        columns: this.store.db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .filter((row) => String(row.type).toUpperCase().includes("TEXT"))
          .map((row) => String(row.name)),
      }));
    const referenced = (assetId: string) => {
      if (
        this.store.db
          .prepare("SELECT 1 FROM revision_asset_refs WHERE asset_id=? LIMIT 1")
          .get(assetId)
      )
        return true;
      for (const { name, columns } of referenceTables) {
        if (!columns.length) continue;
        const sql = `SELECT 1 FROM ${name} WHERE (${columns.map((column) => `instr(${column},?)>0`).join(" OR ")})${name === "lark_resource_cache" ? " AND expires_at>?" : ""} LIMIT 1`;
        if (
          this.store.db
            .prepare(sql)
            .get(
              ...columns.map(() => assetId),
              ...(name === "lark_resource_cache" ? [now()] : []),
            )
        )
          return true;
      }
      return !!this.store.db
        .prepare(
          "SELECT 1 FROM jobs WHERE state IN ('queued','leased','running','retry_wait','awaiting_decision') AND instr(input_refs,?)>0 LIMIT 1",
        )
        .get(assetId);
    };
    let cold: string | null = null;
    try {
      cold = coldDirectory(this.store.dataDir);
    } catch {
      /* Leave cold data in place if its configuration is unavailable. */
    }
    const removed: string[] = [];
    for (const row of candidates) {
      const assetId = String(row.asset_id);
      const hotPath = join(this.store.dataDir, "assets", assetId);
      if (
        !existsSync(hotPath) &&
        (!cold || !existsSync(join(cold, "assets", assetId)))
      ) {
        this.store.db
          .prepare("DELETE FROM retention_asset_candidates WHERE asset_id=?")
          .run(assetId);
        continue;
      }
      if (referenced(assetId)) continue;
      rmSync(join(this.store.dataDir, "assets", assetId), { force: true });
      if (cold) rmSync(join(cold, "assets", assetId), { force: true });
      this.store.db
        .prepare("DELETE FROM retention_asset_candidates WHERE asset_id=?")
        .run(assetId);
      removed.push(assetId);
    }
    return { removed, deferred: false };
  }
}
