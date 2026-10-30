import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, listRuns } from "../src/agents/runs.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { createThread, findThread, threadMessages } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { backfillTick, capturedChats, pollLark, requestBackfill, setCapturePolicy } from "../src/channels/lark-personal.ts";
import { fillResources, missingResources, sourceMessages, storeMessages } from "../src/channels/lark-messages.ts";
import { mkdirSync as mkdirS, writeFileSync as writeF } from "node:fs";
import { run as runSql } from "../src/core/db.ts";
import { buildCard, setLarkClient } from "../src/channels/lark-send.ts";
import { expireWatches, listWatches, routeWatchedMessages, setWatchRule } from "../src/channels/lark-watch.ts";
import { recordCodeActivity } from "../src/sources/activity.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

/** A stand-in for the Feishu SDK client that records what the bot would do. */
function fakeClient() {
  const calls: { op: string; args: any }[] = [];
  let n = 0;
  const ok = (data: any) => ({ code: 0, data });
  return {
    calls,
    im: {
      message: {
        create: async (args: any) => (calls.push({ op: "create", args }), ok({ message_id: `om_${++n}` })),
        reply: async (args: any) => (calls.push({ op: "reply", args }), ok({ message_id: `om_${++n}`, thread_id: args.data.reply_in_thread ? "omt_1" : undefined })),
        patch: async (args: any) => (calls.push({ op: "patch", args }), ok({})),
        get: async (args: any) => ok({ items: [{ chat_id: args.path.message_id.startsWith("om_g") ? "oc_g" : "oc_other" }] }),
      },
      messageReaction: { create: async (args: any) => (calls.push({ op: "react", args }), ok({ reaction_id: "r1" })), delete: async () => ok({}) },
    },
  };
}

afterEach(() => {
  setLarkClient(null);
  setLarkCliForTests(null);
});

