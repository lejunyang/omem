import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { findSkill, readSkill, readSkillFile, saveAgentSpec, saveSkill } from "../src/agents/specs.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { roleOverlay } from "../src/agents/builtin-roles.ts";
import { getContext, saveContext } from "../src/channels/listen.ts";
import { playbookOf } from "../src/channels/listen-cases.ts";
import { addNotificationSink, listNotifications, releaseLater } from "../src/core/notify.ts";
import { larkNotificationOutlet } from "../src/channels/lark-bot.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { findRule, saveRule } from "../src/rules/store.ts";
import { testApp } from "./helpers.ts";

describe("Agent behavior changes", () => {
  let app: ReturnType<typeof testApp>;
  beforeEach(() => { app = testApp(); app.config.notify.laterTimes = ["18:00"]; }, 45_000);
  afterEach(() => app.db.close());
  const notices = () => listNotifications(app).filter((n) => n.askId && getAsk(app, n.askId).handler === "behavior-change");
  const pending = () => notices().filter((n) => getAsk(app, n.askId!).status === "pending");
  const ctxFor = (input: Record<string, unknown> = {}, kind: Parameters<typeof createRun>[1]["kind"] = "ask"): ToolContext => ({ app, runId: createRun(app, { kind, title: "测试这轮的处理", input, spaceId: "personal" }).id, actor: "agent", spaceId: "personal", spaces: null, tools: null });
  const click = (askId: string, choice = 1, by = "owner") => answerAsk(app, askId, { choice, by });
  const tool = async (ctx: ToolContext, name: string, args: object) => {
    const result = await callTool(ctx, name, args);
    expect(result.isError, result.text).toBe(false);
    return result.text;
  };

  it("coalesces skill files with earliest bytes and latest text, then leaves a note in the conversation", async () => {
    saveSkill(app, { name: "project-a", description: "做法", body: "保持不变\n\n起初写法", files: { "references/a.md": "旧附件" } }, "user");
    const conv = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
    const request = "把技能 project-a 改成先核对再写结论";
    const m = addMessage(app, conv.id, "user", request);
    const args = { name: "project-a", description: "做法", attach: false, owner_request: request, change_reason: "检查放在结论前" };
    await tool(ctxFor({ conversationId: conv.id, messageIds: [m] }), "save_skill", { ...args, body: "保持不变\n\n中间写法", files: { "references/a.md": "中间附件" } });
    await tool(ctxFor({ conversationId: conv.id, messageIds: [m] }), "save_skill", { ...args, body: "保持不变\n\n最终写法", files: { "references/b.md": "新附件" } });
    const [n] = pending();
    expect(pending()).toHaveLength(1);
    expect(n).toMatchObject({ urgency: "later", held: 1, title: expect.stringContaining("按你说的改成了这样") });
    expect(n.body).toContain("起初写法");
    expect(n.body).toContain("最终写法");
    expect(n.body).toContain("references/b.md");
    expect(n.body).not.toMatch(/保持不变|中间写法/);
    expect(listAsks(app)).toHaveLength(0);
    await expect(click(n.askId!, 1, "member")).rejects.toThrow("只有本人");
    await click(n.askId!);
    expect(readSkill(app, "project-a").body).toContain("起初写法");
    expect(readSkillFile(app, "project-a", "references/a.md")).toBe("旧附件");
    expect(readSkill(app, "project-a").files).not.toContain("references/b.md");
    expect(threadMessages(app, conv.id).filter((m) => m.meta.behaviorReverted)).toMatchObject([{ text: expect.stringContaining("本人撤回了这次改动") }]);
    expect(releaseLater(app, new Date(), { now: true })).toBe(0);
  });

  it("tracks a skill, role mount, profile edits and skill grouping, but not a manual tool call", async () => {
    const ctx = ctxFor();
    await tool(ctx, "save_skill", { name: "project-a", description: "做法", body: "核对", agent: "assistant" });
    expect(roleOverlay(app, "assistant").skills.add).toContain("project-a");
    expect(pending()).toHaveLength(2);
    await tool(ctx, "organize_skills", { skills: [{ name: "project-a", group: "checks" }] });
    await tool(ctx, "save_agent", { name: "test-profile", description: "核对", prompt: "按说明检查" });
    expect(pending()).toHaveLength(4);
    for (const keyword of ["技能分组", "角色说明", "Agent 档案", "技能「"]) await click(pending().find((n) => n.title.includes(keyword))!.askId!);
    expect(roleOverlay(app, "assistant").skills.add).not.toContain("project-a");
    expect(findSkill(app, "project-a")).toBeNull();
    await tool({ ...ctx, actor: "user" }, "save_agent", { name: "test-profile", description: "核对", prompt: "由本人保存" });
    expect(pending()).toHaveLength(0);
  });

  it("uses the delayed notification's Feishu card to keep the change", async () => {
    app.config.lark.ownerOpenId = "ou_owner";
    app.config.notify.quietStart = app.config.notify.quietEnd;
    const cards: string[] = [];
    setLarkClient({ im: { message: {
      create: async (args: { data: { content: string } }) => { cards.push(args.data.content); return { code: 0, data: { message_id: "om_change" } }; },
      patch: async () => ({ code: 0 }),
    } } });
    const outlet = larkNotificationOutlet(app);
    const stop = addNotificationSink((n) => outlet.push(n));
    try {
      await tool(ctxFor(), "save_skill", { name: "project-a", description: "做法", body: "核对", attach: false });
      expect(cards).toHaveLength(0);
      expect(releaseLater(app, new Date(), { now: true })).toBe(1);
      await vi.waitFor(() => expect(cards[0]).toMatch(/保留.*撤回/));
      const [n] = pending();
      await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_change" }, action: { value: { action: "ask:0" } } } as never);
      await vi.waitFor(() => expect(getAsk(app, n.askId!).result).toBe("已保留这次改动。"));
      expect(readSkill(app, "project-a").body).toBe("核对");
    } finally { stop(); setLarkClient(null); }
  });

  it("restores a rule's settings, ignores runtime counters, and refuses to overwrite an intervening edit", async () => {
    const rule = saveRule(app, { name: "定时检查", description: "旧做法", enabled: true, judge: "code", trigger: { event: "schedule", cron: "0 8 * * *", once: "event", waitMinutes: 0, unless: [] }, conditions: null, actions: [{ type: "notify", urgent: false }] });
    const ctx = ctxFor();
    await tool(ctx, "save_rule", { id: rule.id, description: "新做法", rule: { trigger: { ...rule.trigger, cron: "0 9 * * *" } } });
    const [first] = pending();
    expect(first.body).toContain("0 8");
    await click(first.askId!);
    expect(findRule(app, rule.id)).toMatchObject({ description: "旧做法", trigger: { cron: "0 8 * * *" } });
    await tool(ctx, "save_rule", { id: rule.id, description: "再改", rule: {} });
    saveRule(app, { ...rule, temporary: undefined, description: "本人后来编辑过" });
    await expect(click(pending()[0].askId!)).rejects.toThrow("后来又改过");
    await click(pending()[0].askId!, 0);
    expect(findRule(app, rule.id)?.description).toBe("本人后来编辑过");
  });

  it("rolls back watch settings and coach playbooks without touching the watch's history", async () => {
    const watch = saveContext(app, { kind: "place", chats: ["oc_watch"], name: "项目 A", note: "旧说明", knobs: { reply: "none", batchMinutes: 10 } });
    await tool(ctxFor(), "set_chat_watch", { context: watch.id, note: "新版说明", batch_minutes: 2 });
    await click(pending()[0].askId!);
    expect(getContext(app, watch.id)).toMatchObject({ note: "旧说明", knobs: { batchMinutes: 10 }, conversationId: watch.conversationId });
    await tool(ctxFor({ contextId: watch.id }, "listen-coach"), "submit_playbook", { scenes: [{ name: "新场景", when: "查到了原因", reply: "yes" }] });
    expect(playbookOf(app, getContext(app, watch.id)!)).toContain("新场景");
    await click(pending()[0].askId!);
    expect(playbookOf(app, getContext(app, watch.id)!)).toBe("");
  });
});
