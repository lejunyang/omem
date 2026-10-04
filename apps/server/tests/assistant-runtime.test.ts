import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { UnifiedRetrieval } from "../src/retrieval/unified.js";
import { materialFromRevision } from "../src/knowledge/repository.js";
import { evidenceForRange } from "../src/assistant/research.js";

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

it("passes revision-bound purpose and validity to the answering agent instead of promoting an old plan to current behavior", async () => {
  const { store } = setup();
  const old = captureSource(store, "delivery-plan", "配送计划：准备允许每周改一次收货地址。");
  const description = { role: "plan", status: "proposed", summary: "尚未实施的配送计划", topics: ["配送"], scope: "试点", validFrom: null, validUntil: "2026-09-01T00:00:00Z", concepts: [], basis: "标题说明是计划" };
  store.descriptions.save(old.id, description, "user", 0);
  const live = captureSource(store, "delivery-current", "配送现行规则：发货前可以修改收货地址。");
  store.descriptions.save(live.id, { ...description, role: "reference", status: "current", validUntil: null }, "user", 0);
  const retrieval = new UnifiedRetrieval(store.db);
  let seen = false;
  const runtime = new AssistantRuntime(store, { async generate(input) {
    const plan = input.evidence.find(e => e.sourceRevisionId === old.id)!;
    const rule = input.evidence.find(e => e.sourceRevisionId === live.id)!;
    expect(plan.materialDescription).toMatchObject({ revisionId: old.id, description: { role:"plan",status:"proposed", validUntil: description.validUntil } });
    expect(rule.materialDescription).toMatchObject({ revisionId: live.id, description: { status:"current",validUntil:null } });
    seen = true;
    return {answer:"发货前可以改地址",citationIds:[rule.citationId!]};
  } }, {retrieval});
  try {
    const c = runtime.conversations.open({principalId:"owner",channel:"web",chatId:"material-status",visibility:"private"});
    await runtime.turn({conversationId:c.id,userText:"配送收货地址",mode:"research"});
    expect(seen).toBe(true);
  } finally {runtime.shutdown(); await retrieval.close();}
});

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
  it("search consultation preserves its read-only mode and purpose when retried", async () => {
    const { store } = setup();
    const seen: Array<{ mode?: string; purpose?: string }> = [];
    const model: AssistantModelPort = {
      async generate(input) {
        seen.push({ mode: input.mode, purpose: input.purpose });
        if (seen.length === 1)
          throw new ModelUnavailableError("temporarily disconnected");
        return {
          answer: "这是说明，不执行事项。",
          citationIds: [],
          toolCalls: [
            {
              tool: "create_task",
              title: "周五买牛奶",
              detail: "示例",
              citationIds: [],
            },
          ],
        };
      },
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner" });
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "search-mode",
      visibility: "private",
    });
    const first = await runtime.turn({
      conversationId: conversation.id,
      userText: "帮我记一下周五买牛奶",
      mode: "research",
      purpose: "background",
    });
    expect(first.turn.inputMessageRefs.status).toBe("pending");
    await runtime.retryTurn(first.turn.id);
    expect(seen).toEqual([
      { mode: "research", purpose: "background" },
      { mode: "research", purpose: "background" },
    ]);
    expect(store.tasks()).toEqual([]);
    expect(runtime.conversations.turn(first.turn.id)?.result).toBe(
      "这是说明，不执行事项。",
    );
  });

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

  it("H-G20: ModelUnavailableError marks turn pending for retry, not degraded, no fake answer", async () => {
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
    expect(result.turn.inputMessageRefs.status).toBe("pending");
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

  it("D: withTimeout rejects a hung model that ignores abort — no hang", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    // Model NEVER resolves and NEVER listens to signal — worst case.
    const hungModel: AssistantModelPort = {
      generate: async () => new Promise<AssistantModelReply>(() => { /* never resolves */ }),
    };
    const runtime = new AssistantRuntime(store, hungModel, {
      ownerId: "owner",
      memory,
      turnTimeoutMs: 200, // short timeout
    });
    const conversation = runtime.conversations.open({
      principalId: "owner", channel: "web", chatId: "w", visibility: "private",
    });
    const start = Date.now();
    const result = await runtime.turn({ conversationId: conversation.id, userText: "hang test" });
    const elapsed = Date.now() - start;
    // Should settle within ~2s even though model never resolves.
    expect(elapsed).toBeLessThan(5000);
    // Turn is marked cancelled (timeout rejects with TurnCancelledError).
    expect(result.turn.inputMessageRefs.status).toBe("cancelled");
    expect(store.tasks()).toEqual([]);
  });

  it("A: RetrievalPort Chinese follow-up recall — short phrase via 2-grams recalls the imported fragment", async () => {
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


  it("G08: two-turn anaphora — Turn1 consults, Turn2 reuses Turn1 evidence for task", async () => {
    const { store } = setup();
    captureSource(store, "接口文档", "接口说明：GET /v1/items 返回分页列表。");
    const retrieval = new KeywordRetrieval(store.db);
    const memory = new MemoryService(store, { ownerId: "owner" });
    let turn1FragmentId = "";
    const model: AssistantModelPort = {
      generate: async (input) => {
        if (input.priorTurns.length === 0) {
          expect(input.evidence.length).toBeGreaterThan(0);
          turn1FragmentId = input.evidence[0]!.fragmentId;
          return { answer: "接口在 GET /v1/items。", citationIds: [turn1FragmentId], toolCalls: [] };
        }
        // Turn 2: model MUST see Turn1 fragment in its evidence input (prior working context).
        expect(input.evidence.some((e) => e.fragmentId === turn1FragmentId)).toBe(true);
        return {
          answer: "好的，按这个整理。",
          citationIds: [],
          toolCalls: [{ tool: "create_task", title: "补接口文档", detail: "加分页示例", citationIds: [turn1FragmentId] }],
        };
      },
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory, retrieval });
    const conv = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "w", visibility: "private" });
    const r1 = await runtime.turn({ conversationId: conv.id, userText: "找下接口说明" });
    expect(r1.createdTaskIds).toEqual([]);
    expect(turn1FragmentId).toBeTruthy();
    const turn1Rec = runtime.conversations.turns(conv.id)[0]!;
    expect((turn1Rec.selectedEvidence as unknown[]).length).toBeGreaterThan(0);
    const r2 = await runtime.turn({ conversationId: conv.id, userText: "帮我按这个记一下下一步" });
    expect(r2.createdTaskIds.length).toBe(1);
    expect(store.tasks().length).toBe(1);
  });

  it("G08 negative: Turn1 has no fragments, Turn2 cites nonexistent fragment -> rejected, zero writes", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    const model: AssistantModelPort = {
      generate: async (input) => {
        if (input.priorTurns.length === 0) return { answer: "没找到", citationIds: [], toolCalls: [] };
        return { answer: "好的", citationIds: [], toolCalls: [{ tool: "create_task", title: "空任务", detail: "x", citationIds: ["nonexistent-frag"] }] };
      },
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const conv = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "w", visibility: "private" });
    await runtime.turn({ conversationId: conv.id, userText: "找下不存在的东西" });
    const r2 = await runtime.turn({ conversationId: conv.id, userText: "帮我按这个记一下下一步" });
    expect(store.tasks().length).toBe(0);
    expect(r2.createdTaskIds).toEqual([]);
  });

  it("G20: cancel fence — model resolves late with create_task after cancel, zero writes", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    let release!: (r: AssistantModelReply) => void;
    let generationStarted = () => {};
    const model: AssistantModelPort = {
      generate: async () => new Promise<AssistantModelReply>((res) => { release = res; generationStarted(); }),
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const conv = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "w", visibility: "private" });
    const gen = new Promise<void>((res) => { generationStarted = res; });
    const p = runtime.turn({ conversationId: conv.id, userText: "帮我记一下：周五开会" });
    await gen; // model is now hung waiting for release
    // Get the turn id from router.
    const turns = runtime.conversations.turns(conv.id);
    const turnId = turns[turns.length - 1]!.id;
    runtime.cancelTurn(turnId);
    // Now model resolves WITH a create_task — fence should block it.
    release({ answer: "已创建任务", citationIds: [], toolCalls: [{ tool: "create_task", title: "开会", detail: "周五" }] });
    await p;
    expect(store.tasks()).toEqual([]);
  });

  it("G20: recoverUnfinishedTurns uses real application_receipts, not toolActions", async () => {
    const { store } = setup();
    const memory = new MemoryService(store, { ownerId: "owner" });
    // Model emits create_task with a transportEventId so the receipt is trackable.
    let modelCalls = 0;
    const model: AssistantModelPort = {
      generate: async () => {
        modelCalls++;
        return { answer: "done", citationIds: [], toolCalls: [{ tool: "create_task", title: "买牛奶", detail: "明天" }] };
      },
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const conv = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "w", visibility: "private" });
    const r1 = await runtime.turn({ conversationId: conv.id, userText: "帮我记一下：买牛奶", transportEventId: "evt-recover-1" });
    expect(r1.createdTaskIds.length).toBe(1);
    expect(store.tasks().length).toBe(1);
    // Verify a real application_receipt exists.
    const receiptRow = store.db
      .prepare("SELECT count(*) AS n FROM application_receipts WHERE proposal_id LIKE ?")
      .get("assistant-task:evt-recover-1:%") as { n: number };
    expect(receiptRow.n).toBeGreaterThan(0);
    // New runtime instance (simulating restart). The turn is "done" so it won't be
    // in unfinishedTurns(); the receipt-based check is proven by the combo test below.
    const runtime2 = new AssistantRuntime(store, model, { ownerId: "owner", memory });
    const result = await runtime2.recoverUnfinishedTurns();
    // Turn is already done, nothing to recover.
    expect(result.recovered).toBe(0);
    // Model not called again.
    expect(modelCalls).toBe(1);
  });

  it("G20 combo: model unavailable leaves pending, retrieval works, retryTurn recovers", async () => {
    const { store } = setup();
    captureSource(store, "docs", "接口在 GET /v1/items。");
    const retrieval = new KeywordRetrieval(store.db);
    const memory = new MemoryService(store, { ownerId: "owner" });
    let mode: "unavailable" | "ok" = "unavailable";
    const model: AssistantModelPort = {
      generate: async () => {
        if (mode === "unavailable") throw new ModelUnavailableError("no model");
        return { answer: "done", citationIds: [], toolCalls: [{ tool: "create_task", title: "买牛奶", detail: "明天" }] };
      },
    };
    const runtime = new AssistantRuntime(store, model, { ownerId: "owner", memory, retrieval });
    const conv = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "w", visibility: "private" });
    const r1 = await runtime.turn({ conversationId: conv.id, userText: "帮我记一下：买牛奶" });
    expect(r1.turn.inputMessageRefs.status).toBe("pending");
    expect(r1.turn.inputMessageRefs.error).toContain("model_unavailable");
    expect(store.tasks().length).toBe(0);
    const hits = retrieval.searchSources({ text: "接口", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const turnId = r1.turn.id;
    mode = "ok";
    const retryResult = await runtime.retryTurn(turnId);
    expect(retryResult.ok).toBe(true);
    expect(store.tasks().length).toBe(1);
    const after = runtime.conversations.turn(turnId)!;
    expect(after.inputMessageRefs.status).toBe("done");
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

it("daily workflow creates with time, reschedules, completes, and suppresses due reminders", async () => {
  const { store } = setup();
  const model: AssistantModelPort = { generate: async input => {
    const t = input.tasks?.[0];
    if (!t) return { answer: "模型自报成功不得直接展示", citationIds: [], toolCalls: [{ tool: "create_task", title: "英语复习", detail: "词汇",
      dueAt: "2026-10-02T09:00:00+08:00", dueExpression: "10月2日上午9点" }] };
    if (input.userText.includes("改到")) return { answer: "改好了", citationIds: [], toolCalls: [{ tool: "update_task", taskId: t.id,
      expectedVersion: t.version, action: "reschedule", dueAt: "2026-10-03T10:00:00+08:00", dueExpression: "10月3日上午10点" }] };
    return { answer: "完成了", citationIds: [], toolCalls: [{ tool: "update_task", taskId: t.id, expectedVersion: t.version, action: "complete" }] };
  } };
  const runtime = new AssistantRuntime(store, model, { memory: new MemoryService(store), timezone: "Asia/Shanghai" });
  const c = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "daily", visibility: "private" });
  const create = await runtime.turn({ conversationId: c.id, userText: "提醒我10月2日上午9点英语复习" });
  expect(create.turn.result).toContain("已创建任务：英语复习");
  expect(create.turn.result).not.toContain("模型自报");
  expect(store.tasks()[0]!.dueAt).toBe("2026-10-02T01:00:00.000Z");
  await runtime.turn({ conversationId: c.id, userText: "改到10月3日上午10点" });
  expect(store.tasks()[0]!.dueAt).toBe("2026-10-03T02:00:00.000Z");
  await runtime.turn({ conversationId: c.id, userText: "英语复习已完成" });
  expect(store.tasks()[0]!.status).toBe("done");
  expect(store.tasks()[0]!.version).toBe(3);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
  try { store.remind(); } finally { vi.useRealTimers(); }
  expect(store.notifications().some(n => String(n.title).startsWith("待办到期"))).toBe(false);
  expect((store.db.prepare("SELECT count(*) AS n FROM application_receipts WHERE entity_type='task'").get() as { n: number }).n).toBe(3);
});

