import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/core/config.ts";
import { acquire } from "../src/agents/capacity.ts";
import { claudeRateLimitEvent, noteRateLimit, parseClaudeUsage, parseCodexRateLimits, parseResetText, perDayLeft, quotaAvoid, quotaEvents, quotaView } from "../src/agents/quota.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { testApp } from "./helpers.ts";

const p = (id: string, model?: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({ id, transport: "acp", command: id, args: [], env: {}, idleTimeoutMs: 1000, model, ...extra });
const HOUR = 3_600_000;

describe("plan usage limits", () => {
  it("reads Codex windows by their length, not their slot", () => {
    // A Pro plan: only the weekly window, in the primary slot.
    const pro = parseCodexRateLimits({
      rateLimits: { limitId: "codex", primary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: 1794596532 }, secondary: null, planType: "pro" },
      rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 72, windowDurationMins: 10080, resetsAt: 1794596532 }, secondary: null, planType: "pro" } },
    });
    expect(pro.plan).toBe("pro");
    expect(pro.windows).toEqual([{ name: "7d", usedPercent: 72, windowMinutes: 10080, resetsAt: new Date(1794596532 * 1000).toISOString() }]);
    // A plan with a 5-hour window, and a model counted on its own.
    const plus = parseCodexRateLimits({
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1794000000 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1794500000 }, planType: "plus" },
        spark: { limitId: "spark", limitName: "GPT-Spark", primary: { usedPercent: 5, windowDurationMins: 10080 }, secondary: null },
      },
    });
    expect(plus.windows.map((w) => [w.name, w.usedPercent, w.model])).toEqual([["5h", 40, undefined], ["7d", 10, undefined], ["7d · GPT-Spark", 5, "gpt-spark"]]);
  });

  it("reads Claude's /usage answer", () => {
    const now = new Date("2026-11-09T06:00:00Z");
    const text = [
      "## Usage", "", "> Claude max subscription usage", "", "### Limits", "",
      "**5-hour limit** — **42%** · Resets Nov 9, 3:00 PM GMT+8", "", "`████████░░░░░░░░░░░░`", "",
      "**Weekly · all models** — **18%** · Resets Nov 13, 9:00 AM GMT+8", "", "`████░░░░░░░░░░░░░░░░`", "",
      "**Weekly · Opus** — **30%**",
    ].join("\n");
    const r = parseClaudeUsage(text, now);
    expect(r.plan).toBe("max");
    expect(r.windows).toEqual([
      { name: "5h", windowMinutes: 300, usedPercent: 42, resetsAt: "2026-11-09T07:00:00.000Z" },
      { name: "7d", windowMinutes: 10080, usedPercent: 18, resetsAt: "2026-11-13T01:00:00.000Z" },
      { name: "7d · Opus", windowMinutes: 10080, model: "opus", usedPercent: 30 },
    ]);
    // Claude Code's own text when the adapter falls back to it.
    expect(parseClaudeUsage("Current session\n███ 12% used\nResets 3pm\n\nCurrent week (all models)\n██ 40% used", now).windows.map((w) => [w.name, w.usedPercent])).toEqual([["5h", 12], ["7d", 40]]);
    // A reset date in early January read in late December is next year's.
    expect(parseResetText("Jan 2, 1:00 AM GMT+0", new Date("2026-12-30T00:00:00Z"))).toBe("2027-01-02T01:00:00.000Z");
  });

  it("keeps the events a turn reports, and puts a nearly spent account after the others", async () => {
    const app = testApp();
    const claude = p("claude"), codex = p("codex");
    expect(claudeRateLimitEvent({ status: "allowed", rateLimitType: "five_hour", utilization: 0.95, resetsAt: Math.floor((Date.now() + 2 * HOUR) / 1000) })).toMatchObject({ type: "rate-limit", window: "five_hour", usedPercent: 95 });
    expect(claudeRateLimitEvent({ status: "allowed", rateLimitType: "overage" })).toBeNull();
    const passed: AgentEvent[] = [];
    const emit = quotaEvents(app, claude, (e) => passed.push(e));
    emit(claudeRateLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.95, resetsAt: Math.floor((Date.now() + 2 * HOUR) / 1000) })!);
    emit({ type: "status", text: "x" });
    expect(passed).toEqual([{ type: "status", text: "x" }]);
    expect(quotaAvoid(app, claude)).toMatch(/5h 已用 95%/);
    expect(quotaView(app, claude)?.windows[0]).toMatchObject({ name: "5h", used: 95 });
    const slot = await acquire(app, [claude, codex], { runId: null });
    expect(slot.index).toBe(1);
    slot.release();
    // Pinned to it alone: it still runs.
    const pinned = await acquire(app, [claude], { runId: null });
    expect(pinned.index).toBe(0);
    pinned.release();
    // 100 turns the threshold off.
    app.config.agents.capacity.quotaAvoidAbove = 100;
    expect(quotaAvoid(app, claude)).toBeNull();
    // An API-key account has no plan limits.
    noteRateLimit(app, p("claude@k", undefined, { source: "key:k", keyRef: "k" }), { type: "rate-limit", window: "five_hour", usedPercent: 99 });
    expect(quotaAvoid(app, p("claude@k", undefined, { source: "key:k", keyRef: "k" }))).toBeNull();
  });

  it("weighs a weekly window by what is left per day until it resets", () => {
    const app = testApp();
    const claude = p("claude", "claude-opus-5-5");
    const in3days = new Date(Date.now() + 3 * 24 * HOUR).toISOString();
    noteRateLimit(app, claude, { type: "rate-limit", window: "seven_day", usedPercent: 80, resetsAt: in3days });
    expect(perDayLeft({ name: "7d", usedPercent: 80, windowMinutes: 10080, resetsAt: in3days })).toBeCloseTo(20 / 3, 1);
    expect(quotaAvoid(app, claude)).toBeNull();
    app.config.agents.capacity.quotaPerDayBelow = 10;
    expect(quotaAvoid(app, claude)).toMatch(/7d 剩 20%/);
    // A window for another model family does not count against this one.
    app.config.agents.capacity.quotaPerDayBelow = 0;
    noteRateLimit(app, claude, { type: "rate-limit", window: "seven_day_sonnet", usedPercent: 99, resetsAt: in3days });
    expect(quotaAvoid(app, claude)).toBeNull();
    expect(quotaAvoid(app, p("claude", "claude-sonnet-5-5"))).toMatch(/Sonnet 已用 99%/);
    // An event without the share keeps the last one for the same window; a passed reset is not counted.
    noteRateLimit(app, claude, { type: "rate-limit", window: "seven_day_sonnet", resetsAt: in3days });
    expect(quotaView(app, claude)?.windows.find((w) => w.name === "7d · Sonnet")?.used).toBe(99);
    noteRateLimit(app, claude, { type: "rate-limit", window: "five_hour", usedPercent: 99, resetsAt: new Date(Date.now() - HOUR).toISOString() });
    expect(quotaView(app, claude)?.windows.some((w) => w.name === "5h")).toBe(false);
  });
});
