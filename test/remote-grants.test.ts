import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
    createUser(app, { id: member, name: "成员" });
    createSession(app, member, { via: "link" });
    token = createApiToken(app, member);
    setToolResolverForTests(name => name === "aad" ? [process.execPath, join(import.meta.dirname, "fake-aad.ts")] : null);
    server = await startServer(app, { port: 0, quiet: true });
  });
  afterAll(async () => { await server.close(); setToolResolverForTests(null); app.db.close(); });

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
  async function connect(id: string) {
    const r = await api(`/sessions/${id}/view`, "POST", undefined, token);
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
      [path + "/grants", "POST", { userId: member, mode: "view" }], [path + "/grants/" + grant.id, "DELETE"],
    ] as const) expect((await api(suffix, method, body, token)).ok).toBe(false);
    const closed = once(view.ws, "close");
    await api(path + "/grants/" + grant.id, "PATCH", { mode: "operate" });
    await closed;
    expect((await api(path + "/view", "POST", undefined, token)).ok).toBe(false);
    cap("operate");
    const operator = await connect(id);
    expect((await fetch(view.url, { headers: { cookie: view.cookie } })).ok).toBe(false);
    operator.ws.send('{"type":"key"}');
    await expect.poll(() => operator.frames.at(-1)).toBe('{"type":"key"}');
    const ended = once(operator.ws, "close");
    await api(path + "/grants/" + grant.id, "DELETE");
    await ended;
    expect((await fetch(operator.url, { headers: { cookie: operator.cookie } })).ok).toBe(false);
    expect(all<{ action: string }>(app.db, "select action from audit_events where target=? order by id", id).map(r => r.action)).toEqual(["remote.grant","remote.grant","remote.revoke"]);
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
      const { sessionId } = JSON.parse((await launch()).stdout);
      expect(JSON.parse((await launch()).stdout).sessionId).toBe(sessionId);
      const list = await (await api("", "GET", undefined, actorToken)).json();
      expect(list.sessions).toContainEqual(expect.objectContaining({ id: sessionId, ownerId: actor, runId: job.id, mine: true }));
      expect(runEvents(app, job.id)).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ link: "#/remote/" + sessionId }) }));
      cap("view");
      expect((await (await api("", "GET", undefined, token)).json()).sessions.map((s: {id:string}) => s.id)).not.toContain(sessionId);
      expect((await api("/sessions/" + sessionId + "/grants", "POST", { userId: member, mode: "view" }, actorToken)).ok).toBe(true);
      const viewer = await connect(sessionId);
      const ended = once(viewer.ws, "close");
      for (const client of ws.clients) client.terminate();
      await ended;
      expect((await fetch(viewer.url, { headers: { cookie: viewer.cookie } })).ok).toBe(false);
    } finally {
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
  });
});
