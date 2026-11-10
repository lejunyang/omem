import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { runEvents, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
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

  it("answers a conversation turn on the fallback, and starts the next turn there", async () => {
    const home = mkdtempSync(join(tmpdir(), "omem-quota-"));
    const agent = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread", ...env } });
    writeFileSync(join(home, "config.json"), JSON.stringify({ agents: { default: "spent", fallback: [{ profile: "spare" }], profiles: [agent("spent", { FAKE_QUOTA: "1" }), agent("spare", {})] } }));
    const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
    try {
      const turn = async (text: string) => {
        const { runId } = await receive(app, { channel: "web", chatId: "quota", text, mergeMs: 0 });
        const r = await waitForRun(app, runId!);
        expect(r.error).toBeNull();
        return runEvents(app, runId!).filter((e) => e.type === "status").map((e) => String((e.data as { text?: string }).text ?? ""));
      };
      const first = await turn("你好");
      expect(first.some((t) => /spent 的额度用完了/.test(t))).toBe(true);
      expect(first.some((t) => /改用 spare/.test(t))).toBe(true);
      releaseAll();
      const second = await turn("再问一句");
      expect(second.some((t) => /额度用完了/.test(t))).toBe(false);
    } finally {
      releaseAll();
      server.close();
    }
  }, 60_000);
});
