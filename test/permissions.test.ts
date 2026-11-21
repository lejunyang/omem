import { upsertSource } from "../src/sources/store.ts";
import { setVisibility } from "../src/auth/visibility.ts";
import { ruleVisible, ruleSummary } from "../src/rules/visibility.ts";
import { ruleInputSchema } from "../src/rules/types.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRun, stopWorker } from "../src/agents/runs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { can, canReadRun, spacesWith } from "../src/auth/permissions.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { toolAllowed, trimTools } from "../src/auth/tools.ts";
import { notify } from "../src/core/notify.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser, setUserRole } from "../src/core/users.ts";
import { boot } from "../src/main.ts";
import { registeredRoutes } from "../src/server/http.ts";
import { remember } from "../src/memory/store.ts";
import { writePage } from "../src/wiki/store.ts";
import { migrations, run as sqlRun } from "../src/core/db.ts";

describe("roles and permissions", async () => {
  it.each(["global", "space"])("preserves a pre-existing custom observer role (%s) on upgrade", scope => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`create table roles(id text primary key,scope text); create table users(id text,role text);
        create table space_members(user_id text,space_id text,role text); create table rules(space_id text,created_at text);
        create table invites(role text,spaces text);`);
      db.prepare("insert into roles values ('observer',?),('observer-custom',?)").run(scope, scope);
      db.exec(`insert into users values('demo','observer'); insert into space_members values('demo','team','observer');
        insert into invites values('observer','[{"space":"team","role":"observer"}]');`);
      db.exec(migrations.find(m => m.includes("create table member_capability_overrides"))!);
      expect(db.prepare("select scope from roles where id='observer-custom-old'").get()?.scope).toBe(scope);
      const assignment = scope === "global" ? "users" : "space_members";
      expect(db.prepare(`select role from ${assignment}`).get()?.role).toBe("observer-custom-old");
      const invite = db.prepare("select role,json_extract(spaces,'$[0].role') space from invites").get()!;
      expect(invite[scope === "global" ? "role" : "space"]).toBe("observer-custom-old");
    } finally { db.close(); }
  });
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

  it("distinguishes own item and run ranges from sharing", async () => {
    const me = await json("ann", "/api/me");
    for (const cap of ["items.view", "runs.view"]) {
      expect(me.ownSpaceCaps[cap]).toContain("team");
      expect(me.spaceCaps[cap]).not.toContain("team");
    }
    const item = await (await fetch(base + "/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space: "team", title: "个人事项", kind:"todo" }) })).json();
    sqlRun(app.db, "update items set user_id=? where id=?", "ann", item.id);
    const r = createRun(app, { kind: "ask", title: "个人运行", spaceId: "team", userId: "ann", input: { spaces: ["team"] } });
    expect(JSON.stringify(await json("ann", "/api/items?space=team"))).toContain(item.id);
    expect((await json("ann", "/api/runs")).runs.map((x: {id: string}) => x.id)).toContain(r.id);
  });

  it("shares work and items with observers only in readable spaces", async () => {
    createUser(app, { id: "observer-test", name: "观察者", role: "observer" });
    addMember(app, "team", "observer-test", "reader");
    tokens["observer-test"] = createApiToken(app, "observer-test", "test");
    const make = async (space: string) => (await fetch(base + "/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "line", space, title: "项目进度" }) })).json();
    const visible = await make("team"), hidden = await make("other");
    for (const status of ["waiting", "snoozed"]) {
      const child = await make("team");
      sqlRun(app.db, "update items set status=?,parent_id=? where id=?", status, visible.id, child.id);
      expect(JSON.stringify(await json("observer-test", "/api/work/" + visible.id))).not.toContain(child.id);
      expect((await as("observer-test", "/api/work/" + child.id)).status).toBe(404);
      sqlRun(app.db, "update items set parent_id=null where id=?", child.id);
      expect(JSON.stringify(await json("observer-test", "/api/work"))).not.toContain(child.id);
    }
    const work = await json("observer-test", "/api/work");
    expect(work.lines.map((line: { id: string }) => line.id)).toContain(visible.id);
    expect(work.lines.map((line: { id: string }) => line.id)).not.toContain(hidden.id);
    expect(work).not.toHaveProperty("waiting");
    expect((await json("observer-test", "/api/items/" + visible.id)).can).toEqual({ edit: false, operate: false });
    expect((await as("observer-test", "/api/items/" + hidden.id)).status).toBe(404);
    expect((await as("observer-test", "/api/items/" + visible.id, { method: "PATCH", body: '{"title":"编辑"}' })).status).toBe(403);
    expect((await as("observer-test", "/api/rules")).status).toBe(200);
  });

  it("projects write events in history and the live stream", async () => {
    const {addRunEvent} = await import("../src/agents/runs.ts");
    const user = "event-observer";
    createUser(app,{id:user,name:"读者",role:"observer"});
    addMember(app,"team",user,"reader");
    tokens[user]=createApiToken(app,user,"test");
    await fetch(base+"/api/members/"+user+"/capabilities",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({preset:"observer",overrides:[{capability:"memories.view",scope_kind:"space",scope_id:"team",effect:"deny"}]})});
    const r=createRun(app,{kind:"ask",spaceId:"team",userId:"owner",title:"记录",input:{spaces:["team"]}});
    const ctrl=new AbortController();
    const reader=(await as(user,"/api/events?run="+r.id,{signal:ctrl.signal})).body!.getReader();
    try {
      for (const name of ["remember","save_rule"]) addRunEvent(app,r.id,"tool-write",{name,args:{content:"隐藏正文",rule:{actions:[{type:"script",code:"隐藏脚本"}]}},result:"隐藏结果"});
      const history=await json(user,"/api/runs/"+r.id);
      expect(history.events.filter((e:{type:string})=>e.type==="tool-write").map((e:{data:object})=>e.data)).toEqual([{},{}]);
      let stream="";
      while (stream.split("tool-write").length<3) stream+=new TextDecoder().decode((await reader.read()).value);
      expect(stream).not.toMatch(/隐藏正文|隐藏脚本|隐藏结果/);
    } finally {ctrl.abort();}
  });

  it("lists generic and matching flow definitions only", async () => {
    const { saveFlow } = await import("../src/flows/definitions.ts");
    for (const [id, spaces] of [["generic", []], ["shared", ["team","other"]], ["private-flow", ["other"]]] as const) {
      saveFlow(app, JSON.stringify({ id, name:id, for:{spaces}, stages:[{id:"step",name:"阶段",by:"owner"}] }), "owner");
    }
    const ids = (await json("ann","/api/flows")).flows.map((f: {id:string}) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["generic","shared"]));
    expect(ids).not.toContain("private-flow");
  });

  it("allows ordinary observer answers and mapped edits only", async () => {
    const id = "answer-reader";
    createUser(app, { id, name: "参与者", role: "observer" });
    addMember(app,"team",id,"reader");
    tokens[id] = createApiToken(app,id,"test");
    sqlRun(app.db,"insert into conversations(id,space_id,user_id,created_at,updated_at) values('demo-question','team',?,'','')",id);
    const r = createRun(app,{kind:"ask",title:"询问",spaceId:"team",userId:id,input:{conversationId:"demo-question"}});
    const {createAsk} = await import("../src/agents/asks.ts");
    const ask = (props: Partial<Parameters<typeof createAsk>[1]> = {}) => createAsk(app,{runId:r.id,userId:id,question:"选哪一天？",...props}).id;
    const post = (path: string, body: object = {}) => as(id,path,{method:"POST",body:JSON.stringify(body)});
    expect((await post("/api/asks/"+ask()+"/answer",{text:"周一"})).status).toBe(200);
    expect((await post("/api/asks/"+ask()+"/dismiss")).status).toBe(200);
    for (const card of [ask({kind:"approval"}),ask({context:{handler:"flow-save"}}),ask({userId:"ann"})])
      expect((await post("/api/asks/"+card+"/answer",{text:"好"})).status).toBe(403);
    const item = {space:"team",kind:"todo",title:"测试事项"};
    expect((await post("/api/items",item)).status).toBe(403);
    addMember(app,"team",id,"editor");
    const made = await post("/api/items",item);
    expect(made.status).toBe(200);
    const own = await made.json();
    sqlRun(app.db,"update items set user_id='owner' where id=?",own.id);
    expect((await as(id,"/api/items/"+own.id,{method:"PATCH",body:JSON.stringify({title:"改名"})})).status).toBe(403);
    expect((await post("/api/items",{...item,space:"other"})).status).toBe(403);
    expect((await post("/api/memories",{space:"team"})).status).toBe(403);
    expect((await as(id,"/api/wiki/team/page/example",{method:"PUT",body:"{}"})).status).toBe(403);
    await fetch(base+"/api/members/"+id+"/capabilities",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({preset:"observer",overrides:[{capability:"items.edit",scope_kind:"space",scope_id:"team",effect:"deny"}]})});
    expect((await post("/api/items",item)).status).toBe(403);
  });

  it("applies a revoked run capability to lists, details and the next SSE event", async () => {
    const id = "stream-reader";
    createUser(app, { id, name: "观察者", role: "observer" });
    addMember(app, "team", id, "reader");
    tokens[id] = createApiToken(app, id, "test");
    const code = createRun(app, { kind: "code", title: "编码记录", spaceId: "team", userId: "owner", input: { spaces: ["team"] } });
    const mixed = createRun(app, { kind: "code", title: "编码记录", spaceId: "team", userId: "owner", input: { spaces: ["team", "other"] } });
    expect((await as(id, `/api/runs/${code.id}/reviews`)).status).toBe(200);
    expect((await as(id, `/api/runs/${mixed.id}/reviews`)).status).toBe(404);
    expect((await json(id, "/api/runs/" + code.id)).can.operate).toBe(false);
    expect((await as(id, `/api/runs/${code.id}/retry`, { method: "POST" })).status).toBe(403);
    const put = async (deny: boolean) => fetch(base + "/api/members/" + id + "/capabilities", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "observer", overrides: deny ? [{ scope_kind: "space", scope_id: "team", capability: "runs.view", effect: "deny" }] : [] }) });
    const controller = new AbortController();
    const response = await as(id, "/api/events", { signal: controller.signal });
    const reader = response.body!.getReader();
    const readUntil = async (end: string) => {
      let text = "";
      while (!text.includes(end)) text += new TextDecoder().decode((await reader.read()).value);
      return text;
    };
    try {
      app.emit({ type: "run", runId: code.id, status: "first" });
      await readUntil("first");
      expect((await put(true)).status).toBe(200);
      app.emit({ type: "run", runId: code.id, status: "revoked" });
      app.emit({ type: "changed", entity: "space", id: "team" });
      expect(await readUntil("changed")).not.toContain("revoked");
      expect((await as(id, "/api/runs/" + code.id)).status).toBe(404);
      expect((await json(id, "/api/runs")).runs.map((r: { id: string }) => r.id)).not.toContain(code.id);
      expect((await put(false)).status).toBe(200);
      expect((await as(id, "/api/runs/" + code.id)).status).toBe(200);
    } finally { controller.abort(); }
  });

  it("reports capability origins, prioritizes denial and trims observer tool tokens", async () => {
    const id = "cap-test";
    createUser(app, { id, name: "项目成员" });
    addMember(app, "team", id, "reader");
    tokens[id] = createApiToken(app, id, "test");
    const path = "/api/members/" + id + "/capabilities";
    const put = (preset: string, overrides: object[]) => fetch(base + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset, overrides }) });
    expect((await as(id, path)).status).toBe(403);
    const catalog = await (await fetch(base + "/api/capabilities")).json();
    expect(catalog).toHaveLength(24);
    expect((await as(id, "/api/rules")).status).toBe(403);
    const member = await (await put("member", [{ capability: "rules.view", scope_kind: "global", effect: "allow" }])).json();
    expect(member.effective["rules.view"]).toBe("override");
    expect(member.effective["wiki.view"].team).toBe("spaceRole");
    expect((await as(id, "/api/rules")).status).toBe(200);
    await put("member", [{ capability: "rules.edit", scope_kind: "global", effect: "allow" }]);
    const ruleCtx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "team", spaces: ["team"], tools: new Set(["save_rule"]), actor: "agent", userId: id }))!;
    const result = await callTool(ruleCtx, "save_rule", { description: "示例规则", name: "记录变化", rule: { conditions: { field: "chat.id", op: "equals", value: "team" }, actions: [{ type: "notify", text: "变化" }] } });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    await put("observer", [{ capability: "wiki.view", scope_kind: "space", scope_id: "team", effect: "deny" }, { capability: "wiki.view", scope_kind: "global", effect: "allow" }]);
    const me = await json(id, "/api/me");
    expect(me.caps).toContain("ask.send");
    expect(me.spaceCaps["runs.view"]).toContain("team");
    expect(me.spaceCaps["wiki.view"]).not.toContain("team");
    expect(me.spaceCaps["sources.view"]).not.toContain("personal");
    expect((await as(id, "/api/wiki/team")).status).toBe(403);
    const names = new Set(["search", "read_item", "list_items", "upsert_item", "remember", "write_page", "delegate_code", "lark_send", "lark_write"]);
    trimTools(app, id, names);
    expect([...names]).toEqual(["search", "read_item", "list_items"]);
    const ctx = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "team", spaces: ["team"], tools: names, actor: "agent", userId: id }))!;
    expect((await callTool(ctx, "list_items", {})).isError).toBe(false);
    expect((await callTool(ctx, "remember", {})).isError).toBe(true);
    expect((await as(id, "/api/assistants", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await as(id, "/api/metrics")).status).toBe(200);
  });

  it("keeps rule scripts, nested space conditions and restricted originals out of read-only views", async () => {
    const rule = {
      ...ruleInputSchema.parse({ name: "示例规则", description: "运行检查", conditions: { any: [{ field: "doc.space", op: "equals", value: "other" }] }, actions: [{ type: "script", runtime: "node", code: "// private example" }] }),
      id: "rule-sample", createdAt: "", updatedAt: "", createdBy: "owner", hits: 0, lastFiredAt: null, temporary: null
    };
    expect(ruleVisible(rule, new Set(["team"]))).toBe(false);
    expect(ruleVisible(rule, new Set(["other"]))).toBe(true);
    expect(ruleSummary(rule).actions).toEqual([{ type: "script" }]);
    const source = upsertSource(app, { spaceId: "team", kind: "note", uri: "sample:limited", title: "仅授权者可读", text: "文稿" });
    setVisibility(app, source.id, "restricted");
    const id = "limited-reader";
    createUser(app, { id, name: "只读用户", role: "observer" });
    addMember(app, "team", id, "reader");
    tokens[id] = createApiToken(app, id, "test");
    expect((await as(id, "/api/sources/" + source.id)).status).toBe(403);
    expect(await (await as(id, "/api/sources/paths?space=team")).text()).not.toContain(source.id);
    expect((await json(id, "/api/lookup?id=" + source.id)).hits).toEqual([]);
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
