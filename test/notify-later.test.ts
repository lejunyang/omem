import { afterEach, expect, it } from "vitest";
import { one, run } from "../src/core/db.ts";
import { addNotificationSink, laterSlot, listNotifications, notify, releaseLater, type Notification } from "../src/core/notify.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

// Sinks are process-wide: one for the file, telling apart by the notification's own text.
const pushed: Notification[] = [];
addNotificationSink((n) => void pushed.push(n));
const sentIn = (mark: string) => pushed.filter((n) => n.title.includes(mark) || n.body.includes(mark));
const at = (h: number, m = 0) => new Date(2026, 10, 16, h, m);

function setup() {
  const app = testApp();
  apps.push(app);
  return app;
}

it("names the latest set time of day that has passed", () => {
  const app = setup();
  expect(laterSlot(app, at(8, 0))).toBeNull();
  expect(laterSlot(app, at(9, 30))).toBe("2026-11-16 09:30");
  expect(laterSlot(app, at(13, 29))).toBe("2026-11-16 09:30");
  expect(laterSlot(app, at(23, 59))).toBe("2026-11-16 18:30");
  app.config.notify.laterTimes = [];
  expect(laterSlot(app, at(12, 0))).toBeNull();
});

it("holds a later notification for the next set time; one or two then go out as they are", () => {
  const app = setup();
  const a = notify(app, { title: "A1 抽检报告", urgency: "later" });
  notify(app, { title: "A1 现在要看的", urgency: "normal" });
  expect(sentIn("A1").map((n) => n.title)).toEqual(["A1 现在要看的"]);
  // In the list at once, and unread on the web until it goes out.
  expect(listNotifications(app).find((n) => n.id === a.id)).toMatchObject({ held: 1, unread: true });
  // Before the first time of day: nothing; at it: sent as itself, once.
  expect(releaseLater(app, at(8, 0))).toBe(0);
  expect(releaseLater(app, at(9, 40))).toBe(1);
  expect(sentIn("A1").map((n) => [n.title, n.urgency])).toEqual([["A1 现在要看的", "normal"], ["A1 抽检报告", "normal"]]);
  expect(releaseLater(app, at(9, 55))).toBe(0);
  // The next one waits for the next time of day.
  notify(app, { title: "A1 第二份", urgency: "later" });
  expect(releaseLater(app, at(10, 30))).toBe(0);
  expect(releaseLater(app, at(13, 30))).toBe(1);
});

it("sends several as one list, and lets go of read and stale ones", () => {
  const app = setup();
  const made = ["B2 一", "B2 二", "B2 三", "B2 已读", "B2 太旧"].map((title) => notify(app, { title, urgency: "later" }));
  run(app.db, "update notifications set read_at = ? where id = ?", new Date().toISOString(), made[3].id);
  run(app.db, "update notifications set at = ? where id = ?", new Date(at(9, 0).getTime() - 3 * 86400_000).toISOString(), made[4].id);
  expect(releaseLater(app, at(18, 30))).toBe(3);
  const list = sentIn("B2");
  expect(list).toHaveLength(1);
  expect(list[0].title).toBe("这段时间的 3 条进展");
  expect(list[0].body).toContain("- B2 一\n- B2 二\n- B2 三");
  expect(list[0].bundle).toEqual(made.slice(0, 3).map((n) => n.id));
  // The listed ones count as delivered; none is held any more.
  const rows = listNotifications(app);
  for (const n of made.slice(0, 3)) expect(rows.find((r) => r.id === n.id)).toMatchObject({ unread: false, pushed: { channel: "bundle" } });
  expect(one<{ n: number }>(app.db, "select count(*) n from notifications where json_extract(context, '$.held') = 1")?.n).toBe(0);
});

it("sends later ones at once when no times are set, and never holds the newer state of a card already sent", () => {
  const app = setup();
  app.config.notify.laterTimes = [];
  notify(app, { title: "C3 直接发", urgency: "later" });
  expect(sentIn("C3")).toHaveLength(1);
  app.config.notify.laterTimes = ["09:30"];
  const first = notify(app, { title: "C3 待授权", urgency: "normal" });
  notify(app, { title: "C3 已授权", urgency: "later", replaces: first.id });
  expect(sentIn("C3").map((n) => n.title)).toEqual(["C3 直接发", "C3 待授权", "C3 已授权"]);
});

it("lets go at once when asked to (the owner just came out of a meeting), without using up the next time of day", () => {
  const app = setup();
  notify(app, { title: "E5 会上攒的", urgency: "later" });
  expect(releaseLater(app, at(8, 0))).toBe(0);
  expect(releaseLater(app, at(8, 5), { now: true })).toBe(1);
  expect(sentIn("E5").map((n) => n.title)).toEqual(["E5 会上攒的"]);
  // The 09:30 slot still works for what comes after.
  notify(app, { title: "E5 之后的", urgency: "later" });
  expect(releaseLater(app, at(9, 40))).toBe(1);
});

it("lets go of what was held once the times of day are cleared", () => {
  const app = setup();
  notify(app, { title: "D4 攒着的", urgency: "later" });
  expect(sentIn("D4")).toHaveLength(0);
  app.config.notify.laterTimes = [];
  expect(releaseLater(app, at(7, 0))).toBe(1);
  expect(sentIn("D4").map((n) => n.title)).toEqual(["D4 攒着的"]);
  expect(releaseLater(app, at(7, 5))).toBe(0);
});
