import { afterEach, expect, it, vi } from "vitest";
import { notificationCard } from "../src/channels/item-notification.ts";
import { sendLark, setLarkClient } from "../src/channels/lark-send.ts";
import { notify } from "../src/core/notify.ts";
import { upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
const fresh = () => { const app = testApp(); apps.push(app); return app; };
afterEach(() => {
  setLarkClient(null);
  for (const app of apps.splice(0)) app.db.close();
});

it("delivers a notification link as a URL button even when the body has no URL", async () => {
  const app = fresh();
  const link = "https://example.com/authorize?request=demo&region=cn";
  const n = notify(app, { title: "登录授权", body: "请打开链接完成授权。", link });
  const create = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_notice" } });
  setLarkClient({ im: { message: { create } } });
  await sendLark({ chatId: "oc_owner" }, { card: notificationCard(app, n) });
  const content = JSON.parse(create.mock.calls[0][0].data.content);
  expect(content.header.title.content).toBe(n.title);
  expect(content.body.elements[0].content).toBe(n.body);
  expect(content.body.elements[1].columns[0].elements[0]).toMatchObject({
    tag: "button", text: { content: "打开链接" },
    behaviors: [{ type: "open_url", default_url: link }],
  });
});

it.each([null, "#/runs/demo", "/runs/demo", "//example.com", "javascript:alert(1)", "file:///tmp/demo", "https://", "not a URL"])("does not emit unusable notification buttons for %s", (link) => {
  const app = fresh();
  const card = notificationCard(app, notify(app, { title: "通知", body: "正文", link }));
  expect(JSON.stringify(card)).not.toContain("open_url");
  expect(JSON.stringify(card)).toContain("正文");
});

it("keeps item actions and avoids repeating a link already in the item body", () => {
  const app = fresh();
  const item = upsertItem(app, undefined, { title: "确认方案" });
  const link = "https://example.com/plan";
  const n = notify(app, { title: item.title, body: "方案待确认", link, entityId: item.id });
  const card = JSON.stringify(notificationCard(app, n));
  expect(card).toContain(`item:done:${item.id}`);
  expect(card).toContain(`item:cancel:${item.id}`);
  expect(card).toContain('"default_url":"https://example.com/plan"');
  const repeated = JSON.stringify(notificationCard(app, { ...n, body: `[方案](${link})` }));
  expect(repeated.split(link)).toHaveLength(2);
  expect(repeated).not.toContain("open_url");
});

it("a flow progress card: bold line, long note folded, flow and next steps open, only the flow page button", () => {
  const app = fresh();
  app.config.webUrl = "https://omem.example.com";
  const item = upsertItem(app, undefined, { title: "评审退款改造" });
  const long = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段：${"核对退款回调和重试。".repeat(14)}`).join("\n\n");
  const body = `**「评审结论」卡住了，等你**\n\n${long}\n\n**流程**\n上下文 ✓ → **评审结论 卡住** → 挑问题\n\n**接下来**\n- 「评审结论」等你：在流程页写一句话让它重做，或直接标做完、跳过。`;
  const n = notify(app, { title: item.title, body, entityId: item.id, link: `#/items/${item.id}/flow`, view: "flow", tone: "warning" });
  const card = notificationCard(app, n) as { header: { template: string }; body: { elements: Record<string, unknown>[] } };
  const text = JSON.stringify(card);
  expect(card.header.template).toBe("orange");
  expect(text).not.toContain("item:done");
  expect(text).not.toContain("item:cancel");
  expect(text).toContain("打开流程页");
  const [first] = card.body.elements as { content?: string }[];
  expect(first.content).toMatch(/^\*\*「评审结论」卡住了，等你\*\*\n\n第 1 段/);
  expect(first.content).not.toContain("第 8 段");
  const fold = card.body.elements.find((e) => e.tag === "collapsible_panel");
  expect(JSON.stringify(fold)).toContain("第 8 段");
  const tail = card.body.elements.findIndex((e) => typeof e.content === "string" && (e.content as string).startsWith("**流程**"));
  expect(tail).toBeGreaterThan(card.body.elements.indexOf(fold!));
  expect(card.body.elements[tail].content).toContain("**接下来**");
});

it("holds a push back during quiet hours and gives it back once, unless it was read or is old", async () => {
  const { deferNotification, takeDeferred, markRead } = await import("../src/core/notify.ts");
  const { run } = await import("../src/core/db.ts");
  const app = fresh();
  const waiting = notify(app, { title: "分支评审要求修改：退款", body: "严重 1" });
  const read = notify(app, { title: "已经看过", body: "" });
  const old = notify(app, { title: "前天的", body: "" });
  for (const n of [waiting, read, old]) deferNotification(app, n.id);
  markRead(app, read.id);
  run(app.db, "update notifications set at = ? where id = ?", new Date(Date.now() - 2 * 86400_000).toISOString(), old.id);
  expect(takeDeferred(app).map((n) => n.title)).toEqual(["分支评审要求修改：退款"]);
  expect(takeDeferred(app)).toEqual([]);
});

it("lets a later notification stand for an earlier one: the earlier card is the one to edit", async () => {
  const { notificationCardOf, setNotificationCard } = await import("../src/core/notify.ts");
  const { one } = await import("../src/core/db.ts");
  const app = fresh();
  const asked = notify(app, { title: "飞书授权：读周报目录", body: "请打开链接完成授权。", link: "https://example.com/authorize" });
  setNotificationCard(app, asked.id, "om_auth", null);
  const done = notify(app, { title: "飞书授权已完成", body: "已恢复周报目录核对。", replaces: asked.id });
  expect(done.replaces).toBe(asked.id);
  expect(notificationCardOf(app, done.replaces!)).toEqual({ messageId: "om_auth", bot: null });
  const before = one<{ read_at: string | null; context: string }>(app.db, "select read_at, context from notifications where id = ?", asked.id)!;
  expect(before.read_at).toBeTruthy();
  expect(JSON.parse(before.context).replacedBy).toBe(done.id);
  expect(() => notify(app, { title: "别人的", body: "", replaces: "n_missing" })).toThrow(/没有可以更新的通知/);
});
