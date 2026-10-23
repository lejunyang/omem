import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseBackgroundSessions } from "../src/agents/background-sessions.ts";
import { codexArgs, claudeArgs } from "../src/agents/cli.ts";
import { runRole, type RoleRunInput } from "../src/agents/runner.ts";
import { createRun } from "../src/agents/runs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await releaseBackgroundSessions(); for (const f of cleanups.splice(0)) await f(); });

async function setup(usage = "200,600,601", delay = "0") {
  const app = testApp();
  const log = join(app.home, "deleted.txt");
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "background", FAKE_USAGE: usage, FAKE_DELAY: delay, FAKE_DELETE_LOG: log } });
  app.config.agents.default = "fake";
  app.config.agents.profiles = [profile];
  const server = await startServer(app, { port: 0, quiet: true });
  cleanups.push(() => server.close());
  const invoke = async (extra: Partial<RoleRunInput> = {}) => {
    const run = createRun(app, { kind: "ingest", spaceId: extra.spaceId ?? "personal", title: "测试材料整理" });
    const result = await runRole(app, { role: "ingest", spaceId: "personal", task: "读取本轮材料", runId: run.id, reuseSession: true, ...extra });
    return { ...JSON.parse(result.text), runId: run.id, contextUsage: result.contextUsage } as { session: string; turn: number; prompt: string; runId: string; contextUsage?: { used: number; size: number } };
  };
  const deleted = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { app, invoke, deleted, profile };
}

describe("background sessions", () => {
  it("reuses instructions and MCP scope, attributes tools to each run, rotates above 60%", async () => {
    const { app, invoke, deleted } = await setup();
    const first = await invoke();
    const second = await invoke({ task: "第二份材料" });
    const third = await invoke();
    const fourth = await invoke();
    expect(first.prompt).toContain("# 角色：");
    expect(second).toMatchObject({ session: first.session, turn: 2, contextUsage: { used: 600, size: 1000 } });
    expect(second.prompt).not.toContain("# 角色：");
    expect(second.prompt).toContain("第二份材料");
    expect(third.session).toBe(first.session);
    expect(deleted()).toContain(first.session);
    expect(fourth.session).not.toBe(first.session);
    expect(fourth.prompt).toContain("# 角色：");
    const calls = all<{ run_id: string }>(app.db, "select run_id from memory_rejections where tool = 'remember' order by rowid");
    expect(calls.map((c) => c.run_id)).toEqual([first.runId, second.runId, third.runId, fourth.runId]);
  }, 60000);

  it("does not reuse missing usage or an explicitly disabled pool", async () => {
    const { app, invoke, deleted } = await setup("");
    const first = await invoke();
    const second = await invoke();
    expect(second.session).not.toBe(first.session);
    expect(deleted()).toEqual([first.session, second.session]);
    app.config.sessions.background.enabled = false;
    const third = await invoke();
    expect(deleted()).toContain(third.session);
  }, 60000);

  it("separates roles, permissions and model changes; never shares a busy session", async () => {
    const { app, invoke, profile } = await setup("200", "80");
    const first = await invoke();
    const [a, b] = await Promise.all([invoke(), invoke()]);
    expect(a.session).not.toBe(b.session);
    const limited = await invoke({ denyTools: ["remember"] });
    expect(limited.session).not.toBe(first.session);
    const role = await invoke({ role: "heartbeat" });
    expect(role.session).not.toBe(first.session);
    profile.model = "another-model";
    const model = await invoke();
    expect(model.session).not.toBe(first.session);
    const space = createSpace(app, { id: "project-a", name: "项目 A", kind: "project" });
    const other = await invoke({ spaceId: space.id });
    expect(other.session).not.toBe(model.session);
  }, 60000);

  it("releases idle sessions, respects capacity, and preserves explicit resumable runs", async () => {
    const { app, invoke, deleted } = await setup("200");
    app.config.sessions.background.maxLive = 1;
    const first = await invoke();
    const second = await invoke({ role: "heartbeat" });
    expect(deleted()).toContain(first.session);
    await releaseBackgroundSessions(app);
    expect(deleted()).toContain(second.session);
    const persisted = await invoke({ persistSession: true });
    expect(deleted()).not.toContain(persisted.session);
    app.config.sessions.background.liveMinutes = 0.0001;
    const short = await invoke();
    await new Promise((r) => setTimeout(r, 100));
    expect(deleted()).toContain(short.session);
  }, 60000);

  it("requests CLI temporary sessions only for non-resumable runs", () => {
    const profile = agentProfileSchema.parse({ id: "cli", transport: "codex-cli", command: "codex" });
    const req = { cwd: ".", prompt: "测试" };
    expect(codexArgs(profile, req)).toContain("--ephemeral");
    expect(claudeArgs(profile, req)).toContain("--no-session-persistence");
    for (const keep of [{ persistSession: true }, { resumeSessionId: "existing" }]) {
      expect(codexArgs(profile, { ...req, ...keep })).not.toContain("--ephemeral");
      expect(claudeArgs(profile, { ...req, ...keep })).not.toContain("--no-session-persistence");
    }
  });

  it("requires fresh usage each turn and ignores other sessions' measurements", async () => {
    const { invoke, profile, deleted } = await setup("200,none");
    profile.env.FAKE_OTHER_USAGE = "1";
    const first = await invoke();
    const second = await invoke();
    expect(second.session).toBe(first.session);
    expect(second.contextUsage).toBeUndefined();
    expect(deleted()).toContain(first.session);
    expect((await invoke()).session).not.toBe(first.session);
  }, 60000);

  it("discards a cancelled turn and does not reuse its partial context", async () => {
    const { invoke, deleted } = await setup("200", "500");
    const first = await invoke();
    const controller = new AbortController();
    const next = invoke({ signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(next).rejects.toThrow("CANCELLED");
    expect(deleted()).toContain(first.session);
    expect((await invoke()).session).not.toBe(first.session);
  }, 60000);
});
