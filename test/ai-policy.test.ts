import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { runKinds } from "../src/agents/run-kinds.ts";
import { classIds, internalKinds, runClass, runClasses } from "../src/agents/run-classes.ts";
import { policySchema } from "../src/core/ai-policy-schema.ts";
import { chooseAI } from "../src/agents/choose-ai.ts";
import { groupPick, inHours, matchesSelector, policyReason, policyScope } from "../src/agents/ai-policy.ts";
import { validateExecution } from "../src/agents/execution.ts";
import { failoverProfiles } from "../src/agents/runner.ts";
import type { AgentProfile } from "../src/core/config.ts";

const profile = (id: string, model: string): AgentProfile => ({ id, model, transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 1000 });

it("每一种运行恰有一个归属，内部对比不受档案规则影响", () => {
  const classified = classIds.flatMap(id => runClasses[id].kinds as string[]);
  for (const kind of runKinds) expect([...classified, ...internalKinds].filter(k => k === kind), kind).toHaveLength(1);
  expect(runClass("agent", "supervisor")).toBe("supervise");
  expect(runClass("replay", "ingest", "routine")).toBeUndefined();
});
it("跨午夜的时段和各选择器按后端、模型族、具体配置或密钥匹配", () => {
  expect(["19:59", "20:00", "08:59", "09:00"].map(t => inHours("20:00-09:00", t))).toEqual([false, true, true, false]);
  for (const id of ["claude", "claude-cli", "claude@demo"]) expect(matchesSelector("backend:claude", profile(id, "other"))).toBe(true);
  const p = { ...profile("remote", "gemini-neon"), peer: { id: "device", agent: "claude" }, keyRef: "demo" };
  for (const s of ["backend:claude", "model:gemini", "ai:remote · gemini-neon", "key:demo"]) expect(matchesSelector(s, p)).toBe(true);
  expect(matchesSelector("model:claude", p)).toBe(false);
});
it("起步、故障接手和交办保存共用同一条排除规则，strict 限定组", async () => {
  const app = testApp();
  const blocked = profile("large", "gemini-neon"), allowed = profile("small", "gpt-sol"), outside = profile("other", "gpt-astra");
  app.config.agents.profiles.push(blocked, allowed, outside);
  app.config.agents.groups.find(g => g.id === "cheap")!.items = [{ profile: "large" }, { profile: "small" }];
  app.config.agents.policy = policySchema.parse({ classes: { routine: { use: ["cheap"], deny: ["model:gemini"], order: "fixed", strict: true } } });
  app.config.agents.fallback = [{ profile: "other" }];
  const scope = policyScope(app, "ingest");
  expect(groupPick(app, "cheap", scope)?.profile).toBe("small");
  const result = await chooseAI(app, { scope, scene: "tasks", who: "ingest", task: "整理", current: blocked });
  expect(result?.pick?.profile).toBe("small");
  expect(failoverProfiles(app, { role: "ingest" }, blocked).map(p => p.id)).toEqual(["small"]);
  expect(policyReason(scope, outside)).toContain("只用 cheap");
  expect(() => validateExecution(app, { profile: "large", source: "user", reason: "规则指定" }, undefined, false, scope)).toThrow("日常整理 不用 model:gemini");
  app.db.close();
});

it("严格等待重排同一运行，到原定期限失败并通知本人", async () => {
  const app = testApp();
  const { createRun, getRun, setRunOutput, ResumeRunAt } = await import("../src/agents/runs.ts");
  const { waitForPolicy } = await import("../src/agents/ai-policy.ts");
  const { one } = await import("../src/core/db.ts");
  const run = createRun(app, { kind: "ingest", title: "严格范围" });
  app.config.agents.policy = policySchema.parse({ classes: { routine: { use: ["cheap"], strict: true } } });
  const scope = policyScope(app, "ingest")!;
  await expect(waitForPolicy(app, scope, run.id)).rejects.toBeInstanceOf(ResumeRunAt);
  const deadline = getRun(app, run.id).output.aiPolicyWaitUntil;
  await expect(waitForPolicy(app, scope, run.id)).rejects.toBeInstanceOf(ResumeRunAt);
  expect(getRun(app, run.id).output.aiPolicyWaitUntil).toEqual(deadline);
  setRunOutput(app, run.id, { aiPolicyWaitUntil: Date.now() - 1 });
  await expect(waitForPolicy(app, scope, run.id)).rejects.toThrow("等待 AI 超时");
  expect(one(app.db, "select 1 from notifications where user_id='owner' and title='等待 AI 超时'")).toBeTruthy();
  app.db.close();
});

it("近七天的选择计入类别，包括升级前只有运行类型的记录", async () => {
  const app = testApp();
  const { createRun, addRunEvent } = await import("../src/agents/runs.ts");
  const { policyUsage } = await import("../src/agents/ai-policy.ts");
  const { run: sql } = await import("../src/core/db.ts");
  const ids = ["ingest", "archive", "ask"].map(kind => createRun(app, { kind: kind as "ingest" | "archive" | "ask", title: kind }).id);
  for (const id of ids) addRunEvent(app, id, "status", { choice: { current: "first · gemini-neon", picked: "second · gpt-sol · low" } });
  sql(app.db, "update run_events set at='2000-01-01' where run_id=?", ids[2]);
  expect(policyUsage(app)).toEqual([{ class: "routine", profile: "second", model: "gpt-sol", effort: "low", count: 2 }]);
  app.db.close();
});
