import { afterEach, expect, it } from "vitest";
import { shellToolRuns } from "../src/agents/doubao-cli.ts";
import { createRun, runEvents } from "../src/agents/runs.ts";
import { issueToolToken } from "../src/agents/tools.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { shellToolRuns.clear(); for (const app of apps.splice(0)) app.db.close(); });

it("on the Doubao CLI, the omem tools it calls through its shell show as the run's steps", async () => {
  const app = testApp(); apps.push(app);
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
    const call = async (runId: string) => {
      const token = issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" });
      await fetch(`${base}/api/tools/omem_help`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    };
    const doubao = createRun(app, { kind: "ask", spaceId: "personal", title: "豆包", input: {} });
    shellToolRuns.add(doubao.id);
    await call(doubao.id);
    const steps = runEvents(app, doubao.id).filter((e) => e.type === "tool");
    expect(steps.map((e) => (e.data as { status: string }).status)).toEqual(["in_progress", "completed"]);
    expect((steps[0].data as { title: string }).title).toBe("omem_help");
    // Other backends report their own tool steps: only the trace is added.
    const acp = createRun(app, { kind: "ask", spaceId: "personal", title: "acp", input: {} });
    await call(acp.id);
    expect(runEvents(app, acp.id).map((e) => e.type)).toEqual(["tool-call", "tool-call"]);
  } finally { await server.close(); }
});
