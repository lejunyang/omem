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
});
