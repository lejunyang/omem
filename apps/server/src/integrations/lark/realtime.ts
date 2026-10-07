import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import type { Store } from "../../store.js";
import type { CaptureInput } from "../../../../../packages/contracts/src/index.js";
import { stableDigest } from "../../storage/digest.js";
import { EncryptedSecretStore } from "./secret-store.js";
import { saveImportAssetSync } from "../../imports/documents.js";
import {
  messageMaterial,
  type MessageResource,
} from "../lark-personal/materials.js";
import type { LarkResourcePort } from "./resources.js";
import { DurableJobWorker, JobExecutionError } from "../../jobs/worker.js";
import type { JobLease } from "../../jobs/repository.js";

type Row = Record<string, unknown>;
export type LarkInboundEvent = {
  appId: string;
  eventId: string;
  kind:
    | "im.message.receive_v1"
    | "im.message.updated_v1"
    | "im.chat.member.bot.added_v1"
    | "im.chat.member.bot.deleted_v1"
    | "card.action.trigger";
  eventTime: string;
  senderOpenId: string | null;
  senderType: "user" | "bot" | "system" | "unknown";
  chatId: string | null;
  chatType: "p2p" | "group" | null;
  messageId: string | null;
  /** Lark message_type: text | post | image | ... Drives rich-part parsing. */
  messageType: string | null;
  /** Parent/root message id when this event replies to / quotes another message. */
  parentMessageId: string | null;
  text?: string;
  payload: unknown;
};

/**
 * Inbound media download port. The production implementation calls Lark's
 * message-resource API; tests inject a fake that returns fixture bytes without
 * touching the network.
 */
export interface LarkMediaPort {
  downloadImage(input: {
    appId: string;
    messageId: string;
    imageKey: string;
  }): Promise<{
    dataBase64: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  }>;
}

export interface LarkRealtimeAdapter {
  connect(input: {
    appId: string;
    clientSecret: string;
    tenantBrand: "feishu" | "lark";
    onEvent: (event: LarkInboundEvent) => Promise<unknown> | unknown;
    onState: (
      state:
        | "connecting"
        | "connected"
        | "reconnecting"
        | "disconnected"
        | "failed",
      error?: string,
    ) => void;
  }): { close: () => void };
}

const safeString = (value: unknown) =>
  typeof value === "string" && value ? value : null;

const eventDate = (value: unknown) => {
  const numeric = Number(value);
  const millis = Number.isFinite(numeric)
    ? numeric < 10_000_000_000
      ? numeric * 1000
      : numeric
    : Date.now();
  const date = new Date(millis);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
};

const messageText = (value: unknown) => {
  const raw = safeString(value);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : raw;
  } catch {
    return raw;
  }
};

export const normalizeLarkEvent = (
  appId: string,
  kind: LarkInboundEvent["kind"],
  data: any,
): LarkInboundEvent => ({
  appId,
  eventId:
    safeString(data?.header?.event_id) ||
    safeString(data?.event_id) ||
    stableDigest({ kind, data }),
  kind,
  eventTime: eventDate(
    data?.header?.create_time ||
      data?.create_time ||
      data?.event_time ||
      Date.now(),
  ),
  senderOpenId: safeString(
    data?.sender?.sender_id?.open_id || data?.operator?.open_id,
  ),
  senderType:
    data?.sender?.sender_type === "app" || data?.sender?.sender_type === "bot"
      ? "bot"
      : data?.sender?.sender_type === "user"
        ? "user"
        : data?.sender?.sender_type === "system"
          ? "system"
          : "unknown",
  chatId: safeString(
    data?.message?.chat_id ||
      data?.chat_id ||
      data?.context?.open_chat_id ||
      data?.open_chat_id,
  ),
  chatType:
    data?.message?.chat_type === "group" || data?.chat_type === "group"
      ? "group"
      : data?.message?.chat_type === "p2p" || data?.chat_type === "p2p"
        ? "p2p"
        : null,
  messageId: safeString(
    data?.message?.message_id ||
      data?.context?.open_message_id ||
      data?.open_message_id,
  ),
  messageType: safeString(
    data?.message?.message_type || data?.messageType || data?.msg_type,
  ),
  parentMessageId: safeString(
    data?.message?.parent_id ||
      data?.message?.root_id ||
      data?.parent_id ||
      data?.root_id,
  ),
  text: messageText(data?.message?.content),
  payload: data,
});

export class OfficialLarkRealtimeAdapter implements LarkRealtimeAdapter {
  connect(input: Parameters<LarkRealtimeAdapter["connect"]>[0]) {
    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn });
    const handlers = Object.fromEntries(
      [
        "im.message.receive_v1",
        "im.message.updated_v1",
        "im.chat.member.bot.added_v1",
        "im.chat.member.bot.deleted_v1",
        "card.action.trigger",
      ].map((kind) => [
        kind,
        async (data: unknown) => {
          return (
            (await input.onEvent(
              normalizeLarkEvent(
                input.appId,
                kind as LarkInboundEvent["kind"],
                data,
              ),
            )) ?? {}
          );
        },
      ]),
    );
    dispatcher.register(handlers);
    const client = new WSClient({
      appId: input.appId,
      appSecret: input.clientSecret,
      domain: input.tenantBrand === "lark" ? Domain.Lark : Domain.Feishu,
      loggerLevel: LoggerLevel.warn,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 30 },
      onReady: () => input.onState("connected"),
      onReconnecting: () => input.onState("reconnecting"),
      onReconnected: () => input.onState("connected"),
      onError: (error) => input.onState("failed", error.message),
    });
    input.onState("connecting");
    const start = () =>
      client
        .start({ eventDispatcher: dispatcher })
        .catch((error) =>
          input.onState(
            "failed",
            error instanceof Error ? error.message : "websocket failed",
          ),
        );
    void start();
    let reviving = false;
    const revive = setInterval(() => {
      if (reviving || client.getConnectionStatus().state !== "failed") return;
      reviving = true;
      input.onState("reconnecting");
      void start().finally(() => {
        reviving = false;
      });
    }, 60_000);
    revive.unref();
    return {
      close: () => {
        clearInterval(revive);
        client.close();
        input.onState("disconnected");
      },
    };
  }
}

