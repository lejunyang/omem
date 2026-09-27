import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRouter } from "../src/conversation/router.js";
import type {
  AssistantEvidence,
  AssistantModelPort,
} from "../src/assistant/runtime.js";
import { LarkRuntimeHost } from "../src/integrations/lark/runtime.js";
import type { LarkOnboardingService } from "../src/integrations/lark/onboarding.js";
import {
  LarkDeliveryError,
  type LarkMessageAdapter,
} from "../src/integrations/lark/delivery.js";
import type {
  LarkInboundEvent,
  LarkRealtimeAdapter,
} from "../src/integrations/lark/realtime.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { MemoryService } from "../src/memory/service.js";
import { Store } from "../src/store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class FakeRealtime implements LarkRealtimeAdapter {
  connections: Parameters<LarkRealtimeAdapter["connect"]>[0][] = [];
  connect(input: Parameters<LarkRealtimeAdapter["connect"]>[0]) {
    this.connections.push(input);
    input.onState("connecting");
    input.onState("connected");
    return { close: () => {} };
  }
}

class ScriptedMessages implements LarkMessageAdapter {
  sends: { chatId: string; providerUuid: string }[] = [];
  /** Number of times send should throw an ambiguous failure before succeeding. */
  failingAttempts = 0;
  async send(input: Parameters<LarkMessageAdapter["send"]>[0]) {
    this.sends.push({
      chatId: input.chatId,
      providerUuid: String(input.providerUuid),
    });
    if (this.failingAttempts > 0) {
      this.failingAttempts--;
      throw new LarkDeliveryError("ambiguous_network_failure", "ambiguous");
    }
    return { messageId: `om_${this.sends.length}` };
  }
  async update() {}
}

class FakeModel implements AssistantModelPort {
  calls: { userText: string; evidence: AssistantEvidence[] }[] = [];
  gate: (() => Promise<void>) | null = null;
  constructor(public answer = "fixture-reply") {}
  async generate(input: {
    userText: string;
    evidence: AssistantEvidence[];
  }): Promise<{ answer: string; citationIds: string[]; toolCalls?: never[] }> {
    this.calls.push({ userText: input.userText, evidence: input.evidence });
    if (this.gate) await this.gate();
    return { answer: this.answer, citationIds: [] };
  }
}

const noopOnboarding = {
  stop: async () => {},
} as unknown as LarkOnboardingService;

