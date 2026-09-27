import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../../store.js";
import { MemoryService } from "../../memory/service.js";
import { stableDigest } from "../../storage/digest.js";
import { LarkDeliveryError, type LarkMessageAdapter } from "./delivery.js";
import type { LarkInboundEvent } from "./realtime.js";
import { LarkEventInbox } from "./realtime.js";
import { EncryptedSecretStore } from "./secret-store.js";

type Row = Record<string, unknown>;

const callbackValueSchema = z
  .object({
    protocol: z.literal("omem.decision.v1"),
    cardActionId: z.string().uuid(),
    action: z.enum(["approve", "reject", "request_context"]),
    nonce: z.string().min(32).max(200),
    proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime({ offset: true }),
    expectedVersionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

type CallbackValue = z.infer<typeof callbackValueSchema>;

type CardCommandLease = {
  id: string;
  inboxId: string;
  cardActionId: string;
  action: CallbackValue["action"];
  attempt: number;
  leaseToken: string;
  decisionId: string;
  proposalDigest: string;
  operatorOpenId: string;
  ownerActorId: string;
  messageId: string;
  appId: string;
  tenantBrand: "feishu" | "lark";
  secretRef: string;
  bindingId: string;
};

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const safeError = (error: unknown, sensitive: string[] = []) =>
  sensitive
    .filter(Boolean)
    .reduce(
      (message, item) => message.replaceAll(item, "[REDACTED]"),
      error instanceof Error ? error.message : "card command failed",
    )
    .replace(/\b(?:cli_|sk-|ghp_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);

const resultCard = (state: string, action: string, detail?: string) => {
  const approved = state === "approved";
  const rejected = state === "rejected";
  const context = state === "context_requested";
  const label = approved
    ? "已批准"
    : rejected
      ? "已拒绝"
      : context
        ? "等待补充背景"
        : state === "stale" || state === "expired"
          ? "资料已变化或请求已过期，请重新查看"
          : "未执行";
  return {
    schema: "2.0",
    config: { width_mode: "default", update_multi: true },
    header: {
      title: { tag: "plain_text", content: "omem 决策结果" },
      template: approved ? "green" : rejected ? "red" : "orange",
    },
    body: {
      elements: [
        { tag: "markdown", content: `**${label}**\n动作：\`${action}\`` },
        ...(detail
          ? [{ tag: "markdown", content: detail.slice(0, 1000) }]
          : []),
      ],
    },
  };
};

export class LarkCardActionService {
  private readonly inbox: LarkEventInbox;

  constructor(
    private readonly store: Store,
    private readonly memory: MemoryService,
    private readonly secrets: EncryptedSecretStore,
    private readonly adapter: LarkMessageAdapter,
    private readonly workerId: string,
  ) {
    this.inbox = new LarkEventInbox(store);
  }

  private reject(inboxId: string, reason: string) {
    this.store.db
      .prepare(
        "UPDATE event_inbox SET state='failed',processed_at=? WHERE id=? AND state<>'processed'",
      )
      .run(new Date().toISOString(), inboxId);
    return {
      accepted: false as const,
      reason,
      toast: { type: "error", content: "操作无效或已失效，请刷新后重试" },
    };
  }

  enqueue(event: LarkInboundEvent, now = new Date()) {
    if (event.kind !== "card.action.trigger")
      throw Error("LARK_CARD_EVENT_REQUIRED");
    const receipt = this.inbox.persist(event);
    const existing = this.store.db
      .prepare("SELECT * FROM lark_card_commands WHERE inbox_id=?")
      .get(receipt.id) as Row | undefined;
    if (existing)
      return {
        accepted: true as const,
        duplicate: true,
        commandId: String(existing.id),
        toast: { type: "info", content: "该操作已收到，正在处理" },
      };
    if (receipt.duplicate && receipt.state !== "received")
      return this.reject(receipt.id, "LARK_CARD_EVENT_ALREADY_REJECTED");

    const payload = event.payload as {
      action?: { value?: unknown };
      context?: { open_message_id?: unknown; open_chat_id?: unknown };
      open_message_id?: unknown;
      open_chat_id?: unknown;
    };
    const parsed = callbackValueSchema.safeParse(payload?.action?.value);
    if (!parsed.success)
      return this.reject(receipt.id, "LARK_CARD_ACTION_INVALID");
    const value = parsed.data;
    const messageId = event.messageId;
    const chatId = event.chatId;
    const operatorOpenId = event.senderOpenId;
    if (!messageId || !chatId || !operatorOpenId)
      return this.reject(receipt.id, "LARK_CARD_CONTEXT_MISSING");

    return this.store.tx(() => {
      const row = this.store.db
        .prepare(
          `SELECT a.*,d.expected_versions,d.owner_binding,d.state AS decision_state,
             d.request_id,b.state AS binding_state,c.app_id,c.state AS connection_state
           FROM lark_card_actions a
           JOIN decisions d ON d.id=a.decision_id
           JOIN lark_bindings b ON b.id=a.binding_id
           JOIN lark_connections c ON c.id=b.connection_id
           WHERE a.id=?`,
        )
        .get(value.cardActionId) as Row | undefined;
      if (
        row?.state === "pending" &&
        String(row.expires_at) <= now.toISOString()
      ) {
        this.store.db
          .prepare(
            "UPDATE lark_card_actions SET state='expired' WHERE id=? AND state='pending'",
          )
          .run(value.cardActionId);
        this.store.db
          .prepare(
            "UPDATE decisions SET state='expired' WHERE id=? AND state='pending'",
          )
          .run(String(row.decision_id));
      }
      const valid =
        row &&
        row.app_id === event.appId &&
        row.connection_state === "active" &&
        row.binding_state === "active" &&
        row.operator_open_id === operatorOpenId &&
        row.chat_id === chatId &&
        row.message_id === messageId &&
        row.proposal_digest === value.proposalDigest &&
        row.expires_at === value.expiresAt &&
        safeEqual(String(row.nonce_hash), stableDigest(value.nonce)) &&
        safeEqual(
          stableDigest(JSON.parse(String(row.expected_versions))),
          value.expectedVersionsDigest,
        ) &&
        row.state === "pending" &&
        row.decision_state === "pending" &&
        !row.request_id &&
        String(row.expires_at) > now.toISOString();
      if (!valid) return this.reject(receipt.id, "LARK_CARD_ACTION_REJECTED");

      const commandId = randomUUID();
      const consumed = this.store.db
        .prepare(
          `UPDATE lark_card_actions SET state='consumed',consumed_at=?
           WHERE id=? AND state='pending'`,
        )
        .run(now.toISOString(), value.cardActionId);
      if (Number(consumed.changes) !== 1)
        return this.reject(receipt.id, "LARK_CARD_ACTION_ALREADY_CONSUMED");
      this.store.db
        .prepare(
          `INSERT INTO lark_card_commands(
             id,inbox_id,card_action_id,action,state,attempt_count,next_attempt_at,
             lease_owner,lease_token,lease_expires_at,result_json,error,created_at,
             processed_at
           ) VALUES(?,?,?,?,'queued',0,?,NULL,NULL,NULL,NULL,NULL,?,NULL)`,
        )
        .run(
          commandId,
          receipt.id,
          value.cardActionId,
          value.action,
          now.toISOString(),
          now.toISOString(),
        );
      this.store.db
        .prepare(
          `UPDATE event_inbox SET action_id=?,state='processed',processed_at=?
           WHERE id=?`,
        )
        .run(value.cardActionId, now.toISOString(), receipt.id);
      return {
        accepted: true as const,
        duplicate: false,
        commandId,
        toast: { type: "info", content: "已收到，正在核验并处理" },
      };
    });
  }

  private claim(now = new Date(), leaseMs = 60_000): CardCommandLease | null {
    const at = now.toISOString();
    return this.store.tx(() => {
      const row = this.store.db
        .prepare(
          `SELECT q.*,a.decision_id,a.proposal_digest,a.operator_open_id,a.message_id,
             a.binding_id,d.owner_binding,b.connection_version,c.app_id,c.tenant_brand,
             v.secret_ref
           FROM lark_card_commands q
           JOIN lark_card_actions a ON a.id=q.card_action_id
           JOIN decisions d ON d.id=a.decision_id
           JOIN lark_bindings b ON b.id=a.binding_id
           JOIN lark_connections c ON c.id=b.connection_id
           JOIN lark_connection_versions v ON v.connection_id=c.id
             AND v.version=b.connection_version
           WHERE ((q.state IN ('queued','retry_wait') AND q.next_attempt_at<=?)
              OR (q.state='processing' AND q.lease_expires_at<=?))
           ORDER BY q.created_at LIMIT 1`,
        )
        .get(at, at) as Row | undefined;
      if (!row) return null;
      const token = randomUUID();
      const attempt = Number(row.attempt_count) + 1;
      const changed = this.store.db
        .prepare(
          `UPDATE lark_card_commands SET state='processing',attempt_count=?,
             lease_owner=?,lease_token=?,lease_expires_at=?,error=NULL
           WHERE id=? AND state=?`,
        )
        .run(
          attempt,
          this.workerId,
          token,
          new Date(now.getTime() + leaseMs).toISOString(),
          String(row.id),
          String(row.state),
        );
      if (Number(changed.changes) !== 1) return null;
      const owner = JSON.parse(String(row.owner_binding)) as {
        actorId: string;
      };
      return {
        id: String(row.id),
        inboxId: String(row.inbox_id),
        cardActionId: String(row.card_action_id),
        action: String(row.action) as CardCommandLease["action"],
        attempt,
        leaseToken: token,
        decisionId: String(row.decision_id),
        proposalDigest: String(row.proposal_digest),
        operatorOpenId: String(row.operator_open_id),
        ownerActorId: owner.actorId,
        messageId: String(row.message_id),
        appId: String(row.app_id),
        tenantBrand: row.tenant_brand === "lark" ? "lark" : "feishu",
        secretRef: String(row.secret_ref),
        bindingId: String(row.binding_id),
      };
    });
  }

  private finish(
    lease: CardCommandLease,
    state: "processed" | "failed" | "retry_wait",
    result: unknown,
    error: string | null,
    now: Date,
  ) {
    return this.store.tx(() => {
      const changed = this.store.db
        .prepare(
          `UPDATE lark_card_commands SET state=?,result_json=?,error=?,processed_at=?,
             next_attempt_at=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
           WHERE id=? AND state='processing' AND lease_token=?`,
        )
        .run(
          state,
          result === undefined ? null : JSON.stringify(result),
          error,
          state === "retry_wait" ? null : now.toISOString(),
          state === "retry_wait"
            ? new Date(
                now.getTime() +
                  Math.min(60_000, 1000 * 2 ** (lease.attempt - 1)),
              ).toISOString()
            : null,
          lease.id,
          lease.leaseToken,
        );
      if (Number(changed.changes) !== 1)
        throw Error("STALE_LARK_CARD_COMMAND_LEASE");
      if (state !== "retry_wait")
        this.store.db
          .prepare("UPDATE lark_card_actions SET result_json=? WHERE id=?")
          .run(JSON.stringify(result ?? { error }), lease.cardActionId);
    });
  }

  private disableBinding(bindingId: string, now: Date) {
    this.store.tx(() => {
      this.store.db
        .prepare(
          `UPDATE lark_targets SET state='disabled',capture_enabled=0,updated_at=?
           WHERE connection_id=(SELECT connection_id FROM lark_bindings WHERE id=?)`,
        )
        .run(now.toISOString(), bindingId);
      this.store.db
        .prepare(
          `UPDATE lark_connections SET state='failed',updated_at=?
           WHERE id=(SELECT connection_id FROM lark_bindings WHERE id=?)`,
        )
        .run(now.toISOString(), bindingId);
    });
  }

  async processOne(now = new Date()) {
    const lease = this.claim(now);
    if (!lease) return { processed: false as const };
    let businessResult: unknown;
    let attemptedSecret: string | undefined;
    try {
      businessResult = this.memory.decide(lease.decisionId, {
        action: lease.action,
        proposalDigest: lease.proposalDigest,
        requestId: `lark-card:${lease.id}`,
        actorId: lease.ownerActorId,
      });
      const secret = this.secrets.get(lease.secretRef);
      attemptedSecret = secret.clientSecret;
      if (secret.appId !== lease.appId)
        throw new LarkDeliveryError("LARK_SECRET_APP_MISMATCH", "auth");
      const state = String(
        (businessResult as { state?: unknown })?.state ?? "unknown",
      );
      await this.adapter.update({
        appId: lease.appId,
        clientSecret: secret.clientSecret,
        tenantBrand: lease.tenantBrand,
        messageId: lease.messageId,
        card: resultCard(state, lease.action),
      });
      this.finish(lease, "processed", businessResult, null, now);
      return { processed: true as const, state: "processed", businessResult };
    } catch (error) {
      const message = safeError(
        error,
        attemptedSecret ? [attemptedSecret] : [],
      );
      const current = this.store.db
        .prepare("SELECT state,request_id FROM decisions WHERE id=?")
        .get(lease.decisionId) as Row | undefined;
      const terminalBusinessError =
        /STALE_DECISION|DECISION_ALREADY_RESOLVED|DECISION_DIGEST_MISMATCH|DECISION_ACTOR_MISMATCH/.test(
          message,
        );
      if (terminalBusinessError && current) {
        try {
          const secret = this.secrets.get(lease.secretRef);
          attemptedSecret = secret.clientSecret;
          await this.adapter.update({
            appId: lease.appId,
            clientSecret: secret.clientSecret,
            tenantBrand: lease.tenantBrand,
            messageId: lease.messageId,
            card: resultCard(String(current.state), lease.action, message),
          });
          const result = {
            state: String(current.state),
            requestId: current.request_id ? String(current.request_id) : null,
          };
          this.finish(lease, "failed", result, message, now);
          return {
            processed: true as const,
            state: "failed",
            businessResult: result,
          };
        } catch (updateError) {
          const updateMessage = safeError(
            updateError,
            attemptedSecret ? [attemptedSecret] : [],
          );
          const retry =
            lease.attempt < 5 &&
            (!(updateError instanceof LarkDeliveryError) ||
              ["rate_limit", "ambiguous"].includes(updateError.kind));
          if (
            updateError instanceof LarkDeliveryError &&
            updateError.kind === "auth"
          )
            this.disableBinding(lease.bindingId, now);
          this.finish(
            lease,
            retry ? "retry_wait" : "failed",
            businessResult,
            updateMessage,
            now,
          );
          return {
            processed: true as const,
            state: retry ? "retry_wait" : "failed",
          };
        }
      }
      const retry =
        lease.attempt < 5 &&
        (!(error instanceof LarkDeliveryError) ||
          ["rate_limit", "ambiguous"].includes(error.kind));
      if (error instanceof LarkDeliveryError && error.kind === "auth")
        this.disableBinding(lease.bindingId, now);
      this.finish(
        lease,
        retry ? "retry_wait" : "failed",
        businessResult,
        message,
        now,
      );
      return {
        processed: true as const,
        state: retry ? "retry_wait" : "failed",
      };
    }
  }
}
