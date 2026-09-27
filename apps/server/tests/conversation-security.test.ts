import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../src/app.js";
import { ConversationRouter } from "../src/conversation/router.js";
import type {
  AssistantEvidence,
  AssistantModelPort,
} from "../src/assistant/runtime.js";
import { LarkRuntimeHost } from "../src/integrations/lark/runtime.js";
import type { LarkOnboardingService } from "../src/integrations/lark/onboarding.js";
import type { LarkMessageAdapter } from "../src/integrations/lark/delivery.js";
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

class FakeMessages implements LarkMessageAdapter {
  sends: unknown[] = [];
  async send(input: Parameters<LarkMessageAdapter["send"]>[0]) {
    this.sends.push(input);
    return { messageId: `om_${this.sends.length}` };
  }
  async update() {}
}

class SpyModel implements AssistantModelPort {
  calls: { userText: string; evidence: AssistantEvidence[] }[] = [];
  async generate(input: {
    userText: string;
    evidence: AssistantEvidence[];
  }): Promise<{ answer: string; citationIds: string[] }> {
    this.calls.push({ userText: input.userText, evidence: input.evidence });
    return { answer: "ok", citationIds: [] };
  }
}

const noopOnboarding = {
  stop: async () => {},
} as unknown as LarkOnboardingService;

