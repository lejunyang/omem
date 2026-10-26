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
