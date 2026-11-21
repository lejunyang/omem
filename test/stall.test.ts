import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAcp } from "../src/agents/acp.ts";
import { isRetryableAgentError } from "../src/agents/runner.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import type { AgentEvent } from "../src/agents/types.ts";

const fake = (env: Record<string, string>, idleTimeoutMs = 1500) =>
  agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", ...env }, idleTimeoutMs });

describe("agent stalls and provider queue", () => {
  it("treats silence before the first real token as a retryable provider wait, hiding CLI notices", async () => {
    const events: AgentEvent[] = [];
    const err = await runAcp(fake({ FAKE_STALL: "before" }, 4000), { cwd: process.cwd(), prompt: "hi" }, (e) => events.push(e)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/没有开始回答/);
    expect(isRetryableAgentError(err)).toBe(true);
    // The traex skills notice becomes a status line, not answer text.
    expect(events.some((e) => e.type === "text" && /Skill descriptions/.test(e.text))).toBe(false);
    expect(events.some((e) => e.type === "status" && /Skill descriptions/.test(e.text))).toBe(true);
  }, 20_000);

  it("does not retry a turn that stalled after real output", async () => {
    const err = await runAcp(fake({ FAKE_STALL: "after" }, 4000), { cwd: process.cwd(), prompt: "hi" }, () => {}).catch((e) => e);
    expect(String(err.message)).toMatch(/没有任何活动/);
    expect(isRetryableAgentError(err)).toBe(false);
  }, 20_000);

  it("keeps waiting while the provider reports a queue longer than the idle budget", async () => {
    const events: AgentEvent[] = [];
    // The idle budget also covers starting the agent and the ACP handshake, which can take
    // well over a second under the full suite's load; the queue only has to outlast it.
    const r = await runAcp(fake({ FAKE_QUEUE: "6000" }, 3000), { cwd: process.cwd(), prompt: "hi", queueTimeoutMs: 20_000 }, (e) => events.push(e));
    expect(r.text).toBe("queued-ok");
    expect(events.some((e) => e.type === "queue" && e.queued)).toBe(true);
  }, 30_000);

  it("reads traex's queueStatus meta: idle time is not counted while queued, and the wait is reported", async () => {
    const events: AgentEvent[] = [];
    const profile = { ...fake({ FAKE_TRAE: "1", FAKE_QUEUE: "6000" }, 3000), model: "m2", effort: "high" };
    const r = await runAcp(profile, { cwd: process.cwd(), prompt: "hi", queueTimeoutMs: 20_000 }, (e) => events.push(e));
    expect(r.text).toBe("queued-ok m2");
    const q = events.filter((e): e is Extract<AgentEvent, { type: "queue" }> => e.type === "queue");
    expect(q.map((e) => [e.queued, e.position])).toEqual([[true, 3], [true, 1], [false, undefined]]);
    expect(q[0].message).toBe("排在第 3 位");
    const status = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
    expect(status).toContain("模型排队中，前方约 3 位…");
    expect(status).toContain("模型排队中，前方约 1 位…");
    expect(status.some((t) => /^排队结束/.test(t))).toBe(true);
    // effort is set once the model offers it (it did not exist on the default model).
    expect(status.some((t) => /不支持设置 effort/.test(t))).toBe(false);
  }, 30_000);

  it("probes effort levels per model when they appear only after a model is selected", async () => {
    const r = await runAcp(fake({ FAKE_TRAE: "1" }, 5000), { cwd: process.cwd(), prompt: "", probe: true }, () => {});
    expect(r.probe?.effortsByModel).toEqual({ m1: [], m2: ["low", "medium", "high"], m3: ["low", "xhigh"] });
  }, 20_000);

  it("waits for an effort option the agent lists late when the run named the level, and gives up after the wait", async () => {
    const { setEffortWaitForTests } = await import("../src/agents/acp.ts");
    const strict = { cwd: process.cwd(), prompt: "hi", strictSelection: { model: true, effort: true } };
    const late: Record<string, string>[] = [{ FAKE_LATE_EFFORT: "1800" }, { FAKE_LATE_EFFORT: "1800", FAKE_LATE_EFFORT_ANNOUNCE: "1" }];
    for (const env of late) {
      const events: AgentEvent[] = [];
      const r = await runAcp({ ...fake({ FAKE_TRAE: "1", ...env }, 8000), model: "m2", effort: "high" }, strict, (e) => events.push(e));
      expect(r.text).toContain('"turn":1');
      const status = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
      expect(status).toContain("后端还没列出思考强度的选项，等它加载完再取");
      expect(status.some((t) => /不支持设置 effort/.test(t))).toBe(false);
    }
    // Not named by the owner: no waiting, the agent's default level is used.
    const loose: AgentEvent[] = [];
    await runAcp({ ...fake({ FAKE_TRAE: "1", FAKE_LATE_EFFORT: "60000" }, 8000), model: "m2", effort: "high" }, { cwd: process.cwd(), prompt: "hi" }, (e) => loose.push(e));
    expect(loose.some((e) => e.type === "status" && /不支持设置 effort，使用其默认值/.test(e.text))).toBe(true);
    // Named, and it never shows up: fails once the wait is over.
    setEffortWaitForTests(700);
    try {
      const err = await runAcp({ ...fake({ FAKE_TRAE: "1", FAKE_LATE_EFFORT: "60000" }, 8000), model: "m2", effort: "high" }, strict, () => {}).catch((e) => e);
      expect(String((err as Error).message)).toMatch(/不支持设置 effort，无法使用指定值 high/);
    } finally {
      setEffortWaitForTests(12_000);
    }
  }, 60_000);

  it("moves a saved profile still on an earlier default command line to the current one", async () => {
    const { upgradeProfileArgs } = await import("../src/agents/catalog.ts");
    const old = agentProfileSchema.parse({ id: "traex", transport: "acp", command: "traex", args: ["acp", "serve"] });
    expect(upgradeProfileArgs(old).args).toEqual(["acp", "serve", "-c", "features.headless_queue_status=true"]);
    const own = { ...old, args: ["acp", "serve", "-p", "work"] };
    expect(upgradeProfileArgs(own).args).toEqual(own.args);
  });
});