export class LarkConnectionLeaseRepository {
  constructor(private readonly db: DatabaseSync) {}

  claim(
    connectionId: string,
    owner: string,
    now = new Date(),
    leaseMs = 60_000,
  ) {
    const token = randomUUID();
    const at = now.toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO lark_connection_leases(connection_id,owner,token,expires_at,updated_at)
         VALUES(?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET
           owner=excluded.owner,token=excluded.token,expires_at=excluded.expires_at,
           updated_at=excluded.updated_at
         WHERE lark_connection_leases.expires_at<=excluded.updated_at`,
      )
      .run(
        connectionId,
        owner,
        token,
        new Date(now.getTime() + leaseMs).toISOString(),
        at,
      );
    return Number(result.changes) === 1 ? token : null;
  }

  heartbeat(
    connectionId: string,
    token: string,
    now = new Date(),
    leaseMs = 60_000,
  ) {
    const changed = this.db
      .prepare(
        "UPDATE lark_connection_leases SET expires_at=?,updated_at=? WHERE connection_id=? AND token=?",
      )
      .run(
        new Date(now.getTime() + leaseMs).toISOString(),
        now.toISOString(),
        connectionId,
        token,
      );
    if (Number(changed.changes) !== 1)
      throw Error("STALE_LARK_CONNECTION_LEASE");
  }

  release(connectionId: string, token: string) {
    this.db
      .prepare(
        "DELETE FROM lark_connection_leases WHERE connection_id=? AND token=?",
      )
      .run(connectionId, token);
  }
}

export type LarkAssistantInput = {
  appId: string;
  connectionId: string;
  bindingVersion: number;
  chatId: string;
  chatType: "p2p" | "group";
  /** Canonical principal the message acts on (the bound owner after mapping). */
  principalId: string;
  messageId: string | null;
  /** External transport event id; makes the assistant turn idempotent. */
  eventId: string;
  text: string;
};

export type LarkAssistantHookResult = {
  replyText: string;
  turnId: string;
  status?: string;
  /** True when this result came from an already-enqueued transport event
   *  (idempotent redelivery) rather than a fresh turn we just executed. */
  duplicate?: boolean;
  /** The outbox row already attached to the turn, when one exists (recovery /
   *  redelivery must not create a second delivery). */
  replyOutboxId?: string | null;
};

export type LarkAssistantHook = (
  input: LarkAssistantInput,
) => Promise<LarkAssistantHookResult | null>;

export class LarkEventInbox {
  private readonly ownerId: string;
  private readonly assistant?: LarkAssistantHook;
  private readonly media?: LarkMediaPort;
  private readonly resources?: LarkResourcePort;
  private readonly worker: DurableJobWorker;
  private readonly activeWorkers = new Set<DurableJobWorker>();
  /** Test seam: invoked after the reply outbox row is committed but before the
   *  inbox event is marked processed. Throwing here simulates a crash and must
   *  leave the outbox row in place so a restart / redelivery still delivers. */
  private readonly afterReplyEnqueued?: (info: {
    turnId: string;
    outboxId: string;
  }) => void;
  constructor(
    private readonly store: Store,
    options: {
      ownerId?: string;
      assistant?: LarkAssistantHook;
      media?: LarkMediaPort;
      resources?: LarkResourcePort;
      afterReplyEnqueued?: (info: { turnId: string; outboxId: string }) => void;
    } = {},
  ) {
    this.ownerId = options.ownerId ?? "owner";
    this.assistant = options.assistant;
    this.media = options.media;
    this.resources = options.resources;
    this.afterReplyEnqueued = options.afterReplyEnqueued;
    store.db.exec(`CREATE TABLE IF NOT EXISTS lark_message_materials(
      inbox_id TEXT PRIMARY KEY,event_json TEXT NOT NULL,raw_asset_id TEXT NOT NULL,
      resources TEXT NOT NULL DEFAULT '[]',revision_id TEXT,last_result TEXT,updated_at TEXT NOT NULL)`);
    this.worker = this.createWorker();
  }

  private createWorker(jobIds?: string[]) {
    return new DurableJobWorker(
      this.store.jobs,
      `lark-inbound-${randomUUID()}`,
      {
        lark_inbound: (job, signal) => this.processJob(job, signal),
      },
      {
        kinds: ["lark_inbound"],
        jobIds,
        fingerprint: () => ({
          model: null,
          effort: null,
          promptHash: "lark-inbound@1",
          skillHash: "lark-inbound@1",
          toolHash: "lark-inbound@1",
        }),
      },
    );
  }
  enqueue(event: LarkInboundEvent) {
    const receipt = this.persist(event);
    const queued = this.store.jobs.enqueue({
      kind: "lark_inbound",
      inputRefs: [{ inboxId: receipt.id, mode: "receive" }],
      roleVersion: "lark-inbound@1",
      policyVersion: "original-first@1",
      maxAttempts: 5,
    });
    return { ...receipt, job: queued.job };
  }
  async receive(event: LarkInboundEvent) {
    const queued = this.enqueue(event);
    if (queued.duplicate && queued.job.state === "retry_wait")
      this.store.db
        .prepare(
          "UPDATE jobs SET not_before=? WHERE id=? AND state='retry_wait'",
        )
        .run(new Date().toISOString(), queued.job.id);
    // A callback can wait for its result, while a crash leaves the same job for the host worker.
    const result = await this.processJobId(queued.job.id);
    if (result.processed && "job" in result && result.job?.lastError)
      throw Error(result.job.lastError);
    const row = this.store.db
      .prepare(
        "SELECT last_result FROM lark_message_materials WHERE inbox_id=?",
      )
      .get(queued.id);
    return row?.last_result
      ? JSON.parse(String(row.last_result))
      : { ...queued, outcome: "queued" };
  }
  material(inboxId: string) {
    const row = this.store.db
      .prepare("SELECT * FROM lark_message_materials WHERE inbox_id=?")
      .get(inboxId);
    return row
      ? {
          inboxId,
          rawAssetId: String(row.raw_asset_id),
          revisionId: row.revision_id ? String(row.revision_id) : null,
          sourceId: row.revision_id
            ? (this.store.revision(String(row.revision_id))?.sourceId ?? null)
            : null,
          resources: JSON.parse(String(row.resources)) as MessageResource[],
        }
      : null;
  }
  reprocess(
    inboxId: string,
    options: {
      mode?: "saved" | "remote";
      requestId?: string;
      replace?: boolean;
    } = {},
  ) {
    this.restoreLegacyMaterial(inboxId);
    const material = this.material(inboxId);
    if (!material) throw Error("机器人原始事件不存在");
    const queued = this.store.jobs.enqueue({
      kind: "lark_inbound",
      inputRefs: [
        {
          inboxId,
          mode: options.mode ?? "saved",
          requestId: options.requestId ?? randomUUID(),
          replace: options.replace ?? false,
        },
      ],
      roleVersion: "lark-inbound@1",
      policyVersion: "original-first@1",
      maxAttempts: 3,
      cause: "reprocess_bot_original",
    });
    return { material, job: queued.job };
  }
  private restoreLegacyMaterial(inboxId: string) {
    if (this.material(inboxId)) return;
    const row = this.store.db
      .prepare("SELECT * FROM event_inbox WHERE id=?")
      .get(inboxId);
    if (!row?.payload || !row.event_kind) return;
    const payload = JSON.parse(String(row.payload));
    const normalized = normalizeLarkEvent(
      String(row.app_id),
      String(row.event_kind) as LarkInboundEvent["kind"],
      payload,
    );
    const event: LarkInboundEvent = {
      ...normalized,
      eventId: String(row.event_id),
      eventTime: String(row.event_time),
      senderOpenId: safeString(row.sender_open_id),
      chatId: safeString(row.chat_id),
      messageId: safeString(row.message_id),
    };
    const rawAssetId = saveImportAssetSync(
      this.store.dataDir,
      Buffer.from(JSON.stringify(payload)),
    );
    const revision = this.store.db
      .prepare(
        "SELECT head FROM sources WHERE namespace='chat' AND external_id=?",
      )
      .get(`${event.appId}:${event.messageId}`);
    this.store.db
      .prepare(
        "INSERT INTO lark_message_materials(inbox_id,event_json,raw_asset_id,revision_id,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(
        inboxId,
        JSON.stringify(event),
        rawAssetId,
        revision?.head ?? null,
        new Date().toISOString(),
      );
  }
  processOnce() {
    return this.worker.processOne();
  }
  async processJobId(jobId: string) {
    const worker = this.createWorker([jobId]);
    this.activeWorkers.add(worker);
    try {
      return await worker.processOne();
    } finally {
      this.activeWorkers.delete(worker);
    }
  }
  async processSavedOnce() {
    const ids = this.store.db
      .prepare(
        "SELECT id FROM jobs WHERE kind='lark_inbound' AND json_extract(input_refs,'$[0].mode')='saved' AND state IN ('queued','retry_wait','leased','running') ORDER BY created_at LIMIT 500",
      )
      .all()
      .map((row) => String(row.id));
    if (!ids.length) return { processed: false as const };
    const worker = this.createWorker(ids);
    this.activeWorkers.add(worker);
    try {
      return await worker.processOne();
    } finally {
      this.activeWorkers.delete(worker);
    }
  }
  stop() {
    this.worker.stop();
    for (const worker of this.activeWorkers) worker.stop();
  }
  private async processJob(job: JobLease, signal: AbortSignal) {
    const ref = job.inputRefs[0] as {
      inboxId: string;
      mode: "receive" | "saved" | "remote";
      requestId?: string;
      replace?: boolean;
    };
    const row = this.store.db
      .prepare("SELECT event_json FROM lark_message_materials WHERE inbox_id=?")
      .get(ref.inboxId);
    if (!row) throw new JobExecutionError("机器人原件不存在", "permanent");
    if (signal.aborted)
      throw new JobExecutionError("收件处理已中断", "transient");
    try {
      const event = JSON.parse(String(row.event_json)) as LarkInboundEvent;
      const result = await this.processMessage(event, ref.mode, job.id);
      this.store.db
        .prepare(
          "UPDATE lark_message_materials SET last_result=?,updated_at=? WHERE inbox_id=?",
        )
        .run(JSON.stringify(result), new Date().toISOString(), ref.inboxId);
      if (
        "outcome" in result &&
        result.outcome === "needs_resources" &&
        ref.mode !== "receive"
      )
        throw new JobExecutionError(
          "部分资源没有保存原件或暂不支持理解；未排队学习。可恢复原件或明确重新读取飞书后重试",
          "config",
        );
      return { resultRef: ref.inboxId };
    } catch (error) {
      if (error instanceof JobExecutionError) throw error;
      throw new JobExecutionError(
        error instanceof Error ? error.message : "机器人收件失败",
        "transient",
      );
    }
  }

  persist(event: LarkInboundEvent) {
    const connection = this.store.db
      .prepare(
        `SELECT id,COALESCE(active_version,(
           SELECT MAX(version) FROM lark_connection_versions
           WHERE connection_id=lark_connections.id AND state='awaiting_pair'
         )) AS connection_version
         FROM lark_connections WHERE app_id=?
           AND state IN ('active','awaiting_pair')`,
      )
      .get(event.appId) as Row | undefined;
    if (!connection) throw Error("LARK_EVENT_APP_NOT_ACTIVE");
    const digest = stableDigest(event.payload);
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare(
          "SELECT * FROM event_inbox WHERE workspace_id='personal' AND app_id=? AND event_id=?",
        )
        .get(event.appId, event.eventId) as Row | undefined;
      if (existing) {
        if (existing.payload_digest !== digest)
          throw Error("LARK_EVENT_CONFLICT");
        if (!this.material(String(existing.id))) {
          const rawAssetId = saveImportAssetSync(
            this.store.dataDir,
            Buffer.from(JSON.stringify(event.payload)),
          );
          this.store.db
            .prepare(
              "INSERT INTO lark_message_materials(inbox_id,event_json,raw_asset_id,updated_at) VALUES(?,?,?,?)",
            )
            .run(
              String(existing.id),
              JSON.stringify(event),
              rawAssetId,
              new Date().toISOString(),
            );
        }
        return {
          id: String(existing.id),
          duplicate: true,
          state: String(existing.state),
        };
      }
      const id = randomUUID();
      const rawAssetId = saveImportAssetSync(
        this.store.dataDir,
        Buffer.from(JSON.stringify(event.payload)),
      );
      this.store.db
        .prepare(
          `INSERT INTO event_inbox(
             id,workspace_id,app_id,event_id,action_id,payload_digest,
             received_at,processed_at,state,connection_id,event_kind,event_time,
             sender_open_id,chat_id,message_id,payload
           ) VALUES(?,'personal',?,?,NULL,?,?,NULL,'received',?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          event.appId,
          event.eventId,
          digest,
          new Date().toISOString(),
          String(connection.id),
          event.kind,
          event.eventTime,
          event.senderOpenId,
          event.chatId,
          event.messageId,
          JSON.stringify(event.payload),
        );
      this.store.db
        .prepare(
          "INSERT INTO lark_message_materials(inbox_id,event_json,raw_asset_id,updated_at) VALUES(?,?,?,?)",
        )
        .run(id, JSON.stringify(event), rawAssetId, new Date().toISOString());
      if (connection.connection_version) {
        const version = this.store.db
          .prepare(
            `SELECT capability_profile FROM lark_connection_versions
             WHERE connection_id=? AND version=?`,
          )
          .get(String(connection.id), Number(connection.connection_version)) as
          | Row
          | undefined;
        const capability = version?.capability_profile
          ? (JSON.parse(String(version.capability_profile)) as {
              events?: string[];
            })
          : {};
        const events = [...new Set([...(capability.events ?? []), event.kind])];
        this.store.db
          .prepare(
            `UPDATE lark_connection_versions SET capability_profile=?,updated_at=?
             WHERE connection_id=? AND version=?`,
          )
          .run(
            JSON.stringify({ ...capability, events }),
            new Date().toISOString(),
            String(connection.id),
            Number(connection.connection_version),
          );
      }
      return { id, duplicate: false, state: "received" };
    });
  }

  async processMessage(
    event: LarkInboundEvent,
    mode: "receive" | "saved" | "remote" = "receive",
    requestId?: string,
  ) {
    const stored =
      mode !== "receive"
        ? this.store.db
            .prepare(
              "SELECT id,state FROM event_inbox WHERE app_id=? AND event_id=?",
            )
            .get(event.appId, event.eventId)
        : null;
    const receipt = stored
      ? { id: String(stored.id), state: String(stored.state), duplicate: true }
      : this.persist(event);
    if (mode === "receive" && receipt.duplicate && receipt.state !== "received")
      return receipt;
    // A user-requested saved replay is independent of the current bot connection.
    // It never routes an old command to the assistant or replays target changes.
    if (mode === "saved") {
      if (!event.chatId || !event.messageId)
        throw Error("此事件不是可重新理解的消息");
      const saved = this.material(receipt.id);
      const previous = saved?.revisionId
        ? this.store.revision(saved.revisionId)
        : null;
      return this.rebuildMaterial(
        event,
        receipt,
        previous?.provenance?.actorPrincipalId === this.ownerId,
        mode,
        requestId,
        previous?.provenance,
      );
    }
    if (event.kind === "im.chat.member.bot.deleted_v1" && event.chatId) {
      this.store.tx(() => {
        const binding = this.store.db
          .prepare(
            `SELECT c.id AS connection_id,b.binding_version
             FROM lark_connections c JOIN lark_bindings b
               ON b.connection_id=c.id AND b.state='active'
             WHERE c.app_id=? AND c.state='active'`,
          )
          .get(event.appId) as Row | undefined;
        this.store.db
          .prepare(
            `UPDATE lark_targets SET state='disabled',capture_enabled=0,updated_at=?
             WHERE connection_id=(SELECT id FROM lark_connections WHERE app_id=?)
               AND chat_id=?`,
          )
          .run(new Date().toISOString(), event.appId, event.chatId);
        if (binding)
          this.store.db
            .prepare(
              `INSERT INTO lark_targets(
                 id,workspace_id,connection_id,binding_version,chat_id,target_type,
                 purpose,capture_enabled,state,created_at,updated_at
               ) VALUES(?,'personal',?,?,?,'group','group_monitoring',0,
                 'disabled',?,?)
               ON CONFLICT(connection_id,binding_version,chat_id,purpose) DO UPDATE SET
                 capture_enabled=0,state='disabled',updated_at=excluded.updated_at`,
            )
            .run(
              randomUUID(),
              String(binding.connection_id),
              Number(binding.binding_version),
              event.chatId,
              new Date().toISOString(),
              new Date().toISOString(),
            );
        this.finish(receipt.id, "processed");
      });
      return { ...receipt, outcome: "target_disabled" };
    }
    if (event.kind === "im.chat.member.bot.added_v1" && event.chatId) {
      const outcome = this.store.tx(() => {
        const binding = this.store.db
          .prepare(
            `SELECT c.id AS connection_id,b.binding_version
             FROM lark_connections c JOIN lark_bindings b
               ON b.connection_id=c.id AND b.state='active'
             WHERE c.app_id=? AND c.state='active'`,
          )
          .get(event.appId) as Row | undefined;
        if (!binding) {
          this.finish(receipt.id, "processed");
          return "ignored_connection_not_active";
        }
        this.store.db
          .prepare(
            `INSERT INTO lark_targets(
               id,workspace_id,connection_id,binding_version,chat_id,target_type,
               purpose,capture_enabled,state,created_at,updated_at
             ) VALUES(?,'personal',?,?,?,'group','group_monitoring',1,
               'active',?,?)
             ON CONFLICT(connection_id,binding_version,chat_id,purpose) DO UPDATE SET
               capture_enabled=1,state='active',updated_at=excluded.updated_at`,
          )
          .run(
            randomUUID(),
            String(binding.connection_id),
            Number(binding.binding_version),
            event.chatId,
            new Date().toISOString(),
            new Date().toISOString(),
          );
        this.finish(receipt.id, "processed");
        return "monitoring_enabled";
      });
      return { ...receipt, outcome };
    }
    if (!event.chatId || !event.messageId) {
      this.finish(receipt.id, "processed");
      return { ...receipt, outcome: "ignored_incomplete" };
    }
    const connection = this.store.db
      .prepare(
        `SELECT c.id,v.capability_profile,b.id AS binding_id,b.binding_version,b.owner_open_id AS binding_owner_open_id
         FROM lark_connections c
         JOIN lark_connection_versions v ON v.connection_id=c.id
           AND v.version=c.active_version
         JOIN lark_bindings b ON b.connection_id=c.id AND b.state='active'
         WHERE c.app_id=?`,
      )
      .get(event.appId) as Row | undefined;
    if (!connection) {
      this.finish(receipt.id, "processed");
      return { ...receipt, outcome: "ignored_connection_not_active" };
    }
    const capability = JSON.parse(String(connection.capability_profile)) as {
      botOpenId?: string;
    };
    if (event.senderOpenId && event.senderOpenId === capability.botOpenId) {
      this.finish(receipt.id, "processed");
      return { ...receipt, outcome: "ignored_self" };
    }
    const bindingOwnerOpenId = safeString(connection.binding_owner_open_id);
    const isBoundOwner = Boolean(
      event.senderOpenId &&
        bindingOwnerOpenId &&
        event.senderOpenId === bindingOwnerOpenId,
    );
    if (mode !== "receive") {
      return this.rebuildMaterial(
        event,
        receipt,
        isBoundOwner,
        mode,
        requestId,
      );
    }
    if (
      this.assistant &&
      isBoundOwner &&
      (event.chatType !== "group" ||
        this.botMentioned(event, capability.botOpenId))
    ) {
      const material = await this.captureMaterial(
        event,
        receipt.id,
        isBoundOwner,
        "capture",
      );
      const saved = this.store.capture(material, {
        learning: false,
        notify: false,
      });
      this.store.db
        .prepare(
          "UPDATE lark_message_materials SET revision_id=? WHERE inbox_id=?",
        )
        .run(saved.revision.id, receipt.id);
      if (!this.completeMaterial(material))
        throw Error("消息资源尚未读取完整，原件已保留，尚未交给助手处理");
      const routed = await this.assistant({
        appId: event.appId,
        connectionId: String(connection.id),
        bindingVersion: Number(connection.binding_version),
        chatId: event.chatId,
        chatType: event.chatType === "group" ? "group" : "p2p",
        principalId: this.ownerId,
        messageId: event.messageId,
        eventId: event.eventId,
        text: event.text || "",
      });
      if (!routed) {
        this.finish(receipt.id, "processed");
        return { ...receipt, outcome: "ignored_not_allowed" };
      }
      // A superseded/cancelled turn has no reply body and must not be delivered.
      if (routed.status === "cancelled") {
        this.finish(receipt.id, "processed");
        return { ...receipt, outcome: "interrupted", turnId: routed.turnId };
      }
      const status = routed.status ?? "done";
      const inFlight = status === "pending" || status === "running";
      if (routed.duplicate) {
        if (inFlight) {
          // Concurrent redelivery while the primary turn is still executing. The
          // primary owns both inbox finish and delivery; do not finish or enqueue a
          // second reply, or we'd double-deliver. Leave the inbox for the primary.
          return {
            ...receipt,
            outcome: "assistant_reply",
            reply: routed.replyText,
            turnId: routed.turnId,
          };
        }
        if (routed.replyOutboxId) {
          // Turn already completed and already has an outbox row; the delivery
          // worker owns retries. Ack this redelivery without a second enqueue.
          this.finish(receipt.id, "processed");
          return {
            ...receipt,
            outcome: "assistant_reply",
            reply: routed.replyText,
            turnId: routed.turnId,
          };
        }
        // Recovery path: turn completed but the process crashed before the outbox
        // was written. Fall through and enqueue now; provider_uuid is deterministic
        // per turn so Lark dedupes any ambiguous prior send.
      }
      // E: persist the reply outbox (and atomically link it to the turn) BEFORE
      // marking the inbox processed. If enqueue throws, the inbox stays "received"
      // and Lark redelivers; the outbox row is never lost.
      const outboxId = this.enqueueAssistantReply(
        connection,
        event.chatId,
        routed.replyText,
        routed.turnId,
      );
      this.afterReplyEnqueued?.({ turnId: routed.turnId, outboxId });
      this.finish(receipt.id, "processed");
      return {
        ...receipt,
        outcome: "assistant_reply",
        reply: routed.replyText,
        turnId: routed.turnId,
      };
    }
    if (event.chatType === "group")
      this.store.db
        .prepare(
          `INSERT OR IGNORE INTO lark_targets(
             id,workspace_id,connection_id,binding_version,chat_id,target_type,
             purpose,capture_enabled,state,created_at,updated_at
           ) VALUES(?,'personal',?,?,?,'group','group_monitoring',1,'active',?,?)`,
        )
        .run(
          randomUUID(),
          String(connection.id),
          Number(connection.binding_version),
          event.chatId,
          new Date().toISOString(),
          new Date().toISOString(),
        );
    const target = this.store.db
      .prepare(
        `SELECT * FROM lark_targets WHERE connection_id=? AND chat_id=?
         AND purpose='group_monitoring' AND state='active' AND capture_enabled=1
         ORDER BY binding_version DESC LIMIT 1`,
      )
      .get(String(connection.id), event.chatId) as Row | undefined;
    if (event.chatType !== "group" || !target) {
      this.finish(receipt.id, "processed");
      return { ...receipt, outcome: "ignored_not_allowed" };
    }
    const material = await this.captureMaterial(
      event,
      receipt.id,
      isBoundOwner,
      "capture",
    );
    const original = this.store.capture(material, {
      learning: false,
      notify: false,
    });
    this.store.db
      .prepare(
        "UPDATE lark_message_materials SET revision_id=? WHERE inbox_id=?",
      )
      .run(original.revision.id, receipt.id);
    if (!this.completeMaterial(material)) {
      if (material.context.chat?.resources.some((r) => r.status === "failed"))
        throw Error("部分消息资源读取失败，原件已保留，可重试");
      this.finish(receipt.id, "processed");
      return {
        ...receipt,
        outcome: "needs_resources",
        revisionId: original.revision.id,
      };
    }
    const capture = this.store.inputs.ingest({
      source: "chat",
      externalId: `${event.appId}:${event.messageId}`,
      title: `飞书群消息 ${event.chatId}`,
      observedAt: event.eventTime,
      parts: material.parts,
      context: material.context,
      provenance: {
        collectorId: `lark:${event.appId}`,
        actorId: isBoundOwner ? this.ownerId : (event.senderOpenId ?? null),
        actorType: isBoundOwner ? "owner" : event.senderType,
        actorVerifiedBy: isBoundOwner
          ? `lark-binding:${connection.binding_version}`
          : null,
        sourceUri: null,
        eventId: event.eventId,
        eventAt: event.eventTime,
        timezone: null,
        quoted: Boolean(event.parentMessageId),
        forwarded: false,
        producerKind: "original",
        actorExternalId: event.senderOpenId ?? null,
        actorPrincipalId: isBoundOwner ? this.ownerId : null,
        actorBindingVersion: Number(connection.binding_version),
      },
    });
    this.finish(receipt.id, "processed");
    return { ...receipt, outcome: "captured", capture };
  }

  private async rebuildMaterial(
    event: LarkInboundEvent,
    receipt: { id: string; state: string; duplicate: boolean },
    isOwner: boolean,
    mode: "saved" | "remote",
    requestId?: string,
    originalProvenance?: CaptureInput["provenance"],
  ) {
    const input = await this.captureMaterial(event, receipt.id, isOwner, mode);
    if (originalProvenance)
      input.provenance = { ...originalProvenance, eventId: null };
    const capture = this.store.capture(input, {
      learning: false,
      notify: false,
    });
    this.store.db
      .prepare(
        "UPDATE lark_message_materials SET revision_id=? WHERE inbox_id=?",
      )
      .run(capture.revision.id, receipt.id);
    if (!this.completeMaterial(input))
      return {
        ...receipt,
        outcome: "needs_resources",
        revisionId: capture.revision.id,
        message: "原件已保存，部分资源尚未读取或不支持理解；未排队学习",
      };
    const state = this.store.db
      .prepare("SELECT validity_epoch FROM source_state WHERE source_id=?")
      .get(capture.revision.sourceId)!;
    const learning = this.store.jobs.enqueue({
      kind: "extract_claims",
      inputRefs: [
        {
          sourceId: capture.revision.sourceId,
          revisionId: capture.revision.id,
          validityEpoch: Number(state.validity_epoch),
          reprocessRequestId: requestId ?? randomUUID(),
        },
      ],
      roleVersion: "extractor@1",
      policyVersion: "memory-policy@1",
      cause: "reprocess_bot_original",
      parentJobId:
        requestId && this.store.jobs.get(requestId) ? requestId : null,
    });
    return {
      ...receipt,
      outcome: "reprocessed",
      revisionId: capture.revision.id,
      learningJobId: learning.job.id,
    };
  }

  processPairing(
    event: LarkInboundEvent,
    receiver: {
      receivePairing: (input: {
        appId: string;
        code: string;
        senderOpenId: string;
        chatId: string;
        chatType: "p2p";
      }) => unknown;
    },
  ) {
    const receipt = this.persist(event);
    if (receipt.duplicate && receipt.state !== "received") return receipt;
    const code = event.text?.trim();
    if (
      event.kind !== "im.message.receive_v1" ||
      event.chatType !== "p2p" ||
      !event.senderOpenId ||
      !event.chatId ||
      !code ||
      !/^[A-Za-z0-9_-]{32}$/.test(code)
    ) {
      this.finish(receipt.id, "processed");
      return { ...receipt, outcome: "ignored_not_pairing" };
    }
    try {
      const pairing = receiver.receivePairing({
        appId: event.appId,
        code,
        senderOpenId: event.senderOpenId,
        chatId: event.chatId,
        chatType: "p2p",
      });
      this.finish(receipt.id, "processed");
      return { ...receipt, outcome: "pairing_candidate_verified", pairing };
    } catch (error) {
      this.finish(receipt.id, "processed");
      return {
        ...receipt,
        outcome: "pairing_rejected",
        error:
          error instanceof Error
            ? error.message.replace(/[\r\n]+/g, " ").slice(0, 300)
            : "pairing rejected",
      };
    }
  }

  private botMentioned(event: LarkInboundEvent, botOpenId?: string) {
    if (!botOpenId) return false;
    const mentions = (
      event.payload as {
        message?: { mentions?: Array<{ id?: { open_id?: string } }> };
      }
    )?.message?.mentions;
    if (
      Array.isArray(mentions) &&
      mentions.some((m) => m?.id?.open_id === botOpenId)
    )
      return true;
    return typeof event.text === "string" && event.text.includes(botOpenId);
  }

  private async captureMaterial(
    event: LarkInboundEvent,
    inboxId: string,
    isOwner: boolean,
    mode: "saved" | "remote" | "capture",
  ): Promise<CaptureInput> {
    const saved = this.material(inboxId)!;
    const message = (event.payload as { message?: { content?: string } })
      ?.message;
    const resources: MessageResource[] = [...saved.resources];
    const input = await messageMaterial(
      this.store,
      {
        resource: async (messageId, key, type) => {
          if (this.resources)
            return this.resources.resource(event.appId, messageId, key, type);
          if (type === "image" && this.media) {
            const result = await this.media.downloadImage({
              appId: event.appId,
              messageId,
              imageKey: key,
            });
            return Buffer.from(result.dataBase64, "base64");
          }
          throw Error("机器人资源读取未配置，原消息已保留");
        },
      },
      {
        message_id: event.messageId!,
        chat_id: event.chatId!,
        content: message?.content ?? event.text ?? "[非文本消息]",
        create_time: event.eventTime,
        msg_type: event.messageType ?? "text",
        sender: { id: event.senderOpenId ?? undefined },
      },
      `飞书${event.chatType === "group" ? "群" : "私聊"}`,
      `bot:${event.appId}`,
      true,
      mode === "remote",
      () => {},
      {
        mode,
        savedResources: saved.resources,
        rawAssetId: saved.rawAssetId,
        readDocument: (uri) => {
          if (!this.resources?.document)
            throw Error("机器人文档读取未配置；原链接仍保留");
          return this.resources.document(event.appId, uri);
        },
        onResource: (resource) => {
          const index = resources.findIndex((r) =>
            resource.key ? r.key === resource.key : r.uri === resource.uri,
          );
          if (index >= 0) resources[index] = resource;
          else resources.push(resource);
          this.store.db
            .prepare(
              "UPDATE lark_message_materials SET resources=?,updated_at=? WHERE inbox_id=?",
            )
            .run(JSON.stringify(resources), new Date().toISOString(), inboxId);
        },
      },
    );
    const textParts =
      event.messageType === "image" ? [] : await this.buildCaptureParts(event);
    const richParts = input.input.parts.slice(1);
    const parts = [...textParts, ...richParts].map((part) => ({
      ...part,
      provenance: {
        actorExternalId: event.senderOpenId,
        actorPrincipalId: isOwner ? this.ownerId : null,
        observedAt: event.eventTime,
        eventId: event.eventId,
        replyTo: event.parentMessageId ?? null,
        quoted: Boolean(event.parentMessageId),
        forwarded: false,
        producerKind: "original" as const,
      },
    }));
    if (!parts.length)
      parts.push({
        type: "text",
        text: "[图片消息；原件尚未读取]",
        provenance: {
          actorExternalId: event.senderOpenId,
          actorPrincipalId: isOwner ? this.ownerId : null,
          observedAt: event.eventTime,
          eventId: event.eventId,
          replyTo: event.parentMessageId ?? null,
          quoted: Boolean(event.parentMessageId),
          forwarded: false,
          producerKind: "original",
        },
      });
    return {
      ...input.input,
      externalId: `${event.appId}:${event.messageId}`,
      title: `飞书消息 ${event.chatId}`,
      parts,
      context: { ...input.input.context, event: event.kind },
      provenance: {
        collectorId: `lark:${event.appId}`,
        actorId: isOwner ? this.ownerId : event.senderOpenId,
        actorType: isOwner ? "owner" : event.senderType,
        actorVerifiedBy: isOwner ? "lark-binding" : null,
        sourceUri: null,
        eventId: null,
        eventAt: event.eventTime,
        timezone: null,
        quoted: Boolean(event.parentMessageId),
        forwarded: false,
        producerKind: "original",
        actorExternalId: event.senderOpenId,
        actorPrincipalId: isOwner ? this.ownerId : null,
      },
    };
  }
  private completeMaterial(input: CaptureInput) {
    return !input.context.chat?.resources.some(
      (resource) =>
        resource.status === "failed" ||
        (resource.status === "saved" &&
          !(
            resource.kind === "image" &&
            input.parts.some((part) => part.type === "image")
          )),
    );
  }

  /**
   * H-G15: adapt a raw Lark message into unified capture parts. Text messages stay a
   * single text part; post (rich text) splits title + paragraphs into separate text
   * parts; image messages are downloaded through the media port and stored as an
   * asset-backed image part; a reply/quote carries replyTo provenance on every part.
   */
  private async buildCaptureParts(
    event: LarkInboundEvent,
  ): Promise<CaptureInput["parts"]> {
    const message = (
      event.payload as { message?: { content?: unknown } } | undefined
    )?.message;
    const rawContent =
      typeof message?.content === "string" ? message.content : null;
    let content: Record<string, unknown> | null = null;
    if (rawContent) {
      try {
        content = JSON.parse(rawContent) as Record<string, unknown>;
      } catch {
        content = null;
      }
    }
    const replyTo = event.parentMessageId ?? null;
    const withProvenance = <T extends CaptureInput["parts"][number]>(
      part: T,
    ) => ({
      ...part,
      provenance: {
        actorExternalId: event.senderOpenId ?? null,
        actorPrincipalId: null,
        observedAt: event.eventTime,
        eventId: event.eventId,
        replyTo,
        quoted: Boolean(replyTo),
        forwarded: false,
        producerKind: "original" as const,
      },
    });

    if (event.messageType === "image") {
      const imageKey =
        content && typeof content.image_key === "string"
          ? content.image_key
          : null;
      if (imageKey && this.media && event.messageId) {
        const media = await this.media.downloadImage({
          appId: event.appId,
          messageId: event.messageId,
          imageKey,
        });
        return [
          withProvenance({
            type: "image",
            mimeType: media.mimeType,
            data: media.dataBase64,
            label: "飞书图片",
          }),
        ];
      }
      return [withProvenance({ type: "text", text: "[图片消息]" })];
    }

    if (event.messageType === "post" && content) {
      const parts: CaptureInput["parts"] = [];
      if (typeof content.title === "string" && content.title.trim())
        parts.push(
          withProvenance({ type: "text", text: `【标题】${content.title}` }),
        );
      const rows = Array.isArray(content.content) ? content.content : [];
      for (const row of rows) {
        const segments: string[] = [];
        for (const node of Array.isArray(row) ? row : []) {
          if (!node || typeof node !== "object") continue;
          const tag = (node as Record<string, unknown>).tag;
          const text = (node as Record<string, unknown>).text;
          if (tag === "text" && typeof text === "string") segments.push(text);
          else if (tag === "a" && typeof text === "string") {
            const href = (node as Record<string, unknown>).href;
            segments.push(typeof href === "string" ? `${text}(${href})` : text);
          } else if (tag === "at") {
            const name = (node as Record<string, unknown>).user_name;
            if (typeof name === "string") segments.push(`@${name}`);
          } else if (tag === "img") segments.push("[图片]");
        }
        const line = segments.join("").trim();
        if (line) parts.push(withProvenance({ type: "text", text: line }));
      }
      if (parts.length) return parts;
    }

    return [
      withProvenance({ type: "text", text: event.text || "[非文本消息]" }),
    ];
  }

  private enqueueAssistantReply(
    connection: Row,
    chatId: string,
    replyText: string,
    turnId?: string,
  ): string {
    const at = new Date().toISOString();
    const changeId = randomUUID();
    const card = {
      schema: "2.0",
      config: { width_mode: "default" },
      body: {
        elements: [{ tag: "markdown", content: replyText.slice(0, 8000) }],
      },
    };
    const payloadJson = JSON.stringify(card);
    const intentId = randomUUID();
    // E: provider_uuid is deterministic per TURN (transport event id), not per
    // (chatId, replyText). Two different turns with the same reply text must each
    // send their own Lark message; a redelivery of the same turn reuses the uuid so
    // Lark dedupes any ambiguous prior send.
    const providerUuid = turnId
      ? stableDigest({ channel: "lark", chatId, turnId }).slice(0, 50)
      : stableDigest({ chatId, replyText }).slice(0, 50);
    this.store.tx(() => {
      this.store.db
        .prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?)")
        .run(
          changeId,
          "assistant_reply",
          "主助手回复",
          null,
          null,
          replyText.slice(0, 500),
          at,
        );
      this.store.db
        .prepare(
          `INSERT INTO delivery_intents(
             id,workspace_id,change_id,channel_binding_version,channel,target,
             payload_digest,provider_uuid,state,created_at,updated_at,
             binding_id,payload_json,next_attempt_at,card_action_id,
             aggregation_mode,aggregate_after
           ) VALUES(?,'personal',?,?, 'lark',?,?,?, 'pending',?,?,?,?,?,NULL,'instant',NULL)`,
        )
        .run(
          intentId,
          changeId,
          Number(connection.binding_version),
          chatId,
          stableDigest(card),
          providerUuid,
          at,
          at,
          String(connection.binding_id),
          payloadJson,
          at,
        );
      this.store.db
        .prepare(
          "INSERT INTO delivery_intent_changes(intent_id,change_id,ordinal) VALUES(?,?,0)",
        )
        .run(intentId, changeId);
      // E: link the turn to the outbox row in the SAME transaction, so a turn never
      // has a dangling outbox reference or an orphaned pending delivery.
      if (turnId)
        this.store.db
          .prepare("UPDATE conversation_turns SET reply_outbox_id=? WHERE id=?")
          .run(intentId, turnId);
    });
    return intentId;
  }

  private finish(inboxId: string, state: "processed" | "failed") {
    this.store.db
      .prepare("UPDATE event_inbox SET state=?,processed_at=? WHERE id=?")
      .run(state, new Date().toISOString(), inboxId);
  }
}

