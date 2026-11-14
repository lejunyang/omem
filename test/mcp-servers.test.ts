import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { deleteMcpServer, listMcpServers, mcpServersFor, saveMcpServer } from "../src/agents/mcp-servers.ts";
import { listRoleStates, setRoleMcp } from "../src/agents/builtin-roles.ts";
import { agentSpecSchema, readAgentSpec } from "../src/agents/specs.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { startServer } from "../src/server/http.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { readKeys } from "../src/core/ai-keys.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
const apps: ReturnType<typeof testApp>[] = [];
function setup() { const app = testApp(); apps.push(app); return app; }
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });
const command = { command: process.execPath, args: [resolve("test/fixture-mcp-server.ts")] };

it.each(["http", "sse"])("probes %s with saved headers and redacts tool descriptions", async (kind) => {
  const app = setup();
  const clients: Server[] = [];
  const seen: (string | undefined)[] = [];
  let sse: SSEServerTransport | undefined;
  const makeServer = () => {
    const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "lookup", description: "token header-secret", inputSchema: { type: "object" } }] }));
    clients.push(server);
    return server;
  };
  const http = createServer(async (req, res) => {
    seen.push(req.headers.authorization);
    if (kind === "http") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await makeServer().connect(transport);
      await transport.handleRequest(req, res);
    } else if (req.method === "GET") {
      sse = new SSEServerTransport("/messages", res);
      await makeServer().connect(sse);
    } else if (req.url?.startsWith("/messages") && sse) {
      await sse.handlePostMessage(req, res);
    } else {
      res.writeHead(405).end();
    }
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const address = http.address() as { port: number };
  const api = await startServer(app, { port: 0, quiet: true });
  try {
    saveMcpServer(app, "docs", { url: `http://127.0.0.1:${address.port}/mcp`, secrets: { Authorization: "header-secret" } });
    const response = await api.inject({ method: "POST", url: "/api/mcp/docs/test" });
    expect(response.json()).toEqual({ ok: true, tools: [{ name: "lookup", description: "token [密钥]" }] });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((value) => value === "header-secret")).toBe(true);
    expect(response.body).not.toContain("header-secret");
  } finally {
    await api.close();
    await Promise.all(clients.map((s) => s.close()));
    http.closeAllConnections();
    await new Promise<void>((done, reject) => http.close((e) => e ? reject(e) : done()));
  }
}, 25_000);

