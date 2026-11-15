import { afterEach, expect, it } from "vitest";
import { configSchema } from "../src/core/config.ts";
import { inQuietHours, laterSlot } from "../src/core/notify.ts";
import { systemZone, validZone, zoneMidnight, zonedParts } from "../src/core/util.ts";
import { dayKey, fromWallDate, setTimeZone, toWallDate } from "../web/src/lib/time.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.db.close();
  setTimeZone(undefined);
});

it("reads wall-clock parts and midnight in a zone, not the machine's", () => {
  const t = "2026-11-15T20:30:00Z";
  expect(zonedParts(t, "Asia/Shanghai")).toMatchObject({ date: "2026-11-16", hour: 4, minute: 30, weekday: 1 });
  expect(zonedParts(t, "America/New_York")).toMatchObject({ date: "2026-11-15", hour: 15, minute: 30, weekday: 0 });
  expect(zoneMidnight("2026-11-16", "Asia/Shanghai").toISOString()).toBe("2026-11-15T16:00:00.000Z");
  // A day that starts in summer time and one across the change.
  expect(zoneMidnight("2026-07-01", "America/New_York").toISOString()).toBe("2026-07-01T04:00:00.000Z");
  expect(zoneMidnight("2026-11-02", "America/New_York").toISOString()).toBe("2026-11-02T05:00:00.000Z");
});

it("falls back to the machine's zone for a name it does not know, keeps one it does", () => {
  expect(validZone("Asia/Shanghai")).toBe(true);
  expect(validZone("Mars/Base")).toBe(false);
  expect(configSchema.parse({ timezone: "Mars/Base" }).timezone).toBe(systemZone());
  expect(configSchema.parse({ timezone: "UTC" }).timezone).toBe("UTC");
});

it("quiet hours and the later slots follow config.timezone", () => {
  const app = testApp();
  apps.push(app);
  app.config.notify.quietStart = 23;
  app.config.notify.quietEnd = 8;
  app.config.notify.laterTimes = ["09:30", "18:30"];
  const at = new Date("2026-11-16T02:00:00Z"); // 10:00 in Shanghai, 02:00 in UTC
  app.config.timezone = "Asia/Shanghai";
  expect(inQuietHours(app, at)).toBe(false);
  expect(laterSlot(app, at)).toBe("2026-11-16 09:30");
  app.config.timezone = "UTC";
  expect(inQuietHours(app, at)).toBe(true);
  expect(laterSlot(app, at)).toBeNull();
});

it("web pages turn instants into the set zone's wall clock and back", () => {
  setTimeZone("Asia/Tokyo");
  const t = "2026-11-15T20:30:00Z"; // 05:30 on the 16th in Tokyo
  const w = toWallDate(t);
  expect([w.getFullYear(), w.getMonth() + 1, w.getDate(), w.getHours(), w.getMinutes()]).toEqual([2026, 11, 16, 5, 30]);
  expect(fromWallDate(w).toISOString()).toBe("2026-11-15T20:30:00.000Z");
  expect(fromWallDate(new Date(2026, 10, 16, 9, 0)).toISOString()).toBe("2026-11-16T00:00:00.000Z");
  expect(dayKey(t)).toBe("2026-11-16");
  setTimeZone("America/New_York");
  expect(dayKey(t)).toBe("2026-11-15");
  expect(fromWallDate(new Date(2026, 6, 1, 9, 0)).toISOString()).toBe("2026-07-01T13:00:00.000Z");
});
