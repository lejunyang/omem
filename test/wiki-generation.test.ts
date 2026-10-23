import { resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, listRuns, startWorker, waitForRun } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { one } from "../src/core/db.ts";
import { createSpace, relateSpaces } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { importText } from "../src/sources/import.ts";
import { generateWiki } from "../src/wiki/generate.ts";
import { pageExists } from "../src/wiki/store.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
for (const id of ["project", "materials", "excluded"]) createSpace(app, { id, name: id, kind: "project" });
relateSpaces(app, "project", "materials", { origin: "owner" });
relateSpaces(app, "project", "excluded", { origin: "owner" });
createUser(app, { id: "reader", name: "读者" });
addMember(app, "project", "reader", "editor");
addMember(app, "materials", "reader", "reader");
// The caller can read excluded, but did not include it in this generation.
addMember(app, "excluded", "reader", "reader");
importText(app, "materials", { uri: "README.md", text: "项目 A 的示例材料" });
app.config.agents.default = "fake";
app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "wiki" } })];
const server = await startServer(app, { port: 0, quiet: true });
afterAll(() => server.close());
const ctx: ToolContext = { app, runId: null, spaceId: "project", spaces: ["project", "materials"], writable: ["project"], tools: new Set(["generate_wiki", "read_run"]), actor: "agent", userId: "reader" };

it("rejects inaccessible inputs, read-only targets and missing tool permissions before enqueueing", async () => {
  for (const [context, args] of [
    [ctx, { space: "materials" }],
    [ctx, { source_spaces: ["excluded"] }],
    [{ ...ctx, spaces: null, writable: undefined }, { space: "personal" }],
    [{ ...ctx, tools: new Set() }, {}],
    [ctx, { space: "missing" }],
  ] as [ToolContext, Record<string, unknown>][]) {
    expect((await callTool(context, "generate_wiki", args)).isError).toBe(true);
  }
  expect(listRuns(app)).toHaveLength(0);
});

it("runs planning and writing through ACP/MCP, preserving requirements, user and read/write boundaries", async () => {
  const origin = createRun(app, { kind: "ask", spaceId: "project", title: "发起问答" });
  app.db.prepare("update runs set status = 'done' where id = ?").run(origin.id);
  const focus = "当前代码优先，旧文档需辨别，使用流程图，草稿只作线索。";
  const receipt = await callTool({ ...ctx, runId: origin.id }, "generate_wiki", { focus, source_spaces: ["materials"] });
  expect(receipt.isError).toBe(false);
  expect(receipt.text).toContain("尚未生成完成");
  const plan = listRuns(app, { parentId: origin.id })[0];
  expect(plan).toMatchObject({ kind: "wiki-plan", input: { focus, autoWrite: true, readSpaces: ["project", "materials"] } });
  startWorker(app);
  const planned = await waitForRun(app, plan.id);
  expect(planned.status, planned.error ?? "").toBe("done");
  const children = listRuns(app, { parentId: plan.id });
  expect(children).toHaveLength(1);
  const written = await waitForRun(app, children[0].id);
  expect(written.status, written.error ?? "").toBe("done");
  expect(written.input).toMatchObject({ instructions: focus, readSpaces: ["project", "materials"] });
  for (const run of [planned, written]) {
    expect(one<{ user_id: string }>(app.db, "select user_id from runs where id = ?", run.id)?.user_id).toBe("reader");
    const result = JSON.parse(String(run.output.summary));
    expect(result.prompt).toContain(focus);
    expect(result.read.isError).not.toBe(true);
    expect(result.blockedRead.isError).toBe(true);
    expect(result.blockedWrite.isError).toBe(true);
    expect(result.written.isError).not.toBe(true);
  }
  expect(pageExists(app, "project", "index")).toBe(true);
  expect(pageExists(app, "project", "overview")).toBe(true);
  expect(pageExists(app, "materials", "forbidden")).toBe(false);
  expect((await callTool(ctx, "read_run", { run_id: plan.id })).text).toContain(`[wiki-write/done]`);
}, 60000);

it("supports plan-only HTTP and CLI entry with the same scope defaults", async () => {
  const response = await server.inject({ method: "POST", url: "/api/wiki/project/plan", payload: { focus: "只规划", autoWrite: false } });
  expect(response.statusCode).toBe(200);
  const web = response.json();
  const cli = generateWiki(app, { spaceId: "project", focus: "只规划", autoWrite: false });
  expect(web.input).toEqual(cli.input);
  for (const queued of [web, cli]) {
    const plan = await waitForRun(app, queued.id);
    expect(plan.status, plan.error ?? "").toBe("done");
    expect(listRuns(app, { parentId: plan.id })).toHaveLength(0);
  }
}, 60000);

it("exposes the entry to the assistant, keeps writers separate, and rejects a removed target scope", () => {
  const assistant = prepareRun(app, { actor: { role: "assistant" }, spaceId: "project", runId: null });
  expect(assistant.system).toContain("generate_wiki");
  expect(() => prepareRun(app, { actor: { role: "wiki-writer" }, spaceId: "project", runId: null, spaces: ["project"], readScope: ["materials"] })).toThrow("不能访问");
});
