import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { all } from "../src/core/db.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { createSpace } from "../src/core/spaces.ts";
import { configureTarget, decideProviderWrite, providerState, syncTarget } from "../src/items/providers.ts";
import { getItem, itemEvents, upsertItem } from "../src/items/store.ts";
import { decideCandidate } from "../src/items/auto.ts";
import { manifestSchema } from "../src/plugins/registry.ts";
import { registerProcessHooks } from "../src/plugins/process-hooks.ts";
import type { ExternalItem, ItemProvider } from "../src/plugins/types.ts";
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
  const api = registerProcessHooks(manifestSchema.parse({ id: "demo", name: "示例", permissions: { itemProvider: true, write: true } }), undo);
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
  decideCandidate(app, id, true, "owner");
  upsertItem(app, id, { title: "本地标题" });
  items = [{ ...ext, revision: "2", title: "外部新标题", status: "closed" }];
  await syncTarget(app, "owner", t.id);
  expect(pull.mock.lastCall?.[1].cursor).toBe("page1");
  expect(getItem(app, id)).toMatchObject({ title: "本地标题", status: "done" });
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
  await expect(answerAsk(app, write.ask_id!, { by: "other", choice: 0 })).rejects.toThrow("订阅人");
  expect(setStatus).not.toHaveBeenCalled();
  await answerAsk(app, write.ask_id!, { by: "owner", choice: 0 });
  expect(setStatus.mock.calls).toEqual([[expect.objectContaining({ idempotencyKey: write.id, userId: "owner", spaceId: "personal" }),
    { key: "a", expectedRevision: "1", status: "closed" }]]);
  expect(providerState(app, "owner", id)).toMatchObject({ external: { revision: "2", status: "closed" }, write: null });
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
    expect((await server.inject({ url, headers })).statusCode).toBe(404);
    expect((await server.inject({ method: "PATCH", url, headers, payload: { status: "done" } })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: url + "/writeback", headers, payload: { writeId: "other", confirm: true } })).statusCode).toBe(404);
    expect(getItem(app, id).status).toBe("open");
    expect(setStatus).not.toHaveBeenCalled();
  } finally { await server.close(); }
});
