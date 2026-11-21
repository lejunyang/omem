import { createSpace } from "../src/core/spaces.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { App } from "../src/core/app.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { closeVault } from "../src/auth/vault.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { startFlow } from "../src/flows/engine.ts";
import { attachObject } from "../src/flows/plugin-objects.ts";
import { describePlugin, forgetPlugin, getPlugin, loadPlugins, setPluginEnabled, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { checkSlot, loadSlot, slotsAt } from "../src/plugins/slots.ts";
import { registerObject } from "../src/plugins/objects.ts";
import { pluginStore } from "../src/plugins/store.ts";
import type { PluginBlock, PluginSlot, PluginSlotContext } from "../src/plugins/types.ts";
import type { PluginSlot as SdkSlot, PluginSlotContext as SdkSlotContext } from "../packages/plugin-sdk/slots.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/**
 * Slots (docs/v2/flows.md §8, “界面插槽”): a fake plugin puts display blocks on the item panel, under a
 * flow stage and on the today page; what each shows is read as the person looking, in the item's space.
 */
let app: App;
const servers: FastifyInstance[] = [];
const owner = { actor: "owner" as const, userId: "owner" };
const url = (key = "1") => `https://example.test/changes/${key}`;
const item = (userId = "owner", spaceId = "personal") => upsertItem(app, undefined, { title: "示例商城退款", spaceId, userId }, "user");
const flow = JSON.stringify({ id: "slots", name: "插槽流程", stages: [{ id: "merge", name: "等合并", by: { object: "slotprobe:change" } }, { id: "next", name: "后续", by: "wait" }] });

const SERVER = `export default function register(api) {
  const z = api.z;
  api.object({ kind: "change", label: "合并请求", statuses: { open: "进行中", merged: "已合并" }, final: ["merged"],
    match: (url) => url.startsWith("https://example.test/changes/") ? url.slice("https://example.test/changes/".length) : null,
    read: async (ctx, key) => ({ title: "示例合并请求 " + key, status: "open", link: "https://example.test/changes/" + key }) });
  const seen = async (ctx, slot) => {
    const prev = (await ctx.store.get("seen", "all")) ?? { list: [] };
    await ctx.store.put("seen", "all", { list: [...prev.list, { user: ctx.userId, space: ctx.spaceId, slot }] });
  };
  api.block({ kind: "checks", description: "合并请求的检查结果", display: true, schema: z.object({ passed: z.number(), failed: z.number(), key: z.string() }),
    load: async (ctx, slot) => { await seen(ctx, slot); return { passed: 7, failed: 1, key: slot.object ? slot.object.key : "" }; },
    view: (d) => ({ title: "检查 " + d.key, components: [{ type: "metric", items: [{ label: "通过", value: d.passed }, { label: "失败", value: d.failed, good: "down" }] }] }) });
  api.block({ kind: "stagenote", description: "这一段的说明", display: true, schema: z.object({ text: z.string() }),
    load: async (ctx, slot) => { await seen(ctx, slot); return { text: "阶段 " + slot.stage + (slot.object ? "，跟着 " + slot.object.title : "，还没有关联") }; },
    view: (d) => ({ components: [{ type: "markdown", text: d.text }] }) });
  api.block({ kind: "today", description: "今天的构建", display: true, schema: z.object({ n: z.number() }),
    load: async (ctx, slot) => { await seen(ctx, slot); return { n: 3 }; },
    view: (d) => ({ title: "今天", components: [{ type: "callout", tone: "info", text: "今天跑了 " + d.n + " 次构建" }] }) });
  api.block({ kind: "broken", description: "读不到", display: true, schema: z.object({}), load: async () => { throw new Error("平台暂不可读"); }, view: () => ({ components: [] }) });
  api.block({ kind: "wrong", description: "不合 schema", display: true, schema: z.object({ n: z.number() }), load: async () => ({ n: "三" }), view: () => ({ components: [] }) });
  api.block({ kind: "badview", description: "画错", display: true, schema: z.object({}), load: async () => ({}), view: () => ({ components: [{ type: "chart", title: "图", kind: "bar", labels: ["一"], series: [{ name: "数", values: [1, 2] }] }] }) });
  api.block({ kind: "elsewhere", description: "只在别的空间", display: true, schema: z.object({}), load: async () => ({}), view: () => ({ components: [{ type: "markdown", text: "别处" }] }) });
  api.slot("item.panel", { block: "checks", when: { object: "change" } });
  api.slot("item.panel", { block: "broken" });
  api.slot("item.panel", { block: "wrong" });
  api.slot("item.panel", { block: "badview" });
  api.slot("item.panel", { block: "elsewhere", when: { space: "shop" } });
  api.slot("flow.stage", { block: "stagenote", when: { stage: "merge", object: "change" } });
  api.slot("today", { block: "today" });
}`;

beforeEach(async () => {
  app = testApp();
  const dir = join(app.home, "plugins", "slotprobe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: slotprobe\nname: 示例插槽\n");
  writeFileSync(join(dir, "server.mjs"), SERVER);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, "slotprobe", "inprocess");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  forgetPlugin("slotprobe");
  await new Promise((resolve) => setImmediate(resolve));
  app.db.close();
  closeVault(app.home);
  rmSync(app.home, { recursive: true, force: true });
});

