import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { storeConnection } from "../src/auth/vault.ts";
import { migrateItemProviders } from "../src/items/provider-schema.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { all } from "../src/core/db.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
import { configureTarget, decideProviderWrite, providerState, syncTarget } from "../src/items/providers.ts";
import { getItem, itemEvents, upsertItem } from "../src/items/store.ts";
import { writeParent } from "../src/items/tree.ts";
import { decideCandidate } from "../src/items/auto.ts";
import { manifestSchema } from "../src/plugins/registry.ts";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import { deliverPluginEvents } from "../src/plugins/event-delivery.ts";
import { replaceSubscriptions } from "../src/plugins/event-store.ts";
import type { ExternalItem, ItemProvider, PluginEventV1, Subscription } from "../src/plugins/types.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const ext = { key: "a", url: "https://example.org/items/a", title: "检查库存", status: "open", revision: "1", updatedAt: "2026-11-01T00:00:00Z" };
let app: ReturnType<typeof testApp>;
let items: ExternalItem[];
let undo: (() => void)[];
const pull = vi.fn<ItemProvider["pull"]>();
const setStatus = vi.fn<NonNullable<ItemProvider["setStatus"]>>();
beforeEach(() => {
  app = testApp();
  items = [{ ...ext }];
  undo = [];
  pull.mockReset().mockImplementation(async () => ({ items, cursor: "page1", done: true }));
  setStatus.mockReset().mockImplementation(async (_ctx, req) => ({ status: req.status, revision: "2" }));
  const api = registerProcessHooks(manifestSchema.parse({ id: "demo", name: "示例", connectors: [{ provider: "demo-account" }], permissions: { itemProvider: true, write: true } }), undo);
  api.itemProvider({ id: "issues", label: "示例条目", statuses: { open: "active", closed: "done" }, pull, setStatus });
});
afterEach(() => { for (const f of undo) f(); });
const config = { provider: "demo:issues", target: "repo", spaceId: "personal" };
const ids = () => all<{ id: string }>(app.db, "select id from items").map(i => i.id);

it("persists the page cursor with its items, deduplicates overlapping targets, and keeps local edits", async () => {
  const t = configureTarget(app, "owner", config);
  await syncTarget(app, "owner", t.id);
  const [id] = ids();
  expect(getItem(app, id).status).toBe("candidate");
  expect(itemEvents(app, id)).toContainEqual(expect.objectContaining({ kind: "created", text: expect.stringContaining("从「示例条目」导入") }));
  decideCandidate(app, id, true, "owner");
  upsertItem(app, id, { title: "本地标题" });
  items = [{ ...ext, revision: "2", title: "外部新标题", status: "closed" }];
  await syncTarget(app, "owner", t.id);
  expect(pull.mock.lastCall?.[1].cursor).toBe("page1");
  expect(getItem(app, id)).toMatchObject({ title: "本地标题", status: "done" });
  expect(itemEvents(app, id)).toContainEqual(expect.objectContaining({ kind: "updated", text: expect.stringContaining("「示例条目」更新：外部新标题（closed）") }));
  expect(providerState(app, "owner", id)?.write).toBeNull();
  const n = itemEvents(app, id).length;
  const other = configureTarget(app, "owner", { ...config, target: "org" });
  await syncTarget(app, "owner", other.id);
  expect(ids()).toEqual([id]);
  expect(itemEvents(app, id)).toHaveLength(n);
});

it("checks the subscriber, confirms precisely one revision, and retires the approval", async () => {
  const t = configureTarget(app, "owner", { ...config, importMode: "direct" });
  await syncTarget(app, "owner", t.id);
  const [id] = ids();
  upsertItem(app, id, { status: "done" });
  const write = providerState(app, "owner", id)!.write!;
  expect(getAsk(app, write.ask_id!).question).toContain("「示例条目」的 a");
  await expect(answerAsk(app, write.ask_id!, { by: "other", choice: 0 })).rejects.toThrow("订阅人");
  expect(setStatus).not.toHaveBeenCalled();
  await answerAsk(app, write.ask_id!, { by: "owner", choice: 0 });
  expect(setStatus.mock.calls).toEqual([[expect.objectContaining({ idempotencyKey: write.id, userId: "owner", spaceId: "personal" }),
    { key: "a", expectedRevision: "1", status: "closed" }]]);
  expect(providerState(app, "owner", id)).toMatchObject({ external: { revision: "2", status: "closed" }, direction: "push", error: null, write: null });
  await expect(decideProviderWrite(app, "owner", id, write.id, true)).rejects.toThrow("已变化");
});

