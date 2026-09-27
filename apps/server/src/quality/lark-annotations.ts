import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import { stableDigest } from "../storage/digest.js";
import type { LarkInboundEvent } from "../integrations/lark/realtime.js";
import { LarkEventInbox } from "../integrations/lark/realtime.js";
import type { EncryptedSecretStore } from "../integrations/lark/secret-store.js";
import { QualityRepository, type QualitySample } from "./repository.js";

type Row = Record<string, unknown>;

const actionSchema = z
  .object({
    protocol: z.literal("omem.quality.v1"),
    sessionId: z.string().uuid(),
    sampleId: z.string().uuid(),
    action: z.enum(["confirm", "abstain", "needs_edit", "skip"]),
    nonce: z.string().min(32).max(200),
    labelDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class QualityLarkAnnotationService {
  readonly repository: QualityRepository;
  private readonly inbox: LarkEventInbox;

  constructor(
    private readonly store: Store,
    private readonly secrets: EncryptedSecretStore,
  ) {
    this.repository = new QualityRepository(store.db);
    this.inbox = new LarkEventInbox(store);
  }

  private card(
    sessionId: string,
    sample: QualitySample,
    nonce: string,
    expiresAt: string,
  ) {
    const progress = this.repository.progress(sample.datasetId);
    const total = Object.values(progress).reduce(
      (sum, count) => sum + Number(count),
      0,
    );
    const reviewed = total - Number(progress.pending ?? 0);
    const label = sample.draftLabel;
    const objects = label.objects
      .map(
        (object, index) =>
          `${index + 1}. **${object.kind}**：${object.statement}${
            object.evidenceQuote === sample.input.text
              ? "\n引用：与上方原文完全一致"
              : `\n引用：${object.evidenceQuote}`
          }`,
      )
      .join("\n\n");
    const value = (action: z.infer<typeof actionSchema>["action"]) => ({
      protocol: "omem.quality.v1",
      sessionId,
      sampleId: sample.id,
      action,
      nonce,
      labelDigest: sample.labelDigest,
      expiresAt,
    });
    const button = (
      action: z.infer<typeof actionSchema>["action"],
      content: string,
    ) => ({
      tag: "button",
      text: { tag: "plain_text", content },
      type: action === "confirm" ? "primary" : "default",
      behaviors: [{ type: "callback", value: value(action) }],
    });
    return {
      schema: "2.0",
      config: { width_mode: "default", update_multi: true },
      header: {
        title: {
          tag: "plain_text",
          content: `质量标注 ${sample.ordinal} · ${reviewed}/${total}`,
        },
        template: "blue",
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: `**原始材料**\n${sample.input.text.slice(0, 3000)}\n\n**请判断以下四点**\n1. 这是否值得作为长期知识记录？\n2. 建议事实是否准确且足够原子？\n3. 是否保留了数字、条件、例外和适用范围？\n4. 是否允许在“${sample.input.source.section}”范围自动沉淀？\n\n**建议答案**\n处置：${label.disposition}\n自动应用：${label.autoApply ? "是" : "否"}\n${objects || "无提炼对象"}`,
          },
          {
            tag: "column_set",
            flex_mode: "flow",
            horizontal_spacing: "8px",
            columns: [
              {
                tag: "column",
                width: "auto",
                elements: [button("confirm", "标注正确")],
              },
              {
                tag: "column",
                width: "auto",
                elements: [button("abstain", "应不提炼")],
              },
              {
                tag: "column",
                width: "auto",
                elements: [button("needs_edit", "需要修改")],
              },
              {
                tag: "column",
                width: "auto",
                elements: [button("skip", "稍后处理")],
              },
            ],
          },
        ],
      },
    };
  }

  private completedCard(datasetId: string) {
    const progress = this.repository.progress(datasetId);
    return {
      schema: "2.0",
      config: { width_mode: "default", update_multi: true },
      header: {
        title: { tag: "plain_text", content: "本轮质量标注已完成" },
        template: "green",
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: `已确认 ${Number(progress.confirmed ?? 0)} 条；需修改 ${Number(progress.needs_edit ?? 0)} 条；稍后处理 ${Number(progress.skipped ?? 0)} 条。`,
          },
        ],
      },
    };
  }

  cancel(sessionId: string) {
    const at = new Date().toISOString();
    this.store.tx(() => {
      const changed = this.store.db
        .prepare(
          `UPDATE quality_annotation_sessions SET state='cancelled',updated_at=?
           WHERE id=? AND state='active'`,
        )
        .run(at, sessionId);
      if (Number(changed.changes) !== 1)
        throw Error("QUALITY_ANNOTATION_SESSION_NOT_ACTIVE");
      // F9: revoke cards that have not been sent yet in the SAME transaction as
      // the session cancellation. Intents already in flight ('sending') are not
      // recalled: the network request cannot be withdrawn, so their outcome
      // (delivered / unknown-after-dedupe-window) is recorded honestly.
      // Already-'delivered' history is left untouched so we never pretend a card
      // the user already saw was retracted.
      this.store.db
        .prepare(
          `UPDATE delivery_intents SET state='cancelled',
             last_error='annotation session cancelled before send',
             next_attempt_at=NULL,updated_at=?
           WHERE annotation_session_id=? AND state IN ('pending','retry_wait')`,
        )
        .run(at, sessionId);
    });
    return { id: sessionId, state: "cancelled" };
  }

  start(datasetId: string, appId?: string, options: { resend?: boolean } = {}) {
    const existing = this.store.db
      .prepare(
        `SELECT s.*,b.binding_version FROM quality_annotation_sessions s
         JOIN lark_bindings b ON b.id=s.binding_id
         WHERE s.dataset_id=? AND s.state='active'
         ORDER BY s.created_at DESC LIMIT 1`,
      )
      .get(datasetId) as Row | undefined;
    if (existing && !options.resend)
      return { id: String(existing.id), duplicate: true, state: "active" };
    if (existing) {
      const sample = this.repository.sample(String(existing.current_sample_id));
      if (!sample) throw Error("QUALITY_DATASET_HAS_NO_PENDING_SAMPLES");
      const nonce = randomBytes(24).toString("base64url");
      const at = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
      const card = this.card(String(existing.id), sample, nonce, expiresAt);
      const changeId = randomUUID();
      const intentId = randomUUID();
      this.store.tx(() => {
        this.store.db
          .prepare(
            `UPDATE quality_annotation_sessions SET message_id=NULL,
               nonce_hash=?,expires_at=?,updated_at=? WHERE id=?`,
          )
          .run(
            this.secrets.hashPairingCode(nonce),
            expiresAt,
            at,
            String(existing.id),
          );
        this.store.db
          .prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?)")
          .run(
            changeId,
            "quality_annotation",
            `继续人工标注：${sample.datasetId}`,
            null,
            String(existing.id),
            `继续第 ${sample.ordinal} 条 owner 标注。`,
            at,
          );
        this.store.db
          .prepare(
            `INSERT INTO delivery_intents(
               id,workspace_id,change_id,channel_binding_version,channel,target,
               payload_digest,provider_uuid,state,created_at,updated_at,binding_id,
               payload_json,next_attempt_at,card_action_id,aggregation_mode,
               aggregate_after,superseded_by,annotation_session_id
             ) VALUES(?,'personal',?,?,'lark',?,?,?,?,?,?,?,?,?,NULL,'instant',?,NULL,?)`,
          )
          .run(
            intentId,
            changeId,
            Number(existing.binding_version),
            String(existing.chat_id),
            stableDigest(card),
            stableDigest({
              sessionId: existing.id,
              sampleId: sample.id,
              resendAt: at,
            }).slice(0, 50),
            "pending",
            at,
            at,
            String(existing.binding_id),
            JSON.stringify(card),
            at,
            at,
            String(existing.id),
          );
        this.store.db
          .prepare(
            "INSERT INTO delivery_intent_changes(intent_id,change_id,ordinal) VALUES(?,?,0)",
          )
          .run(intentId, changeId);
      });
      return {
        id: String(existing.id),
        duplicate: true,
        resent: true,
        state: "active",
      };
    }
    const sample = this.repository.nextPending(datasetId);
    if (!sample) throw Error("QUALITY_DATASET_HAS_NO_PENDING_SAMPLES");
    const target = this.store.db
      .prepare(
        `SELECT t.chat_id,b.id AS binding_id,b.owner_open_id,b.binding_version
         FROM lark_targets t JOIN lark_bindings b
           ON b.connection_id=t.connection_id
          AND b.binding_version=t.binding_version
         JOIN lark_connections c ON c.id=t.connection_id
         WHERE t.workspace_id='personal' AND t.purpose='owner_notification'
           AND t.target_type='p2p' AND t.state='active'
           AND b.state='active' AND c.state='active'
           AND (? IS NULL OR c.app_id=?)
         ORDER BY b.created_at DESC LIMIT 1`,
      )
      .get(appId ?? null, appId ?? null) as Row | undefined;
    if (!target) throw Error("QUALITY_OWNER_LARK_TARGET_NOT_FOUND");
    const sessionId = randomUUID();
    const nonce = randomBytes(24).toString("base64url");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const card = this.card(sessionId, sample, nonce, expiresAt);
    const changeId = randomUUID();
    const intentId = randomUUID();
    this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO quality_annotation_sessions(
             id,dataset_id,binding_id,chat_id,owner_open_id,message_id,
             current_sample_id,nonce_hash,expires_at,state,created_at,updated_at
           ) VALUES(?,?,?,?,?,NULL,?,?,?,'active',?,?)`,
        )
        .run(
          sessionId,
          datasetId,
          String(target.binding_id),
          String(target.chat_id),
          String(target.owner_open_id),
          sample.id,
          this.secrets.hashPairingCode(nonce),
          expiresAt,
          createdAt,
          createdAt,
        );
      this.store.db
        .prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?)")
        .run(
          changeId,
          "quality_annotation",
          `开始人工标注：${sample.datasetId}`,
          null,
          sessionId,
          `从第 ${sample.ordinal} 条开始，由绑定 owner 确认。`,
          createdAt,
        );
      const payloadJson = JSON.stringify(card);
      this.store.db
        .prepare(
          `INSERT INTO delivery_intents(
             id,workspace_id,change_id,channel_binding_version,channel,target,
             payload_digest,provider_uuid,state,created_at,updated_at,binding_id,
             payload_json,next_attempt_at,card_action_id,aggregation_mode,
             aggregate_after,superseded_by,annotation_session_id
           ) VALUES(?,'personal',?,?, 'lark',?,?,?,?,?,?,?,?,?,NULL,'instant',?,NULL,?)`,
        )
        .run(
          intentId,
          changeId,
          Number(target.binding_version),
          String(target.chat_id),
          stableDigest(card),
          stableDigest({ sessionId, sampleId: sample.id }).slice(0, 50),
          "pending",
          createdAt,
          createdAt,
          String(target.binding_id),
          payloadJson,
          createdAt,
          createdAt,
          sessionId,
        );
      this.store.db
        .prepare(
          "INSERT INTO delivery_intent_changes(intent_id,change_id,ordinal) VALUES(?,?,0)",
        )
        .run(intentId, changeId);
    });
    return { id: sessionId, duplicate: false, state: "active" };
  }

  handle(event: LarkInboundEvent) {
    if (event.kind !== "card.action.trigger")
      throw Error("QUALITY_CARD_EVENT_REQUIRED");
    const receipt = this.inbox.persist(event);
    if (receipt.duplicate && receipt.state !== "received")
      return {
        accepted: true,
        duplicate: true,
        toast: { type: "info", content: "这次标注已经记录" },
      };
    const payload = event.payload as { action?: { value?: unknown } };
    const parsed = actionSchema.safeParse(payload?.action?.value);
    if (!parsed.success)
      return this.reject(receipt.id, "QUALITY_ACTION_INVALID");
    const action = parsed.data;
    const session = this.store.db
      .prepare(
        `SELECT s.*,b.owner_open_id,c.app_id FROM quality_annotation_sessions s
         JOIN lark_bindings b ON b.id=s.binding_id
         JOIN lark_connections c ON c.id=b.connection_id WHERE s.id=?`,
      )
      .get(action.sessionId) as Row | undefined;
    const sample = this.repository.sample(action.sampleId);
    const valid =
      session &&
      sample &&
      session.state === "active" &&
      session.current_sample_id === sample.id &&
      session.owner_open_id === event.senderOpenId &&
      session.chat_id === event.chatId &&
      session.message_id === event.messageId &&
      session.app_id === event.appId &&
      String(session.expires_at) > new Date().toISOString() &&
      action.expiresAt === session.expires_at &&
      action.labelDigest === sample.labelDigest &&
      safeEqual(
        String(session.nonce_hash),
        this.secrets.hashPairingCode(action.nonce),
      );
    if (!valid) return this.reject(receipt.id, "QUALITY_ACTION_REJECTED");
    const nextNonce = randomBytes(24).toString("base64url");
    const at = new Date().toISOString();
    let next: QualitySample | null = null;
    this.store.tx(() => {
      this.repository.label({
        sampleId: sample.id,
        action: action.action,
        reviewerOpenId: event.senderOpenId!,
        expectedLabelDigest: action.labelDigest,
      });
      this.store.db
        .prepare(
          `INSERT INTO quality_annotation_events(
             id,session_id,sample_id,event_id,action,actor_open_id,
             label_digest,created_at
           ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          action.sessionId,
          sample.id,
          event.eventId,
          action.action,
          event.senderOpenId,
          action.labelDigest,
          at,
        );
      this.store.db
        .prepare(
          "UPDATE event_inbox SET state='processed',processed_at=? WHERE id=?",
        )
        .run(at, receipt.id);
      next = this.repository.nextPending(sample.datasetId);
      this.store.db
        .prepare(
          `UPDATE quality_annotation_sessions SET current_sample_id=?,
             nonce_hash=?,state=?,updated_at=? WHERE id=?`,
        )
        .run(
          next?.id ?? null,
          this.secrets.hashPairingCode(nextNonce),
          next ? "active" : "completed",
          at,
          action.sessionId,
        );
    });
    return {
      accepted: true,
      duplicate: false,
      toast: {
        type: "success",
        content:
          action.action === "confirm"
            ? "已确认这条标注"
            : action.action === "abstain"
              ? "已标为不提炼"
              : action.action === "needs_edit"
                ? "已标记为需要修改"
                : "已跳过，稍后可重新处理",
      },
      card: next
        ? this.card(action.sessionId, next, nextNonce, action.expiresAt)
        : this.completedCard(sample.datasetId),
    };
  }

  private reject(inboxId: string, reason: string) {
    this.store.db
      .prepare(
        "UPDATE event_inbox SET state='failed',processed_at=? WHERE id=?",
      )
      .run(new Date().toISOString(), inboxId);
    return {
      accepted: false,
      reason,
      toast: { type: "error", content: "标注操作无效或已过期" },
    };
  }
}
