import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Proposal } from "../../../packages/contracts/src/index.js";
import { LarkCardActionService } from "../src/integrations/lark/card-actions.js";
import {
  LarkDeliveryRepository,
  LarkDeliveryWorker,
  type LarkMessageAdapter,
} from "../src/integrations/lark/delivery.js";
import {
  LarkConnectionLeaseRepository,
  LarkConnectionManager,
  LarkEventInbox,
  normalizeLarkEvent,
  type LarkInboundEvent,
  type LarkRealtimeAdapter,
} from "../src/integrations/lark/realtime.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { MemoryService } from "../src/memory/service.js";
import { Store } from "../src/store.js";

type Resource = {
  directory: string;
  store: Store;
  secrets: EncryptedSecretStore;
};

const resources: Resource[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

class FakeMessages implements LarkMessageAdapter {
  readonly sends: Parameters<LarkMessageAdapter["send"]>[0][] = [];
  readonly updates: Parameters<LarkMessageAdapter["update"]>[0][] = [];
  async send(input: Parameters<LarkMessageAdapter["send"]>[0]) {
    this.sends.push(input);
    return { messageId: `om_card_${this.sends.length}` };
  }
  async update(input: Parameters<LarkMessageAdapter["update"]>[0]) {
    this.updates.push(input);
  }
}

class FakeRealtime implements LarkRealtimeAdapter {
  readonly connections: Parameters<LarkRealtimeAdapter["connect"]>[0][] = [];
  closed = 0;
  connect(input: Parameters<LarkRealtimeAdapter["connect"]>[0]) {
    this.connections.push(input);
    input.onState("connecting");
    input.onState("connected");
    return { close: () => this.closed++ };
  }
}

const setup = (targetType: "p2p" | "group" = "p2p") => {
  const directory = mkdtempSync(join(tmpdir(), "omem-lark-realtime-"));
  const store = new Store(directory);
  const secrets = new EncryptedSecretStore(
    join(directory, "secrets"),
    randomBytes(32),
  );
  const resource = { directory, store, secrets };
  resources.push(resource);
  const at = "2026-09-27T00:00:00.000Z";
  const secretRef = secrets.put({
    appId: "cli_realtime1",
    clientSecret: "fixture-secret",
  });
  store.db
    .prepare(
      `INSERT INTO lark_connections(
         id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
         owner_open_id,created_at,updated_at
       ) VALUES('connection-1','personal','cli_realtime1','feishu','tenant-1',
         'active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_connection_versions(
         id,connection_id,version,secret_ref,requested_config,capability_profile,
         missing_capabilities,state,created_at,updated_at
       ) VALUES('connection-version-1','connection-1',1,?,'{}',?,'[]','active',?,?)`,
    )
    .run(secretRef, JSON.stringify({ botOpenId: "ou_bot" }), at, at);
  store.db
    .prepare(
      `INSERT INTO lark_bindings(
         id,workspace_id,connection_id,connection_version,binding_version,
         owner_open_id,target_chat_id,target_type,state,supersedes_binding_id,
         created_at
       ) VALUES('binding-1','personal','connection-1',1,1,'ou_owner',?,?,'active',NULL,?)`,
    )
    .run(targetType === "group" ? "oc_group" : "oc_owner", targetType, at);
  for (const purpose of ["owner_notification", "decision"])
    store.db
      .prepare(
        `INSERT INTO lark_targets(
           id,workspace_id,connection_id,binding_version,chat_id,target_type,
           purpose,capture_enabled,state,created_at,updated_at
         ) VALUES(?,'personal','connection-1',1,?,?,?,0,'active',?,?)`,
      )
      .run(
        `target-${purpose}`,
        targetType === "group" ? "oc_group" : "oc_owner",
        targetType,
        purpose,
        at,
        at,
      );
  return resource;
};

const event = (patch: Partial<LarkInboundEvent> = {}): LarkInboundEvent => ({
  appId: "cli_realtime1",
  eventId: `evt-${Math.random()}`,
  kind: "im.message.receive_v1",
  eventTime: "2026-09-27T00:00:00.000Z",
  senderOpenId: "ou_member",
  senderType: "user",
  chatId: "oc_group",
  chatType: "group",
  messageId: `om-${Math.random()}`,
  text: "群消息",
  payload: { fixture: true },
  ...patch,
});

let sequence = 0;
const capture = (store: Store, externalId = `source-${++sequence}`) =>
  store.capture({
    source: "manual",
    externalId,
    title: "Decision evidence",
    parts: [{ type: "text", text: "需要确认这个高影响事项。" }],
    context: {},
    provenance: {
      collectorId: "lark-decision-test",
      actorId: "owner",
      actorType: "owner",
      actorVerifiedBy: "fixture",
      sourceUri: null,
      eventId: null,
      eventAt: "2026-09-27T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  }).revision;

const decisionProposal = (revision: ReturnType<typeof capture>): Proposal => ({
  schema_version: 1,
  proposal_id: `proposal-${++sequence}`,
  kind: "task",
  operation: "create",
  scope: {
    workspace_id: "personal",
    project_id: "realtime",
    subject_id: "owner",
  },
  body: {
    title: "高影响事项",
    owner_id: "owner",
    due_at: null,
    due_expression: null,
    next_step: "等待确认",
  },
  evidence: [
    {
      fragment_revision_id: revision.fragments[0]!.id,
      source_revision_id: revision.id,
      exact_quote: revision.fragments[0]!.text,
      selector: {
        start: 0,
        end: Array.from(revision.fragments[0]!.text).length,
        unit: "unicode_codepoint",
      },
    },
  ],
  uncertainties: [],
  reason: "影响范围超过自动应用阈值",
  expected_versions: {},
  origin: {
    job_id: "job-lark-card",
    role_bundle: "extractor@1",
    producer_kind: "derived",
  },
});

const prepareDecision = async (resource: Resource) => {
  const revision = capture(resource.store);
  const memory = new MemoryService(resource.store, {
    ownerId: "owner",
    maxAutoApply: 10,
  });
  const proposal = decisionProposal(revision);
  const result = memory.evaluate(
    proposal,
    {
      semantic_verdict: "supported",
      reviewer_version: "fixture-reviewer",
      role_version: "verifier@1",
      reason_code: "supported",
      details: "fixture deterministic assessment",
    },
    { impactCount: 11 },
  );
  expect(result).toMatchObject({ policy: "awaiting_decision" });
  const messages = new FakeMessages();
  const delivery = new LarkDeliveryWorker(
    new LarkDeliveryRepository(resource.store.db),
    resource.secrets,
    messages,
    "decision-sender",
  );
  expect(await delivery.processOne()).toMatchObject({ state: "delivered" });
  const intent = resource.store.db
    .prepare(
      "SELECT * FROM delivery_intents WHERE card_action_id IS NOT NULL LIMIT 1",
    )
    .get() as Record<string, unknown>;
  const card = JSON.parse(String(intent.payload_json)) as any;
  const value = card.body.elements[1].columns[0].elements[0].behaviors[0]
    .value as Record<string, unknown>;
  const cardEvent = event({
    eventId: "evt-card-1",
    kind: "card.action.trigger",
    senderOpenId: "ou_owner",
    senderType: "user",
    chatId: "oc_owner",
    chatType: "p2p",
    messageId: "om_card_1",
    text: undefined,
    payload: {
      context: {
        open_message_id: "om_card_1",
        open_chat_id: "oc_owner",
      },
      operator: { open_id: "ou_owner" },
      action: { value },
    },
  });
  return { revision, memory, proposal, result, messages, value, cardEvent };
};

describe("B2-06 Lark realtime and callback acceptance", () => {
  it("A-L08 leases one WebSocket consumer, routes pairing, and records reconnect health", async () => {
    const resource = setup();
    const adapterA = new FakeRealtime();
    const adapterB = new FakeRealtime();
    const inbox = new LarkEventInbox(resource.store);
    const leases = new LarkConnectionLeaseRepository(resource.store.db);
    const pairingEvents: unknown[] = [];
    const first = new LarkConnectionManager(
      resource.store.db,
      leases,
      resource.secrets,
      adapterA,
      inbox,
      "worker-a",
      undefined,
      {
        receivePairing(input) {
          pairingEvents.push(input);
          return { pairingId: "pairing-fixture" };
        },
      },
    );
    const second = new LarkConnectionManager(
      resource.store.db,
      leases,
      resource.secrets,
      adapterB,
      inbox,
      "worker-b",
    );
    expect(first.start("connection-1", new Date(), 60_000)).toBe(true);
    expect(second.start("connection-1", new Date(), 60_000)).toBe(false);
    expect(
      await adapterA.connections[0]!.onEvent(
        event({
          eventId: "evt-pairing",
          chatId: "oc_owner",
          chatType: "p2p",
          senderOpenId: "ou_owner",
          messageId: "om_pairing",
          text: "a".repeat(32),
        }),
      ),
    ).toMatchObject({ outcome: "pairing_candidate_verified" });
    expect(pairingEvents).toEqual([
      {
        appId: "cli_realtime1",
        code: "a".repeat(32),
        senderOpenId: "ou_owner",
        chatId: "oc_owner",
        chatType: "p2p",
      },
    ]);
    adapterA.connections[0]!.onState("reconnecting");
    adapterA.connections[0]!.onState("connected");
    expect(
      resource.store.db
        .prepare(
          "SELECT state FROM lark_connection_events WHERE connection_id='connection-1' ORDER BY rowid",
        )
        .all()
        .map((row) => (row as { state: string }).state),
    ).toEqual(["connecting", "connected", "reconnecting", "connected"]);
    first.stop("connection-1");
    expect(second.start("connection-1", new Date(), 60_000)).toBe(true);
    second.stop("connection-1");

    expect(
      normalizeLarkEvent("cli_realtime1", "card.action.trigger", {
        event_id: "evt-sdk-card",
        create_time: "1790467200000",
        context: {
          open_message_id: "om_sdk",
          open_chat_id: "oc_sdk",
        },
        operator: { open_id: "ou_sdk_owner" },
        action: { value: { protocol: "omem.decision.v1" } },
      }),
    ).toMatchObject({
      appId: "cli_realtime1",
      eventId: "evt-sdk-card",
      kind: "card.action.trigger",
      senderOpenId: "ou_sdk_owner",
      chatId: "oc_sdk",
      messageId: "om_sdk",
    });

    const awaiting = setup();
    awaiting.store.db
      .prepare(
        "UPDATE lark_connections SET state='awaiting_pair',active_version=NULL WHERE id='connection-1'",
      )
      .run();
    awaiting.store.db
      .prepare(
        "UPDATE lark_connection_versions SET state='awaiting_pair' WHERE id='connection-version-1'",
      )
      .run();
    const awaitingAdapter = new FakeRealtime();
    const awaitingManager = new LarkConnectionManager(
      awaiting.store.db,
      new LarkConnectionLeaseRepository(awaiting.store.db),
      awaiting.secrets,
      awaitingAdapter,
      new LarkEventInbox(awaiting.store),
      "pairing-worker",
    );
    expect(awaitingManager.start("connection-1")).toBe(true);
    awaitingManager.stop("connection-1");
  });

  it("A-L09 auto-monitors joined groups, deduplicates events, preserves identity/order, and ignores self", async () => {
    const resource = setup("group");
    const inbox = new LarkEventInbox(resource.store);
    expect(
      await inbox.processMessage(
        event({ eventId: "evt-existing-group", messageId: "om-existing" }),
      ),
    ).toMatchObject({ outcome: "captured" });
    const added = event({
      eventId: "evt-added",
      kind: "im.chat.member.bot.added_v1",
      senderOpenId: "ou_owner",
      messageId: null,
      text: undefined,
    });
    expect(await inbox.processMessage(added)).toMatchObject({
      outcome: "monitoring_enabled",
    });
    expect(
      resource.store.db
        .prepare(
          `SELECT state,capture_enabled FROM lark_targets
           WHERE purpose='group_monitoring' AND chat_id='oc_group'`,
        )
        .get(),
    ).toEqual({ state: "active", capture_enabled: 1 });
    const immediatelyAfterJoin = event({
      eventId: "evt-after-join",
      messageId: "om-after-join",
    });
    expect(await inbox.processMessage(immediatelyAfterJoin)).toMatchObject({
      outcome: "captured",
    });

    const self = event({
      eventId: "evt-self",
      senderOpenId: "ou_bot",
      senderType: "bot",
    });
    expect(await inbox.processMessage(self)).toMatchObject({
      outcome: "ignored_self",
    });
    const later = event({
      eventId: "evt-later",
      eventTime: "2026-09-27T00:02:00.000Z",
      messageId: "om-shared",
      senderOpenId: "ou_other_bot",
      senderType: "bot",
      text: "later body",
      payload: { body: "later" },
    });
    const olderUpdate = event({
      eventId: "evt-older-update",
      kind: "im.message.updated_v1",
      eventTime: "2026-09-27T00:01:00.000Z",
      messageId: "om-shared",
      senderOpenId: "ou_other_bot",
      senderType: "bot",
      text: "older edit",
      payload: { body: "older edit" },
    });
    expect(await inbox.processMessage(later)).toMatchObject({ outcome: "captured" });
    expect(await inbox.processMessage(later)).toMatchObject({ duplicate: true });
    await expect(
      inbox.processMessage({
        ...later,
        payload: { body: "conflicting replay" },
      }),
    ).rejects.toThrow("LARK_EVENT_CONFLICT");
    expect(await inbox.processMessage(olderUpdate)).toMatchObject({
      outcome: "captured",
    });
    const captured = resource.store.db
      .prepare(
        "SELECT event_id,envelope FROM input_events WHERE event_id IN ('evt-later','evt-older-update') ORDER BY event_id",
      )
      .all() as Array<{ event_id: string; envelope: string }>;
    expect(captured).toHaveLength(2);
    expect(
      captured.map((row) => JSON.parse(row.envelope).provenance.actorType),
    ).toEqual(["bot", "bot"]);
    expect(
      captured.map((row) => JSON.parse(row.envelope).observedAt).sort(),
    ).toEqual(["2026-09-27T00:01:00.000Z", "2026-09-27T00:02:00.000Z"]);
  });

  it("A-L10 gives repeated or racing card actions at most one business effect and renders actual state", async () => {
    const resource = setup();
    const prepared = await prepareDecision(resource);
    const cards = new LarkCardActionService(
      resource.store,
      prepared.memory,
      resource.secrets,
      prepared.messages,
      "card-worker",
    );
    expect(cards.enqueue(prepared.cardEvent)).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect(cards.enqueue(prepared.cardEvent)).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    const competing = structuredClone(prepared.cardEvent);
    competing.eventId = "evt-card-competing";
    (competing.payload as any).action.value.action = "reject";
    expect(cards.enqueue(competing)).toMatchObject({ accepted: false });
    expect(await cards.processOne()).toMatchObject({
      processed: true,
      state: "processed",
      businessResult: { state: "approved", duplicate: false },
    });
    expect(
      resource.store.db.prepare("SELECT count(*) AS n FROM tasks").get(),
    ).toEqual({ n: 1 });
    expect(prepared.messages.updates).toHaveLength(1);
    expect(JSON.stringify(prepared.messages.updates[0]!.card)).toContain(
      "已批准",
    );

    const racedResource = setup();
    const raced = await prepareDecision(racedResource);
    const racedCards = new LarkCardActionService(
      racedResource.store,
      raced.memory,
      racedResource.secrets,
      raced.messages,
      "card-worker-race",
    );
    expect(racedCards.enqueue(raced.cardEvent)).toMatchObject({
      accepted: true,
    });
    expect(
      raced.memory.decide(raced.result.decisionId!, {
        action: "reject",
        proposalDigest: raced.result.proposalDigest,
        requestId: "web-race",
        actorId: "owner",
      }),
    ).toMatchObject({ state: "rejected" });
    expect(await racedCards.processOne()).toMatchObject({
      state: "failed",
      businessResult: { state: "rejected", requestId: "web-race" },
    });
    expect(
      racedResource.store.db.prepare("SELECT count(*) AS n FROM tasks").get(),
    ).toEqual({ n: 0 });
    expect(JSON.stringify(raced.messages.updates[0]!.card)).toContain("已拒绝");
  });

  it("A-L11 rejects forged operator/chat/message/nonce/digest/expiry fields without consuming the action", async () => {
    const resource = setup();
    const prepared = await prepareDecision(resource);
    const cards = new LarkCardActionService(
      resource.store,
      prepared.memory,
      resource.secrets,
      prepared.messages,
      "card-worker",
    );
    const variants: LarkInboundEvent[] = [];
    const wrongOperator = structuredClone(prepared.cardEvent);
    wrongOperator.eventId = "evt-forged-operator";
    wrongOperator.senderOpenId = "ou_attacker";
    variants.push(wrongOperator);
    const wrongChat = structuredClone(prepared.cardEvent);
    wrongChat.eventId = "evt-forged-chat";
    wrongChat.chatId = "oc_other";
    variants.push(wrongChat);
    const wrongMessage = structuredClone(prepared.cardEvent);
    wrongMessage.eventId = "evt-forged-message";
    wrongMessage.messageId = "om_other";
    variants.push(wrongMessage);
    for (const [name, value] of [
      ["nonce", "x".repeat(40)],
      ["proposalDigest", "f".repeat(64)],
      ["expiresAt", "2026-09-20T00:00:00.000Z"],
      ["expectedVersionsDigest", "e".repeat(64)],
    ] as const) {
      const forged = structuredClone(prepared.cardEvent);
      forged.eventId = `evt-forged-${name}`;
      (forged.payload as any).action.value[name] = value;
      variants.push(forged);
    }
    for (const forged of variants)
      expect(cards.enqueue(forged)).toMatchObject({ accepted: false });
    expect(
      resource.store.db.prepare("SELECT state FROM lark_card_actions").get(),
    ).toEqual({ state: "pending" });
    expect(
      resource.store.db
        .prepare("SELECT count(*) AS n FROM lark_card_commands")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("A-L12 persists a command before ACK and can redeliver after a DB write failure", async () => {
    const resource = setup();
    const prepared = await prepareDecision(resource);
    const cards = new LarkCardActionService(
      resource.store,
      prepared.memory,
      resource.secrets,
      prepared.messages,
      "card-worker",
    );
    resource.store.db.exec(
      `CREATE TRIGGER reject_card_command BEFORE INSERT ON lark_card_commands
       BEGIN SELECT RAISE(ABORT,'fixture database unavailable'); END`,
    );
    expect(() => cards.enqueue(prepared.cardEvent)).toThrow(
      "fixture database unavailable",
    );
    expect(
      resource.store.db.prepare("SELECT state FROM event_inbox").get(),
    ).toEqual({ state: "received" });
    resource.store.db.exec("DROP TRIGGER reject_card_command");
    expect(cards.enqueue(prepared.cardEvent)).toMatchObject({ accepted: true });
    expect(
      resource.store.db.prepare("SELECT state FROM lark_card_commands").get(),
    ).toEqual({ state: "queued" });
    expect(
      resource.store.db.prepare("SELECT count(*) AS n FROM tasks").get(),
    ).toEqual({ n: 0 });
  });

  it("A-L13 refuses a queued approval after its source changes and updates the card to stale", async () => {
    const resource = setup();
    const prepared = await prepareDecision(resource);
    const cards = new LarkCardActionService(
      resource.store,
      prepared.memory,
      resource.secrets,
      prepared.messages,
      "card-worker",
    );
    expect(cards.enqueue(prepared.cardEvent)).toMatchObject({ accepted: true });
    const source = resource.store.db
      .prepare("SELECT external_id FROM sources WHERE id=?")
      .get(prepared.revision.sourceId) as { external_id: string };
    resource.store.capture({
      source: "manual",
      externalId: source.external_id,
      title: "Decision evidence updated",
      parts: [{ type: "text", text: "原资料已变更。" }],
      context: {},
    });
    expect(await cards.processOne()).toMatchObject({
      processed: true,
      state: "failed",
      businessResult: { state: "stale" },
    });
    expect(
      resource.store.db
        .prepare("SELECT state FROM decisions WHERE id=?")
        .get(prepared.result.decisionId),
    ).toEqual({ state: "stale" });
    expect(JSON.stringify(prepared.messages.updates[0]!.card)).toContain(
      "资料已变化或请求已过期",
    );
    expect(
      resource.store.db.prepare("SELECT count(*) AS n FROM tasks").get(),
    ).toEqual({ n: 0 });
  });

  it("A-L14 disables capture immediately when the bot is removed from an approved group", async () => {
    const resource = setup("group");
    resource.store.db
      .prepare(
        `INSERT INTO lark_targets(
           id,workspace_id,connection_id,binding_version,chat_id,target_type,
           purpose,capture_enabled,state,created_at,updated_at
         ) VALUES('monitor','personal','connection-1',1,'oc_group','group',
           'group_monitoring',1,'active',?,?)`,
      )
      .run("2026-09-27T00:00:00.000Z", "2026-09-27T00:00:00.000Z");
    const inbox = new LarkEventInbox(resource.store);
    expect(
      await inbox.processMessage(
        event({
          eventId: "evt-removed",
          kind: "im.chat.member.bot.deleted_v1",
          messageId: null,
          text: undefined,
        }),
      ),
    ).toMatchObject({ outcome: "target_disabled" });
    expect(
      resource.store.db
        .prepare(
          "SELECT state,capture_enabled FROM lark_targets WHERE chat_id='oc_group' ORDER BY purpose",
        )
        .all(),
    ).toEqual([
      { state: "disabled", capture_enabled: 0 },
      { state: "disabled", capture_enabled: 0 },
      { state: "disabled", capture_enabled: 0 },
    ]);
    expect(
      await inbox.processMessage(event({ eventId: "evt-after-remove" })),
    ).toMatchObject({ outcome: "ignored_not_allowed" });
  });
});
