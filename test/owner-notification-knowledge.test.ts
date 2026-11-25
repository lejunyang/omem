import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAsk } from "../src/agents/asks.ts";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool } from "../src/agents/tools.ts";
import { larkNotificationOutlet } from "../src/channels/lark-bot.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { one, run } from "../src/core/db.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { labelOutcomes } from "../src/core/notify-outcome.ts";
import { addNotificationSink, listNotifications, notify, QUIET_HANDLED, releaseLater } from "../src/core/notify.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

describe("background Feishu notifications about what the owner already knows", () => {
  let app: ReturnType<typeof testApp>;
  let outlet: ReturnType<typeof larkNotificationOutlet>;
  const send = vi.fn(async (_request: unknown) => ({ code: 0, data: { message_id: "om_notice" } }));
  const model = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
    answers: [{ type: "predicate", name: "q", probability: 0.95 }],
  })));

  beforeEach(() => {
    app = testApp();
    app.config.lark.ownerOpenId = "ou_example";
    app.config.notify.quietStart = app.config.notify.quietEnd = 0;
    app.config.ai.providers = [{ id: "example", name: "测试决策", kind: "openai", backends: [] }];
    app.config.ai.decision = { provider: "example", model: "", fallback: "general", gatekeeper: true };
    setKey(app.home, "example", "example-key");
    send.mockClear();
    model.mockClear();
    setDecisionFetchForTests(model);
    setLarkClient({ im: { message: { create: send } } });
    outlet = larkNotificationOutlet(app);
  });
  afterEach(() => {
    vi.useRealTimers();
    setDecisionFetchForTests(null);
    resetDecisionCooldownForTests();
    setLarkClient(null);
    app.db.close();
  });

  function ownerSaid(text: string, { lark = false, at = Date.now(), topic = null }: { lark?: boolean; at?: number; topic?: string | null } = {}) {
    if (lark) {
      run(app.db, "insert into lark_messages(message_id,chat_id,thread_id,sender_kind,content,create_ms) values(?, 'oc_other', ?, 'owner',?,?)",
        "om_owner_" + text.length, topic, text, at);
    } else {
      const t = createThread(app, { channel: "web", spaceId: "personal" });
      addMessage(app, t.id, "user", text, null, {});
    }
  }

  function draft(extra: Partial<Parameters<typeof notify>[1]> = {}) {
    const r = createRun(app, { kind: "heartbeat", title: "后台巡检" });
    return notify(app, { title: "项目 A 已恢复", body: "登录检查 APP-12345 已通过。", runId: r.id, agentInitiated: true, ...extra }, { push: false });
  }

  it("uses matched owner messages from other chats and records a known outcome", async () => {
    ownerSaid("我刚恢复了 APP-12345，验证通过。", { lark: true });
    ownerSaid("APP-12345 的检查标准是什么？");
    ownerSaid("这一句没有共同线索。");
    const source = upsertSource(app, { spaceId: "personal", kind: "chat", title: "项目 A 群", uri: "lark:oc_project", text: "小王：登录检查 APP-12345 已通过。" });
    const n = draft({ body: "登录检查已通过。", sourceRefs: ["src:" + source.id + "#L1"] });
    await outlet.push(n);
    expect(send).not.toHaveBeenCalled();
    expect(model).toHaveBeenCalledOnce();
    const material = String(model.mock.calls[0][1]?.body);
    expect(material).toContain("我刚恢复了 APP-12345");
    expect(material).toContain("检查标准是什么");
    expect(material).not.toContain("没有共同线索");
    expect(listNotifications(app)).toMatchObject([{ id: n.id, quiet: QUIET_HANDLED, unread: false }]);
    expect(one(app.db, "select scene, taken from decisions where ref=?", n.id)).toMatchObject({ scene: "notify-known", taken: "yes" });
    run(app.db, "update notifications set at=? where id=?", new Date(Date.now() - 49 * 3600_000).toISOString(), n.id);
    labelOutcomes(app);
    expect(one(app.db, "select outcome from notifications where id=?", n.id)).toMatchObject({ outcome: "known" });
  });

  it("pushes without calling the model when the owner has no related recent messages", async () => {
    ownerSaid("我关掉了 APP-123456。");
    ownerSaid("APP-12345 已办好。", { lark: true, at: Date.now() - 5 * 3600_000 });
    await outlet.push(draft());
    expect(model).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("matches another citation to an overlapping source passage", async () => {
    const s = upsertSource(app, { spaceId: "personal", kind: "doc", title: "排查记录", uri: "https://example.com/doc", text: "引言\n已完成恢复\n检查通过" });
    ownerSaid("我处理完了，见 src:" + s.id + "#L2-L3");
    await outlet.push(draft({ sourceRefs: ["src:" + s.id + "#L1-L2"] }));
    expect(model).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps owner messages in the cited topic and skips a different topic of the same group", async () => {
    const text = "小王：页面恢复了。";
    const s = upsertSource(app, { spaceId: "personal", kind: "chat", title: "项目 A 群", uri: "lark:oc_other", text });
    run(app.db, "insert into lark_messages(message_id,chat_id,thread_id,content,create_ms) values('om_trigger','oc_other','omt_recovery',?,?)", text, Date.now());
    run(app.db, "insert into lark_message_lines(source_id,message_id,line) values(?, 'om_trigger', 1)", s.id);
    const n = draft({ body: "页面恢复了。", sourceRefs: ["src:" + s.id + "#L1"] });
    ownerSaid("我要更新本周的排班。", { lark: true, topic: "omt_shift" });
    await outlet.push(n);
    expect(model).not.toHaveBeenCalled();
    ownerSaid("我这边验证页面已经恢复。", { lark: true, topic: "omt_recovery" });
    await outlet.push(n);
    expect(model).toHaveBeenCalledOnce();
    expect(String(model.mock.calls[0][1]?.body)).not.toContain("本周的排班");
  });

  it("pushes when the model fails, is absent, or lacks confidence", async () => {
    ownerSaid("我已经办完 APP-12345。");
    model.mockRejectedValueOnce(new Error("测试连接出错"));
    await outlet.push(draft());
    expect(model).toHaveBeenCalledOnce();
    resetDecisionCooldownForTests();
    model.mockResolvedValueOnce(new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: 0.79 }] })));
    await outlet.push(draft());
    app.config.ai.decision.provider = "";
    await outlet.push(draft());
    expect(model).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(3);
    expect(listNotifications(app).every(n => !n.quiet)).toBe(true);
  });

  it("keeps asks, urgent notifications and explicit rule notifications out of the decision", async () => {
    ownerSaid("我已经办完 APP-12345。");
    const ask = createAsk(app, { runId: null, kind: "approval", question: "是否关闭 APP-12345？", context: { afterReply: true } });
    await outlet.push(draft({ askId: ask.id }));
    await outlet.push(draft({ urgency: "urgent" }));
    await outlet.push(draft({ agentInitiated: false, title: "规则「项目 A」" }));
    expect(model).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("marks tool notifications from a patrol as background and preserves direct replies", async () => {
    const t = createThread(app, { channel: "web", spaceId: "personal" });
    const m = addMessage(app, t.id, "user", "请把 APP-12345 的结论发给我。", null, {});
    const inputs = [
      createRun(app, { kind: "heartbeat", title: "巡检" }),
      createRun(app, { kind: "dream", title: "整理记忆" }),
      createRun(app, { kind: "curate", title: "整理原件" }),
      createRun(app, { kind: "ask", title: "本人要求的结果", input: { conversationId: t.id, messageIds: [m] } }),
    ];
    for (const r of inputs) {
      const res = await callTool({ app, actor: "agent", spaceId: "personal", spaces: null, tools: null, runId: r.id },
        "notify", { title: r.title, body: "APP-12345 已恢复。" });
      expect(res.isError, res.text).toBe(false);
    }
    const notifications = listNotifications(app);
    for (const title of ["巡检", "整理记忆", "整理原件"]) {
      expect(notifications.find(n => n.title === title)).toMatchObject({ agentInitiated: true });
    }
    const direct = notifications.find(n => n.title === "本人要求的结果")!;
    expect(direct.agentInitiated).toBeUndefined();
    await outlet.push({ ...direct, userId: "owner", readAt: direct.readAt ?? null });
    expect(send).toHaveBeenCalledOnce();
    expect(model).not.toHaveBeenCalled();
  });

  it("leaves already known entries out of the Feishu later summary", async () => {
    ownerSaid("我已经办完 APP-12345。");
    const known = draft({ urgency: "later" });
    draft({ title: "项目 B", body: "投递结果", urgency: "later" });
    draft({ title: "项目 C", body: "投递结果", urgency: "later" });
    const deliveries: Promise<void>[] = [];
    const stop = addNotificationSink(n => { deliveries.push(outlet.push(n)); });
    try {
      releaseLater(app, new Date(), { now: true });
      await Promise.all(deliveries);
      expect(send).toHaveBeenCalledOnce();
      expect(JSON.stringify(send.mock.calls[0])).toContain("项目 B");
      expect(JSON.stringify(send.mock.calls[0])).not.toContain("项目 A 已恢复");
      expect(listNotifications(app).find(n => n.id === known.id)?.quiet).toBe(QUIET_HANDLED);
    } finally { stop(); }
  });

  it("rechecks the contents of a notification batch deferred by quiet hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T03:20:00Z"));
    app.config.timezone = "UTC";
    app.config.notify.quietStart = 22;
    app.config.notify.quietEnd = 4;
    const known = draft();
    for (const project of ["项目 B", "项目 C", "项目 D"]) {
      await outlet.push(draft({ title: project, body: "进展已记录。" }));
    }
    await outlet.push(known);
    expect(send).not.toHaveBeenCalled();
    ownerSaid("刚办完 APP-12345。");
    vi.setSystemTime(new Date("2026-10-20T04:05:00Z"));
    await outlet.sendDeferred();
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(send.mock.calls[0])).toContain("项目 B");
    expect(JSON.stringify(send.mock.calls[0])).not.toContain("项目 A 已恢复");
    expect(listNotifications(app).find(n => n.id === known.id)?.quiet).toBe(QUIET_HANDLED);
  });
});