it("direct write uses the same precondition and a changed remote revision blocks it", async () => {
  const t = configureTarget(app, "owner", { ...config, importMode: "direct", mode: "direct" });
  await syncTarget(app, "owner", t.id);
  const [id] = ids();
  upsertItem(app, id, { status: "done" });
  items = [{ ...ext, revision: "changed" }];
  await syncTarget(app, "owner", t.id);
  const conflict = providerState(app, "owner", id)!.write!;
  expect(conflict.state).toBe("conflict");
  expect(providerState(app, "owner", id)).toMatchObject({ direction: "pull", error: conflict.error });
  await expect(decideProviderWrite(app, "owner", id, conflict.id, true)).rejects.toThrow("外部版本");
  expect(setStatus).not.toHaveBeenCalled();
  await decideProviderWrite(app, "owner", id, conflict.id, false);
  upsertItem(app, id, { status: "open" });
  upsertItem(app, id, { status: "done" });
  await syncTarget(app, "owner", t.id);
  expect(setStatus.mock.calls[0][1].expectedRevision).toBe("changed");
});

it("refuses a pull after the subscriber loses write access", async () => {
  createUser(app, { id: "member", name: "成员" });
  createSpace(app, { id: "team", name: "团队", kind: "project" });
  addMember(app, "team", "member", "editor");
  const t = configureTarget(app, "member", { ...config, spaceId: "team" });
  addMember(app, "team", "member", "reader");
  expect(() => syncTarget(app, "member", t.id)).toThrow("没有权限");
  expect(() => syncTarget(app, "owner", t.id)).toThrow("找不到该订阅");
  expect(pull).not.toHaveBeenCalled();
});

it("rolls back a bad page and leaves a rejected candidate closed", async () => {
  const t = configureTarget(app, "owner", config);
  items.push({ ...ext, key: "b", status: "unmapped" });
  await expect(syncTarget(app, "owner", t.id)).rejects.toThrow("未声明");
  expect(ids()).toHaveLength(0);
  items.pop();
  await syncTarget(app, "owner", t.id);
  expect(pull.mock.lastCall?.[1].cursor).toBeUndefined();
  const [id] = ids();
  decideCandidate(app, id, false, "owner");
  items = [{ ...ext, title: "另一个标题" }];
  await syncTarget(app, "owner", t.id);
  expect(getItem(app, id)).toMatchObject({ status: "cancelled", title: ext.title });
  expect(setStatus).not.toHaveBeenCalled();
});

it("invalidates the old confirmation when the local status changes", async () => {
  const t = configureTarget(app, "owner", { ...config, importMode: "direct" });
  await syncTarget(app, "owner", t.id);
  const [id] = ids();
  upsertItem(app, id, { status: "done" });
  const w = providerState(app, "owner", id)!.write!;
  upsertItem(app, id, { status: "open" });
  expect(getAsk(app, w.ask_id!).status).toBe("cancelled");
  expect(providerState(app, "owner", id)?.write).toBeNull();
});

it("enforces subscription ownership through the HTTP item read, local edit and writeback routes", async () => {
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    createUser(app, { id: "member", name: "成员" });
    const headers = { authorization: `Bearer ${createApiToken(app, "member", "test")}` };
    const configured = await server.inject({ method: "PUT", url: "/api/item-sync", payload: { ...config, mode: "direct", importMode: "direct" } });
    expect(configured.statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: `/api/item-sync/${configured.json().id}/pull` })).statusCode).toBe(200);
    const [id] = ids();
    const url = `/api/items/${id}`;
    expect((await server.inject(url)).json().external).toMatchObject({ url: ext.url, status: "open" });
    // What the pages show: the entry with its platform's name on the work page too, and each subscription's count and last read.
    const label = (await server.inject("/api/item-sync")).json().providers.find((p: { id: string }) => p.id === config.provider).label;
    expect((await server.inject(`/api/work/${id}`)).json().external).toMatchObject({ url: ext.url, status: "open", providerLabel: label, write: null });
    const listed = (await server.inject("/api/item-sync")).json();
    expect(listed.targets).toEqual([expect.objectContaining({ id: configured.json().id, items: 1, synced_at: expect.any(String) })]);
    expect(listed.providers.find((p: { id: string }) => p.id === config.provider)).toHaveProperty("targetHint");
    expect((await server.inject({ url, headers })).statusCode).toBe(404);
    expect((await server.inject({ method: "PATCH", url, headers, payload: { status: "done" } })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: url + "/writeback", headers, payload: { writeId: "other", confirm: true } })).statusCode).toBe(404);
    expect(getItem(app, id).status).toBe("open");
    expect(setStatus).not.toHaveBeenCalled();
  } finally { await server.close(); }
});

