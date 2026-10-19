import { afterEach, describe, expect, it } from "vitest";
import { describeLarkContent, firstDelivery, messageText } from "../src/channels/lark-bot.ts";
import { notificationOrigins } from "../src/channels/common.ts";
import { refExcerpt } from "../src/items/evidence.ts";
import { upsertSource } from "../src/sources/store.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { remember } from "../src/memory/store.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  for (const a of apps.splice(0)) a.db.close();
});
const fresh = () => {
  const app = testApp();
  apps.push(app);
  return app;
};
const look = (names: Record<string, string | null> = {}) => ({
  chatName: async (id: string) => names[id] ?? null,
  userName: async (id: string) => (id === "ou_w" ? "小王" : id),
  children: async () => [
    { sender: "小王", type: "text", content: JSON.stringify({ text: "接口周三给" }) },
    { sender: "小张", type: "post", content: JSON.stringify({ title: "", content: [[{ tag: "text", text: "收到" }]] }) },
  ],
});

describe("feishu bot message content", () => {
  it("names a shared group and says whether its messages are already captured", async () => {
    const app = fresh();
    const content = JSON.stringify({ chat_id: "oc_project" });
    const before = await describeLarkContent(app, { messageId: "om_1", type: "share_chat", content }, look({ oc_project: "项目 A 发布群" }));
    expect(before).toMatch(/「项目 A 发布群」chat_id=oc_project/);
    expect(before).toMatch(/set_lark_subscription/);
    const src = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_project", title: "项目 A 发布群", text: "[2026-10-19 10:00] 小王: 明天发版 (om_a)" });
    const after = await describeLarkContent(app, { messageId: "om_1", type: "share_chat", content }, look({ oc_project: "项目 A 发布群" }));
    expect(after).toContain(`(src:${src.id})`);
    // Unreadable group: still the id, never a bare placeholder.
    expect(await describeLarkContent(app, { messageId: "om_2", type: "share_chat", content }, look())).toMatch(/读不到群名.*oc_project/);
  });

  it("reads merged forwards, contact cards and quoted cards", async () => {
    const app = fresh();
    expect(await describeLarkContent(app, { messageId: "om_3", type: "merge_forward", content: "{}" }, look())).toBe("[合并转发] 2 条\n- 小王: 接口周三给\n- 小张: 收到");
    expect(await describeLarkContent(app, { messageId: "om_4", type: "share_user", content: JSON.stringify({ user_id: "ou_w" }) }, look())).toBe("[分享名片] 小王");
    const card = JSON.stringify({ title: null, elements: [[{ tag: "img", image_key: "img_1" }, { tag: "text", text: "请升级至最新版本客户端，以查看内容" }]] });
    expect(messageText(card, "interactive")).toBe("[卡片]");
    expect(messageText(JSON.stringify({ header: { title: { content: "周报" } }, elements: [{ tag: "markdown", content: "本周完成 3 项" }] }), "interactive")).toBe("[卡片] 周报 本周完成 3 项");
  });

  it("handles a redelivered event once, also after a restart", () => {
    const app = fresh();
    expect(firstDelivery(app, "om_x")).toBe(true);
    expect(firstDelivery(app, "om_x")).toBe(false);
    expect(firstDelivery(app, "om_y")).toBe(true);
  });
});

describe("reference excerpts", () => {
  it("shows what the cited lines say instead of 原文1/原文2", () => {
    const app = fresh();
    const chat = upsertSource(app, {
      spaceId: "personal",
      kind: "chat",
      uri: "lark:oc_p2p",
      title: "与 小王 的私聊",
      text: ["[2026-10-19 07:00] 小王: 你在吗 (om_1)", "[2026-10-19 07:02] 小王: 整理一份《差旅报销制度》的说明 ⏎ a. 适用范围 (om_2)"].join("\n"),
    });
    const doc = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "https://example.com/plan", title: "发布计划", text: "第一行\n周五发版" });
    expect(refExcerpt(app, `src:${chat.id}#L2-L2`)).toMatchObject({ title: "与 小王 的私聊", text: "小王: 整理一份《差旅报销制度》的说明 a. 适用范围" });
    expect(refExcerpt(app, "src:missing#L1")).toBeNull();
    const md = notificationOrigins(app, [`src:${doc.id}#L2-L2`, `src:${chat.id}#L1-L1`, `src:${chat.id}#L2-L2`]);
    // One link per final URL, labelled with the title, followed by the excerpts.
    expect(md).toContain("- [发布计划](https://example.com/plan)：「周五发版」");
    expect(md.match(/applink\.feishu\.cn/g)).toHaveLength(1);
    expect(md).toContain("「小王: 你在吗」 「小王: 整理一份《差旅报销制度》的说明 a. 适用范围」");
    expect(md).not.toMatch(/原文\d/);
  });
});

describe("read_source for msg: and mem: refs", () => {
  it("reads conversation messages and memories instead of looking them up as sources", async () => {
    const app = testApp();
    apps.push(app);
    const thread = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
    const id = addMessage(app, thread.id, "user", "用 osdk 下的 lark-cli，不要 .ai-devbox 的", null, {});
    const mem = remember(app, { spaceId: "personal", kind: "fact", content: "lark-cli 用 osdk 的", sourceRefs: [`msg:${id}`] });
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
    expect((await callTool(ctx, "read_source", { source: `msg:${id}` })).text).toContain("用 osdk 下的 lark-cli");
    expect((await callTool(ctx, "read_source", { source: id })).text).toContain("用 osdk 下的 lark-cli"); // bare msg id also works
    const memText = (await callTool(ctx, "read_source", { source: `mem:${mem.id}` })).text;
    expect(memText).toContain("lark-cli 用 osdk 的");
    expect(memText).toContain(`msg:${id}`);
    await expect(callTool(ctx, "read_source", { source: "msg_nope" })).resolves.toMatchObject({ isError: true });
  });
});
