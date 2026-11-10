import { afterEach, describe, expect, it } from "vitest";
import { deliverToThread, receive } from "../src/agents/inbox.ts";
import { homeOf, moveHome } from "../src/agents/home.ts";
import { followOwner } from "../src/agents/code-chain.ts";
import { addMessage, createThread, updateThread } from "../src/agents/threads.ts";
import { fireWake, type WakeInput } from "../src/agents/wakes.ts";
import { one, run } from "../src/core/db.ts";
import { setupLarkBot } from "../src/channels/lark-bot.ts";
import { onLarkSent, setLarkBotClient } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

type Post = { to: string; inThread: boolean; text: string; id: string };

/** A bot client: records where each post went; replies under a message listed in `gone` fail as Feishu does for a deleted one. */
function fakeClient(posts: Post[], gone = new Set<string>()) {
  const text = (data: any) => String(data.content ?? "");
  const overrides: Record<string, (...a: any[]) => Promise<unknown>> = {
    request: async (o: { url: string }) => (o.url.includes("/bot/v3/info") ? { bot: { open_id: "ou_bot", app_name: "小助手" } } : { code: 0, data: {} }),
    "im.message.reply": async ({ path, data }: any) => {
      if (gone.has(path.message_id)) return { code: 230011, msg: "The message was withdrawn." };
      const id = `om_bot_${posts.length + 1}`;
      posts.push({ to: path.message_id, inThread: !!data.reply_in_thread, text: text(data), id });
      return { code: 0, data: { message_id: id, ...(data.reply_in_thread ? { thread_id: "omt_x" } : {}) } };
    },
    "im.message.create": async ({ data }: any) => {
      const id = `om_bot_${posts.length + 1}`;
      posts.push({ to: data.receive_id, inThread: false, text: text(data), id });
      return { code: 0, data: { message_id: id, chat_id: data.receive_id } };
    },
  };
  const make = (path: string): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (typeof k !== "string" || k === "then" ? undefined : make(path ? `${path}.${k}` : k)),
      apply: (_t, _this, args) => (overrides[path] ?? (async () => ({ code: 0, data: {} })))(...args),
    });
  return make("");
}

afterEach(() => {
  onLarkSent(null);
  setLarkBotClient("main", null);
});

async function setup(gone?: Set<string>) {
  const app = testApp();
  app.config.lark.ownerOpenId = "ou_owner";
  run(app.db, "insert into kv(key,value) values('lark_owner_chat','oc_dm')");
  const posts: Post[] = [];
  await setupLarkBot(app, "main", fakeClient(posts, gone));
  return { app, posts };
}

/** The owner's request in a conversation and the ask run it started (the work's first run). */
function ask(app: ReturnType<typeof testApp>, conversationId: string, text: string, externalId?: string) {
  const runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", runId, "ask", "personal", "done", text, JSON.stringify({ conversationId }), new Date(Date.now() - 60_000).toISOString());
  addMessage(app, conversationId, "user", text, runId, externalId ? { externalId } : {});
  return runId;
}

const wake = (setBy: string, conversationId: string, setAt: string): WakeInput => ({ note: "看一下复核结果", target: { conversationId }, setBy: { runId: setBy, agent: "助理" }, setAt });
const conversationOf = (app: ReturnType<typeof testApp>, runId: string) => JSON.parse(one<{ input: string }>(app.db, "select input from runs where id = ?", runId)!.input).conversationId as string;