describe("C conversation channel/visibility hardening", () => {
  it("web API rejects a forged Lark channel or group visibility and forces web/private/owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-convsec-"));
    directories.push(directory);
    const previous = process.env.OMEM_SECRET_KEY;
    process.env.OMEM_SECRET_KEY = randomBytes(32).toString("base64");
    let built: Awaited<ReturnType<typeof buildApp>> | null = null;
    try {
      built = await buildApp({
        dataDir: directory,
        agentCwd: join(directory, "agent"),
        host: "127.0.0.1",
        port: 0,
        token: undefined,
        captureRoots: [],
        notifications: { mode: "instant" },
        lark: { enabled: false },
        profiles: [
          profileSchema.parse({
            id: "traex",
            name: "Fixture",
            transport: "acp",
            command: process.execPath,
          }),
        ],
      });
      const forgedChannel = await built.app.inject({
        method: "POST",
        url: "/api/assistant/conversations",
        payload: { chatId: "oc_x", channel: "lark_group" },
      });
      expect(forgedChannel.statusCode).toBe(400);
      const forgedVisibility = await built.app.inject({
        method: "POST",
        url: "/api/assistant/conversations",
        payload: { chatId: "oc_x", visibility: "group" },
      });
      expect(forgedVisibility.statusCode).toBe(400);

      const ok = await built.app.inject({
        method: "POST",
        url: "/api/assistant/conversations",
        payload: { chatId: "web-1", principalId: "attacker", visibility: "group" },
      });
      // visibility=group is rejected regardless of principalId tampering.
      expect(ok.statusCode).toBe(400);

      const good = await built.app.inject({
        method: "POST",
        url: "/api/assistant/conversations",
        payload: { chatId: "web-1", principalId: "attacker" },
      });
      expect(good.statusCode).toBe(200);
      const body = good.json();
      // Server forces channel=web, visibility=private, principalId=owner.
      expect(body).toMatchObject({
        channel: "web",
        visibility: "private",
        principalId: "owner",
        chatId: "web-1",
      });
    } finally {
      await built?.app.close();
      if (previous === undefined) delete process.env.OMEM_SECRET_KEY;
      else process.env.OMEM_SECRET_KEY = previous;
    }
  });

  it("never reuses an HTTP-forged lark_group/private row; the Lark route is group-scoped", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-convsec-"));
    directories.push(directory);
    const store = new Store(directory);
    const secrets = new EncryptedSecretStore(
      join(directory, "secrets"),
      randomBytes(32),
    );
    const secretRef = secrets.put({
      appId: "cli_sec1",
      clientSecret: "fixture-sec",
    });
    const at = "2026-09-27T00:00:00.000Z";
    store.db
      .prepare(
        `INSERT INTO lark_connections(
           id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
           owner_open_id,created_at,updated_at
         ) VALUES('conn-sec','personal','cli_sec1','feishu',NULL,
           'active',1,'ou_owner',?,?)`,
      )
      .run(at, at);
    store.db
      .prepare(
        `INSERT INTO lark_connection_versions(
           id,connection_id,version,secret_ref,requested_config,
           capability_profile,missing_capabilities,state,created_at,updated_at
         ) VALUES('ver-sec','conn-sec',1,?,'{}',?,'[]','active',?,?)`,
      )
      .run(secretRef, JSON.stringify({ botOpenId: "ou_bot_sec" }), at, at);
    store.db
      .prepare(
        `INSERT INTO lark_bindings(
           id,workspace_id,connection_id,connection_version,binding_version,
           owner_open_id,target_chat_id,target_type,state,
           supersedes_binding_id,created_at
         ) VALUES('bind-sec','personal','conn-sec',1,1,'ou_owner','oc_group','group',
           'active',NULL,?)`,
      )
      .run(at);

    // Step 1: an attacker (or legacy HTTP) forges a PRIVATE lark_group row for the
    // same chat. Web can no longer create this, so we plant it directly to prove the
    // transport namespacing still prevents reuse.
    const router = new ConversationRouter(store.db);
    const forged = router.open({
      principalId: "owner",
      channel: "lark_group",
      chatId: "oc_group",
      threadId: "",
      visibility: "private",
    });
    expect(forged.visibility).toBe("private");

    // Private evidence with NO group chat binding (must never leak into the group).
    const privateRev = store.capture({
      source: "manual",
      externalId: "private-evidence",
      title: "Private",
      parts: [{ type: "text", text: "COMMONTERM hidden owner note" }],
      context: {},
      provenance: {
        collectorId: "web",
        actorId: "owner",
        actorType: "owner",
        actorVerifiedBy: "fixture",
        sourceUri: null,
        eventId: null,
        eventAt: at,
        timezone: "Asia/Shanghai",
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    }).revision;
    // Legit group-sourced evidence (same searchable term, so retrieval returns both
    // and the visibility policy is what must drop the private one).
    const groupRev = store.capture({
      source: "chat",
      externalId: "group-evidence",
      title: "Group",
      parts: [{ type: "text", text: "COMMONTERM discussed in group" }],
      context: { conversationId: "oc_group" },
      provenance: {
        collectorId: "lark",
        actorId: "ou_owner",
        actorType: "owner",
        actorVerifiedBy: "fixture",
        sourceUri: null,
        eventId: null,
        eventAt: at,
        timezone: "Asia/Shanghai",
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    }).revision;
    const privateFragmentId = privateRev.fragments[0]!.id;
    const groupFragmentId = groupRev.fragments[0]!.id;

    const memory = new MemoryService(store, { ownerId: "owner" });
    const realtime = new FakeRealtime();
    const messages = new FakeMessages();
    const model = new SpyModel();
    const host = new LarkRuntimeHost({
      store,
      memory,
      onboarding: noopOnboarding,
      secrets,
      realtimeAdapter: realtime,
      messageAdapter: messages,
      assistantModel: model,
      pollMs: 1000,
    });
    try {
      await host.processOnce();
      const event: LarkInboundEvent = {
        appId: "cli_sec1",
        eventId: "evt-sec-1",
        kind: "im.message.receive_v1",
        eventTime: at,
        senderOpenId: "ou_owner",
        senderType: "user",
        chatId: "oc_group",
        chatType: "group",
        messageId: "om_sec_1",
        messageType: "text",
        parentMessageId: null,
        text: "COMMONTERM",
        payload: {
          message: {
            content: JSON.stringify({ text: "COMMONTERM" }),
            mentions: [{ id: { open_id: "ou_bot_sec" } }],
          },
        },
      };
      await realtime.connections[0]!.onEvent(event);

      // The host must have opened a NEW namespaced conversation (visibility=group),
      // not reused the forged private row.
      const usedConvId = String(
        (
          store.db
            .prepare("SELECT conversation_id FROM conversation_turns ORDER BY created_at DESC LIMIT 1")
            .get() as { conversation_id: string }
        ).conversation_id,
      );
      const used = router.get(usedConvId)!;
      expect(used.visibility).toBe("group");
      expect(used.threadId).toBe("lark:cli_sec1:v1");
      // The forged private row was left untouched.
      expect(router.get(forged.id)!.visibility).toBe("private");

      // The model never saw the private (no-chat) evidence; only group-scoped.
      expect(model.calls).toHaveLength(1);
      const citedIds = model.calls[0]!.evidence.map((e) => e.fragmentId);
      expect(citedIds).not.toContain(privateFragmentId);
      expect(citedIds).toContain(groupFragmentId);
    } finally {
      await host.stop();
      store.close();
    }
  });
});
