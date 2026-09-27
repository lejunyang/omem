import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LarkDeliveryError,
  LarkNotificationBatcher,
  LarkDeliveryRepository,
  LarkDeliveryWorker,
  type LarkMessageAdapter,
} from "../src/integrations/lark/delivery.js";
import {
  externalDeliveryTiming,
  type ExternalNotificationPolicy,
} from "../src/storage/repository.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { MemoryService } from "../src/memory/service.js";
import { Store } from "../src/store.js";

type Resource = {
  directory: string;
  store: Store;
  secrets: EncryptedSecretStore;
  key: Buffer;
};

const resources: Resource[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    try {
      resource.store.close();
    } catch {
      // A restart test may already have closed the previous handle.
    }
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

class FakeMessages implements LarkMessageAdapter {
  readonly sends: Parameters<LarkMessageAdapter["send"]>[0][] = [];
  readonly updates: Parameters<LarkMessageAdapter["update"]>[0][] = [];
  sendResults: Array<{ messageId: string } | Error> = [];
  updateResults: Array<void | Error> = [];

  async send(input: Parameters<LarkMessageAdapter["send"]>[0]) {
    this.sends.push(input);
    const result = this.sendResults.shift() ?? {
      messageId: `om_fixture_${this.sends.length}`,
    };
    if (result instanceof Error) throw result;
    return result;
  }

  async update(input: Parameters<LarkMessageAdapter["update"]>[0]) {
    this.updates.push(input);
    const result = this.updateResults.shift();
    if (result instanceof Error) throw result;
  }
}

const setup = (
  target = "oc_owner_1",
  externalNotifications?: Partial<ExternalNotificationPolicy>,
) => {
  const directory = mkdtempSync(join(tmpdir(), "omem-lark-delivery-"));
  const key = randomBytes(32);
  const store = new Store(directory, { externalNotifications });
  const secrets = new EncryptedSecretStore(join(directory, "secrets"), key);
  const resource = { directory, store, secrets, key };
  resources.push(resource);
  seedConnection(resource, target);
  return resource;
};

const seedConnection = (
  resource: Resource,
  target: string,
  options: { bindingVersion?: number; bindingId?: string; state?: string } = {},
) => {
  const at = "2026-09-27T00:00:00.000Z";
  const bindingVersion = options.bindingVersion ?? 1;
  const bindingId = options.bindingId ?? `binding-${bindingVersion}`;
  const secretRef = resource.secrets.put({
    appId: "cli_delivery1",
    clientSecret: `secret-${bindingVersion}`,
  });
  resource.store.db
    .prepare(
      `INSERT OR IGNORE INTO lark_connections(
         id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
         owner_open_id,created_at,updated_at
       ) VALUES('connection-1','personal','cli_delivery1','feishu','tenant-1',
         'active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  resource.store.db
    .prepare(
      `INSERT OR IGNORE INTO lark_connection_versions(
         id,connection_id,version,secret_ref,requested_config,capability_profile,
         missing_capabilities,state,created_at,updated_at
       ) VALUES(?, 'connection-1',1,?,'{}',?,'[]','active',?,?)`,
    )
    .run(
      `connection-version-${bindingVersion}`,
      secretRef,
      JSON.stringify({ botOpenId: "ou_bot" }),
      at,
      at,
    );
  resource.store.db
    .prepare(
      `INSERT INTO lark_bindings(
         id,workspace_id,connection_id,connection_version,binding_version,
         owner_open_id,target_chat_id,target_type,state,supersedes_binding_id,
         created_at
       ) VALUES(?,'personal','connection-1',1,?,'ou_owner',?,'p2p',?,NULL,?)`,
    )
    .run(bindingId, bindingVersion, target, options.state ?? "active", at);
  for (const purpose of ["owner_notification", "decision"])
    resource.store.db
      .prepare(
        `INSERT INTO lark_targets(
           id,workspace_id,connection_id,binding_version,chat_id,target_type,
           purpose,capture_enabled,state,created_at,updated_at
         ) VALUES(?,'personal','connection-1',?,?,'p2p',?,0,?,?,?)`,
      )
      .run(
        `${bindingId}-${purpose}`,
        bindingVersion,
        target,
        purpose,
        options.state ?? "active",
        at,
        at,
      );
  return { bindingId, secretRef };
};

let sequence = 0;
const applyTask = (store: Store, suffix = String(++sequence)) =>
  store.applications.applyTask({
    metadata: {
      workspaceId: "personal",
      applicationId: `application-${suffix}`,
      proposalDigest: suffix.padStart(64, "0").slice(-64),
      generation: 1,
      title: `通知 ${suffix}`,
      details: `变更详情 ${suffix}`,
      delivery: {
        channelBindingVersion: 1,
        channel: "in_app",
        target: "notification-center",
      },
    },
    task: {
      title: `事项 ${suffix}`,
      detail: "detail",
      nextStep: "next",
    },
  });

const larkIntent = (store: Store, changeId?: string) =>
  store.db
    .prepare(
      `SELECT * FROM delivery_intents
       WHERE channel='lark' ${changeId ? "AND change_id=?" : ""}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...(changeId ? [changeId] : [])) as Record<string, unknown>;

describe("B2-06 Lark delivery acceptance", () => {
  it("A-N01 persists the outbox across a process restart without replaying the application", async () => {
    const resource = setup();
    const receipt = applyTask(resource.store, "1");
    const intentBefore = larkIntent(resource.store, receipt.changeId);
    expect(intentBefore.state).toBe("pending");
    expect(
      resource.store.db.prepare("SELECT count(*) AS n FROM tasks").get(),
    ).toEqual({ n: 1 });

    resource.store.close();
    resource.store = new Store(resource.directory);
    resource.secrets = new EncryptedSecretStore(
      join(resource.directory, "secrets"),
      resource.key,
    );
    const messages = new FakeMessages();
    const worker = new LarkDeliveryWorker(
      new LarkDeliveryRepository(resource.store.db),
      resource.secrets,
      messages,
      "sender-after-restart",
    );
    const sendAt = new Date(
      Date.parse(String(intentBefore.created_at)) + 1_000,
    );
    expect(await worker.processOne(sendAt)).toMatchObject({
      processed: true,
      state: "delivered",
    });
    expect(messages.sends).toHaveLength(1);
    expect(
      resource.store.db.prepare("SELECT count(*) AS n FROM tasks").get(),
    ).toEqual({ n: 1 });
    expect(larkIntent(resource.store, receipt.changeId)).toMatchObject({
      state: "delivered",
      message_id: "om_fixture_1",
    });
  });

  it("A-N02 retries ambiguous sends with one uuid inside one hour and becomes unknown after it", async () => {
    const resource = setup();
    applyTask(resource.store, "2");
    const messages = new FakeMessages();
    messages.sendResults.push(
      new LarkDeliveryError("response lost", "ambiguous"),
      { messageId: "om_after_retry" },
    );
    const worker = new LarkDeliveryWorker(
      new LarkDeliveryRepository(resource.store.db),
      resource.secrets,
      messages,
      "sender-1",
    );
    const pending = larkIntent(resource.store);
    const start = new Date(Date.parse(String(pending.created_at)) + 1_000);
    expect(await worker.processOne(start)).toMatchObject({
      state: "retry_wait",
    });
    expect(
      await worker.processOne(new Date(start.getTime() + 2_000)),
    ).toMatchObject({ state: "delivered" });
    expect(messages.sends.map((send) => send.uuid)).toEqual([
      messages.sends[0]!.uuid,
      messages.sends[0]!.uuid,
    ]);

    applyTask(resource.store, "3");
    const expired = larkIntent(resource.store);
    resource.store.db
      .prepare(
        `UPDATE delivery_intents SET state='sending',attempt_count=1,
           first_sent_at=?,lease_expires_at=?,lease_token='dead-lease'
         WHERE id=?`,
      )
      .run(start.toISOString(), start.toISOString(), String(expired.id));
    expect(
      await worker.processOne(new Date(start.getTime() + 3_600_001)),
    ).toEqual({ processed: false });
    expect(larkIntent(resource.store, String(expired.change_id))).toMatchObject(
      {
        state: "unknown",
        error_kind: "ambiguous",
      },
    );
    expect(messages.sends).toHaveLength(2);
  });

  it("A-N03 bounds rate-limit retries and disables a connection on auth failure", async () => {
    const resource = setup();
    applyTask(resource.store, "4");
    const messages = new FakeMessages();
    messages.sendResults.push(
      new LarkDeliveryError("slow down", "rate_limit", 5_000),
      new LarkDeliveryError("token invalid secret-1", "auth"),
    );
    const worker = new LarkDeliveryWorker(
      new LarkDeliveryRepository(resource.store.db),
      resource.secrets,
      messages,
      "sender-2",
    );
    const intent = larkIntent(resource.store);
    const now = new Date(Date.parse(String(intent.created_at)) + 1_000);
    expect(await worker.processOne(now)).toMatchObject({ state: "retry_wait" });
    const waiting = larkIntent(resource.store);
    expect(waiting).toMatchObject({ attempt_count: 1 });
    expect(waiting.next_attempt_at).toBe(
      new Date(now.getTime() + 5_000).toISOString(),
    );
    expect(
      await worker.processOne(new Date(now.getTime() + 5_000)),
    ).toMatchObject({ state: "failed" });
    expect(
      resource.store.db
        .prepare("SELECT state FROM lark_connections WHERE id='connection-1'")
        .get(),
    ).toEqual({ state: "failed" });
    expect(
      resource.store.db
        .prepare("SELECT DISTINCT state FROM lark_targets")
        .all(),
    ).toEqual([{ state: "disabled" }]);
    expect(String(larkIntent(resource.store).last_error)).not.toContain(
      "secret-1",
    );
  });

  it("A-N04 keeps a distinct traceable delivery mapping for every immediate change", () => {
    const resource = setup();
    const receipts = Array.from({ length: 5 }, (_, index) =>
      applyTask(resource.store, `batch-${index}`),
    );
    const rows = resource.store.db
      .prepare(
        `SELECT change_id,payload_digest,provider_uuid FROM delivery_intents
         WHERE channel='lark' ORDER BY created_at`,
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.change_id))).toEqual(
      new Set(receipts.map((receipt) => receipt.changeId)),
    );
    expect(new Set(rows.map((row) => row.provider_uuid)).size).toBe(5);
    expect(rows.every((row) => String(row.payload_digest).length === 64)).toBe(
      true,
    );
    expect(
      resource.store.db
        .prepare(
          `SELECT count(*) AS count FROM delivery_intent_changes m
           JOIN delivery_intents i ON i.id=m.intent_id
           WHERE i.channel='lark'`,
        )
        .get(),
    ).toEqual({ count: 5 });
  });

  it("A-N04 merges a short window while preserving every change mapping", async () => {
    const resource = setup("oc_window", {
      mode: "window",
      windowMs: 60_000,
      scheduleLocalTime: "09:00",
      timezone: "Asia/Shanghai",
    });
    const receipts = Array.from({ length: 5 }, (_, index) =>
      applyTask(resource.store, `window-${index}`),
    );
    const pending = resource.store.db
      .prepare(
        `SELECT * FROM delivery_intents WHERE channel='lark'
         ORDER BY created_at`,
      )
      .all() as Record<string, unknown>[];
    expect(pending).toHaveLength(5);
    expect(pending.every((row) => row.aggregation_mode === "window")).toBe(
      true,
    );
    const due = new Date(
      Math.max(
        ...pending.map((row) => Date.parse(String(row.aggregate_after))),
      ) + 1,
    );
    const batcher = new LarkNotificationBatcher(resource.store.db);
    expect(batcher.prepareDue(due)).toEqual({ batches: 1, changes: 5 });
    const active = resource.store.db
      .prepare(
        `SELECT * FROM delivery_intents
         WHERE channel='lark' AND state='pending'`,
      )
      .all() as Record<string, unknown>[];
    expect(active).toHaveLength(1);
    expect(String(active[0]!.payload_json)).toContain("omem 变更摘要（5 项）");
    expect(
      resource.store.db
        .prepare(
          "SELECT change_id FROM delivery_intent_changes WHERE intent_id=? ORDER BY ordinal",
        )
        .all(String(active[0]!.id))
        .map((row) => String((row as { change_id: string }).change_id)),
    ).toEqual(receipts.map((receipt) => receipt.changeId));
    expect(
      resource.store.db
        .prepare(
          `SELECT count(*) AS count FROM delivery_intents
           WHERE channel='lark' AND state='cancelled' AND superseded_by=?`,
        )
        .get(String(active[0]!.id)),
    ).toEqual({ count: 4 });
    const lastNotification = resource.store.db
      .prepare("SELECT id FROM notifications WHERE change_id=?")
      .get(receipts[4]!.changeId) as { id: string };
    expect(
      resource.store.notification(lastNotification.id)?.deliveries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: active[0]!.id,
          changeCount: 5,
          aggregationMode: "instant",
        }),
        expect.objectContaining({
          state: "cancelled",
          supersededBy: active[0]!.id,
        }),
      ]),
    );
    const messages = new FakeMessages();
    const worker = new LarkDeliveryWorker(
      new LarkDeliveryRepository(resource.store.db),
      resource.secrets,
      messages,
      "window-sender",
    );
    expect(await worker.processOne(due)).toMatchObject({
      processed: true,
      state: "delivered",
    });
    expect(messages.sends).toHaveLength(1);
  });

  it("A-N04 schedules the next local digest boundary", () => {
    const policy: ExternalNotificationPolicy = {
      mode: "scheduled",
      windowMs: 300_000,
      scheduleLocalTime: "09:00",
      timezone: "Asia/Shanghai",
    };
    expect(
      externalDeliveryTiming("2026-09-27T00:30:00.000Z", policy).after,
    ).toBe("2026-09-27T01:00:00.000Z");
    expect(
      externalDeliveryTiming("2026-09-27T02:00:00.000Z", policy).after,
    ).toBe("2026-09-28T01:00:00.000Z");
    const resource = setup("oc_scheduled", policy);
    const receipts = Array.from({ length: 5 }, (_, index) =>
      applyTask(resource.store, `scheduled-${index}`),
    );
    const intents = resource.store.db
      .prepare(
        "SELECT * FROM delivery_intents WHERE channel='lark' ORDER BY created_at",
      )
      .all() as Record<string, unknown>[];
    expect(intents).toHaveLength(5);
    expect(
      intents.every(
        (intent) =>
          intent.aggregation_mode === "scheduled" &&
          intent.next_attempt_at === intent.aggregate_after,
      ),
    ).toBe(true);
    const due = new Date(
      Math.max(
        ...intents.map((intent) => Date.parse(String(intent.aggregate_after))),
      ) + 1,
    );
    expect(
      new LarkNotificationBatcher(resource.store.db).prepareDue(due),
    ).toEqual({ batches: 1, changes: 5 });
    const summary = resource.store.db
      .prepare(
        "SELECT * FROM delivery_intents WHERE channel='lark' AND state='pending'",
      )
      .get() as Record<string, unknown>;
    expect(summary).toMatchObject({
      state: "pending",
      aggregation_mode: "instant",
    });
    expect(
      resource.store.db
        .prepare(
          "SELECT count(*) AS count FROM delivery_intent_changes WHERE intent_id=?",
        )
        .get(String(summary.id)),
    ).toEqual({ count: receipts.length });
  });

  it("A-N05 never forwards an old intent to a replacement binding and restoration cards contain no localhost URL", async () => {
    const resource = setup("oc_old");
    const first = resource.store.applications.applyMemory({
      metadata: {
        workspaceId: "personal",
        applicationId: "memory-v1",
        proposalDigest: "a".repeat(64),
        generation: 1,
        title: "记录 v1",
        details: "first",
        delivery: {
          channelBindingVersion: 1,
          channel: "in_app",
          target: "notification-center",
        },
      },
      memory: {
        kind: "claim",
        scope: { workspace_id: "personal" },
        body: { statement: "v1" },
        evidenceSet: [],
      },
    });
    resource.store.applications.applyMemory({
      metadata: {
        workspaceId: "personal",
        applicationId: "memory-v2",
        proposalDigest: "b".repeat(64),
        generation: 1,
        title: "记录 v2",
        details: "second",
        delivery: {
          channelBindingVersion: 1,
          channel: "in_app",
          target: "notification-center",
        },
      },
      memory: {
        id: first.entityId,
        expectedVersion: 1,
        kind: "claim",
        scope: { workspace_id: "personal" },
        body: { statement: "v2" },
        evidenceSet: [],
      },
    });
    resource.store.db
      .prepare(
        "UPDATE lark_bindings SET state='superseded' WHERE id='binding-1'",
      )
      .run();
    resource.store.db
      .prepare(
        "UPDATE lark_targets SET state='disabled' WHERE binding_version=1",
      )
      .run();
    seedConnection(resource, "oc_new", {
      bindingVersion: 2,
      bindingId: "binding-2",
    });

    const messages = new FakeMessages();
    const worker = new LarkDeliveryWorker(
      new LarkDeliveryRepository(resource.store.db),
      resource.secrets,
      messages,
      "sender-3",
    );
    const deliveryAt = new Date(Date.now() + 1_000);
    expect(await worker.processOne(deliveryAt)).toEqual({ processed: false });
    expect(messages.sends).toEqual([]);
    expect(
      resource.store.db
        .prepare(
          "SELECT DISTINCT state FROM delivery_intents WHERE channel='lark' AND target='oc_old'",
        )
        .all(),
    ).toEqual([{ state: "cancelled" }]);

    const restored = new MemoryService(resource.store, {
      ownerId: "owner",
    }).restoreMemory({
      memoryId: first.entityId,
      expectedVersion: 2,
      targetVersion: 1,
      requestId: "restore-v1",
    });
    const current = larkIntent(resource.store, restored.changeId);
    expect(current).toMatchObject({
      target: "oc_new",
      binding_id: "binding-2",
    });
    expect(String(current.payload_json)).not.toMatch(/localhost|127\.0\.0\.1/);
  });
});
