import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableDigest } from "./digest.js";

type Row = Record<string, unknown>;

export type ApplicationMetadata = {
  workspaceId: string;
  applicationId: string;
  proposalId?: string;
  proposalDigest: string;
  generation: number;
  title: string;
  details: string;
  notificationBody?: string;
  delivery: {
    channelBindingVersion: number;
    channel: string;
    target: string;
    payloadDigest?: string;
  };
};

export type MemoryApplication = {
  metadata: ApplicationMetadata;
  memory: {
    id?: string;
    expectedVersion?: number;
    kind: "claim" | "episode" | "procedure";
    scope: Record<string, unknown>;
    body: Record<string, unknown>;
    validFrom?: string | null;
    validTo?: string | null;
    status?: "active" | "superseded" | "invalidated" | "archived";
    evidenceSet: unknown[];
  };
};

export type TaskApplication = {
  metadata: ApplicationMetadata;
  task: {
    id?: string;
    expectedVersion?: number;
    title: string;
    detail: string;
    ownerId?: string | null;
    dueAt?: string | null;
    dueExpression?: string | null;
    nextStep: string;
    evidenceId?: string | null;
    status?: "open" | "done";
  };
};

export type ApplicationReceipt = {
  id: string;
  entityType: "memory" | "task";
  entityId: string;
  entityVersion: number;
  changeId: string;
  duplicate: boolean;
};

export type ApplicationHooks = {
  before?: () => void;
  after?: (receipt: ApplicationReceipt) => void;
};

