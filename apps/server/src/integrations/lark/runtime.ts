import type { RetrievalPort } from "../../retrieval/port.js";
import { randomUUID } from "node:crypto";
import type { Store } from "../../store.js";
import { MemoryService, FeedbackService } from "../../memory/service.js";
import { KeywordRetrieval } from "../../retrieval/keyword.js";
import { LarkCardActionService } from "./card-actions.js";
import {
  LarkDeliveryRepository,
  LarkDeliveryWorker,
  LarkNotificationBatcher,
  OfficialLarkMessageAdapter,
  type LarkMessageAdapter,
} from "./delivery.js";
import type { LarkOnboardingService } from "./onboarding.js";
import {
  LarkConnectionLeaseRepository,
  LarkConnectionManager,
  LarkEventInbox,
  OfficialLarkRealtimeAdapter,
  type LarkMediaPort,
  type LarkRealtimeAdapter,
} from "./realtime.js";
import type { EncryptedSecretStore } from "./secret-store.js";
import {
  AssistantRuntime,
  type AssistantModelPort,
} from "../../assistant/runtime.js";
import type { VisibilityPolicy } from "../../assistant/runtime.js";
import { QualityLarkAnnotationService } from "../../quality/lark-annotations.js";

type Row = Record<string, unknown>;

