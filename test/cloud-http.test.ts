import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { once } from "node:events";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { saveRole } from "../src/auth/permissions.ts";
import { issueProbeTicket } from "../src/auth/cloud-probe-ticket.ts";
import { App } from "../src/core/app.ts";
import { cloudToolNames, loadConfig, saveConfig } from "../src/core/config.ts";
import { expect, it, vi } from "vitest";
import * as doubao from "../src/agents/doubao.ts";
import * as capabilities from "../src/agents/capabilities.ts";
import { upsertSource } from "../src/sources/store.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { addRunEvent, createRun, runEvents } from "../src/agents/runs.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { sessionPrompt } from "../src/agents/types.ts";
import { all, migrations, run } from "../src/core/db.ts";
import { createUser, createApiToken, userForToken } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

async function loopbackProxy(upstream: string, headersFor: (req: IncomingMessage) => OutgoingHttpHeaders | null) {
  const proxy = createServer((req, res) => {
    const headers = headersFor(req);
    if (!headers) {
      res.writeHead(403).end();
      return;
    }
    const forwarded = request(upstream + req.url, { method: req.method, headers }, response => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    });
    forwarded.on("error", () => res.writeHead(502).end());
    req.pipe(forwarded);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address() as import("node:net").AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  return { proxy, base };
}

// Exercise the documented map over sockets with a loopback upstream and rewritten Host.
function publicIngress(upstream: string) {
  const doc = readFileSync(new URL("../docs/v2/external-access.md", import.meta.url), "utf8");
  const map = doc.split('$cloud_tools_allowed {')[1].split("}")[0];
  const allow = [...map.matchAll(/"~(.+)" 1;/g)].map(m => new RegExp(m[1]));
  return loopbackProxy(upstream, req => {
    const path = new URL(req.url!, upstream).pathname;
    const authorization = req.headers.authorization ?? "";
    if (!allow.some(rule => rule.test(`${req.method}:${path}:${authorization}`))) return null;
    const headers: OutgoingHttpHeaders = {};
    if (authorization) headers.authorization = authorization;
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    return headers;
  });
}

it("requires authentication at the upstream when a loopback proxy forwards management requests", async () => {
  const app = testApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true, secure: false });
  const ingress = await loopbackProxy(app.baseUrl, req => ({ ...req.headers, host: new URL(app.baseUrl).host }));
  try {
    expect(app.config.auth.enabled).toBe(false);
    expect(app.config.token).toBeFalsy();
    for (const forwardSource of [true, false]) {
      const headers: Record<string, string> = forwardSource ? { "x-forwarded-for": "192.0.2.10" } : {};
      for (const path of ["", "/probe", "/probe/confirm", "/revoke"]) {
        const response = await fetch(ingress.base + "/api/cloud-tools" + path, { method: path ? "POST" : "GET", headers });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ login: false });
      }
    }
  } finally {
    ingress.proxy.close();
    await server.close();
    app.db.close();
  }
});

it.each([undefined, "local-test-token"])("keeps the global HTTP token local for a settings manager (%s)", async token => {
  const app = testApp();
  app.config.token = token;
  // Settings are read and written by section (auth/settings-sections.ts): this member was given the system section.
  createUser(app, { id: "editor", name: "成员" });
  for (const capability of ["settings.system.view", "settings.system.edit"])
    app.db.prepare("insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by,updated_at) values('editor',?,'global','','allow','0','owner','0')").run(capability);
  const headers = { authorization: "Bearer " + createApiToken(app, "editor", "test") };
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true, secure: false });
  try {
    const url = "/api/settings";
    const read = await server.inject({ url, headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().config).not.toHaveProperty("token");
    const write = await server.inject({ method: "PUT", url, headers, payload: { language: "en", token: "ignored" } });
    expect(write.statusCode).toBe(200);
    expect(write.json().config.language).toBe("en");
    expect(write.json().config).not.toHaveProperty("token");
    expect(loadConfig(app.home).token).toBe(token);
    expect(app.config.token).toBe(token);
    const auth = { ...app.config.auth, enabled: !app.config.auth.enabled };
    expect((await server.inject({ method: "PUT", url, headers, payload: { auth } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: "/api/cloud-tools/revoke", headers })).statusCode).toBe(403);
  } finally {
    await server.close();
    app.db.close();
  }
});

