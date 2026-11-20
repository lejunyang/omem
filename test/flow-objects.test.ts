import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { registerLoginProvider, setAuthFetchForTests } from "../src/auth/providers.ts";
import { closeVault, storeConnection } from "../src/auth/vault.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { materialsBrief, materialViews } from "../src/items/materials.ts";
import { itemEvents, upsertItem } from "../src/items/store.ts";
import { describeStage, parseFlow, saveFlow } from "../src/flows/definitions.ts";
import { advance, flowReminders, flowView, ownerAction, startFlow } from "../src/flows/engine.ts";
import { getStage, stageLog } from "../src/flows/store.ts";
import { attachObject, detachObject, itemObjects, pollObjects } from "../src/flows/plugin-objects.ts";
import { pluginContext } from "../src/plugins/blocks.ts";
import { pluginObjectKind, registerObject } from "../src/plugins/objects.ts";
import { forgetPlugin, getPlugin, loadPlugins, setPluginEnabled, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import type { PluginApi, PluginObject } from "../src/plugins/types.ts";
import type { PluginObject as SdkObject } from "../packages/plugin-sdk/objects.ts";
import { startServer } from "../src/server/http.ts";
import github, { pullRequestMatch } from "../plugins/github/server.ts";
import { testApp } from "./helpers.ts";

let app: App;
const servers: FastifyInstance[] = [];
let undoProvider: () => void;
const owner = { actor: "owner", userId: "owner" };
const kind = "objectprobe:change";
const url = (key = "1") => `https://example.test/changes/${key}`;
const raw = (by: unknown = { object: kind }, done?: unknown) => JSON.stringify({ id: "objects", name: "对象流程", stages: [{ id: "merge", name: "等合并", by, ...(done ? { done } : {}) }, { id: "next", name: "后续", by: "wait" }] });
const item = (userId = "owner", spaceId = "personal") => upsertItem(app, undefined, { title: "示例商城退款", spaceId, userId }, "user");
const store = (userId = "owner", spaceId = "personal") => pluginStore(app, "objectprobe", userId, spaceId);
const set = (key: string, value: Record<string, unknown>, userId = "owner", spaceId = "personal") => store(userId, spaceId).put("states", key, value);
const reads = (key = "1", userId = "owner", spaceId = "personal") => store(userId, spaceId).get<{ n: number }>("reads", key)?.n ?? 0;
const oldChecks = () => run(app.db, "update flow_objects set checked_at='2000-01-01T00:00:00.000Z'");
const ctx = (userId = "owner", spaces: string[] | null = null, writable?: string[]): ToolContext => ({ app, runId: null, spaceId: "personal", spaces, writable, tools: null, actor: "agent", userId });

beforeEach(async () => {
  app = testApp();
  undoProvider = registerLoginProvider({ id: "objectprobe-api", label: "示例平台", channel: "objectprobe", apiBase: "https://api.example.test", unavailable: () => null });
  const dir = join(app.home, "plugins", "objectprobe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: objectprobe\nname: 示例对象\n");
  writeFileSync(join(dir, "server.mjs"), `export default function register(api) {
    api.object({ kind: "change", label: "合并请求", statuses: { open: "进行中", merged: "已合并", closed: "已关闭" }, final: ["merged", "closed"],
      match: (url) => url.startsWith("https://example.test/changes/") ? url.slice("https://example.test/changes/".length) : null,
      async read(ctx, key) {
        const prev = await ctx.store.get("reads", key);
        await ctx.store.put("reads", key, { n: (prev?.n ?? 0) + 1, user: ctx.userId });
        const c = await ctx.connection("objectprobe-api");
        const state = c ? await (await c.fetch("/changes/" + key)).json() : (await ctx.store.get("states", key)) ?? {};
        if (state.fail) throw new Error("平台暂不可读");
        if (state.hang) return new Promise(() => {});
        if (state.emit) await ctx.emit({ kind: "observed", keys: { key }, payload: { title: "示例" } });
        return { title: state.title ?? "示例合并请求", status: state.status ?? "open", link: "https://example.test/changes/" + key, fields: [{ label: "目标分支", value: "main" }], revision: state.revision, note: state.note };
      }
    });
  }`);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, "objectprobe", "inprocess");
});
afterEach(async () => {
  vi.useRealTimers();
  for (const s of servers.splice(0)) await s.close();
  forgetPlugin("objectprobe");
  undoProvider();
  setAuthFetchForTests(null);
  await new Promise((resolve) => setImmediate(resolve));
  app.db.close();
  closeVault(app.home);
  rmSync(app.home, { recursive: true, force: true });
});