const timestamp = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class ApplicationRepository {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private existingReceipt(
    metadata: ApplicationMetadata,
    requestDigest: string,
  ): ApplicationReceipt | null {
    const row = this.db
      .prepare(
        `SELECT * FROM application_receipts
         WHERE workspace_id=? AND
           (application_id=? OR (proposal_digest=? AND application_generation=?))`,
      )
      .get(
        metadata.workspaceId,
        metadata.applicationId,
        metadata.proposalDigest,
        metadata.generation,
      ) as Row | undefined;
    if (!row) return null;
    if (row.request_digest !== requestDigest)
      throw Error("APPLICATION_IDEMPOTENCY_CONFLICT");
    return {
      id: String(row.id),
      entityType: String(row.entity_type) as "memory" | "task",
      entityId: String(row.entity_id),
      entityVersion: Number(row.entity_version),
      changeId: String(row.change_id),
      duplicate: true,
    };
  }

  private commitApplication(
    metadata: ApplicationMetadata,
    requestDigest: string,
    entityType: "memory" | "task",
    createEntity: () => {
      id: string;
      version: number;
      beforeId: string | null;
      afterId: string | null;
    },
    hooks: ApplicationHooks,
  ): ApplicationReceipt {
    return this.transaction(() => {
      const existing = this.existingReceipt(metadata, requestDigest);
      if (existing) return existing;

      hooks.before?.();
      const entity = createEntity();
      const changeId = randomUUID();
      const createdAt = timestamp();
      this.db
        .prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?)")
        .run(
          changeId,
          entityType,
          metadata.title,
          entity.beforeId,
          entity.afterId,
          metadata.details,
          createdAt,
        );
      this.db
        .prepare("INSERT INTO notifications VALUES(?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          changeId,
          metadata.title,
          metadata.notificationBody ?? metadata.details,
          createdAt,
          null,
          `application:${metadata.workspaceId}:${metadata.applicationId}`,
        );
      this.db
        .prepare(
          `INSERT INTO delivery_intents(
             id,workspace_id,change_id,channel_binding_version,channel,target,
             payload_digest,provider_uuid,state,created_at,updated_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          metadata.workspaceId,
          changeId,
          metadata.delivery.channelBindingVersion,
          metadata.delivery.channel,
          metadata.delivery.target,
          metadata.delivery.payloadDigest ??
            digest({
              title: metadata.title,
              body: metadata.notificationBody ?? metadata.details,
            }),
          metadata.applicationId,
          "pending",
          createdAt,
          createdAt,
        );
      const larkTargets = this.db
        .prepare(
          `SELECT t.chat_id,t.binding_version,b.id AS binding_id
           FROM lark_targets t JOIN lark_bindings b
             ON b.connection_id=t.connection_id
            AND b.binding_version=t.binding_version
           JOIN lark_connections c ON c.id=t.connection_id
           WHERE t.workspace_id=? AND t.purpose='owner_notification'
             AND t.state='active' AND b.state='active' AND c.state='active'`,
        )
        .all(metadata.workspaceId) as Row[];
      for (const target of larkTargets) {
        const payload = {
          schema: "2.0",
          config: { width_mode: "default" },
          header: {
            title: { tag: "plain_text", content: metadata.title.slice(0, 100) },
            template: "green",
          },
          body: {
            elements: [
              {
                tag: "markdown",
                content: (metadata.notificationBody ?? metadata.details).slice(
                  0,
                  8000,
                ),
              },
            ],
          },
        };
        const payloadJson = JSON.stringify(payload);
        if (Buffer.byteLength(payloadJson) > 30_000)
          throw Error("LARK_CARD_PAYLOAD_TOO_LARGE");
        this.db
          .prepare(
            `INSERT INTO delivery_intents(
               id,workspace_id,change_id,channel_binding_version,channel,target,
               payload_digest,provider_uuid,state,created_at,updated_at,
               binding_id,payload_json,next_attempt_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            metadata.workspaceId,
            changeId,
            Number(target.binding_version),
            "lark",
            String(target.chat_id),
            stableDigest(payload),
            digest({ changeId, target: target.chat_id }).slice(0, 50),
            "pending",
            createdAt,
            createdAt,
            String(target.binding_id),
            payloadJson,
            createdAt,
          );
      }
      const receiptId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO application_receipts(
             id,workspace_id,application_id,proposal_id,proposal_digest,
             application_generation,request_digest,entity_type,entity_id,
             entity_version,change_id,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          receiptId,
          metadata.workspaceId,
          metadata.applicationId,
          metadata.proposalId ?? null,
          metadata.proposalDigest,
          metadata.generation,
          requestDigest,
          entityType,
          entity.id,
          entity.version,
          changeId,
          createdAt,
        );
      const receipt: ApplicationReceipt = {
        id: receiptId,
        entityType,
        entityId: entity.id,
        entityVersion: entity.version,
        changeId,
        duplicate: false,
      };
      hooks.after?.(receipt);
      return receipt;
    });
  }

  applyMemory(
    input: MemoryApplication,
    hooks: ApplicationHooks = {},
  ): ApplicationReceipt {
    const requestDigest = digest(input);
    return this.commitApplication(
      input.metadata,
      requestDigest,
      "memory",
      () => {
        const date = timestamp();
        const status = input.memory.status ?? "active";
        const existing = input.memory.id
          ? (this.db
              .prepare("SELECT * FROM memories WHERE id=? AND workspace_id=?")
              .get(input.memory.id, input.metadata.workspaceId) as
              | Row
              | undefined)
          : undefined;
        if (input.memory.id && !existing && input.memory.expectedVersion)
          throw Error("MEMORY_NOT_FOUND");
        if (existing && input.memory.kind !== existing.kind)
          throw Error("MEMORY_KIND_MISMATCH");
        const memoryId = existing
          ? String(existing.id)
          : (input.memory.id ?? randomUUID());
        const previousVersion = existing ? Number(existing.version) : 0;
        if (
          existing &&
          (input.memory.expectedVersion === undefined ||
            input.memory.expectedVersion !== previousVersion)
        )
          throw Error("STALE_MEMORY_VERSION");
        const revisionId = randomUUID();
        const nextVersion = previousVersion + 1;
        if (!existing)
          this.db
            .prepare(
              `INSERT INTO memories(
                 id,workspace_id,kind,scope,head_revision_id,version,status,created_at,updated_at
               ) VALUES(?,?,?,?,NULL,?,?,?,?)`,
            )
            .run(
              memoryId,
              input.metadata.workspaceId,
              input.memory.kind,
              JSON.stringify(input.memory.scope),
              nextVersion,
              status,
              date,
              date,
            );
        this.db
          .prepare(
            `INSERT INTO memory_revisions(
               id,workspace_id,memory_id,version,body,valid_from,valid_to,status,
               evidence_set,supersedes_revision_id,created_at
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            revisionId,
            input.metadata.workspaceId,
            memoryId,
            nextVersion,
            JSON.stringify(input.memory.body),
            input.memory.validFrom ?? null,
            input.memory.validTo ?? null,
            status,
            JSON.stringify(input.memory.evidenceSet),
            existing?.head_revision_id
              ? String(existing.head_revision_id)
              : null,
            date,
          );
        if (existing) {
          const updated = this.db
            .prepare(
              `UPDATE memories SET head_revision_id=?,version=?,status=?,scope=?,updated_at=?
               WHERE id=? AND workspace_id=? AND version=?`,
            )
            .run(
              revisionId,
              nextVersion,
              status,
              JSON.stringify(input.memory.scope),
              date,
              memoryId,
              input.metadata.workspaceId,
              previousVersion,
            );
          if (Number(updated.changes) !== 1)
            throw Error("STALE_MEMORY_VERSION");
        } else {
          this.db
            .prepare("UPDATE memories SET head_revision_id=? WHERE id=?")
            .run(revisionId, memoryId);
        }
        for (const evidence of input.memory.evidenceSet) {
          if (!evidence || typeof evidence !== "object") continue;
          const item = evidence as Record<string, unknown>;
          if (
            typeof item.sourceId !== "string" ||
            typeof item.sourceRevisionId !== "string" ||
            !Number.isInteger(item.validityEpoch)
          )
            continue;
          this.db
            .prepare(
              `INSERT INTO memory_dependencies(
                 memory_revision_id,source_id,source_revision_id,validity_epoch,state
               ) VALUES(?,?,?,?,'current')`,
            )
            .run(
              revisionId,
              item.sourceId,
              item.sourceRevisionId,
              Number(item.validityEpoch),
            );
        }
        return {
          id: memoryId,
          version: nextVersion,
          beforeId: existing ? String(existing.head_revision_id) : null,
          afterId: revisionId,
        };
      },
      hooks,
    );
  }

  applyTask(
    input: TaskApplication,
    hooks: ApplicationHooks = {},
  ): ApplicationReceipt {
    const requestDigest = digest(input);
    return this.commitApplication(
      input.metadata,
      requestDigest,
      "task",
      () => {
        const date = timestamp();
        const dueAt = input.task.dueAt
          ? new Date(input.task.dueAt).toISOString()
          : null;
        const existing = input.task.id
          ? (this.db
              .prepare("SELECT * FROM tasks WHERE id=? AND workspace_id=?")
              .get(input.task.id, input.metadata.workspaceId) as
              | Row
              | undefined)
          : undefined;
        if (input.task.id && !existing && input.task.expectedVersion)
          throw Error("TASK_NOT_FOUND");
        const taskId = existing
          ? String(existing.id)
          : (input.task.id ?? randomUUID());
        const previousVersion = existing ? Number(existing.version) : 0;
        const nextVersion = previousVersion + 1;
        if (
          existing &&
          (input.task.expectedVersion === undefined ||
            input.task.expectedVersion !== previousVersion)
        )
          throw Error("STALE_TASK_VERSION");
        if (existing) {
          const updated = this.db
            .prepare(
              `UPDATE tasks SET title=?,detail=?,due_at=?,evidence_id=?,status=?,
                 version=?,workspace_id=?,owner_id=?,due_expression=?,next_step=?
               WHERE id=? AND workspace_id=? AND version=?`,
            )
            .run(
              input.task.title,
              input.task.detail,
              dueAt,
              input.task.evidenceId ?? null,
              input.task.status ?? String(existing.status),
              nextVersion,
              input.metadata.workspaceId,
              input.task.ownerId ?? null,
              input.task.dueExpression ?? null,
              input.task.nextStep,
              taskId,
              input.metadata.workspaceId,
              previousVersion,
            );
          if (Number(updated.changes) !== 1) throw Error("STALE_TASK_VERSION");
        } else {
          this.db
            .prepare(
              `INSERT INTO tasks(
                 id,title,detail,due_at,evidence_id,status,created_at,version,
                 workspace_id,owner_id,due_expression,next_step
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              taskId,
              input.task.title,
              input.task.detail,
              dueAt,
              input.task.evidenceId ?? null,
              input.task.status ?? "open",
              date,
              nextVersion,
              input.metadata.workspaceId,
              input.task.ownerId ?? null,
              input.task.dueExpression ?? null,
              input.task.nextStep,
            );
        }
        this.db
          .prepare(
            `INSERT INTO task_revisions(
             id,workspace_id,task_id,version,title,detail,due_at,due_expression,
             owner_id,next_step,status,evidence_set,correction_feedback_id,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
          )
          .run(
            randomUUID(),
            input.metadata.workspaceId,
            taskId,
            nextVersion,
            input.task.title,
            input.task.detail,
            dueAt,
            input.task.dueExpression ?? null,
            input.task.ownerId ?? null,
            input.task.nextStep,
            input.task.status ?? (existing ? String(existing.status) : "open"),
            JSON.stringify(
              input.task.evidenceId ? [input.task.evidenceId] : [],
            ),
            date,
          );
        return {
          id: taskId,
          version: nextVersion,
          beforeId: existing ? taskId : null,
          afterId: taskId,
        };
      },
      hooks,
    );
  }
}
