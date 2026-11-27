import { afterEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import type { AgentEvent } from "../src/agents/types.ts";
import { runRole } from "../src/agents/runner.ts";
import * as dispatch from "../src/agents/dispatch.ts";
import { addRunEvent, createRun, runEvents } from "../src/agents/runs.ts";
import { policySchema } from "../src/core/ai-policy-schema.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { all } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  setDecisionFetchForTests(null);
  resetDecisionCooldownForTests();
});

it.each([
  { name: "采用高置信选择并按第二名接手", first: 0.70, second: 0.25, gap: 0.15, order: ["b", "c", "a", "d"], failFirst: true },
  { name: "低于门槛", first: 0.54, second: 0.26, gap: 0.15, order: ["a", "b", "c", "d"] },
  { name: "低于本人设置的最小差距", first: 0.58, second: 0.40, gap: 0.20, order: ["a", "b", "c", "d"] },
  { name: "服务限流", status: 429, first: 0, second: 0, gap: 0.15, order: ["a", "b", "c", "d"] },
  { name: "固定顺序", fixed: true, first: 0, second: 0, gap: 0.15, order: ["a", "b", "c", "d"] },
])("从日常整理运行入口验证$name", async ({ fixed, first, second, gap, order, failFirst, status }) => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  try {
    const names = ["blocked", "a", "b", "c", "d"];
    app.config.agents.default = "blocked";
    app.config.agents.profiles.push(...names.map(id => ({
      id, model: id === "blocked" ? "gemini-neon" : "demo", transport: "acp" as const,
      command: process.execPath, args: [], env: {}, idleTimeoutMs: 1000,
    })));
    app.config.agents.groups.push(...names.map(id => ({ id, name: id, items: [{ profile: id, note: id + "的用途" }] })));
    app.config.agents.routing.automatic = true;
    app.config.agents.policy = policySchema.parse({ classes: { routine: { use: names, order: fixed ? "fixed" : "choose", strict: true, deny: ["model:gemini"] } } });
    app.config.ai.providers = [{ id: "d", name: "测试", kind: "openai", backends: [] }];
    app.config.ai.decision.provider = "d";
    app.config.ai.decision.routeMinGap = gap;
    setKey(app.home, "d", "test-key");
    const judge = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      return status ? new Response("", { status }) : Response.json({ answers: [{ name: "q", type: "choice", choice: "b", probabilities:
        Object.entries({ a: 1 - first - second, b: first, c: second }).map(([value, probability]) => ({ value, probability })) }] });
    });
    setDecisionFetchForTests(judge);
    const backend = vi.spyOn(dispatch, "runBackend").mockImplementation(async (_app, profile) => ({ agent: profile.id, text: "已整理", stopReason: "end_turn" }));
    if (failFirst) backend.mockRejectedValueOnce(new Error("Agent 进程退出（1）"));
    const run = createRun(app, { kind: "ingest", title: "整理示例" });
    await runRole(app, { role: "ingest", spaceId: "personal", task: "文".repeat(1501), runId: run.id,
      onEvent: e => addRunEvent(app, run.id, e.type, e) });
    expect(backend.mock.calls.map(call => call[1].id)).toEqual(order.slice(0, failFirst ? 2 : 1));
    expect(judge).toHaveBeenCalledTimes(fixed ? 0 : 1);
    if (!fixed) {
      const body = JSON.parse(String(judge.mock.calls[0][1]?.body));
      expect(body.questions[0].choices.map((c: { value: string }) => c.value)).toEqual(["a", "b", "c"]);
      expect(body.input[0].content[0].data).toEqual({ 类别: expect.stringContaining("日常整理"), 任务: "文".repeat(1500) });
    }
    const events = runEvents(app, run.id).filter(e => e.type === "status").map(e => e.data as Extract<AgentEvent, { type: "status" }>);
    const choice = events.find(e => e.choice)?.choice;
    expect(choice).toMatchObject({ class: "routine", order: order.map(id => id + " · demo"), excluded: expect.arrayContaining([expect.stringContaining("不用 model:gemini")]) });
    if (failFirst) expect(events.find(e => e.failover)?.failover).toMatchObject({ inScope: true, to: "c · demo" });
    else if (!fixed) expect(choice).toMatchObject({ reason: expect.stringContaining("按默认先后") });
    expect(all(app.db, "select taken from decisions where scene='route' and ref=?", run.id)).toEqual(fixed ? [] : [{ taken: order[0] }]);
  } finally {
    app.db.close();
    rmSync(app.home, { recursive: true, force: true });
  }
}, 60_000);

it("加载旧配置后，流程档位不接管普通运行，旧候选仍可和角色默认 AI 比较", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { chooseAI } = await import("../src/agents/choose-ai.ts");
  const home = mkdtempSync(join(tmpdir(), "omem-route-"));
  const profiles = ["original", "alternate", "flow-ai"].map(id => ({
    id, transport: "acp" as const, command: process.execPath, args: [], env: {}, model: "demo", idleTimeoutMs: 1000,
  }));
  try {
    for (const useCandidates of [false, true]) {
      writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { profiles, default: "original",
        tiers: { strong: { profile: "flow-ai" } }, routing: { choose: { tasks: "decision" },
          candidates: useCandidates ? [{ profile: "alternate", when: "短任务" }] : [] } } }));
      const app = testApp(home);
      try {
        const opt = { scene: "tasks" as const, who: "ingest", task: "整理项目记录", current: profiles[0] };
        const result = await chooseAI(app, opt);
        if (!useCandidates) { expect(result).toBeNull(); continue; }
        expect(result?.order.map(p => p.id)).toEqual(["original", "alternate"]);
        app.config.ai.providers = [{ id: "d", name: "测试", kind: "openai", backends: [] }];
        app.config.ai.decision.provider = "d";
        setKey(home, "d", "test-key");
        setDecisionFetchForTests(async () => Response.json({ answers: [{ name: "q", type: "choice", choice: "candidates",
          probabilities: [{ value: "ai:original · demo", probability: 0.1 }, { value: "candidates", probability: 0.9 }] }] }));
        expect((await chooseAI(app, opt))?.order.map(p => p.id)).toEqual(["alternate", "original"]);
      } finally { app.db.close(); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
