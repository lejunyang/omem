import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { runRole } from "../src/agents/runner.ts";
import { createRun } from "../src/agents/runs.ts";
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
}, 60000);
