import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { runEvents, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { boot } from "../src/main.ts";
import { clearOutOfQuota, excluded, outOfQuotaList, quotaResetAt } from "../src/agents/capacity.ts";
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
