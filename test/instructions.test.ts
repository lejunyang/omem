import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRole } from "../src/agents/runner.ts";
import { createRun } from "../src/agents/runs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0)) await f(); });

type Echo = { session: string; resumed: boolean; system: string | null; prompt: string };

async function setup(env: Record<string, string>) {
  const app = testApp();
  app.config.agents.default = "fake";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "echo", ...env } })];
  const server = await startServer(app, { port: 0, quiet: true });
  cleanups.push(() => server.close());
  return async (task: string, resumeSessionId?: string) => {
    const run = createRun(app, { kind: "code", spaceId: "personal", title: "测试交办" });
    const r = await runRole(app, { role: "coder", spaceId: "personal", task, runId: run.id, resumeSessionId, persistSession: true });
    return JSON.parse(r.text) as Echo;
  };
}

describe("standing instructions", () => {
  it("open a new session and are not repeated into a resumed one", async () => {
    const turn = await setup({});
    const first = await turn("实现退款按钮");
    expect(first).toMatchObject({ resumed: false, system: null });
    expect(first.prompt).toContain("# 角色：");
    expect(first.prompt).toMatch(/（现在：.+）\n\n# 任务\n\n实现退款按钮/);
    const next = await turn("按评审修改：补上测试", first.session);
    expect(next).toMatchObject({ session: first.session, resumed: true });
    expect(next.prompt).not.toContain("# 角色：");
    expect(next.prompt).toContain("按评审修改：补上测试");
  }, 60000);

  it("go in as the system prompt when the agent takes one, without the clock", async () => {
    const turn = await setup({ FAKE_SYSTEM: "1" });
    const first = await turn("实现退款按钮");
    expect(first.system).toContain("# 角色：");
    expect(first.system).not.toMatch(/现在：/);
    expect(first.prompt).not.toContain("# 角色：");
    expect(first.prompt).toContain("实现退款按钮");
    // Sent again on resume (some agents set it per process), still not in the message.
    const next = await turn("按评审修改：补上测试", first.session);
    expect(next).toMatchObject({ session: first.session, resumed: true, system: first.system });
    expect(next.prompt).not.toContain("# 角色：");
  }, 60000);
});
