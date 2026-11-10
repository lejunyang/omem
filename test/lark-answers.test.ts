import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { createThread, updateThread } from "../src/agents/threads.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { newId } from "../src/core/util.ts";
import { run } from "../src/core/db.ts";
import { setupLarkBot } from "../src/channels/lark-bot.ts";
import { setCotSdk } from "../src/channels/lark-cot.ts";
import { setLarkBotClient } from "../src/channels/lark-send.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

type Reply = { to: string; inThread: boolean; content: string };
/** The bot's SDK client: records replies; any other call answers with an empty success. */
function fakeClient(replies: Reply[]) {
  const overrides: Record<string, (...a: any[]) => Promise<unknown>> = {
    request: async (o: { url: string }) => (o.url.includes("/bot/v3/info") ? { bot: { open_id: "ou_bot", app_name: "助手" } } : { code: 0, data: {} }),
    "im.message.reply": async ({ path, data }: any) => {
      replies.push({ to: path.message_id, inThread: !!data.reply_in_thread, content: data.content });
      return { code: 0, data: { message_id: `om_reply_${replies.length}` } };
    },
    "im.messageReaction.create": async () => ({ code: 0, data: { reaction_id: "r1" } }),
    "im.message.create": async ({ data }: any) => {
      replies.push({ to: data.receive_id, inThread: false, content: data.content });
      return { code: 0, data: { message_id: `om_new_${replies.length}` } };
    },
  };
  const make = (path: string): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (typeof k !== "string" || k === "then" ? undefined : make(path ? `${path}.${k}` : k)),
      apply: (_t, _this, args) => (overrides[path] ?? (async () => ({ code: 0, data: {} })))(...args),
    });
  return make("");
}

const event = (o: { id: string; chat: string; type?: "group" | "p2p"; text: string; sender: string; topic?: string; atBot?: boolean }) => ({
  sender: { sender_type: "user", sender_id: { open_id: o.sender } },
  message: {
    message_id: o.id, chat_id: o.chat, chat_type: o.type ?? "group", message_type: "text", create_time: String(Date.now()),
    content: JSON.stringify({ text: o.atBot === false ? o.text : `@_user_1 ${o.text}` }),
    ...(o.topic ? { thread_id: o.topic } : {}),
    mentions: o.atBot === false ? [] : [{ key: "@_user_1", name: "助手", id: { open_id: "ou_bot" } }],
  },
});

