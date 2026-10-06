import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../src/app.js";
import { LarkRuntimeHost } from "../src/integrations/lark/runtime.js";
import { LarkOnboardingService } from "../src/integrations/lark/onboarding.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import type {
  LarkCapabilityProbe,
  LarkRegistrationAdapter,
} from "../src/integrations/lark/registration.js";
import type {
  LarkInboundEvent,
  LarkRealtimeAdapter,
} from "../src/integrations/lark/realtime.js";
import type { LarkMessageAdapter } from "../src/integrations/lark/delivery.js";
import { MemoryService } from "../src/memory/service.js";
import { Store } from "../src/store.js";
import type { AssistantWork } from "../src/assistant/work.js";
import type { WorkActor } from "../../../packages/contracts/src/work.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class FakeRealtime implements LarkRealtimeAdapter {
  connections: Parameters<LarkRealtimeAdapter["connect"]>[0][] = [];
  closed = 0;
  connect(input: Parameters<LarkRealtimeAdapter["connect"]>[0]) {
    this.connections.push(input);
    input.onState("connecting");
    input.onState("connected");
    return { close: () => this.closed++ };
  }
}

class FakeMessages implements LarkMessageAdapter {
  sends: Parameters<LarkMessageAdapter["send"]>[0][] = [];
  async send(input: Parameters<LarkMessageAdapter["send"]>[0]) {
    this.sends.push(input);
    return { messageId: `om_host_${this.sends.length}` };
  }
  async update() {}
}

const unusedRegistration: LarkRegistrationAdapter = {
  register: async () => await new Promise<never>(() => {}),
};
const unusedProbe: LarkCapabilityProbe = {
  probe: async () => ({
    actual: { scopes: [], events: [], callbacks: [] },
    missing: [],
  }),
};

