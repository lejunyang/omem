import { afterEach, expect, it } from "vitest";
import { all, run } from "../src/core/db.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { pollFastRules, textWords, waitMatches, waitThenAct } from "../src/rules/fast.ts";
import { saveRule } from "../src/rules/store.ts";
import { OWNER } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

afterEach(() => { setLarkClient(null); setLarkCliForTests(null); });

const at = (ms: number) => new Date(ms).toISOString();

it("asked for a code in a private chat, waits for the code bot and sends the new code back in a group with the asker", async () => {
  const app = testApp();
  app.config.lark.enabled = true; app.config.lark.appId = "cli_bot";
  run(app.db, "insert into lark_cursors(chat_id, name, chat_mode) values('oc_codes','虚拟号通知','p2p')");
  const t0 = Date.now();
  const cli: string[][] = [];
  let codeArrived = false;
  setLarkCliForTests(async (args) => {
    cli.push(args);
    if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_owner" } } } };
    if (args.includes("+messages-search")) {
      const p2p = args.includes("p2p");
      // The colleague's request (private chat); the search for group @s finds nothing.
      return { data: { has_more: false, messages: p2p ? [{ message_id: "om_ask", chat_id: "oc_wang", msg_type: "text", content: JSON.stringify({ text: "能给我一下验证码吗" }), create_time: String(t0), sender: { id: "ou_wang", name: "小王", sender_type: "user" } }] : [] } };
    }
    if (args.includes("+chat-messages-list")) {
      // The code bot: an old code (before the request) and, a moment later, the new one.
      const old = { message_id: "om_old", chat_id: "oc_codes", msg_type: "text", content: JSON.stringify({ text: "验证码 1111" }), create_time: String(t0 - 120_000), sender: { id: "cli_codes", sender_type: "app", name: "虚拟号通知" } };
      const fresh = { message_id: "om_code", chat_id: "oc_codes", msg_type: "text", content: JSON.stringify({ text: "验证码 4006，请勿泄露" }), create_time: String(t0 + 5_000), sender: { id: "cli_codes", sender_type: "app", name: "虚拟号通知" } };
      const msgs = codeArrived ? [old, fresh] : [old];
      codeArrived = true;
      return { data: { has_more: false, messages: msgs } };
    }
    if (args.includes("+chat-create")) return { data: { chat_id: "oc_with_wang" } };
    return {};
  });
  const sent: { chat?: string; text: string }[] = [];
  setLarkClient({ im: { message: { create: async ({ data }: any) => (sent.push({ chat: data.receive_id, text: data.content }), { code: 0, data: { message_id: "om_sent" } }) } } });
  try {
    const rule = saveRule(app, {
      name: "验证码", description: "有人私聊或 @ 我要验证码，等虚拟号通知的新验证码发给他", enabled: true,
      trigger: { event: "message", fast: true },
      conditions: { all: [{ any: [{ field: "chat.kind", op: "equals", value: "p2p" }, { field: "message.mentionsOwner", op: "is", value: true }] }, { field: "message.text", op: "contains", value: "验证码" }, { field: "sender.kind", op: "equals", value: "user" }] },
      judge: "code",
      actions: [{ type: "wait-message", chatId: "oc_codes", name: "虚拟号通知", minutes: 1, contains: "验证码" }, { type: "forward", to: { kind: "origin" }, note: "" }],
    } as never, "user", OWNER);
    expect(textWords(rule.conditions)).toEqual(["验证码"]);
    expect(await pollFastRules(app)).toBe(1);
    // The search asked for what the rule looks for.
    expect(cli.find((a) => a.includes("+messages-search"))).toEqual(expect.arrayContaining(["--query", "验证码"]));
    const [wait] = all<{ id: string; input: string }>(app.db, "select id, input from runs where kind = 'rule-fire'");
    const input = JSON.parse(wait.input);
    expect(input.wait).toMatchObject({ chatId: "oc_codes" });
    const r = await waitThenAct(app, input);
    expect(r.summary).toContain("已发到和 小王 的群");
    expect(cli.find((a) => a.includes("+chat-create"))).toEqual(expect.arrayContaining(["--users", "ou_wang", "--bots", "cli_bot"]));
    expect(sent).toHaveLength(1);
    expect(sent[0].chat).toBe("oc_with_wang");
    expect(sent[0].text).toContain("4006");
    expect(sent[0].text).not.toContain("1111");
    // The same request seen again (the capture, the next search) is not fired twice.
    expect(await pollFastRules(app)).toBe(1);
    expect(all(app.db, "select id from runs where kind = 'rule-fire'")).toHaveLength(1);
  } finally { app.db.close(); }
}, 30_000);

it("matches a wait step's words or pattern, and checks the rule before saving", () => {
  expect(waitMatches({ contains: "验证码", matches: "" }, "验证码 4006")).toBe(true);
  expect(waitMatches({ contains: "", matches: "\\d{4,6}" }, "你的码是 123")).toBe(false);
  const app = testApp();
  try {
    const base = { name: "x", description: "x", enabled: true, conditions: { field: "message.text", op: "contains", value: "验证码" }, judge: "code" };
    expect(() => saveRule(app, { ...base, actions: [{ type: "wait-message", chatId: "oc_codes" }] } as never, "user", OWNER)).toThrow(/后面要有动作/);
    expect(() => saveRule(app, { ...base, actions: [{ type: "wait-message", chatId: "oc_codes", matches: "(" }, { type: "notify" }] } as never, "user", OWNER)).toThrow(/正则/);
    expect(() => saveRule(app, { ...base, actions: [{ type: "forward", to: { kind: "origin" } }] } as never, "agent")).toThrow(/本人亲自指定/);
    void at;
  } finally { app.db.close(); }
});
