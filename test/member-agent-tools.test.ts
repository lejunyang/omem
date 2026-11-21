import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { prepareRun, runRole } from "../src/agents/runner.ts";
import { callTool, issueToolToken, revokeToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { startAgentWork, refreshWork } from "../src/agents/agent-work.ts";
import { createThread } from "../src/agents/threads.ts";
import { saveAgentSpec, saveSkill } from "../src/agents/specs.ts";
import { createRun, getRun, runEvents, runUser } from "../src/agents/runs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
const log = join(app.home, "calls.jsonl");
const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath,
  args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "aware", FAKE_TOOL_LOG: log } });
app.config.agents.profiles = [profile];
app.config.agents.default = profile.id;
app.config.agents.fallback = [{ profile: profile.id }];
const spaceId = createSpace(app, { id: "team", name: "项目" }).id;
const server = await startServer(app, { port: 0, quiet: true });
const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
afterAll(async () => { await server.close(); app.db.close(); });

it("offers skill and agent discovery to a contributor without management rights", async () => {
  const userId = createUser(app, { id: "contributor", name: "贡献者" }).id;
  addMember(app, spaceId, userId, "contributor");
  const skill = "review-notes";
  saveSkill(app, { name: skill, description: "核对笔记", body: "逐条核对材料。", status: "active" }, "user");
  const prepared = prepareRun(app, { actor: { role: "assistant" }, userId, spaceId, spaces: [spaceId], runId: null, profile });
  try {
    for (const name of ["list_skills", "read_skill", "list_agents", "list_ai_backends"]) expect(prepared.tools).toContain(name);
    for (const name of ["save_skill", "save_agent"]) expect(prepared.tools).not.toContain(name);
    expect(prepared.system).toContain(skill);
    const ctx = toolContextForToken(app, prepared.token)!;
    expect(await callTool(ctx, "read_skill", { name: skill })).toMatchObject({ isError: false, text: expect.stringContaining("逐条核对材料") });
    app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,'agents.view','global','','deny','0','owner')").run(userId);
    expect(await callTool(ctx, "read_skill", { name: skill })).toMatchObject({ isError: true, deniedCapability: "agents.view" });
  } finally { revokeToolToken(prepared.token); }
});

it("applies the observer's permissions across personal HTTP, MCP and an ACP assistant", async () => {
  const userId = createUser(app, { id: "reader", name: "观察者", role: "observer" }).id;
  addMember(app, spaceId, userId, "reader");
  const headers = { authorization: "Bearer " + createApiToken(app, userId), "x-omem-spaces": spaceId };
  const mcp = async (method: string, params: object) => (await server.inject({ method: "POST", url: "/mcp",
    headers: { ...headers, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method, params } })).json().result;
  const directory = (await server.inject({ url: "/api/tools", headers })).json().tools;
  const mcpNames = (await mcp("tools/list", {})).tools.map((t: {name: string}) => t.name);
  expect(mcpNames).toEqual(directory.map((t: {name: string}) => t.name));
  expect(mcpNames).toContain("list_sources");
  expect(mcpNames).not.toContain("save_note");
  const actions = [{ name: "list_sources", args: { space: spaceId }, denied: false },
    { name: "save_note", args: { space: spaceId, text: "项目材料" }, denied: true }];
  for (const { name, args, denied } of actions) {
    expect((await server.inject({ method: "POST", url: "/api/tools/" + name, headers, payload: args })).json().isError).toBe(denied);
    expect((await mcp("tools/call", { name, arguments: args })).isError).toBe(denied);
  }
  const runId = createRun(app, { kind: "ask", title: "查项目材料", userId, spaceId }).id;
  await runRole(app, { role: "assistant", runId, spaceId, spaces: [spaceId], profileId: profile.id,
    task: actions.map(a => "@call " + a.name + " " + JSON.stringify(a.args)).join("\n") });
  expect(calls()).toEqual(actions.map(a => expect.objectContaining({ name: a.name, isError: a.denied })));
  expect(calls().at(-1).text).toContain("请勿重试");
  expect(runEvents(app, runId)).toContainEqual(expect.objectContaining({
    type: "tool-call", data: expect.objectContaining({ phase: "end", deniedCapability: "sources.edit", ok: false }),
  }));
}, 60000);

it("records the missing capability when an existing run loses write access", async () => {
  const userId = createUser(app, { id: "former-editor", name: "项目编辑" }).id;
  addMember(app, spaceId, userId, "contributor");
  const runId = createRun(app, { kind: "ask", title: "记笔记", spaceId, userId }).id;
  const token = issueToolToken({ actor: "agent", runId, spaceId, userId, spaces: [spaceId], tools: new Set(["save_note"]) });
  try {
    app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,'sources.edit','space',?,'deny','0','owner')").run(userId, spaceId);
    const r = await server.inject({ method: "POST", url: "/api/tools/save_note", headers: { authorization: "Bearer " + token }, payload: { text: "材料" } });
    expect(r.json()).toMatchObject({ isError: true, deniedCapability: "sources.edit", text: expect.stringContaining("请勿重试") });
    expect(runEvents(app, runId)).toContainEqual(expect.objectContaining({
      type: "tool-call", data: expect.objectContaining({ deniedCapability: "sources.edit", phase: "end" }),
    }));
  } finally { revokeToolToken(token); }
});

it("checks the work owner before moving a topic and queues specialists with the current caller scope", async () => {
  const userId = createUser(app, { id: "worker", name: "成员" }).id;
  addMember(app, spaceId, userId, "contributor");
  const agent = "specialist";
  saveAgentSpec(app, { name: agent, status: "active", description: "整理材料", prompt: "整理材料" }, "user");
  const start = (userId: string) => {
    const root = createThread(app, { spaceId, channel: "web", userId });
    const ask = createRun(app, { kind: "ask", spaceId, userId, title: "原任务", input: { conversationId: root.id } });
    return startAgentWork(app, { askRunId: ask.id, rootConversationId: root.id, spaceId, title: "原任务", agent,
      task: "第一轮", startMessage: "开始", assistantScope: { spaces: null, userId, denyTools: [], lark: { chats: [] } } });
  };
  const original = start("owner");
  const mine = start(userId);
  const queued = createRun(app, { kind: "ask", spaceId, title: "待协调", lane: original.work.workConversationId });
  const root = createThread(app, { spaceId, channel: "web", userId });
  const runId = createRun(app, { kind: "ask", title: "续办", userId, spaceId, input: { conversationId: root.id } }).id;
  const before = refreshWork(app, original.work.askRunId);
  await runRole(app, { role: "assistant", runId, spaceId, spaces: [spaceId], profileId: profile.id,
    task: [original, mine].map(({ work }) => "@call run_agent " + JSON.stringify({ work_id: work.askRunId, name: agent, task: "继续整理" })).join("\n") });
  expect(calls().slice(-2)).toMatchObject([{ name: "run_agent", isError: true, text: expect.stringContaining("只能续办") },
    { name: "run_agent", isError: false }]);
  expect(refreshWork(app, original.work.askRunId)).toEqual(before);
  expect(getRun(app, original.runId).status).toBe("queued");
  expect(getRun(app, queued.id).status).toBe("queued");
  const next = refreshWork(app, mine.work.askRunId)!.rounds.at(-1)!.runId;
  expect(next).not.toBe(mine.runId);
  expect(runUser(app, next)).toBe(userId);
  expect(getRun(app, next).input.assistantScope).toMatchObject({ spaces: [spaceId], readScope: [spaceId], userId });
}, 60000);
