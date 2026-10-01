import { dispatchTaskReminders } from "./tasks/follow-up.js";
import type { TaskStatus, TaskFollowUp } from "../../../packages/contracts/src/task-flow.js";
import { recordSourceRefresh } from "./learning/refresh.js";
/** SQLite is the single-user foundation. Immutable revisions, changes and notification
 * outbox are committed together. Postgres/team enforcement remains a later migration. */
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CaptureInput,
  StoredPart,
  Revision,
  Fragment,
  Change,
} from "../../../packages/contracts/src/index.js";
import { migrateDatabase } from "./storage/migrations.js";
import {
  ApplicationRepository,
  type ExternalNotificationPolicy,
} from "./storage/repository.js";
import { stableDigest } from "./storage/digest.js";
import { JobRepository } from "./jobs/repository.js";
import { InputAggregator } from "./inputs/aggregator.js";
import { RuntimeRequestRepository } from "./agent-runtime/requests.js";
import { SourceProfileService } from "./source-profile/service.js";
const id = () => randomUUID();
const now = () => new Date().toISOString();
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
type Row = Record<string, unknown>;
export class Store {
  readonly db: DatabaseSync;
  readonly applications: ApplicationRepository;
  readonly jobs: JobRepository;
  readonly inputs: InputAggregator;
  readonly runtimeRequests: RuntimeRequestRepository;
  readonly profiles: SourceProfileService;
  constructor(
    readonly dataDir: string,
    options: {
      externalNotifications?: Partial<ExternalNotificationPolicy>;
    } = {},
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, "omem.sqlite");
    this.db = new DatabaseSync(file);
    try {
      migrateDatabase(this.db);
      mkdirSync(join(dataDir, "assets"), { recursive: true, mode: 0o700 });
      chmodSync(file, 0o600);
      this.applications = new ApplicationRepository(
        this.db,
        options.externalNotifications,
      );
      this.jobs = new JobRepository(this.db);
      this.inputs = new InputAggregator(this.db);
      this.runtimeRequests = new RuntimeRequestRepository(this.db);
      this.profiles = new SourceProfileService(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  tx<T>(f: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = f();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  record(
    kind: string,
    title: string,
    before: string | null,
    after: string | null,
    details: string,
  ) {
    const changeId = id();
    const date = now();
    this.db
      .prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?)")
      .run(changeId, kind, title, before, after, details, date);
    this.db
      .prepare("INSERT INTO notifications VALUES(?,?,?,?,?,?,?)")
      .run(id(), changeId, title, details, date, null, changeId);
    return changeId;
  }
  capture(input: CaptureInput) {
    const payloadDigest = stableDigest(input);
    const parts: StoredPart[] = input.parts.map((p) => {
      if (p.type !== "image") return p;
      const bytes = Buffer.from(p.data, "base64");
      if (
        !bytes.length ||
        bytes.length > 5_000_000 ||
        bytes.toString("base64").replace(/=+$/, "") !==
          p.data.replace(/=+$/, "")
      )
        throw Error("Invalid or oversized image");
      const valid =
        p.mimeType === "image/png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : p.mimeType === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216
            : bytes.toString("ascii", 0, 4) === "RIFF" &&
              bytes.toString("ascii", 8, 12) === "WEBP";
      if (!valid) throw Error("Image type does not match bytes");
      const assetId = hash(bytes);
      const file = join(this.dataDir, "assets", assetId);
      if (!existsSync(file))
        writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      return {
        type: "image",
        assetId,
        mimeType: p.mimeType,
        label: p.label,
        ...(p.provenance ? { provenance: p.provenance } : {}),
      };
    });
    const body = {
      parts,
      context: input.context,
      provenance: input.provenance,
      observedAt: input.observedAt,
      upstreamVersion: input.upstreamVersion,
    };
    const fingerprint = hash(JSON.stringify({ title: input.title, ...body }));
    return this.tx(() => {
      const producer = input.provenance?.collectorId;
      const eventId = input.provenance?.eventId;
      if (producer && eventId) {
        const receipt = this.db
          .prepare(
            `SELECT * FROM capture_receipts
             WHERE workspace_id='personal' AND producer=? AND event_id=?`,
          )
          .get(producer, eventId) as Row | undefined;
        if (receipt) {
          if (receipt.payload_digest !== payloadDigest)
            throw Error("CAPTURE_EVENT_CONFLICT");
          const revision = this.revision(String(receipt.revision_id));
          if (!revision) throw Error("Capture receipt revision is missing");
          const queued = this.queueCaptureJob(input, revision);
          return {
            revision,
            duplicate: true,
            receipt: this.captureReceipt(receipt),
            job: queued?.job ?? null,
          };
        }
      }
      let source = this.db
        .prepare("SELECT * FROM sources WHERE namespace=? AND external_id=?")
        .get(input.source, input.externalId) as Row | undefined;
      if (!source) {
        source = { id: id(), head: null };
        this.db
          .prepare("INSERT INTO sources VALUES(?,?,?,?)")
          .run(String(source.id), input.source, input.externalId, null);
      }
      const head = source.head
        ? (this.db
            .prepare("SELECT * FROM revisions WHERE id=?")
            .get(String(source.head)) as Row)
        : undefined;
      if (head?.fingerprint === fingerprint) {
        const revision = this.revision(String(head.id))!;
        const receipt = this.writeCaptureReceipt(
          input,
          payloadDigest,
          revision.id,
        );
        const queued = this.queueCaptureJob(input, revision);
        return {
          revision,
          duplicate: true,
          receipt,
          job: queued?.job ?? null,
        };
      }
      const revisionId = id();
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)")
        .run(
          revisionId,
          String(source.id),
          Number(head?.version || 0) + 1,
          input.title,
          JSON.stringify(body),
          fingerprint,
          head ? String(head.id) : null,
          now(),
        );
      const texts = parts.flatMap((p) =>
        p.type === "text"
          ? p.text.split(/\n\s*\n/).filter((t) => t.trim())
          : p.type === "link"
            ? [`${p.label}\n${p.url}`]
            : [`[图片] ${p.label}`],
      );
      if (texts.length > 2000)
        throw Error("Fragment budget exceeded (2000 per capture)");
      texts.forEach((text, i) =>
        this.db
          .prepare("INSERT INTO fragments VALUES(?,?,?,?)")
          .run(id(), revisionId, i, text),
      );
      // V3-03: lightweight deterministic navigation profile. Best-effort: a
      // profiling failure records a failed row but never blocks the source.
      try {
        this.profiles.persistForRevision(revisionId);
      } catch (profileError) {
        this.profiles.recordFailure(revisionId, profileError);
      }
      this.db
        .prepare("UPDATE sources SET head=? WHERE id=?")
        .run(revisionId, String(source.id));
      this.db
        .prepare(
          `INSERT INTO source_state(
             source_id,workspace_id,registered_scope,head_revision_id,
             validity_epoch,capture_policy,updated_at
           ) VALUES(?,'personal','{}',?,1,'{}',?)
           ON CONFLICT(source_id) DO UPDATE SET
             head_revision_id=excluded.head_revision_id,
             validity_epoch=source_state.validity_epoch+1,
             updated_at=excluded.updated_at`,
        )
        .run(String(source.id), revisionId, now());
      if (head) {
        this.db
          .prepare(
            `UPDATE memory_dependencies SET state='stale'
             WHERE source_id=? AND source_revision_id<>?`,
          )
          .run(String(source.id), revisionId);
        this.db
          .prepare(
            `UPDATE memories SET status='invalidated',updated_at=?
             WHERE head_revision_id IN (
               SELECT memory_revision_id FROM memory_dependencies
               WHERE source_id=? AND state='stale'
             )`,
          )
          .run(now(), String(source.id));
        recordSourceRefresh(this.db, "personal", [{ sourceId: String(source.id), previousRevisionId: String(head.id), revisionId }]);
        this.jobs.enqueueInCurrentTransaction({
          kind: "refresh_dependents",
          inputRefs: [
            {
              sourceId: String(source.id),
              previousRevisionId: String(head.id),
              revisionId,
            },
          ],
          roleVersion: "deterministic@1",
          policyVersion: "memory-policy@1",
          cause: "source_update",
        });
      }
      this.record(
        "capture",
        input.title,
        head ? String(head.id) : null,
        revisionId,
        `材料${head ? "更新" : "录入"}为第 ${Number(head?.version || 0) + 1} 版。${head ? "可展开比较完整内容差异。" : "原始内容已保存，可查看原文。"}`,
      );
      const revision = this.revision(revisionId)!;
      const receipt = this.writeCaptureReceipt(
        input,
        payloadDigest,
        revision.id,
      );
      const queued = this.queueCaptureJob(input, revision);
      return {
        revision,
        duplicate: false,
        receipt,
        job: queued?.job ?? null,
      };
    });
  }
  private captureReceipt(row: Row) {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      producer: String(row.producer),
      eventId: String(row.event_id),
      payloadDigest: String(row.payload_digest),
      revisionId: String(row.revision_id),
      sourceSequence: row.source_sequence ? String(row.source_sequence) : null,
      createdAt: String(row.created_at),
    };
  }
  private writeCaptureReceipt(
    input: CaptureInput,
    payloadDigest: string,
    revisionId: string,
  ) {
    const producer = input.provenance?.collectorId;
    const eventId = input.provenance?.eventId;
    if (!producer || !eventId) return null;
    const receipt = {
      id: id(),
      workspace_id: "personal",
      producer,
      event_id: eventId,
      payload_digest: payloadDigest,
      revision_id: revisionId,
      source_sequence: input.upstreamVersion ?? null,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO capture_receipts(
           id,workspace_id,producer,event_id,payload_digest,revision_id,
           source_sequence,created_at
         ) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        receipt.id,
        receipt.workspace_id,
        receipt.producer,
        receipt.event_id,
        receipt.payload_digest,
        receipt.revision_id,
        receipt.source_sequence,
        receipt.created_at,
      );
    return this.captureReceipt(receipt);
  }
  private queueCaptureJob(input: CaptureInput, revision: Revision) {
    // Only derived material (model summaries/reflections) is withheld from the
    // learning queue: it must not self-loop as independent evidence. Original Agent
    // sessions are real experience and DO enter extract_claims (G14).
    if (input.provenance?.producerKind === "derived") return null;
    const state = this.db
      .prepare("SELECT validity_epoch FROM source_state WHERE source_id=?")
      .get(revision.sourceId) as Row | undefined;
    return this.jobs.enqueueInCurrentTransaction({
      kind: "extract_claims",
      inputRefs: [
        {
          revisionId: revision.id,
          sourceId: revision.sourceId,
          validityEpoch: Number(state?.validity_epoch ?? 1),
        },
      ],
      roleVersion: "extractor@1",
      policyVersion: "memory-policy@1",
      cause: "capture",
    });
  }
  list() {
    return (
      this.db
        .prepare(
          "SELECT r.*,s.namespace,s.external_id FROM revisions r JOIN sources s ON s.head=r.id ORDER BY r.created_at DESC",
        )
        .all() as Row[]
    ).map((r) => ({
      id: r.id,
      title: r.title,
      source: r.namespace,
      externalId: r.external_id,
      version: r.version,
      createdAt: r.created_at,
      sourceId: r.source_id,
    }));
  }
  revision(revisionId: string): Revision | null {
    const r = this.db
      .prepare(
        "SELECT r.*,s.namespace,s.head FROM revisions r JOIN sources s ON r.source_id=s.id WHERE r.id=?",
      )
      .get(revisionId) as Row | undefined;
    if (!r) return null;
    const body = JSON.parse(String(r.body));
    return {
      id: String(r.id),
      sourceId: String(r.source_id),
      version: Number(r.version),
      title: String(r.title),
      source: String(r.namespace),
      createdAt: String(r.created_at),
      parts: body.parts,
      context: body.context,
      provenance: body.provenance,
      fragments: this.fragments(revisionId),
      previousId: r.previous_id ? String(r.previous_id) : null,
      current: r.head === r.id,
    };
  }
  fragments(revisionId: string) {
    return (
      this.db
        .prepare("SELECT * FROM fragments WHERE revision_id=? ORDER BY ordinal")
        .all(revisionId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      revisionId: String(r.revision_id),
      ordinal: Number(r.ordinal),
      text: String(r.text),
    }));
  }
  evidence(fragmentId: string) {
    const f = this.db
      .prepare("SELECT * FROM fragments WHERE id=?")
      .get(fragmentId) as Row | undefined;
    if (!f) return null;
    const revision = this.revision(String(f.revision_id))!;
    const fragment = revision.fragments.find((x) => x.id === fragmentId)!;
    const relation = (column: string, target: string) =>
      this.db
        .prepare(
          `SELECT e.id,e.kind,f.id AS targetId,f.text,r.title,r.version FROM edges e JOIN fragments f ON e.${target}=f.id JOIN revisions r ON f.revision_id=r.id WHERE e.${column}=? LIMIT 100`,
        )
        .all(fragmentId);
    return {
      fragment,
      revision,
      outgoing: relation("from_id", "to_id"),
      backlinks: relation("to_id", "from_id"),
    };
  }
  link(from: string, to: string) {
    return this.tx(() => {
      if (!this.evidence(from) || !this.evidence(to))
        throw Error("Evidence not found");
      const existing = this.db
        .prepare("SELECT id FROM edges WHERE from_id=? AND to_id=? AND kind=?")
        .get(from, to, "references");
      if (existing) return existing;
      const edgeId = id();
      this.db
        .prepare("INSERT INTO edges VALUES(?,?,?,?)")
        .run(edgeId, from, to, "references");
      this.record(
        "link",
        "添加片段引用",
        null,
        null,
        `${from} → ${to}；用户建立的引用，不自动判定为事实支持。`,
      );
      return { id: edgeId };
    });
  }
  search(query: string) {
    if (!query.trim()) return [];
    const escaped = query.replace(/[!%_]/g, "!$&");
    return this.db
      .prepare(
        "SELECT f.id,f.text,r.title,r.version FROM fragments f JOIN revisions r ON f.revision_id=r.id JOIN sources s ON s.head=r.id WHERE f.text LIKE ? ESCAPE '!' OR r.title LIKE ? ESCAPE '!' LIMIT 50",
      )
      .all("%" + escaped + "%", "%" + escaped + "%");
  }

  history(sourceId: string) {
    return this.db
      .prepare(
        "SELECT id,title,version,created_at AS createdAt FROM revisions WHERE source_id=? ORDER BY version DESC",
      )
      .all(sourceId);
  }
  changes() {
    return this.db
      .prepare(
        "SELECT id,kind,title,before_id AS beforeId,after_id AS afterId,created_at AS createdAt,details FROM changes ORDER BY rowid DESC LIMIT 200",
      )
      .all() as unknown as Change[];
  }
  restore(changeId: string, expectedHead: string) {
    return this.tx(() => {
      const c = this.db
        .prepare("SELECT * FROM changes WHERE id=?")
        .get(changeId) as Row | undefined;
      if (!c?.before_id || !c.after_id)
        throw Error("Change has no restorable predecessor");
      const old = this.revision(String(c.before_id));
      const after = this.revision(String(c.after_id));
      if (!old || !after) throw Error("Revision not found");
      const source = this.db
        .prepare("SELECT head FROM sources WHERE id=?")
        .get(old.sourceId) as Row;
      if (source.head !== expectedHead || source.head !== after.id)
        throw Error("REBASE_REQUIRED");
      const next = id();
      const saved = this.db
        .prepare("SELECT * FROM revisions WHERE id=?")
        .get(old.id) as Row;
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)")
        .run(
          next,
          old.sourceId,
          after.version + 1,
          old.title,
          String(saved.body),
          String(saved.fingerprint),
          after.id,
          now(),
        );
      const fragmentMap = new Map<string, string>();
      old.fragments.forEach((f) => {
        const newId = id();
        fragmentMap.set(f.id, newId);
        this.db
          .prepare("INSERT INTO fragments VALUES(?,?,?,?)")
          .run(newId, next, f.ordinal, f.text);
      });
      for (const f of old.fragments) {
        const edges = this.db
          .prepare("SELECT * FROM edges WHERE from_id=?")
          .all(f.id) as Row[];
        for (const e of edges)
          this.db
            .prepare("INSERT INTO edges VALUES(?,?,?,?)")
            .run(
              id(),
              fragmentMap.get(f.id)!,
              fragmentMap.get(String(e.to_id)) || String(e.to_id),
              String(e.kind),
            );
      }
      this.db
        .prepare("UPDATE sources SET head=? WHERE id=?")
        .run(next, old.sourceId);
      this.record(
        "restore",
        "恢复：" + old.title,
        after.id,
        next,
        "恢复为新修订，保留原文与全部历史。",
      );
      return this.revision(next);
    });
  }
  asset(assetId: string) {
    if (!/^[a-f0-9]{64}$/.test(assetId)) return null;
    const file = join(this.dataDir, "assets", assetId);
    return existsSync(file) ? readFileSync(file) : null;
  }
  notifications() {
    return this.db
      .prepare(
        "SELECT id,title,body,change_id AS changeId,created_at AS createdAt,read_at AS readAt FROM notifications ORDER BY rowid DESC LIMIT 200",
      )
      .all();
  }
  notification(notificationId: string) {
    const row = this.db
      .prepare(
        `SELECT n.id,n.title,n.body,n.change_id AS changeId,
           n.created_at AS createdAt,n.read_at AS readAt,
           c.kind AS changeKind,c.title AS changeTitle,
           c.before_id AS beforeId,c.after_id AS afterId,c.details
         FROM notifications n
         LEFT JOIN changes c ON c.id=n.change_id
         WHERE n.id=?`,
      )
      .get(notificationId) as Row | undefined;
    if (!row) return null;
    const changeId = row.changeId ? String(row.changeId) : null;
    const deliveries = changeId
      ? (this.db
          .prepare(
            `SELECT DISTINCT i.id,i.channel,i.state,
               i.attempt_count AS attemptCount,i.error_kind AS errorKind,
               i.last_error AS lastError,i.created_at AS createdAt,
               i.updated_at AS updatedAt,i.aggregation_mode AS aggregationMode,
               i.superseded_by AS supersededBy,
               (SELECT count(*) FROM delivery_intent_changes count_map
                WHERE count_map.intent_id=i.id) AS changeCount
             FROM delivery_intents i
             LEFT JOIN delivery_intent_changes m ON m.intent_id=i.id
             WHERE i.change_id=? OR m.change_id=? ORDER BY i.created_at`,
          )
          .all(changeId, changeId) as Row[])
      : [];
    const receipt = changeId
      ? (this.db
          .prepare(
            `SELECT id,proposal_id AS proposalId,entity_type AS entityType,
               entity_id AS entityId,entity_version AS entityVersion,
               created_at AS createdAt
             FROM application_receipts WHERE change_id=?`,
          )
          .get(changeId) as Row | undefined)
      : undefined;
    let proposal: Row | undefined;
    if (receipt?.proposalId)
      proposal = this.db
        .prepare("SELECT evidence FROM proposals WHERE id=?")
        .get(String(receipt.proposalId)) as Row | undefined;
    else if (row.changeKind === "decision" && row.afterId)
      proposal = this.db
        .prepare(
          `SELECT p.evidence FROM decisions d
           JOIN proposals p ON p.digest=d.proposal_digest WHERE d.id=?`,
        )
        .get(String(row.afterId)) as Row | undefined;
    const evidence = proposal?.evidence
      ? (JSON.parse(String(proposal.evidence)) as Record<string, unknown>[])
      : [];
    return {
      ...row,
      deliveries,
      receipt: receipt ?? null,
      evidenceIds: evidence
        .map((item) => item.fragment_revision_id)
        .filter((id): id is string => typeof id === "string"),
    };
  }
  readNotification(notificationId: string) {
    this.db
      .prepare("UPDATE notifications SET read_at=? WHERE id=?")
      .run(now(), notificationId);
  }
  tasks(): (Record<string, unknown> & { followUp: TaskFollowUp | null })[] {
    return this.db
      .prepare(
        `SELECT id,title,detail,due_at AS dueAt,evidence_id AS evidenceId,
           status,version,workspace_id AS workspaceId,owner_id AS ownerId,
           due_expression AS dueExpression,next_step AS nextStep,follow_up AS followUp
         FROM tasks ORDER BY created_at DESC`,
      )
      .all().map(row => ({ ...row, followUp: row.followUp ? JSON.parse(String(row.followUp)) : null }));
  }
  createTask(input: {
    title: string;
    detail: string;
    dueAt: string | null;
    evidenceId?: string;
  }) {
    return this.tx(() => {
      const taskId = id();
      if (input.evidenceId && !this.evidence(input.evidenceId))
        throw Error("Evidence not found");
      this.db
        .prepare(
          "INSERT INTO tasks(id,title,detail,due_at,evidence_id,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          taskId,
          input.title,
          input.detail,
          input.dueAt ? new Date(input.dueAt).toISOString() : null,
          input.evidenceId || null,
          now(),
        );
      this.db
        .prepare(
          `INSERT INTO task_revisions(
             id,workspace_id,task_id,version,title,detail,due_at,due_expression,
             owner_id,next_step,status,evidence_set,correction_feedback_id,created_at
           ) VALUES(?,'personal',?,1,?,?,?,NULL,NULL,'','open',?,NULL,?)`,
        )
        .run(
          id(),
          taskId,
          input.title,
          input.detail,
          input.dueAt ? new Date(input.dueAt).toISOString() : null,
          JSON.stringify(input.evidenceId ? [input.evidenceId] : []),
          now(),
        );
      this.record(
        "task",
        "新增待办：" + input.title,
        null,
        null,
        input.detail || "用户创建待办",
      );
      return { id: taskId };
    });
  }
  setTaskStatus(
    taskId: string,
    status: TaskStatus,
    expectedVersion: number,
  ) {
    return this.tx(() => {
      const old = this.db
        .prepare("SELECT * FROM tasks WHERE id=?")
        .get(taskId) as Row | undefined;
      if (!old) throw Error("Task not found");
      if (Number(old.version) !== expectedVersion)
        throw Error("STALE_TASK_VERSION");
      if (old.status === status) return { version: expectedVersion };
      const updated = this.db
        .prepare(
          "UPDATE tasks SET status=?,follow_up=NULL,version=version+1 WHERE id=? AND version=?",
        )
        .run(status, taskId, expectedVersion);
      if (Number(updated.changes) !== 1) throw Error("STALE_TASK_VERSION");
      this.db
        .prepare(
          `INSERT INTO task_revisions(
             id,workspace_id,task_id,version,title,detail,due_at,due_expression,
             owner_id,next_step,status,evidence_set,correction_feedback_id,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
        )
        .run(
          id(),
          String(old.workspace_id),
          taskId,
          expectedVersion + 1,
          String(old.title),
          String(old.detail),
          old.due_at ? String(old.due_at) : null,
          old.due_expression ? String(old.due_expression) : null,
          old.owner_id ? String(old.owner_id) : null,
          String(old.next_step),
          status,
          JSON.stringify(old.evidence_id ? [String(old.evidence_id)] : []),
          now(),
        );
      this.record(
        "task",
        `${status === "done" ? "完成" : status === "cancelled" ? "取消" : status === "waiting" ? "等待" : "重新打开"}待办：${old.title}`,
        null,
        null,
        "待办状态已变更。",
      );
      return { version: expectedVersion + 1 };
    });
  }
  remind(instant = now()) {
    return this.tx(() => dispatchTaskReminders(this.db, instant));
  }
}
