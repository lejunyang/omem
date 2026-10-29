import { expect, it } from "vitest";
import { createRun, getRun, queueReason, registerHandler, startWorker, waitForRun } from "../src/agents/runs.ts";
import { tooFull } from "../src/agents/background-sessions.ts";
import { addRunEvent } from "../src/agents/runs.ts";
import { toolLatency } from "../src/core/peer-exec.ts";
import { testApp } from "./helpers.ts";

it("gives the bulk digest one slot of its own, so new material and the heartbeat never wait behind it", async () => {
  const app = testApp();
  app.config.concurrency = 1;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registerHandler("digest", async () => { await gate; });
  registerHandler("triage", async () => { await gate; });
  registerHandler("ingest", async () => {});
  registerHandler("heartbeat", async () => {});
  const digests = [createRun(app, { kind: "digest", title: "整理第 1 批" }), createRun(app, { kind: "digest", title: "整理第 2 批" }), createRun(app, { kind: "triage", title: "分级" })];
  const ingest = createRun(app, { kind: "ingest", title: "新材料" });
  const heartbeat = createRun(app, { kind: "heartbeat", title: "巡检" });
  startWorker(app);
  try {
    expect(getRun(app, digests[0].id).status).toBe("running");
    expect(getRun(app, digests[1].id).status).toBe("queued");
    expect(queueReason(app, getRun(app, digests[1].id))).toMatch(/等存量整理空位：同时最多 1 个，正在运行 1 个/);
    // Background work goes ahead in its own slot.
    expect((await waitForRun(app, ingest.id)).status).toBe("done");
    expect((await waitForRun(app, heartbeat.id)).status).toBe("done");
    expect(getRun(app, digests[2].id).status).toBe("queued");
  } finally {
    release();
  }
  for (const d of digests) expect((await waitForRun(app, d.id)).status).toBe("done");
});

it("rotates a reused background session past the ratio or the absolute token limit", () => {
  const config = { maxContextRatio: 0.6, maxContextTokens: 120_000 };
  expect(tooFull({ used: 100_000, size: 200_000 }, config)).toBe(false);
  expect(tooFull({ used: 130_000, size: 200_000 }, config)).toBe(true);
  expect(tooFull({ used: 300_000, size: 1_000_000 }, config)).toBe(true);
  expect(tooFull({ used: 300_000, size: 1_000_000 }, { ...config, maxContextTokens: 0 })).toBe(false);
});

it("reports tool-call p90 with a warning above 30 seconds", () => {
  const app = testApp();
  const r = createRun(app, { kind: "ingest", title: "整理" });
  for (let i = 0; i < 10; i++) addRunEvent(app, r.id, "tool", { id: `t${i}`, title: "mcp__omem__search", status: "completed", ms: i < 8 ? 1000 : 45_000 });
  for (let i = 0; i < 5; i++) addRunEvent(app, r.id, "tool", { id: `s${i}`, title: "Read file", status: "completed", ms: 200 });
  addRunEvent(app, r.id, "tool", { id: "p", title: "pending", status: "pending" });
  const t = toolLatency(app);
  expect(t).toMatchObject({ n: 15, maxMs: 45_000 });
  expect(t.p90Ms).toBe(45_000);
  expect(t.warning).toMatch(/p90 是 45 秒/);
  expect(t.slowest[0]).toMatchObject({ tool: "search", n: 10, p90Ms: 45_000 });
});