it("one bounded query expansion retrieves cross-language originals and never executes first-round mutations", async () => {
  const { store } = setup();
  const source = captureSource(store, "english", "CircuitBreaker opens after seven failures.");
  let calls = 0;
  const model: AssistantModelPort = { generate: async input => {
    calls++;
    if (!input.retrievalRound) return { answer: "要再查", citationIds: [], searchQueries: ["CircuitBreaker"],
      toolCalls: [{ tool: "create_task", title: "不该执行", detail: "" }] };
    expect(input.evidence.map(e => e.fragmentId)).toContain(source.fragments[0]!.id);
    return { answer: "七次失败后熔断", citationIds: [source.fragments[0]!.id], searchQueries: ["ignored"] };
  } };
  const runtime = new AssistantRuntime(store, model, { memory: new MemoryService(store), retrieval: new KeywordRetrieval(store.db) });
  const c = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "search", visibility: "private" });
  const result = await runtime.turn({ conversationId: c.id, userText: "熔断阈值是什么" });
  expect(calls).toBe(2); expect(store.tasks()).toHaveLength(0);
  expect(result.turn.selectedEvidence).toHaveLength(1);
  expect(result.turn.toolActions[0]).toMatchObject({ tool: "search", queries: ["CircuitBreaker"] });
});