it("同一连接主体跨目标和空间重复导入一个外部键", async () => {
  storeConnection(app, { userId: "owner", provider: "demo-account", accountId: "one", accountName: "账号", scopes: [], accessToken: "test" });
  pull.mockImplementation(async ctx => {
    await ctx.connection("demo-account");
    return { items, done: true };
  });
  createSpace(app, { id: "team", name: "团队", kind: "project" });
  const first = configureTarget(app, "owner", config);
  const other = configureTarget(app, "owner", { ...config, spaceId: "team" });
  const overlap = configureTarget(app, "owner", { ...config, target: "another" });
  items.push({ ...ext, key: "child", parentKey: ext.key, title: "子事项" });
  await syncTarget(app, "owner", first.id);
  await syncTarget(app, "owner", overlap.id);
  const [parent] = all<{ id: string }>(app.db, "select id from items where parent_id is null");
  items = items.map(i => ({ ...i, title: "另一个空间", summary: "私有", revision: "2" }));
  await syncTarget(app, "owner", other.id);
  expect(ids()).toHaveLength(2);
  expect(all(app.db, "select title,parent_id from items where space_id='personal' order by rowid")).toEqual([
    { title: ext.title, parent_id: null }, { title: "子事项", parent_id: parent.id },
  ]);
  expect(providerState(app, "owner", parent.id)?.external).toEqual(ext);
  items = [{ ...ext, key: "separate", parentKey: ext.key }];
  await syncTarget(app, "owner", other.id);
  expect(all(app.db, "select parent_id from items where space_id='team'")).toEqual([{ parent_id: null }]);
  expect(all(app.db, "select distinct subjects from external_item_links")).toEqual([{ subjects: '{"demo-account":"one"}' }]);
  storeConnection(app, { userId: "owner", provider: "demo-account", accountId: "two", accountName: "账号", scopes: [], accessToken: "test2" });
  const secondAccount = configureTarget(app, "owner", { ...config, spaceId: "team", target: "second" });
  items = [{ ...ext, key: "child", parentKey: ext.key }];
  await syncTarget(app, "owner", secondAccount.id);
  expect(all(app.db, "select i.parent_id from items i join external_item_links l on i.id=l.item_id where l.target_id=?", secondAccount.id))
    .toEqual([{ parent_id: null }]);
});

it("导入已存在的外部父事项后识别子事项的 parentKey", async () => {
  const t = configureTarget(app, "owner", config);
  await syncTarget(app, "owner", t.id);
  const [parent] = ids();
  items = [{ ...ext, key: "child", parentKey: ext.key }];
  await syncTarget(app, "owner", t.id);
  const [child] = ids().filter(id => id !== parent);
  expect(getItem(app, child).parentId).toBe(parent);
  createSpace(app, { id: "team", name: "团队", kind: "project" });
  const manual = upsertItem(app, undefined, { spaceId: "team", title: "手动归类" });
  writeParent(app, child, manual.id);
  const history = itemEvents(app, manual.id);
  await syncTarget(app, "owner", t.id);
  expect(getItem(app, child).parentId).toBe(manual.id);
  expect(itemEvents(app, manual.id)).toEqual(history);
});

it("resolves child-first pages and rolls back cycles and deep trees", async () => {
  const t = configureTarget(app, "owner", config);
  items.unshift({ ...ext, key: "child", parentKey: ext.key });
  await syncTarget(app, "owner", t.id);
  const links = all<{ item_id: string }>(app.db, "select item_id from external_item_links order by rowid");
  expect(getItem(app, links[0].item_id).parentId).toBe(links[1].item_id);
  items = [{ ...ext, parentKey: "child" }];
  await expect(syncTarget(app, "owner", t.id)).rejects.toThrow("成环");
  items = [{ ...ext, key: "grandchild", parentKey: "child" }, { ...ext, key: "leaf", parentKey: "grandchild" }];
  await expect(syncTarget(app, "owner", t.id)).rejects.toThrow("最多三层");
  expect(ids()).toHaveLength(2);
});