describe("插件对象注册与挂接", () => {
  it("校验 kind、statuses、final、间隔与重复注册，SDK 类型可以声明宿主对象", () => {
    const def: PluginObject = { kind: "demo", label: "示例", match: () => null, read: async () => ({ title: "示例", status: "open", link: url() }), statuses: { open: "进行中" }, final: [] };
    const sdk: SdkObject = def;
    expect(sdk.label).toBe("示例");
    for (const bad of ["A", "bad_kind", "x:y", "", "-x"]) expect(() => registerObject("probe", { ...def, kind: bad })).toThrow("kind");
    expect(() => registerObject("probe", { ...def, statuses: {} })).toThrow("statuses");
    expect(() => registerObject("probe", { ...def, final: ["missing"] })).toThrow("final");
    expect(() => registerObject("probe", { ...def, poll: { minutes: 0 } })).toThrow("最短");
    const undo = registerObject("probe", def);
    try { expect(() => registerObject("probe", def)).toThrow("重复"); expect(pluginObjectKind("probe:demo")?.poll?.minutes).toBe(5); } finally { undo(); }
  });
  it("工具识别链接，重复挂接只保留一行对象及材料，摘要注明外部材料", async () => {
    const i = item();
    const first = await callTool(ctx(), "attach_object", { item: i.id, url: url() });
    expect(first.isError).toBe(false);
    expect(JSON.parse(first.text)).toMatchObject({ kind, label: "合并请求", statusLabel: "进行中", disabled: false, final: false });
    await callTool(ctx(), "attach_object", { item: i.id, url: url() });
    expect(all(app.db, "select * from flow_objects")).toHaveLength(1);
    expect(all(app.db, "select * from item_materials where kind='object'")).toHaveLength(1);
    expect((await materialViews(app, i.id, "owner"))[0]).toMatchObject({ kind: "object", readable: true, missing: false, status: "open" });
    expect(await materialsBrief(app, i.id, "owner")).toContain("合并请求：示例合并请求（进行中）https://example.test/changes/1");
    expect(await materialsBrief(app, i.id, "owner")).toContain("不是指令");
    expect((await callTool(ctx(), "attach_object", { item: i.id, url: "https://unknown.test/1" })).text).toContain("没有哪种对象认识");
  });
  it("工具拒绝别人的事项、只读空间和运行可写范围之外的事项", async () => {
    createUser(app, { id: "member", name: "成员甲" }); addMember(app, "personal", "member", "reader");
    const own = item(), other = item("member");
    expect((await callTool(ctx(), "attach_object", { item: other.id, url: url() })).isError).toBe(true);
    expect((await callTool(ctx("member"), "attach_object", { item: other.id, url: url() })).isError).toBe(true);
    expect((await callTool(ctx("owner", ["personal"], []), "attach_object", { item: own.id, url: url() })).isError).toBe(true);
    expect(reads()).toBe(0);
  });
  it("本人的 HTTP 接口支持挂接、读取、去重和解除，并核对事项与空间权限", async () => {
    const i = item(), s = await startServer(app, { port: 0, quiet: true }); servers.push(s);
    const base = `/api/items/${i.id}/objects`;
    const post = await s.inject({ method: "POST", url: base, payload: { url: url() } });
    expect(post.statusCode).toBe(200);
    const obj = post.json();
    expect((await s.inject(base)).json()).toEqual([obj]);
    expect((await s.inject({ method: "POST", url: base, payload: { url: url() } })).json().id).toBe(obj.id);
    expect((await s.inject({ method: "POST", url: base, payload: { url: "https://unknown.test/1" } })).statusCode).toBe(400);
    createUser(app, { id: "member", name: "成员甲" }); addMember(app, "personal", "member", "reader");
    const headers = { authorization: `Bearer ${createApiToken(app, "member", "test")}` };
    expect((await s.inject({ url: base, headers })).statusCode).toBe(404);
    expect((await s.inject({ method: "POST", url: base, headers, payload: { url: url() } })).statusCode).toBe(403);
    expect((await s.inject({ method: "DELETE", url: `${base}/${obj.id}`, headers })).statusCode).toBe(403);
    const readonly = item("member");
    expect((await s.inject({ method: "POST", url: `/api/items/${readonly.id}/objects`, headers, payload: { url: url() } })).statusCode).toBe(403);
    const privateItem = item("owner", "personal-member");
    const reader = createUser(app, { id: "outsider", name: "成员乙" });
    const hidden = { authorization: `Bearer ${createApiToken(app, reader.id, "test")}` };
    expect((await s.inject({ url: `/api/items/${privateItem.id}/objects`, headers: hidden })).statusCode).toBe(404);
    expect((await s.inject({ method: "DELETE", url: `${base}/${obj.id}` })).json()).toEqual({ removed: true });
    expect((await s.inject(base)).json()).toEqual([]);
    expect(all(app.db, "select * from flow_objects")).toHaveLength(1);
  });
  it("读不认识的状态算失败，保留原状态及 changedAt，并记错误", async () => {
    const i = item(), obj = await attachObject(app, i.id, url(), "owner");
    set("1", { status: "unknown" }); oldChecks();
    await pollObjects(app);
    expect(itemObjects(app, i.id, "owner")[0]).toMatchObject({ status: "open", changedAt: obj.changedAt, error: expect.stringContaining("不认识的状态") });
    expect(all(app.db, "select * from flow_signals")).toHaveLength(0);
  });
  it("插件可声明 deleted 状态而不被当作材料丢失，状态标识必须是字符串", async () => {
    const def = pluginObjectKind(kind)!;
    def.statuses = { ...def.statuses, deleted: "已删除", "7": "状态七" };
    const i = item(); await attachObject(app, i.id, url(), "owner");
    set("1", { status: "deleted" }); oldChecks(); await pollObjects(app);
    expect((await materialViews(app, i.id, "owner"))[0]).toMatchObject({ status: "deleted", readable: true, missing: false });
    expect(await materialsBrief(app, i.id, "owner")).toContain("已删除");
    set("1", { status: 7 }); oldChecks(); await pollObjects(app);
    expect(itemObjects(app, i.id, "owner")[0]).toMatchObject({ status: "deleted", error: expect.stringContaining("不认识的状态") });
  });
  it("使用事项主人的连接读取，宿主账号的令牌不会用于成员的对象", async () => {
    createUser(app, { id: "member", name: "成员甲" });
    const seen: string[] = [];
    setAuthFetchForTests((async (_url, init) => { seen.push(new Headers(init?.headers).get("authorization")!); return new Response(JSON.stringify({ title: "成员的数据", status: "open" })); }) as typeof fetch);
    for (const userId of ["owner", "member"]) storeConnection(app, { userId, provider: "objectprobe-api", accountId: userId, accountName: "示例账号", scopes: [], accessToken: `token-${userId}`, expiresIn: 3600 });
    const i = item("member", "personal-member");
    await attachObject(app, i.id, url(), "member"); oldChecks(); await pollObjects(app);
    expect(seen).toEqual(["Bearer token-member", "Bearer token-member"]);
    expect(reads("1", "member", "personal-member")).toBe(2);
  });
});

