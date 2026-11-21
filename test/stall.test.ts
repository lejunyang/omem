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
      setEffortWaitForTests(3_000);
    }
  }, 60_000);

  it("opens a fresh session after a wait when the agent lists less than it is known to have", async () => {
    const { setCatalogRetryForTests, setEffortWaitForTests } = await import("../src/agents/acp.ts");
    const { saveProbe } = await import("../src/agents/probe.ts");
    const { testApp } = await import("./helpers.ts");
    const app = testApp();
    // What the backend listed when it was last probed: m2 with its levels.
    saveProbe(app, "fake", { at: new Date().toISOString(), agent: "fake-agent 1", models: ["m1", "m2", "m3"], efforts: ["low", "medium", "high", "xhigh"], effortsByModel: { m1: [], m2: ["low", "medium", "high"], m3: ["low", "xhigh"] } });
    setEffortWaitForTests(200);
    const before = setCatalogRetryForTests({ named: [800, 800, 800, 800, 800], other: [300] });
    const named = { app, cwd: process.cwd(), prompt: "hi", strictSelection: { model: true, effort: true } };
    const statusOf = (events: AgentEvent[]) => events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
    try {
      // Cut down for a while (no level; then no m2 at all), whole again later: the run waits and goes through.
      for (const what of ["effort", "model"]) {
        const events: AgentEvent[] = [];
        const r = await runAcp({ ...fake({ FAKE_TRAE: "1", FAKE_CUT: what, FAKE_CUT_UNTIL: String(Date.now() + 2200) }, 8000), model: "m2", effort: "high" }, named, (e) => events.push(e));
        expect(r.text).toContain('"turn":1');
        const status = statusOf(events);
        expect(status.some((t) => new RegExp(`指定的${what === "effort" ? "思考强度 high" : "模型 m2"} 这次不可用.*秒后重开会话再试`).test(t))).toBe(true);
        expect(status.some((t) => /不支持设置|用它的默认/.test(t))).toBe(false);
      }
      // Never whole again: a named run fails saying so. It is not moved to another backend for this (the owner named this one).
      const err = await runAcp({ ...fake({ FAKE_TRAE: "1", FAKE_CUT_UNTIL: String(Date.now() + 600_000) }, 8000), model: "m2", effort: "high" }, { ...named }, () => {}).catch((e) => e);
      expect(String((err as Error).message)).toMatch(/指定的思考强度 high 这次不可用：.*上次检测时有它，这次没有列出思考强度/);
      expect(isRetryableAgentError(err)).toBe(false);
      // Not named: after its tries it goes on with the agent's defaults, as before.
      const loose: AgentEvent[] = [];
      const r = await runAcp({ ...fake({ FAKE_TRAE: "1", FAKE_CUT_UNTIL: String(Date.now() + 600_000) }, 8000), model: "m2", effort: "high" }, { app, cwd: process.cwd(), prompt: "hi" }, (e) => loose.push(e));
      expect(r.text).toContain('"turn":1');
      expect(statusOf(loose).some((t) => /不支持设置 effort，使用其默认值/.test(t))).toBe(true);
      // A level this backend never had is still refused at once (nothing known says it should be there).
      const never = await runAcp({ ...fake({ FAKE_TRAE: "1" }, 8000), model: "m2", effort: "ultra" }, { ...named }, () => {}).catch((e) => e);
      expect(String((never as Error).message)).toMatch(/指定 effort=ultra 不可用/);
      expect(isRetryableAgentError(never)).toBe(false);
    } finally {
      setCatalogRetryForTests(before);
      setEffortWaitForTests(3_000);
      app.events.emit("close");
      app.db.close();
    }
  }, 90_000);

  it("starts the backend on the named model and level where its catalog entry says how, and takes a session already on the level", async () => {
    const { launchConfigEnv } = await import("../src/agents/catalog.ts");
    const codex = { id: "codex", command: "codex-acp", env: {} as Record<string, string> };
    expect(JSON.parse(launchConfigEnv(codex, { model: "m2", effort: "high" }).CODEX_CONFIG)).toEqual({ model: "m2", model_reasoning_effort: "high" });
    expect(launchConfigEnv(codex, { model: "m2", effort: null })).toEqual({ CODEX_CONFIG: '{"model":"m2"}' });
    expect(launchConfigEnv(codex, {})).toEqual({});
    // What the profile already puts there stays, and wins.
    const own = { ...codex, env: { CODEX_CONFIG: '{"hooks":{"a":1},"model":"mine"}' } };
    expect(JSON.parse(launchConfigEnv(own, { model: "m2", effort: "high" }).CODEX_CONFIG)).toEqual({ hooks: { a: 1 }, model: "mine", model_reasoning_effort: "high" });
    expect(launchConfigEnv({ ...codex, env: { CODEX_CONFIG: "not json" } }, { model: "m2" })).toEqual({});
    // A profile made from the entry under another id, and a backend with no such setting.
    expect(Object.keys(launchConfigEnv({ id: "codex-work", source: "codex", command: "x", env: {} }, { model: "m2" }))).toEqual(["CODEX_CONFIG"]);
    expect(launchConfigEnv({ id: "fake", command: process.execPath, env: {} }, { model: "m2", effort: "high" })).toEqual({});

    // The agent lists no levels (its catalog does not know the model) but the session says it is on m2[high]: taken, at once.
    const events: AgentEvent[] = [];
    const started = Date.now();
    const r = await runAcp({ ...fake({ FAKE_TRAE: "1", FAKE_LAUNCHED: "m2:high", FAKE_CUT_UNTIL: String(Date.now() + 600_000) }, 8000), model: "m2", effort: "high" },
      { cwd: process.cwd(), prompt: "hi", strictSelection: { model: true, effort: true } }, (e) => events.push(e));
    expect(r.text).toContain('"turn":1');
    const status = events.filter((e) => e.type === "status").map((e) => (e as { text: string }).text);
    expect(status).toContain("思考强度 high 已在启动时指定（后端这次没有列出思考强度）");
    expect(status.some((t) => /等它加载完再取|不支持设置/.test(t))).toBe(false);
    expect(Date.now() - started).toBeLessThan(8_000);
    // On another level than the one named: not taken.
    const err = await runAcp({ ...fake({ FAKE_TRAE: "1", FAKE_LAUNCHED: "m2:low", FAKE_CUT_UNTIL: String(Date.now() + 600_000) }, 8000), model: "m2", effort: "high" },
      { cwd: process.cwd(), prompt: "hi", strictSelection: { model: true, effort: true } }, () => {}).catch((e) => e);
    expect(String((err as Error).message)).toMatch(/不支持设置 effort，无法使用指定值 high/);
  }, 60_000);

  it("moves a saved profile still on an earlier default command line to the current one", async () => {
    const { upgradeProfileArgs } = await import("../src/agents/catalog.ts");
    const old = agentProfileSchema.parse({ id: "traex", transport: "acp", command: "traex", args: ["acp", "serve"] });
    expect(upgradeProfileArgs(old).args).toEqual(["acp", "serve", "-c", "features.headless_queue_status=true"]);
    const own = { ...old, args: ["acp", "serve", "-p", "work"] };
    expect(upgradeProfileArgs(own).args).toEqual(own.args);
  });
});
