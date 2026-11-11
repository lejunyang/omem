import { expect, it, vi } from "vitest";

const seen: { addTools?: string[]; task?: string }[] = [];
vi.mock("../src/agents/runner.ts", async (orig) => ({
  ...(await orig<typeof import("../src/agents/runner.ts")>()),
  runRole: vi.fn(async (_app: unknown, input: { addTools?: string[]; task?: string }) => {
    seen.push({ addTools: input.addTools, task: input.task });
    return { text: "做完了", profileId: "fake", agent: "fake" };
  }),
}));

const { __testHandlers: handlers, createRun, getRun } = await import("../src/agents/runs.ts");
await import("../src/agents/jobs.ts");
const { createThread } = await import("../src/agents/threads.ts");
const { saveAgentSpec } = await import("../src/agents/specs.ts");
const { testApp } = await import("./helpers.ts");

it("a round's run gets the tools lent to it, minus what the run is denied, and is told so", async () => {
  const app = testApp();
  saveAgentSpec(app, { name: "sheet-z", description: "整理表格", prompt: "只整理", status: "active" }, "user");
  const root = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const r = createRun(app, { kind: "agent", spaceId: "personal", title: "整理", input: { spec: "sheet-z", task: "整理", threadId: root.id, extraTools: ["lark_read", "search"], denyTools: ["search"] } });
  await handlers.get("agent")!({ app, run: getRun(app, r.id), signal: new AbortController().signal, event: () => {} } as never);
  expect(seen[0].addTools).toContain("lark_read");
  expect(seen[0].addTools).not.toContain("search");
  expect(seen[0].task).toContain("临时借给你的工具（只在这一轮可用）：lark_read");
  app.db.close();
});