describe("对象巡检与信号", () => {
  it("无关联、关联事项已结束、终态和未到间隔均不读", async () => {
    const a = item(), b = item(), c = item(), d = item();
    const o = await attachObject(app, a.id, url("a"), "owner"); detachObject(app, a.id, o.id, "owner");
    await attachObject(app, b.id, url("b"), "owner"); run(app.db, "update items set status='done' where id=?", b.id);
    set("c", { status: "merged" }); await attachObject(app, c.id, url("c"), "owner"); oldChecks();
    await attachObject(app, d.id, url("d"), "owner");
    await pollObjects(app);
    for (const key of ["a", "b", "c", "d"]) expect(reads(key)).toBe(1);
    oldChecks(); await pollObjects(app); expect(reads("d")).toBe(2);
  });
  it("一次最多 20 个、串行读取，重入共用一轮", async () => {
    const i = item();
    for (let n = 0; n < 23; n++) await attachObject(app, i.id, url(String(n)), "owner");
    oldChecks();
    const def = pluginObjectKind(kind)!, original = def.read;
    let active = 0, max = 0, calls = 0;
    def.read = async (...args) => { active++; max = Math.max(active, max); calls++; try { await Promise.resolve(); return await original(...args); } finally { active--; } };
    const a = pollObjects(app), b = pollObjects(app); expect(a).toBe(b); await a;
    expect(calls).toBe(20); expect(max).toBe(1);
    await pollObjects(app); expect(calls).toBe(23);
  });
  it("失败按 5、15、60 分钟退避，另一对象照常读，成功清除错误", async () => {
    const i = item(); await attachObject(app, i.id, url("bad"), "owner"); await attachObject(app, i.id, url("good"), "owner");
    set("bad", { fail: true }); oldChecks();
    const start = new Date(); await pollObjects(app, start);
    expect(reads("bad")).toBe(2); expect(reads("good")).toBe(2);
    await pollObjects(app, new Date(+start + 4 * 60000)); expect(reads("bad")).toBe(2);
    await pollObjects(app, new Date(+start + 5 * 60000)); expect(reads("bad")).toBe(3);
    await pollObjects(app, new Date(+start + 19 * 60000)); expect(reads("bad")).toBe(3);
    await pollObjects(app, new Date(+start + 20 * 60000)); expect(reads("bad")).toBe(4);
    await pollObjects(app, new Date(+start + 79 * 60000)); expect(reads("bad")).toBe(4);
    set("bad", { status: "open" }); await pollObjects(app, new Date(+start + 80 * 60000)); expect(reads("bad")).toBe(5);
    expect(itemObjects(app, i.id, "owner").find((o) => o.link === url("bad"))?.error).toBeNull();
  });
  it("单次读取 15 秒超时，后续对象仍能完成巡检", async () => {
    const i = item(); await attachObject(app, i.id, url("hang"), "owner"); await attachObject(app, i.id, url("good"), "owner"); oldChecks(); set("hang", { hang: true });
    vi.useFakeTimers();
    const p = pollObjects(app);
    for (let n = 0; n < 30; n++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15001); await p;
    expect(itemObjects(app, i.id, "owner").find((o) => o.link === url("hang"))?.error).toContain("15 秒");
    expect(reads("good")).toBe(2);
  });
  it("停用与卸载注销类型，保留状态、停止轮询并在视图标记", async () => {
    const i = item(); await attachObject(app, i.id, url(), "owner"); oldChecks();
    await setPluginEnabled(app, "objectprobe", false); await pollObjects(app);
    expect(reads()).toBe(1); expect(itemObjects(app, i.id, "owner")[0]).toMatchObject({ status: "open", disabled: true });
    await setPluginEnabled(app, "objectprobe", true); await pollObjects(app); expect(reads()).toBe(2);
    forgetPlugin("objectprobe"); oldChecks(); await pollObjects(app);
    expect(itemObjects(app, i.id, "owner")[0].disabled).toBe(true); expect(reads()).toBe(2);
  });
  it("同一状态不重复发信号；状态变化记一行信号、每件事一笔时间线并推进一次", async () => {
    const a = item(), b = item(); saveFlow(app, raw(), "user"); await startFlow(app, a.id, "objects", owner); await startFlow(app, b.id, "objects", owner);
    const obj = await attachObject(app, a.id, url(), "owner"); await attachObject(app, b.id, url(), "owner");
    oldChecks(); await pollObjects(app); expect(all(app.db, "select * from flow_signals")).toHaveLength(0);
    set("1", { status: "merged" }); oldChecks(); await flowReminders(app);
    const signals = all<{ type: string; keys: string }>(app.db, "select * from flow_signals");
    expect(signals).toHaveLength(1); expect(signals[0].type).toBe(`object.${kind}.merged`); expect(JSON.parse(signals[0].keys)).toEqual({ object: obj.id, items: [a.id, b.id] });
    for (const i of [a, b]) {
      expect(getStage(app, i.id, "merge")).toMatchObject({ state: "done", evidence: [`object:${obj.id}`] });
      expect(itemEvents(app, i.id).filter((e) => e.text.includes("进行中 → 已合并"))).toHaveLength(1);
      expect(stageLog(app, i.id).filter((s) => s.stageId === "merge" && s.toState === "done")).toHaveLength(1);
    }
    await flowReminders(app); expect(all(app.db, "select * from flow_signals")).toHaveLength(1);
  });
  it("ctx.emit 只记 plugin 前缀信号；keys 与 payload 分别限制 4000 字符", async () => {
    const context = pluginContext(app, getPlugin("objectprobe").env, { userId: "owner", spaceId: "personal", runId: null, actor: "user" });
    await context.emit({ kind: "received", keys: { object: "x" }, payload: { value: "示例" } });
    expect(one(app.db, "select type,keys,outcome from flow_signals")).toEqual({ type: "plugin.objectprobe.received", keys: '{"object":"x"}', outcome: '{"value":"示例"}' });
    await expect(context.emit({ kind: "large", keys: { value: "x".repeat(4000) } })).rejects.toThrow("4000");
    await expect(context.emit({ kind: "large", keys: {}, payload: "x".repeat(4000) })).rejects.toThrow("4000");
    expect(all(app.db, "select * from flow_signals")).toHaveLength(1);
  });
  it("隔离插件的 match/read/emit 通过子进程代理，撤销信任后停止", async () => {
    untrustPlugin(app, "objectprobe"); await trustPlugin(app, "objectprobe", "isolated");
    const i = item(); set("1", { status: "open", emit: true });
    const o = await attachObject(app, i.id, url(), "owner");
    expect(o).toMatchObject({ kind, title: "示例合并请求", status: "open" }); expect(reads()).toBe(1);
    expect(one<{ type: string }>(app.db, "select type from flow_signals")?.type).toBe("plugin.objectprobe.observed");
    untrustPlugin(app, "objectprobe"); oldChecks(); await pollObjects(app); expect(reads()).toBe(1);
    expect(itemObjects(app, i.id, "owner")[0].disabled).toBe(true);
  });
});

