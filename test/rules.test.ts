import { describe, expect, it } from "vitest";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { callTool } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { listNotifications } from "../src/core/notify.ts";
import { describe as describeCond, evaluate, eventReader } from "../src/rules/conditions.ts";
import { dispatchRuleEvent, testRule } from "../src/rules/engine.ts";
import { deleteRule, getRule, listFirings, saveRule } from "../src/rules/store.ts";
import type { Condition, RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

const msg = (over: Partial<RuleEvent["message"]> = {}, chat = { id: "oc_alerts", name: "项目 A 报警群", kind: "group" as const }, sender: RuleEvent["sender"] = { name: "小王", email: "wang@example.com", kind: "bot" }): RuleEvent => ({
  key: `lark:${over.id ?? "om_1"}`,
  kind: "message",
  at: new Date().toISOString(),
  chat,
  sender,
  message: { id: "om_1", text: "CPU 使用率超过 90%", type: "interactive", mentionsOwner: false, mentionsBot: false, topicId: null, cardTitle: "P1 报警", ...over },
  via: "test",
});

describe("rule conditions", () => {
  it("evaluates fields with and/or/not and reads unknown fields as not matching", async () => {
    const c: Condition = {
      all: [
        { field: "chat.name", op: "contains", value: "报警" },
        { any: [{ field: "sender.name", op: "in", value: ["小王", "小李"] }, { field: "sender.email", op: "endsWith", value: "@ops.example.com" }] },
        { field: "message.type", op: "equals", value: "interactive" },
        { not: { field: "message.text", op: "matches", value: "已恢复|resolved" } },
      ],
    };
    expect(await evaluate(c, eventReader(msg()))).toBe(true);
    expect(await evaluate(c, eventReader(msg({ text: "已恢复：CPU 正常" })))).toBe(false);
    expect(await evaluate(c, eventReader(msg({}, undefined, { name: "小张", kind: "user" })))).toBe(false);
    // A field the event does not have never matches (no chat on a schedule tick).
    expect(await evaluate({ field: "chat.name", op: "contains", value: "" }, eventReader({ key: "s", kind: "schedule", at: "", via: "test" }))).toBe(false);
    // Bots are read only when asked, once.
    let calls = 0;
    const read = eventReader(msg(), { chatBots: async () => (calls++, [{ appId: "cli_qa", name: "问答机器人" }, { appId: "cli_own", name: "小王的助理" }]), ownAppId: "cli_own" });
    expect(await evaluate({ any: [{ field: "chat.bots", op: "contains", value: "问答" }, { field: "chat.bots", op: "contains", value: "报警" }] }, read)).toBe(true);
    // omem's own bot is recognized by app id, whatever it is named.
    expect(await evaluate({ field: "chat.hasOwnBot", op: "is", value: true }, read)).toBe(true);
    expect(await evaluate({ field: "chat.hasOwnBot", op: "is", value: false }, eventReader(msg(), { chatBots: async () => [{ appId: "cli_qa", name: "omem" }], ownAppId: "cli_own" }))).toBe(true);
    // Unknown (no member list): neither true nor false fires.
    expect(await evaluate({ field: "chat.hasOwnBot", op: "is", value: false }, eventReader(msg(), { chatBots: async () => null, ownAppId: "cli_own" }))).toBe(false);
    expect(calls).toBe(1);
    expect(describeCond(c)).toBe("群名包含 报警，并且（发送人是其中之一 小王、小李，或者发送人邮箱结尾是 @ops.example.com），并且消息类型（text / post / interactive 卡片 / image / file…）是 interactive，并且不是（消息内容匹配 已恢复|resolved）");
  });
});

describe("rules", () => {
  it("fires once per event (or once per chat), logs it and runs its actions", async () => {
    const app = testApp();
    const r = saveRule(app, { name: "报警卡片", description: "报警群里的报警卡片通知我", enabled: true, conditions: { all: [{ field: "chat.name", op: "contains", value: "报警" }, { field: "message.type", op: "equals", value: "interactive" }] }, judge: "code", actions: [{ type: "notify", urgent: true }] });
    await dispatchRuleEvent(app, msg());
    // The same message again (the bot and the capture both saw it): handled once.
    await dispatchRuleEvent(app, msg());
    await dispatchRuleEvent(app, msg({ id: "om_2", type: "text" }));
    expect(listFirings(app, r.id)).toHaveLength(1);
    expect(getRule(app, r.id).hits).toBe(1);
    const n = listNotifications(app).find((x) => x.title === "规则「报警卡片」");
    expect(n?.body).toContain("CPU 使用率超过 90%");
    expect(n?.urgency).toBe("urgent");

    // once per chat: the second message in the same chat does not fire again.
    const perChat = saveRule(app, { name: "值班群", description: "值班群里我被 @ 就优先采集", enabled: true, trigger: { event: "message", once: "chat" }, conditions: { field: "message.mentionsOwner", op: "is", value: true }, judge: "code", actions: [{ type: "notify", urgent: false }] });
    await dispatchRuleEvent(app, msg({ id: "om_3", mentionsOwner: true }));
    await dispatchRuleEvent(app, msg({ id: "om_4", mentionsOwner: true }));
    expect(listFirings(app, perChat.id)).toHaveLength(1);
    expect(listFirings(app, perChat.id)[0].eventKey).toBe("chat:oc_alerts");

    // Disabled rules do nothing.
    const off = saveRule(app, { name: "关掉的", description: "x", enabled: false, conditions: { field: "chat.name", op: "contains", value: "报警" }, judge: "code", actions: [{ type: "notify", urgent: false }] });
    await dispatchRuleEvent(app, msg({ id: "om_5" }));
    expect(listFirings(app, off.id)).toHaveLength(0);
    app.db.close();
  });

  it("hands an event to an agent that may only post where the rule allows", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "alert-analyst", description: "分析报警", prompt: "分析报警。" }, "user");
    const quiet = saveRule(app, { name: "只告诉我", description: "报警交给 alert-analyst，结论告诉我", enabled: true, conditions: { field: "chat.name", op: "contains", value: "报警" }, judge: "code", actions: [{ type: "agent", spec: "alert-analyst", task: "看看要不要关注", ownTopic: false, reply: "none" }] });
    await dispatchRuleEvent(app, msg({ id: "om_10" }));
    const f = listFirings(app, quiet.id)[0];
    expect(f.results[0]).toMatchObject({ action: "agent", ok: true });
    const runRow = one<{ input: string }>(app.db, "select input from runs where id = ?", f.results[0].runId!);
    const input = JSON.parse(runRow!.input);
    expect(input).toMatchObject({ spec: "alert-analyst", rule: { id: quiet.id }, lark: { chats: [], draft: false } });
    expect(input.threadId).toBeUndefined();
    expect(input.task).toContain("CPU 使用率超过 90%");
    expect(input.task).toContain("看看要不要关注");

    const auto = saveRule(app, { name: "直接回复", description: "报警交给 alert-analyst，直接在群里回复", enabled: true, conditions: { field: "chat.name", op: "contains", value: "报警" }, judge: "code", actions: [{ type: "agent", spec: "alert-analyst", task: "", ownTopic: false, reply: "auto" }] });
    await dispatchRuleEvent(app, msg({ id: "om_11" }));
    const autoInput = JSON.parse(one<{ input: string }>(app.db, "select input from runs where id = ?", listFirings(app, auto.id)[0].results[0].runId!)!.input);
    expect(autoInput.lark).toEqual({ chats: ["oc_alerts"], draft: false });
    expect(one<{ external_id: string }>(app.db, "select external_id from conversations where id = ?", autoInput.threadId)?.external_id).toBe("oc_alerts");

    // A missing spec fails that action only; the firing is still logged.
    const broken = saveRule(app, { name: "缺档案", description: "x", enabled: true, conditions: { field: "chat.name", op: "contains", value: "报警" }, judge: "code", actions: [{ type: "agent", spec: "ghost", task: "", ownTopic: false, reply: "none" }, { type: "notify", urgent: false }] });
    await dispatchRuleEvent(app, msg({ id: "om_12" }));
    expect(listFirings(app, broken.id)[0].results.map((x) => x.ok)).toEqual([false, true]);
    app.db.close();
  });

  it("checks rules before saving them, keeps a schedule for timed rules, and tries a rule on captured messages", async () => {
    const app = testApp();
    expect(() => saveRule(app, { name: "x", description: "x", judge: "code", conditions: null, actions: [{ type: "notify", urgent: false }] })).toThrow(/需要条件/);
    expect(() => saveRule(app, { name: "x", description: "x", trigger: { event: "schedule", once: "event" }, judge: "code", conditions: null, actions: [{ type: "notify", urgent: false }] })).toThrow(/cron/);
    expect(() => saveRule(app, { name: "x", description: "x", trigger: { event: "schedule", once: "event", cron: "0 9 * * *" }, judge: "code", conditions: null, actions: [{ type: "invite-bot" }] })).toThrow(/定时规则/);
    const timed = saveRule(app, { name: "每早", description: "每天早上看发布群", enabled: true, trigger: { event: "schedule", once: "event", cron: "0 9 * * *" }, judge: "code", conditions: null, actions: [{ type: "notify", urgent: false }] });
    expect(one(app.db, "select 1 from schedules where id = ? and kind = 'rule'", `rule:${timed.id}`)).toBeTruthy();
    deleteRule(app, timed.id);
    expect(one(app.db, "select 1 from schedules where id = ?", `rule:${timed.id}`)).toBeUndefined();

    // Captured messages: two in the alert chat, one elsewhere.
    run(app.db, "insert into lark_cursors(chat_id, name, chat_mode, last_time, last_ids, updated_at) values('oc_alerts','项目 A 报警群','group',0,'[]',?), ('oc_chat','闲聊群','group',0,'[]',?)", new Date().toISOString(), new Date().toISOString());
    const ins = (id: string, chat: string, type: string, content: string) =>
      run(app.db, "insert into lark_messages(message_id, chat_id, sender_name, sender_kind, msg_type, content, create_ms, resources, reactions, mentions) values(?,?,?,?,?,?,?,?,?,?)", id, chat, "小王", "app", type, content, Date.now() - 60_000, "{}", "[]", "[]");
    ins("om_a", "oc_alerts", "interactive", '<card title="P1 报警">CPU 高</card>');
    ins("om_b", "oc_alerts", "text", "收到");
    ins("om_c", "oc_chat", "interactive", '<card title="周报">本周…</card>');
    const t = await testRule(app, { name: "试", description: "报警卡片", conditions: { all: [{ field: "chat.name", op: "contains", value: "报警" }, { field: "message.cardTitle", op: "contains", value: "报警" }] }, judge: "code", actions: [{ type: "notify", urgent: false }] });
    expect(t.checked).toBe(3);
    expect(t.matches.map((m) => m.messageId)).toEqual(["om_a"]);
    // Trying fires nothing.
    expect(all(app.db, "select 1 from rule_firings")).toHaveLength(0);
    app.db.close();
  });

  it("lets the main assistant set a rule (off until the owner enables it), not an agent spec", async () => {
    const app = testApp();
    const main = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const, userId: "owner" };
    const r = await callTool(main, "save_rule", { description: "群里有人提到合同到期就通知我", rule: { name: "合同到期", conditions: { field: "message.text", op: "contains", value: "合同到期" }, judge: "code", actions: [{ type: "notify" }] } });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/未启用/);
    expect((await callTool(main, "list_rules", {})).text).toMatch(/合同到期.*消息内容包含 合同到期/s);
    const spec = await callTool({ ...main, spec: "helper" }, "save_rule", { description: "x", rule: { conditions: null, judge: "ai", actions: [{ type: "notify" }] } });
    expect(spec.isError).toBe(true);
    app.db.close();
  });
});