it.each([["header", "message"], ["url", "message"], ["header", "channel"]])("probes and runs a fake cloud session over %s HTTP with %s credentials", async (mode, credentialIn) => {
  const app = testApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true, secure: false });
  const ingress = await publicIngress(app.baseUrl);
  const owner = { authorization: "Bearer " + createApiToken(app, "owner", "test") };
  createUser(app, { id: "admin-a", name: "管理员", role: "admin" });
  const admin = { authorization: "Bearer " + createApiToken(app, "admin-a", "test") };
  const events = vi.spyOn(console, "error");
  vi.spyOn(doubao, "doubaoApps").mockResolvedValue([{ appId: "fake", secret: "unused" }]);
  vi.spyOn(doubao, "doubaoTokenExists").mockReturnValue(true);
  const deleted = vi.spyOn(doubao, "deleteDoubaoSession").mockResolvedValue(undefined);
  const id = createRun(app, { kind: "ask", title: "读资料" }).id;
  run(app.db, "update runs set status='running' where id=?", id);
  if (credentialIn === "channel") {
    const base = capabilities.backendCapabilities;
    vi.spyOn(capabilities, "backendCapabilities").mockImplementation(p => ({ ...base(p), credentialChannel: true }));
  }
  const source = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "guide", title: "项目资料", text: "项目 A 的验收记录" });
  let mcpToken = "";
  let bearer = "";
  const fake = vi.spyOn(doubao, "runDoubao").mockImplementation(async (_profile, req, emit) => {
    const challenge = req.prompt.match(/\/api\/cloud-tools\/challenge\/([\w-]+)/);
    const sessionId = challenge ? "probe-session" : "task-session";
    emit({ type: "session", sessionId, resumed: false });
    sessionPrompt({ resumed: false }, req, req.prompt, emit);
    let text: string;
    if (challenge) {
      expect(req.mcp).toBeUndefined();
      const headers: Record<string, string> = mode === "header" ? { authorization: "Bearer probe-" + challenge[1] } : {};
      const list = await fetch(ingress.base + challenge[0], { headers });
      const url = ingress.base + new URL((await list.json()).next).pathname;
      const args = { probe: challenge[1] };
      const receipt = mode === "header" ? await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(args) })
        : await fetch(url + "?" + new URLSearchParams({ args: JSON.stringify(args) }));
      text = (await receipt.json()).receipt;
    } else {
      expect(req.system).toContain("## 云端工具");
      expect(req.system).not.toContain("oct_");
      const conn = req.cloudChannel ?? JSON.parse(req.prompt.split("\n").at(-1)!);
      bearer = JSON.stringify(conn).match(/oct_[\w-]+/)![0];
      expect(req.prompt.includes(bearer)).toBe(credentialIn === "message");
      const listed = await fetch(ingress.base + new URL(conn.url).pathname, { headers: conn.headers });
      expect(listed.status).toBe(200);
      const list = await listed.json();
      expect(list.tools.map((t: {name: string}) => t.name)).toContain("read_source");
      const rejected = await server.inject({ method: "GET", url: "/api/settings", headers: { authorization: "Bearer " + bearer } });
      expect(rejected.statusCode).toBe(403);
      const mcp = await server.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer " + bearer } });
      expect(mcp.statusCode).toBe(403);
      const args = { source: source.id };
      const read = mode === "header" ? await fetch(ingress.base + "/api/tools/read_source", { method: "POST", headers: { ...conn.headers, "content-type": "application/json" }, body: JSON.stringify(args) })
        : await fetch(ingress.base + new URL(list.next).pathname + "/read_source?" + new URLSearchParams({ args: JSON.stringify(args) }));
      const local = await server.inject({ method: "POST", url: "/api/tools/read_source", headers: { authorization: "Bearer " + mcpToken }, payload: args });
      expect(local.json().isError).toBe(false);
      expect(await read.json()).toMatchObject(local.json());
      text = "已读回原文";
    }
    return { sessionId, text, agent: "fake", stopReason: "end_turn" };
  });
  try {
    app.config.webUrl = "https://8.8.8.8";
    const cfg = { ...app.config.agents.cloudTools, enabled: true, backends: ["doubao"], credentialIn };
    const update = (headers: Record<string, string>, cloudTools: unknown) => server.inject({ method: "PUT", url: "/api/settings", headers, payload: { agents: { ...app.config.agents, cloudTools } } });
    const session = createSession(app, "owner", { via: "test" });
    const cookie = { cookie: SESSION_COOKIE + "=" + session.token };
    expect((await server.inject({ url: "/api/cloud-tools", headers: cookie })).statusCode).toBe(200);
    for (const path of ["cloud-tools", "cloud-tools/revoke", "cloud-tools/probe", "cloud-tools/probe/confirm"]) {
      const method = path === "cloud-tools" ? "GET" : "POST";
      expect((await fetch(ingress.base + "/api/" + path, { method, headers: owner })).status).toBe(403);
      const invalid = await server.inject({ method, url: "/api/" + path, headers: { authorization: "Bearer invalid" } });
      expect([401, 403]).toContain(invalid.statusCode);
    }
    expect((await fetch(ingress.base + "/api/tools", { headers: owner })).status).toBe(403);
    expect((await update({}, cfg)).statusCode).toBe(403);
    expect((await update(admin, cfg)).statusCode).toBe(403);
    expect((await update(owner, { ...cfg, tools: ["write_page"] })).statusCode).toBe(400);
    expect((await update(owner, cfg)).statusCode).toBe(200);
    if (credentialIn === "channel") {
      app.config.port = Number(new URL(app.baseUrl).port);
      saveConfig(app.config, app.home);
      const cli = await promisify(execFile)(process.execPath, ["src/cli.ts", "--home", app.home, "cloud-tools", "probe", "doubao"]);
      expect(JSON.parse(cli.stdout)).toMatchObject({ mode, confirmed: false });
      expect(all(app.db, "select 1 from kv where key glob 'cli-probe:*'")).toHaveLength(0);
    }
    const probe = await server.inject({ method: "POST", url: "/api/cloud-tools/probe", headers: owner, payload: { backend: "doubao" } });
    expect(probe.json()).toMatchObject({ mode, confirmed: false });
    expect(deleted).toHaveBeenCalledWith(app.home, expect.anything(), "probe-session");
    const confirmed = await server.inject({ method: "POST", url: "/api/cloud-tools/probe/confirm", headers: owner, payload: { backend: "doubao", id: probe.json().id } });
    expect(confirmed.statusCode).toBe(200);
    const prep = prepareRun(app, { actor: { role: "assistant" }, runId: id, spaceId: "personal", profileId: "doubao" });
    try {
      mcpToken = prep.token;
      await runBackend(app, prep.profile, { ...prep, runId: id, prompt: "核对材料" }, e => addRunEvent(app, id, e.type, e));
    } finally { revokeToolToken(prep.token); }
    expect(fake).toHaveBeenCalledTimes(credentialIn === "channel" ? 3 : 2);
    expect(deleted).toHaveBeenCalledWith(app.home, expect.anything(), "task-session");
    const history = runEvents(app, id);
    expect(JSON.stringify(history)).toContain('"omemAccess":"http"');
    expect(JSON.stringify([history, all(app.db, "select * from audit_events"), events.mock.calls])).not.toContain(bearer);
    const status = (await server.inject({ url: "/api/cloud-tools", headers: owner })).json();
    expect(status).toMatchObject({ activeCredentials: 0, recent: [{ runId: id, title: "读资料", calls: 2, errors: 0 }] });
    expect(status.availableTools.map((t: { name: string }) => t.name).sort()).toEqual([...cloudToolNames].sort());
    expect(status.availableTools.every((t: { description: string }) => t.description.length > 1)).toBe(true);
    for (const path of ["cloud-tools", "cloud-tools/revoke", "cloud-tools/probe", "cloud-tools/probe/confirm"]) {
      expect((await server.inject({ method: path === "cloud-tools" ? "GET" : "POST", url: "/api/" + path, headers: admin })).statusCode).toBe(403);
    }
  } finally {
    ingress.proxy.close();
    vi.restoreAllMocks();
    await server.close();
    app.db.close();
  }
});