describe("对象的修订（有更新）", () => {
  it("状态不变而修订变了记 updated 信号和时间线；第一次读和没有修订都不算", async () => {
    const i = item(); set("1", { status: "open" });
    const o = await attachObject(app, i.id, url(), "owner");
    set("1", { status: "open", revision: "c1" }); oldChecks(); await pollObjects(app);
    expect(all(app.db, "select * from flow_signals")).toHaveLength(0);
    expect(one<{ revision: string }>(app.db, "select revision from flow_objects")?.revision).toBe("c1");
    set("1", { status: "open", revision: "c2", note: "新提交 2 个" }); oldChecks(); await pollObjects(app);
    const signals = all<{ type: string; keys: string; outcome: string }>(app.db, "select * from flow_signals");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ type: `object.${kind}.updated`, outcome: "新提交 2 个" });
    expect(JSON.parse(signals[0].keys)).toEqual({ object: o.id, items: [i.id], revision: "c2" });
    expect(itemEvents(app, i.id).filter((e) => e.text.includes("有更新：新提交 2 个"))).toHaveLength(1);
    // Same revision again: nothing; a status change with a new revision is a status change only.
    oldChecks(); await pollObjects(app); expect(all(app.db, "select * from flow_signals")).toHaveLength(1);
    set("1", { status: "merged", revision: "c3" }); oldChecks(); await pollObjects(app);
    expect(all<{ type: string }>(app.db, "select type from flow_signals order by id").map((s) => s.type)).toEqual([`object.${kind}.updated`, `object.${kind}.merged`]);
  });
  it("updated 是保留的状态：插件不能用它，流程的 done 可以写它，人话是“有更新”", () => {
    const def: PluginObject = { kind: "reserved", label: "示例", match: () => null, read: async () => ({ title: "示例", status: "open", link: url() }), statuses: { open: "进行中", updated: "已更新" }, final: [] };
    expect(() => registerObject("objectprobe", def)).toThrow("updated");
    const f = parseFlow(raw("owner", { object: kind, status: "updated" }));
    expect(describeStage(f.stages[0]).done).toContain("合并请求到了 有更新");
  });
  it("done 写 updated 的阶段：进来之后修订变了才算做完，之前的变化不算", async () => {
    const i = item(); saveFlow(app, JSON.stringify({ id: "wait-update", name: "等更新", stages: [{ id: "wait", name: "等更新", by: "owner", done: { object: kind, status: "updated" } }, { id: "next", name: "后续", by: "wait" }] }), "user");
    set("1", { status: "open", revision: "c1" }); await attachObject(app, i.id, url(), "owner");
    set("1", { status: "open", revision: "c2" }); oldChecks(); await pollObjects(app);
    await startFlow(app, i.id, "wait-update", owner);
    expect(getStage(app, i.id, "wait").state).toBe("doing");
    oldChecks(); await pollObjects(app);
    expect(getStage(app, i.id, "wait").state).toBe("doing");
    await new Promise((r) => setTimeout(r, 5));
    set("1", { status: "open", revision: "c3", note: "有新评论" }); oldChecks(); await pollObjects(app);
    expect(getStage(app, i.id, "wait")).toMatchObject({ state: "done", note: "合并请求有更新" });
    expect(getStage(app, i.id, "next").state).toBe("doing");
  });
});

