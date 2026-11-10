import { afterEach, expect, it } from "vitest";
import { one, run } from "../src/core/db.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { forgetChatBots } from "../src/rules/engine.ts";
import { forwardAction } from "../src/rules/forward.ts";
import { getRule, saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { OWNER } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

afterEach(() => { setLarkClient(null); setLarkCliForTests(null); });

const event = (over: Partial<RuleEvent> = {}): RuleEvent => ({
  key: "lark:om_src", kind: "message", at: "2026-11-09T08:00:00Z",
  chat: { id: "oc_vnumber", name: "虚拟号通知", kind: "p2p" },
  sender: { id: "ou_bot", name: "虚拟号通知", kind: "bot" },
  message: { id: "om_src", text: "账号 A 的虚拟号已换绑", type: "text", mentionsOwner: false, mentionsBot: false, topicId: null, cardTitle: null },
  via: "capture", ...over,
});

function setup() {
  const app = testApp();
  app.config.lark.enabled = true; app.config.lark.appId = "cli_bot";
  const sent: { chat: string; text: string; uuid?: string }[] = [];
  const cli: string[][] = [];
  setLarkClient({ im: { message: { create: async ({ data }: any) => { sent.push({ chat: data.receive_id, text: data.content, uuid: data.uuid }); return { code: 0, data: { message_id: `om_${sent.length}` } }; } } } });
  return { app, sent, cli };
}

it("forwards to a group, adding the bot as the owner only when it is not there", async () => {
  const { app, sent, cli } = setup();
  try {
    let botIn = false;
    setLarkCliForTests(async (args) => {
      cli.push(args);
      if (args.includes("+chat-members-list")) return { data: { bots: botIn ? [{ app_id: "cli_bot", name: "omem" }] : [] } };
      if (args.includes("chat.members")) { botIn = true; return { data: {} }; }
      return {};
    });
    const rule = saveRule(app, { name: "虚拟号转群", description: "虚拟号通知转到值班群", enabled: true, conditions: { field: "chat.name", op: "contains", value: "虚拟号" }, judge: "code", actions: [{ type: "forward", to: { chatId: "oc_duty", name: "值班群", kind: "group" }, note: "请值班同学看下" }] } as never, "user", OWNER);
    const r = await forwardAction(app, rule, rule.actions[0] as never, event());
    expect(r.detail).toContain("已用你的身份把机器人拉进「值班群」");
    expect(cli.some((a) => a.includes("chat.members") && a.includes("user"))).toBe(true);
    expect(sent[0].chat).toBe("oc_duty");
    expect(sent[0].text).toMatch(/转发自私聊「虚拟号通知」[\s\S]*请值班同学看下[\s\S]*虚拟号已换绑/);
    // Next time the bot is there: no invite.
    forgetChatBots("oc_duty"); cli.length = 0;
    const again = await forwardAction(app, rule, rule.actions[0] as never, event({ key: "lark:om_2", message: { ...event().message!, id: "om_2" } }));
    expect(again.detail).not.toContain("拉进");
    expect(cli.some((a) => a.includes("chat.members"))).toBe(false);
    expect(sent[1].uuid).not.toBe(sent[0].uuid);
  } finally { app.db.close(); }
});

it("forwards to a person through a group made once with them and the bot", async () => {
  const { app, sent, cli } = setup();
  try {
    run(app.db, "insert into lark_messages(message_id, chat_id, sender_id, sender_name, sender_kind, msg_type, content, create_ms, mentions) values('om_p','oc_wang','ou_wang','小王','user','text','在吗',1,'[]')");
    setLarkCliForTests(async (args) => { cli.push(args); return args.includes("+chat-create") ? { data: { chat_id: "oc_made" } } : {}; });
    const rule = saveRule(app, { name: "转给小王", description: "虚拟号通知转给小王", enabled: true, conditions: { field: "chat.name", op: "contains", value: "虚拟号" }, judge: "code", actions: [{ type: "forward", to: { chatId: "oc_wang", name: "小王", kind: "p2p" }, note: "" }] } as never, "user", OWNER);
    const first = await forwardAction(app, rule, rule.actions[0] as never, event());
    expect(first.detail).toContain("已用你的身份建群");
    const create = cli.find((a) => a.includes("+chat-create"))!;
    expect(create).toEqual(expect.arrayContaining(["--as", "user", "--users", "ou_wang", "--bots", "cli_bot"]));
    await forwardAction(app, rule, rule.actions[0] as never, event({ message: { ...event().message!, id: "om_3" } }));
    expect(cli.filter((a) => a.includes("+chat-create"))).toHaveLength(1);
    expect(sent.map((s) => s.chat)).toEqual(["oc_made", "oc_made"]);
  } finally { app.db.close(); }
});

it("only the owner picks where a rule forwards to, and only message rules forward", () => {
  const app = testApp();
  try {
    const rule = { name: "转发", description: "x", enabled: true, conditions: { field: "chat.name", op: "contains", value: "虚拟号" }, judge: "code", actions: [{ type: "forward", to: { chatId: "oc_duty", name: "值班群", kind: "group" }, note: "" }] } as never;
    expect(() => saveRule(app, rule, "agent")).toThrow(/本人亲自指定/);
    const saved = saveRule(app, rule, "user", OWNER);
    // An agent may edit the rule as long as the target stays.
    expect(saveRule(app, { ...(rule as object), id: saved.id, description: "改了说明" } as never, "agent").description).toBe("改了说明");
    expect(() => saveRule(app, { ...(rule as object), id: saved.id, actions: [{ type: "forward", to: { chatId: "oc_other", name: "别的群", kind: "group" }, note: "" }] } as never, "agent")).toThrow(/本人亲自指定/);
    expect(getRule(app, saved.id).actions[0]).toMatchObject({ to: { chatId: "oc_duty" } });
    expect(() => saveRule(app, { ...(rule as object), trigger: { event: "schedule", cron: "0 9 * * *" }, conditions: null } as never, "user", OWNER)).toThrow(/新消息/);
  } finally { app.db.close(); }
});

it("in the owner's own message in a group, the assistant may set a rule forwarding to that group", async () => {
  const { callTool, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
  const { createRun } = await import("../src/agents/runs.ts");
  const { createThread, addMessage } = await import("../src/agents/threads.ts");
  const app = testApp();
  try {
    run(app.db, "insert into lark_cursors(chat_id, name, chat_mode) values('oc_here','值班群','group')");
    const t = createThread(app, { channel: "lark", key: "oc_here", spaceId: "personal", userId: "owner" });
    const rule = { name: "虚拟号转群", description: "虚拟号通知私聊我的消息转到这个群", enabled: false, rule: { trigger: { event: "message" }, judge: "code", conditions: { field: "chat.name", op: "contains", value: "虚拟号" }, actions: [{ type: "forward", to: { chatId: "current" }, note: "" }] } };
    const turn = (messageIds: string[]) => {
      const r = createRun(app, { kind: "ask", title: "x", input: { conversationId: t.id, messageIds }, lane: `hold-${messageIds.length}`, notBefore: "2999-01-01T00:00:00Z" });
      return toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "assistant" } as never))!;
    };
    // A wake-up (no owner message in the turn): refused.
    expect((await callTool(turn([]), "save_rule", rule)).text).toMatch(/本人亲自指定/);
    const said = addMessage(app, t.id, "user", "以后虚拟号通知私聊我的消息都转到这个群", null, {});
    const out = await callTool(turn([said]), "save_rule", rule);
    expect(out.isError).toBe(false);
    const { listRules } = await import("../src/rules/store.ts");
    expect(listRules(app)[0].actions[0]).toMatchObject({ type: "forward", to: { chatId: "oc_here", name: "值班群", kind: "group" } });
  } finally { app.db.close(); }
});