describe("answers in groups and where thinking bubbles go", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-answers-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner", appId: "cli_bot", guests: { enabled: true, ownerPresent: "guest" } },
      agents: { default: "fake", roles: { gatekeeper: "gate-yes" }, profiles: [fake("fake", { FAKE_MODE: "thread" }), fake("gate-yes", { FAKE_SAY: '{"verdict":"answer","reason":"项目相关的提问"}' }), fake("quiet", { FAKE_SAY: "看过了，不是新问题。", FAKE_QUIET: "同一个告警已经在处理" })] },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  vi.spyOn(console, "info").mockImplementation(() => {});
  const replies: Reply[] = [];
  // The bubble API: records what each bubble was created with; message lookups say which ids sit in a topic.
  const cots: { origin?: string; inThread: boolean }[] = [];
  const recalled: string[] = [];
  const inTopic = new Set(["om_became_root"]);
  setCotSdk({
    request: async (r: { method: string; url: string; data?: any }) => {
      if (r.method === "GET") {
        const id = decodeURIComponent(r.url.split("/").pop()!);
        return { code: 0, data: { items: [{ message_id: id, ...(inTopic.has(id) ? { thread_id: "omt_progress" } : {}) }] } };
      }
      if (r.method === "DELETE") recalled.push(decodeURIComponent(r.url.split("/").pop()!));
      if (r.method === "POST" && r.url.endsWith("/message_cot")) {
        cots.push({ origin: r.data.origin_message_id, inThread: r.data.reply_in_thread });
        return { code: 0, data: { cot_id: `cot_${cots.length}`, message_id: `om_cot_${cots.length}` } };
      }
      return { code: 0, data: {} };
    },
  });
  const bot = await setupLarkBot(app, "main", fakeClient(replies));
  afterAll(() => {
    vi.restoreAllMocks();
    setCotSdk(null);
    setLarkBotClient("main", null);
    releaseAll();
    server.close();
  });
  const send = async (e: ReturnType<typeof event>) => {
    await bot.message(e);
    await bot.settled();
  };
  const answerTo = (id: string) => replies.find((r) => r.to === id);

  it("@s whoever asked in a group, a colleague in guest mode too, but not the owner in the private chat", async () => {
    await send(event({ id: "om_owner_group", chat: "oc_team", text: "查一下上次的发布记录", sender: "ou_owner" }));
    expect(answerTo("om_owner_group")?.content).toContain("<at id=ou_owner></at>");
    await send(event({ id: "om_guest", chat: "oc_team", text: "部署文档在哪", sender: "ou_colleague" }));
    const guest = answerTo("om_guest");
    expect(guest?.content).toContain("<at id=ou_colleague></at>");
    expect(guest?.content).toContain("受限模式");
    await send(event({ id: "om_dm", chat: "oc_dm", type: "p2p", text: "今天有什么要做的", sender: "ou_owner", atBot: false }));
    const dm = answerTo("om_dm");
    expect(dm).toBeTruthy();
    expect(dm!.content).not.toContain("<at");
  }, 60_000);

  it("a meeting's conclusion goes to the private chat itself, not the topic the owner last wrote in", async () => {
    const { deliverToThread } = await import("../src/agents/inbox.ts");
    const { getThread } = await import("../src/agents/threads.ts");
    const t = createThread(app, { channel: "lark", key: "oc_owner_dm", spaceId: "personal", userId: "owner" });
    updateThread(app, t.id, { settings: { lastMessageId: "om_in_other_task", lastTopicId: "omt_other_task" } });
    await deliverToThread(app, t.id, "会议结论：下周二上线", { topLevel: true });
    await expect.poll(() => replies.find((r) => r.content.includes("下周二上线")), { timeout: 5_000 }).toBeTruthy();
    expect(replies.find((r) => r.content.includes("下周二上线"))).toMatchObject({ to: "oc_owner_dm", inThread: false });
    expect(getThread(app, t.id).settings).toMatchObject({ lastTopicId: null, lastMessageId: expect.stringMatching(/^om_new_/) });
  }, 30_000);

  it("a meeting run (it carries the rule that brought the bot in) posts its conclusion in the private chat itself", async () => {
    const { waitForRun } = await import("../src/agents/runs.ts");
    const t = createThread(app, { channel: "lark", key: "oc_owner_dm2", spaceId: "personal", userId: "owner" });
    // The main stream last replied to a message that is now another task's topic root.
    updateThread(app, t.id, { settings: { lastMessageId: "om_old_root", lastTopicId: null } });
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "assistant（会议「周会」，会后）", input: { spec: "assistant", assistantScope: { spaces: ["personal"], userId: "owner", denyTools: [], lark: { chats: [], draft: false } }, task: "# 会议结束\n\n周会结论", threadId: t.id, topLevel: true, rule: { id: "rule_meet", name: "入会拉机器人" } } });
    const done = await waitForRun(app, r.id);
    expect(done.error).toBeNull();
    await expect.poll(() => replies.find((x) => x.to === "oc_owner_dm2"), { timeout: 10_000 }).toBeTruthy();
    expect(replies.some((x) => x.to === "om_old_root")).toBe(false);
  }, 60_000);

  it("a reply in a topic gets its thinking bubble in that topic, with the answer", async () => {
    await send(event({ id: "om_in_topic", chat: "oc_team", topic: "omt_t1", text: "那就按第二个方案", sender: "ou_owner" }));
    expect(cots.find((c) => c.origin === "om_in_topic")).toEqual({ origin: "om_in_topic", inThread: true });
    expect(answerTo("om_in_topic")?.inThread).toBe(true);
  }, 60_000);

  it("a background turn whose anchor has since become a topic's root shows its bubble inside that topic", async () => {
    const turn = async (anchor: string) => {
      const t = createThread(app, { channel: "lark", key: `oc_chat_${anchor}`, spaceId: "personal", userId: "owner" });
      updateThread(app, t.id, { settings: { lastMessageId: "om_unrelated_meeting", lastTopicId: null } });
      // A delegation's result handed to the assistant (no worker picks it: it is already running).
      const id = newId("r");
      // The work's own latest message in this chat is the anchor (agents/home.ts), not whatever the chat said last.
      run(app.db, "insert into runs(id,kind,space_id,status,title,input,output,created_at) values(?,?,?,?,?,?,?,?)", id, "ask", "personal", "running", "编码交办的结果", JSON.stringify({ conversationId: t.id, messageIds: [], handoff: { kind: "code", workId: "r_work" } }), JSON.stringify({ home: { conversationId: t.id, anchor } }), new Date().toISOString());
      app.emit({ type: "run", runId: id, status: "running" });
      await expect.poll(() => cots.find((c) => c.origin === anchor), { timeout: 5_000 }).toBeTruthy();
      app.emit({ type: "run", runId: id, status: "done" });
      return cots.find((c) => c.origin === anchor)!;
    };
    // A coding progress card opened a topic under the request: the answer lands there, so does the bubble.
    expect(await turn("om_became_root")).toEqual({ origin: "om_became_root", inThread: true });
    // Still in the main stream: stays there.
    expect(await turn("om_plain")).toEqual({ origin: "om_plain", inThread: false });
  }, 30_000);

  it("a rule's agent that stays quiet posts nothing, and its bubble does not stay", async () => {
    saveAgentSpec(app, { name: "alert-checker", description: "看告警", agent: "quiet", prompt: "看告警是不是新的" }, "user");
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "看告警", input: { spec: "alert-checker", task: "看这条告警", rule: { id: "rule_alert", name: "告警" }, replyAt: { chatId: "oc_team", messageId: "om_alert" }, lark: { chats: ["oc_team"] } } });
    const { waitForRun } = await import("../src/agents/runs.ts");
    const done = await waitForRun(app, r.id);
    expect(done.output).toMatchObject({ quiet: true, stayQuiet: "同一个告警已经在处理" });
    expect(answerTo("om_alert")).toBeUndefined();
    // Either never created (it ended before the first push) or created and then recalled.
    const created = () => cots.filter((c) => c.origin === "om_alert").length;
    await expect.poll(() => recalled.filter((id) => id.startsWith("om_cot_")).length >= created() && created() <= 1, { timeout: 5_000 }).toBe(true);
    if (created()) expect(recalled).toContain(`om_cot_${cots.findIndex((c) => c.origin === "om_alert") + 1}`);
  }, 60_000);
});