describe("feishu bot messaging", () => {
  it("converts citations in sends, nested cards, updates and drafts while preserving callback data", async () => {
    const app = testApp();
    const client = fakeClient();
    setLarkClient(client);
    const uri = "https://tenant.larkoffice.com/docx/Guide";
    const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri, title: "操作说明", text: "申请后需确认" });
    // Inline: the words link to the document. Trailing, with nothing to open (no run, so no share): left out.
    const md = `按[流程说明](src:${doc.id}#L1-L1)办理。[记忆](mem:m1) [缺失](src:missing)`;
    const expected = `按[流程说明](${uri})办理。`;
    const ctx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_g"] }))!;
    for (const content of [{ text: md }, { markdown: md }]) {
      expect((await callTool(ctx, "lark_send", { chat_id: "oc_g", ...content })).isError).toBe(false);
      expect(client.calls.at(-1)!.args.data.content).toContain(expected);
    }
    expect((await callTool(ctx, "lark_card", { chat_id: "oc_g", blocks: [{ markdown: md }, { fields: [{ label: "来源", value: md }] }] })).isError).toBe(false);
    expect(client.calls.at(-1)!.args.data.content).toContain(expected);
    expect(client.calls.at(-1)!.args.data.content).not.toContain("src:");
    const callback = { tag: "markdown", content: md };
    const raw = { schema: "2.0", body: { elements: [{ tag: "div", text: { tag: "lark_md", content: md } }, { tag: "button", behaviors: [{ type: "callback", value: callback }] }] } };
    expect((await callTool(ctx, "lark_update_card", { message_id: "om_g1", raw_card: raw })).isError).toBe(false);
    const updated = JSON.parse(client.calls.at(-1)!.args.data.content);
    expect(updated.body.elements[0].text.content).toBe(expected);
    expect(updated.body.elements[1].behaviors[0].value).toEqual(callback);
    expect(raw.body.elements[0].text?.content).toBe(md);
    app.config.lark.ownerOpenId = "ou_owner";
    expect((await callTool({ ...ctx, larkDraft: true }, "lark_send", { chat_id: "oc_g", markdown: md })).text).toContain("草稿");
    expect(client.calls.at(-1)!.args.data.content).toContain(expected);
    const pending = all<{ payload: string }>(app.db, "select payload from card_interactions where purpose='draft'");
    expect(JSON.parse(pending[0].payload).content.markdown).toBe(expected);
  });

  it("converts a rule agent's first topic reply while retaining internal citations in its run", async () => {
    const { __testHandlers: handlers } = await import("../src/agents/runs.ts");
    await import("../src/agents/jobs.ts");
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1"; // The fixed ACP reply does not call tools.
    const client = fakeClient();
    setLarkClient(client);
    const uri = "https://tenant.larkoffice.com/docx/Guide";
    const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri, title: "操作说明", text: "申请后需确认\n完成后可删除" });
    const answer = `先确认，见[流程说明](src:${doc.id}#L1-L1)。完成后可删除。[删除规则](src:${doc.id}#L1-L2)`;
    app.config.agents.profiles.push({ id: "citation-test", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_SAY: answer }, idleTimeoutMs: 30000 });
    saveAgentSpec(app, { name: "topic-helper", description: "话题回复", agent: "citation-test", prompt: "按原件回答" }, "user");
    const run = createRun(app, { kind: "agent", spaceId: "personal", title: "话题回复", input: { spec: "topic-helper", task: "回复流程", rule: { id: "rule_fixture", name: "回复" }, replyAt: { chatId: "oc_g", messageId: "om_g1" }, lark: { chats: ["oc_g"] } } });
    const result = await handlers.get("agent")!({ app, run, signal: AbortSignal.timeout(30000), event: () => {}, output: () => {} }) as { answer: string };
    expect(result.answer).toBe(answer);
    const sent = client.calls.filter(c => c.op === "reply");
    expect(sent).toHaveLength(1);
    expect(sent[0].args.data.reply_in_thread).toBe(true);
    const body = JSON.parse(sent[0].args.data.content).body.elements[0].content;
    expect(body).toBe(`先确认，见[流程说明](${uri})。完成后可删除。[①](${uri})`);
    // Posted its conclusion itself (lark_send to @ someone) and ends QUIET: nothing is sent twice.
    app.config.agents.profiles.find(p => p.id === "citation-test")!.env.FAKE_SAY = "结论已在话题里发出。\n\nQUIET";
    await handlers.get("agent")!({ app, run, signal: AbortSignal.timeout(30000), event: () => {}, output: () => {} });
    expect(client.calls.filter(c => c.op === "reply")).toHaveLength(1);
    app.config.agents.profiles.find(p => p.id === "citation-test")!.env.FAKE_SAY = "QUIET";
    const followup = { ...run, input: { ...run.input as Record<string, unknown>, wake: true } };
    await handlers.get("agent")!({ app, run: followup, signal: AbortSignal.timeout(30000), event: () => {}, output: () => {} });
    expect(client.calls.filter(c => c.op === "reply")).toHaveLength(1);
  }, 40000);

  it("builds Card 2.0 with buttons and forms", () => {
    const card = buildCard({
      title: "告警",
      color: "red",
      blocks: [{ fields: [{ label: "服务", value: "api" }] }, { buttons: [{ text: "认领", value: "claim", style: "primary" }] }, { form: { fields: [{ type: "select", name: "level", options: [{ text: "P0", value: "p0" }] }, { type: "input", name: "note" }] } }],
    }) as any;
    expect(card.schema).toBe("2.0");
    expect(card.header.template).toBe("red");
    const json = JSON.stringify(card);
    expect(json).toContain('"behaviors":[{"type":"callback","value":{"action":"claim"}}]');
    expect(json).toContain('"tag":"form"');
    expect(json).toContain('"form_action_type":"submit"');
    expect(json).toContain('"tag":"select_static"');
  });

  it("posts within scope, restricts who may act, and routes actions back to the conversation", async () => {
    const app = testApp();
    const client = fakeClient();
    setLarkClient(client);
    const t = createThread(app, { spaceId: "personal", channel: "lark-watch", key: "oc_g" });
    const run = createRun(app, { kind: "ask", title: "x", input: { conversationId: t.id, messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const ctx = toolContextForToken(app, issueToolToken({ runId: run.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_g"] }))!;

    expect((await callTool(ctx, "lark_send", { chat_id: "oc_other", text: "hi" })).text).toMatch(/不能往这个飞书会话发消息/);
    expect((await callTool(ctx, "lark_react", { message_id: "om_g1", emoji: "OnIt" })).text).toBe("已加表情");
    const sent = await callTool(ctx, "lark_card", { reply_to: "om_g1", in_thread: true, title: "认领", blocks: [{ buttons: [{ text: "我来", value: "claim" }] }], allowed: ["ou_a"] });
    expect(sent.text).toMatch(/已发送 om_\d+（话题 omt_1）/);
    const cardId = /已发送 (om_\d+)/.exec(sent.text)![1];
    expect(client.calls.find((c) => c.op === "reply")!.args.data.reply_in_thread).toBe(true);

    expect(await handleCardAction(app, { operator: { open_id: "ou_b" }, context: { open_message_id: cardId }, action: { tag: "button", value: { action: "claim" } } })).toMatchObject({ toast: { type: "error" } });
    const ok = await handleCardAction(app, { operator: { open_id: "ou_a" }, context: { open_message_id: cardId }, action: { tag: "button", value: { action: "claim" } } });
    expect(ok).toMatchObject({ toast: { content: "已收到，处理中" } });
    const last = threadMessages(app, t.id).pop()!;
    expect(last.text).toMatch(/\[卡片操作\] ou_a（ou_a）在卡片 om_\d+ 上点击按钮「claim」/);
    expect(last.meta.speaker).toBe("ou_a");
  });

  it("without a target, posts into the Feishu conversation the run is answering", async () => {
    const app = testApp();
    const client = fakeClient();
    setLarkClient(client);
    const t = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_p2p" });
    const run = createRun(app, { kind: "ask", title: "x", input: { conversationId: t.id, messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const ctx = toolContextForToken(app, issueToolToken({ runId: run.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: null }))!;
    expect((await callTool(ctx, "lark_card", { title: "飞书授权", blocks: [{ markdown: "请打开链接完成授权" }] })).isError).toBe(false);
    expect(client.calls.find((c) => c.op === "create")!.args.data.receive_id).toBe("oc_p2p");
  });

  it("updates its own card without asking Feishu where it is", async () => {
    const app = testApp();
    const client = fakeClient();
    // The bot may not read messages: only what omem recorded tells where the card is.
    client.im.message.get = async () => ({ code: 230027, msg: "Lack of necessary permissions" }) as any;
    setLarkClient(client);
    const t = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_p2p" });
    const run = createRun(app, { kind: "ask", title: "x", input: { conversationId: t.id, messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const ctx = toolContextForToken(app, issueToolToken({ runId: run.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: null }))!;
    const sent = await callTool(ctx, "lark_card", { title: "测试", blocks: [{ buttons: [{ text: "选项一", value: "test_option_1" }] }] });
    const cardId = /已发送 (om_\d+)/.exec(sent.text)![1];
    const r = await callTool(ctx, "lark_update_card", { message_id: cardId, title: "测试成功", blocks: [{ markdown: "按钮正常" }] });
    expect(r).toMatchObject({ isError: false, text: "已更新卡片" });
    const other = await callTool(ctx, "lark_update_card", { message_id: "om_unknown", blocks: [{ markdown: "x" }] });
    expect(other.text).toMatch(/无法确认消息 om_unknown 所在的飞书会话（飞书：230027/);
  });

  it("turns posts into drafts the owner approves", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    const client = fakeClient();
    setLarkClient(client);
    const ctx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_g"], larkDraft: true }))!;
    expect((await callTool(ctx, "lark_send", { chat_id: "oc_g", markdown: "**已处理**" })).text).toMatch(/草稿/);
    const draft = client.calls.find((c) => c.op === "create")!;
    expect(draft.args.data.receive_id).toBe("ou_owner");
    const draftId = "om_1";
    expect(await handleCardAction(app, { operator: { open_id: "ou_x" }, context: { open_message_id: draftId }, action: { value: { action: "send" } } })).toMatchObject({ toast: { type: "error" } });
    // The clicked card comes back changed in the callback response (no buttons left).
    const sent = await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: draftId }, action: { value: { action: "send" } } });
    expect(sent).toMatchObject({ toast: { content: "已发送" }, card: { type: "raw", data: { header: { title: { content: "已发送" } } } } });
    expect(JSON.stringify(sent.card)).not.toContain("callback");
    const real = client.calls.filter((c) => c.op === "create")[1];
    expect(real.args.data.receive_id).toBe("oc_g");
    expect(JSON.parse(real.args.data.content).body.elements[0].content).toBe("**已处理**");
    expect(await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: draftId }, action: { value: { action: "send" } } })).toMatchObject({ toast: { content: "已经处理过了" } });

    // "不发": nothing is sent and the card says so.
    expect((await callTool(ctx, "lark_send", { chat_id: "oc_g", markdown: "再想想" })).text).toMatch(/草稿/);
    const creates = client.calls.filter((c) => c.op === "create").length;
    const second = `om_${creates}`;
    const dropped = await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: second }, action: { value: { action: "drop" } } });
    expect(dropped).toMatchObject({ toast: { content: "已放弃" }, card: { type: "raw", data: { header: { title: { content: "没有发送" } } } } });
    expect(JSON.stringify(dropped.card)).not.toContain("callback");
    expect(client.calls.filter((c) => c.op === "create")).toHaveLength(creates);
  });
});

