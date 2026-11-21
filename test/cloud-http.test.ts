import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.ts";
import { saveConfig } from "../src/core/config.ts";
import { expect, it, vi } from "vitest";
import * as doubao from "../src/agents/doubao.ts";
import * as capabilities from "../src/agents/capabilities.ts";
import { upsertSource } from "../src/sources/store.ts";
import { runBackend } from "../src/agents/dispatch.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { addRunEvent, createRun, runEvents } from "../src/agents/runs.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { sessionPrompt } from "../src/agents/types.ts";
import { all, run } from "../src/core/db.ts";
import { createUser, createApiToken } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

it.each([["header", "message"], ["url", "message"], ["header", "channel"]])("probes and runs a fake cloud session over %s HTTP with %s credentials", async (mode, credentialIn) => {
  const app = testApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true, secure: false });
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
      const headers = mode === "header" ? { authorization: "Bearer probe-" + challenge[1] } : {};
      const list = await server.inject({ url: challenge[0], headers });
      const url = new URL(list.json().next).pathname;
      const args = { probe: challenge[1] };
      const receipt = mode === "header" ? await server.inject({ url, method: "POST", headers, payload: args })
        : await server.inject({ url, query: { args: JSON.stringify(args) } });
      text = receipt.json().receipt;
    } else {
      expect(req.system).toContain("云端只读工具");
      expect(req.system).not.toContain("oct_");
      const conn = req.cloudChannel ?? JSON.parse(req.prompt.split("\n").at(-1)!);
      bearer = JSON.stringify(conn).match(/oct_[\w-]+/)![0];
      expect(req.prompt.includes(bearer)).toBe(credentialIn === "message");
      const list = await server.inject({ url: new URL(conn.url).pathname, headers: conn.headers });
      expect(list.statusCode).toBe(200);
      expect(list.json().tools.map((t: {name: string}) => t.name)).toContain("read_source");
      const rejected = await server.inject({ method: "GET", url: "/api/settings", headers: { authorization: "Bearer " + bearer } });
      expect(rejected.statusCode).toBe(403);
      const mcp = await server.inject({ method: "POST", url: "/mcp", headers: { authorization: "Bearer " + bearer } });
      expect(mcp.statusCode).toBe(403);
      const args = { source: source.id };
      const read = mode === "header" ? await server.inject({ method: "POST", url: "/api/tools/read_source", headers: conn.headers, payload: args })
        : await server.inject({ url: new URL(list.json().next).pathname + "/read_source", query: { args: JSON.stringify(args) } });
      const local = await server.inject({ method: "POST", url: "/api/tools/read_source", headers: { authorization: "Bearer " + mcpToken }, payload: args });
      expect(local.json().isError).toBe(false);
      expect(read.json()).toMatchObject(local.json());
      text = "已读回原文";
    }
    return { sessionId, text, agent: "fake", stopReason: "end_turn" };
  });
  try {
    app.config.webUrl = "https://8.8.8.8";
    const cfg = { ...app.config.agents.cloudTools, enabled: true, backends: ["doubao"], credentialIn };
    const update = (headers: Record<string, string>, cloudTools: unknown) => server.inject({ method: "PUT", url: "/api/settings", headers, payload: { agents: { ...app.config.agents, cloudTools } } });
    const loopback = { host: "localhost" };
    const session = createSession(app, "owner", { via: "test" });
    const cookie = { cookie: SESSION_COOKIE + "=" + session.token };
    expect((await server.inject({ url: "/api/cloud-tools", headers: cookie })).statusCode).toBe(200);
    for (const path of ["cloud-tools", "cloud-tools/revoke", "cloud-tools/probe", "cloud-tools/probe/confirm"]) {
      const method = path === "cloud-tools" ? "GET" : "POST";
      for (const headers of [loopback, { ...loopback, "x-forwarded-for": "192.0.2.10" }, { authorization: "Bearer invalid" }]) {
        const response = await server.inject({ method, url: "/api/" + path, headers });
        expect([401, 403]).toContain(response.statusCode);
      }
    }
    expect((await update({}, cfg)).statusCode).toBe(403);
    expect((await update(admin, cfg)).statusCode).toBe(403);
    expect((await update(owner, { ...cfg, tools: ["write_page"] })).statusCode).toBe(400);
    expect((await update(owner, cfg)).statusCode).toBe(200);
    if (credentialIn === "channel") {
      app.config.port = Number(new URL(app.baseUrl).port);
      saveConfig(app.config, app.home);
      const cli = await promisify(execFile)(process.execPath, ["src/cli.ts", "--home", app.home, "cloud-tools", "probe", "doubao"]);
      expect(JSON.parse(cli.stdout)).toMatchObject({ mode, confirmed: false });
      expect(all(app.db, "select 1 from api_tokens where label='cloud-tools probe'")).toHaveLength(0);
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
    expect((await server.inject({ url: "/api/cloud-tools", headers: owner })).json()).toMatchObject({ activeCredentials: 0, recent: [{ calls: 2, errors: 0 }] });
    for (const path of ["cloud-tools", "cloud-tools/revoke", "cloud-tools/probe", "cloud-tools/probe/confirm"]) {
      expect((await server.inject({ method: path === "cloud-tools" ? "GET" : "POST", url: "/api/" + path, headers: admin })).statusCode).toBe(403);
    }
  } finally {
    vi.restoreAllMocks();
    await server.close();
    app.db.close();
  }
});
