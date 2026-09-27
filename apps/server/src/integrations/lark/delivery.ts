import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Client, Domain } from "@larksuiteoapi/node-sdk";
import { stableDigest } from "../../storage/digest.js";
import { EncryptedSecretStore } from "./secret-store.js";

type Row = Record<string, unknown>;
type DeliveryLease = {
  id: string;
  workspaceId: string;
  changeId: string;
  bindingId: string;
  target: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  providerUuid: string;
  attempt: number;
  leaseToken: string;
  appId: string;
  tenantBrand: "feishu" | "lark";
  secretRef: string;
};

export class LarkDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: "rate_limit" | "auth" | "permanent" | "ambiguous",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LarkDeliveryError";
  }
}

export interface LarkMessageAdapter {
  send(input: {
    appId: string;
    clientSecret: string;
    tenantBrand: "feishu" | "lark";
    chatId: string;
    card: Record<string, unknown>;
    uuid: string;
  }): Promise<{ messageId: string }>;
  update(input: {
    appId: string;
    clientSecret: string;
    tenantBrand: "feishu" | "lark";
    messageId: string;
    card: Record<string, unknown>;
  }): Promise<void>;
}

const numberValue = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const classifyLarkError = (error: unknown, sensitive: string[] = []) => {
  const redact = (value: string) =>
    sensitive
      .filter(Boolean)
      .reduce((result, item) => result.replaceAll(item, "[REDACTED]"), value);
  if (error instanceof LarkDeliveryError)
    return new LarkDeliveryError(
      redact(error.message),
      error.kind,
      error.retryAfterMs,
    );
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    response?: {
      status?: unknown;
      headers?: Record<string, unknown>;
      data?: { code?: unknown; msg?: unknown };
    };
  };
  const code =
    numberValue(candidate?.response?.data?.code) ??
    numberValue(candidate?.code);
  const status = numberValue(candidate?.response?.status);
  const retryHeader =
    candidate?.response?.headers?.["retry-after"] ??
    candidate?.response?.headers?.["Retry-After"];
  const retryAfterSeconds = Number(retryHeader);
  const retryAfterMs = Number.isFinite(retryAfterSeconds)
    ? Math.max(0, retryAfterSeconds * 1000)
    : undefined;
  const message = redact(
    typeof candidate?.response?.data?.msg === "string"
      ? candidate.response.data.msg
      : typeof candidate?.message === "string"
        ? candidate.message
        : "Lark request failed",
  );
  if (status === 429 || code === 99991400)
    return new LarkDeliveryError(message, "rate_limit", retryAfterMs);
  if (
    status === 401 ||
    status === 403 ||
    [99991663, 99991668, 99991671, 99991672].includes(code ?? -1)
  )
    return new LarkDeliveryError(message, "auth");
  const transportCode = String(candidate?.code ?? "");
  if (
    (status !== undefined && status >= 500) ||
    /ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|UND_ERR/i.test(
      transportCode + message,
    )
  )
    return new LarkDeliveryError(message, "ambiguous");
  return new LarkDeliveryError(message, "permanent");
};

export class OfficialLarkMessageAdapter implements LarkMessageAdapter {
  async send(input: Parameters<LarkMessageAdapter["send"]>[0]) {
    const client = new Client({
      appId: input.appId,
      appSecret: input.clientSecret,
      domain: input.tenantBrand === "lark" ? Domain.Lark : Domain.Feishu,
    });
    try {
      const response = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: input.chatId,
          msg_type: "interactive",
          content: JSON.stringify(input.card),
          uuid: input.uuid,
        },
      });
      if (response.code && response.code !== 0)
        throw classifyLarkError({
          code: response.code,
          message: `Lark send failed (${response.code})`,
        });
      const messageId = response.data?.message_id;
      if (!messageId)
        throw new LarkDeliveryError(
          "Lark send response had no message id",
          "ambiguous",
        );
      return { messageId };
    } catch (error) {
      throw classifyLarkError(error, [input.clientSecret]);
    }
  }

  async update(input: Parameters<LarkMessageAdapter["update"]>[0]) {
    const client = new Client({
      appId: input.appId,
      appSecret: input.clientSecret,
      domain: input.tenantBrand === "lark" ? Domain.Lark : Domain.Feishu,
    });
    try {
      const response = await client.im.message.patch({
        path: { message_id: input.messageId },
        data: { content: JSON.stringify(input.card) },
      });
      if (response.code && response.code !== 0)
        throw classifyLarkError({
          code: response.code,
          message: `Lark update failed (${response.code})`,
        });
    } catch (error) {
      throw classifyLarkError(error, [input.clientSecret]);
    }
  }
}