describe("a piece of work is followed where it was last talked about", () => {
  it("asked in a topic: the wake-up's result goes back into that topic", async () => {
    const { app, posts } = await setup();
    const topic = createThread(app, { channel: "lark", key: "oc_team#omt_fix", spaceId: "personal", userId: "owner" });
    updateThread(app, topic.id, { settings: { lastMessageId: "om_req", lastTopicId: "omt_fix" } });
    const root = ask(app, topic.id, "修一下 diff 的问题", "om_req");
    const woke = fireWake(app, wake(root, topic.id, new Date().toISOString()));
    expect(conversationOf(app, woke.runId!)).toBe(topic.id);
    await deliverToThread(app, topic.id, "复核通过", { runId: woke.runId });
    expect(posts.at(-1)).toMatchObject({ to: "om_req", inThread: true });
  });

  it("carried on in a new topic: later wake-ups and replies go there, the old topic hears nothing more", async () => {
    const { app, posts } = await setup();
    const first = createThread(app, { channel: "lark", key: "oc_team#omt_a", spaceId: "personal", userId: "owner" });
    updateThread(app, first.id, { settings: { lastMessageId: "om_req", lastTopicId: "omt_a" } });
    const root = ask(app, first.id, "修一下 diff 的问题", "om_req");
    const setAt = new Date(Date.now() - 30_000).toISOString();
    // The work posted a result in the first topic.
    await deliverToThread(app, first.id, "第一轮做完了", { runId: root });
    const result = posts.at(-1)!.id;
    // The owner opens another topic of the chat and replies to that result there (quoting it).
    const second = createThread(app, { channel: "lark", key: "oc_team#omt_b", spaceId: "personal", userId: "owner" });
    await receive(app, { conversationId: second.id, channel: "lark", text: "换个思路，接着做", externalMessageId: "om_owner_b", quote: { messageId: result } });
    expect(homeOf(app, root)).toMatchObject({ conversationId: second.id, anchor: "om_owner_b" });
    // A wake-up set before the move fires where the work is now, and its answer is posted there.
    const woke = fireWake(app, wake(root, first.id, setAt));
    expect(conversationOf(app, woke.runId!)).toBe(second.id);
    await deliverToThread(app, second.id, "复核通过", { runId: woke.runId });
    expect(posts.at(-1)).toMatchObject({ to: "om_owner_b", inThread: true });
    // A wake-up set after the move stays where it was set (the owner may move it again by talking there).
    const later = fireWake(app, wake(root, first.id, new Date(Date.now() + 1000).toISOString()));
    expect(conversationOf(app, later.runId!)).toBe(first.id);
  });

  it("steering a delegation from the private chat moves the whole work there, wake-ups included", async () => {
    const app = testApp();
    const topic = createThread(app, { channel: "lark", key: "oc_team#omt_a", spaceId: "personal", userId: "owner" });
    const dm = createThread(app, { channel: "lark", key: "oc_dm", spaceId: "personal", userId: "owner" });
    const root = ask(app, topic.id, "修一下 diff 的问题", "om_req");
    const code = `r_code_${Math.random().toString(36).slice(2, 8)}`;
    run(app.db, "insert into runs(id,kind,space_id,status,title,input,parent_id,created_at) values(?,?,?,?,?,?,?,?)", code, "code", "personal", "failed", "交办", "{}", root, new Date().toISOString());
    const setAt = new Date(Date.now() - 1000).toISOString();
    expect(followOwner(app, code, dm.id, "owner")).toBe(true);
    expect(homeOf(app, code)?.conversationId).toBe(dm.id);
    expect(conversationOf(app, fireWake(app, wake(root, topic.id, setAt)).runId!)).toBe(dm.id);
  });

  it("in the chat itself, quotes only the work's own message — never an unrelated one — and nothing when it has none", async () => {
    const { app, posts } = await setup();
    const dm = createThread(app, { channel: "lark", key: "oc_dm2", spaceId: "personal", userId: "owner" });
    // The chat's last message is a meeting's conclusion, nothing to do with the work.
    updateThread(app, dm.id, { settings: { lastMessageId: "om_meeting", lastTopicId: null } });
    // A wake-up turn: nobody's message in it to quote.
    const root = `r_${Math.random().toString(36).slice(2, 10)}`;
    run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", root, "ask", "personal", "done", "唤醒", JSON.stringify({ conversationId: dm.id, wake: true }), new Date().toISOString());
    await deliverToThread(app, dm.id, "第一轮断了，已重试", { runId: root });
    expect(posts.at(-1)).toMatchObject({ to: "oc_dm2", inThread: false });
    const own = posts.at(-1)!.id;
    // Its next post replies to its own earlier one.
    await deliverToThread(app, dm.id, "重试通过", { runId: root });
    expect(posts.at(-1)).toMatchObject({ to: own, inThread: false });
    expect(posts.some((p) => p.to === "om_meeting")).toBe(false);
    // A message without a run behind it quotes nothing either.
    await deliverToThread(app, dm.id, "提醒");
    expect(posts.at(-1)).toMatchObject({ to: "oc_dm2" });
  });

  it("a work's anchor that became the root of another task's topic is not quoted any more", async () => {
    const { app, posts } = await setup();
    const dm = createThread(app, { channel: "lark", key: "oc_dm3", spaceId: "personal", userId: "owner" });
    const root = ask(app, dm.id, "整理一下周报", "om_weekly");
    // Another task opens a topic under that message (/topic, a work topic).
    const { sendLark } = await import("../src/channels/lark-send.ts");
    await sendLark({ replyTo: "om_weekly", inThread: true }, { text: "这项任务在本话题中开始" });
    await deliverToThread(app, dm.id, "周报好了", { runId: root });
    expect(posts.at(-1)).toMatchObject({ to: "oc_dm3", inThread: false });
  });

  it("the topic is gone: the follow-up goes to the owner's private chat and says what it follows up", async () => {
    const { app, posts } = await setup(new Set(["om_deleted"]));
    const topic = createThread(app, { channel: "lark", key: "oc_team#omt_gone", spaceId: "personal", userId: "owner" });
    updateThread(app, topic.id, { settings: { lastMessageId: "om_deleted", lastTopicId: "omt_gone" } });
    const root = ask(app, topic.id, "核对一下回滚影响范围", "om_deleted");
    await deliverToThread(app, topic.id, "核对完了：只影响两个页面", { runId: root });
    expect(posts.at(-1)).toMatchObject({ to: "oc_dm", inThread: false });
    expect(posts.at(-1)!.text).toContain("「核对一下回滚影响范围」的后续");
    expect(posts.at(-1)!.text).toContain("只影响两个页面");
  });

  it("moving keeps nothing but the home: the same conversation only refreshes what to quote", () => {
    const app = testApp();
    const dm = createThread(app, { channel: "lark", key: "oc_dm4", spaceId: "personal", userId: "owner" });
    const root = ask(app, dm.id, "查一下", "om_q");
    expect(moveHome(app, root, dm.id, "om_q2")).toBe(false);
    expect(homeOf(app, root)).toMatchObject({ conversationId: dm.id, anchor: "om_q2" });
    expect(homeOf(app, root)?.movedAt).toBeUndefined();
  });
});