describe("B2-08 production Lark host", () => {
  it("assembles the host only when explicitly enabled with a master key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-lark-app-host-"));
    directories.push(directory);
    const previous = process.env.OMEM_SECRET_KEY;
    process.env.OMEM_SECRET_KEY = randomBytes(32).toString("base64");
    try {
      const built = await buildApp({
        dataDir: directory,
        agentCwd: join(directory, "agent"),
        host: "127.0.0.1",
        port: 0,
        token: undefined,
        captureRoots: [],
        notifications: { mode: "instant" },
        lark: { enabled: true, pollMs: 20 },
        profiles: [
          profileSchema.parse({
            id: "traex",
            name: "Fixture",
            transport: "acp",
            command: process.execPath,
          }),
        ],
      });
      try {
        expect(built.lark).toBeTruthy();
        expect(built.larkRuntime?.status()).toMatchObject({
          running: true,
          connections: 0,
          lastError: null,
        });
        expect(
          (await built.app.inject("/api/health")).json().lark,
        ).toMatchObject({ running: true, connections: 0 });
      } finally {
        await built.app.close();
      }
    } finally {
      if (previous === undefined) delete process.env.OMEM_SECRET_KEY;
      else process.env.OMEM_SECRET_KEY = previous;
    }
  });

  it("starts active connections, records runtime events and drains outbox", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-lark-host-"));
    directories.push(directory);
    const store = new Store(directory);
    const secrets = new EncryptedSecretStore(
      join(directory, "secrets"),
      randomBytes(32),
    );
    const secretRef = secrets.put({
      appId: "cli_runtime1",
      clientSecret: "fixture-runtime-secret",
    });
    const at = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO lark_connections(
           id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,
           owner_open_id,created_at,updated_at
         ) VALUES('connection-runtime','personal','cli_runtime1','feishu',NULL,
           'active',1,'ou_owner',?,?)`,
      )
      .run(at, at);
    store.db
      .prepare(
        `INSERT INTO lark_connection_versions(
           id,connection_id,version,secret_ref,requested_config,
           capability_profile,missing_capabilities,state,created_at,updated_at
         ) VALUES('version-runtime','connection-runtime',1,?,'{}',?,'[]',
           'active',?,?)`,
      )
      .run(secretRef, JSON.stringify({ botOpenId: "ou_runtimebot" }), at, at);
    store.db
      .prepare(
        `INSERT INTO lark_bindings(
           id,workspace_id,connection_id,connection_version,binding_version,
           owner_open_id,target_chat_id,target_type,state,
           supersedes_binding_id,created_at
         ) VALUES('binding-runtime','personal','connection-runtime',1,1,
           'ou_owner','oc_owner','p2p','active',NULL,?)`,
      )
      .run(at);
    for (const purpose of ["owner_notification", "decision"])
      store.db
        .prepare(
          `INSERT INTO lark_targets(
             id,workspace_id,connection_id,binding_version,chat_id,target_type,
             purpose,capture_enabled,state,created_at,updated_at
           ) VALUES(?,'personal','connection-runtime',1,'oc_owner','p2p',?,0,
             'active',?,?)`,
        )
        .run(`target-${purpose}`, purpose, at, at);

    const memory = new MemoryService(store, { ownerId: "owner" });
    const onboarding = new LarkOnboardingService(
      store.db,
      secrets,
      unusedRegistration,
      unusedProbe,
    );
    const realtime = new FakeRealtime();
    const messages = new FakeMessages();
    const workCalls: WorkActor[] = [];
    const host = new LarkRuntimeHost({
      store,
      memory,
      onboarding,
      secrets,
      realtimeAdapter: realtime,
      messageAdapter: messages,
      assistantModel: {
        generate: async () => ({
          answer: "模型声称成功",
          citationIds: [],
          workAction: {
            operation: "track",
            title: "退款需求",
            goal: "跟进上线",
            materialKeys: [],
            contextIds: [],
          },
        }),
      },
      work: {
        apply: (_action: unknown, actor: WorkActor) => {
          workCalls.push(actor);
          return {
            tool: "work_action",
            operation: "track",
            message: "已保存退款需求，正在调查。",
          };
        },
      } as unknown as AssistantWork,
      workerId: "runtime-test",
      pollMs: 20,
    });
    try {
      store.applications.applyTask({
        metadata: {
          workspaceId: "personal",
          applicationId: "runtime-application",
          proposalDigest: "a".repeat(64),
          generation: 1,
          title: "Runtime delivery",
          details: "Deliver through the active binding",
          delivery: {
            channelBindingVersion: 1,
            channel: "in_app",
            target: "notification-center",
          },
        },
        task: {
          title: "Runtime task",
          detail: "Runtime detail",
          nextStep: "Observe receipt",
        },
      });
      expect(await host.processOnce()).toEqual({
        cards: 0,
        deliveries: 1,
        batches: 0,
        changes: 0,
        connections: 1,
      });
      expect(realtime.connections).toHaveLength(1);
      expect(messages.sends).toHaveLength(1);
      expect(messages.sends[0]).toMatchObject({
        appId: "cli_runtime1",
        chatId: "oc_owner",
      });
      expect(JSON.stringify(host.status())).not.toContain(
        "fixture-runtime-secret",
      );

      const event: LarkInboundEvent = {
        appId: "cli_runtime1",
        eventId: "event-runtime-1",
        kind: "im.message.receive_v1",
        eventTime: new Date().toISOString(),
        senderOpenId: "ou_groupuser",
        senderType: "user",
        chatId: "oc_group",
        chatType: "group",
        messageId: "om_group1",
        text: "captured by runtime host",
        payload: { fixture: true },
      };
      await realtime.connections[0]!.onEvent(event);
      const capability = JSON.parse(
        String(
          (
            store.db
              .prepare(
                "SELECT capability_profile FROM lark_connection_versions WHERE id='version-runtime'",
              )
              .get() as { capability_profile: string }
          ).capability_profile,
        ),
      ) as { events: string[] };
      expect(capability.events).toContain("im.message.receive_v1");
      expect(
        store.db
          .prepare(
            "SELECT state,capture_enabled FROM lark_targets WHERE chat_id='oc_group' AND purpose='group_monitoring'",
          )
          .get(),
      ).toEqual({ state: "active", capture_enabled: 1 });

      // The production bot assembler must pass the same managed work service as
      // web. A receipt, rather than speculative model text, becomes the reply.
      await realtime.connections[0]!.onEvent({
        ...event,
        eventId: "event-owner-track",
        messageId: "om_owner_track",
        senderOpenId: "ou_owner",
        chatId: "oc_owner",
        chatType: "p2p",
        text: "帮我跟进退款需求",
      });
      expect(workCalls).toHaveLength(1);
      expect(workCalls[0]).toMatchObject({
        principalId: "owner",
        visibility: "private",
        userText: "帮我跟进退款需求",
      });
      const turn = store.db
        .prepare("SELECT result FROM conversation_turns WHERE input_text=?")
        .get("帮我跟进退款需求");
      expect(turn?.result).toBe("已保存退款需求，正在调查。");
    } finally {
      await host.stop();
      expect(realtime.closed).toBe(1);
      store.close();
    }
  });
});
