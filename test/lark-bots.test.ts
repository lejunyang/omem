import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { one, run } from "../src/core/db.ts";
import { botRoster, onBotMessage, registerMainRelay, relayMentions, renderBotMentions, rosterNote } from "../src/channels/lark-bots.ts";
import { postedByOmem, setLarkBotClient, setLarkClient } from "../src/channels/lark-send.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

/** A bot client that records what it posts. */
type Sent = { to: string; content: string; id: string };
function fakeClient(sent: Sent[], prefix: string) {
  const post = (to: string, data: { content: string }) => {
    const id = `om_${prefix}_${sent.length + 1}`;
    sent.push({ to, content: data.content, id });
    return { code: 0, data: { message_id: id } };
  };
  return {
    im: {
      message: {
        reply: async ({ path, data }: any) => post(path.message_id, data),
        create: async ({ data }: any) => post(data.receive_id, data),
      },
      messageReaction: { create: async () => ({ code: 0, data: { reaction_id: "r1" } }), delete: async () => ({}) },
    },
  };
}

const event = (o: { id: string; chat?: string; text: string; sender?: string; mentions?: { key: string; name: string; open_id: string }[] }) => ({
  sender: { sender_type: "user", sender_id: { open_id: o.sender ?? "ou_owner_in_b" } },
  message: {
    message_id: o.id, chat_id: o.chat ?? "oc_team", chat_type: "group", message_type: "text", content: JSON.stringify({ text: o.text }),
    mentions: (o.mentions ?? []).map((m) => ({ key: m.key, name: m.name, id: { open_id: m.open_id } })),
  },
});

describe("more Feishu bots, each its own profile", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-bots-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner", appId: "cli_main", bots: [{ id: "reviewer-bot", appId: "cli_rev", agent: "code-checker", ownerOpenId: "ou_owner_in_b" }], botRelay: 1 },
      agents: { default: "fake", profiles: [fake("fake", { FAKE_MODE: "thread" })] },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  saveAgentSpec(app, { name: "code-checker", description: "代码检查员：看改动有没有问题", prompt: "只看代码。" }, "user");
  const mainSent: Sent[] = [];
  const botSent: Sent[] = [];
  setLarkClient(fakeClient(mainSent, "main"), "ou_main");
  setLarkBotClient("reviewer-bot", fakeClient(botSent, "rev"), "ou_rev_self", "检查员");
  run(app.db, "insert into kv(key,value) values('lark_bot_name','小助手')");
  const relayed: { text: string; from: string }[] = [];
  registerMainRelay(async (t) => void relayed.push({ text: t.text, from: t.from }));
  afterAll(() => {
    registerMainRelay(null);
    setLarkBotClient("reviewer-bot", null);
    setLarkClient(null);
    releaseAll();
    server.close();
  });

  it("knows the other bots and how to hand over", () => {
    expect(botRoster(app).map((r) => r.name)).toEqual(["小助手", "检查员"]);
    const note = rosterNote(app, "reviewer-bot");
    expect(note).toContain("你是「检查员」");
    expect(note).toContain("「小助手」：主助手");
    expect(note).toContain("Agent 档案 code-checker：代码检查员");
  });

  it("answers an @ from the owner as its own profile, in a conversation of its own, and hands an @ on", async () => {
    await onBotMessage(app, app.config.lark.bots[0], event({
      id: "om_1", text: "@_user_1 看看这次改动，再请 @_user_2 排一下上线时间",
      mentions: [{ key: "@_user_1", name: "检查员", open_id: "ou_rev_self" }, { key: "@_user_2", name: "小助手", open_id: "ou_main_in_rev" }],
    }));
    const conv = one<{ channel: string; spec: string | null }>(app.db, "select channel, json_extract(settings,'$.spec') spec from conversations where channel = 'lark:reviewer-bot'");
    expect(conv).toMatchObject({ channel: "lark:reviewer-bot", spec: "code-checker" });
    expect(botSent).toHaveLength(1);
    expect(botSent[0].to).toBe("om_1");
    expect(botSent[0].content).toContain("代码检查员");
    // It learned the main bot's id in its own app and @-ed it for real.
    expect(botSent[0].content).toContain("<at id=ou_main_in_rev></at>");
    expect(mainSent).toHaveLength(0);
    // Delivered back to it by Feishu, its own post is left alone.
    expect(postedByOmem(botSent[0].id)).toBe(true);
    // The reply @-ed the main bot: it takes the message, once.
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ from: "reviewer-bot" });
    expect(relayed[0].text).toContain("「检查员」@ 了你");
    expect(relayMentions(app, "reviewer-bot", { chatId: "oc_team", messageId: "om_x", text: "@小助手 还有一件事" })).toEqual([]);
  });

  it("ignores messages that do not @ it, other omem bots' posts and people it cannot place", async () => {
    const before = botSent.length;
    await onBotMessage(app, app.config.lark.bots[0], event({ id: "om_2", text: "随便聊聊" }));
    await onBotMessage(app, app.config.lark.bots[0], event({ id: "om_3", text: "@_user_1 你好", sender: "ou_stranger", mentions: [{ key: "@_user_1", name: "检查员", open_id: "ou_rev_self" }] }));
    expect(botSent.length).toBe(before);
    expect(renderBotMentions(app, "main", "@检查员 看看")).toBe("@检查员 看看");
  });
});
