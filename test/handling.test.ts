import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/core/app.ts";
import { run } from "../src/core/db.ts";
import { handlingOf, noteYield, replyHolder, REPLY_ORDER, yieldTo } from "../src/core/handling.ts";
import { appendToSource } from "../src/sources/store.ts";
import { upsertItem } from "../src/items/store.ts";
import { recordChange } from "../src/items/changes.ts";
import { answeredDirectly, routeWatchedMessages, watchChat } from "../src/channels/lark-watch.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { callTool } from "../src/agents/tools.ts";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { resolveTurn } from "../src/agents/turn-context.ts";
import { awarenessNote } from "../src/agents/awareness.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});
const fresh = () => { const app = testApp(); apps.push(app); return app; };
const tool = (app: App) => ({ app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const, userId: "owner" });

describe("处理归属：谁接手了，后来的让开", () => {
  it("回复的顺序只写在一处：当场回答、规则、关注、有人找你", () => {
    expect(REPLY_ORDER).toEqual(["direct", "rule", "watch", "mention"]);
    const app = fresh();
    run(app.db, "insert into handled_messages(channel,message_id,rule,at) values('lark','om_1','ctx_a',?)", new Date().toISOString());
    expect(yieldTo(app, "mention", "om_1")).toMatchObject({ actor: "watch" });
    expect(yieldTo(app, "watch", "om_1")).toBeNull();
    expect(yieldTo(app, "rule", "om_1")).toBeNull();
    // A rule took it too: the rule answers, the 关注 steps aside.
    run(app.db, "insert into rule_handled(rule_id,key,at) values('rule_a','lark:om_1',?)", new Date().toISOString());
    expect(replyHolder(app, "om_1")).toMatchObject({ actor: "rule" });
    expect(yieldTo(app, "watch", "om_1")).toMatchObject({ actor: "rule" });
    // Only reading it is not taking it.
    run(app.db, "insert into handled_messages(channel,message_id,rule,at) values('lark','om_2','read:ctx_a',?)", new Date().toISOString());
    expect(replyHolder(app, "om_2")).toBeNull();
  });

  it("有人 @ 了机器人：关注让开，处理记录上写着为什么", async () => {
    const app = fresh();
    saveAgentSpec(app, { name: "helper", description: "帮忙", prompt: "回答问题。" }, "user");
    await watchChat(app, "oc_team", { spec: "helper", on: "all", reply: "draft" });
    expect(answeredDirectly(app, "oc_team", "om_asked")).toBe(true);
    expect(await routeWatchedMessages(app, "oc_team", "项目群", [{ id: "om_asked", time: String(Date.now()), sender: "小王", text: "@机器人 接口好了吗" }])).toBe(0);
    const list = handlingOf(app, "om_asked");
    expect(list.map((h) => [h.actor, h.decision])).toEqual([["direct", "taken"], ["watch", "yielded"]]);
    expect(list[1].reason).toContain("当场回答");
    // Stepping aside is recorded once.
    noteYield(app, { event: "om_asked", actor: "watch", to: "别的", reason: "第二次" });
    expect(handlingOf(app, "om_asked").filter((h) => h.decision === "yielded")).toHaveLength(1);
  });

  it("助手读群聊时看得到哪条消息已经被谁记成了什么；这一轮的处理记录也带进去", async () => {
    const app = fresh();
    const item = upsertItem(app, undefined, { title: "退款改造" }, "user");
    const chat = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_team", title: "项目群", lines: ["小王：运费也要退"], meta: { chatId: "oc_team" } });
    run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_kind,sender_name,content,create_ms) values('om_r',?,?,1,'user','小王','运费也要退',?)", "oc_team", chat.id, Date.now());
    const c = recordChange(app, { itemId: item.id, type: "scope", summary: "运费也要退", refs: [`src:${chat.id}#L1`], origin: "follow", runId: "r_follow" })!;
    const read = await callTool(tool(app), "read_source", { source: chat.id });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain(`L1 跟进（item-follow）记成了变化（变化 ${c.id}）`);

    const thread = createThread(app, { channel: "web", spaceId: "personal" });
    const id = addMessage(app, thread.id, "user", "运费的事定了吗", null, { externalId: "om_r" });
    const r = createRun(app, { kind: "ask", title: "问", input: { conversationId: thread.id }, notBefore: new Date(Date.now() + 60_000).toISOString() });
    const turn = resolveTurn(app, r.id, thread, threadMessages(app, thread.id).filter((m) => m.id === id), "owner");
    expect(turn.context.handled).toContain("记成了变化");
    expect(awarenessNote(app, r.id, true, turn)).toContain("这条消息别处已经处理过");
  });

  it("线的页面上每条变化带着谁记的、谁补的，和这条消息上谁让开了", async () => {
    const app = fresh();
    const line = upsertItem(app, undefined, { title: "退款改造", kind: "line" }, "user");
    const chat = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_team", title: "项目群", lines: ["小王：下周五上线"], meta: { chatId: "oc_team" } });
    run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_kind,sender_name,content,create_ms) values('om_d',?,?,1,'user','小王','下周五上线',?)", "oc_team", chat.id, Date.now());
    const ref = `src:${chat.id}#L1`;
    recordChange(app, { itemId: line.id, type: "deadline", summary: "提到改期", refs: [ref], origin: "owner", runId: "r_a" });
    recordChange(app, { itemId: line.id, type: "deadline", summary: "上线改到下周五", due: "2026-12-04", refs: [ref], origin: "follow", runId: "r_b" });
    noteYield(app, { event: "om_d", actor: "mention", to: "关注「项目群」", reason: "关注「项目群」已经接手这条消息的回复" });
    const { workDetail } = await import("../src/items/work-http.ts");
    const d = await workDetail(app, line.id, "owner");
    expect(d.timeline).toHaveLength(1);
    expect(d.timeline[0]).toMatchObject({ origin: "owner", sourceKey: "lark:om_d", added: [expect.objectContaining({ origin: "follow", fields: expect.arrayContaining(["due"]) })], yields: [expect.objectContaining({ label: "有人找你", reason: expect.stringContaining("接手") })] });
    expect(d.yielded.count).toBe(1);
  });
});