it("“this group” in a rule's conditions becomes the Feishu chat the owner is talking in", async () => {
  const { callTool, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
  const { createRun } = await import("../src/agents/runs.ts");
  const { createThread } = await import("../src/agents/threads.ts");
  const { listRules } = await import("../src/rules/store.ts");
  const { currentChatIn } = await import("../src/rules/conditions.ts");
  const app = testApp();
  try {
    const ctxIn = (channel: string, key: string) => {
      const t = createThread(app, { channel, key, spaceId: "personal", userId: "owner" });
      const r = createRun(app, { kind: "ask", title: "x", input: { conversationId: t.id }, lane: `hold-${key}`, notBefore: "2999-01-01T00:00:00Z" });
      return toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", role: "assistant" } as never))!;
    };
    const rule = { description: "这个群里有人 @ 我就通知我", rule: { trigger: { event: "message" }, judge: "code", conditions: { all: [{ field: "chat.id", op: "equals", value: "current" }, { field: "message.mentionsOwner", op: "is", value: true }] }, actions: [{ type: "notify" }] } };
    const group = ctxIn("lark", "oc_team#om_topic");
    expect((await callTool(group, "save_rule", { ...rule, name: "群里 @ 我" })).isError).toBe(false);
    const saved = listRules(app)[0];
    expect(saved.conditions).toEqual({ all: [{ field: "chat.id", op: "equals", value: "oc_team" }, { field: "message.mentionsOwner", op: "is", value: true }] });
    // Replies (发到) go back to this group's conversation, also for a document rule made here.
    const here = saved.conversationId!;
    expect(one<{ external_id: string }>(app.db, "select external_id from conversations where id = ?", here)!.external_id).toBe("oc_team#om_topic");
    const sheetRule = { description: "排期表有别人新加的行就在这个群里 @ 修改人", rule: { conversationId: "current", trigger: { event: "doc", docs: ["https://tenant.larkoffice.com/sheets/SheetTok"] }, judge: "code", conditions: { field: "change.byOwner", op: "is", value: false }, actions: [{ type: "agent", reply: "auto", task: "回到群里对应的消息下 @ 修改人" }] } };
    expect((await callTool(group, "save_rule", { ...sheetRule, name: "排期表新行" })).isError).toBe(false);
    expect(listRules(app).find((r) => r.name === "排期表新行")!.conversationId).toBe(here);
    // Not a Feishu conversation: no “this group”.
    const web = await callTool(ctxIn("web", "w1"), "save_rule", { ...rule, name: "网页里" });
    expect(web.text).toMatch(/不是飞书会话/);
    // Inside an `in` list too; other fields are left alone.
    expect(currentChatIn({ any: [{ field: "chat.id", op: "in", value: ["oc_a", "current"] }, { field: "chat.name", op: "equals", value: "current" }] }, "oc_b")).toEqual({ any: [{ field: "chat.id", op: "in", value: ["oc_a", "oc_b"] }, { field: "chat.name", op: "equals", value: "current" }] });
  } finally { app.db.close(); }
});
