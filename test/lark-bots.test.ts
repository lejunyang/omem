import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { withBot } from "../src/core/bot-context.ts";
import { one, run } from "../src/core/db.ts";
import { OWNER } from "../src/core/users.ts";
import { setupLarkBot } from "../src/channels/lark-bot.ts";
import { botRoster, larkUser, relayMentions, rosterNote, setMainMemberForTests } from "../src/channels/lark-bots.ts";
import { rememberPerson, resolveMention } from "../src/channels/lark-people.ts";
import { getInteraction, postedByOmem, recordInteraction, setLarkBotClient } from "../src/channels/lark-send.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

type Sent = { to: string; content: string; id: string };
/** A bot client: records posts; any other SDK call answers with an empty success. */
function fakeClient(name: string, openId: string, sent: Sent[], chats: Set<string>) {
  const post = (to: string, data: { content: string }) => {
    const id = `om_${openId}_${sent.length + 1}`;
    sent.push({ to, content: data.content, id });
    return { code: 0, data: { message_id: id } };
  };
  const overrides: Record<string, (...a: any[]) => Promise<unknown>> = {
    request: async (o: { url: string }) => (o.url.includes("/bot/v3/info") ? { bot: { open_id: openId, app_name: name } } : { code: 1, msg: "unsupported in test" }),
    "im.message.reply": async ({ path, data }: any) => post(path.message_id, data),
    "im.message.create": async ({ data }: any) => post(data.receive_id, data),
    "im.messageReaction.create": async () => ({ code: 0, data: { reaction_id: "r1" } }),
    "im.chat.get": async ({ path }: any) => (chats.has(path.chat_id) ? { code: 0, data: { name: "项目群" } } : { code: 232011, msg: "not in chat" }),
  };
  const make = (path: string): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (typeof k !== "string" || k === "then" ? undefined : make(path ? `${path}.${k}` : k)),
      apply: (_t, _this, args) => (overrides[path] ?? (async () => ({ code: 0, data: {} })))(...args),
    });
  return make("");
}

const event = (o: { id: string; chat?: string; text: string; sender?: string; userId?: string; mentions?: { key: string; name: string; open_id: string }[] }) => ({
  sender: { sender_type: "user", sender_id: { open_id: o.sender ?? "ou_owner_in_rev", ...(o.userId ? { user_id: o.userId } : {}) } },
  message: {
    message_id: o.id, chat_id: o.chat ?? "oc_team", chat_type: "group", message_type: "text", content: JSON.stringify({ text: o.text }), create_time: String(Date.now()),
    mentions: (o.mentions ?? []).map((m) => ({ key: m.key, name: m.name, id: { open_id: m.open_id } })),
  },
});

