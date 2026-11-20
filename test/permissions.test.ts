import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, stopWorker } from "../src/agents/runs.ts";
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
import { run as sqlRun } from "../src/core/db.ts";

describe("roles and permissions", async () => {
  it("keeps repository lesson curation owner-only", () => {
    for (const key of ["GET /api/spaces/:id/lessons", "POST /api/spaces/:id/lessons", "PUT /api/spaces/:id/lessons/:lesson", "DELETE /api/spaces/:id/lessons/:lesson"])
      expect(ROUTE_RULES[key]).toBe("owner");
    expect(toolAllowed(app, "owner", "propose_repo_lesson")).toBe(true);
  });
  it("keeps level audit decisions owner-only", () => {
    expect(ROUTE_RULES["POST /api/sources/level-audit/review"]).toBe("owner");
  });
  const home = mkdtempSync(join(tmpdir(), "omem-perms-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({}));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(async () => {
    await server.close();
    stopWorker();
    app.db.close();
    rmSync(home, { recursive: true, force: true });
  });
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

  it("preserves the four original roles' representative route responses", async () => {
    for (const [path, expected] of [
      ["/api/work", [200, 403, 403, 403]],
      ["/api/rules", [200, 200, 403, 403]],
      ["/api/wiki/team", [200, 200, 200, 200]],
    ] as const) {
      const responses = await Promise.all([fetch(base + path), ...["cat", "ann", "dan"].map(id => as(id, path))]);
      expect(responses.map(r => r.status)).toEqual(expected);
    }
  });

  it("shares work and items with observers only in readable spaces", async () => {
    createUser(app, { id: "observer-test", name: "观察者", role: "observer" });
    addMember(app,"team","observer-test","reader");
    tokens["observer-test"] = createApiToken(app,"observer-test","test");
    const make = async (space:string) => (await fetch(base+"/api/items",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"line",space,title:"项目进度"})})).json();
    const visible = await make("team"), hidden = await make("other");
    const work = await json("observer-test","/api/work");
    expect(work.lines.map((line:{id:string})=>line.id)).toContain(visible.id);
    expect(work.lines.map((line:{id:string})=>line.id)).not.toContain(hidden.id);
    expect(work).not.toHaveProperty("waiting");
    expect((await json("observer-test","/api/items/"+visible.id)).can).toEqual({edit:false,operate:false});
    expect((await as("observer-test","/api/items/"+hidden.id)).status).toBe(404);
    expect((await as("observer-test","/api/items/"+visible.id,{method:"PATCH",body:'{"title":"编辑"}'})).status).toBe(403);
    expect((await as("observer-test","/api/rules")).status).toBe(200);
  });

  it("applies a revoked run capability to lists, details and the next SSE event", async () => {
    const id = "stream-reader";
    createUser(app,{id,name:"观察者",role:"observer"});
    addMember(app,"team",id,"reader");
    tokens[id] = createApiToken(app,id,"test");
    const code = createRun(app,{kind:"code",title:"编码记录",spaceId:"team",userId:"owner",input:{spaces:["team"]}});
    const mixed = createRun(app,{kind:"code",title:"编码记录",spaceId:"team",userId:"owner",input:{spaces:["team","other"]}});
    expect((await as(id,`/api/runs/${code.id}/reviews`)).status).toBe(200);
    expect((await as(id,`/api/runs/${mixed.id}/reviews`)).status).toBe(404);
    expect((await json(id,"/api/runs/"+code.id)).can.operate).toBe(false);
    expect((await as(id,`/api/runs/${code.id}/retry`,{method:"POST"})).status).toBe(403);
    const put = async (deny:boolean) => fetch(base+"/api/members/"+id+"/capabilities",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({preset:"observer",overrides:deny ? [{scope_kind:"space",scope_id:"team",capability:"runs.view",effect:"deny"}] : []})});
    const controller = new AbortController();
    const response = await as(id,"/api/events",{signal:controller.signal});
    const reader = response.body!.getReader();
    const readUntil = async (end:string) => {
      let text = "";
      while (!text.includes(end)) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    };
    try {
      app.emit({type:"run",runId:code.id,status:"first"});
      await readUntil("first");
      expect((await put(true)).status).toBe(200);
      app.emit({type:"run",runId:code.id,status:"revoked"});
      app.emit({type:"changed",entity:"space",id:"team"});
      expect(await readUntil("changed")).not.toContain("revoked");
      expect((await as(id,"/api/runs/"+code.id)).status).toBe(404);
      expect((await json(id,"/api/runs")).runs.map((r:{id:string})=>r.id)).not.toContain(code.id);
      expect((await put(false)).status).toBe(200);
      expect((await as(id,"/api/runs/"+code.id)).status).toBe(200);
    } finally { controller.abort(); }
  });

  it("keeps decision calibration owner-only", async () => {
    expect(ROUTE_RULES["GET /api/ai/decision/report"]).toBe("owner");
    expect((await as("ann", "/api/ai/decision/report")).status).toBe(403);
    expect((await as("cat", "/api/ai/decision/report")).status).toBe(403);
    const result = await fetch(base + "/api/ai/decision/report?days=7");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ days: 7, scenes: expect.any(Array) });
  });

  it("serves insights, record lists and exports as self, with members limited to their own part", async () => {
    for (const path of ["/api/insights", "/api/insights/records", "/api/insights/export"]) expect(ROUTE_RULES[`GET ${path}`]).toBe("self");
    const at = "2026-11-05T03:00:00.000Z";
    for (const [id, user, by] of [["insight-member", "ann", "user:ann"], ["insight-other", "bob", "user:bob"]]) sqlRun(app.db, "insert into runs(id,kind,space_id,status,user_id,trigger_by,created_at) values(?,?,?,?,?,?,?)", id, "ask", "team", "done", user, by, at);
    const filter = "from=2026-11-01&to=2026-11-15";
    const report = await json("ann", `/api/insights?${filter}`);
    expect(report.sections.flatMap((s: { metrics: { key: string; value: number }[] }) => s.metrics).find((m: { key: string }) => m.key === "usage:total").value).toBe(1);
    expect(report.options.people).toEqual(["user:ann"]);
    const detail = await json("ann", `/api/insights/records?${filter}&metric=usage:total`);
    expect(detail.records.map((r: { id: string }) => r.id)).toEqual(["insight-member"]);
    for (const format of ["csv", "md"]) {
      const response = await as("ann", `/api/insights/export?${filter}&format=${format}`);
      expect(response.status).toBe(200); expect(response.headers.get("content-disposition")).toContain(`insights.${format}`);
      expect(await response.text()).not.toContain("user:bob");
    }
    expect((await as("ann", "/api/insights?from=2026-01-01&to=2026-11-15")).status).toBe(400);
  });

  it("knows what every API route needs, and lists no route that does not exist", () => {
    expect(ROUTE_RULES["GET /api/code/:id/improve"]).toEqual({ run: "read" });
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

  it("keeps improvement history behind the delegation's read permission", async () => {
    const r = createRun(app, { kind: "code", spaceId: "other", title: "改进目标", input: { spaces: ["other"] }, userId: "owner" });
    expect((await as("ann", `/api/code/${r.id}/improve`)).status).toBe(404);
    expect((await as("cat", `/api/code/${r.id}/improve`)).status).toBe(200);
    expect(toolAllowed(app, "dan", "improve_start")).toBe(false);
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

  it("keeps space selection in scenario packs restricted to the owner", async () => {
    for (const user of ["ann", "cat", "dan"]) {
      expect((await as(user, "/api/plugins/pack")).status).toBe(403);
      expect((await as(user, "/api/plugins/pack", { method: "POST", body: JSON.stringify({ id: "restrictedpack", name: "示例", spaces: ["team", "personal"] }) })).status).toBe(403);
    }
  });

  it("opens the pages of a space by its role", async () => {
    writePage(app, "team", "intro", { meta: { title: "介绍" }, body: "团队介绍" });
    expect(((await json("ann", "/api/spaces")) as { id: string }[]).map((s) => s.id).sort()).toEqual(["personal-ann", "team"]);
    expect((await as("ann", "/api/wiki/team")).status).toBe(200);
    expect((await as("ann", "/api/wiki/other")).status).toBe(403);
    expect((await as("ann", "/api/wiki/team/corrections")).status).toBe(403);
    expect((await as("bob", "/api/wiki/team/corrections")).status).toBe(200);
    expect((await as("bob", "/api/wiki/other/corrections")).status).toBe(403);
    const correction = { method: "POST", body: JSON.stringify({ slug: "intro", wrong: "旧说法", right: "新说法" }) };
    expect((await as("ann", "/api/wiki/team/corrections", correction)).status).toBe(403);
    expect((await as("bob", "/api/wiki/other/corrections", correction)).status).toBe(403);
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
  it("restricts coverage statistics and manual generation to Wiki writers", async () => {
    expect((await as("ann", "/api/wiki/team/coverage")).status).toBe(403);
    expect((await as("ann", "/api/wiki/team/coverage/run", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await as("bob", "/api/wiki/team/coverage")).status).toBe(200);
    expect((await as("bob", "/api/wiki/team/coverage/run", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await as("bob", "/api/wiki/other/coverage")).status).toBe(403);
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
