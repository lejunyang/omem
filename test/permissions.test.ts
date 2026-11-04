import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { can, canReadRun, spacesWith } from "../src/auth/permissions.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { toolAllowed } from "../src/auth/tools.ts";
import { notify } from "../src/core/notify.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser, setUserRole } from "../src/core/users.ts";
import { boot } from "../src/main.ts";
import { registeredRoutes } from "../src/server/http.ts";
import { remember } from "../src/memory/store.ts";
import { writePage } from "../src/wiki/store.ts";

describe("roles and permissions", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-perms-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({}));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const base = app.baseUrl!;

  createSpace(app, { id: "team", name: "团队" });
  createSpace(app, { id: "other", name: "别的" });
  for (const [id, role] of [["ann", "member"], ["bob", "member"], ["cat", "admin"], ["dan", "viewer"]] as const) {
    createUser(app, { name: id, id });
    if (role !== "member") setUserRole(app, id, role);
  }
  addMember(app, "team", "ann", "reader");
  addMember(app, "team", "bob", "editor");
  addMember(app, "team", "dan", "contributor");
  const tokens = Object.fromEntries(["ann", "bob", "cat", "dan"].map((u) => [u, createApiToken(app, u, "test")]));
  const as = (user: string, path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${tokens[user]}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) } });
  const json = async (user: string, path: string, init: RequestInit = {}) => (await as(user, path, init)).json();

  it("knows what every API route needs, and lists no route that does not exist", () => {
    const listed = new Set(Object.keys(ROUTE_RULES));
    const missing = [...registeredRoutes].filter((r) => {
      const [method, url] = r.split(" ");
      if (method === "HEAD" || method === "OPTIONS") return false;
      return !listed.has(r) && !listed.has(`* ${url}`);
    });
    expect(missing).toEqual([]);
    const urls = new Set([...registeredRoutes].map((r) => r.split(" ")[1]));
    expect(Object.keys(ROUTE_RULES).filter((k) => (k.startsWith("* ") ? !urls.has(k.slice(2)) : !registeredRoutes.has(k)))).toEqual([]);
  });

  it("grants by global role and by space role", () => {
    expect(can(app, "ann", "space.read", "team")).toBe(true);
    expect(can(app, "ann", "wiki.write", "team")).toBe(false);
    expect(can(app, "bob", "wiki.write", "team")).toBe(true);
    expect(can(app, "dan", "memory.write", "team")).toBe(true);
    expect(can(app, "dan", "wiki.write", "team")).toBe(false);
    expect(can(app, "dan", "spaces.create")).toBe(false);
    expect(can(app, "ann", "spaces.create")).toBe(true);
    // The admin reaches every space, except other people's personal ones.
    expect(can(app, "cat", "space.manage", "other")).toBe(true);
    expect(can(app, "cat", "space.read", "personal-ann")).toBe(false);
    expect(can(app, "cat", "space.read", "personal")).toBe(false);
    expect(spacesWith(app, "cat", "space.read")).toEqual(expect.arrayContaining(["team", "other", "personal-cat"]));
    expect(spacesWith(app, "cat", "space.read")).not.toContain("personal-ann");
    expect(can(app, "cat", "settings.manage")).toBe(false);
    expect(can(app, "cat", "agents.manage")).toBe(true);
  });

  it("opens the pages of a space by its role", async () => {
    writePage(app, "team", "intro", { meta: { title: "介绍" }, body: "团队介绍" });
    expect(((await json("ann", "/api/spaces")) as { id: string }[]).map((s) => s.id).sort()).toEqual(["personal-ann", "team"]);
    expect((await as("ann", "/api/wiki/team")).status).toBe(200);
    expect((await as("ann", "/api/wiki/other")).status).toBe(403);
    const page = JSON.stringify({ title: "介绍", body: "改过了" });
    expect((await as("ann", "/api/wiki/team/page/intro", { method: "PUT", body: page })).status).toBe(403);
    expect((await as("bob", "/api/wiki/team/page/intro", { method: "PUT", body: page })).status).toBe(200);
    // A contributor writes memories but not pages.
    expect((await as("dan", "/api/memories", { method: "POST", body: JSON.stringify({ space: "team", kind: "fact", content: "周会在周三" }) })).status).toBe(200);
    expect((await as("ann", "/api/memories", { method: "POST", body: JSON.stringify({ space: "team", kind: "fact", content: "周会在周四" }) })).status).toBe(403);
    // Lists that would cover every space need one named.
    expect((await as("ann", "/api/sources")).status).toBe(400);
    expect((await as("ann", "/api/sources?space=team")).status).toBe(200);
    expect((await as("ann", "/api/sources?space=other")).status).toBe(403);
    const m = remember(app, { spaceId: "other", kind: "fact", content: "别处的事" });
    expect((await as("ann", `/api/memories/${m.id}`)).status).toBe(403);
    // The memory page lists every space at once: only the readable ones.
    const listed = (await json("ann", "/api/memories")) as { spaceId: string }[];
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((x) => ["team", "personal-ann"].includes(x.spaceId))).toBe(true);
    expect((await as("ann", "/api/memories?space=other")).status).toBe(403);
    expect((await as("ann", "/api/memory-folders?space=other")).status).toBe(403);
  });

  it("keeps the shared setup to those who manage it", async () => {
    expect((await as("cat", "/api/agents")).status).toBe(200);
    expect((await as("ann", "/api/agents")).status).toBe(403);
    expect((await as("cat", "/api/settings")).status).toBe(403);
    expect((await as("cat", "/api/delegate", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await as("ann", "/api/home")).status).toBe(403);
  });

  it("lets whoever creates a space manage it", async () => {
    expect((await as("dan", "/api/spaces", { method: "POST", body: JSON.stringify({ name: "访客空间" }) })).status).toBe(403);
    const s = await json("ann", "/api/spaces", { method: "POST", body: JSON.stringify({ id: "ann-proj", name: "小安的项目" }) });
    expect(s.id).toBe("ann-proj");
    expect(can(app, "ann", "space.manage", "ann-proj")).toBe(true);
    expect((await as("ann", "/api/spaces", { method: "POST", body: JSON.stringify({ name: "关联目录", rootPath: home }) })).status).toBe(403);
    expect((await as("ann", "/api/spaces/ann-proj/members/bob", { method: "PUT", body: JSON.stringify({ role: "reader" }) })).status).toBe(200);
    expect(((await json("ann", "/api/spaces/ann-proj/members")) as { id: string; spaceRole: string }[]).map((m) => [m.id, m.spaceRole]).sort()).toEqual([["ann", "manager"], ["bob", "reader"]]);
    // A reader there does not manage it.
    expect((await as("bob", "/api/spaces/ann-proj/members/dan", { method: "PUT", body: JSON.stringify({ role: "reader" }) })).status).toBe(403);
    expect((await as("ann", "/api/spaces/ann-proj/members/ann", { method: "PUT", body: JSON.stringify({ role: null }) })).status).toBe(400);
  });

  it("custom roles are the owner's to make", async () => {
    const local = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: init.body ? { "content-type": "application/json" } : {} });
    expect((await as("cat", "/api/access/roles", { method: "POST", body: JSON.stringify({ name: "审稿", scope: "space", permissions: ["space.read", "wiki.write"] }) })).status).toBe(403);
    const r = await (await local("/api/access/roles", { method: "POST", body: JSON.stringify({ id: "proofreader", name: "审稿", scope: "space", permissions: ["space.read", "wiki.write"] }) })).json();
    expect(r.id).toBe("proofreader");
    expect((await local("/api/access/roles", { method: "POST", body: JSON.stringify({ name: "乱写", scope: "space", permissions: ["settings.manage"] }) })).status).toBe(400);
    addMember(app, "other", "ann", "proofreader");
    expect(can(app, "ann", "wiki.write", "other")).toBe(true);
    expect(can(app, "ann", "memory.write", "other")).toBe(false);
    expect((await local("/api/access/roles/proofreader", { method: "DELETE" })).status).toBe(409);
    expect((await local("/api/users/ann", { method: "PATCH", body: JSON.stringify({ role: "admin" }) })).status).toBe(200);
    expect(can(app, "ann", "agents.manage")).toBe(true);
    setUserRole(app, "ann", "member");
    const audit = (await (await local("/api/access/audit")).json()) as { action: string; target: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["role.save", "user.role", "space.member"]));
  });

  it("shows a run to those who may read every space it could read", async () => {
    const mine = createRun(app, { kind: "ask", spaceId: "team", title: "安的问题", userId: "ann" });
    const teamOnly = createRun(app, { kind: "ask", spaceId: "team", title: "只在团队里", userId: "ann", input: { spaces: ["team"] } });
    const owners = createRun(app, { kind: "ask", spaceId: "personal", title: "本人的", userId: "owner" });
    expect(canReadRun(app, "ann", mine.id)).toBe(true);
    // Its scope includes ann's personal space: nobody else (but the owner).
    expect(canReadRun(app, "bob", mine.id)).toBe(false);
    expect(canReadRun(app, "cat", mine.id)).toBe(false);
    // Only the team: an editor there (runs.read) and the admin may; a contributor may not.
    expect(canReadRun(app, "bob", teamOnly.id)).toBe(true);
    expect(canReadRun(app, "cat", teamOnly.id)).toBe(true);
    expect(canReadRun(app, "dan", teamOnly.id)).toBe(false);
    expect(canReadRun(app, "cat", owners.id)).toBe(false);
    const list = (await json("bob", "/api/runs")) as { runs: { id: string }[] };
    expect(list.runs.map((r) => r.id)).toContain(teamOnly.id);
    expect(list.runs.map((r) => r.id)).not.toContain(mine.id);
    expect((await as("bob", `/api/runs/${mine.id}`)).status).toBe(404);
    expect((await as("bob", `/api/runs/${teamOnly.id}`)).status).toBe(200);
    // Reading is not stopping.
    expect((await as("bob", `/api/runs/${teamOnly.id}/cancel`, { method: "POST", body: "{}" })).status).toBe(403);
  });

  it("keeps notifications and conversations to their person", async () => {
    notify(app, { userId: "ann", title: "给安的", urgency: "silent" });
    notify(app, { title: "给本人的", urgency: "silent" });
    expect(((await json("ann", "/api/notifications")) as { notifications: { title: string }[] }).notifications.map((n) => n.title)).toEqual(["给安的"]);
    const conv = app.db.prepare("insert into conversations(id,space_id,channel,title,created_at,updated_at,user_id) values('c_bob','team','web','x',?,?,'bob')").run(new Date().toISOString(), new Date().toISOString());
    expect(conv.changes).toBe(1);
    expect((await as("ann", "/api/conversations/c_bob", { method: "DELETE" })).status).toBe(404);
    expect((await as("bob", "/api/conversations/c_bob", { method: "DELETE" })).status).toBe(200);
  });

  it("leaves out tools the run's person may not use", async () => {
    expect(toolAllowed(app, "ann", "search")).toBe(true);
    expect(toolAllowed(app, "ann", "delegate_code")).toBe(false);
    expect(toolAllowed(app, "ann", "save_rule")).toBe(false);
    expect(toolAllowed(app, "cat", "save_rule")).toBe(true);
    expect(toolAllowed(app, "owner", "delegate_code")).toBe(true);
    const token = issueToolToken({ runId: null, spaceId: "team", spaces: ["team"], tools: null, actor: "agent", userId: "ann" });
    const ctx = toolContextForToken(app, token)!;
    expect((await callTool(ctx, "save_rule", {})).text).toMatch(/没有这项权限/);
    expect((await callTool(ctx, "write_page", { page: "x", title: "x", summary: "x", body: "x", space: "team" })).text).toMatch(/不能写 Wiki|无权/);
  });
});