const seen = (userId = "owner", spaceId = "personal") => pluginStore(app, "slotprobe", userId, spaceId).get<{ list: { user: string; space: string; slot: Record<string, unknown> }[] }>("seen", "all")?.list ?? [];

describe("界面插槽的声明", () => {
  const block = (over: Partial<PluginBlock> = {}): PluginBlock => ({ kind: "card", description: "卡片", schema: z.object({}), display: true, load: async () => ({}), view: () => ({ components: [] }), ...over });
  const blocks = new Map([["card", block()], ["plain", block({ kind: "plain", load: undefined })], ["form", block({ kind: "form", display: false })]]);
  it("SDK 的插槽类型和宿主一致", () => {
    const at: PluginSlotContext = { at: "flow.stage", item: "it_1", stage: "merge", object: null };
    const sdkAt: SdkSlotContext = at;
    const slot: SdkSlot = { block: "card", when: { object: "change", stage: ["merge"] } };
    const host: PluginSlot = slot;
    expect([sdkAt.at, host.block]).toEqual(["flow.stage", "card"]);
  });
  it("拒绝未知位置、未知或不能放的块、和位置不配的条件、别人的对象类型与重复", () => {
    expect(() => checkSlot("demo", blocks, [], "sidebar", { block: "card" })).toThrow(/位置不认识/);
    expect(() => checkSlot("demo", blocks, [], "item.panel", { block: "nope" })).toThrow(/没有声明的内容块/);
    expect(() => checkSlot("demo", blocks, [], "item.panel", { block: "plain" })).toThrow(/load 和 view/);
    expect(() => checkSlot("demo", blocks, [], "item.panel", { block: "form" })).toThrow(/display/);
    expect(() => checkSlot("demo", blocks, [], "item.panel", { block: "card", when: { stage: "merge" } })).toThrow(/flow\.stage/);
    expect(() => checkSlot("demo", blocks, [], "today", { block: "card", when: { space: "personal" } })).toThrow(/今日页/);
    expect(() => checkSlot("demo", blocks, [], "item.panel", { block: "card", when: { object: "change" } })).toThrow(/对象类型/);
    expect(() => checkSlot("demo", blocks, [], "item.panel", { block: "card", when: { space: [] } })).toThrow(/when\.space/);
    expect(() => checkSlot("demo", blocks, [], "item.panel", { block: "card", when: { owner: "me" } as never })).toThrow(/不认识/);
    const undo = registerObject("demo", { kind: "change", label: "变更", statuses: { open: "开" }, final: [], match: () => null, read: async () => ({ title: "", status: "open", link: "" }) });
    try {
      // Another plugin's kind is not this one's.
      expect(() => checkSlot("other", blocks, [], "item.panel", { block: "card", when: { object: "change" } })).toThrow(/对象类型/);
      const ok = checkSlot("demo", blocks, [], "flow.stage", { block: "card", when: { object: "change", stage: "merge", flow: ["a", "b"] } });
      expect(ok).toEqual({ at: "flow.stage", block: "card", when: { object: "change", stage: ["merge"], flow: ["a", "b"] } });
      expect(() => checkSlot("demo", blocks, [ok], "flow.stage", { block: "card" })).toThrow(/已经放过/);
    } finally {
      undo();
    }
  });
  it("插件代码里声明错的插槽让信任失败，块和工具一起卸下", async () => {
    const dir = join(app.home, "plugins", "slotbad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), "id: slotbad\nname: 声明错的\n");
    writeFileSync(join(dir, "server.mjs"), `export default function register(api) {
      api.block({ kind: "card", description: "卡片", display: true, schema: api.z.object({}), load: async () => ({}), view: () => ({ components: [] }) });
      api.slot("sidebar", { block: "card" });
    }`);
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    try {
      await expect(trustPlugin(app, "slotbad", "inprocess")).rejects.toThrow(/位置不认识/);
      expect(describePlugin(getPlugin("slotbad"))).toMatchObject({ trust: "required", slots: [] });
    } finally {
      forgetPlugin("slotbad");
    }
  });
});

describe("界面插槽的显示与取数", () => {
  it("事项页侧栏：按挂着的对象各显示一块，取数带对象并按看的人和事项空间", async () => {
    const i = item();
    expect((await slotsAt(app, "owner", { at: "item.panel", item: i.id })).map((s) => s.block)).toEqual(["broken", "wrong", "badview"]);
    const a = await attachObject(app, i.id, url("1"), "owner"), b = await attachObject(app, i.id, url("2"), "owner");
    const list = await slotsAt(app, "owner", { at: "item.panel", item: i.id });
    expect(list.filter((s) => s.block === "checks").map((s) => s.object)).toEqual([{ id: b.id, title: "示例合并请求 2" }, { id: a.id, title: "示例合并请求 1" }]);
    expect(list[0]).toMatchObject({ plugin: "slotprobe", pluginName: "示例插槽", label: "合并请求的检查结果", at: "item.panel", item: i.id, stage: null });
    const shown = await loadSlot(app, "owner", { at: "item.panel", plugin: "slotprobe", block: "checks", item: i.id, object: a.id });
    expect(shown).toEqual({ title: "检查 1", components: [{ type: "metric", items: [{ label: "通过", value: 7 }, { label: "失败", value: 1, good: "down" }] }] });
    expect(seen().at(-1)).toEqual({ user: "owner", space: "personal", slot: { at: "item.panel", item: i.id, stage: null, object: { id: a.id, kind: "slotprobe:change", key: "1", title: "示例合并请求 1", status: "open", link: url("1") } } });
    // An object that is not linked to this item, or a slot without that condition asked with an object: not shown here.
    const other = item(), c = await attachObject(app, other.id, url("3"), "owner");
    await expect(loadSlot(app, "owner", { at: "item.panel", plugin: "slotprobe", block: "checks", item: i.id, object: c.id })).rejects.toMatchObject({ status: 404 });
    await expect(loadSlot(app, "owner", { at: "item.panel", plugin: "slotprobe", block: "checks", item: i.id })).rejects.toMatchObject({ status: 404 });
    await expect(loadSlot(app, "owner", { at: "flow.stage", plugin: "slotprobe", block: "checks", item: i.id, stage: "merge" })).rejects.toMatchObject({ status: 404 });
  });
  it("一个块读不到、交回的内容不对或画错，只是这一块报错", async () => {
    const i = item();
    const load = (block: string) => loadSlot(app, "owner", { at: "item.panel", plugin: "slotprobe", block, item: i.id });
    await expect(load("broken")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("平台暂不可读") });
    await expect(load("wrong")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("schema") });
    await expect(load("badview")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("横轴") });
  });
  it("按空间限定：事项不在那个空间就不显示", async () => {
    const shop = item("owner", "shop");
    expect((await slotsAt(app, "owner", { at: "item.panel", item: shop.id })).map((s) => s.block)).toContain("elsewhere");
    expect((await slotsAt(app, "owner", { at: "item.panel", item: item().id })).map((s) => s.block)).not.toContain("elsewhere");
    expect(await loadSlot(app, "owner", { at: "item.panel", plugin: "slotprobe", block: "elsewhere", item: shop.id })).toEqual({ title: null, components: [{ type: "markdown", text: "别处" }] });
    expect(seen("owner", "shop")).toEqual([]);
  });
  it("流程阶段下面：按阶段 id 和阶段跟着的对象类型，没有流程或别的阶段不显示", async () => {
    const i = item();
    expect(await slotsAt(app, "owner", { at: "flow.stage", item: i.id, stage: "merge" })).toEqual([]);
    saveFlow(app, flow, "user");
    await startFlow(app, i.id, "slots", owner);
    const list = await slotsAt(app, "owner", { at: "flow.stage", item: i.id, stage: "merge" });
    expect(list).toEqual([expect.objectContaining({ block: "stagenote", stage: "merge", object: null })]);
    expect(await slotsAt(app, "owner", { at: "flow.stage", item: i.id, stage: "next" })).toEqual([]);
    expect(await slotsAt(app, "owner", { at: "flow.stage", item: i.id, stage: "nope" })).toEqual([]);
    expect((await loadSlot(app, "owner", { at: "flow.stage", plugin: "slotprobe", block: "stagenote", item: i.id, stage: "merge" })).components).toEqual([{ type: "markdown", text: "阶段 merge，还没有关联" }]);
    const a = await attachObject(app, i.id, url("9"), "owner");
    expect((await slotsAt(app, "owner", { at: "flow.stage", item: i.id, stage: "merge" }))[0].object).toEqual({ id: a.id, title: "示例合并请求 9" });
    expect((await loadSlot(app, "owner", { at: "flow.stage", plugin: "slotprobe", block: "stagenote", item: i.id, stage: "merge", object: a.id })).components).toEqual([{ type: "markdown", text: "阶段 merge，跟着 示例合并请求 9" }]);
  });
  it("今日页：没有事项，用插件自己的空间", async () => {
    expect((await slotsAt(app, "owner", { at: "today" })).map((s) => s.block)).toEqual(["today"]);
    expect(await loadSlot(app, "owner", { at: "today", plugin: "slotprobe", block: "today" })).toEqual({ title: "今天", components: [{ type: "callout", tone: "info", text: "今天跑了 3 次构建" }] });
    expect(seen().at(-1)).toEqual({ user: "owner", space: "personal", slot: { at: "today", item: null, stage: null, object: null } });
    await expect(slotsAt(app, "owner", { at: "sidebar" })).rejects.toMatchObject({ status: 400 });
    await expect(slotsAt(app, "owner", { at: "item.panel" })).rejects.toMatchObject({ status: 400 });
  });
  it("插件停用、撤销信任时插槽消失，重新启用并信任后回来", async () => {
    const i = item();
    await setPluginEnabled(app, "slotprobe", false);
    expect(await slotsAt(app, "owner", { at: "item.panel", item: i.id })).toEqual([]);
    expect(await slotsAt(app, "owner", { at: "today" })).toEqual([]);
    await expect(loadSlot(app, "owner", { at: "today", plugin: "slotprobe", block: "today" })).rejects.toMatchObject({ status: 404 });
    await setPluginEnabled(app, "slotprobe", true);
    expect((await slotsAt(app, "owner", { at: "today" })).length).toBe(1);
    untrustPlugin(app, "slotprobe");
    expect(await slotsAt(app, "owner", { at: "today" })).toEqual([]);
    expect(describePlugin(getPlugin("slotprobe")).slots).toEqual([]);
    await trustPlugin(app, "slotprobe", "inprocess");
    expect(describePlugin(getPlugin("slotprobe")).slots).toContainEqual({ at: "today", block: "today" });
  });
  it("HTTP：看得到事项的人能列出并取数，看不到的 404，用的是看的人自己", async () => {
    const s = await startServer(app, { port: 0, quiet: true });
    servers.push(s);
    createSpace(app, { id: "project", name: "项目 A" });
    const i = item("owner", "project"), a = await attachObject(app, i.id, url("1"), "owner");
    const list = await s.inject(`/api/slots?at=item.panel&item=${i.id}`);
    expect(list.statusCode).toBe(200);
    expect(list.json().map((x: { block: string }) => x.block)).toContain("checks");
    const one = await s.inject(`/api/slots/slotprobe/checks?at=item.panel&item=${i.id}&object=${a.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().title).toBe("检查 1");
    expect((await s.inject(`/api/slots/slotprobe/broken?at=item.panel&item=${i.id}`)).statusCode).toBe(502);
    expect((await s.inject(`/api/slots/slotprobe/nope?at=item.panel&item=${i.id}`)).statusCode).toBe(404);
    expect((await s.inject(`/api/slots?at=sidebar`)).statusCode).toBe(400);
    createUser(app, { id: "member", name: "成员甲" });
    addMember(app, "project", "member", "editor");
    const mine = item("member", "project"), linked = await attachObject(app, mine.id, url("2"), "member");
    addMember(app, "project", "member", "reader");
    const member = { authorization: `Bearer ${createApiToken(app, "member", "test")}` };
    expect((await s.inject({ url: `/api/slots?at=item.panel&item=${i.id}`, headers: member })).statusCode).toBe(404);
    expect((await s.inject({ url: `/api/slots/slotprobe/checks?at=item.panel&item=${i.id}&object=${a.id}`, headers: member })).statusCode).toBe(404);
    expect((await s.inject({ url: `/api/slots?at=item.panel&item=${mine.id}`, headers: member })).statusCode).toBe(200);
    expect((await s.inject({ url: `/api/slots/slotprobe/checks?at=item.panel&item=${mine.id}&object=${linked.id}`, headers: member })).statusCode).toBe(200);
    expect(seen("member", "project").at(-1)).toMatchObject({ user: "member", space: "project" });
    createUser(app, { id: "outsider", name: "成员乙" });
    const outsider = { authorization: `Bearer ${createApiToken(app, "outsider", "test")}` };
    expect((await s.inject({ url: `/api/slots?at=item.panel&item=${i.id}`, headers: outsider })).statusCode).toBe(404);
    expect((await s.inject({ url: `/api/slots/slotprobe/checks?at=item.panel&item=${i.id}&object=${a.id}`, headers: outsider })).statusCode).toBe(404);
    expect((await s.inject({ url: `/api/slots?at=today`, headers: outsider })).statusCode).toBe(200);
  });
});
