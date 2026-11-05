import { resolve } from "node:path";
import { expect, it } from "vitest";
import { runRole } from "../src/agents/runner.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { testApp } from "./helpers.ts";

it("moves a role run to the next backend when the first fails before doing anything", async () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  // A backend that cannot get going: its process says why and exits, as a CLI whose local environment failed would.
  app.config.agents.profiles.push({ id: "broken", name: "broken", transport: "acp", command: process.execPath, args: ["-e", "console.error('Local execution environment preparation failed: ENVIRONMENT_ERROR.'); process.exit(1)"], env: {}, idleTimeoutMs: 20000 });
  app.config.agents.profiles.push({ id: "spare", name: "spare", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" }, idleTimeoutMs: 60000 });
  app.config.agents.default = "broken";
  app.config.agents.fallback = [{ profile: "spare" }];
  const events: AgentEvent[] = [];
  const r = await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结一下", onEvent: (e) => events.push(e) });
  expect(r.profileId).toBe("spare");
  expect(events.some((e) => e.type === "status" && /没有开始工作就失败了/.test(e.text) && /spare/.test(e.text))).toBe(true);
  // With nothing to fall back to, the first failure is what the run reports.
  app.config.agents.fallback = [];
  await expect(runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "再总结" })).rejects.toThrow();
}, 60_000);