it("expires an unused probe ticket even when the CLI is killed before delivery", async () => {
  const app = testApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true, secure: false });
  // Hold the CLI request before it reaches the application. SIGKILL skips all CLI cleanup.
  let resolve!: (value: string) => void;
  const waiting = { promise: new Promise<string>(r => { resolve = r; }), resolve: (value: string) => resolve(value) };
  const relay = createServer((req, res) => {
    if (req.url === "/api/settings") res.end(JSON.stringify({ home: app.home }));
    else waiting.resolve(req.headers.authorization!);
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  app.config.port = (relay.address() as import("node:net").AddressInfo).port;
  saveConfig(app.config, app.home);
  const cli = spawn(process.execPath, ["src/cli.ts", "--home", app.home, "cloud-tools", "probe", "doubao"]);
  const stopped = once(cli, "exit");
  try {
    const authorization = await Promise.race([waiting.promise, stopped.then(() => { throw new Error("CLI 在发出请求前已退出"); })]);
    cli.kill("SIGKILL");
    await stopped;
    const headers = { authorization };
    expect(all(app.db, "select 1 from api_tokens")).toHaveLength(0);
    for (const url of ["/api/settings", "/api/cloud-tools", "/api/cloud-tools/revoke", "/api/cloud-tools/probe/confirm"]) {
      const method = url.endsWith("revoke") || url.endsWith("confirm") ? "POST" : "GET";
      expect((await server.inject({ method, url, headers })).statusCode).toBe(401);
    }
    const probe = { method: "POST" as const, url: "/api/cloud-tools/probe", payload: { backend: "doubao" } };
    const fresh = { authorization: "Bearer " + issueProbeTicket(app) };
    // The first request reaches the handler (webUrl is unset), and spends the ticket.
    expect((await server.inject({ ...probe, headers: fresh })).statusCode).toBe(400);
    expect((await server.inject({ ...probe, headers: fresh })).statusCode).toBe(401);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    expect((await server.inject({ ...probe, headers })).statusCode).toBe(401);
  } finally {
    vi.restoreAllMocks();
    cli.kill();
    relay.closeAllConnections();
    relay.close();
    await server.close();
    app.db.close();
  }
});
