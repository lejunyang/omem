import { afterEach, describe, expect, it } from "vitest";
import { createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { cleanUpLarkIds, formatLine, learnPeople, sourceMessages, storeMessages } from "../src/channels/lark-messages.ts";
import { applyMentions, learnCliPeople, peopleByCliIds, rememberPerson, resolveMention } from "../src/channels/lark-people.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { one } from "../src/core/db.ts";
import { search } from "../src/search/search.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const A = "ou_" + "a".repeat(32);
const B = "ou_" + "b".repeat(32);
const C = "ou_" + "c".repeat(32);

/** lark-cli's contact search: its own open_ids → name and enterprise email. */
function fakeContacts(users: Record<string, { name: string; email: string }>) {
  const calls: string[][] = [];
  setLarkCliForTests(async (args) => {
    calls.push(args);
    if (args[0] === "contact" && args[1] === "+search-user") {
      const ids = args[args.indexOf("--user-ids") + 1].split(",");
      return { ok: true, data: { users: ids.filter((id) => users[id]).map((id) => ({ open_id: id, localized_name: users[id].name, enterprise_email: users[id].email })) } };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  });
  return calls;
}

/** The bot: email → user_id, and messages it sends. */
function fakeBot(userIds: Record<string, string>, opts: { noPermission?: boolean } = {}) {
  const sent: any[] = [];
  setLarkClient({
    contact: {
      user: {
        batchGetId: async ({ data }: any) => {
          if (opts.noPermission) throw Object.assign(new Error("403"), { response: { data: { code: 99991672, msg: "Access denied. contact:user.id:readonly" } } });
          return { code: 0, data: { user_list: data.emails.map((e: string) => ({ email: e, user_id: userIds[e] })) } };
        },
      },
    },
    im: { message: { create: async (args: any) => (sent.push(args), { code: 0, data: { message_id: "om_sent" } }) } },
  });
  return sent;
}

afterEach(() => {
  setLarkCliForTests(null);
  setLarkClient(null);
});

describe("people across Feishu apps", () => {
  it("learns names and emails for lark-cli's ids once, in batches", async () => {
    const app = testApp();
    const calls = fakeContacts({ [A]: { name: "小王", email: "wang@example.com" }, [B]: { name: "小李", email: "li@example.com" } });
    await learnCliPeople(app, [A, B, A]);
    await learnCliPeople(app, [A]);
    expect(calls).toHaveLength(1);
    expect(peopleByCliIds(app, [A, B]).get(B)).toMatchObject({ name: "小李", email: "li@example.com" });
  });

  it("resolves who to @ by name or email, and says which one when names repeat", async () => {
    const app = testApp();
    rememberPerson(app, { cliOpenId: A, name: "小王", email: "wang@example.com" });
    rememberPerson(app, { cliOpenId: B, name: "小李", email: "li1@example.com" });
    rememberPerson(app, { cliOpenId: C, name: "小李", email: "li2@example.com" });
    fakeBot({ "wang@example.com": "u_wang", "li2@example.com": "u_li2", "new@example.com": "u_new" });
    expect(await resolveMention(app, "小王")).toEqual({ name: "小王", userId: "u_wang", email: "wang@example.com" });
    // Remembered: no second lookup needed.
    expect(one(app.db, "select user_id from lark_people where email = 'wang@example.com'")).toEqual({ user_id: "u_wang" });
    await expect(resolveMention(app, "小李")).rejects.toThrow(/“小李”有 2 个人：小李（li1@example.com）、小李（li2@example.com）/);
    expect(await resolveMention(app, "li2@example.com")).toMatchObject({ userId: "u_li2" });
    expect(await resolveMention(app, "new@example.com")).toMatchObject({ userId: "u_new" });
    await expect(resolveMention(app, "陌生人")).rejects.toThrow(/给出邮箱/);
    expect(await resolveMention(app, "all")).toEqual({ all: true });
    fakeBot({}, { noPermission: true });
    await expect(resolveMention(app, "li1@example.com")).rejects.toThrow(/omem lark bot-permissions/);
  });

  it("writes mentions as text and card tags", () => {
    const p = { name: "小王", userId: "u_wang", email: "wang@example.com" };
    expect(applyMentions("@小王 看下这个", [p], "text")).toBe('<at user_id="u_wang">小王</at> 看下这个');
    expect(applyMentions("看下这个", [p, { all: true }], "text")).toBe('<at user_id="u_wang">小王</at> <at user_id="all"></at> 看下这个');
    expect(applyMentions("请 @wang@example.com 确认", [p], "card")).toBe("请 <at id=u_wang></at> 确认");
  });

  it("@s people through lark_send", async () => {
    const app = testApp();
    rememberPerson(app, { cliOpenId: A, name: "小王", email: "wang@example.com" });
    const sent = fakeBot({ "wang@example.com": "u_wang" });
    createThread(app, { spaceId: "personal", channel: "lark-watch", key: "oc_g" });
    const ctx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", larkChats: ["oc_g"] }))!;
    expect((await callTool(ctx, "lark_send", { chat_id: "oc_g", text: "@小王 发布清单好了吗", mentions: ["小王"] })).text).toMatch(/已发送/);
    expect(JSON.parse(sent[0].data.content).text).toBe('<at user_id="u_wang">小王</at> 发布清单好了吗');
    await callTool(ctx, "lark_send", { chat_id: "oc_g", markdown: "**提醒**", mentions: ["wang@example.com"] });
    expect(JSON.parse(sent[1].data.content).body.elements[0].content).toBe("<at id=u_wang></at> **提醒**");
  });

  it("keeps lark-cli's ids out of chat lines and shows emails on the page", async () => {
    const app = testApp();
    fakeContacts({ [A]: { name: "小王", email: "wang@example.com" }, [B]: { name: "小李", email: "li@example.com" } });
    const card = { message_id: "om_c", msg_type: "interactive", content: `<card title="待审批">\n提交人 @小王(${A})\n</card>`, create_time: String(Date.now()), sender: { id: "cli_x", name: "审批", sender_type: "app" } };
    const text = { message_id: "om_t", msg_type: "text", content: "@小李 看下", create_time: String(Date.now()), sender: { id: A, name: "小王" }, mentions: [{ id: B, key: "@_user_1", name: "小李" }] };
    const line = formatLine(card as never, {});
    expect(line).toContain("提交人 @小王");
    expect(line).not.toContain("ou_");
    const src = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_x", title: "群", text: [line, formatLine(text as never, {})].join("\n") });
    storeMessages(app, "oc_x", [card, text] as never, { sourceId: src.id, firstLine: 1 });
    await learnPeople(app, [card, text] as never);
    const view = sourceMessages(app, src.id);
    expect(view.messages[0].content).not.toContain("ou_");
    expect(view.messages[0].mentions).toEqual([{ name: "小王", email: "wang@example.com" }]);
    expect(view.messages[1].mentions).toEqual([{ name: "小李", email: "li@example.com" }]);
    // The stored row keeps the id.
    expect(one<{ content: string }>(app.db, "select content from lark_messages where message_id = 'om_c'")!.content).toContain(A);
  });

  it("cleans ids out of chats captured before, once", async () => {
    const app = testApp();
    fakeContacts({ [A]: { name: "小王", email: "wang@example.com" } });
    const src = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_old", title: "旧群", text: `[2026-10-10 10:00] 审批: <card> ⏎ @小王(${A}) 请审批 (om_1)\n[2026-10-10 10:01] 小王: 好 (om_2)` });
    storeMessages(app, "oc_old", [{ message_id: "om_1", msg_type: "interactive", content: `@小王(${A}) 请审批`, create_time: "1", sender: { id: "cli_x", sender_type: "app" } }] as never, {});
    expect((await search(app, A, { limit: 5 })).length).toBeGreaterThan(0);
    await cleanUpLarkIds(app);
    const text = one<{ text: string }>(app.db, "select text from sources where id = ?", src.id)!.text;
    expect(text).toBe("[2026-10-10 10:00] 审批: <card> ⏎ @小王 请审批 (om_1)\n[2026-10-10 10:01] 小王: 好 (om_2)");
    // Search no longer finds the id.
    expect(await search(app, A, { limit: 5 })).toEqual([]);
    expect((await search(app, "请审批", { limit: 5 })).length).toBeGreaterThan(0);
    expect(peopleByCliIds(app, [A]).get(A)?.email).toBe("wang@example.com");
  });
});
