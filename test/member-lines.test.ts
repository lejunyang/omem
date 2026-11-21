import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { accountEntries, accountHome } from "../src/agents/accounts.ts";
import { getRun, listRuns, stopWorker } from "../src/agents/runs.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { saveContext } from "../src/channels/listen.ts";
import { assistDue } from "../src/channels/listen-assist.ts";
import { run as sqlRun } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { addChange } from "../src/items/changes.ts";
import { lineRoutine } from "../src/items/member-routine.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { queueWrapUp } from "../src/items/lifecycle.ts";
import { boot } from "../src/main.ts";

/**
 * A member's and an observer's work page (docs/v2/multi-user.md “成员的线”): the lines they may read, whole
 * where they may read everything under them; their own lines; nothing of what they may not read, not
 * even in the numbers.
 */
describe("members' work lines", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-member-lines-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({}));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(async () => {
    setSandboxSupportForTests(undefined);
    await server.close();
    stopWorker();
    app.db.close();
    try { rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* Windows may still hold a file of the account folder. */ }
  });
  const base = app.baseUrl!;
  createSpace(app, { id: "proj", name: "项目 A" });
  createSpace(app, { id: "other", name: "项目 B" });
  createUser(app, { id: "xw", name: "小王" });
  createUser(app, { id: "yl", name: "小林" });
  createUser(app, { id: "obs", name: "观察者", role: "observer" });
  addMember(app, "proj", "xw", "contributor");
  addMember(app, "proj", "yl", "contributor");
  addMember(app, "proj", "obs", "reader");
  const tokens: Record<string, string> = Object.fromEntries(["xw", "yl", "obs"].map((u) => [u, createApiToken(app, u, "test")]));
  const call = (user: string | null, path: string, init: RequestInit & { json?: unknown } = {}) =>
    fetch(base + path, {
      ...init, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
      headers: { ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    });
  const get = async (user: string | null, path: string) => {
    const r = await call(user, path);
    expect(r.status, `${user} ${path}`).toBe(200);
    return r.json();
  };
  // 小王 may read the owner's lines in 项目 A (看工作线), not the items under them (no 看事项 on others' items).
  await call(null, "/api/members/xw/capabilities", { method: "PUT", json: { preset: "member", overrides: [{ capability: "work.view", scope_kind: "space", scope_id: "proj", effect: "allow" }] } });
  await call(null, "/api/members/yl/capabilities", { method: "PUT", json: { preset: "member", overrides: [{ capability: "work.view", scope_kind: "space", scope_id: "proj", effect: "allow" }] } });

  const item = (input: Record<string, unknown>) => upsertItem(app, undefined, input as never, "user");
  const under = (child: string, parent: string) => sqlRun(app.db, "update items set parent_id = ? where id = ?", parent, child);
  const now = (id: string, text: string) => sqlRun(app.db, "update items set now = ? where id = ?", JSON.stringify({ text, people: [{ name: "小周", role: "后端" }], weeks: [{ label: "本周", text }], at: new Date().toISOString(), runId: null }), id);
  // The owner's line in 项目 A with one item in 项目 B under it: partial for everyone but the owner.
  const mixed = item({ spaceId: "proj", kind: "line", title: "退款改造" });
  const seen = item({ spaceId: "proj", kind: "todo", title: "退款接口联调" });
  const away = item({ spaceId: "other", kind: "todo", title: "隐藏的合同评审" });
  under(seen.id, mixed.id); under(away.id, mixed.id);
  now(mixed.id, "截至今天合同评审卡住了");
  addChange(app, { itemId: seen.id, type: "decision", summary: "接口按新版走", origin: "owner" });
  addChange(app, { itemId: away.id, type: "blocker", summary: "隐藏变化：合同条款没谈拢", origin: "owner" });
  sqlRun(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,created_at,updated_at) values('nx-mixed',?,?,?,'[]','ask','open',?,?)", mixed.id, "去问合同进度", "隐藏的理由", new Date().toISOString(), new Date().toISOString());
  // The owner's line in 项目 A with everything in 项目 A: whole for the observer.
  const whole = item({ spaceId: "proj", kind: "line", title: "会员体系" });
  const wholeChild = item({ spaceId: "proj", kind: "todo", title: "会员等级表" });
  under(wholeChild.id, whole.id);
  now(whole.id, "截至今天等级表定了");
  // The owner's line in the owner's personal space: nobody else's.
  const personal = item({ spaceId: "personal", kind: "line", title: "本人自己的线" });
  // Another member's line in the same space.
  const ylLine = item({ spaceId: "proj", kind: "line", title: "小林的线", userId: "yl" });

  it("gives the observer the lines of readable spaces, whole only where nothing under them is hidden", async () => {
    const work = await get("obs", "/api/work");
    const ids = work.lines.map((l: { id: string }) => l.id);
    expect(ids).toEqual(expect.arrayContaining([mixed.id, whole.id]));
    expect(ids).not.toContain(personal.id);
    expect(ids).not.toContain(ylLine.id);
    const m = work.lines.find((l: { id: string }) => l.id === mixed.id);
    expect(m.partial).toBe(true);
    expect(m.now).toBeNull();
    expect(m.next).toEqual([]);
    expect(m.children.map((c: { id: string }) => c.id)).toEqual([seen.id]);
    // Only the change on what they may read counts.
    expect(m.counts.changes).toBe(1);
    const w = work.lines.find((l: { id: string }) => l.id === whole.id);
    expect(w.partial).toBe(false);
    expect(w.now.text).toBe("截至今天等级表定了");
    expect(w.person.id).toBe("owner");
    const text = JSON.stringify(work);
    for (const secret of ["隐藏的合同评审", "隐藏变化", "合同评审卡住了", "隐藏的理由", "去问合同进度", away.id]) expect(text).not.toContain(secret);
    // Their own “等我的”: nothing waits for them.
    expect(work.waiting.total).toBe(0);
  });

  it("keeps a line's page to what the observer may read", async () => {
    const d = await get("obs", `/api/work/${mixed.id}`);
    expect(d.partial).toBe(true);
    expect(d.now).toBeNull();
    expect(d.item.now).toBeNull();
    expect(d.can).toEqual({ edit: false, operate: false });
    expect(d.children.map((c: { id: string }) => c.id)).toEqual([seen.id]);
    expect(d.timeline.map((c: { summary: string }) => c.summary)).toEqual(["接口按新版走"]);
    expect(d.chats).toEqual([]);
    const text = JSON.stringify(d);
    for (const secret of ["隐藏的合同评审", "隐藏变化", "合同评审卡住了", "隐藏的理由", away.id]) expect(text).not.toContain(secret);
    for (const id of [away.id, personal.id, ylLine.id]) expect((await call("obs", `/api/work/${id}`)).status).toBe(404);
    const full = await get("obs", `/api/work/${whole.id}`);
    expect(full.now.text).toBe("截至今天等级表定了");
    expect(full.children.map((c: { id: string }) => c.id)).toEqual([wholeChild.id]);
  });

  it("leaves hidden changes out of 按时间 and hidden summaries out of the ended lines", async () => {
    const acts = await get("obs", "/api/work/activities");
    expect(JSON.stringify(acts)).not.toContain("隐藏变化");
    expect(JSON.stringify(acts)).toContain("接口按新版走");
    expect((await call("obs", `/api/work/activities?line=${personal.id}`)).status).toBe(403);
    const ended = item({ spaceId: "proj", kind: "line", title: "旧版下线" });
    const endedAway = item({ spaceId: "other", kind: "todo", title: "隐藏的收尾" });
    under(endedAway.id, ended.id);
    sqlRun(app.db, "update items set status = 'done', closed_at = ?, now = ? where id = ?", new Date().toISOString(), JSON.stringify({ text: "x", people: [], weeks: [], at: new Date().toISOString(), runId: null, summary: "隐藏的小结" }), ended.id);
    const list = await get("obs", "/api/work/ended");
    const row = list.items.find((e: { id: string }) => e.id === ended.id);
    expect(row).toBeTruthy();
    expect(row.summary).toBeNull();
    expect(JSON.stringify(list)).not.toContain("隐藏的小结");
    // Nor can they find it by what its summary says.
    expect((await get("obs", "/api/work/ended?q=" + encodeURIComponent("隐藏的小结"))).items).toEqual([]);
  });

  it("gives a member with 看工作线 but not 看事项 the owner's lines without what is under them", async () => {
    const work = await get("xw", "/api/work");
    const w = work.lines.find((l: { id: string }) => l.id === whole.id);
    expect(w.partial).toBe(true);
    expect(w.now).toBeNull();
    expect(w.children).toEqual([]);
    expect(work.lines.map((l: { id: string }) => l.id)).not.toContain(ylLine.id);
    expect(JSON.stringify(work)).not.toContain("会员等级表");
    expect((await call("xw", `/api/work/${wholeChild.id}`)).status).toBe(404);
  });

  it("lets a member make their own line, hang their items under it and write its next steps", async () => {
    const made = await (await call("xw", "/api/items", { method: "POST", json: { kind: "line", space: "proj", title: "小王的导出改造" } })).json();
    expect(made.userId).toBe("xw");
    const todo = await (await call("xw", "/api/items", { method: "POST", json: { kind: "todo", space: "proj", title: "导出字段梳理" } })).json();
    expect((await call("xw", `/api/items/${todo.id}/parent`, { method: "PUT", json: { parent: made.id } })).status).toBe(200);
    const step = await call("xw", `/api/work/${made.id}/next`, { method: "POST", json: { text: "和小周对一遍字段", kind: "ask" } });
    expect(step.status).toBe(200);
    now(made.id, "截至今天字段梳理了一半");
    const work = await get("xw", "/api/work");
    const mine = work.lines.find((l: { id: string }) => l.id === made.id);
    expect(mine).toMatchObject({ partial: false, mine: true });
    expect(mine.now.text).toBe("截至今天字段梳理了一半");
    expect(mine.next.map((n: { text: string }) => n.text)).toEqual(["和小周对一遍字段"]);
    expect(mine.children.map((c: { id: string }) => c.id)).toEqual([todo.id]);
    const d = await get("xw", `/api/work/${made.id}`);
    expect(d.can).toEqual({ edit: true, operate: true });
    // The owner's page stays the owner's: nobody else's line comes into it.
    const owner = await get(null, "/api/work");
    expect(owner.lines.map((l: { id: string }) => l.id)).not.toContain(made.id);
    // Not on anyone else's line, not even in the same space.
    expect((await call("yl", `/api/work/${made.id}/next`, { method: "POST", json: { text: "替他写" } })).status).toBe(403);
    expect((await call("yl", `/api/work/${made.id}`)).status).toBe(404);
    const ylTodo = await (await call("yl", "/api/items", { method: "POST", json: { kind: "todo", space: "proj", title: "小林的事" } })).json();
    expect((await call("yl", `/api/items/${ylTodo.id}/parent`, { method: "PUT", json: { parent: made.id } })).status).toBe(403);
  });

  it("refuses a member every change to the owner's lines", async () => {
    const own = await (await call("xw", "/api/items", { method: "POST", json: { kind: "todo", space: "proj", title: "我的待办" } })).json();
    const change = addChange(app, { itemId: whole.id, type: "info", summary: "本人的变化", origin: "owner" })!;
    sqlRun(app.db, "insert into item_next(id,item_id,text,why,refs,kind,status,created_at,updated_at) values('nx-whole',?,'本人的下一步','','[]','read','open',?,?)", whole.id, new Date().toISOString(), new Date().toISOString());
    for (const [method, path, json] of [
      ["POST", `/api/work/${whole.id}/next`, { text: "替本人写" }],
      ["PUT", `/api/work/${whole.id}/phase`, { phase: "watching" }],
      ["POST", `/api/work/${whole.id}/refresh`, undefined],
      ["PUT", `/api/items/${wholeChild.id}/parent`, { parent: null }],
      ["PUT", `/api/items/${own.id}/parent`, { parent: whole.id }],
      ["PUT", "/api/item-next/nx-whole", { status: "declined" }],
      ["PUT", `/api/item-changes/${change}/noise`, { noise: true }],
    ] as const) {
      for (const user of ["xw", "obs"]) expect((await call(user, path, { method, ...(json ? { json } : {}) })).status, `${user} ${method} ${path}`).toBeGreaterThanOrEqual(403);
    }
    expect((await call("obs", "/api/items", { method: "POST", json: { kind: "line", space: "proj", title: "观察者的线" } })).status).toBe(403);
    expect((await call("obs", "/api/work/routine", { method: "PUT", json: { on: true } })).status).toBe(403);
  });

  it("does not run the routine work on a member's line unless they turned it on and have their own AI account", async () => {
    const line = item({ spaceId: "proj", kind: "line", title: "小王要每天看的线", userId: "xw" });
    saveContext(app, { kind: "item", itemId: line.id, name: line.title });
    const ownerLine = item({ spaceId: "proj", kind: "line", title: "本人要每天看的线" });
    saveContext(app, { kind: "item", itemId: ownerLine.id, name: ownerLine.title });
    const looks = (ids: string[]) => ids.map((id) => getRun(app, id).input.lineState);
    let ran = looks(await assistDue(app));
    expect(ran).toContain(ownerLine.id);
    expect(ran).not.toContain(line.id);
    expect(lineRoutine(app, "xw")).toMatchObject({ on: false, ready: false });
    // Turned on, but no account of their own: still nothing, and the page says why.
    expect((await call("xw", "/api/work/routine", { method: "PUT", json: { on: true } })).status).toBe(200);
    setSandboxSupportForTests({ ok: true } as never);
    ran = looks(await assistDue(app));
    expect(ran).not.toContain(line.id);
    const routine = (await get("xw", "/api/work")).routine;
    expect(routine).toMatchObject({ on: true, ready: false });
    expect(routine.reason).toContain("登录");
    expect((await call("xw", `/api/work/${line.id}/refresh`, { method: "POST" })).status).toBe(409);
    // Logged in to an account of their own: the look runs, and only on that account.
    const backend = accountEntries(app)[0];
    expect(backend).toBeTruthy();
    mkdirSync(accountHome(app, "xw"), { recursive: true });
    sqlRun(app.db, "insert into kv(key,value) values(?,?)", `agent_account:xw:${backend.id}`, JSON.stringify({ state: "logged-in" }));
    expect(lineRoutine(app, "xw").ready).toBe(true);
    const ids = await assistDue(app);
    const look = ids.map((id) => getRun(app, id)).find((r) => r.input.lineState === line.id)!;
    expect(look).toBeTruthy();
    expect((app.db.prepare("select user_id u from runs where id = ?").get(look.id) as { u: string }).u).toBe("xw");
    expect(look.input.ownAccountOnly).toBe(true);
    // Someone else may not switch it for them; the owner may.
    expect((await call("yl", "/api/work/routine", { method: "PUT", json: { on: false, user: "xw" } })).status).toBe(403);
    expect((await call(null, "/api/work/routine", { method: "PUT", json: { on: false, user: "xw" } })).status).toBe(200);
    expect(lineRoutine(app, "xw").on).toBe(false);
    // Nor the wrap-up after it ends.
    expect(queueWrapUp(app, getItem(app, line.id))).toBeNull();
    expect(listRuns(app, { kind: "agent" }).filter((r) => r.input.lineState === line.id)).toHaveLength(1);
  });
});
