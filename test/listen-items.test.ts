import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { one, run } from "../src/core/db.ts";
import { appendToSource } from "../src/sources/store.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { addMaterials, removeMaterials } from "../src/items/materials.ts";
import { createRun, getRun, listRuns } from "../src/agents/runs.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { createThread, findThread, threadMessages } from "../src/agents/threads.ts";
import { watchedNote } from "../src/agents/sessions.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { startFlow, stopFlow } from "../src/flows/engine.ts";
import { finishFollow, followAnchor, followContexts, noteItemChange } from "../src/flows/follow.ts";
import { routeWatchedMessages } from "../src/channels/lark-watch.ts";
import { chatListened, getContext, itemContext, saveContext } from "../src/channels/listen.ts";
import { migrateItemContexts, setItemListening } from "../src/channels/listen-items.ts";
import { runActions } from "../src/rules/actions.ts";
import { confirmRule } from "../src/rules/confirmation.ts";
import { getRule, saveRule } from "../src/rules/store.ts";
import { ruleToContext } from "../src/rules/to-listen.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});

const owner = { actor: "owner", userId: "owner" };
const BRIEF = { handle: ["问这件事进展的"], skip: ["闲聊"], valid: "说得出依据" };

/** An item linked to a captured group chat, with a way to add lines to that chat. */
function setup() {
  const app = testApp(); apps.push(app); app.config.flows.autoAdvance = 20;
  const item = upsertItem(app, undefined, { title: "示例商城退款", detail: "退商品款", dueAt: "2026-12-01" }, "user");
  const src = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_shop", title: "示例商城讨论", lines: ["原来的需求"], meta: { chatId: "oc_shop" } });
  run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,content,create_ms) values('history','oc_shop',?,1,'原来的需求',?)", src.id, Date.now() - 3600000);
  addMaterials(app, item.id, [{ kind: "source", ref: src.id }], "owner");
  let line = 1;
  const message = (content = "小王说截止时间要改到 12 月 8 日") => {
    line++;
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_shop", title: "示例商城讨论", lines: [content] });
    run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_kind,sender_name,content,create_ms) values(?,?,?,?,?,?,?,?)", `msg_${line}`, "oc_shop", src.id, line, "user", "小王", content, Date.now() + 1);
    return `src:${src.id}#L${line}`;
  };
  return { app, item, src, message };
}
const flow = (app: App) => saveFlow(app, YAML.stringify({ id: "demo", name: "示例交付", stages: [{ id: "code", name: "编码", by: "wait" }, { id: "end", name: "结束", by: "wait" }] }), "owner");
const ownerTools = (app: App) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
const msgEvent = (id: string, chatId: string, text: string): RuleEvent => ({
  key: `lark:${id}`, kind: "message", at: new Date().toISOString(), via: "capture",
  chat: { id: chatId, name: "值班群", kind: "group" }, sender: { name: "小王", kind: "user" },
  message: { id, text, type: "text", mentionsOwner: false, mentionsBot: false },
});