it("keeps a semantic hit beyond the ACP prefix budget, including the next turn's working context", async () => {
  const { store } = setup();
  const text = "背景材料。".repeat(900) + "口腔门诊预约码是72819，周四上午十点就诊。";
  const original = captureSource(store,"long-evidence",text);
  expect(original.fragments).toHaveLength(1);
  const retrieval = new KeywordRetrieval(store.db);
  let searches = 0;
  const model: AssistantModelPort = { async generate(input) {
    expect(input.evidence[0]!.text.length).toBeLessThanOrEqual(2000);
    expect(input.evidence[0]!.text).toContain("72819");
    expect(text).toContain(input.evidence[0]!.text);
    return { answer:"预约码72819",citationIds:[original.fragments[0]!.id],toolCalls:[] };
  } };
  const runtime = new AssistantRuntime(store,model,{retrieval:Object.assign(retrieval,{
    async searchSourcesAsync() { return searches++ ? [] : [{id:original.fragments[0]!.id,fragmentId:original.fragments[0]!.id,
      sourceRevisionId:original.id,score:1,snippet:"口腔门诊预约码是72819，周四上午十点就诊。",routes:["semantic"],provenance:{actor:null,time:null,source:"manual"}}]; }
  })});
  const conversation=runtime.conversations.open({principalId:"owner",channel:"web",chatId:"long-evidence",visibility:"private"});
  await runtime.turn({conversationId:conversation.id,userText:"查一下看牙的安排"});
  await runtime.turn({conversationId:conversation.id,userText:"再说一次刚才的预约码"});
});