const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : "Lark runtime failed")
    .replace(/\b(?:cli_|sk-|ghp_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);

export class LarkRuntimeHost {
  private readonly controller = new AbortController();
  private readonly connections = new Map<string, LarkConnectionManager>();
  private readonly delivery: LarkDeliveryWorker;
  private readonly batcher: LarkNotificationBatcher;
  private readonly cards: LarkCardActionService;
  readonly quality: QualityLarkAnnotationService;
  private readonly assistant: AssistantRuntime | null;
  private loopPromise: Promise<void> | null = null;
  private processedDeliveries = 0;
  private processedCards = 0;
  private lastError: string | null = null;

  constructor(
    private readonly input: {
      store: Store;
      memory: MemoryService;
      onboarding: LarkOnboardingService;
      secrets: EncryptedSecretStore;
      pollMs?: number;
      workerId?: string;
      realtimeAdapter?: LarkRealtimeAdapter;
      messageAdapter?: LarkMessageAdapter;
      assistantModel?: AssistantModelPort;
      assistantTimeoutMs?: number;
      retrieval?: RetrievalPort;
      media?: LarkMediaPort;
      /** Test seam: invoked after the reply outbox row is committed but before the
       *  inbox event is acked. Throwing here simulates a crash and must leave the
       *  outbox row durable. */
      afterReplyEnqueued?: (info: { turnId: string; outboxId: string }) => void;
    },
  ) {
    const workerId =
      input.workerId ?? `lark-${process.pid}-${randomUUID().slice(0, 8)}`;
    const messages = input.messageAdapter ?? new OfficialLarkMessageAdapter();
    this.delivery = new LarkDeliveryWorker(
      new LarkDeliveryRepository(input.store.db),
      input.secrets,
      messages,
      `${workerId}-delivery`,
    );
    this.batcher = new LarkNotificationBatcher(input.store.db);
    this.cards = new LarkCardActionService(
      input.store,
      input.memory,
      input.secrets,
      messages,
      `${workerId}-cards`,
    );
    this.quality = new QualityLarkAnnotationService(input.store, input.secrets);
    // Real server-owned visibility: a group conversation may see only evidence
    // actually collected in that group chat. The owner's private/p2p imports and
    // anything not sourced from this chat are invisible here.
    const visibilityPolicy: VisibilityPolicy = ({
      conversation,
      fragmentId,
    }) => {
      if (conversation.visibility === "private") return true;
      const record = input.store.evidence(fragmentId);
      if (!record) return false;
      const chatId = record.revision.context?.conversationId;
      return Boolean(chatId && chatId === conversation.chatId);
    };
    const assistantRetrieval =
      input.retrieval ?? new KeywordRetrieval(input.store.db);
    const assistantFeedback = new FeedbackService(input.store);
    this.assistant = input.assistantModel
      ? new AssistantRuntime(input.store, input.assistantModel, {
          ownerId: "owner",
          memory: input.memory,
          feedback: assistantFeedback,
          retrieval: assistantRetrieval,
          visibilityPolicy,
          turnTimeoutMs: input.assistantTimeoutMs ?? 60_000,
        })
      : null;
  }

  private activeConnections() {
    return this.input.store.db
      .prepare(
        `SELECT id FROM lark_connections
         WHERE state IN ('active','awaiting_pair') ORDER BY created_at`,
      )
      .all() as Row[];
  }

  private syncConnections() {
    const active = new Set(
      this.activeConnections().map((row) => String(row.id)),
    );
    for (const [id, manager] of this.connections)
      if (!active.has(id)) {
        manager.stop(id);
        this.connections.delete(id);
      }
    for (const id of active) {
      let manager = this.connections.get(id);
      if (!manager) {
        manager = new LarkConnectionManager(
          this.input.store.db,
          new LarkConnectionLeaseRepository(this.input.store.db),
          this.input.secrets,
          this.input.realtimeAdapter ?? new OfficialLarkRealtimeAdapter(),
          new LarkEventInbox(this.input.store, {
            media: this.input.media,
            afterReplyEnqueued: this.input.afterReplyEnqueued,
            assistant: this.assistant
              ? async (routed) => {
                  // C: namespaced conversation key. The thread_id encodes the
                  // transport binding (appId + bindingVersion), so a web/forged row
                  // (channel=web, thread_id='') and rows from a different Lark app or
                  // a superseded binding can never be reused here. Web cannot create
                  // lark_* conversations at all (app.ts forces channel=web).
                  const transportThread = `lark:${routed.appId}:v${routed.bindingVersion}`;
                  const expectedVisibility =
                    routed.chatType === "group" ? "group" : "private";
                  const conversation = this.assistant!.conversations.open({
                    principalId: routed.principalId,
                    channel:
                      routed.chatType === "group" ? "lark_group" : "lark_p2p",
                    chatId: routed.chatId,
                    threadId: transportThread,
                    visibility: expectedVisibility,
                  });
                  // Fail-closed: never adopt a row whose visibility disagrees with the
                  // current Lark binding (a tampered/forged private group row).
                  if (conversation.visibility !== expectedVisibility)
                    throw Error("LARK_CONVERSATION_VISIBILITY_MISMATCH");
                  const result = await this.assistant!.turn({
                    conversationId: conversation.id,
                    userText: routed.text,
                    transportEventId: routed.eventId,
                  });
                  return {
                    replyText: result.turn.result,
                    turnId: result.turn.id,
                    status: result.turn.inputMessageRefs.status,
                    duplicate: result.duplicate,
                    replyOutboxId: result.turn.replyOutboxId,
                  };
                }
              : undefined,
          }),
          `connection-${process.pid}-${randomUUID().slice(0, 8)}`,
          {
            enqueue: (event) => {
              const protocol = (
                event.payload as { action?: { value?: { protocol?: unknown } } }
              )?.action?.value?.protocol;
              return protocol === "omem.quality.v1"
                ? this.quality.handle(event)
                : this.cards.enqueue(event);
            },
          },
          this.input.onboarding,
        );
        this.connections.set(id, manager);
      }
      if (!manager.isRunning()) manager.start(id);
    }
  }

  async processOnce(limit = 100) {
    this.syncConnections();
    const aggregation = this.batcher.prepareDue();
    let cards = 0;
    let deliveries = 0;
    while (cards < limit && (await this.cards.processOne()).processed) cards++;
    while (deliveries < limit && (await this.delivery.processOne()).processed)
      deliveries++;
    this.processedCards += cards;
    this.processedDeliveries += deliveries;
    return {
      cards,
      deliveries,
      batches: aggregation.batches,
      changes: aggregation.changes,
      connections: this.connections.size,
    };
  }

  /**
   * E: recovery worker. At start no model is in flight, so every pending/running
   * turn left by a previous process is stale. A turn that crashed mid-model (no
   * result) is removed so a redelivery of the same transport event starts a fresh
   * turn instead of returning the stale pending record forever. A turn that already
   * produced a result but never reached a terminal state is marked done; the reply
   * outbox (if any) is owned by the delivery worker.
   */
  recoverUnfinishedTurns(): { reset: number; completed: number } {
    if (!this.assistant) return { reset: 0, completed: 0 };
    let reset = 0;
    let completed = 0;
    for (const turn of this.assistant.conversations.unfinishedTurns()) {
      if (turn.result) {
        this.assistant.conversations.completeTurn({
          turnId: turn.id,
          result: turn.result,
          selectedEvidence: turn.selectedEvidence,
          toolActions: turn.toolActions,
        });
        completed++;
      } else {
        this.input.store.db
          .prepare("DELETE FROM conversation_turns WHERE id=?")
          .run(turn.id);
        reset++;
      }
    }
    return { reset, completed };
  }

  start() {
    if (this.loopPromise) return;
    this.recoverUnfinishedTurns();
    this.loopPromise = this.loop();
  }

  private async wait() {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, this.input.pollMs ?? 1000);
      timer.unref();
      this.controller.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async loop() {
    while (!this.controller.signal.aborted) {
      try {
        await this.processOnce();
        this.lastError = null;
      } catch (error) {
        this.lastError = safeError(error);
      }
      await this.wait();
    }
  }

  status() {
    return {
      running: Boolean(this.loopPromise) && !this.controller.signal.aborted,
      connections: [...this.connections.values()].filter((manager) =>
        manager.isRunning(),
      ).length,
      processedDeliveries: this.processedDeliveries,
      processedCards: this.processedCards,
      lastError: this.lastError,
    };
  }

  async stop() {
    this.controller.abort();
    for (const [id, manager] of this.connections) manager.stop(id);
    this.connections.clear();
    await this.input.onboarding.stop();
    await this.loopPromise;
  }
}
