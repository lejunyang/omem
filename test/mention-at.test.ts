import { afterEach, expect, it } from "vitest";
import { atAsker } from "../src/channels/mention-reply.ts";
import { realMentions } from "../src/channels/lark-people.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { setLarkClient(null); for (const app of apps.splice(0)) app.db.close(); });

it("@s the asker once: the handler's own “@名字” becomes the real mention, otherwise one goes in front", () => {
  expect(atAsker("@小王 这个口径对上了", "小王", "ou_w")).toBe("<at id=ou_w></at> 这个口径对上了");
  expect(atAsker("对上了，辛苦 @小王 带一下", "小王", "ou_w")).toBe("对上了，辛苦 <at id=ou_w></at> 带一下");
  expect(atAsker("这个口径对上了", "小王", "ou_w")).toBe("<at id=ou_w></at> 这个口径对上了");
  expect(atAsker("<at id=ou_w></at> 好", "小王", "ou_w")).toBe("<at id=ou_w></at> 好");
  expect(atAsker("@小王 好", "小王", null)).toBe("@小王 好");
});

it("every @名字 the bot posts into a group becomes a real mention when the person is known or in the chat", async () => {
  const app = testApp(); apps.push(app);
  const members = [{ member_id: "ou_yf", name: "一帆" }, { member_id: "ou_li", name: "小李" }];
  let scans = 0;
  setLarkClient({ im: { chatMembers: { get: async () => (scans++, { code: 0, data: { items: members, has_more: false } }) } } });
  const text = "@小王 查过了。@一帆 确认下今天按 30% 还是 50%，@小李确认下管理员时间；@路人甲 不在群里。再提一次 @一帆。";
  const out = await realMentions(app, text, "oc_team", { 小王: "ou_w" });
  expect(out).toBe("<at id=ou_w></at> 查过了。<at id=ou_yf></at> 确认下今天按 30% 还是 50%，<at id=ou_li></at>确认下管理员时间；@路人甲 不在群里。再提一次 一帆。");
  expect(scans).toBeGreaterThan(0);
  // No chat (a private chat): only the people already known.
  expect(await realMentions(app, "@小王 和 @一帆", null, { 小王: "ou_w" })).toBe("<at id=ou_w></at> 和 @一帆");
});

it("sendLark turns @名字 into real mentions for every path, and leaves code and emails alone", async () => {
  const app = testApp(); apps.push(app);
  const { sendLark, setMentionResolver } = await import("../src/channels/lark-send.ts");
  const sent: string[] = [];
  setLarkClient({ im: {
    chatMembers: { get: async () => ({ code: 0, data: { items: [{ member_id: "ou_yq", name: "杨祺" }], has_more: false } }) },
    message: { create: async ({ data }: any) => (sent.push(data.content), { code: 0, data: { message_id: "om_1" } }) },
  } });
  setMentionResolver((md, where) => realMentions(app, md, where.chatId ?? null));
  try {
    await sendLark({ chatId: "oc_team" }, { markdown: "@杨祺 申请单已取消。写法见 `@Component`，邮件发 a@杨祺.com" });
    expect(sent[0]).toContain("<at id=ou_yq></at> 申请单已取消");
    expect(sent[0]).toContain("`@Component`");
    expect(sent[0]).toContain("a@杨祺.com");
  } finally {
    setMentionResolver(null);
  }
});
