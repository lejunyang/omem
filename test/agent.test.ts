import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ask } from "../src/agents/jobs.ts";
import { runEvents, waitForRun } from "../src/agents/runs.ts";
import { listMemories } from "../src/memory/store.ts";
import { importText } from "../src/sources/import.ts";
import { boot } from "../src/main.ts";

describe("agent loop over ACP + MCP bridge", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-agent-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")] }] } }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());

  it("answers with tools, records events and writes a memory through the bridge", async () => {
    importText(app, "personal", { title: "约定", text: "每周四下午三点和小王同步项目A进度。" });
    const { runId, conversationId } = await ask(app, { text: "和小王什么时候同步" });
    const run = await waitForRun(app, runId!);
    expect(run.error).toBeNull();
    expect(run.status).toBe("done");
    const answer = (run.output as { answer: string }).answer;
    expect(answer).toMatch(/^tools=\d+; search=1\. 原件/);
    expect(listMemories(app, {}).map((m) => m.content)).toContain("FAKE: 和小王什么时候同步");
    const types = runEvents(app, runId!).map((e) => e.type);
    expect(types).toContain("tool");
    expect(types).toContain("text");
    expect(conversationId).toBeTruthy();
  }, 60000);

  it("lets one agent consult another: a visible child run, answered inline, that cannot hand work on", async () => {
    const { saveAgentSpec } = await import("../src/agents/specs.ts");
    const { callTool } = await import("../src/agents/tools.ts");
    const { createRun, getRun, listRuns } = await import("../src/agents/runs.ts");
    saveAgentSpec(app, { name: "db-expert", description: "数据库问题", prompt: "回答数据库相关问题。" }, "user");
    const parent = createRun(app, { kind: "agent", spaceId: "personal", title: "调查", input: { spec: "x", task: "t", inline: true } });
    // Keep the worker away from the stand-in parent.
    app.db.prepare("update runs set status = 'done' where id = ?").run(parent.id);
    const r = await callTool({ app, runId: parent.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner", spec: "investigator" }, "ask_agent", { name: "db-expert", question: "和小王什么时候同步" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^db-expert 的回答（运行 r/);
    const child = listRuns(app, { parentId: parent.id })[0];
    expect(child).toMatchObject({ kind: "agent", status: "done" });
    expect((child.input as { consultOf?: string }).consultOf).toBe(parent.id);
    expect(String((getRun(app, child.id).output as { answer?: string }).answer)).toMatch(/^tools=/);
    // Specs (and the main assistant) may consult; a consulted run is denied consulting and handing work on.
    const { prepareRun } = await import("../src/agents/runner.ts");
    const { readAgentSpec } = await import("../src/agents/specs.ts");
    const { toolContextForToken } = await import("../src/agents/tools.ts");
    const toolsOf = (deny?: string[]) => toolContextForToken(app, prepareRun(app, { actor: { spec: readAgentSpec(app, "db-expert") }, spaceId: "personal", runId: null, denyTools: deny }).token)!.tools!;
    expect(toolsOf().has("ask_agent")).toBe(true);
    expect(toolsOf(["ask_agent", "run_agent"]).has("ask_agent")).toBe(false);
  }, 60000);
});