describe("事情型关注", () => {
  it("a flow makes the item's 关注 (only reading, its groups), ends it with the flow; startup does the same for running flows", async () => {
    const { app, item } = setup();
    flow(app);
    await startFlow(app, item.id, "demo", owner);
    const c = itemContext(app, item.id)!;
    expect(c).toMatchObject({ kind: "item", name: "示例商城退款", chats: ["oc_shop"], spaceId: "personal", byFlow: true, status: "active", expiresAt: null, knobs: { reply: "none" } });
    expect(chatListened(app, "oc_shop")).toBe(true);
    // A matter's space does not decide where its group is kept.
    expect(one<{ settings: string }>(app.db, "select settings from chat_settings where channel='lark-watch' and chat_id='oc_shop'")!.settings).not.toContain("spaceId");
    expect(findThread(app, c.conversationId!)).toMatchObject({ channel: "listen", key: c.id });
    await stopFlow(app, item.id);
    expect(getContext(app, c.id)!.status).toBe("paused");
    expect(followAnchor(app, item.id)).toBeNull();
    // Started again: the same 关注 is back.
    await startFlow(app, item.id, "demo", owner);
    expect(itemContext(app, item.id)).toMatchObject({ id: c.id, status: "active" });

    // Startup: flows running without a 关注 get one, once.
    const other = upsertItem(app, undefined, { title: "另一件事" }, "user");
    await startFlow(app, other.id, "demo", owner);
    run(app.db, "delete from listen_contexts where item_id=?", other.id);
    expect(migrateItemContexts(app)).toBe(1);
    expect(migrateItemContexts(app)).toBe(0);
    expect(itemContext(app, other.id)).toMatchObject({ byFlow: true, knobs: { reply: "none" } });
  });

  it("follows an item the owner keeps a 关注 on with no flow: changes without stages, a proposed deadline asked", async () => {
    const { app, item, message } = setup();
    app.config.flows.follow.maxMessages = 1;
    const c = setItemListening(app, item.id, true)!;
    expect(c).toMatchObject({ kind: "item", status: "active", chats: ["oc_shop"] });
    expect(c.byFlow).toBeUndefined();
    expect(followAnchor(app, item.id)).toEqual({ startedAt: c.since, flow: null });
    await followContexts(app);
    const ref = message();
    await followContexts(app);
    const queued = listRuns(app, { kind: "item-follow" });
    expect(queued).toHaveLength(1);
    expect(String(queued[0].input.task)).toContain("这件事没有在走的流程");
    expect(String(queued[0].input.task)).not.toContain("## 观察期");
    run(app.db, "update runs set status='running' where id=?", queued[0].id);
    expect(() => noteItemChange(app, queued[0].id, { item: item.id, type: "scope", summary: "范围变了", stages: ["code"], refs: [ref] })).toThrow("没有在走的流程");
    noteItemChange(app, queued[0].id, { item: item.id, type: "deadline", summary: "小王提出改到 12 月 8 日", due: "2026-12-08", refs: [ref] });
    finishFollow(app, getRun(app, queued[0].id));
    const ask = listAsks(app, { runId: queued[0].id })[0];
    expect(ask.question).toContain("改截止时间");
    await answerAsk(app, ask.id, { choice: 0, by: "owner" });
    expect(getItem(app, item.id).dueAt).toBe("2026-12-08");

    // Off: nothing follows any more; closed items are not followed either.
    setItemListening(app, item.id, false);
    expect(itemContext(app, item.id)!.status).toBe("paused");
    expect(followAnchor(app, item.id)).toBeNull();
    setItemListening(app, item.id, true, { reply: "none" });
    expect(followAnchor(app, item.id)).not.toBeNull();
    upsertItem(app, item.id, { status: "done" }, "user");
    expect(followAnchor(app, item.id)).toBeNull();
    await followContexts(app);
    expect(itemContext(app, item.id)!.status).toBe("paused");
  });

  it("tells item-follow what still matters once the line launched and is being watched", async () => {
    const { app, item, message } = setup();
    app.config.flows.follow.maxMessages = 1;
    setItemListening(app, item.id, true);
    run(app.db, "update items set phase = 'watching', phase_since = ?, watch_until = null where id = ?", new Date().toISOString(), item.id);
    await followContexts(app);
    message("上线后有用户说退款按钮点了没反应");
    await followContexts(app);
    const [queued] = listRuns(app, { kind: "item-follow" });
    expect(String(queued.input.task)).toContain("## 观察期\n这件事已经上线，在观察期：只关心报错、用户反馈和数据异常，普通讨论不用处理。");
  });

  it("keeps the 关注's groups the item's linked chats on each pass, and the chat index with them", async () => {
    const { app, item, src } = setup();
    const c = setItemListening(app, item.id, true)!;
    const other = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_dev", title: "开发群", lines: ["x"], meta: { chatId: "oc_dev" } });
    const conv = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_test#omt_1" });
    // A private chat is no group of the matter.
    run(app.db, "insert into lark_cursors(chat_id,name,kind) values('oc_p2p','小王','p2p')");
    const p2p = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_p2p" });
    addMaterials(app, item.id, [{ kind: "source", ref: other.id }, { kind: "conversation", ref: conv.id }, { kind: "conversation", ref: p2p.id }], "owner");
    await followContexts(app);
    expect(getContext(app, c.id)!.chats.sort()).toEqual(["oc_dev", "oc_shop", "oc_test"]);
    expect(chatListened(app, "oc_dev")).toBe(true);
    expect(chatListened(app, "oc_p2p")).toBe(false);
    removeMaterials(app, item.id, [`source:${src.id}`], "owner");
    await followContexts(app);
    expect(getContext(app, c.id)!.chats.sort()).toEqual(["oc_dev", "oc_test"]);
    expect(chatListened(app, "oc_shop")).toBe(false);
  });

  it("set_chat_watch(item) sets the matter's 关注: groups from the item, replies need a brief, remove pauses it", async () => {
    const { app, item } = setup();
    const tools = ownerTools(app);
    const made = await callTool(tools, "set_chat_watch", { item: item.id });
    expect(made.isError).toBe(false);
    expect(made.text).toContain("只读");
    const c = itemContext(app, item.id)!;
    expect(c).toMatchObject({ chats: ["oc_shop"], expiresAt: null, knobs: { reply: "none" } });
    // A group capture never saw is refused (adding a known one: the test below).
    expect((await callTool(tools, "set_chat_watch", { item: item.id, chat_id: "oc_x" })).isError).toBe(true);
    expect((await callTool(tools, "set_chat_watch", { item: item.id, reply: "draft" })).text).toContain("brief");
    const on = await callTool(tools, "set_chat_watch", { item: item.id, reply: "draft", brief: BRIEF });
    expect(on.isError).toBe(false);
    expect(getContext(app, c.id)).toMatchObject({ knobs: { reply: "draft" }, brief: { handle: BRIEF.handle } });
    // A flow made one earlier: the owner's word makes it their own.
    run(app.db, "update listen_contexts set settings=json_set(settings,'$.byFlow',json('true')) where id=?", c.id);
    await callTool(tools, "set_chat_watch", { context: c.id, depth: "answer" });
    expect(getContext(app, c.id)!.byFlow).toBeUndefined();
    await callTool(tools, "set_chat_watch", { item: item.id, remove: true });
    expect(getContext(app, c.id)!.status).toBe("paused");
  });

  it("an item 关注 that only reads takes no group messages; with replies on, its handler is told where the matter stands", async () => {
    const { app, item } = setup();
    setItemListening(app, item.id, true);
    expect(await routeWatchedMessages(app, "oc_shop", "示例商城讨论", [{ id: "om_1", time: String(Date.now()), sender: "小王", text: "退款什么时候上线" }])).toBe(0);
    run(app.db, "insert into item_changes(id,item_id,at,type,summary,refs,run_id,updated_at,status) values('ic_1',?,?,'scope','小王提出运费也要退','[]','r_x',?,'noted')", item.id, new Date().toISOString(), new Date().toISOString());
    const c = saveContext(app, { id: itemContext(app, item.id)!.id, kind: "item", knobs: { reply: "draft" }, brief: { ...BRIEF, at: new Date().toISOString() } });
    expect(await routeWatchedMessages(app, "oc_shop", "示例商城讨论", [{ id: "om_2", time: String(Date.now()), sender: "小王", text: "退款什么时候上线" }])).toBe(1);
    const t = findThread(app, c.conversationId!)!;
    const note = await watchedNote(app, t, threadMessages(app, t.id));
    expect(note).toContain("这件事现在的样子");
    expect(note).toContain(`事项 ${item.id}「示例商城退款」`);
    expect(note).toContain("截止 2026-12-01");
    expect(note).toContain("小王提出运费也要退");
    expect(note).not.toContain("观察期");
    // The line launched and is being watched: the handler is told what still matters, no knob changes.
    run(app.db, "update items set phase = 'watching', phase_since = ?, watch_until = ? where id = ?", new Date().toISOString(), "2026-12-05T04:00:00Z", item.id);
    const watched = await watchedNote(app, t, threadMessages(app, t.id));
    expect(watched).toContain("这件事已经上线，在观察期，观察到 12 月 5 日：只关心报错、用户反馈和数据异常，普通讨论不用处理。");
    expect(getContext(app, c.id)!.knobs).toEqual(c.knobs);
  });

  it("the owner picks the matter's groups on the line page or by asking: kept through every sync with its items", async () => {
    const { app, item, src } = setup();
    const c = setItemListening(app, item.id, true)!;
    run(app.db, "insert into lark_cursors(chat_id,name,kind) values('oc_ops','值班群','group'), ('oc_dm','小王','p2p')");
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const put = (chats: string[]) => server.inject({ method: "PUT", url: `/api/listen/${c.id}`, payload: { chats } });
      // Add a group the items do not link, let go of the one they do.
      expect((await put(["oc_ops"])).statusCode).toBe(200);
      expect(getContext(app, c.id)).toMatchObject({ chats: ["oc_ops"], added: ["oc_ops"], dropped: ["oc_shop"] });
      await followContexts(app);
      expect(getContext(app, c.id)!.chats).toEqual(["oc_ops"]);
      expect(chatListened(app, "oc_ops")).toBe(true);
      expect(chatListened(app, "oc_shop")).toBe(false);
      // The line's page lists what its 关注 reads.
      const d = (await server.inject(`/api/work/${item.id}`)).json();
      expect(d.chats.map((x: { chatId: string }) => x.chatId)).toEqual(["oc_ops"]);
      expect(d.listen).toEqual({ id: c.id, status: "active" });
      // A new chat linked to the item still comes in; a private chat or an unknown one is refused.
      const dev = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_dev", title: "开发群", lines: ["x"], meta: { chatId: "oc_dev" } });
      addMaterials(app, item.id, [{ kind: "source", ref: dev.id }], "owner");
      await followContexts(app);
      expect(getContext(app, c.id)!.chats.sort()).toEqual(["oc_dev", "oc_ops"]);
      expect((await put(["oc_ops", "oc_dm"])).statusCode).toBe(400);
      expect((await put(["oc_ops", "oc_nobody"])).statusCode).toBe(400);
      // Taking the group back clears what was dropped.
      expect((await put(["oc_ops", "oc_dev", "oc_shop"])).json()).not.toHaveProperty("dropped");
      await followContexts(app);
      expect(getContext(app, c.id)!.chats.sort()).toEqual(["oc_dev", "oc_ops", "oc_shop"]);
      expect(getContext(app, c.id)!.dropped).toBeUndefined();
      void src;
    } finally {
      await server.close();
    }
    // Asking the assistant does the same: by the 关注's name, one more group (chat_id) or the whole list (chats).
    const tools = ownerTools(app);
    run(app.db, "insert into lark_cursors(chat_id,name,kind) values('oc_qa','测试群','group')");
    expect((await callTool(tools, "set_chat_watch", { context: "示例商城退款", chat_id: "oc_qa" })).isError).toBe(false);
    expect(getContext(app, c.id)!.chats.sort()).toEqual(["oc_dev", "oc_ops", "oc_qa", "oc_shop"]);
    expect((await callTool(tools, "set_chat_watch", { context: "「示例商城退款」的关注", chats: ["oc_qa"], listen: "addressed" })).isError).toBe(false);
    expect(getContext(app, c.id)).toMatchObject({ chats: ["oc_qa"], knobs: { listen: "addressed" } });
    await followContexts(app);
    expect(getContext(app, c.id)!.chats).toEqual(["oc_qa"]);
    const none = await callTool(tools, "set_chat_watch", { context: "没有这个", depth: "answer" });
    expect(none.isError).toBe(true);
    expect(none.text).toContain("示例商城退款");
  });
});

