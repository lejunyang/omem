import { afterAll, expect, it } from "vitest";
import { dueReminders, listItems, upsertItem } from "../src/items/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
afterAll(() => app.db.close());

it("fires a reminder written with the owner's offset at that moment, not hours later", () => {
  // 15 minutes before a 17:00 meeting in UTC+8: 08:45 UTC.
  const item = upsertItem(app, undefined, { kind: "reminder", title: "参加评审会", dueAt: "2026-10-28T17:00:00+08:00", remindAt: "2026-10-28T16:45:00+08:00" });
  const due = (at: string) => dueReminders(app, at).some((i) => i.id === item.id);
  expect(due("2026-10-28T08:30:00.000Z")).toBe(false);
  expect(due("2026-10-28T08:45:00.000Z")).toBe(true);
  // A time west of UTC is not early either.
  const west = upsertItem(app, undefined, { kind: "reminder", title: "west", remindAt: "2026-10-28T08:00:00-05:00" });
  expect(dueReminders(app, "2026-10-28T12:59:00.000Z").some((i) => i.id === west.id)).toBe(false);
  expect(dueReminders(app, "2026-10-28T13:00:00.000Z").some((i) => i.id === west.id)).toBe(true);
  // Stored as written: agents read the owner's time back.
  expect(listItems(app, {}).find((i) => i.id === item.id)?.remindAt).toBe("2026-10-28T16:45:00+08:00");
});

it("orders open items by the actual moment of their due time", () => {
  const early = upsertItem(app, undefined, { kind: "todo", title: "早", priority: 2, dueAt: "2026-11-01T09:00:00+08:00" });
  const late = upsertItem(app, undefined, { kind: "todo", title: "晚", priority: 2, dueAt: "2026-11-01T03:00:00Z" });
  const ids = listItems(app, {}).map((i) => i.id);
  expect(ids.indexOf(early.id)).toBeLessThan(ids.indexOf(late.id));
});