describe("流程中的插件对象", () => {
  it("定义校验对象与状态，人话使用类型名与状态词", () => {
    expect(() => parseFlow(raw({ object: "missing:change" }))).toThrow("没有这种对象：missing:change；装了对应的插件才有");
    expect(() => parseFlow(raw("owner", { object: kind, status: "unknown" }))).toThrow("没有这种状态");
    const f = parseFlow(raw("owner", { object: kind, status: ["merged", "closed"] }));
    expect(describeStage(f.stages[0]).done).toContain("合并请求到了 已合并 / 已关闭");
  });
  it("对象承担阶段先等待，挂上后自动接上，到 final 完成，视图提供状态词和字段", async () => {
    const i = item(); saveFlow(app, raw(), "user"); await startFlow(app, i.id, "objects", owner);
    expect(getStage(app, i.id, "merge")).toMatchObject({ state: "doing", by: null, note: "还没有关联合并请求：把链接发给助手，或在事项页挂上" });
    expect(all(app.db, "select * from runs where kind='flow-stage'")).toHaveLength(0);
    const o = await attachObject(app, i.id, url(), "owner");
    expect(getStage(app, i.id, "merge").by).toBe(`object:${o.id}`);
    expect(flowView(app, i.id).stages[0].object).toMatchObject({ title: "示例合并请求", status: "open", statusLabel: "进行中", fields: [{ label: "目标分支", value: "main" }] });
    set("1", { status: "closed" }); oldChecks(); await pollObjects(app);
    expect(getStage(app, i.id, "merge").state).toBe("done"); expect(getStage(app, i.id, "next").state).toBe("doing");
  });
  it("默认跟最近挂上的对象，显式 done 按写的状态完成", async () => {
    const i = item(); saveFlow(app, raw({ object: kind }, { object: kind, status: "merged" }), "user");
    await startFlow(app, i.id, "objects", owner); await attachObject(app, i.id, url("older"), "owner");
    set("newer", { status: "closed" }); const latest = await attachObject(app, i.id, url("newer"), "owner");
    set("older", { status: "merged" }); oldChecks(); await pollObjects(app);
    expect(getStage(app, i.id, "merge")).toMatchObject({ state: "doing", by: `object:${latest.id}` });
  });
  it("owner + done 能由任一关联对象完成；重开后旧状态不能再次完成", async () => {
    const i = item(); saveFlow(app, raw("owner", { object: kind, status: "merged" }), "user"); await startFlow(app, i.id, "objects", owner);
    set("older", { status: "merged" }); await attachObject(app, i.id, url("older"), "owner"); await attachObject(app, i.id, url("newer"), "owner");
    expect(getStage(app, i.id, "merge").state).toBe("done");
    await ownerAction(app, i.id, "merge", "reopen", "需要重新确认"); await advance(app, i.id);
    expect(getStage(app, i.id, "merge").state).toBe("doing");
    set("newer", { status: "merged" }); oldChecks(); await pollObjects(app);
    expect(getStage(app, i.id, "merge").state).toBe("done");
  });
  it("对象承担的阶段重开后，不沿用先前终态", async () => {
    const i = item(); saveFlow(app, raw(), "user"); await startFlow(app, i.id, "objects", owner);
    set("1", { status: "merged" }); await attachObject(app, i.id, url(), "owner");
    await ownerAction(app, i.id, "merge", "reopen", "再次核验"); await advance(app, i.id);
    expect(getStage(app, i.id, "merge").state).toBe("doing");
    expect(stageLog(app, i.id).filter((s) => s.stageId === "merge" && s.toState === "done")).toHaveLength(1);
  });
});

