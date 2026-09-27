import { randomUUID } from "node:crypto";
import type { Store } from "../../store.js";
import { MemoryService } from "../../memory/service.js";
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
  type LarkRealtimeAdapter,
} from "./realtime.js";
import type { EncryptedSecretStore } from "./secret-store.js";
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
          new LarkEventInbox(this.input.store),
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

  start() {
    if (this.loopPromise) return;
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