describe("watched chats", () => {
  it("hands matching messages to the handler once, in a thread that may post only there", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "alert-handler", description: "处理报警", prompt: "按告警处理技能处理。" }, "user");
    expect(() => setWatchRule(app, "oc_alert", { spec: "nope", on: "all", reply: "draft" })).toThrow(/没有 Agent 档案/);
    setWatchRule(app, "oc_alert", { spec: "alert-handler", on: "keyword", pattern: "P[01]", reply: "draft" });
    const msgs = [
      { id: "om_a1", time: String(Date.now()), sender: "监控", text: "【P1】订单服务 5xx 升高" },
      { id: "om_a2", time: String(Date.now()), sender: "监控", text: "【P3】磁盘 70%" },
    ];
    expect(await routeWatchedMessages(app, "oc_alert", "报警群", msgs)).toBe(1);
    expect(await routeWatchedMessages(app, "oc_alert", "报警群", msgs)).toBe(0);
    const runs = listRuns(app, { kind: "ask" });
    expect(runs).toHaveLength(1);
    const thread = findThread(app, (runs[0].input as { conversationId: string }).conversationId)!;
    expect(thread.channel).toBe("lark-watch");
    expect(thread.settings.spec).toBe("alert-handler");
    expect(thread.settings.lark).toEqual({ chats: ["oc_alert"], draft: true });
    expect(threadMessages(app, thread.id)[0].meta.speaker).toBe("监控");
  });

  it("lets the assistant watch a group in batches, in one context, until a time", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    // Not asked by the owner in this turn (a wake-up, a watched batch…): no inviting the bot.
    const ask = createRun(app, { kind: "ask", title: "x", input: { conversationId: "c_none", messageIds: [] }, lane: "test-hold", notBefore: "2999-01-01T00:00:00Z" });
    const ctx = toolContextForToken(app, issueToolToken({ runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    expect((await callTool(ctx, "set_chat_watch", { chat_id: "oc_proj", note: "有人问接口进度就帮我回", invite_bot: true })).text).toMatch(/本人亲自要求/);
    expect((await callTool(ctx, "set_chat_watch", { chat_id: "oc_proj", note: "有人问接口进度就帮我回" })).text).toMatch(/开始盯 oc_proj：消息每 10 分钟一批交给 assistant/);
    const t = Date.now();
    await routeWatchedMessages(app, "oc_proj", "项目群", [{ id: "om_p1", time: String(t), sender: "小王", text: "接口今天能联调吗", topicId: "omt_a" }]);
    await routeWatchedMessages(app, "oc_proj", "项目群", [{ id: "om_p2", time: String(t), sender: "小李", text: "另一个话题：周会改到周四", topicId: "omt_b" }]);
    // Both topics in one batch, one conversation; later messages do not push the batch back.
    const runs = listRuns(app, { kind: "ask" }).filter((r) => r.id !== ask.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].input.messageIds).toHaveLength(2);
    const due = Date.parse(one<{ not_before: string }>(app.db, "select not_before from runs where id = ?", runs[0].id)!.not_before);
    expect(due - t).toBeGreaterThan(9 * 60_000);
    expect(findThread(app, String(runs[0].input.conversationId))!.settings.spec).toBeUndefined();
    // An @ of the owner brings the batch forward.
    await routeWatchedMessages(app, "oc_proj", "项目群", [{ id: "om_p3", time: String(t), sender: "小王", text: "@本人 帮看下", mentions: ["ou_owner"] }]);
    expect(Date.parse(one<{ not_before: string }>(app.db, "select not_before from runs where id = ?", runs[0].id)!.not_before) - Date.now()).toBeLessThan(31_000);
    // The handler slows down; then the watch runs out.
    expect((await callTool(ctx, "set_chat_watch", { chat_id: "oc_proj", batch_minutes: 30 })).text).toMatch(/已更新 oc_proj：消息每 30 分钟/);
    expect(listWatches(app)[0]).toMatchObject({ chatId: "oc_proj", batchMinutes: 30, note: "有人问接口进度就帮我回" });
    expect(expireWatches(app, new Date(Date.now() + 4 * 86400_000).toISOString())).toBe(1);
    expect(listWatches(app)).toHaveLength(0);
    expect(await routeWatchedMessages(app, "oc_proj", "项目群", [{ id: "om_p4", time: String(t), sender: "小王", text: "还在吗" }])).toBe(0);
  });
});

