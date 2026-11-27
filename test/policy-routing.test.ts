import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentRunError, type AgentEvent } from "../src/agents/types.ts";
import { runRole } from "../src/agents/runner.ts";
import * as dispatch from "../src/agents/dispatch.ts";
import { addRunEvent, createRun, runEvents } from "../src/agents/runs.ts";
import { policySchema } from "../src/core/ai-policy-schema.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { all } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";
import { confirmProbe, probeCloud } from "../src/agents/cloud-probe.ts";
import { fakeCloudReceipt } from "./fake-cloud-probe.ts";

afterEach(() => {
  vi.restoreAllMocks();
  setDecisionFetchForTests(null);
  resetDecisionCooldownForTests();
});

it.each(["automatic", "quota", "pinned"] as const)("本机工作区限制覆盖自动选型、额度换后端和流程指派：%s", async route => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  try {
    const [local, cloud, backup] = ["local", "cloud", "backup"].map(id => ({
      id, transport: id === "cloud" ? "doubao" as const : "acp" as const, command: process.execPath, args: [], env: {}, idleTimeoutMs: 1000,
    }));
    app.config.agents.profiles.push(local, cloud, backup);
    app.config.agents.default = local.id;
    app.config.agents.fallback = [{ profile: cloud.id }, { profile: backup.id }];
    app.config.webUrl = "https://8.8.8.8";
    mkdirSync(join(app.home, "secrets"), { recursive: true });
    writeFileSync(join(app.home, "secrets", "doubao.json"), JSON.stringify({ demo: {} }));
    Object.assign(app.config.agents.cloudTools, { enabled: true, backends: [cloud.id], credentialIn: "message", tools: ["trial_report"] });
    const probe = await probeCloud(app, cloud.id, async (_app, _profile, req) => ({
      text: fakeCloudReceipt(app, req.prompt.match(/challenge\/([\w-]+)/)![1], "header"), agent: cloud.id, stopReason: "end_turn",
    }));
    confirmProbe(app, cloud.id, probe.id);
    if (route === "automatic") {
      const profiles = [cloud, backup, local];
      app.config.agents.groups.push(...profiles.map(p => ({ id: p.id, name: p.id, items: [{ profile: p.id, note: "" }] })));
      app.config.agents.policy = policySchema.parse({ classes: { flows: { use: profiles.map(p => p.id), order: "fixed", strict: true } } });
    }
    const backend = vi.spyOn(dispatch, "runBackend").mockImplementation(async (_app, profile) => ({ agent: profile.id, text: "完成", stopReason: "end_turn" }));
    if (route === "quota") backend.mockRejectedValueOnce(agentRunError("达到额度上限", "quota"));
    const trial = createRun(app, { kind: "study-trial", title: "示例试验" });
    const task = runRole(app, { role: "assistant", spaceId: "personal", task: "运行示例项目的测试", runId: trial.id, choose: "tasks",
      addTools: ["trial_report"], requiredTools: ["trial_report"],
      ...(route === "pinned" ? { execution: { profile: cloud.id, source: "flow", reason: "试验阶段指定" } } : {}),
    });
    if (route === "pinned") await expect(task).rejects.toThrow("本机工作区");
    else await expect(task).resolves.toMatchObject({ profileId: backup.id });
    expect(backend.mock.calls.map(call => call[1].id)).toEqual(route === "pinned" ? [] : route === "quota" ? [local.id, backup.id] : [backup.id]);
  } finally {
    app.db.close();
    rmSync(app.home, { recursive: true, force: true });
  }
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

it("加载旧配置后，档位和候选留在原处，选型照旧，流程档位不接管普通运行", async () => {
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
        // Nothing was copied into the groups: the settings page that edits tiers and candidates still applies.
        expect(app.config.agents.groups.every(g => !g.items.length)).toBe(true);
        // As before the rules: without a decision model, a run of this kind is not re-chosen.
        expect(await chooseAI(app, opt)).toBeNull();
        if (!useCandidates) continue;
        app.config.ai.providers = [{ id: "d", name: "测试", kind: "openai", backends: [] }];
        app.config.ai.decision.provider = "d";
        setKey(home, "d", "test-key");
        setDecisionFetchForTests(async () => Response.json({ answers: [{ name: "q", type: "choice", choice: "c1",
          probabilities: [{ value: "keep", probability: 0.1 }, { value: "c1", probability: 0.9 }] }] }));
        const order = (await chooseAI(app, opt))?.order.map(p => p.id);
        expect(order).toEqual(["alternate", "original"]);
        expect(order).not.toContain("flow-ai");
      } finally { app.db.close(); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