describe("GitHub 合并请求例子", () => {
  it("只匹配公开 GitHub 的 HTTPS PR 链接，后续路径、查询和片段都可带", () => {
    for (const suffix of ["", "/files", "/commits", "?tab=files", "#discussion"]) expect(pullRequestMatch(`https://github.com/example/shop/pull/7${suffix}`)).toBe("example/shop#7");
    for (const link of ["http://github.com/example/shop/pull/7", "https://github.com/example/shop/issues/7", "https://evil.test/github.com/example/shop/pull/7", "https://github.com/example/shop/pull/7bad"]) expect(pullRequestMatch(link)).toBeNull();
  });
  it.each([[null, "open", "open"], ["2026-11-01", "closed", "merged"], [null, "closed", "closed"]])("状态映射 %s / %s → %s，检查可选且评审有状态", async (mergedAt, state, expected) => {
    let def!: PluginObject;
    github({ object: (d: PluginObject) => { def = d; }, platform: () => {}, tool: () => {}, z } as unknown as PluginApi);
    let checksReadable = true;
    const c = { account: "示例", scopes: [], base: "https://api.github.com", fetch: async (path: string) => {
      if (path.endsWith("/pulls/7")) return new Response(JSON.stringify({ title: "退款改造", state, merged_at: mergedAt, html_url: "https://github.com/example/shop/pull/7", base: { ref: "main" }, head: { sha: "abc" } }));
      if (path.includes("/reviews")) return new Response(JSON.stringify([{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED" }, { user: { login: "reviewer" }, state: "APPROVED" }]));
      if (!checksReadable) return new Response("forbidden", { status: 403 });
      if (path.endsWith("/status")) return new Response(JSON.stringify({ state: "success", total_count: 1 }));
      return new Response(JSON.stringify({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] }));
    } };
    const context = { ...pluginContext(app, getPlugin("objectprobe").env, { userId: "owner", spaceId: "personal", runId: null, actor: "user" }), connection: async () => c };
    const obj = await def.read(context, "example/shop#7");
    expect(obj.status).toBe(expected); expect(obj.fields).toEqual([{ label: "目标分支", value: "main" }, { label: "检查", value: "通过" }, { label: "评审状态", value: "已批准" }]);
    checksReadable = false; expect((await def.read(context, "example/shop#7")).fields?.some((f) => f.label === "检查")).toBe(false);
  });
});
