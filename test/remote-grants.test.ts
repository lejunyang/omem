import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { prepareRun } from "../src/agents/runner.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { createRun, runEvents } from "../src/agents/runs.ts";
import { once } from "node:events";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createSession } from "../src/auth/sessions.ts";
import { all, run } from "../src/core/db.ts";
import { createApiToken, createUser, personalSpaceId, updateUser } from "../src/core/users.ts";
import { setToolResolverForTests } from "../src/core/tools.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

describe("browser session grants", () => {
  const app = testApp();
  app.config.token = "test-owner";
  let server: Awaited<ReturnType<typeof startServer>>;
  const member = "visitor";
  let token: string;
  beforeAll(async () => {
    process.env.FAKE_AAD_TARGET_DIR = app.home;
    createUser(app, { id: member, name: "成员" });
    createSession(app, member, { via: "link" });
    token = createApiToken(app, member);
    setToolResolverForTests(name => name === "aad" ? [process.execPath, join(import.meta.dirname, "fake-aad.ts")] : null);
    server = await startServer(app, { port: 0, quiet: true });
  });
  afterAll(async () => { await server.close(); delete process.env.FAKE_AAD_TARGET_DIR; setToolResolverForTests(null); app.db.close(); });

  const api = (path: string, method = "GET", body?: object, as = "test-owner") =>
    fetch(app.baseUrl + "/api/remote" + path, { method, headers: { authorization: "Bearer " + as,
      ...(body && { "content-type": "application/json" }) }, body: body && JSON.stringify(body) });
  async function open() {
    const r = await api("/sessions", "POST", { kind: "browser" });
    expect(r.status).toBe(200);
    return (await r.json()).id as string;
  }
  function cap(mode: string) {
    run(app.db, "insert or replace into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values(?,?,'global','','allow','','owner')", member, "remote." + mode);
  }
  async function connect(id: string, as = token) {
    const r = await api(`/sessions/${id}/view`, "POST", undefined, as);
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const { src } = await r.json();
    const url = app.baseUrl + src;
    expect((await fetch(url, { headers: { cookie } })).status).toBe(200);
    const ws = new WebSocket(url.replace(/^http/, "ws").replace("/?token", "/ws?token"), { headers: { cookie } });
    const frames: string[] = [];
    ws.on("message", data => frames.push(data.toString()));
    await expect.poll(() => frames).toContain(Buffer.from([1, 2, 3]).toString());
    return { ws, frames, cookie, url };
  }

  it("requires the capability and grant, isolates cookies, and filters viewer input before aad", async () => {
    const id = await open(), other = await open();
    const path = `/sessions/${id}`;
    expect((await api(path + "/view", "POST", undefined, token)).ok).toBe(false);
    cap("view");
    expect((await fetch(app.baseUrl + "/remote/" + id + "/?token=viewer", { headers: { authorization: "Bearer " + token } })).ok).toBe(false);
    expect((await (await api("", "GET", undefined, token)).json()).sessions).toEqual([]);
    expect((await api(path + "/view", "POST", undefined, token)).ok).toBe(false);
    const grant = await (await api(path + "/grants", "POST", { userId: member, mode: "view" })).json();
    const view = await connect(id);
    expect((await fetch(view.url.replace(id, other), { headers: { cookie: view.cookie } })).ok).toBe(false);
    const listed = await (await api("")).json();
    expect(listed.sessions.find((s: { id: string }) => s.id === id).grants[0]).toMatchObject({ userId: member, connected: true });
    for (const type of ["mouse","key","text","paste","clipboard","navigate","script","viewport","take","release","unknown"]) view.ws.send(JSON.stringify({ type }));
    view.ws.send(Buffer.from([4, 5]));
    view.ws.send('{"type":"keyframe"}');
    await expect.poll(() => view.frames.at(-1)).toBe('{"type":"keyframe"}');
    expect(view.frames).toHaveLength(3);
    for (const [suffix, method, body] of [
      ["/sessions", "POST", { kind: "desktop" }], ["/screens", "GET"], [path, "DELETE"],
      [path + "/recording", "POST", {}], ["/settings", "PUT", {}], [path + "/viewer", "POST"],
      [path + "/navigate", "POST", { url: "https://example.test/" }],
      [path + "/grants", "POST", { userId: member, mode: "view" }], [path + "/grants/" + grant.id, "DELETE"],
    ] as const) expect((await api(suffix, method, body, token)).ok).toBe(false);
    const closed = once(view.ws, "close");
    await api(path + "/grants/" + grant.id, "PATCH", { mode: "operate" });
    await closed;
    expect((await api(path + "/view", "POST", undefined, token)).ok).toBe(false);
    cap("operate");
    const operator = await connect(id);
    expect((await fetch(view.url, { headers: { cookie: view.cookie } })).ok).toBe(false);
    expect((await api(path + "/navigate", "POST", { url: "https://example.test/" }, token)).status).toBe(200);
    const ownerView = await connect(id, "test-owner");
    const ownersList = await (await api("")).json();
    expect(ownersList.sessions.find((s: {id:string}) => s.id === id).connections).toEqual(expect.arrayContaining([
      { userId: member, mode: "operate" }, { userId: "owner", mode: "operate" }
    ]));
    const stream = await fetch(operator.url, { headers: { cookie: operator.cookie, accept: "application/x-test-stream" } });
    const reader = stream.body!.getReader();
    await reader.read();
    const streamEnded = expect(reader.read()).rejects.toThrow();
    const target = join(app.home, "9333-PAGE1");
    writeFileSync(target, "");
    for (const [ws, text, expected] of [
      [ownerView.ws, "A", "A"], [operator.ws, "B", "AB"], [ownerView.ws, "C", "ABC"],
    ] as const) {
      ws.send(JSON.stringify({ type: "text", text }));
      await expect.poll(() => readFileSync(target, "utf8")).toBe(expected);
    }
    operator.ws.send('{"type":"clipboard"}');
    await expect.poll(() => operator.frames.at(-1)).toContain('"fileId"');
    const { fileId } = JSON.parse(operator.frames.at(-1)!);
    expect((await fetch(operator.url.replace("/?token", "/clipboard/" + fileId + "?token"), { headers: { cookie: operator.cookie } })).status).toBe(200);
    const ended = once(operator.ws, "close");
    await api(path + "/grants/" + grant.id, "DELETE");
    await ended;
    await streamEnded;
    expect(ownerView.ws.readyState).toBe(WebSocket.OPEN);
    ownerView.ws.close();
    expect((await fetch(operator.url, { headers: { cookie: operator.cookie } })).ok).toBe(false);
    expect(all<{ action: string }>(app.db, "select action from audit_events where target=? order by id", id).map(r => r.action)).toEqual(["remote.grant","remote.grant","remote.revoke"]);
  });

  it("opens HTTP and WS after upgrading with a legacy /remote cookie", async () => {
    const id = await open();
    const legacy = "omem_remote=before-upgrade";
    const opened = await fetch(app.baseUrl + `/api/remote/sessions/${id}/view`, {
      method: "POST", headers: { authorization: "Bearer test-owner" },
    });
    expect(opened.status).toBe(200);
    const current = opened.headers.get("set-cookie")!.split(";")[0];
    // Browsers send the more specific session path first, then the old /remote path.
    const cookie = current + "; " + legacy;
    const url = app.baseUrl + (await opened.json()).src;
    expect((await fetch(url, { headers: { cookie: legacy } })).status).toBe(401);
    expect((await fetch(url, { headers: { cookie } })).status).toBe(200);
    const ws = new WebSocket(url.replace(/^http/, "ws").replace("/?token", "/ws?token"), { headers: { cookie } });
    try {
      const [frame] = await once(ws, "message");
      expect(frame.toString()).toContain("ready assist");
    } finally {
      ws.close();
      await api("/sessions/" + id, "DELETE");
    }
  });

  it("limits grant duration, recipients and targets", async () => {
    const id = await open(), path = "/sessions/" + id + "/grants";
    const recipient = { userId: member, mode: "view" };
    expect((await api(path, "POST", { ...recipient, hours: 25 })).status).toBe(400);
    createUser(app, { id: "offline", name: "未登录成员" });
    expect((await api(path, "POST", { ...recipient, userId: "offline" })).status).toBe(400);
    updateUser(app, member, { disabled: true });
    expect((await api(path, "POST", recipient)).status).toBe(400);
    updateUser(app, member, { disabled: false });
    const start = Date.now();
    const grant = await (await api(path, "POST", recipient)).json();
    expect(Date.parse(grant.expiresAt)).toBeGreaterThanOrEqual(start + 2 * 3600_000);
    expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(Date.now() + 2 * 3600_000);
    expect((await api(path, "POST", recipient)).status).toBe(409);
    const desk = await (await api("/sessions", "POST", { kind: "desktop" })).json();
    expect((await api("/sessions/" + desk.id + "/grants", "POST", recipient)).status).toBe(400);
    expect((await api("/sessions/" + desk.id + "/view", "POST", undefined, token)).ok).toBe(false);
    expect((await api("/sessions/" + desk.id + "/grants/" + grant.id, "PATCH", { hours: 1 })).ok).toBe(false);
  });

  it("registers the skill's opened tab with the run identity and detaches when the page closes", async () => {
    const actor = "agent-user";
    createUser(app, { id: actor, name: "运行主人" });
    const actorToken = createApiToken(app, actor);
    const spaceId = personalSpaceId(actor);
    const job = createRun(app, { kind: "agent", title: "浏览器", spaceId, userId: actor });
    const prep = prepareRun(app, { actor: { role: "assistant" }, runId: job.id, spaceId, userId: actor, profileId: "codex" });
    const root = join(app.home, "remote", "profiles", "@" + actor), dir = join(root, "demo");
    mkdirSync(dir, { recursive: true });
    expect(prep.mcp.env?.OMEM_BROWSER_PROFILES).toBe(root);
    const pageId = "PAGE1";
    const cdp = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/json/version" ? {} : { id: pageId }));
    });
    const ws = new WebSocketServer({ server: cdp, path: "/devtools/page/" + pageId });
    ws.on("connection", client => client.on("message", () => client.send(JSON.stringify({ id: 1, result: { arguments: ["--user-data-dir=" + dir] } }))));
    cdp.listen(0, "127.0.0.1");
    await once(cdp, "listening");
    const port = (cdp.address() as { port: number }).port;
    writeFileSync(join(dir, "DevToolsActivePort"), port + "\n/devtools/browser/demo");
    const env = { ...process.env, ...prep.mcp.env, OMEM_CHROME: join(app.home, "unused-chrome") };
    const launch = () => promisify(execFile)(process.execPath, [join(import.meta.dirname, "../skills/library/desktop-control/scripts/browser.mjs"),
      "open", "demo", "--url", "https://example.test/"], { env });
    try {
      expect((await api("/agent-browser", "POST", { profile: "demo", pageId }, actorToken)).ok).toBe(false);
      const log = join(app.home, "registration.jsonl");
      process.env.FAKE_AAD_LOG = log;
      const { sessionId } = JSON.parse((await launch()).stdout);
      expect(JSON.parse((await launch()).stdout).sessionId).toBe(sessionId);
      const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls.filter(args => args[0] === "assist")).toHaveLength(1);
      const list = await (await api("", "GET", undefined, actorToken)).json();
      expect(list.sessions).toContainEqual(expect.objectContaining({ id: sessionId, ownerId: actor, runId: job.id, mine: true }));
      expect(runEvents(app, job.id).filter(e => "link" in e.data && e.data.link === "#/remote/" + sessionId)).toHaveLength(1);
      cap("view");
      expect((await (await api("", "GET", undefined, token)).json()).sessions.map((s: {id:string}) => s.id)).not.toContain(sessionId);
      expect((await api("/sessions/" + sessionId + "/grants", "POST", { userId: member, mode: "view" }, actorToken)).ok).toBe(true);
      const viewer = await connect(sessionId);
      const ended = once(viewer.ws, "close");
      for (const client of ws.clients) client.terminate();
      await ended;
      expect((await fetch(viewer.url, { headers: { cookie: viewer.cookie } })).ok).toBe(false);
    } finally {
      delete process.env.FAKE_AAD_LOG;
      for (const client of ws.clients) client.terminate();
      revokeToolToken(prep.token);
      ws.close();
      cdp.close();
    }
  });

  it.each(["expiry", "disable", "close"])("disconnects a silent viewer on %s", async reason => {
    cap("view");
    const id = await open(), path = "/sessions/" + id;
    const grant = await (await api(path + "/grants", "POST", { userId: member, mode: "view" })).json();
    const view = await connect(id);
    const ended = once(view.ws, "close");
    if (reason === "expiry") await api(path + "/grants/" + grant.id, "PATCH", { hours: 0.00005 });
    if (reason === "disable") updateUser(app, member, { disabled: true });
    if (reason === "close") await api(path, "DELETE");
    await ended;
    expect((await fetch(view.url, { headers: { cookie: view.cookie } })).ok).toBe(false);
    if (reason === "disable") updateUser(app, member, { disabled: false });
    if (reason === "close") {
      const rows = all<{detail: string}>(app.db, "select detail from audit_events where target=? and action='remote.revoke'", id);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].detail)).toMatchObject({ sessionId: id, userId: member, mode: "view", reason: "session-ended" });
    }
  });
});
