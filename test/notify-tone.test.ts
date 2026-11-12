import { afterEach, expect, it } from "vitest";
import { notify } from "../src/core/notify.ts";
import { notificationCard } from "../src/channels/item-notification.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

const color = (card: unknown) => (card as { header?: { template?: string } }).header?.template;

it("a card waiting on the owner is orange, and turns green once updated as settled", () => {
  const app = testApp(); apps.push(app);
  const asked = notify(app, { title: "某工具需要授权", body: "打开链接登录", tone: "warning" });
  expect(color(notificationCard(app, asked))).toBe("orange");
  // Updated without a tone: an update of a warning card means it is settled.
  const done = notify(app, { title: "某工具已授权", body: "已恢复查询", replaces: asked.id });
  expect(done.tone).toBe("done");
  expect(color(notificationCard(app, done))).toBe("green");
  // Still waiting: it says so.
  const again = notify(app, { title: "某工具需要授权", body: "链接过期，重新登录", tone: "warning" });
  expect(notify(app, { title: "还在等授权", body: "", replaces: again.id, tone: "warning" }).tone).toBe("warning");
  // Plain notifications keep the default look.
  expect(color(notificationCard(app, notify(app, { title: "普通提醒", body: "x" })))).toBe("blue");
});
