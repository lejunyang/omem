import { afterEach, describe, expect, it } from "vitest";
import { listRuns } from "../src/agents/runs.ts";
import { watchedNote } from "../src/agents/sessions.ts";
import { findThread, setChatSettings, threadMessages, createThread, addMessage } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { all, one, run } from "../src/core/db.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { routeWatchedMessages, seedContext } from "../src/channels/lark-watch.ts";
import { chatListened, contextsOfChat, getContext, migrateWatches, saveContext } from "../src/channels/listen.ts";
import { casesText, nearCases, playbookOf } from "../src/channels/listen-cases.ts";
import { remember } from "../src/memory/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setLarkClient(null));

/** Records what the bot would post. */
function fakeClient() {
  let n = 0;
  const ok = (data: any) => ({ code: 0, data });
  return {
    im: {
      message: {
        create: async () => ok({ message_id: `om_${++n}` }),
        reply: async () => ok({ message_id: `om_${++n}` }),
        get: async () => ok({ items: [{ chat_id: "oc_ops" }] }),
      },
    },
  };
}

const now = () => String(Date.now());

describe("「关注」", () => {
  it("reads several groups in one conversation, each message saying which group it is from", async () => {
    const app = testApp();
    const c = saveContext(app, { kind: "place", name: "异常通知需求", chats: ["oc_req", "oc_dev"], knobs: { reply: "none" } });
    expect(chatListened(app, "oc_req") && chatListened(app, "oc_dev")).toBe(true);
    await routeWatchedMessages(app, "oc_req", "需求群", [{ id: "om_r1", time: now(), sender: "产品", text: "消息要支持撤回吗" }]);
    await routeWatchedMessages(app, "oc_dev", "开发群", [{ id: "om_d1", time: now(), sender: "后端", text: "撤回接口还没排期" }]);
    const msgs = threadMessages(app, c.conversationId!);
    expect(msgs.map((m) => m.text)).toEqual([expect.stringContaining("群「需求群」"), expect.stringContaining("群「开发群」")]);
    // One batch for the two groups.
    expect(listRuns(app, { kind: "ask" })).toHaveLength(1);
    const note = await watchedNote(app, findThread(app, c.conversationId!)!, msgs);
    expect(note).toContain("关注「异常通知需求」");
    expect(note).toContain("这 2 个群");
    expect(note).toContain("不在群里发言");
  });

  it("gives a group's message to every 关注 it is in, and only the most specific one replies", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    setLarkClient(fakeClient());
    const place = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], brief: { handle: ["报错"], skip: [], valid: "有依据", at: new Date().toISOString() } });
    const item = saveContext(app, { kind: "item", name: "事项 A", itemId: "i_a", chats: ["oc_ops"], knobs: { reply: "draft" } });
    expect(contextsOfChat(app, "oc_ops").map((c) => c.id)).toEqual([item.id, place.id]);
    await routeWatchedMessages(app, "oc_ops", "值班群", [{ id: "om_x", time: now(), sender: "小王", text: "事项 A 的页面报错了" }]);
    const inPlace = threadMessages(app, place.conversationId!)[0];
    const inItem = threadMessages(app, item.conversationId!)[0];
    expect(inItem.meta.lead).toBeUndefined();
    expect(inPlace.meta).toMatchObject({ lead: item.id, leadName: "事项 A" });
    // The place's handler is told the item leads, and cannot post a reply to that message.
    expect(await watchedNote(app, findThread(app, place.conversationId!)!, [inPlace])).toContain("由它们负责回复");
    const placeRun = listRuns(app, { kind: "ask" }).find((r) => r.input.conversationId === place.conversationId)!;
    const handler = toolContextForToken(app, issueToolToken({ runId: placeRun.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_ops"], larkDraft: true }))!;
    const r = await callTool(handler, "lark_send", { reply_to: "om_x", in_thread: true, markdown: "我来答" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("事项 A");
    // An item that only reads leaves the reply to the place.
    saveContext(app, { id: item.id, kind: "item", knobs: { reply: "none" } });
    await routeWatchedMessages(app, "oc_ops", "值班群", [{ id: "om_y", time: now(), sender: "小王", text: "又报错了" }]);
    expect(threadMessages(app, place.conversationId!).find((m) => m.text.includes("又报错了"))!.meta.lead).toBeUndefined();
  });

  it("turns knobs into the handler's instructions instead of fixed rules", async () => {
    const app = testApp();
    const c = saveContext(app, { kind: "place", name: "答疑群", chats: ["oc_help"], brief: { handle: ["接口问题"], skip: [], valid: "有依据", at: new Date().toISOString() } });
    await routeWatchedMessages(app, "oc_help", "答疑群", [{ id: "om_h1", time: now(), sender: "小王", text: "@本人 这个要不要改", mentions: ["ou_owner"] }]);
    const t = findThread(app, c.conversationId!)!;
    const msgs = threadMessages(app, t.id);
    const before = await watchedNote(app, t, msgs);
    expect(before).toContain("不在群里回答、不替本人表态");
    expect(before).toContain("不接手");
    expect(before).toContain("值得查的主动查");
    saveContext(app, { id: c.id, kind: "place", knobs: { ownerAsks: "answer", othersAsks: "handle", depth: "answer" } });
    const after = await watchedNote(app, t, msgs);
    expect(after).not.toContain("不替本人表态");
    expect(after).toContain("本人允许你直接回答");
    expect(after).toContain("你能帮上的也可以处理");
    expect(after).toContain("只回答能直接答的");
  });

  it("starts from what the groups said before: the backlog window as messages, the rest as background", async () => {
    const app = testApp();
    const insert = (id: string, ago: number, text: string) =>
      run(app.db, "insert into lark_messages(message_id,chat_id,sender_name,sender_kind,content,create_ms) values(?,?,?,?,?,?)", id, "oc_bg", "小王", "user", text, Date.now() - ago);
    insert("om_b1", 30 * 3600_000, "昨天定了先做 A");
    insert("om_b2", 2 * 3600_000, "B 页面打不开谁能看下");
    const c = saveContext(app, { kind: "place", name: "背景群", chats: ["oc_bg"], knobs: { reply: "none", backlog: "24h" } });
    expect(await seedContext(app, c)).toBe(1);
    const msgs = threadMessages(app, c.conversationId!);
    expect(msgs.find((m) => m.text.includes("B 页面打不开"))!.text).toContain("关注开始前发的");
    expect(msgs.find((m) => m.text.includes("昨天定了先做 A"))!.meta.backlog).toBe(true);
    // A summary is on its way for the background.
    expect(listRuns(app, { kind: "thread-summary" })).toHaveLength(1);
    // Backlog off: everything is background, nothing to handle.
    const d = saveContext(app, { kind: "place", name: "只看背景", chats: ["oc_bg2"], knobs: { reply: "none", backlog: "off" } });
    run(app.db, "insert into lark_messages(message_id,chat_id,sender_name,sender_kind,content,create_ms) values('om_c1','oc_bg2','小李','user','有人在吗',?)", Date.now() - 3600_000);
    expect(await seedContext(app, d)).toBe(0);
    expect(threadMessages(app, d.conversationId!)[0].text).toContain("有人在吗");
  });

  it("moves an old watch, its conversation and its decisions into a place 关注", () => {
    const app = testApp();
    const t = createThread(app, { spaceId: "personal", channel: "lark-watch", key: "oc_old", title: "老值班群" });
    addMessage(app, t.id, "user", "之前的消息", null, { speaker: "小王" });
    setChatSettings(app, "lark-watch", "oc_old", {
      watch: { spec: "assistant", on: "mention", reply: "draft", note: "帮我看着", batchMinutes: 5, brief: { handle: ["报错"], skip: [], valid: "有依据", at: "2026-11-19T00:00:00.000Z" }, log: [{ at: "2026-11-19T01:00:00.000Z", decision: "dropped", reason: "owner-decides", ask: "小李：要不要提级", draft: "先不提" }] } as never,
      lark: { chats: ["oc_old"], draft: true },
    });
    expect(migrateWatches(app)).toBe(1);
    expect(migrateWatches(app)).toBe(0);
    const c = contextsOfChat(app, "oc_old")[0];
    expect(c).toMatchObject({ kind: "place", name: "老值班群", note: "帮我看着", conversationId: t.id, knobs: { listen: "addressed", reply: "draft", batchMinutes: 5, backlog: "off" } });
    expect(findThread(app, t.id)).toMatchObject({ channel: "listen", key: c.id });
    expect(one(app.db, "select decision, reason, source from reply_samples where context_id = ?", c.id)).toMatchObject({ decision: "dropped", reason: "owner-decides", source: "watch" });
    expect(one<{ settings: string }>(app.db, "select settings from chat_settings where channel = 'lark-watch' and chat_id = 'oc_old'")!.settings).not.toContain('"watch"');
  });

  it("finds the cases closest to a new message: same person, same group, alike in words", () => {
    const app = testApp();
    const c = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], knobs: { reply: "none" } });
    const add = (id: string, asker: string, chat: string, ask: string, extra: Record<string, string>) =>
      run(app.db, `insert into reply_samples(id,channel,chat_id,chat_kind,chat_name,asker_name,ask,last_ms,created_at,context_id,decision,owner_reply,draft) values(?,'lark',?,'group','值班群',?,?,0,?,?,?,?,?)`,
        id, chat, asker, ask, new Date().toISOString(), c.id, extra.decision ?? null, extra.owner_reply ?? null, extra.draft ?? null);
    add("rs1", "小王", "oc_ops", "UID 123 的主页打不开", { decision: "sent", draft: "查了日志，是 POI 被过滤" });
    add("rs2", "小李", "oc_ops", "周会改时间吗", { owner_reply: "改到周四" });
    add("rs3", "小王", "oc_ops", "能帮忙申请权限吗", { decision: "dropped" });
    add("rs4", "小王", "oc_ops", "没人管的", {});
    const near = nearCases(app, { contextId: c.id, askerName: "小王", chatId: "oc_ops", text: "UID 456 的主页也打不开" }, 3);
    expect(near.map((x) => x.id)).toEqual(["rs1", "rs3", "rs2"]);
    expect(casesText(near)).toContain("本人自己回了：改到周四");
    expect(all(app.db, "select 1 from reply_samples where id = 'rs4'")).toHaveLength(1);
    expect(near.some((x) => x.id === "rs4")).toBe(false);
  });

  it("set_chat_watch makes one 关注 of several groups, keeps a group in two, and pauses instead of deleting", async () => {
    const app = testApp();
    const ctx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    const brief = { handle: ["和需求有关的问题"], skip: [], valid: "有依据" };
    expect((await callTool(ctx, "set_chat_watch", { chat_id: "oc_a", chats: ["oc_b"], name: "需求 X", reply: "none", until: "never" })).text).toContain("2 个群");
    expect((await callTool(ctx, "set_chat_watch", { chat_id: "oc_b", chats: ["oc_c"], name: "需求 Y", reply: "draft", brief, until: "never" })).text).toContain("开始关注「需求 Y」");
    expect(contextsOfChat(app, "oc_b").map((c) => c.name).sort()).toEqual(["需求 X", "需求 Y"]);
    // Ambiguous without context.
    expect((await callTool(ctx, "set_chat_watch", { chat_id: "oc_b", remove: true })).isError).toBe(true);
    const y = contextsOfChat(app, "oc_b").find((c) => c.name === "需求 Y")!;
    expect((await callTool(ctx, "set_chat_watch", { context: y.id, owner_asks: "draft", strictness: 0.8 })).isError).toBe(false);
    expect(getContext(app, y.id)!.knobs).toMatchObject({ ownerAsks: "draft", strictness: 0.8 });
    await callTool(ctx, "set_chat_watch", { context: y.id, remove: true });
    expect(getContext(app, y.id)!.status).toBe("paused");
    expect(contextsOfChat(app, "oc_b").map((c) => c.name)).toEqual(["需求 X"]);
    expect(chatListened(app, "oc_c")).toBe(false);
  });

  it("keeps a quiet batch as a case, files cases into scenes with listen-coach, and learns from the owner's own replies", async () => {
    const app = testApp();
    const { createRun } = await import("../src/agents/runs.ts");
    const { coachDue, collectOwnerReplies } = await import("../src/channels/listen-coach.ts");
    const { playbookPath } = await import("../src/channels/listen-cases.ts");
    const c = saveContext(app, { kind: "place", name: "值班群", chats: ["oc_ops"], knobs: { reply: "none" } });
    await routeWatchedMessages(app, "oc_ops", "值班群", [{ id: "om_q", time: now(), sender: "小王", text: "周会改到几点" }]);
    const batch = listRuns(app, { kind: "ask" })[0];
    const handler = toolContextForToken(app, issueToolToken({ runId: batch.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    expect((await callTool(handler, "stay_quiet", { reason: "闲聊，和值班无关" })).isError).toBe(false);
    expect(one(app.db, "select decision, reason, ask, asker_name from reply_samples where context_id = ?", c.id)).toMatchObject({ decision: "quiet", reason: "闲聊，和值班无关", asker_name: "小王" });

    // The owner answers someone in the group themselves: a case, even where nobody drafted anything.
    const ms = Date.now();
    run(app.db, "insert into lark_messages(message_id,chat_id,sender_name,sender_kind,content,create_ms) values('om_ask','oc_ops','小李','user','UID 9 的页面打不开',?)", ms - 1000);
    run(app.db, "insert into lark_messages(message_id,chat_id,parent_id,sender_name,sender_kind,content,create_ms) values('om_mine','oc_ops','om_ask','本人','owner','是 POI 被过滤了，找地点值班',?)", ms);
    run(app.db, "insert into kv(key,value) values('listen_owner_replies_ms', ?)", String(ms - 5000));
    expect(collectOwnerReplies(app)).toBe(1);
    expect(one(app.db, "select owner_reply, asker_name from reply_samples where id = 'rs_own_om_mine'")).toMatchObject({ owner_reply: "是 POI 被过滤了，找地点值班", asker_name: "小李" });

    // Enough cases the owner had a say in: listen-coach is queued, and its hand-in becomes the lessons.
    for (let i = 0; i < 4; i++) run(app.db, `insert into reply_samples(id,channel,chat_id,chat_kind,chat_name,asker_name,ask,last_ms,created_at,context_id,decision,draft,decided_at) values(?,'lark','oc_ops','group','值班群','小王',?,0,?,?,'sent','查了日志',?)`, `rs_s${i}`, `UID ${i} 打不开`, new Date().toISOString(), c.id, new Date().toISOString());
    expect(coachDue(app)).toBe(1);
    expect(coachDue(app)).toBe(0);
    const coachRun = listRuns(app, { kind: "listen-coach" })[0];
    const coach = toolContextForToken(app, issueToolToken({ runId: coachRun.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
    const out = await callTool(coach, "submit_playbook", {
      scenes: [{ name: "用户报页面打不开", when: "带 UID 说页面打不开", reply: "yes", check: "查 POI 过滤日志", answer: "先给结论再给日志链接", cases: ["rs_s0", "rs_own_om_mine"] }],
      case_scenes: [{ case: "rs_s1", scene: "用户报页面打不开" }],
    });
    expect(out.isError).toBe(false);
    const file = one<{ text: string }>(app.db, "select text from sources where uri = ?", `work/${playbookPath(c)}`)!;
    expect(file.text).toContain("## 用户报页面打不开");
    expect(file.text).toContain("查 POI 过滤日志");
    expect(all(app.db, "select id from reply_samples where scene = '用户报页面打不开' order by id")).toHaveLength(3);
    expect(getContext(app, c.id)!.playbookAt).toBeTruthy();
    // A rename keeps the lessons where they were written.
    saveContext(app, { id: c.id, kind: "place", name: "改名后的值班群" });
    expect(playbookOf(app, getContext(app, c.id)!)).toContain("用户报页面打不开");
    // Others may not hand in lessons; the handler now reads them.
    expect((await callTool(handler, "submit_playbook", { scenes: [{ name: "xx", when: "xx", reply: "no" }] })).isError).toBe(true);
    await routeWatchedMessages(app, "oc_ops", "值班群", [{ id: "om_q2", time: now(), sender: "小王", text: "UID 7 打不开" }]);
    const t = findThread(app, c.conversationId!)!;
    expect(await watchedNote(app, t, threadMessages(app, t.id).slice(-1))).toContain("这个关注的经验");
  });

  it("serves 关注 to the web: list with the default one, detail, create, update, correct a case, coach by hand", async () => {
    const app = testApp();
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const list = (await server.inject({ method: "GET", url: "/api/listen" })).json();
      expect(list.map((c: { kind: string }) => c.kind)).toContain("default");
      expect((await server.inject({ method: "POST", url: "/api/listen", payload: { chats: ["oc_w"], knobs: { reply: "draft" } } })).statusCode).toBe(400);
      const made = await server.inject({ method: "POST", url: "/api/listen", payload: { name: "网页建的", chats: ["oc_w", "oc_w2"], brief: { handle: ["报错"], skip: [], valid: "有依据" }, knobs: { ownerAsks: "draft" } } });
      expect(made.statusCode).toBe(200);
      const id = made.json().id;
      expect(made.json()).toMatchObject({ name: "网页建的", knobs: { ownerAsks: "draft" }, brief: { confirmedAt: expect.any(String) } });
      expect((await server.inject({ method: "PUT", url: `/api/listen/${id}`, payload: { knobs: { ownerAsks: null, strictness: 0.8 } } })).json().knobs).toMatchObject({ ownerAsks: "notify", strictness: 0.8 });
      // Choosing the reply mode on the web ends a trial of direct replies.
      saveContext(app, { id, kind: "place", knobs: { wantsAuto: true } });
      expect((await server.inject({ method: "PUT", url: `/api/listen/${id}`, payload: { knobs: { strictness: 0.7 } } })).json().knobs.wantsAuto).toBe(true);
      expect((await server.inject({ method: "PUT", url: `/api/listen/${id}`, payload: { knobs: { reply: "draft" } } })).json().knobs.wantsAuto).toBeUndefined();
      run(app.db, "insert into reply_samples(id,channel,chat_id,chat_kind,chat_name,asker_name,ask,last_ms,created_at,context_id,decision) values('rs_w','lark','oc_w','group','g','小王','?',0,?,?,'sent')", new Date().toISOString(), id);
      // A memory the assistant drew from the group (stored without a user, as the owner's are).
      const chatSource = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_w", title: "g", text: "小王：退款接口 502" }).id;
      remember(app, { spaceId: "personal", kind: "fact", content: "退款接口 502 是下游超时", sourceRefs: [`src:${chatSource}#L1-L1`], createdBy: "agent" });
      const detail = (await server.inject({ method: "GET", url: `/api/listen/${id}` })).json();
      expect(detail.cases.map((c: { id: string }) => c.id)).toEqual(["rs_w"]);
      expect(detail.memories.map((m: { content: string }) => m.content)).toEqual(["退款接口 502 是下游超时"]);
      expect(detail.context.groups).toHaveLength(2);
      expect((await server.inject({ method: "PUT", url: "/api/cases/rs_w", payload: { verdict: "should-not", note: "这类不用回" } })).json()).toMatchObject({ verdict: "should-not", note: "这类不用回" });
      expect((await server.inject({ method: "GET", url: "/api/lark/chats/oc_w/detail" })).json().contexts[0].id).toBe(id);
      expect((await server.inject({ method: "POST", url: `/api/listen/${id}/coach` })).json().runId).toBeTruthy();
      expect((await server.inject({ method: "DELETE", url: `/api/listen/${id}` })).statusCode).toBe(200);
      expect(chatListened(app, "oc_w")).toBe(false);
    } finally {
      await server.close();
    }
  });
});


describe("learning a 关注 from history", () => {
  it("turns the owner's past answers in closed groups into cases, quoted or not, once, and queues the coach", async () => {
    const app = testApp();
    const { learnFromHistory } = await import("../src/channels/listen-coach.ts");
    const c = saveContext(app, { kind: "place", name: "工单群", chats: ["oc_live"], knobs: { reply: "none" } });
    const day = 86400_000, t = Date.now() - 3 * day;
    const msg = (id: string, chat: string, kind: string, text: string, at: number, parent: string | null = null) =>
      run(app.db, "insert into lark_messages(message_id,chat_id,parent_id,sender_name,sender_kind,content,create_ms) values(?,?,?,?,?,?,?)", id, chat, parent, kind === "owner" ? "本人" : kind === "app" ? "工单机器人" : "小王", kind, text, at);
    for (let i = 0; i < 5; i++) {
      const chat = `oc_old${i}`;
      msg(`om_card${i}`, chat, "app", "工单卡片", t + i * 1000);
      msg(`om_q${i}`, chat, "user", `UID ${i} 员工号解绑失败`, t + i * 1000 + 10);
      // Two answer by quoting; the rest just answer right after.
      msg(`om_a${i}`, chat, "owner", `查了，是主账号已注销 ${i}`, t + i * 1000 + 20, i < 2 ? `om_q${i}` : null);
    }
    msg("om_late", "oc_old0", "owner", "两个月前的回答", Date.now() - 50 * day);
    const r = learnFromHistory(app, c.id, { chats: ["oc_old0", "oc_old1", "oc_old2", "oc_old3", "oc_old4"], days: 30 });
    expect(r).toMatchObject({ chats: 5, added: 5 });
    expect(r.coachRunId).toBeTruthy();
    expect(one(app.db, "select ask, owner_reply, source from reply_samples where id = 'rs_own_om_a3'")).toMatchObject({ ask: "UID 3 员工号解绑失败", owner_reply: "查了，是主账号已注销 3", source: "watch" });
    // Again: nothing new, nothing doubled.
    expect(learnFromHistory(app, c.id, { chats: ["oc_old0"], days: 30 }).added).toBe(0);
    expect(one<{ n: number }>(app.db, "select count(*) n from reply_samples where context_id = ?", c.id)!.n).toBe(5);
  });
});
