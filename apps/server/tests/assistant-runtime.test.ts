import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssistantRuntime,
  ModelUnavailableError,
  TurnCancelledError,
  detectTaskIntent,
  type AssistantModelPort,
  type AssistantModelReply,
} from "../src/assistant/runtime.js";
import { MemoryService, FeedbackService } from "../src/memory/service.js";
import {
  LarkEventInbox,
  type LarkInboundEvent,
} from "../src/integrations/lark/realtime.js";
import { EncryptedSecretStore } from "../src/integrations/lark/secret-store.js";
import { Store } from "../src/store.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";

type Resource = { directory: string; store: Store; secrets: EncryptedSecretStore };
const resources: Resource[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), "omem-assistant-"));
  const store = new Store(directory);
  const secrets = new EncryptedSecretStore(
    join(directory, "secrets"),
    randomBytes(32),
  );
  resources.push({ directory, store, secrets });
  return { directory, store, secrets };
};

const ownerProvenance = {
  collectorId: "assistant-test",
  actorId: "owner",
  actorType: "owner" as const,
  actorVerifiedBy: "fixture",
  sourceUri: null,
  eventId: null,
  eventAt: "2026-09-27T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  quoted: false,
  forwarded: false,
  producerKind: "original" as const,
};

const captureSource = (
  store: Store,
  externalId: string,
  text: string,
  extra: { context?: Record<string, unknown>; provenance?: Record<string, unknown> } = {},
) =>
  store.capture({
    source: "manual",
    externalId,
    title: externalId,
    parts: [{ type: "text", text }],
    context: extra.context ?? {},
    provenance: { ...ownerProvenance, ...(extra.provenance ?? {}) },
  }).revision;

class ScriptedModel implements AssistantModelPort {
  readonly calls: {
    userText: string;
    visibility: string;
    evidenceCount: number;
    trustedContext?: string;
  }[] = [];
  constructor(private readonly replies: AssistantModelReply[]) {}
  async generate(input: {
    userText: string;
    visibility: "private" | "group";
    evidence: { fragmentId: string }[];
    trustedContext?: string;
  }): Promise<AssistantModelReply> {
    this.calls.push({
      userText: input.userText,
      visibility: input.visibility,
      evidenceCount: input.evidence.length,
      trustedContext: input.trustedContext,
    });
    const next = this.replies.shift();
    if (!next) throw Error("MODEL_EXHAUSTED");
    return next;
  }
}

describe("detectTaskIntent (unit)", () => {
  it("identifies explicit assignment intents", () => {
    expect(detectTaskIntent("帮我记一下：周五下午3点和张三开会").explicit).toBe(true);
    expect(detectTaskIntent("提醒我明天交报告").explicit).toBe(true);
    expect(detectTaskIntent("创建一个任务").explicit).toBe(true);
    expect(detectTaskIntent("记一下：买牛奶").explicit).toBe(true);
  });
  it("rejects consultation questions", () => {
    expect(detectTaskIntent("接口说明").explicit).toBe(false);
    expect(detectTaskIntent("这个接口怎么写？").explicit).toBe(false);
    expect(detectTaskIntent("这是什么？").explicit).toBe(false);
    expect(detectTaskIntent("你好").explicit).toBe(false);
  });
});

