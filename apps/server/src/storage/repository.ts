import { queueOwnerNotice } from "../integrations/lark/owner-notice.js";
import { taskFollowUpSchema, type TaskFollowUp, type TaskStatus } from "../../../../packages/contracts/src/task-flow.js";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableDigest } from "./digest.js";
import { transaction } from "./transaction.js";

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
    projectId?: string | null;
    id?: string;
    expectedVersion?: number;
    title: string;
    detail: string;
    ownerId?: string | null;
    dueAt?: string | null;
    dueExpression?: string | null;
    nextStep: string;
    evidenceId?: string | null;
    status?: TaskStatus;
    followUp?: TaskFollowUp | null;
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

export type ExternalNotificationPolicy = {
  mode: "instant" | "window" | "scheduled";
  windowMs: number;
  scheduleLocalTime: string;
  timezone: string;
};

const defaultNotificationPolicy: ExternalNotificationPolicy = {
  mode: "instant",
  windowMs: 300_000,
  scheduleLocalTime: "09:00",
  timezone: "Asia/Shanghai",
};

const timestamp = () => new Date().toISOString();
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const zonedParts = (date: Date, timezone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;

const zonedTime = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
) => {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = zonedParts(guess, timezone);
  const represented = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return new Date(guess.getTime() - (represented - guess.getTime()));
};

export function externalDeliveryTiming(
  createdAt: string,
  policy: ExternalNotificationPolicy = defaultNotificationPolicy,
) {
  const created = new Date(createdAt);
  if (policy.mode === "instant")
    return { mode: policy.mode, after: created.toISOString() };
  if (policy.mode === "window")
    return {
      mode: policy.mode,
      after: new Date(created.getTime() + policy.windowMs).toISOString(),
    };
  const [hour, minute] = policy.scheduleLocalTime.split(":").map(Number);
  const local = zonedParts(created, policy.timezone);
  let target = zonedTime(
    local.year!,
    local.month!,
    local.day!,
    hour!,
    minute!,
    policy.timezone,
  );
  if (target <= created)
    target = zonedTime(
      local.year!,
      local.month!,
      local.day! + 1,
      hour!,
      minute!,
      policy.timezone,
    );
  return { mode: policy.mode, after: target.toISOString() };
}

export class ApplicationRepository {
  private readonly notificationPolicy: ExternalNotificationPolicy;

  constructor(
    private readonly db: DatabaseSync,
    notificationPolicy: Partial<ExternalNotificationPolicy> = {},
  ) {
    this.notificationPolicy = {
      ...defaultNotificationPolicy,
      ...notificationPolicy,
    };
  }

  externalDeliveryTiming(createdAt: string) {
    return externalDeliveryTiming(createdAt, this.notificationPolicy);
  }

  private transaction<T>(work: () => T): T {
    return transaction(this.db, work);
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
      const inAppIntentId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO delivery_intents(
             id,workspace_id,change_id,channel_binding_version,channel,target,
             payload_digest,provider_uuid,state,created_at,updated_at,
             aggregation_mode,aggregate_after,next_attempt_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          inAppIntentId,
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
          "instant",
          createdAt,
          createdAt,
        );
      this.db
        .prepare(
          `INSERT INTO delivery_intent_changes(intent_id,change_id,ordinal)
           VALUES(?,?,0)`,
        )
        .run(inAppIntentId, changeId);
      queueOwnerNotice(this.db, changeId, metadata.title, metadata.notificationBody ?? metadata.details, createdAt, this.externalDeliveryTiming(createdAt), metadata.workspaceId);
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
        const projectId = input.task.projectId === undefined ? (existing?.project_id ? String(existing.project_id) : null) : input.task.projectId;
        const parsedFollowUp = input.task.followUp ? taskFollowUpSchema.parse(input.task.followUp) : null;
        const followUp = input.task.followUp === undefined ? (existing?.follow_up ? String(existing.follow_up) : null) : parsedFollowUp ? JSON.stringify({ ...parsedFollowUp,
          next_check_at: parsedFollowUp.next_check_at ? new Date(parsedFollowUp.next_check_at).toISOString() : null,
          snoozed_until: parsedFollowUp.snoozed_until ? new Date(parsedFollowUp.snoozed_until).toISOString() : null }) : null;
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
                 version=?,workspace_id=?,owner_id=?,due_expression=?,next_step=?,follow_up=?,project_id=?
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
              followUp,
              projectId,
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
                 workspace_id,owner_id,due_expression,next_step,follow_up,project_id
               ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
              followUp,
              projectId,
            );
        }
        this.db
          .prepare(
            `INSERT INTO task_revisions(
             id,workspace_id,task_id,version,title,detail,due_at,due_expression,
             owner_id,next_step,status,evidence_set,correction_feedback_id,created_at,follow_up,project_id
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)`,
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
            followUp,
            projectId,
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