describe("feishu capture (lark-cli)", () => {
  it("reads every active chat incrementally, follows topics, and captures calendar and minutes", async () => {
    const app = testApp();
    app.config.lark.capture = { ...app.config.lark.capture, mode: "all", attachments: false, docs: false, quietStop: 2 };
    const t0 = Date.now() - 3600_000;
    const msgs: Record<string, any[]> = {
      oc_a: [
        { message_id: "om_1", msg_type: "text", content: JSON.stringify({ text: "明天发版" }), create_time: String(t0), sender: { name: "小王" }, thread_id: "omt_9" },
        { message_id: "om_2", msg_type: "text", content: JSON.stringify({ text: "收到" }), create_time: String(t0 + 1000), sender: { name: "我" } },
      ],
      oc_p2p: [{ message_id: "om_3", msg_type: "text", content: "周五一起吃饭", create_time: String(t0 + 2000), sender: { name: "小李" } }],
    };
    const thread = [{ message_id: "om_t1", msg_type: "text", content: JSON.stringify({ text: "回滚方案已准备" }), create_time: String(t0 + 3000), sender: { name: "小张" } }];
    const calls: string[][] = [];
    setLarkCliForTests(async (args) => {
      calls.push(args);
      const sub = args.slice(0, 2).join(" ");
      if (sub === "im +chat-list") return { data: { chats: [{ chat_id: "oc_a", name: "项目群", chat_mode: "group" }, { chat_id: "oc_p2p", name: "小李", chat_mode: "p2p" }, { chat_id: "oc_quiet", name: "安静群", chat_mode: "group" }] } };
      if (sub === "im +chat-messages-list") {
        const chat = args[args.indexOf("--chat-id") + 1];
        const start = Date.parse(args[args.indexOf("--start") + 1]);
        return { data: { messages: (msgs[chat] ?? []).filter((m) => Number(m.create_time) >= start - 1000) } };
      }
      if (sub === "im +threads-messages-list") return { data: { messages: thread } };
      if (sub === "calendar +agenda") return { data: { events: [{ event_id: "ev1", summary: "需求评审", start_time: { date_time: "2026-10-15T10:00:00+08:00" }, end_time: { date_time: "2026-10-15T11:00:00+08:00" }, attendees: [{ display_name: "小王" }] }] } };
      if (sub === "minutes +search") return { data: { items: [{ minute_token: "obc1", title: "周会" }] } };
      if (sub === "minutes +detail") return { data: { minutes: [{ minute_token: "obc1", title: "周会", artifacts: { summary: "确定 10 月底上线", todos: [{ content: "小王整理发布清单" }] } }] } };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const r = await pollLark(app);
    expect(r.messages).toBe(4);
    const chats = all<{ uri: string; text: string; kind: string }>(app.db, "select uri, text, kind from sources where uri like 'lark:%' order by uri");
    const group = chats.find((c) => c.uri === "lark:oc_a")!;
    expect(group.text).toMatch(/小王: 明天发版 \(om_1\)/);
    expect(group.text).toMatch(/话题 omt_9\] 小张: 回滚方案已准备/);
    expect(chats.find((c) => c.uri === "lark:oc_p2p")!.text).toMatch(/小李: 周五一起吃饭/);
    expect(chats.find((c) => c.uri === "lark:calendar:ev1")).toMatchObject({ kind: "event" });
    expect(chats.find((c) => c.uri === "lark:minutes:obc1")!.text).toMatch(/小王整理发布清单/);
    expect(listRuns(app, { kind: "ingest" }).length).toBeGreaterThan(0);

    // Second poll: nothing new is appended twice.
    calls.length = 0;
    const again = await pollLark(app);
    expect(again.messages).toBe(0);
    expect(all<{ text: string }>(app.db, "select text from sources where uri = 'lark:oc_a'")[0].text.match(/om_1/g)).toHaveLength(1);
  });
});

describe("feishu capture policies by kind of chat", () => {
  it("skips omem's own bot and muted chats, keeps bot chats searchable, and ingests groups only when the owner is involved", async () => {
    const app = testApp();
    app.config.lark.appId = "cli_omem";
    app.config.lark.capture = { ...app.config.lark.capture, mode: "all", attachments: false, docs: false, calendar: false, minutes: false, quietStop: 10 };
    runSql(app.db, "insert into kv(key,value) values('lark_owner_chat','oc_ownbot')");
    const t0 = Date.now() - 3600_000;
    const text = (t: string) => JSON.stringify({ text: t });
    const msgs: Record<string, any[]> = {
      oc_ownbot: [{ message_id: "om_o1", msg_type: "text", content: text("我的助理回答"), create_time: String(t0), sender: { id: "cli_omem", id_type: "app_id", sender_type: "app" } }],
      oc_notify: [{ message_id: "om_n1", msg_type: "text", content: text("你的工单已处理"), create_time: String(t0), sender: { id: "cli_x", id_type: "app_id", sender_type: "app", name: "工单助手" } }],
      oc_passive: [{ message_id: "om_p1", msg_type: "text", content: text("有人知道怎么配吗"), create_time: String(t0), sender: { id: "ou_a", name: "路人" } }],
      oc_mine: [
        { message_id: "om_m1", msg_type: "text", content: text("方案定了吗"), create_time: String(t0), sender: { id: "ou_b", name: "同事" }, mentions: [{ id: "ou_me", name: "我" }] },
        { message_id: "om_m2", msg_type: "text", content: text("这是我的机器人回复"), create_time: String(t0 + 1), sender: { id: "cli_omem", id_type: "app_id", sender_type: "app" } },
      ],
      oc_muted: [{ message_id: "om_x1", msg_type: "text", content: text("刷屏"), create_time: String(t0), sender: { id: "ou_c", name: "某人" } }],
    };
    const read: string[] = [];
    setLarkCliForTests(async (args) => {
      const sub = args.slice(0, 2).join(" ");
      if (sub === "auth status") return { data: { identities: { user: { openId: "ou_me" } } } };
      if (sub === "im +chat-list") {
        const chats = [
          { chat_id: "oc_ownbot", name: "我的助理", chat_mode: "p2p", p2p_target_type: "bot" },
          { chat_id: "oc_notify", name: "工单助手", chat_mode: "p2p", p2p_target_type: "user" },
          { chat_id: "oc_passive", name: "大群", chat_mode: "topic" },
          { chat_id: "oc_mine", name: "项目群", chat_mode: "group" },
          { chat_id: "oc_muted", name: "吵闹群", chat_mode: "group" },
        ];
        return { data: { chats: args.includes("--exclude-muted") ? chats.filter((c) => c.chat_id !== "oc_muted") : chats } };
      }
      if (sub === "im +chat-messages-list") {
        const chat = args[args.indexOf("--chat-id") + 1];
        read.push(chat);
        return { data: { messages: msgs[chat] ?? [] } };
      }
      if (sub === "im +messages-search") return { data: { messages: [] } };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    await pollLark(app);
    expect(read).not.toContain("oc_ownbot");
    expect(read).not.toContain("oc_muted");
    const src = (uri: string) => all<{ id: string; text: string }>(app.db, "select id, text from sources where uri = ?", uri)[0];
    expect(src("lark:oc_ownbot")).toBeUndefined();
    expect(src("lark:oc_notify").text).toMatch(/工单助手（机器人）: 你的工单已处理/);
    expect(src("lark:oc_passive").text).toMatch(/有人知道怎么配吗/);
    // omem's own replies in a group are its output, not material.
    expect(src("lark:oc_mine").text).not.toMatch(/这是我的机器人回复/);
    const ingested = listRuns(app, { kind: "ingest" }).flatMap((r) => (r.input as { sourceIds: string[] }).sourceIds);
    expect(ingested).toContain(src("lark:oc_mine").id);
    expect(ingested).not.toContain(src("lark:oc_passive").id);
    expect(ingested).not.toContain(src("lark:oc_notify").id);

    const seen = Object.fromEntries(capturedChats(app).map((c) => [c.chatId, c]));
    expect(seen.oc_notify).toMatchObject({ kind: "bot", policy: "store" });
    expect(seen.oc_passive).toMatchObject({ kind: "topic", policy: "involved", involved: false });
    expect(seen.oc_mine).toMatchObject({ involved: true });

    // A chat's own setting wins over its kind.
    setCapturePolicy(app, "oc_passive", "ingest");
    msgs.oc_passive.push({ message_id: "om_p2", msg_type: "text", content: text("补充一下"), create_time: String(t0 + 5000), sender: { id: "ou_a", name: "路人" } });
    await pollLark(app);
    const again = listRuns(app, { kind: "ingest" }).flatMap((r) => (r.input as { sourceIds: string[] }).sourceIds);
    expect(again).toContain(src("lark:oc_passive").id);
  });
});

describe("feishu messages as a chat", () => {
  it("keeps quotes, thread replies and images, and backfills history into monthly archives", async () => {
    const app = testApp();
    app.config.lark.capture = { ...app.config.lark.capture, mode: "all", attachments: true, docs: false, calendar: false, minutes: false, backfill: { days: 0, policies: [], pagesPerMinute: 60, concurrency: 4 } };
    const t0 = Date.now() - 3600_000;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const live = [
      { message_id: "om_q", msg_type: "text", content: "明天几点评审？\n顺便带上方案", create_time: String(t0), sender: { id: "ou_a", name: "小王" }, thread_id: "omt_1", thread_replies: [{ message_id: "om_r", msg_type: "text", content: "十点", create_time: String(t0 + 50), sender: { id: "ou_me", name: "我" } }] },
      { message_id: "om_reply", msg_type: "text", content: "收到", create_time: String(t0 + 100), sender: { id: "ou_b", name: "小李" }, reply_to: "om_old" },
      { message_id: "om_img", msg_type: "image", content: "![Image](img_k1)", create_time: String(t0 + 200), sender: { id: "ou_a", name: "小王" } },
    ];
    const history = [
      { message_id: "om_h2", msg_type: "text", content: "上个月的结论：用方案 B", create_time: String(Date.parse("2026-09-20T03:00:00Z")), sender: { id: "ou_a", name: "小王" } },
      { message_id: "om_h1", msg_type: "text", content: "先讨论方案", create_time: String(Date.parse("2026-08-30T03:00:00Z")), sender: { id: "ou_b", name: "小李" } },
    ];
    const calls: string[] = [];
    setLarkCliForTests(async (args, cwd) => {
      const sub = args.slice(0, 2).join(" ");
      calls.push(sub);
      if (sub === "auth status") return { data: { identities: { user: { openId: "ou_me" } } } };
      if (sub === "im +chat-list") return { data: { chats: [{ chat_id: "oc_g", name: "项目群", chat_mode: "group" }] } };
      if (sub === "im +chat-messages-list") {
        const start = Date.parse(args[args.indexOf("--start") + 1]);
        const end = Date.parse(args[args.indexOf("--end") + 1]);
        if (args.includes("desc")) return { data: { messages: history.filter((m) => Number(m.create_time) >= start && Number(m.create_time) < end), has_more: false } };
        const msgs = live.filter((m) => Number(m.create_time) >= start - 1000).map((m) => ({ ...m }));
        if (args.includes("--download-resources") && cwd) {
          mkdirS(`${cwd}/lark-im-resources`, { recursive: true });
          writeF(`${cwd}/lark-im-resources/img_k1`, png);
          const img = msgs.find((m) => m.message_id === "om_img") as any;
          if (img) img.resources = [{ message_id: "om_img", key: "img_k1", type: "image", local_path: "lark-im-resources/img_k1", size_bytes: png.length }];
        }
        return { data: { messages: msgs } };
      }
      if (sub === "im +messages-mget") return { data: { messages: [{ message_id: "om_old", msg_type: "text", content: "接口文档发我一下", create_time: String(t0 - 86400_000), sender: { id: "ou_me", name: "我" } }] } };
      if (sub === "im +threads-messages-list" || sub === "im +messages-search") return { data: { messages: [] } };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    await pollLark(app);
    const src = all<{ id: string; text: string }>(app.db, "select id, text from sources where uri = 'lark:oc_g'")[0];
    expect(src.text).toMatch(/小李 ↩ 回复 我「接口文档发我一下」: 收到/);
    expect(src.text).toMatch(/话题 omt_1\] 我（本人）: 十点 \(om_r\)/);
    expect(src.text).toMatch(/明天几点评审？ ⏎ 顺便带上方案/);
    const view = sourceMessages(app, src.id);
    expect(view.messages.map((m) => m.id)).toEqual(["om_q", "om_r", "om_reply", "om_img"]);
    expect(view.messages[0].content).toBe("明天几点评审？\n顺便带上方案");
    expect(view.messages[2]).toMatchObject({ parentId: "om_old", line: 3 });
    expect(view.quoted.om_old).toMatchObject({ sender: "我", content: "接口文档发我一下" });
    expect(view.messages[3].resources.img_k1.url).toMatch(/^\/api\/files\/[a-f0-9]{16}\.png$/);

    // History on request: a page at a time, into a source per month.
    requestBackfill(app, "oc_g", 0);
    for (let i = 0; i < 4 && (await backfillTick(app, "ou_me")).left; i++);
    const months = all<{ uri: string; text: string }>(app.db, "select uri, text from sources where uri like 'lark:oc_g@%' order by uri");
    expect(months.map((m) => m.uri)).toEqual(["lark:oc_g@2026-08", "lark:oc_g@2026-09"]);
    expect(months[1].text).toMatch(/用方案 B/);
    expect(capturedChats(app).find((c) => c.chatId === "oc_g")?.backfilling).toBe(false);
  });

  it("does not repeat messages the bot already wrote into the chat", async () => {
    const app = testApp();
    app.config.lark.capture = { ...app.config.lark.capture, mode: "all", attachments: false, docs: false, calendar: false, minutes: false };
    const t0 = Date.now() - 3600_000;
    // The bot is in the group and wrote the first message as it arrived.
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_g", title: "项目群", lines: ["[2026-10-20 10:00] 小王: 发布好了吗 (om_1)"] });
    const msgs = [
      { message_id: "om_1", msg_type: "text", content: "发布好了吗", create_time: String(t0), sender: { id: "ou_a", name: "小王" } },
      { message_id: "om_2", msg_type: "text", content: "好了", create_time: String(t0 + 100), sender: { id: "ou_b", name: "小李" } },
    ];
    setLarkCliForTests(async (args) => {
      const sub = args.slice(0, 2).join(" ");
      if (sub === "auth status") return { data: { identities: { user: { openId: "ou_me" } } } };
      if (sub === "im +chat-list") return { data: { chats: [{ chat_id: "oc_g", name: "项目群", chat_mode: "group" }] } };
      if (sub === "im +chat-messages-list") return { data: { messages: msgs } };
      return { data: { messages: [] } };
    });
    await pollLark(app);
    const src = all<{ id: string; text: string }>(app.db, "select id, text from sources where uri = 'lark:oc_g'")[0];
    expect(src.text.match(/\(om_1\)/g)).toHaveLength(1);
    expect(src.text.split("\n")).toHaveLength(2);
    expect(sourceMessages(app, src.id).messages.map((m) => [m.id, m.line])).toEqual([["om_1", 1], ["om_2", 2]]);
  });

  it("fills in images and files saved messages never downloaded", async () => {
    const app = testApp();
    // A row whose image was not downloaded, and an older line with only the key (no row).
    storeMessages(app, "oc_g", [{ message_id: "om_a", msg_type: "image", content: "[Image: img_a]", create_time: String(Date.now()), sender: { id: "ou_a", name: "小王" } }] as never, {});
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_g", title: "项目群", lines: ['[2026-10-01 10:00] 小李: <file key="file_b" name="方案.pdf"/> (om_b)', "[2026-10-01 10:01] 小李: 看看 (om_c)"] });
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_other", title: "别的群", lines: ["[2026-10-01 10:00] 小张: [Image: img_z] (om_z)"] });
    expect(missingResources(app, ["oc_g"]).map((x) => `${x.messageId}/${x.key}`).sort()).toEqual(["om_a/img_a", "om_b/file_b"]);
    setLarkCliForTests(async (args, cwd) => {
      const id = args[args.indexOf("--message-ids") + 1];
      if (id === "om_b") return { data: { messages: [] } }; // withdrawn: neither lark-cli nor the bot can read it
      mkdirS(`${cwd}/lark-im-resources`, { recursive: true });
      writeF(`${cwd}/lark-im-resources/img_a`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return { data: { messages: [{ message_id: id, resources: [{ key: "img_a", type: "image", local_path: "lark-im-resources/img_a" }] }] } };
    });
    const p = await fillResources(app, ["oc_g"]);
    expect(p).toMatchObject({ total: 2, fetched: 1, failed: 1 });
    expect(missingResources(app, ["oc_g"]).map((x) => x.key)).toEqual(["file_b"]);
    expect(sourceMessages(app, all<{ id: string }>(app.db, "select id from sources where uri = 'lark:oc_g'")[0].id).messages).toHaveLength(0);
  });
});

describe("code activity", () => {
  it("records new commits and the shape of uncommitted work", () => {
    const app = testApp();
    const dir = mkdtempSync(join(tmpdir(), "omem-act-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "me", GIT_COMMITTER_NAME: "me", GIT_AUTHOR_EMAIL: "m@x", GIT_COMMITTER_EMAIL: "m@x" } });
    g("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    g("add", ".");
    g("commit", "-qm", "first");
    createSpace(app, { id: "repo", name: "repo", kind: "repo", rootPath: dir });
    recordCodeActivity(app);
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    g("add", ".");
    g("commit", "-qm", "add b");
    writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    const r = recordCodeActivity(app);
    expect(r).toHaveLength(1);
    const text = all<{ text: string }>(app.db, "select text from sources where kind = 'activity'")[0].text;
    expect(text).toMatch(/提交 [0-9a-f]+（me，main）：add b｜1 file changed/);
    expect(text).toMatch(/未提交改动 1 个文件.*a\.ts/);
    expect(recordCodeActivity(app)).toHaveLength(0);
  });
});

describe("progress card", () => {
  it("keeps the fallback minimal and ends with the answer", async () => {
    const { startProgress } = await import("../src/channels/lark-progress.ts");
    const app = testApp();
    const client = fakeClient();
    setLarkClient(client);
    const p = await startProgress(app, { messageId: "om_q", inThread: false }, "r_x");
    expect(client.calls.map((c) => c.op)).toEqual(["react", "reply"]);
    app.emit({ type: "run-event", runId: "r_x", seq: 1, event: { type: "tool", data: { id: "t1", title: "mcp__omem__search", status: "in_progress" }, at: "" } } as never);
    app.emit({ type: "run-event", runId: "r_x", seq: -1, event: { type: "text-delta", data: { text: "部分答案" }, at: "" } } as never);
    expect(client.calls.filter((c) => c.op === "patch")).toHaveLength(0);
    const live = client.calls.find((c) => c.op === "reply")!;
    expect(live.args.data.content).toContain("思考气泡暂不可用");
    expect(live.args.data.content).not.toMatch(/部分答案|检索/);
    await p.finish("最终答案");
    const final = JSON.parse(client.calls.filter((c) => c.op === "patch").pop()!.args.data.content);
    expect(final.body.elements[0].content).toBe("最终答案");
    expect(client.calls.filter((c) => c.op === "react").map((c) => c.args.data.reaction_type.emoji_type)).toEqual(["OnIt", "DONE"]);
  });
});