it("saves names and set flags, keeps null values and removes omitted secrets", () => {
  const app = setup();
  const view = saveMcpServer(app, "docs", { ...command, description: "示例查询", secrets: { TOKEN: "private-token", OLD: "old-token" } });
  expect(view).toMatchObject({ name: "docs", kind: "command", secrets: [{ name: "TOKEN", set: true }, { name: "OLD", set: true }] });
  expect(JSON.stringify(listMcpServers(app))).not.toContain("private-token");
  expect(readFileSync(join(app.home, "config.json"), "utf8")).not.toContain("private-token");
  saveMcpServer(app, "docs", { ...command, secrets: { TOKEN: null } });
  expect(mcpServersFor(app, ["docs", "missing", "docs"])).toEqual({ docs: { ...command, env: { TOKEN: "private-token" }, readOnly: false } });
  expect(listMcpServers(app)[0].secrets).toEqual([{ name: "TOKEN", set: true }]);
  saveMcpServer(app, "docs", { url: "https://example.com/mcp", secrets: { Authorization: "Bearer hidden" }, readOnly: true });
  expect(mcpServersFor(app, ["docs"])).toEqual({ docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer hidden" }, readOnly: true } });
  saveMcpServer(app, "docs", { url: "https://example.com/mcp", secrets: { Authorization: null } });
  expect(listMcpServers(app)[0].secrets).toEqual([{ name: "Authorization", set: true }]);
  deleteMcpServer(app, "docs");
  expect(listMcpServers(app)).toEqual([]);
  expect(readKeys(app.home)["mcp:docs"]).toBeUndefined();
  expect(mcpServersFor(app, ["docs"])).toEqual({});
  expect(() => deleteMcpServer(app, "docs")).toThrow("没有名为");
});

it("validates command-or-url, URL, names and missing kept values without changing saved data", () => {
  const app = setup();
  for (const input of [{}, { command: "node", url: "https://example.com/mcp" }, { url: "file:///example" }]) expect(() => saveMcpServer(app, "docs", input)).toThrow();
  expect(() => saveMcpServer(app, "Bad Name", command)).toThrow("名称");
  expect(() => saveMcpServer(app, "docs", { ...command, secrets: { TOKEN: null } })).toThrow("还没有值");
  expect(listMcpServers(app)).toEqual([]);
});

it("assigns role servers, rejects unknown servers and guest roles, returns the overlay", () => {
  const app = setup(); saveMcpServer(app, "docs", command);
  expect(() => setRoleMcp(app, "assistant", ["missing"])).toThrow("没有这些 MCP 服务");
  for (const role of ["guest", "gatekeeper"]) expect(() => setRoleMcp(app, role, ["docs"])).toThrow("回答访客");
  expect(setRoleMcp(app, "assistant", ["docs", "docs"]).overlay.mcp).toEqual(["docs"]);
  expect(listRoleStates(app).find((r) => r.name === "assistant")?.overlay.mcp).toEqual(["docs"]);
  expect(setRoleMcp(app, "assistant", []).overlay.mcp ?? []).toEqual([]);
});

it("gives named servers only to owner runs, filters replay to read-only and excludes review checks", () => {
  const app = setup(); app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.default = "fake";
  app.config.agents.profiles = [{ id: "fake", transport: "acp", ...command, env: {}, idleTimeoutMs: 60000 }];
  saveMcpServer(app, "docs", { ...command, readOnly: true, secrets: { TOKEN: "real-token" } });
  saveMcpServer(app, "writer", command);
  const spec = { ...agentSpecSchema.parse({ name: "investigator", description: "查询示例材料", tools: ["search"], mcpServers: ["docs", "writer"] }), prompt: "查清问题。" };
  const input = { actor: { spec }, spaceId: "personal", runId: null };
  expect(prepareRun(app, input).extraMcp).toEqual({ docs: { ...command, env: { TOKEN: "real-token" } }, writer: { ...command, env: {} } });
  const other = createUser(app, { id: "reader", name: "小王" });
  expect(prepareRun(app, { ...input, userId: other.id, spaceId: `personal-${other.id}` }).extraMcp).toEqual({});
  expect(prepareRun(app, { ...input, actor: { role: "guest" } }).extraMcp).toEqual({});
  expect(prepareRun(app, { ...input, replay: { view: { asOf: new Date().toISOString() }, tools: ["search"] } }).extraMcp).toEqual({ docs: { ...command, env: { TOKEN: "real-token" } } });
  expect(prepareRun(app, { ...input, reviewCheck: true }).extraMcp).toEqual({});
  expect(prepareRun(app, { ...input, reviewLead: true }).extraMcp).toEqual({});
  setRoleMcp(app, "assistant", ["docs"]);
  expect(prepareRun(app, { ...input, actor: { role: "assistant" } }).extraMcp).toEqual({ docs: { ...command, env: { TOKEN: "real-token" } } });
});

it("CRUD routes expose usage, profile round-trip and 400 for unknown names, and settings retain keys", async () => {
  const app = setup(); const server = await startServer(app, { port: 0, quiet: true });
  try {
    const saved = await server.inject({ method: "PUT", url: "/api/mcp/docs", payload: { ...command, secrets: { TOKEN: "route-secret" } } });
    expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain("route-secret");
    const profile = await server.inject({ method: "PUT", url: "/api/agents/investigator", payload: { description: "示例查询", prompt: "查示例材料。", mcpServers: ["docs"] } });
    expect(profile.statusCode).toBe(200); expect(profile.json().mcpServers).toEqual(["docs"]);
    expect((await server.inject({ url: "/api/agents/investigator" })).json().mcpServers).toEqual(["docs"]);
    expect((await server.inject({ method: "PUT", url: "/api/agents/investigator", payload: { mcpServers: ["missing"] } })).statusCode).toBe(400);
    expect(readAgentSpec(app, "investigator").mcpServers).toEqual(["docs"]);
    const raw = "---\nname: investigator\ndescription: 示例\nmcpServers: [missing]\n---\n正文";
    expect((await server.inject({ method: "PUT", url: "/api/library-files/agent/investigator", payload: { raw } })).statusCode).toBe(400);
    expect((await server.inject({ method: "PUT", url: "/api/roles/assistant/mcp", payload: { servers: ["docs"] } })).statusCode).toBe(200);
    const list = (await server.inject({ url: "/api/mcp" })).json().servers;
    expect(list[0].usedBy).toEqual(["investigator", "assistant"]);
    expect(JSON.stringify(list)).not.toContain("route-secret");
    expect((await server.inject({ url: "/api/roles" })).json().find((r: { name: string }) => r.name === "assistant").overlay.mcp).toEqual(["docs"]);
    await server.inject({ method: "PUT", url: "/api/settings", payload: { concurrency: 3 } });
    expect(mcpServersFor(app, ["docs"]).docs).toMatchObject({ env: { TOKEN: "route-secret" } });
    expect((await server.inject({ method: "DELETE", url: "/api/mcp/docs" })).statusCode).toBe(200);
    expect((await server.inject({ url: "/api/mcp" })).json()).toEqual({ servers: [] });
    expect((await server.inject({ method: "PUT", url: "/api/mcp/bad", payload: {} })).statusCode).toBe(400);
  } finally { await server.close(); }
});

it("registers MCP routes as owner-only and refuses a member's token", async () => {
  const app = setup(); const user = createUser(app, { name: "小王", id: "member", role: "admin" });
  const token = createApiToken(app, user.id, "测试");
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    for (const [method, url, payload] of [["GET", "/api/mcp", undefined], ["PUT", "/api/mcp/:name", command], ["DELETE", "/api/mcp/:name", undefined], ["POST", "/api/mcp/:name/test", {}], ["PUT", "/api/roles/:name/mcp", { servers: [] }]] as const) {
      expect(ROUTE_RULES[`${method} ${url}`]).toBe("owner");
      const response = await server.inject({ method, url: url.replace(":name", "docs"), headers: { authorization: `Bearer ${token}` }, payload });
      expect(response.statusCode).toBe(403);
    }
  } finally { await server.close(); }
});

it("probes a real stdio MCP server and kills its process on success and error, redacting secrets", async () => {
  const app = setup(); const server = await startServer(app, { port: 0, quiet: true });
  const pidFile = join(app.home, "probe.pid");
  try {
    saveMcpServer(app, "probe", { ...command, secrets: { PID_FILE: pidFile } });
    const ok = await server.inject({ method: "POST", url: "/api/mcp/probe/test" });
    expect(ok.json()).toEqual({ ok: true, tools: [{ name: "lookup", description: "查询示例材料" }] });
    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
    saveMcpServer(app, "probe", { ...command, secrets: { PROBE_MODE: "error", PROBE_SECRET: "secret-must-not-leak", PID_FILE: pidFile } });
    const error = await server.inject({ method: "POST", url: "/api/mcp/probe/test" });
    expect(error.json().ok).toBe(false); expect(error.body).not.toContain("secret-must-not-leak");
    expect(error.json().error).toContain("[密钥]");
    const failedPid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => { try { process.kill(failedPid, 0); return false; } catch { return true; } }).toBe(true);
  } finally { await server.close(); }
}, 15_000);

it("stops an unresponsive server after 20 seconds and kills the child", async () => {
  const app = setup(); const server = await startServer(app, { port: 0, quiet: true });
  const pidFile = join(app.home, "timeout.pid");
  try {
    saveMcpServer(app, "probe", { ...command, secrets: { PROBE_MODE: "hang", PID_FILE: pidFile } });
    const start = Date.now();
    const response = await server.inject({ method: "POST", url: "/api/mcp/probe/test" });
    expect(response.json()).toEqual({ ok: false, error: "检测超时（20 秒）" });
    expect(Date.now() - start).toBeLessThan(22_000);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
  } finally { await server.close(); }
}, 26_000);