describe("规则交给关注", () => {
  it("hands the event to the 关注's conversation once, whichever comes first, and says so on the confirmation card", async () => {
    const app = testApp(); apps.push(app);
    const c = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], knobs: { reply: "none" } });
    const base = { name: "报错交给值班", description: "值班群里有人报错就交给值班关注", enabled: true, judge: "code" as const, conditions: { all: [{ field: "chat.id" as const, op: "equals" as const, value: "oc_ops" }, { field: "message.text" as const, op: "contains" as const, value: "报错" }] } };
    expect(() => saveRule(app, { ...base, actions: [{ type: "context", context: "ctx_missing" }] })).toThrow("没有这个关注");
    const rule = saveRule(app, { ...base, actions: [{ type: "context", context: c.id }] });

    // The rule first: the message is in the conversation, marked as the rule's, and routing does not add it again.
    const [r1] = await runActions(app, rule, msgEvent("om_a", "oc_ops", "页面报错了"), "");
    expect(r1).toMatchObject({ action: "context", ok: true, detail: "交给关注「值班群」" });
    await routeWatchedMessages(app, "oc_ops", "值班群", [{ id: "om_a", time: String(Date.now()), sender: "小王", text: "页面报错了" }]);
    const msgs = threadMessages(app, c.conversationId!);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toContain("规则「报错交给值班」交给这个关注");
    expect(msgs[0].meta).toMatchObject({ rule: rule.id, addressed: true, speaker: "小王", chatId: "oc_ops" });

    // Routing first: the waiting message is only marked.
    await routeWatchedMessages(app, "oc_ops", "值班群", [{ id: "om_b", time: String(Date.now()), sender: "小李", text: "又报错了" }]);
    const [r2] = await runActions(app, rule, msgEvent("om_b", "oc_ops", "又报错了"), "");
    expect(r2.detail).toContain("标为规则要处理的");
    const after = threadMessages(app, c.conversationId!);
    expect(after).toHaveLength(2);
    expect(after[1].meta).toMatchObject({ rule: rule.id, addressed: true });

    // A paused 关注 takes nothing.
    saveContext(app, { id: c.id, kind: "place", status: "paused" });
    const [r3] = await runActions(app, rule, msgEvent("om_c", "oc_ops", "还在报错"), "");
    expect(r3.ok).toBe(false);

    // Documents and omem's own events may go to a 关注 too.
    expect(() => saveRule(app, { name: "文档", description: "文档改了交给值班关注", judge: "code", conditions: null, trigger: { event: "doc", once: "event", docs: ["https://tenant.larkoffice.com/docx/abc"] }, actions: [{ type: "context", context: c.id }] })).not.toThrow();

    const off = saveRule(app, { ...base, enabled: false, actions: [{ type: "context", context: c.id }] });
    const t = createThread(app, { spaceId: "personal", channel: "web" });
    const runRow = createRun(app, { kind: "ask", spaceId: "personal", title: "x", input: {} });
    expect(confirmRule(app, off, runRow.id, t.id)!.question).toContain("交给关注「值班群」");
  });

  it("turns a rule on certain groups into a place 关注: off when the 关注 does it all, else handing its picks over", async () => {
    const app = testApp(); apps.push(app);
    const plain = saveRule(app, { name: "报警群", description: "报警群的消息交给主助手看看，有问题告诉我", enabled: true, judge: "code", conditions: { field: "chat.id", op: "equals", value: "oc_alert" }, actions: [{ type: "agent", spec: "assistant", task: "看看要不要处理", ownTopic: false, reply: "none" }] });
    const a = await ruleToContext(app, plain.id);
    expect(a.outcome).toBe("disabled");
    expect(a.reused).toBe(false);
    expect(a.context).toMatchObject({ kind: "place", name: "报警群", chats: ["oc_alert"], spec: "assistant", note: "报警群的消息交给主助手看看，有问题告诉我\n要做的：看看要不要处理", status: "active", expiresAt: null, knobs: { reply: "none", backlog: "off" } });
    expect(getRule(app, plain.id)).toMatchObject({ enabled: false, actions: [{ type: "context", context: a.context.id }] });

    const picky = saveRule(app, { name: "报警卡片", description: "两个报警群的报警卡片静默排查", enabled: true, judge: "code", conditions: { all: [{ any: [{ field: "chat.id", op: "equals", value: "oc_a" }, { field: "chat.id", op: "equals", value: "oc_b" }] }, { field: "message.type", op: "equals", value: "interactive" }] }, actions: [{ type: "agent", spec: "assistant", task: "", ownTopic: false, reply: "silent" }, { type: "notify", urgent: false }] });
    const b = await ruleToContext(app, picky.id);
    expect(b.outcome).toBe("switched");
    expect(b.context).toMatchObject({ chats: ["oc_a", "oc_b"], knobs: { reply: "auto" } });
    expect(getRule(app, picky.id)).toMatchObject({ enabled: true, actions: [{ type: "context", context: b.context.id }, { type: "notify" }] });
    // The same groups and handler again: the existing 关注 is used.
    const again = saveRule(app, { ...picky, id: undefined, temporary: undefined, name: "再一条", actions: [{ type: "agent", spec: "assistant", task: "", ownTopic: false, reply: "none" }] });
    expect((await ruleToContext(app, again.id)).reused).toBe(true);

    const byName = saveRule(app, { name: "按群名", description: "名字带报警的群", enabled: true, judge: "code", conditions: { field: "chat.name", op: "contains", value: "报警" }, actions: [{ type: "agent", spec: "assistant", task: "", ownTopic: false, reply: "none" }] });
    await expect(ruleToContext(app, byName.id)).rejects.toThrow("哪些群");
  });
});