describe("AssistantRuntime (async, governed)", () => {
  it("B-positive: explicit owner assignment creates a task through MemoryService with real receipt", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });

    const model = new ScriptedModel([
      {
        answer: "好的，已记下。",
        citationIds: [],
        toolCalls: [
          {
            tool: "create_task",
            title: "周五下午3点和张三开会",
            detail: "周会",
            citationIds: [],
          },
        ],
      },
    ]);
    const runtime = new AssistantRuntime(store, model, {
      ownerId: "owner",
      memory,
    });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "web-1",
      visibility: "private",
    });

    const result = await runtime.turn({
      conversationId: conversation.id,
      userText: "帮我记一下：周五下午3点和张三开会",
    });
    expect(result.createdTaskIds).toHaveLength(1);
    expect(result.turn.result).toContain("已创建任务");
    expect(store.tasks().map((t) => t.title)).toContain("周五下午3点和张三开会");
  });

  it("B-negative: pure consultation (no explicit intent) creates ZERO tasks even if model emits create_task", async () => {
    const { store } = setup();
    const revision = captureSource(store, "接口说明", "GET /v1/items 列表查询接口。");
    const fragmentId = revision.fragments[0]!.id;
    const memory = new MemoryService(store, { ownerId: "owner" });

    const model = new ScriptedModel([
      {
        answer: "接口说明见 GET /v1/items。",
        citationIds: [fragmentId],
        toolCalls: [
          {
            tool: "create_task",
            title: "补充接口调用示例",
            detail: "按 GET /v1/items 整理",
            citationIds: [fragmentId],
          },
        ],
      },
    ]);
    const runtime = new AssistantRuntime(store, model, {
      ownerId: "owner",
      memory,
    });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "web-consult",
      visibility: "private",
    });

    const result = await runtime.turn({ conversationId: conversation.id, userText: "接口说明" });
    // Zero writes: no task created.
    expect(store.tasks()).toEqual([]);
    expect(result.createdTaskIds).toEqual([]);
    // The answer honestly says no task was created.
    expect(result.turn.result).toContain("未创建任务");
    // The tool action is rejected with reason not_explicit_task_intent.
    const action = (result.turn.toolActions as Array<{ rejected?: boolean; reason?: string }>)[0];
    expect(action).toMatchObject({ rejected: true, reason: "not_explicit_task_intent" });
  });

  it("H-G20: ModelUnavailableError marks turn failed, not degraded, no fake answer", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    const model: AssistantModelPort = {
      generate: async () => {
        throw new ModelUnavailableError("no cli");
      },
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "w",
      visibility: "private",
    });
    const result = await runtime.turn({ conversationId: conversation.id, userText: "你好" });
    expect(result.turn.inputMessageRefs.status).toBe("failed");
    expect(String(result.turn.inputMessageRefs.error)).toContain("model_unavailable");
    expect(result.createdTaskIds).toEqual([]);
    expect(store.tasks()).toEqual([]);
  });

  it("runtime error (non-unavailable) degrades honestly", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    const model: AssistantModelPort = {
      generate: async () => {
        throw Error("boom");
      },
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "w",
      visibility: "private",
    });
    const result = await runtime.turn({ conversationId: conversation.id, userText: "你好" });
    expect(result.degraded).toBe(true);
    expect(result.turn.result).toContain("模型暂时不可用");
    expect(result.createdTaskIds).toEqual([]);
    expect(store.tasks()).toEqual([]);
  });

  it("G09: group conversations deny evidence by default when no policy is injected", async () => {
    const { store } = setup();
    captureSource(store, "群项目文档", "群内公开说明。");
    const model: AssistantModelPort = {
      generate: async (input) => ({
        answer: `evidence=${input.evidence.length}`,
        citationIds: input.evidence.map((e) => e.fragmentId),
      }),
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner" });
    const group = runtime.conversations.open({
      principalId: "owner",
      channel: "lark_group",
      chatId: "oc_g",
      visibility: "group",
    });
    const groupResult = await runtime.turn({ conversationId: group.id, userText: "群项目文档" });
    expect(groupResult.turn.result).toBe("evidence=0");
    expect((groupResult.turn.selectedEvidence as unknown[])).toEqual([]);
    const priv = runtime.conversations.open({
      principalId: "owner",
      channel: "lark_p2p",
      chatId: "oc_p",
      visibility: "private",
    });
    const privResult = await runtime.turn({ conversationId: priv.id, userText: "群项目文档" });
    expect(privResult.turn.result).toBe("evidence=1");
  });

  it("G09: injected policy hides private evidence in group; p2p history does not leak", async () => {
    const { store } = setup();
    const privateRev = captureSource(store, "私人笔记", "密钥 super-secret-123。");
    const publicRev = captureSource(store, "群项目文档", "群内公开说明。", {
      context: { conversationId: "oc_group" },
    });
    const privateFragment = privateRev.fragments[0]!.id;
    const publicFragment = publicRev.fragments[0]!.id;

    const model: AssistantModelPort = {
      generate: async (input) => ({
        answer: input.evidence.map((e) => `${e.fragmentId}:${e.text}`).join("|"),
        citationIds: [privateFragment, publicFragment],
      }),
    };
    const runtime = new AssistantRuntime(store, model, {
      ownerId: "owner",
      visibilityPolicy: ({ conversation, fragmentId }) => {
        if (conversation.visibility === "private") return true;
        const ev = store.evidence(fragmentId);
        return ev?.revision.context?.conversationId === conversation.chatId;
      },
    });

    const p2p = runtime.conversations.open({
      principalId: "owner",
      channel: "lark_p2p",
      chatId: "oc_owner",
      visibility: "private",
    });
    const p2pResult = await runtime.turn({ conversationId: p2p.id, userText: "密钥" });
    expect(p2pResult.turn.result).toContain("super-secret-123");

    const group = runtime.conversations.open({
      principalId: "owner",
      channel: "lark_group",
      chatId: "oc_group",
      visibility: "group",
    });
    const groupResult = await runtime.turn({ conversationId: group.id, userText: "群内公开" });
    expect(groupResult.turn.result).not.toContain("super-secret-123");
    expect(groupResult.turn.result).not.toContain(privateFragment);
    expect(groupResult.turn.result).toContain(publicFragment);
    expect(groupResult.turn.ordinal).toBe(1);
  });

  it("governance: group-member material cannot be turned into an owner task even with explicit intent", async () => {
    const { store } = setup();
    const memberRev = captureSource(store, "群消息", "我周五把报告交了。", {
      context: { conversationId: "oc_group" },
      provenance: {
        actorId: "ou_member",
        actorType: "user",
        actorVerifiedBy: null,
        actorPrincipalId: null,
      },
    });
    const memberFragment = memberRev.fragments[0]!.id;
    const memory = new MemoryService(store, { ownerId: "owner" });

    const model: AssistantModelPort = {
      generate: async () => ({
        answer: "好的",
        citationIds: [],
        toolCalls: [
          {
            tool: "create_task",
            title: "周五交报告",
            detail: "群里成员说的",
            citationIds: [memberFragment],
          },
        ],
      }),
    };
    const runtime = new AssistantRuntime(store, model, {
      ownerId: "owner",
      memory,
      visibilityPolicy: ({ conversation, fragmentId }) => {
        if (conversation.visibility === "private") return true;
        const ev = store.evidence(fragmentId);
        return ev?.revision.context?.conversationId === conversation.chatId;
      },
    });
    const group = runtime.conversations.open({
      principalId: "owner",
      channel: "lark_group",
      chatId: "oc_group",
      visibility: "group",
    });
    // Consultation (no explicit intent) → model tries to cite group-member material → rejected
    const result = await runtime.turn({ conversationId: group.id, userText: "周五交报告是什么" });
    expect(result.createdTaskIds).toEqual([]);
    expect(store.tasks()).toEqual([]);
  });

  it("idempotency: same transport_event_id does not create a second turn or task", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    const model = new ScriptedModel([
      {
        answer: "ok",
        citationIds: [],
        toolCalls: [
          {
            tool: "create_task",
            title: "幂等任务",
            detail: "d",
            citationIds: [],
          },
        ],
      },
    ]);
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "w",
      visibility: "private",
    });
    const first = await runtime.turn({
      conversationId: conversation.id,
      userText: "帮我记一下幂等任务",
      transportEventId: "evt-dup-1",
    });
    expect(first.createdTaskIds).toHaveLength(1);
    const second = await runtime.turn({
      conversationId: conversation.id,
      userText: "帮我记一下幂等任务",
      transportEventId: "evt-dup-1",
    });
    expect(second.duplicate).toBe(true);
    expect(second.turn.id).toBe(first.turn.id);
    expect(store.tasks().filter((t) => t.title === "幂等任务")).toHaveLength(1);
  });

  it("cancellation: a newer message interrupts the in-flight turn without a task", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    let release!: (v: AssistantModelReply) => void;
    let generation = 0;
    const waiters: (() => void)[] = [];
    const waitForGeneration = async (n: number) => {
      while (generation < n)
        await new Promise<void>((resolve) => waiters.push(resolve));
    };
    const model: AssistantModelPort = {
      generate: async ({ signal }) =>
        new Promise<AssistantModelReply>((resolve, reject) => {
          release = resolve;
          signal?.addEventListener("abort", () => reject(new Error("CANCELLED")));
          generation++;
          for (const waiter of waiters.splice(0)) waiter();
        }),
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "w",
      visibility: "private",
    });
    const firstPromise = runtime.turn({ conversationId: conversation.id, userText: "first" });
    await waitForGeneration(1);
    const secondPromise = runtime.turn({ conversationId: conversation.id, userText: "second" });
    await waitForGeneration(2);
    release({ answer: "second reply", citationIds: [] });
    const second = await secondPromise;
    expect(second.turn.result).toBe("second reply");
    const first = await firstPromise;
    expect(first.turn.inputMessageRefs.status).toBe("cancelled");
    expect(first.createdTaskIds).toEqual([]);
    expect(store.tasks()).toEqual([]);
  });

  it("A: RetrievalPort Chinese follow-up recall — '按这个' recalls the imported fragment", async () => {
    const { store } = setup();
    captureSource(store, "会议纪要", "周五下午3点和张三开会讨论接口设计。");
    const retrieval = new KeywordRetrieval(store.db);
    const seenFragments: string[] = [];
    const model: AssistantModelPort = {
      generate: async (input) => {
        seenFragments.push(...input.evidence.map((e) => e.fragmentId));
        return {
          answer: input.evidence.length ? "recalled" : "nothing",
          citationIds: input.evidence.map((e) => e.fragmentId),
        };
      },
    };
    const runtime = new AssistantRuntime(store, model, {
      ownerId: "owner",
      retrieval,
    });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "w",
      visibility: "private",
    });
    // First turn establishes the topic.
    await runtime.turn({ conversationId: conversation.id, userText: "周五下午3点和张三开会讨论接口设计" });
    // Follow-up using a short phrase shares 2-grams ("周五","开会") with the content.
    const result = await runtime.turn({ conversationId: conversation.id, userText: "周五开会" });
    expect(result.turn.result).toBe("recalled");
    expect(seenFragments.length).toBeGreaterThan(0);
  });

  it("A: unrelated query does NOT recall", async () => {
    const { store } = setup();
    captureSource(store, "会议纪要", "周五下午3点和张三开会讨论接口设计。");
    const retrieval = new KeywordRetrieval(store.db);
    const model: AssistantModelPort = {
      generate: async (input) => ({
        answer: input.evidence.length ? "recalled" : "nothing",
        citationIds: [],
      }),
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", retrieval });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "w",
      visibility: "private",
    });
    const result = await runtime.turn({ conversationId: conversation.id, userText: "量子物理坍缩方程推导" });
    expect(result.turn.result).toBe("nothing");
  });

  it("H-G16: correction in same scope reaches model; different scope does not leak", async () => {
    const { store } = setup();
    const feedback = new FeedbackService(store);
    const seen: string[] = [];
    const model: AssistantModelPort = {
      generate: async (input) => {
        seen.push(input.trustedContext ?? "");
        return { answer: "ok", citationIds: [] };
      },
    };
    const runtime = new AssistantRuntime(store, model, {
      ownerId: "owner",
      feedback,
    });
    const conv1 = runtime.conversations.open({
      principalId: "owner", channel: "web", chatId: "w1", visibility: "private",
    });
    const conv2 = runtime.conversations.open({
      principalId: "owner", channel: "web", chatId: "w2", visibility: "private",
    });
    insertScopedCorrection(store, conv1.id, "X", "Y是正确答案");
    await runtime.turn({ conversationId: conv1.id, userText: "X是什么" });
    await runtime.turn({ conversationId: conv2.id, userText: "X是什么" });
    expect(seen[0]).toContain("Y是正确答案");
    expect(seen[1]).not.toContain("Y是正确答案");
  });

});