export class LarkConnectionManager {
  private handle?: { close: () => void };
  private heartbeat?: ReturnType<typeof setInterval>;
  private token?: string;

  constructor(
    private readonly db: DatabaseSync,
    private readonly leases: LarkConnectionLeaseRepository,
    private readonly secrets: EncryptedSecretStore,
    private readonly adapter: LarkRealtimeAdapter,
    private readonly inbox: LarkEventInbox,
    private readonly workerId: string,
    private readonly cardActions?: {
      enqueue: (event: LarkInboundEvent) => unknown;
    },
    private readonly pairing?: {
      receivePairing: (input: {
        appId: string;
        code: string;
        senderOpenId: string;
        chatId: string;
        chatType: "p2p";
      }) => unknown;
    },
  ) {}

  isRunning() {
    return Boolean(this.handle && this.token);
  }

  start(connectionId: string, now = new Date(), leaseMs = 60_000) {
    const token = this.leases.claim(connectionId, this.workerId, now, leaseMs);
    if (!token) return false;
    const row = this.db
      .prepare(
        `SELECT c.app_id,c.tenant_brand,v.version AS connection_version,
           v.secret_ref FROM lark_connections c
         JOIN lark_connection_versions v ON v.id=(
           SELECT candidate.id FROM lark_connection_versions candidate
           WHERE candidate.connection_id=c.id
             AND candidate.state IN ('active','awaiting_pair')
           ORDER BY CASE candidate.state WHEN 'awaiting_pair' THEN 0 ELSE 1 END,
             candidate.version DESC LIMIT 1
         )
         WHERE c.id=? AND c.state IN ('active','awaiting_pair')`,
      )
      .get(connectionId) as Row | undefined;
    if (!row) {
      this.leases.release(connectionId, token);
      throw Error("LARK_CONNECTION_NOT_ACTIVE");
    }
    const credentials = this.secrets.get(String(row.secret_ref));
    this.token = token;
    const recordState = (state: string, error?: string) =>
      this.db
        .prepare(
          "INSERT INTO lark_connection_events(id,connection_id,state,error,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          connectionId,
          state,
          error
            ?.replaceAll(credentials.clientSecret, "[REDACTED]")
            .replace(/\b(?:cli_|sk-|ghp_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
            .replace(/[\r\n]+/g, " ")
            .slice(0, 1000) ?? null,
          new Date().toISOString(),
        );
    this.handle = this.adapter.connect({
      appId: String(row.app_id),
      clientSecret: credentials.clientSecret,
      tenantBrand: row.tenant_brand === "lark" ? "lark" : "feishu",
      onEvent: (event) => {
        if (event.kind === "card.action.trigger" && this.cardActions)
          return this.cardActions.enqueue(event);
        if (
          event.kind === "im.message.receive_v1" &&
          event.chatType === "p2p" &&
          this.pairing &&
          /^[A-Za-z0-9_-]{32}$/.test(event.text?.trim() ?? "")
        )
          return this.inbox.processPairing(event, this.pairing);
        return this.inbox.receive(event);
      },
      onState: recordState,
    });
    this.heartbeat = setInterval(
      () => {
        try {
          const current = this.db
            .prepare(
              `SELECT v.version FROM lark_connections c
               JOIN lark_connection_versions v ON v.id=(
                 SELECT candidate.id FROM lark_connection_versions candidate
                 WHERE candidate.connection_id=c.id
                   AND candidate.state IN ('active','awaiting_pair')
                 ORDER BY CASE candidate.state WHEN 'awaiting_pair' THEN 0 ELSE 1 END,
                   candidate.version DESC LIMIT 1
               ) WHERE c.id=? AND c.state IN ('active','awaiting_pair')`,
            )
            .get(connectionId) as Row | undefined;
          if (
            !current ||
            Number(current.version) !== Number(row.connection_version)
          ) {
            this.stop(connectionId);
            return;
          }
          this.leases.heartbeat(connectionId, token, new Date(), leaseMs);
        } catch {
          this.stop(connectionId);
        }
      },
      Math.max(1000, leaseMs / 3),
    );
    this.heartbeat.unref();
    return true;
  }

  stop(connectionId: string) {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.handle?.close();
    if (this.token) this.leases.release(connectionId, this.token);
    this.handle = undefined;
    this.token = undefined;
  }
}
