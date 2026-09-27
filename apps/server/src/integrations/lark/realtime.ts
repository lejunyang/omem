import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import type { Store } from "../../store.js";
import { stableDigest } from "../../storage/digest.js";
import { EncryptedSecretStore } from "./secret-store.js";

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
  text?: string;
  payload: unknown;
};

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

export class LarkEventInbox {
  constructor(private readonly store: Store) {}

  persist(event: LarkInboundEvent) {
    const connection = this.store.db
      .prepare(
        "SELECT id FROM lark_connections WHERE app_id=? AND state IN ('active','awaiting_pair')",
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
        return {
          id: String(existing.id),
          duplicate: true,
          state: String(existing.state),
        };
      }
      const id = randomUUID();
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
      return { id, duplicate: false, state: "received" };
    });
  }

  processMessage(event: LarkInboundEvent) {
    const receipt = this.persist(event);
    if (receipt.duplicate && receipt.state !== "received") return receipt;
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
        `SELECT c.id,v.capability_profile,b.binding_version
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
    const capture = this.store.inputs.ingest({
      source: "chat",
      externalId: `${event.appId}:${event.messageId}`,
      title: `飞书群消息 ${event.chatId}`,
      observedAt: event.eventTime,
      parts: [{ type: "text", text: event.text || "[非文本消息]" }],
      context: { conversationId: event.chatId, event: event.kind },
      provenance: {
        collectorId: `lark:${event.appId}`,
        actorId: event.senderOpenId,
        actorType: event.senderType,
        actorVerifiedBy: "lark-websocket",
        sourceUri: null,
        eventId: event.eventId,
        eventAt: event.eventTime,
        timezone: null,
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    });
    this.finish(receipt.id, "processed");
    return { ...receipt, outcome: "captured", capture };
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
          this.pairing
        )
          return this.inbox.processPairing(event, this.pairing);
        return this.inbox.processMessage(event);
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
