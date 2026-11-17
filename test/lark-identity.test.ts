import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { contextLines } from "../src/channels/lark-bots.ts";
import { readChatHistory } from "../src/channels/lark-bot-history.ts";
import { claimLarkSender } from "../src/channels/lark-identity.ts";
import { rememberPerson } from "../src/channels/lark-people.ts";
import { setLarkBotClient } from "../src/channels/lark-send.ts";
import { all, one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createUser, resolveIdentity } from "../src/core/users.ts";
import { sourceText, upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const CLI = "ou_" + "1".repeat(32);
const BOT = "ou_" + "2".repeat(32);
const OTHER = "ou_" + "3".repeat(32);

/** The bot's directory: its open_ids → person, emails → user_id; a chat's messages for im.message.list. */
function fakeBot(opts: { people?: Record<string, { name: string; email?: string; user_id?: string }>; ids?: Record<string, string>; messages?: any[]; calls?: string[] }) {
  const calls = opts.calls ?? [];
  const client = {
    contact: {
      user: {
        get: async ({ path }: any) => (calls.push(`get ${path.user_id}`), { code: 0, data: { user: opts.people?.[path.user_id] ? { ...opts.people[path.user_id], enterprise_email: opts.people[path.user_id].email } : undefined } }),
        batchGetId: async ({ data }: any) => (calls.push(`ids ${data.emails.join(",")}`), { code: 0, data: { user_list: data.emails.map((e: string) => ({ email: e, user_id: opts.ids?.[e] })) } }),
      },
    },
    im: {
      message: {
        list: async ({ params }: any) => (calls.push(`list ${params.container_id_type} ${params.container_id}`), { code: 0, data: { items: [...(opts.messages ?? [])].reverse(), has_more: false } }),
      },
    },
  };
  return { client, calls };
}

afterEach(() => setLarkBotClient("main", null));

describe("one person across the two Feishu apps", () => {
  it("merges lark-cli's row (email) and the bot's row (open_id, user_id) once a fact ties them", () => {
    const app = testApp();
    rememberPerson(app, { cliOpenId: CLI, name: "小王", email: "wang@example.com" });
    rememberPerson(app, { botOpenId: BOT, userId: "u_wang", name: "小王" });
    expect(all(app.db, "select * from lark_people")).toHaveLength(2);
    // The bot reads the email: one row with both open_ids.
    rememberPerson(app, { botOpenId: BOT, email: "Wang@Example.com", name: "小王" });
    expect(all(app.db, "select email, cli_open_id, bot_open_id, user_id from lark_people")).toEqual([{ email: "wang@example.com", cli_open_id: CLI, bot_open_id: BOT, user_id: "u_wang" }]);
  });

  it("keeps rows that contradict each other apart", () => {
    const app = testApp();
    rememberPerson(app, { cliOpenId: CLI, email: "a@example.com", name: "小李" });
    rememberPerson(app, { botOpenId: BOT, email: "b@example.com", name: "小李" });
    rememberPerson(app, { botOpenId: BOT, cliOpenId: CLI, name: "小李" });
    expect(all(app.db, "select email from lark_people order by email")).toEqual([{ email: "a@example.com" }, { email: "b@example.com" }]);
  });
});

describe("an account added by email or name takes the bot's open_id on first use", () => {
  it("by the directory email", async () => {
    const app = testApp();
    const u = createUser(app, { name: "小王", email: "wang@example.com" });
    const { client } = fakeBot({ people: { [BOT]: { name: "小王", email: "wang@example.com", user_id: "u_wang" } } });
    expect(await claimLarkSender(app, client, { openId: BOT })).toBe(u.id);
    expect(resolveIdentity(app, "lark", BOT)).toBe(u.id);
    expect(one<{ action: string }>(app.db, "select action from audit_events where target = ?", u.id)?.action).toBe("lark.identity.claim");
  });

  it("by the user_id the account's email has, when the bot cannot read emails", async () => {
    const app = testApp();
    const u = createUser(app, { name: "小王", email: "wang@example.com" });
    const { client } = fakeBot({ people: { [BOT]: { name: "小王", user_id: "u_wang" } }, ids: { "wang@example.com": "u_wang" } });
    expect(await claimLarkSender(app, client, { openId: BOT, userId: "u_wang" })).toBe(u.id);
  });

  it("by name for an account without an email, only when one account has it", async () => {
    const app = testApp();
    const u = createUser(app, { name: "小张" });
    const { client } = fakeBot({ people: { [BOT]: { name: "小张" } } });
    expect(await claimLarkSender(app, client, { openId: BOT, name: "小张" })).toBe(u.id);
    createUser(app, { name: "小赵" }); createUser(app, { name: "小赵" });
    const two = fakeBot({ people: { [OTHER]: { name: "小赵" } } });
    expect(await claimLarkSender(app, two.client, { openId: OTHER, name: "小赵" })).toBeNull();
    expect(resolveIdentity(app, "lark", OTHER)).toBeNull();
  });

  it("a real guest is looked up once until the accounts change", async () => {
    const app = testApp();
    const calls: string[] = [];
    const { client } = fakeBot({ people: { [BOT]: { name: "访客" } }, calls });
    expect(await claimLarkSender(app, client, { openId: BOT })).toBeNull();
    expect(await claimLarkSender(app, client, { openId: BOT })).toBeNull();
    expect(calls.filter((c) => c.startsWith("get"))).toHaveLength(1);
    const u = createUser(app, { name: "访客" });
    expect(await claimLarkSender(app, client, { openId: BOT })).toBe(u.id);
  });
});

describe("context before a mention", () => {
  const lines = [
    "[2026-01-01 10:00 · 话题 omt_a] 小王: 退款失败了，订单 123 (om_1)",
    ...Array.from({ length: 20 }, (_, i) => `[2026-01-01 11:${String(i).padStart(2, "0")}] 小李: 别的事 ${i} (om_x${i})`),
    "[2026-01-01 12:00 · 话题 omt_a] 小王: 看下这个 (om_2)",
  ];
  it("keeps the topic's first message and the chat's latest lines; only an isolated topic sees just its own", () => {
    const open = contextLines(lines, "omt_a", false);
    expect(open[0]).toContain("退款失败了");
    expect(open.some((l) => l.includes("别的事 19"))).toBe(true);
    expect(contextLines(lines, "omt_a", true)).toEqual([lines[0], lines.at(-1)]);
  });
});

describe("the bot reads earlier messages itself", () => {
  const message = (id: string, text: string, thread?: string) => ({ message_id: id, msg_type: "text", create_time: String(Date.parse("2026-01-01T10:00:00Z") + Number(id.slice(3)) * 60000), thread_id: thread, sender: { id: BOT, sender_type: "user" }, body: { content: JSON.stringify({ text }) } });
  it("records them in the chat's source with citable lines", async () => {
    const app = testApp();
    rememberPerson(app, { botOpenId: BOT, name: "小王" });
    const { client, calls } = fakeBot({ messages: [message("om_1", "退款失败了，订单 123", "omt_a"), message("om_2", "看下这个", "omt_a")] });
    const page = await readChatHistory(app, client, { chatId: "oc_" + "a".repeat(32), topicId: "omt_a", chatName: "示例群" });
    expect(calls).toEqual([`list thread omt_a`]);
    expect(page.lines.map((l) => l.line)).toEqual([1, 2]);
    expect(sourceText(app, page.sourceId!)).toContain("小王: 退款失败了，订单 123");
  });

  it("a guest run reads only the chat it was asked in, within the spaces it may read", async () => {
    const app = testApp();
    createSpace(app, { id: "shop", name: "示例商城", kind: "project" });
    const chat = "oc_" + "b".repeat(32);
    upsertSource(app, { spaceId: "shop", uri: `lark:${chat}`, title: "示例群", kind: "chat", text: "" });
    const { client } = fakeBot({ messages: [message("om_1", "退款失败了")] });
    setLarkBotClient("main", client as never);
    const r = createRun(app, { kind: "guest", spaceId: "shop", title: "访客", input: { chatId: chat, spaces: ["shop"] } });
    const ctx = toolContextForToken(app, issueToolToken({ runId: r.id, spaceId: "shop", spaces: ["shop"], tools: null, actor: "agent", userId: "owner" }))!;
    const out = await callTool(ctx, "lark_chat_history", {});
    expect(out.isError).toBeFalsy();
    expect(JSON.stringify(out)).toContain("退款失败了");
    expect((await callTool(ctx, "lark_chat_history", { chat_id: "oc_" + "c".repeat(32) })).isError).toBe(true);
  });
});
