import { afterEach, expect, it } from "vitest";
import { toolOutput } from "../src/agents/acp.ts";
import { addRunEvent, createRun, flushRunText } from "../src/agents/runs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });

it("read_run shows what a run did: omem's answers to permission requests, each command and its output, and what was still going at the end", async () => {
  const app = testApp(); apps.push(app);
  const r = createRun(app, { kind: "agent", spaceId: "personal", title: "核验", input: {} });
  addRunEvent(app, r.id, "status", { text: "允许操作：Run command" });
  addRunEvent(app, r.id, "tool", { id: "t1", title: "query employee", status: "in_progress" });
  addRunEvent(app, r.id, "tool", { id: "t1", title: "query employee", status: "completed", output: "Status: 7" });
  addRunEvent(app, r.id, "tool", { id: "t2", title: "duty plan get", status: "in_progress" });
  addRunEvent(app, r.id, "text", { text: "账号查询仍在等命令执行许可" });
  flushRunText(app, r.id);
  run(app.db, "update runs set status = 'done' where id = ?", r.id);
  const ctx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
  const text = (await callTool(ctx, "read_run", { run_id: r.id })).text;
  expect(text).toContain("宿主允许操作：Run command（omem 当场回答");
  expect(text).toContain("query employee：完成");
  expect(text).toContain("输出末尾：Status: 7");
  expect(text).toContain("duty plan get：运行结束时还没跑完");
});

it("keeps the end of what a finished command printed", () => {
  expect(toolOutput([{ type: "content", content: { type: "text", text: "hi" } }], undefined)).toBe("hi");
  expect(toolOutput([], { stdout: "out" })).toBe("out");
  expect(toolOutput(undefined, "x".repeat(5000))).toHaveLength(3001);
});