const insertScopedCorrection = (
  store: Store,
  conversationId: string,
  matchKey: string,
  replacement: string,
) => {
  const at = new Date().toISOString();
  const fbId = `fb-${Math.random().toString(36).slice(2)}`;
  store.db.prepare(
    `INSERT INTO feedback(id,workspace_id,producer,event_id,subject_type,subject_id,actor_provenance,correction,outcome,evidence,scope,created_at,payload_digest)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    fbId, "personal", "test", `evt-${fbId}`, "query", conversationId,
    JSON.stringify({ id: "owner", verifiedBy: "test" }),
    replacement, "fact_correction", "[]",
    JSON.stringify({ workspace_id: "personal", project_id: null, subject_id: conversationId }),
    at, "digest",
  );
  store.db.prepare(
    `INSERT INTO feedback_constraints(id,workspace_id,project_id,subject_id,feedback_id,kind,match_key,replacement,strength,active,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `fc-${fbId}`, "personal", null, conversationId, fbId,
    "fact_correction", matchKey, replacement, "confirmed", 1, at,
  );
};
// ---- Lark wiring (deterministic, no real socket) ----

const larkSetup = () => {
  const resource = setup();
  const at = "2026-09-27T00:00:00.000Z";
  const secretRef = resource.secrets.put({ appId: "cli_a1", clientSecret: "s" });
  resource.store.db
    .prepare(
      `INSERT INTO lark_connections(id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,owner_open_id,created_at,updated_at) VALUES('c1','personal','cli_a1','feishu','t','active',1,'ou_owner',?,?)`,
    )
    .run(at, at);
  resource.store.db
    .prepare(
      `INSERT INTO lark_connection_versions(id,connection_id,version,secret_ref,requested_config,capability_profile,missing_capabilities,state,created_at,updated_at) VALUES('cv1','c1',1,?,'{}',?,'[]','active',?,?)`,
    )
    .run(secretRef, JSON.stringify({ botOpenId: "ou_bot" }), at, at);
  resource.store.db
    .prepare(
      `INSERT INTO lark_bindings(id,workspace_id,connection_id,connection_version,binding_version,owner_open_id,target_chat_id,target_type,state,supersedes_binding_id,created_at) VALUES('b1','personal','c1',1,1,'ou_owner','oc_owner','p2p','active',NULL,?)`,
    )
    .run(at);
  return resource;
};

const larkEvent = (patch: Partial<LarkInboundEvent> = {}): LarkInboundEvent => ({
  appId: "cli_a1",
  eventId: `evt-${Math.random()}`,
  kind: "im.message.receive_v1",
  eventTime: "2026-09-27T00:00:00.000Z",
  senderOpenId: "ou_owner",
  senderType: "user",
  chatId: "oc_owner",
  chatType: "p2p",
  messageId: `om-${Math.random()}`,
  text: "你好",
  payload: { message: { chat_id: "oc_owner" } },
  ...patch,
});

const buildInbox = (store: Store, model: AssistantModelPort) => {
  const runtime = new AssistantRuntime(store, model, { ownerId: "owner" });
  return new LarkEventInbox(store, {
    ownerId: "owner",
    assistant: async (routed) => {
      const conversation = runtime.conversations.open({
        principalId: routed.principalId,
        channel: routed.chatType === "group" ? "lark_group" : "lark_p2p",
        chatId: routed.chatId,
        visibility: routed.chatType === "group" ? "group" : "private",
      });
      const result = await runtime.turn({
        conversationId: conversation.id,
        userText: routed.text,
        transportEventId: routed.eventId,
      });
      return {
        replyText: result.turn.result,
        turnId: result.turn.id,
        status: result.turn.inputMessageRefs.status,
      };
    },
  });
};

describe("Lark main-assistant entry", () => {
  it("routes bound-owner p2p to the assistant, enqueues a reply and links outbox", async () => {
    const { store } = larkSetup();
    const model: AssistantModelPort = {
      generate: async () => ({ answer: "p2p 回复：已收到。", citationIds: [] }),
    };
    const inbox = buildInbox(store, model);
    const result = await inbox.processMessage(
      larkEvent({ text: "找下接口说明" }),
    );
    expect(result).toMatchObject({ outcome: "assistant_reply" });
    expect(String(result.reply)).toContain("p2p 回复");
    const intents = store.db
      .prepare("SELECT target,payload_json FROM delivery_intents WHERE channel='lark'")
      .all();
    expect(intents).toHaveLength(1);
    expect(String((intents[0] as { target: string }).target)).toBe("oc_owner");
    const turn = store.db
      .prepare("SELECT reply_outbox_id FROM conversation_turns WHERE id=?")
      .get(String(result.turnId)) as { reply_outbox_id: string | null };
    expect(turn.reply_outbox_id).not.toBeNull();
  });

  it("keeps unbound senders ignored in p2p (security)", async () => {
    const { store } = larkSetup();
    const model: AssistantModelPort = {
      generate: async () => ({ answer: "should not happen", citationIds: [] }),
    };
    const inbox = buildInbox(store, model);
    const result = await inbox.processMessage(
      larkEvent({ senderOpenId: "ou_stranger", text: "随便发" }),
    );
    expect(result).toMatchObject({ outcome: "ignored_not_allowed" });
    expect(
      store.db.prepare("SELECT count(*) AS n FROM delivery_intents").get(),
    ).toEqual({ n: 0 });
  });

  it("routes @-mentioned owner in group, but leaves background messages to capture", async () => {
    const { store } = larkSetup();
    store.db
      .prepare(
        `INSERT OR IGNORE INTO lark_targets(id,workspace_id,connection_id,binding_version,chat_id,target_type,purpose,capture_enabled,state,created_at,updated_at) VALUES('t-g','personal','c1',1,'oc_group','group','group_monitoring',1,'active',?,?)`,
      )
      .run("2026-09-27T00:00:00.000Z", "2026-09-27T00:00:00.000Z");
    const model: AssistantModelPort = {
      generate: async () => ({ answer: "群内回复", citationIds: [] }),
    };
    const inbox = buildInbox(store, model);

    const mentioned = larkEvent({
      chatId: "oc_group",
      chatType: "group",
      senderOpenId: "ou_owner",
      text: "@ou_bot 帮我看下",
      payload: {
        message: { chat_id: "oc_group", mentions: [{ id: { open_id: "ou_bot" } }] },
      },
    });
    const assistantResult = await inbox.processMessage(mentioned);
    expect(assistantResult).toMatchObject({ outcome: "assistant_reply" });

    const background = larkEvent({
      eventId: "evt-bg",
      chatId: "oc_group",
      chatType: "group",
      senderOpenId: "ou_member",
      text: "普通群消息",
      payload: { message: { chat_id: "oc_group" } },
    });
    const captured = await inbox.processMessage(background);
    expect(captured).toMatchObject({ outcome: "captured" });
  });

  it("duplicate delivery of the same event id does not create a second reply", async () => {
    const { store } = larkSetup();
    let count = 0;
    const model: AssistantModelPort = {
      generate: async () => {
        count++;
        return { answer: `回复 ${count}`, citationIds: [] };
      },
    };
    const inbox = buildInbox(store, model);
    const event = larkEvent({ eventId: "evt-repeat-1", text: "你好" });
    const first = await inbox.processMessage(event);
    expect(first).toMatchObject({ outcome: "assistant_reply" });
    const second = await inbox.processMessage({ ...event });
    expect(
      store.db.prepare("SELECT count(*) AS n FROM delivery_intents").get(),
    ).toEqual({ n: 1 });
  });
});
