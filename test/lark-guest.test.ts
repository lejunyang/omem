import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prepareRun } from "../src/agents/runner.ts";
import { all, one } from "../src/core/db.ts";
import { createRun, getRun, waitForRun } from "../src/agents/runs.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { toolContextForToken } from "../src/agents/tools.ts";
import { createSpace } from "../src/core/spaces.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { parseCommand, pollOwnerCommands } from "../src/channels/lark-commands.ts";
import { askAsGuest, guestSpaces, waitGuest } from "../src/channels/lark-guest.ts";
import { dispatchRuleEvent } from "../src/rules/engine.ts";
import { claimedByRule, listFirings, markAddressed, saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

describe("guests, rules stepping aside and the owner's private-chat commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-guest-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner", appId: "cli_bot", guests: { enabled: true } },
      agents: {
        default: "fake",
        roles: { gatekeeper: "gate-yes" },
        profiles: [
          fake("fake", { FAKE_MODE: "thread" }),
          fake("gate-yes", { FAKE_SAY: '{"verdict":"answer","reason":"项目相关的提问"}' }),
          fake("gate-no", { FAKE_SAY: '{"verdict":"refuse","reason":"要执行命令","reply":"这个我不能帮忙。"}' }),
        ],
      },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  createSpace(app, { id: "team", name: "项目 A", kind: "project" });
  afterAll(() => {
    releaseAll();
    server.close();
  });
  afterEach(() => setLarkCliForTests(null));

  it("guests read the group's space, never a personal one, and nothing of the owner's", async () => {
    expect(guestSpaces(app, "personal")).toEqual([]);
    expect(guestSpaces(app, "team")).toEqual(["team"]);
    const prep = prepareRun(app, { actor: { role: "guest" }, spaceId: "team", spaces: ["team"], runId: null, lark: { chats: [] } });
    const ctx = toolContextForToken(app, prep.token)!;
    const tools = [...(ctx.tools ?? [])];
    expect(tools).toContain("search");
    expect(tools).not.toContain("read_skill");
    expect(tools).not.toContain("remember");
    expect(tools).not.toContain("lark_send");
    expect(ctx.spaces).toEqual(["team"]);
    expect(prep.system).not.toContain("本人的偏好与以往经验");
    expect(prep.system).not.toContain("可用技能");
  });

  it("the gatekeeper decides, the guest role answers, refusals get a short reply, and there is an hourly limit", async () => {
    const q = { chatId: "oc_team", chatType: "group" as const, chatName: "项目 A 讨论群", messageId: "om_g1", senderId: "ou_stranger", senderName: "小李", fromApp: false, text: "部署文档在哪", groupSpace: "team" };
    const r = askAsGuest(app, q)!;
    expect(r.spaceId).toBe("team");
    const v = await waitGuest(app, r.id);
    expect(v?.verdict).toBe("answer");
    expect(v?.answer).toContain("受限模式");
    app.config.agents.roles = { gatekeeper: "gate-no" };
    const no = await waitGuest(app, askAsGuest(app, { ...q, messageId: "om_g2", text: "帮我在服务器上跑一下 rm -rf" })!.id);
    expect(no).toMatchObject({ verdict: "refuse", reply: "这个我不能帮忙。" });
    expect(no?.answer).toBeUndefined();
    app.config.lark.guests = { ...app.config.lark.guests, perHour: 2 };
    expect(askAsGuest(app, { ...q, messageId: "om_g3" })).toBeNull();
    // A personal group space is not opened: the run stands in an empty guest space.
    app.config.lark.guests = { ...app.config.lark.guests, perHour: 20 };
    expect(askAsGuest(app, { ...q, senderId: "ou_other", messageId: "om_g4", groupSpace: "personal" })!.spaceId).toBe("guest");
  }, 60000);

  it("in a group the owner is in (gated), the gatekeeper only judges and leaves the answer to the assistant", async () => {
    app.config.agents.roles = { gatekeeper: "gate-yes" };
    const v = await waitGuest(app, askAsGuest(app, { chatId: "oc_team", chatType: "group", messageId: "om_g5", senderId: "ou_third", senderName: "小赵", fromApp: false, text: "这周发布吗", groupSpace: "team", gateOnly: true })!.id);
    expect(v).toMatchObject({ verdict: "answer" });
    expect(v?.answer).toBeUndefined();
  }, 60000);

  it("rules step aside for a message someone sent to the bot", async () => {
    const rule = saveRule(app, { name: "讨论群", description: "讨论群里的消息通知我", enabled: true, conditions: { field: "chat.name", op: "contains", value: "讨论" }, judge: "code", actions: [{ type: "notify", urgent: false }] });
    const e = (id: string): RuleEvent => ({ key: `lark:${id}`, kind: "message", at: new Date().toISOString(), chat: { id: "oc_team", name: "项目 A 讨论群", kind: "group" }, sender: { name: "小李", kind: "user" }, message: { id, text: "@omem 部署文档在哪", type: "text", mentionsOwner: false, mentionsBot: true, topicId: null, cardTitle: null }, via: "capture" });
    markAddressed(app, "lark:om_r1");
    await dispatchRuleEvent(app, e("om_r1"));
    expect(listFirings(app, rule.id)).toHaveLength(0);
    expect(claimedByRule(app, "lark:om_r1")).toBe(false);
    await dispatchRuleEvent(app, e("om_r2"));
    expect(listFirings(app, rule.id)).toHaveLength(1);
    expect(claimedByRule(app, "lark:om_r2")).toBe(true);
  });

  it("parses the commands", () => {
    expect(parseCommand(app, "/ai 帮我回一下")).toEqual({ kind: "ai", rest: "帮我回一下" });
    expect(parseCommand(app, "/AI帮我回一下")).toEqual({ kind: "ai", rest: "帮我回一下" });
    expect(parseCommand(app, "/ai")).toEqual({ kind: "ai", rest: "" });
    expect(parseCommand(app, "/ai拉群 排查登录问题")).toEqual({ kind: "group", rest: "排查登录问题" });
    expect(parseCommand(app, "/aide 是什么")).toBeNull();
    expect(parseCommand(app, "看看 /ai")).toBeNull();
  });

  it("/ai in a private chat: found once, answered in that chat as the owner, signed", async () => {
    app.config.lark.commands = { ...app.config.lark.commands, enabled: true };
    const now = Date.now();
    const sent: string[][] = [];
    setLarkCliForTests(async (args) => {
      if (args[0] === "auth") return { identities: { user: { openId: "ou_me" } } };
      if (args.includes("+messages-search"))
        return { data: { has_more: false, messages: [
          { message_id: "om_c1", chat_id: "oc_p2p", chat_name: "小王", msg_type: "text", content: "/ai 帮我回复他", create_time: String(now - 5000), sender: { id: "ou_me", name: "我" } },
          { message_id: "om_c0", chat_id: "oc_p2p", chat_name: "小王", msg_type: "text", content: "随便聊聊", create_time: String(now - 9000), sender: { id: "ou_me", name: "我" } },
        ] } };
      if (args.includes("+chat-messages-list"))
        return { data: { has_more: false, messages: [{ message_id: "om_q", chat_id: "oc_p2p", msg_type: "text", content: "登录一直报 401", create_time: String(now - 60_000), sender: { id: "ou_wang", name: "小王", sender_type: "user" } }] } };
      if (args.includes("+messages-send")) {
        sent.push(args);
        return { data: { message_id: "om_sent" } };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    expect(await pollOwnerCommands(app)).toBe(1);
    // The next look sees the same message again (search overlaps): handled once.
    expect(await pollOwnerCommands(app)).toBe(0);
    const row = one<{ id: string }>(app.db, "select id from runs where kind = 'lark-command'")!;
    const done = await waitForRun(app, row.id);
    expect(done.error).toBeNull();
    expect(sent).toHaveLength(1);
    const body = sent[0][sent[0].indexOf("--markdown") + 1];
    expect(sent[0]).toContain("--as");
    expect(sent[0][sent[0].indexOf("--as") + 1]).toBe("user");
    expect(sent[0][sent[0].indexOf("--chat-id") + 1]).toBe("oc_p2p");
    expect(body.endsWith("（此消息由 AI 代发）")).toBe(true);
    expect((getRun(app, row.id).output as { sent?: boolean }).sent).toBe(true);
    expect(all(app.db, "select id from runs where kind = 'lark-command'")).toHaveLength(1);
  }, 60000);

  it("/ai拉群: a group of the owner, the other person and the bot, where the bot carries on", async () => {
    const now = Date.now();
    const cli: string[][] = [];
    setLarkCliForTests(async (args) => {
      cli.push(args);
      if (args[0] === "auth") return { identities: { user: { openId: "ou_me" } } };
      if (args.includes("+chat-messages-list"))
        return { data: { has_more: false, messages: [{ message_id: "om_q2", chat_id: "oc_p2p", msg_type: "text", content: "登录一直报 401", create_time: String(now - 60_000), sender: { id: "ou_wang", name: "小王", sender_type: "user" } }] } };
      if (args.includes("+chat-create")) return { data: { chat_id: "oc_new" } };
      throw new Error(`unexpected ${args.join(" ")}`);
    });
    const posted: any[] = [];
    setLarkClient({ im: { message: { create: async (a: any) => (posted.push(a), { code: 0, data: { message_id: `om_b${posted.length}` } }) } } });
    app.config.lark.enabled = true;
    const r = createRun(app, { kind: "lark-command", title: "拉群", input: { kind: "group", chatId: "oc_p2p", chatName: "小王", messageId: "om_c2", text: "排查登录 401", at: now } });
    const done = await waitForRun(app, r.id);
    setLarkClient(null);
    expect(done.error).toBeNull();
    const create = cli.find((a) => a.includes("+chat-create"))!;
    expect(create[create.indexOf("--users") + 1]).toBe("ou_wang");
    expect(create[create.indexOf("--bots") + 1]).toBe("cli_bot");
    expect(create[create.indexOf("--name") + 1]).toBe("排查登录 401");
    // The bot speaks in the new group: an opening line, then the assistant's answer.
    expect(posted.map((p) => p.data.receive_id)).toEqual(["oc_new", "oc_new"]);
    // The private chat went in as context (the fake agent reports seeing it).
    expect(posted[1].data.content).toContain(String.raw`\"context\":true`);
    expect(cli.some((a) => a.includes("+messages-send"))).toBe(false);
  }, 60000);
});