const safeError = (error: Error) =>
  error.message
    .replace(/\b(?:cli_|sk-|ghp_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);

export class LarkDeliveryRepository {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T) {
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

  claim(
    workerId: string,
    now = new Date(),
    leaseMs = 60_000,
  ): DeliveryLease | null {
    const at = now.toISOString();
    return this.transaction(() => {
      while (true) {
        const row = this.db
          .prepare(
            `SELECT i.*,b.connection_id,b.state AS binding_state,
               c.app_id,c.tenant_brand,c.state AS connection_state,v.secret_ref,
               s.state AS annotation_session_state
             FROM delivery_intents i
             JOIN lark_bindings b ON b.id=i.binding_id
             JOIN lark_connections c ON c.id=b.connection_id
             JOIN lark_connection_versions v ON v.connection_id=c.id
               AND v.version=b.connection_version
             LEFT JOIN quality_annotation_sessions s ON s.id=i.annotation_session_id
             WHERE i.channel='lark' AND
               ((i.state IN ('pending','retry_wait') AND
                 COALESCE(i.next_attempt_at,i.created_at)<=?) OR
                (i.state='sending' AND i.lease_expires_at<=?))
             ORDER BY COALESCE(i.next_attempt_at,i.created_at),i.created_at LIMIT 1`,
          )
          .get(at, at) as Row | undefined;
        if (!row) return null;
        const firstSentAt = row.first_sent_at
          ? Date.parse(String(row.first_sent_at))
          : Number.NaN;
        if (
          Number.isFinite(firstSentAt) &&
          now.getTime() - firstSentAt >= 3_600_000 &&
          (row.state === "sending" || row.error_kind === "ambiguous")
        ) {
          const message =
            "delivery outcome unknown after provider dedupe window";
          this.db
            .prepare(
              `UPDATE delivery_intents SET state='unknown',updated_at=?,
                 next_attempt_at=NULL,last_error=?,error_kind='ambiguous',
                 lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
            )
            .run(at, message, String(row.id));
          this.db
            .prepare(
              `UPDATE deliveries SET state='unknown',error=?,ended_at=?
               WHERE intent_id=? AND state='sending'`,
            )
            .run(message, at, String(row.id));
          continue;
        }
        if (row.connection_state !== "active") {
          const message = "connection inactive";
          this.db
            .prepare(
              "UPDATE delivery_intents SET state='failed',updated_at=?,last_error=? WHERE id=?",
            )
            .run(at, message, String(row.id));
          this.db
            .prepare(
              `UPDATE deliveries SET state='failed',error=?,ended_at=?
               WHERE intent_id=? AND state='sending'`,
            )
            .run(message, at, String(row.id));
          continue;
        }
        if (row.binding_state !== "active") {
          const message = "binding superseded";
          this.db
            .prepare(
              "UPDATE delivery_intents SET state='cancelled',updated_at=?,last_error=? WHERE id=?",
            )
            .run(at, message, String(row.id));
          this.db
            .prepare(
              `UPDATE deliveries SET state='failed',error=?,ended_at=?
               WHERE intent_id=? AND state='sending'`,
            )
            .run(message, at, String(row.id));
          continue;
        }
        // F9: never send a card for an annotation session that is no longer
        // active (cancelled / completed / expired). The cancel transaction
        // already sweeps pending/retry_wait intents; this guard also covers the
        // race window and intents that reached retry_wait after an ambiguous
        // failure. Delivered history and genuinely in-flight leases are untouched.
        if (
          row.annotation_session_id != null &&
          row.annotation_session_state !== "active"
        ) {
          const message = `annotation session ${String(row.annotation_session_state)}; card suppressed before send`;
          this.db
            .prepare(
              `UPDATE delivery_intents SET state='cancelled',updated_at=?,
                 last_error=?,next_attempt_at=NULL,
                 lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
               WHERE id=?`,
            )
            .run(at, message, String(row.id));
          this.db
            .prepare(
              `UPDATE deliveries SET state='failed',error=?,ended_at=?
               WHERE intent_id=? AND state='sending'`,
            )
            .run(message, at, String(row.id));
          continue;
        }
        const leaseToken = randomUUID();
        const attempt = Number(row.attempt_count) + 1;
        const changed = this.db
          .prepare(
            `UPDATE delivery_intents SET state='sending',attempt_count=?,
               lease_owner=?,lease_token=?,lease_expires_at=?,
               first_sent_at=COALESCE(first_sent_at,?),last_sent_at=?,updated_at=?
             WHERE id=? AND state=?`,
          )
          .run(
            attempt,
            workerId,
            leaseToken,
            new Date(now.getTime() + leaseMs).toISOString(),
            at,
            at,
            at,
            String(row.id),
            String(row.state),
          );
        if (Number(changed.changes) !== 1) continue;
        this.db
          .prepare(
            `INSERT INTO deliveries(
               id,workspace_id,intent_id,attempt,state,receipt,error,
               started_at,ended_at,provider_uuid
             ) VALUES(?,?,?,?, 'sending',NULL,NULL,?,NULL,?)`,
          )
          .run(
            randomUUID(),
            String(row.workspace_id),
            String(row.id),
            attempt,
            at,
            String(row.provider_uuid),
          );
        return {
          id: String(row.id),
          workspaceId: String(row.workspace_id),
          changeId: String(row.change_id),
          bindingId: String(row.binding_id),
          target: String(row.target),
          payload: JSON.parse(String(row.payload_json)),
          payloadDigest: String(row.payload_digest),
          providerUuid: String(row.provider_uuid),
          attempt,
          leaseToken,
          appId: String(row.app_id),
          tenantBrand: row.tenant_brand === "lark" ? "lark" : "feishu",
          secretRef: String(row.secret_ref),
        };
      }
    });
  }

  delivered(lease: DeliveryLease, messageId: string, now = new Date()) {
    return this.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE delivery_intents SET state='delivered',message_id=?,updated_at=?,
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,last_error=NULL,
             error_kind=NULL WHERE id=? AND lease_token=? AND state='sending'`,
        )
        .run(messageId, now.toISOString(), lease.id, lease.leaseToken);
      if (Number(changed.changes) !== 1) throw Error("STALE_DELIVERY_LEASE");
      this.db
        .prepare(
          `UPDATE deliveries SET state='delivered',receipt=?,ended_at=?
           WHERE intent_id=? AND attempt=?`,
        )
        .run(
          JSON.stringify({ messageId }),
          now.toISOString(),
          lease.id,
          lease.attempt,
        );
      this.db
        .prepare(
          `UPDATE lark_card_actions SET message_id=?
           WHERE id=(SELECT card_action_id FROM delivery_intents WHERE id=?)`,
        )
        .run(messageId, lease.id);
      this.db
        .prepare(
          `UPDATE quality_annotation_sessions SET message_id=?,updated_at=?
           WHERE id=(SELECT annotation_session_id FROM delivery_intents WHERE id=?)`,
        )
        .run(messageId, now.toISOString(), lease.id);
    });
  }

  failed(lease: DeliveryLease, error: LarkDeliveryError, now = new Date()) {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM delivery_intents WHERE id=? AND lease_token=?")
        .get(lease.id, lease.leaseToken) as Row | undefined;
      if (!row) throw Error("STALE_DELIVERY_LEASE");
      const firstSent = Date.parse(String(row.first_sent_at));
      const withinDedupeWindow = now.getTime() - firstSent < 3_600_000;
      const retry =
        Number(row.attempt_count) < 5 &&
        (error.kind === "rate_limit" ||
          (error.kind === "ambiguous" && withinDedupeWindow));
      const state =
        error.kind === "ambiguous" && !withinDedupeWindow
          ? "unknown"
          : retry
            ? "retry_wait"
            : "failed";
      const delay =
        error.retryAfterMs ?? Math.min(60_000, 1000 * 2 ** (lease.attempt - 1));
      const message = safeError(error);
      this.db
        .prepare(
          `UPDATE delivery_intents SET state=?,next_attempt_at=?,error_kind=?,
             last_error=?,updated_at=?,lease_owner=NULL,lease_token=NULL,
             lease_expires_at=NULL WHERE id=?`,
        )
        .run(
          state,
          retry ? new Date(now.getTime() + delay).toISOString() : null,
          error.kind,
          message,
          now.toISOString(),
          lease.id,
        );
      this.db
        .prepare(
          `UPDATE deliveries SET state=?,error=?,ended_at=?
           WHERE intent_id=? AND attempt=?`,
        )
        .run(state, message, now.toISOString(), lease.id, lease.attempt);
      if (error.kind === "auth") {
        this.db
          .prepare(
            `UPDATE lark_targets SET state='disabled',capture_enabled=0,updated_at=?
             WHERE connection_id=(SELECT connection_id FROM lark_bindings WHERE id=?)`,
          )
          .run(now.toISOString(), lease.bindingId);
        this.db
          .prepare(
            `UPDATE lark_connections SET state='failed',updated_at=?
             WHERE id=(SELECT connection_id FROM lark_bindings WHERE id=?)`,
          )
          .run(now.toISOString(), lease.bindingId);
        this.db
          .prepare(
            `UPDATE delivery_intents SET state='failed',next_attempt_at=NULL,
               error_kind='auth',last_error=?,updated_at=?
             WHERE id<>? AND state IN ('pending','retry_wait')
               AND binding_id IN (
                 SELECT id FROM lark_bindings WHERE connection_id=(
                   SELECT connection_id FROM lark_bindings WHERE id=?
                 )
               )`,
          )
          .run(message, now.toISOString(), lease.id, lease.bindingId);
      }
      return state;
    });
  }
}

export class LarkNotificationBatcher {
  constructor(private readonly db: DatabaseSync) {}

  prepareDue(now = new Date()) {
    const at = now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const seeds = this.db
        .prepare(
          `SELECT * FROM delivery_intents
           WHERE channel='lark' AND state='pending'
             AND aggregation_mode IN ('window','scheduled')
             AND aggregate_after<=? AND superseded_by IS NULL
           ORDER BY aggregate_after,created_at`,
        )
        .all(at) as Row[];
      let batches = 0;
      let changes = 0;
      const consumed = new Set<string>();
      for (const seed of seeds) {
        if (consumed.has(String(seed.id))) continue;
        const members = this.db
          .prepare(
            `SELECT * FROM delivery_intents
             WHERE channel='lark' AND state='pending'
               AND workspace_id=? AND binding_id=? AND target=?
               AND aggregation_mode=? AND created_at<=?
               AND superseded_by IS NULL
             ORDER BY created_at,id`,
          )
          .all(
            String(seed.workspace_id),
            String(seed.binding_id),
            String(seed.target),
            String(seed.aggregation_mode),
            String(seed.aggregate_after),
          ) as Row[];
        if (!members.length) continue;
        const primary = members[0]!;
        const memberIds = members.map((member) => String(member.id));
        memberIds.forEach((id) => consumed.add(id));
        const placeholders = memberIds.map(() => "?").join(",");
        const mapped = this.db
          .prepare(
            `SELECT DISTINCT m.change_id,c.title,c.details,c.created_at
             FROM delivery_intent_changes m
             JOIN changes c ON c.id=m.change_id
             WHERE m.intent_id IN (${placeholders})
             ORDER BY c.created_at,m.change_id`,
          )
          .all(...memberIds) as Row[];
        if (!mapped.length)
          throw Error("LARK_AGGREGATION_CHANGE_MAPPING_MISSING");
        if (members.length === 1 && mapped.length === 1) {
          this.db
            .prepare(
              `UPDATE delivery_intents SET aggregation_mode='instant',
                 aggregate_after=NULL,next_attempt_at=?,updated_at=? WHERE id=?`,
            )
            .run(at, at, String(primary.id));
          batches++;
          changes++;
          continue;
        }
        const title = `omem 变更摘要（${mapped.length} 项）`;
        const summary = mapped
          .map(
            (change, index) =>
              `${index + 1}. **${String(change.title).slice(0, 200)}**\n${String(
                change.details,
              ).slice(0, 1000)}`,
          )
          .join("\n\n")
          .slice(0, 8000);
        const payload = {
          schema: "2.0",
          config: { width_mode: "default" },
          header: {
            title: { tag: "plain_text", content: title },
            template: "green",
          },
          body: { elements: [{ tag: "markdown", content: summary }] },
        };
        const payloadJson = JSON.stringify(payload);
        if (Buffer.byteLength(payloadJson) > 30_000)
          throw Error("LARK_CARD_PAYLOAD_TOO_LARGE");
        const changeIds = mapped.map((change) => String(change.change_id));
        this.db
          .prepare(
            `UPDATE delivery_intents SET payload_json=?,payload_digest=?,
               provider_uuid=?,aggregation_mode='instant',aggregate_after=NULL,
               next_attempt_at=?,updated_at=? WHERE id=?`,
          )
          .run(
            payloadJson,
            stableDigest(payload),
            stableDigest({
              mode: seed.aggregation_mode,
              bindingId: seed.binding_id,
              target: seed.target,
              changeIds,
            }).slice(0, 50),
            at,
            at,
            String(primary.id),
          );
        this.db
          .prepare("DELETE FROM delivery_intent_changes WHERE intent_id=?")
          .run(String(primary.id));
        changeIds.forEach((changeId, ordinal) =>
          this.db
            .prepare(
              `INSERT INTO delivery_intent_changes(intent_id,change_id,ordinal)
               VALUES(?,?,?)`,
            )
            .run(String(primary.id), changeId, ordinal),
        );
        for (const member of members.slice(1))
          this.db
            .prepare(
              `UPDATE delivery_intents SET state='cancelled',superseded_by=?,
                 last_error='aggregated into another intent',next_attempt_at=NULL,
                 updated_at=? WHERE id=?`,
            )
            .run(String(primary.id), at, String(member.id));
        batches++;
        changes += mapped.length;
      }
      this.db.exec("COMMIT");
      return { batches, changes };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class LarkDeliveryWorker {
  constructor(
    private readonly repository: LarkDeliveryRepository,
    private readonly secrets: EncryptedSecretStore,
    private readonly adapter: LarkMessageAdapter,
    private readonly workerId: string,
  ) {}

  async processOne(now = new Date()) {
    const lease = this.repository.claim(this.workerId, now);
    if (!lease) return { processed: false as const };
    let attemptedSecret: string | undefined;
    try {
      const secret = this.secrets.get(lease.secretRef);
      attemptedSecret = secret.clientSecret;
      if (secret.appId !== lease.appId)
        throw new LarkDeliveryError("LARK_SECRET_APP_MISMATCH", "auth");
      if (stableDigest(lease.payload) !== lease.payloadDigest)
        throw new LarkDeliveryError(
          "LARK_DELIVERY_PAYLOAD_DIGEST_MISMATCH",
          "permanent",
        );
      if (Buffer.byteLength(JSON.stringify(lease.payload)) > 30_000)
        throw new LarkDeliveryError("LARK_CARD_PAYLOAD_TOO_LARGE", "permanent");
      const result = await this.adapter.send({
        appId: lease.appId,
        clientSecret: secret.clientSecret,
        tenantBrand: lease.tenantBrand,
        chatId: lease.target,
        card: lease.payload,
        uuid: lease.providerUuid,
      });
      this.repository.delivered(lease, result.messageId, now);
      return {
        processed: true as const,
        state: "delivered",
        messageId: result.messageId,
      };
    } catch (error) {
      const classified = classifyLarkError(
        error,
        attemptedSecret ? [attemptedSecret] : [],
      );
      const state = this.repository.failed(lease, classified, now);
      return { processed: true as const, state };
    }
  }
}
