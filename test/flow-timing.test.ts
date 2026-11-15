import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageTiming, nextRoundAt } from "../src/flows/timing.ts";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { flowReminders, startFlow } from "../src/flows/engine.ts";
import { getStage } from "../src/flows/store.ts";
import { upsertItem } from "../src/items/store.ts";
const d = (s: string) => new Date(s);
const apps: App[] = [];
afterEach(async () => { vi.useRealTimers(); await new Promise((r) => setImmediate(r)); for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); } });

describe("阶段开始时间纯函数", () => {
  it("不写限制随时开始，at 是本轮日期的下限，跨日不再等同一个时刻", () => {
    expect(stageTiming(d("2026-11-15T09:00Z"), "UTC", {})).toEqual({ ready: true, nextAt: null });
    expect(stageTiming(d("2026-11-15T09:00Z"), "UTC", { at: "10:00" })).toEqual({ ready: false, nextAt: "2026-11-15T10:00:00.000Z" });
    expect(stageTiming(d("2026-11-15T10:00Z"), "UTC", { at: "10:00" }).ready).toBe(true);
    expect(stageTiming(d("2026-11-16T01:00Z"), "UTC", { at: "10:00" }, d("2026-11-15T09:00Z")).ready).toBe(true);
  });
  it("时间段包含开始，不含结束，at 和 window 要同时满足", () => {
    expect(stageTiming(d("2026-11-15T00:59:01Z"), "UTC", { window: "01:00-06:00" }).nextAt).toBe("2026-11-15T01:00:00.000Z");
    expect(stageTiming(d("2026-11-15T01:00Z"), "UTC", { window: "01:00-06:00" }).ready).toBe(true);
    expect(stageTiming(d("2026-11-15T06:00Z"), "UTC", { window: "01:00-06:00" }).nextAt).toBe("2026-11-16T01:00:00.000Z");
    expect(stageTiming(d("2026-11-15T02:00Z"), "UTC", { at: "10:00", window: "01:00-06:00" }).nextAt).toBe("2026-11-16T01:00:00.000Z");
  });
  it("跨午夜在午夜后仍可开始，出了窗口等当晚；按配置时区", () => {
    const window = "23:00-05:00";
    for (const t of ["2026-11-15T23:00Z", "2026-11-16T00:00Z", "2026-11-16T04:59Z"]) expect(stageTiming(d(t), "UTC", { window }).ready).toBe(true);
    expect(stageTiming(d("2026-11-16T05:00Z"), "UTC", { window }).nextAt).toBe("2026-11-16T23:00:00.000Z");
    expect(stageTiming(d("2026-11-15T00:00Z"), "Asia/Tokyo", { at: "10:00" }).nextAt).toBe("2026-11-15T01:00:00.000Z");
    expect(stageTiming(d("2026-11-15T16:00Z"), "Asia/Tokyo", { window: "01:00-06:00" }).ready).toBe(true);
    expect(nextRoundAt(d("2026-11-15T16:00Z"), "Asia/Tokyo", ["tue", "fri"])).toBe("2026-11-16T15:00:00.000Z");
  });
  it("夏令时跳过不存在的钟点，回拨的两个同名时刻都按当地窗口判断", () => {
    expect(stageTiming(d("2026-03-08T06:00Z"), "America/New_York", { at: "02:30" }).nextAt).toBe("2026-03-08T07:00:00.000Z");
    for (const t of ["2026-11-01T05:30Z", "2026-11-01T06:30Z"]) expect(stageTiming(d(t), "America/New_York", { window: "01:00-02:00" }).ready).toBe(true);
    expect(nextRoundAt(d("2026-03-08T06:00Z"), "America/New_York", "day")).toBe("2026-03-09T04:00:00.000Z");
  });
  it("推进留未开始并说明等待时刻，巡检到点开始，不重复记录同一等待", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(d("2026-11-15T00:00Z"));
    const app = testApp(); apps.push(app); app.config.timezone = "UTC";
    saveFlow(app, JSON.stringify({ id: "timing", name: "示例夜间核验", stages: [{ id: "check", name: "核验", by: { run: {} }, at: "01:00", window: "01:00-06:00" }] }), "user");
    const item = upsertItem(app, undefined, { title: "示例核验", spaceId: "personal" }, "user");
    await startFlow(app, item.id, "timing", { actor: "owner" });
    expect(getStage(app, item.id, "check")).toMatchObject({ state: "pending", attempt: 0, control: { waitUntil: "2026-11-15T01:00:00.000Z" } });
    expect(getStage(app, item.id, "check").note).toContain("01:00");
    await flowReminders(app, d("2026-11-15T00:59Z")); expect(getStage(app, item.id, "check").state).toBe("pending");
    await flowReminders(app, d("2026-11-15T01:00Z")); expect(getStage(app, item.id, "check")).toMatchObject({ state: "doing", attempt: 1 });
    await flowReminders(app, d("2026-11-15T07:00Z")); expect(getStage(app, item.id, "check").state).toBe("doing");
  });
});