describe("several Feishu bots, the same abilities, each its own profile", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-bots-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner", appId: "cli_main", bots: [{ id: "reviewer-bot", appId: "cli_rev", agent: "code-checker", ownerOpenId: "ou_owner_in_rev" }], botRelay: 1 },
      agents: { default: "fake", profiles: [fake("fake", { FAKE_MODE: "thread" })] },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  saveAgentSpec(app, { name: "code-checker", description: "代码检查员：看改动有没有问题", prompt: "只看代码。" }, "user");
  const mainSent: Sent[] = [];
  const botSent: Sent[] = [];
  const mainChats = new Set(["oc_team"]);
  run(app.db, "insert into kv(key,value) values('lark_bot_name','小助手')");
  const main = await setupLarkBot(app, "main", fakeClient("小助手", "ou_main", mainSent, mainChats));
  const rev = await setupLarkBot(app, "reviewer-bot", fakeClient("检查员", "ou_rev", botSent, new Set(["oc_team", "oc_solo"])));
  afterAll(() => {
    setLarkBotClient("reviewer-bot", null);
    setLarkBotClient("main", null);
    releaseAll();
    server.close();
  });
  const send = async (h: typeof rev, e: ReturnType<typeof event>) => {
    await h.message(e);
    await h.settled();
  };

  it("knows the other bots and how to hand over", () => {
    expect(botRoster(app).map((r) => r.name)).toEqual(["小助手", "检查员"]);
    const note = rosterNote(app, "reviewer-bot");
    expect(note).toContain("你是「检查员」");
    expect(note).toContain("「小助手」：主助手");
    expect(note).toContain("Agent 档案 code-checker：代码检查员");
  });

  it("answers an @ through its own app as its profile, and hands an @ of another bot on", async () => {
    setMainMemberForTests("oc_team", true);
    await send(rev, event({
      id: "om_1", text: "@_user_1 看看这次改动，再请 @_user_2 排一下上线时间",
      mentions: [{ key: "@_user_1", name: "检查员", open_id: "ou_rev" }, { key: "@_user_2", name: "小助手", open_id: "ou_main_in_rev" }],
    }));
    const conv = one<{ channel: string; spec: string | null }>(app.db, "select channel, json_extract(settings,'$.spec') spec from conversations where channel = 'lark:reviewer-bot'");
    expect(conv).toMatchObject({ spec: "code-checker" });
    const answer = botSent.find((s) => s.to === "om_1" && s.content.includes("代码检查员"));
    expect(answer).toBeTruthy();
    // It learned the main bot's id in its own app and @-ed it for real.
    expect(answer!.content).toContain("<at id=ou_main_in_rev></at>");
    expect(postedByOmem(answer!.id)).toBe(true);
    // The main bot is in this chat: it keeps the chat's records, not this one.
    expect(one(app.db, "select 1 from lark_messages where message_id = 'om_1'")).toBeUndefined();
    // The main bot took the hand-off: it answered under the reviewer's post, through its own app.
    await expect.poll(() => mainSent.some((s) => s.to === answer!.id), { timeout: 15_000 }).toBe(true);
    expect(one(app.db, "select 1 from conversations where channel = 'lark' and external_id = 'oc_team'")).toBeTruthy();
    // Hand-offs in a row are bounded (lark.botRelay = 1) until a person speaks.
    expect(relayMentions(app, "reviewer-bot", { chatId: "oc_team", messageId: "om_x", text: "@小助手 还有一件事" })).toEqual([]);
  });

  it("keeps the records of a chat the main bot is not in", async () => {
    setMainMemberForTests("oc_solo", false);
    await send(rev, event({ id: "om_solo", chat: "oc_solo", text: "今天发布" }));
    expect(one(app.db, "select 1 from lark_messages where message_id = 'om_solo'")).toBeTruthy();
    expect(botSent.some((s) => s.to === "om_solo")).toBe(false);
  });

  it("speaks with ids of its own app: people by user_id, the owner by its open_id there", async () => {
    rememberPerson(app, { botOpenId: "ou_wang_main", name: "小王" });
    rememberPerson(app, { botOpenId: "ou_li_main", userId: "u_li", name: "小李" });
    await withBot("reviewer-bot", async () => {
      expect(await resolveMention(app, "小李")).toMatchObject({ userId: "u_li" });
      await expect(resolveMention(app, "小王")).rejects.toThrow();
      // A card it posts is updated and answered through it.
      const id = recordInteraction(app, { messageId: "om_card", chatId: "oc_team", conversationId: null, runId: null, purpose: "agent", allowed: [], payload: {} });
      expect(getInteraction(app, id)!.bot).toBe("reviewer-bot");
    });
    expect(await resolveMention(app, "小王")).toMatchObject({ userId: "ou_wang_main" });
    expect(larkUser(app, { open_id: "ou_owner_in_rev" }, "reviewer-bot")).toBe(OWNER);
    expect(larkUser(app, { open_id: "ou_owner_in_rev" }, "main")).toBeNull();
  });

  it("ignores messages that do not @ it and people it cannot place", async () => {
    const before = botSent.length;
    await send(rev, event({ id: "om_2", text: "随便聊聊" }));
    await send(rev, event({ id: "om_3", text: "@_user_1 你好", sender: "ou_stranger", mentions: [{ key: "@_user_1", name: "检查员", open_id: "ou_rev" }] }));
    expect(botSent.length).toBe(before);
    void main;
  });
});