it.each([[true, "open"], [false, "cancelled"]] as const)("候选导入后选择留下=%s，订阅收到创建和转为 %s 的事件", async (keep, status) => {
  const events: Subscription["events"] = ["item.created", "item.status"];
  const seen: PluginEventV1[] = [];
  const manifest = manifestSchema.parse({ id: "listener", name: "订阅示例", permissions: { events } });
  const subscription: Subscription = {
    id: "candidates", events,
    async handle(_ctx, event) { seen.push(event); },
  };
  registerProcessHooks(manifest, undo).subscribe(subscription);
  replaceSubscriptions(app, "listener", [subscription]);
  app.config.plugins.eventSpaces.listener = ["personal"];

  const target = configureTarget(app, "owner", config);
  await syncTarget(app, "owner", target.id);
  const [id] = ids();
  await deliverPluginEvents(app);
  decideCandidate(app, id, keep, "owner");
  await deliverPluginEvents(app);
  expect(seen).toMatchObject([
    { entity: { id }, type: "item.created", data: { from: null, status: "candidate" } },
    { entity: { id }, type: "item.status", data: { from: "candidate", status } },
  ]);
});

it("includes the provider URL in created and status events without the imported body", async () => {
  app.config.plugins.eventSpaces.demo = ["personal"];
  app.db.exec("insert into plugin_subscriptions values ('demo','demo:test','item.created'),('demo','demo:test','item.status')");
  const t = configureTarget(app, "owner", { ...config, importMode: "direct" });
  items = [{ ...ext, summary: "仅供事项详情" }];
  await syncTarget(app, "owner", t.id);
  upsertItem(app, ids()[0], { status: "done" });
  const bodies = all<{ body: string }>(app.db, "select body from plugin_events order by seq").map(r => r.body);
  expect(bodies.map(body => JSON.parse(body))).toMatchObject([
    { type: "item.created", data: { links: [ext.url] } }, { type: "item.status", data: { links: [ext.url] } },
  ]);
  expect(bodies.join("")).not.toContain(items[0].summary);
});

it("migrates the first legacy mapping and its pending write on reopen", () => {
  const a = configureTarget(app, "owner", config);
  const b = configureTarget(app, "owner", { ...config, target: "second" });
  const original = upsertItem(app, undefined, { title: "初次导入" });
  const duplicate = upsertItem(app, undefined, { title: "重复导入" });
  app.db.exec(`drop table item_provider_writes;
    drop table external_item_links;
    create table item_provider_links(item_id text primary key, target_id text, external_key text, synced_at text, snapshot text, dismissed integer);
    create table item_provider_writes(id text primary key, item_id text references item_provider_links(item_id), status text, revision text, ask_id text, state text, error text);`);
  for (const [target, item] of [[a, original], [b, duplicate]] as const) {
    app.db.prepare("insert into item_provider_links values(?,?,'a','2026-11-21',?,0)").run(item.id, target.id, JSON.stringify(ext));
    app.db.prepare("insert into item_provider_writes values(?,?,'closed','1',null,'failed','无法连接')").run(target.id, item.id);
  }
  migrateItemProviders(app.db);
  migrateItemProviders(app.db);
  expect(all(app.db, "select item_id,revision,error from external_item_links")).toEqual([{ item_id: original.id, revision: "1", error: "无法连接" }]);
  expect(all(app.db, "select item_id from item_provider_writes")).toEqual([{ item_id: original.id }]);
  expect(ids()).toHaveLength(2);
  expect(all(app.db, "pragma foreign_key_check")).toEqual([]);
});

it("rejects oversized provider fields before saving items or advancing the page", async () => {
  const target = configureTarget(app, "owner", config);
  for (const field of ["status", "url", "assignee", "parentKey", "revision", "summary"] as const) {
    items = [ext, { ...ext, key: "invalid", [field]: "https://example.org/" + "a".repeat(65537) }];
    await expect(syncTarget(app, "owner", target.id)).rejects.toThrow(field);
    expect(ids()).toEqual([]);
    expect(pull.mock.lastCall?.[1].cursor).toBeUndefined();
  }
});
