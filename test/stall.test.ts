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
    const err = await runAcp(fake({ FAKE_STALL: "before" }), { cwd: process.cwd(), prompt: "hi" }, (e) => events.push(e)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/没有开始回答/);
    expect(isRetryableAgentError(err)).toBe(true);
    // The traex skills notice becomes a status line, not answer text.
    expect(events.some((e) => e.type === "text" && /Skill descriptions/.test(e.text))).toBe(false);
    expect(events.some((e) => e.type === "status" && /Skill descriptions/.test(e.text))).toBe(true);
  }, 20_000);

  it("does not retry a turn that stalled after real output", async () => {
    const err = await runAcp(fake({ FAKE_STALL: "after" }), { cwd: process.cwd(), prompt: "hi" }, () => {}).catch((e) => e);
    expect(String(err.message)).toMatch(/没有任何活动/);
    expect(isRetryableAgentError(err)).toBe(false);
  }, 20_000);

  it("keeps waiting while the provider reports a queue longer than the idle budget", async () => {
    const events: AgentEvent[] = [];
    const r = await runAcp(fake({ FAKE_QUEUE: "2500" }, 1000), { cwd: process.cwd(), prompt: "hi", queueTimeoutMs: 10_000 }, (e) => events.push(e));
    expect(r.text).toBe("queued-ok");
    expect(events.some((e) => e.type === "queue" && e.queued)).toBe(true);
  }, 20_000);
});
