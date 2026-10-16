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