const setup = (
  opts: {
    answer?: string;
    afterReplyEnqueued?: (info: { turnId: string; outboxId: string }) => void;
  } = {},
) => {
  const directory = mkdtempSync(join(tmpdir(), "omem-lark-recovery-"));
  directories.push(directory);
  const store = new Store(directory);
  const secrets = new EncryptedSecretStore(
    join(directory, "secrets"),
    randomBytes(32),
  );
  const secretRef = secrets.put({
    appId: "cli_recovery1",
    clientSecret: "fixture-recovery-secret",
  });
  const at = "2026-09-27T00:00:00.000Z";
  store.db
    .prepare(
      `INSERT INTO lark_connections(
         id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
         owner_open_id,created_at,updated_at
       ) VALUES('conn-rec','personal','cli_recovery1','feishu',NULL,
         'active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  store.db
    .prepare(
      `INSERT INTO lark_connection_versions(
         id,connection_id,version,secret_ref,requested_config,
         capability_profile,missing_capabilities,state,created_at,updated_at
       ) VALUES('ver-rec','conn-rec',1,?,'{}',?,'[]','active',?,?)`,
    )
    .run(secretRef, JSON.stringify({ botOpenId: "ou_bot_rec" }), at, at);
  store.db
    .prepare(
      `INSERT INTO lark_bindings(
         id,workspace_id,connection_id,connection_version,binding_version,
         owner_open_id,target_chat_id,target_type,state,
         supersedes_binding_id,created_at
       ) VALUES('bind-rec','personal','conn-rec',1,1,'ou_owner','oc_group','group',
         'active',NULL,?)`,
    )
    .run(at);

  const memory = new MemoryService(store, { ownerId: "owner" });
  const realtime = new FakeRealtime();
  const messages = new ScriptedMessages();
  const model = new FakeModel(opts.answer);
  const host = new LarkRuntimeHost({
    store,
    memory,
    onboarding: noopOnboarding,
    secrets,
    realtimeAdapter: realtime,
    messageAdapter: messages,
    assistantModel: model,
    afterReplyEnqueued: opts.afterReplyEnqueued,
    pollMs: 1000,
  });
  return { store, host, realtime, messages, model };
};

// A group @-mention from the bound owner routes to the main assistant.
const ownerGroupEvent = (eventId: string, text: string): LarkInboundEvent => ({
  appId: "cli_recovery1",
  eventId,
  kind: "im.message.receive_v1",
  eventTime: "2026-09-27T00:00:00.000Z",
  senderOpenId: "ou_owner",
  senderType: "user",
  chatId: "oc_group",
  chatType: "group",
  messageId: `om_${eventId}`,
  messageType: "text",
  parentMessageId: null,
  text: `@ou_bot_rec ${text}`,
  payload: {
    message: {
      content: JSON.stringify({ text: `@ou_bot_rec ${text}` }),
      mentions: [{ id: { open_id: "ou_bot_rec" } }],
    },
  },
});

const outboxRows = (store: Store) =>
  (
    store.db
      .prepare(
        "SELECT id,provider_uuid,state FROM delivery_intents ORDER BY created_at",
      )
      .all() as { id: string; provider_uuid: string; state: string }[]
  );

describe("E persistent Lark reply delivery & recovery", () => {
  it("keeps the outbox row after a crash between enqueue and inbox-ack, and redelivers without duplicating", async () => {
    let crashed = false;
    const { store, host, realtime, messages } = setup({
      afterReplyEnqueued: () => {
        crashed = true;
        throw new Error("simulated_crash_after_enqueue");
      },
    });
    await host.processOnce(); // establish the fake connection
    await expect(
      realtime.connections[0]!.onEvent(ownerGroupEvent("evt-crash", "hi")),
    ).rejects.toThrow("simulated_crash_after_enqueue");
    expect(crashed).toBe(true);
    // The outbox row WAS committed even though the inbox was never acked.
    let rows = outboxRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("pending");
    expect(
      (
        store.db
          .prepare("SELECT state FROM event_inbox WHERE event_id=?")
          .get("evt-crash") as { state: string }
      ).state,
    ).toBe("received");

    // Redeliver the same event ("restart"). It must not create a second outbox row.
    await realtime.connections[0]!.onEvent(ownerGroupEvent("evt-crash", "hi"));
    rows = outboxRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("pending");
    expect(
      (
        store.db
          .prepare("SELECT state FROM event_inbox WHERE event_id=?")
          .get("evt-crash") as { state: string }
      ).state,
    ).toBe("processed");

    // The delivery worker drains the single pending reply.
    await host.processOnce();
    expect(messages.sends).toHaveLength(1);
    await host.stop();
    store.close();
  });

  it("deduplicates two concurrent deliveries of the same event into one turn and one outbox row", async () => {
    const { store, host, realtime, messages, model } = setup();
    await host.processOnce();
    let releaseGate!: () => void;
    model.gate = () => new Promise<void>((r) => (releaseGate = r));

    const p1 = realtime.connections[0]!.onEvent(ownerGroupEvent("evt-conc", "hi"));
    await new Promise((r) => setImmediate(r)); // p1 now suspended inside the model
    const p2 = realtime.connections[0]!.onEvent(ownerGroupEvent("evt-conc", "hi"));
    await p2; // concurrent duplicate: in-flight, must no-op
    releaseGate();
    await p1;

    expect(
      store.db.prepare("SELECT count(*) AS n FROM conversation_turns").get(),
    ).toEqual({ n: 1 });
    expect(outboxRows(store)).toHaveLength(1);
    await host.processOnce();
    expect(messages.sends).toHaveLength(1);
    await host.stop();
    store.close();
  });

  it("delivers two turns that happen to produce the same reply text (no false dedupe)", async () => {
    const { store, host, realtime, messages } = setup({ answer: "同一个回复" });
    await host.processOnce();
    await realtime.connections[0]!.onEvent(ownerGroupEvent("evt-same-1", "first"));
    await realtime.connections[0]!.onEvent(ownerGroupEvent("evt-same-2", "second"));
    const rows = outboxRows(store);
    expect(rows).toHaveLength(2);
    // Per-turn provider_uuid: two distinct rows, not one.
    expect(new Set(rows.map((r) => r.provider_uuid)).size).toBe(2);
    await host.processOnce();
    expect(messages.sends).toHaveLength(2);
    await host.stop();
    store.close();
  });

  it("retries a failed send and delivers once without creating a second outbox row", async () => {
    const { store, host, realtime, messages } = setup();
    await host.processOnce();
    messages.failingAttempts = 1; // first send attempt fails ambiguously
    await realtime.connections[0]!.onEvent(ownerGroupEvent("evt-flaky", "hi"));
    expect(outboxRows(store)).toHaveLength(1);
    await host.processOnce(); // attempt fails -> retry_wait (backoff ~1s)
    expect(outboxRows(store)[0]!.state).toBe("retry_wait");
    await new Promise((r) => setTimeout(r, 1100)); // wait past backoff
    await host.processOnce(); // retry succeeds
    expect(outboxRows(store)[0]!.state).toBe("delivered");
    expect(outboxRows(store)).toHaveLength(1);
    await host.stop();
    store.close();
  });

  it("recoverUnfinishedTurns resets a stale mid-model pending turn so a redelivery re-runs", async () => {
    const { store, host } = setup();
    const router = new ConversationRouter(store.db);
    const conv = router.open({
      principalId: "owner",
      channel: "lark_group",
      chatId: "oc_group",
      threadId: "lark:cli_recovery1:v1",
      visibility: "group",
    });
    router.enqueueTurn({
      conversationId: conv.id,
      inputText: "crashed mid model",
      transportEventId: "evt-stuck",
    });
    expect(router.unfinishedTurns()).toHaveLength(1);
    expect(host.recoverUnfinishedTurns()).toEqual({ reset: 1, completed: 0 });
    expect(router.unfinishedTurns()).toHaveLength(0);
    await host.stop();
    store.close();
  });
});
