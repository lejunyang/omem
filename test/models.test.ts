import { describe, expect, it } from "vitest";
import { createThread, findThread } from "../src/agents/threads.ts";
import { normalizeModel, resolveModelOption, resolveRoleProfile } from "../src/agents/models.ts";
import { saveProbe } from "../src/agents/probe.ts";
import { run } from "../src/core/db.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { testApp } from "./helpers.ts";

describe("model name normalization", () => {
  it("matches case, separators and token order", () => {
    expect(normalizeModel("GPT-Sol-6.1")).toBe("gpt-sol-6.1");
    expect(resolveModelOption("GPT-Sol-6.1", ["gpt-6.1-sol"])).toEqual({ value: "gpt-6.1-sol", matched: true });
    expect(resolveModelOption("sol 6.1", ["gpt-6.1-sol"]).matched).toBe(true);
    // a bare version must not match a family it never names
    expect(resolveModelOption("6.1", ["gpt-6.1-sol"]).matched).toBe(false);
    expect(resolveModelOption("exact-id", ["exact-id"]).value).toBe("exact-id");
    const miss = resolveModelOption("gpt-99", ["gpt-6.1-sol", "claude"]);
    expect(miss).toEqual({ value: "gpt-99", matched: false });
  });

  it("applies role-level model/effort overrides per backend", () => {
    const app = testApp();
    app.config.agents.roleModels = { wiki: { traex: { model: "gpt-6.1-sol", effort: "low" } } };
    const base = { id: "traex", transport: "acp" as const, command: "traex", args: [], env: {}, idleTimeoutMs: 0, model: "gpt-fast", effort: "medium" };
    expect(resolveRoleProfile(app, base, "wiki")).toMatchObject({ model: "gpt-6.1-sol", effort: "low" });
    expect(resolveRoleProfile(app, base, "assistant")).toBe(base);
    expect(resolveRoleProfile(app, { ...base, id: "other" }, "wiki")).toMatchObject({ model: "gpt-fast" });
  });
});

describe("feishu /model card actions", () => {
  const recordModelCard = (app: ReturnType<typeof testApp>, threadId: string, messageId: string) => {
    run(
      app.db,
      "insert into card_interactions(id,message_id,chat_id,conversation_id,run_id,purpose,allowed,payload,created_at) values(?,?,?,?,?,?,?,?,?)",
      "ci_test", messageId, "oc_g", threadId, null, "model", "[]", "{}", new Date().toISOString(),
    );
  };

  it("normalizes a typed model name onto the offered one and stores it on the thread", async () => {
    const app = testApp();
    app.config.agents.profiles.push({ id: "traex", name: "TraeX", transport: "acp", command: "traex", args: [], env: {}, idleTimeoutMs: 0 });
    app.config.agents.default = "traex";
    const t = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_g" });
    saveProbe(app, "traex", { at: new Date().toISOString(), agent: "traex", models: ["gpt-6.1-sol", "gpt-fast"], efforts: ["low", "medium", "high"] });
    recordModelCard(app, t.id, "om_card");

    const r = await handleCardAction(app, {
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_card" },
      action: { tag: "form", name: "model", form_value: { profile: "", model: "", effort: "high", modelText: "GPT-Sol-6.1" } },
    });
    expect(r.toast.type).toBe("success");
    const updated = findThread(app, t.id)!;
    expect(updated.settings.model).toBe("gpt-6.1-sol");
    expect(updated.settings.effort).toBe("high");
  });

  it("restores defaults from the off button without queuing an agent turn", async () => {
    const app = testApp();
    const t = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_g", settings: { model: "gpt-6.1-sol", effort: "low" } });
    recordModelCard(app, t.id, "om_off");
    const r = await handleCardAction(app, {
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_off" },
      action: { tag: "button", value: { action: "model:off" } },
    });
    expect(r.toast.content).toMatch(/默认/);
    const updated = findThread(app, t.id)!;
    expect(updated.settings.model).toBeNull();
    expect(updated.settings.effort).toBeNull();
  });
});

describe("feishu item reminder cards", () => {
  it("resolves 已处理/忽略 without an agent and answers in the callback shape Feishu accepts", async () => {
    const { upsertItem, getItem } = await import("../src/items/store.ts");
    const { recordInteraction } = await import("../src/channels/lark-send.ts");
    const app = testApp();
    const item = upsertItem(app, undefined, { title: "核对西溪宾馆入住" });
    recordInteraction(app, { messageId: "om_item", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: item.id } });
    const r = (await handleCardAction(app, {
      operator: { open_id: "ou_owner" },
      context: { open_message_id: "om_item" },
      action: { tag: "button", value: { action: `item:cancel:${item.id}` } },
    })) as { toast: { type: string }; card?: { type: string; data: Record<string, unknown> } };
    expect(r.toast.type).toBe("success");
    // A bare card object here is what made Feishu show an error; it must be wrapped.
    expect(r.card?.type).toBe("raw");
    expect(JSON.stringify(r.card?.data)).toContain("核对西溪宾馆入住");
    expect(getItem(app, item.id).status).toBe("cancelled");
  });

  it("turns citations into links Feishu can open and drops internal ones", async () => {
    const { upsertSource } = await import("../src/sources/store.ts");
    const { resolveCitations } = await import("../src/channels/common.ts");
    const app = testApp();
    const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://tenant.larkoffice.com/docx/AbC", title: "文档", text: "x" });
    const chat = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_123abc", title: "群", text: "y" });
    const out = resolveCitations(app, `[文档](src:${doc.id}#L1-L2) [群](src:${chat.id}) [记忆](mem:m1) [详情](#/runs/r1)`);
    expect(out).toContain("[文档](https://tenant.larkoffice.com/docx/AbC)");
    expect(out).toContain("openChatId=oc_123abc");
    expect(out).not.toContain("mem:");
    expect(out).not.toContain("#/runs");
  });
});
