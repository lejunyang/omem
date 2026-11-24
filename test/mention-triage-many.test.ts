import { afterEach, expect, it } from "vitest";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { all } from "../src/core/db.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { triage } from "../src/mentions/triage.ts";
import { testApp } from "./helpers.ts";

afterEach(() => setDecisionFetchForTests(null));

it("分诊决定先查后才合问处理者和回复权限，回复权限仍逐题套门槛", async () => {
  const app = testApp();
  saveAgentSpec(app, { name: "demo", description: "负责项目 A", prompt: "核对项目 A 的信息。" }, "user");
  app.config.ai.providers = [{ id: "d", kind: "openai", name: "测试决策", backends: [] }];
  app.config.ai.decision = { provider: "d", model: "", fallback: "none", gatekeeper: true, thresholds: { ...app.config.ai.decision.thresholds!, progress: 0.8 } };
  setKey(app.home, "d", "test-key");
  const calls: string[][] = [];
  let action = "handle";
  setDecisionFetchForTests((async (_url: string, init: RequestInit) => {
    const { questions } = JSON.parse(String(init.body)) as { questions: { type: string; name: string }[] };
    calls.push(questions.map(q => q.name));
    return new Response(JSON.stringify({ answers: questions.map(q => q.type === "predicate"
      ? { ...q, probability: 0.7 } : { ...q, choice: q.name === "handler" ? "demo" : action,
        probabilities: [{ value: q.name === "handler" ? "demo" : action, probability: 0.99 }] }) }));
  }) as typeof fetch);
  const material = { 消息: "项目 A 的截止时间定了吗？" };
  expect(await triage(app, material, { needProgress: true, ref: "mention-test" })).toMatchObject({ action: "handle", handler: "demo", canProgress: false });
  expect(calls).toEqual([["q"], ["handler", "progress"]]);
  expect(all(app.db, "select scene, choice, taken from decisions where ref=? order by rowid", "mention-test")).toEqual([
    { scene: "triage", choice: "handle", taken: "handle" }, { scene: "progress", choice: "yes", taken: "no" },
  ]);
  action = "notify";
  calls.length = 0;
  expect(await triage(app, material, { needProgress: true })).toMatchObject({ action: "notify", canProgress: false });
  expect(calls).toEqual([["q"]]);
});
