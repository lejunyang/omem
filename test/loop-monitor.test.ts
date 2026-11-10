import { afterEach, expect, it, vi } from "vitest";
import { all, run } from "../src/core/db.ts";
import { loopStats, mark, resetLoopStats, startLoopMonitor, stopLoopMonitor, syncSpan } from "../src/core/loop-monitor.ts";
import { closeReadProcess, readProcess } from "../src/search/read-process.ts";
import { upsertSource } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end); };
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

afterEach(() => { stopLoopMonitor(); resetLoopStats(); vi.restoreAllMocks(); });

it("names the synchronous step and what started before a stall", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  startLoopMonitor({ thresholdMs: 150 });
  await sleep(250);
  mark("GET /api/example");
  syncSpan("示例同步步骤", () => busy(400));
  await sleep(250);
  const stats = loopStats();
  expect(stats.stalls.length).toBeGreaterThanOrEqual(1);
  const stall = stats.stalls[0];
  expect(stall.ms).toBeGreaterThanOrEqual(250);
  expect(stall.spans[0].name).toBe("示例同步步骤");
  expect(stall.started).toContain("GET /api/example");
  expect(stats.slowestSync[0]).toMatchObject({ name: "示例同步步骤", n: 1 });
  expect(stats.delay?.maxMs).toBeGreaterThanOrEqual(250);
  expect(warn.mock.calls.some((c) => String(c[0]).includes("事件循环卡了") && String(c[0]).includes("示例同步步骤"))).toBe(true);
  // Short steps are not kept.
  syncSpan("很快的步骤", () => busy(5));
  expect(loopStats().slowestSync.some((s) => s.name === "很快的步骤")).toBe(false);
});

it("times SQL through the db helpers", () => {
  const app = testApp();
  try {
    all(app.db, "with recursive x(n) as (values(0) union all select n+1 from x where n < 3000000) select sum(n) s from x");
    run(app.db, "select 1");
    const slow = loopStats().slowestSync;
    expect(slow.some((s) => s.name.startsWith("sql with recursive x(n)"))).toBe(true);
    expect(slow.some((s) => s.name === "sql select 1")).toBe(false);
  } finally { app.db.close(); }
});

it("loads vectors in the search process while the main thread keeps running", async () => {
  const app = testApp();
  const n = 40_000;
  const dims = 256;
  try {
    const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "bulk", title: "批量", text: "x" }).id;
    run(app.db, "delete from chunks where source_id = ?", src);
    run(app.db, "begin");
    const ins = app.db.prepare("insert into chunks(source_id, space_id, ord, kind, line_start, line_end, text, embedding) values(?,?,?,?,?,?,?,?)");
    const v = new Float32Array(dims);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < dims; k++) v[k] = Math.sin(i + k);
      ins.run(src, "personal", i, "window", 1, 1, `c${i}`, new Uint8Array(v.buffer.slice(0)));
    }
    run(app.db, "commit");
    const reader = readProcess(app, "vector");
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
    const started = performance.now();
    await reader.request({ op: "prepare", spaces: ["personal"] }, 120_000);
    const took = performance.now() - started;
    clearInterval(timer);
    expect(reader.stats.vectors).toBe(n);
    // The load itself takes a while; the main thread's timers kept firing throughout.
    expect(took).toBeGreaterThan(50);
    expect(maxGap).toBeLessThan(150);
  } finally { closeReadProcess(app); app.db.close(); }
}, 120_000);