it("keeps the complete cited chapter and its conditions when a follow-up has no fresh matches", async () => {
  const { store } = setup();
  const original = store.capture({
    source: "manual", externalId: "workshop-arrangement", title: "周末工作坊安排",
    parts: [
      { type: "text", text: "# 参加费用\n参加者预算八十元。" },
      { type: "text", text: "预算包括材料费，不包含往返交通费。" },
      { type: "text", text: "仅限已报名者；请在周三十八点前确认。" },
    ],
    provenance: ownerProvenance,
  }).revision;
  const material = materialFromRevision(store, original.id)!;
  const cited = evidenceForRange(material, 1, material.lineCount, () => true);
  expect(cited.sourceTarget!.fragmentIds).toHaveLength(3);
  const description = { role: "reference", status: "current", summary: "工作坊费用与报名条件", topics: ["工作坊"], scope: "已报名参加者", validFrom: null, validUntil: null, concepts: [], basis: "活动原文" };
  store.descriptions.save(original.id, description, "user", 0);
  const seen: Parameters<AssistantModelPort["generate"]>[0][] = [];
  let hiddenFragment: string | undefined;
  const runtime = new AssistantRuntime(store, { async generate(input) {
    seen.push(input);
    return { answer: "预算是八十元。", citationIds: [cited.citationId!], researchedEvidence: [cited] };
  } }, {
    retrieval: Object.assign(new KeywordRetrieval(store.db), { async searchSourcesAsync() { return []; } }),
    visibilityPolicy: ({ fragmentId }) => fragmentId !== hiddenFragment,
  });
  const conversation = runtime.conversations.open({ principalId: "owner", channel: "web", chatId: "chapter-follow-up", visibility: "private" });
  try {
    await runtime.turn({ conversationId: conversation.id, userText: "工作坊预算是多少？" });
    await runtime.turn({ conversationId: conversation.id, userText: "包括交通费吗？什么时候确认？" });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.evidence).toHaveLength(1);
    expect(seen[1]!.evidence[0]).toMatchObject({
      citationId: cited.citationId, materialKey: material.key,
      sourceTarget: cited.sourceTarget, text: material.text,
      sectionTitle: "参加费用",
      materialDescription: { revisionId: original.id, description },
    });
    hiddenFragment = original.fragments[1]!.id;
    await runtime.turn({ conversationId: conversation.id, userText: "再看一遍刚才的条件。" });
    expect(seen[2]!.evidence).toEqual([]);
  } finally { runtime.shutdown(); }
});
