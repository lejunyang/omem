import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { runEvents, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { getThread, updateThread } from "../src/agents/threads.ts";
import { boot } from "../src/main.ts";
import { clearOutOfQuota, dailyCapReached, excluded, isQuotaMessage, markOutOfQuota, outOfQuotaList, perDayOf, quotaResetAt, usedToday } from "../src/agents/capacity.ts";
import { createRun } from "../src/agents/runs.ts";
import { run } from "../src/core/db.ts";
import { isRetryableAgentError, runRole } from "../src/agents/runner.ts";
import { allProfiles } from "../src/core/config.ts";
import type { AgentEvent } from "../src/agents/types.ts";
import { testApp } from "./helpers.ts";

describe("usage quota", () => {
  it("reads when the quota resets from the provider's message", () => {
    const at = new Date(2026, 10, 4, 10, 30);
    expect(quotaResetAt("You've hit your usage limit. … try again at 2:36 PM.", at)).toEqual(new Date(2026, 10, 4, 14, 36));
    // Earlier than now: tomorrow.
    expect(quotaResetAt("try again at 9:05 AM.", at)).toEqual(new Date(2026, 10, 5, 9, 5));
    expect(quotaResetAt("try again at Nov 6th, 2026 2:36 PM.", at)).toEqual(new Date(2026, 10, 6, 14, 36));
    expect(quotaResetAt("try again in 2 hours 5 minutes.", at)).toEqual(new Date(2026, 10, 4, 12, 35));
    expect(quotaResetAt("⚠ Individual quota reached. Resets in 1h9m34s.", at)).toEqual(new Date(2026, 10, 4, 11, 39, 34));
    // Nothing usable: an hour.
    expect(quotaResetAt("You've hit your usage limit.", at)).toEqual(new Date(2026, 10, 4, 11, 30));
    expect(isRetryableAgentError(new Error("Internal error：{\"codexErrorInfo\":\"usageLimitExceeded\"}"))).toBe(true);
  });

  it("leaves out only the model whose own daily limit was reached, until the owner's next midnight", () => {
    const app = testApp();
    app.config.timezone = "Asia/Shanghai";
    const base = { transport: "acp" as const, command: "x", args: [], env: {}, idleTimeoutMs: 1000 };
    const big = { ...base, id: "acct", model: "big-model" };
    const small = { ...base, id: "acct", model: "small-model" };
    for (const text of ["Daily limit reached for this model", "该模型今日额度已用完，请明天再试", "今日调用次数已达上限", "model big-model: per-day quota exhausted"]) expect(isQuotaMessage(text)).toBe(true);
    expect(isQuotaMessage("rate limit, slow down")).toBe(false);
    // 2026-11-10 15:00 in Shanghai (07:00 UTC): the day ends at 16:00 UTC.
    const at = new Date(Date.UTC(2026, 10, 10, 7, 0));
    expect(quotaResetAt("该模型今日额度已用完", at, "Asia/Shanghai").toISOString()).toBe("2026-11-10T16:00:00.000Z");
    // A time in the message still wins.
    expect(quotaResetAt("daily limit reached, try again in 2 hours", at, "Asia/Shanghai").toISOString()).toBe("2026-11-10T09:00:00.000Z");
    markOutOfQuota(app, big, "该模型今日额度已用完");
    expect(excluded(app, big)).toBe(true);
    expect(excluded(app, small)).toBe(false);
    expect(outOfQuotaList(app)[0]).toMatchObject({ source: "acct|big-model", account: "acct", model: "big-model" });
    clearOutOfQuota(app, "acct|big-model");
    expect(excluded(app, big)).toBe(false);
  });

  it("keeps a model under the owner's own cap per day, counted from the runs that used it today", () => {
    const app = testApp();
    app.config.timezone = "Asia/Shanghai";
    app.config.agents.profiles.push({ id: "acct", name: "acct", transport: "acp", command: "x", args: [], env: {}, idleTimeoutMs: 1000, model: "big-model" });
    app.config.agents.capacity.limits = [{ profile: "acct", model: "big-model", max: 3, perDay: 2 }];
    const big = allProfiles(app.config).find((p) => p.id === "acct")!;
    expect(perDayOf(app, big)).toBe(2);
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      const r = createRun(app, { kind: "ingest", spaceId: "personal", title: `第 ${i} 次`, input: {} });
      run(app.db, "update runs set ai = ?, started_at = ? where id = ?", JSON.stringify({ profile: "acct", model: "big-model" }), new Date(now - 1000).toISOString(), r.id);
    }
    expect(usedToday(app, big, now)).toBe(2);
    expect(dailyCapReached(app, big, now)).toContain("每天 2 次");
    expect(excluded(app, big)).toBe(true);
    // Another model of the same backend is not capped.
    expect(excluded(app, { ...big, model: "small-model" })).toBe(false);
  });

  it("moves a run to the fallback when the account is out of quota, and leaves the account out until it resets", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    const agent = (id: string, env: Record<string, string>) => app.config.agents.profiles.push({ id, name: id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", ...env }, idleTimeoutMs: 60000, model: "m1" });
    agent("spent", { FAKE_QUOTA: "1" });
    agent("spare", {});
    app.config.agents.default = "spent";
    app.config.agents.fallback = [{ profile: "spare" }];
    const events: AgentEvent[] = [];
    const first = await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结一下", onEvent: (e) => events.push(e) });
    expect(first.profileId).toBe("spare");
    expect(events.some((e) => e.type === "status" && /spent 的额度用完了/.test(e.text))).toBe(true);
    const spent = allProfiles(app.config).find((p) => p.id === "spent")!;
    expect(excluded(app, spent)).toBe(true);
    expect(outOfQuotaList(app)[0]).toMatchObject({ source: "spent" });
    expect(Date.parse(outOfQuotaList(app)[0].until) - Date.now()).toBeGreaterThan(110 * 60_000);
    // The next run goes to the fallback directly, without trying the spent account again.
    const later: AgentEvent[] = [];
    expect((await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "再总结", onEvent: (e) => later.push(e) })).profileId).toBe("spare");
    expect(later.some((e) => e.type === "status" && /额度用完了/.test(e.text))).toBe(false);
    clearOutOfQuota(app, "spent");
    expect(excluded(app, spent)).toBe(false);
  }, 60_000);

  it.each(["1", "text", "text-split"])("answers a conversation turn on the fallback (%s quota signal), and starts the next turn there", async (quotaSignal) => {
    const home = mkdtempSync(join(tmpdir(), "omem-quota-"));
    const agent = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", ...env } });
    writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { default: "spent", fallback: [{ profile: "spare" }], profiles: [agent("spent", { FAKE_QUOTA: quotaSignal }), agent("spare", {})] } }));
    const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
    try {
      const turn = async (text: string) => {
        const { runId } = await receive(app, { channel: "web", chatId: "quota", text, mergeMs: 0 });
        const r = await waitForRun(app, runId!);
        expect(r.error).toBeNull();
        expect(r.ai?.profile).toBe("spare");
        expect(JSON.parse(String(r.output.answer)).msgs).toContain(text);
        return runEvents(app, runId!).filter((e) => e.type === "status").map((e) => String((e.data as { text?: string }).text ?? ""));
      };
      const first = await turn("你好");
      expect(first.some((t) => /spent 的额度用完了/.test(t))).toBe(true);
      expect(first.some((t) => /改用 spare/.test(t))).toBe(true);
      expect(outOfQuotaList(app)[0]).toMatchObject({ source: "spent" });
      releaseAll();
      const second = await turn("再问一句");
      expect(second.some((t) => /额度用完了/.test(t))).toBe(false);
    } finally {
      releaseAll();
      server.close();
    }
  }, 60_000);

  it.each(["auto", "pinned", "no alternative"])("checks cached quota before continuing an existing conversation (%s)", async (selection) => {
    const home = mkdtempSync(join(tmpdir(), "omem-quota-"));
    const agent = (id: string) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" } });
    const primary = { ...agent("primary"), source: "antigravity", model: "m1" };
    writeFileSync(join(home, "config.json"), JSON.stringify({ agents: {
      default: "primary", profiles: [primary, agent("spare")], routing: { automatic: false }, capacity: { quotaAvoidAbove: 95 },
    } }));
    const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
    try {
      const turn = async (text: string) => {
        const { runId, thread } = await receive(app, { channel: "web", chatId: "quota-continue", text, mergeMs: 0 });
        const result = await waitForRun(app, runId!);
        expect(result.error).toBeNull();
        return { result, threadId: thread.id, answer: JSON.parse(String(result.output.answer)), events: runEvents(app, runId!) };
      };
      const setQuota = (usedPercent: number) => {
        const at = new Date().toISOString();
        const windows = [{ name: "Gemini Models · 5h", models: ["m1"], usedPercent }];
        run(app.db, "insert or replace into kv(key,value) values ('agent_quota', ?)", JSON.stringify({ antigravity: { at, via: "antigravity-usage", windows } }));
      };
      setQuota(62);
      const first = await turn("第一轮");
      expect(first.result.ai?.profile).toBe("primary");
      const settings = getThread(app, first.threadId).settings;
      updateThread(app, first.threadId, { settings: selection === "pinned" ? { ...settings, profile: "primary" } : { ...settings, auto: { profile: "primary", model: "m1" } } });
      if (selection !== "no alternative") app.config.agents.default = "spare";
      setQuota(97.6);
      const next = await turn("继续核对");
      if (selection === "auto") {
        expect(next.result.ai?.profile).toBe("spare");
        expect(next.answer).toMatchObject({ cold: true, turn: 1 });
        expect(next.events.find((event) => event.type === "status" && "failover" in (event.data as object))?.data)
          .toMatchObject({ failover: { why: "Gemini Models · 5h 已用 98%" } });
        expect((await turn("再次追问")).answer.session).toBe(next.answer.session);
      } else {
        expect(next.result.ai?.profile).toBe("primary");
        expect(next.answer).toMatchObject({ session: first.answer.session, turn: 2 });
      }
    } finally {
      releaseAll();
      server.close();
    }
  }, 60_000);
});
