import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { closeVault } from "../src/auth/vault.ts";
import { auditLog } from "../src/auth/permissions.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { upsertItem } from "../src/items/store.ts";
import { attachObject } from "../src/flows/plugin-objects.ts";
import { pluginHook, registerHook } from "../src/plugins/hooks.ts";
import { HOOK_ACCEPT_MS } from "../src/plugins/hook-accept.ts";
import { HOOK_HEADER_MAX, HOOK_PER_MINUTE } from "../src/plugins/hook-request.ts";
import { HOOK_CONCURRENCY, HOOK_HISTORY_MAX, HOOK_HISTORY_MS, HOOK_PENDING_MAX, HOOK_RETRY_MS } from "../src/plugins/hook-inbox.ts";
import type { PluginHook, PluginHookRequest } from "../src/plugins/types.ts";
import { describePlugin, forgetPlugin, getPlugin, loadPlugins, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import type { PluginHook as SdkHook } from "../packages/plugin-sdk/objects.ts";
import { listFirings, saveRule } from "../src/rules/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

vi.mock("fastify", async (original) => {
  const actual = await original<typeof import("fastify")>();
  return { ...actual, default: (options: Parameters<typeof actual.default>[0]) => {
    const instance = actual.default(options);
    instance.listen = (async () => { await instance.ready(); return "http://127.0.0.1:4317"; }) as typeof instance.listen;
    return instance;
  } };
});

let app: App;
const servers: FastifyInstance[] = [];
const unregister: (() => void)[] = [];
const kind = "hookprobe:change";
const url = (key = "1") => `https://example.test/changes/${key}`;
const item = () => upsertItem(app, undefined, { title: "示例商城退款", spaceId: "personal", userId: "owner" }, "user");
const set = (key: string, value: Record<string, unknown>) => pluginStore(app, "hookprobe", "owner", "personal").put("states", key, value);
async function server() { const s = await startServer(app, { port: 0, quiet: true }); servers.push(s); return s; }
async function secret(s: FastifyInstance, name = "change") {
  const r = await s.inject({ method: "POST", url: `/api/plugins/hookprobe/hooks/${name}/secret` });
  expect(r.statusCode).toBe(200);
  return r.json() as { secret: string; path: string; headerPath: string; secretHeader: string };
}
const probe = (def: Omit<PluginHook, "name"> & { name?: string }) => unregister.push(registerHook("hookprobe", { name: "inbox", ...def }));
const send = (s: FastifyInstance, url: string, data: unknown = {}, headers: Record<string, string> = {}) => s.inject({
  method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(data),
});
const history = (s: FastifyInstance, name = "inbox") => s.inject({ method: "GET", url: `/api/plugins/hookprobe/hooks/${name}/deliveries` });
const delivery = (id: string) => one<{ status: string; due_at: number | null; body: string | null; attempts: number }>(app.db,
  "select status,due_at,body,attempts from plugin_hook_deliveries where id=?", id);
function defer() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("插件回调收件箱", () => {
  it("先提交收件再应答，不等慢处理；重投共用编号且不占限流，头白名单不带密钥", async () => {
    const replies: PluginHookRequest[] = [];
    const gate = defer();
    probe({ ack: "first", headers: ["X-Signature", "Cookie", "X-Callback-Key"], secretHeader: "X-Callback-Key", rateLimit: { perMinute: 1 }, async handle(_ctx, req) {
      replies.push(req);
      await gate.promise;
    } });
    const instance = await server();
    const auth = await secret(instance, "inbox");
    const payload = { id: "示例事件", text: "这只是外部材料" };
    try {
      const responses = await Promise.all(Array.from({ length: 3 }, () => send(instance, `${auth.headerPath}?source=demo`, payload, {
        "x-callback-key": auth.secret, "x-event-id": "delivery-1", "x-signature": "sig", "x-drop": "drop", cookie: "session=never-save",
      })));
      expect(responses.map(response => response.statusCode).sort()).toEqual([200, 200, 202]);
      const { id } = responses[0].json();
      expect(responses.map(response => response.json().id)).toEqual([id, id, id]);
      expect(delivery(id)).toMatchObject({ body: JSON.stringify(payload) });
      await vi.waitFor(() => expect(replies).toHaveLength(1));
      expect(replies[0]).toEqual({ method: "POST", query: { source: "demo" }, headers: { "content-type": "application/json", "x-event-id": "delivery-1", "x-signature": "sig" }, body: JSON.stringify(payload),
        event: { format: "webhook", data: payload, trust: "untrusted" }, deliveryId: id, deliveryKey: "delivery-1" });
      expect(JSON.stringify(all(app.db, "select * from plugin_hook_deliveries"))).not.toMatch(new RegExp(`${auth.secret}|session=never-save|x-drop`));
      expect((await history(instance)).json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "running", id, duplicates: 2 }),
        expect.objectContaining({ status: "duplicate", duplicateOf: id, deliveryKey: "delivery-1", durationMs: 0 }),
      ]));
      expect((await send(instance, auth.path, {}, { "x-event-id": "other-id" })).statusCode).toBe(429);
      gate.resolve();
      await vi.waitFor(() => expect(delivery(id)).toMatchObject({ status: "done", body: null, attempts: 1 }));
      const output = (await history(instance)).json().find((entry: { id: string }) => entry.id === id);
      expect(output).toMatchObject({ status: "done", receivedAt: expect.any(Number), durationMs: expect.any(Number), error: null });
      expect(JSON.stringify(output)).not.toContain(JSON.stringify(payload));
    } finally { gate.resolve(); }
  });

  it("重开数据库后继续排队和中断的投递，处理并发有上限", async () => {
    const gate = defer();
    const handled: string[] = [];
    probe({ ack: "first", async handle(_ctx, req) { handled.push(req.deliveryId); await gate.promise; } });
    const instance = await server();
    const auth = await secret(instance, "inbox");
    const ids: string[] = [];
    try {
      for (let index = 0; index < HOOK_CONCURRENCY + 2; index++) {
        const response = await send(instance, auth.path, { index }, { "idempotency-key": `demo-${index}` });
        expect(response.statusCode).toBe(202);
        ids.push(response.json().id);
      }
      await vi.waitFor(() => expect(handled).toHaveLength(HOOK_CONCURRENCY));
      expect(delivery(ids[HOOK_CONCURRENCY])?.status).toBe("pending");
      const closing = instance.close();
      await new Promise(resolve => setImmediate(resolve));
      const interrupted = ids[HOOK_CONCURRENCY + 1];
      run(app.db, "update plugin_hook_deliveries set status='running',attempts=1,due_at=null where id=?", interrupted);
      run(app.db, `insert into plugin_hook_deliveries(id,plugin,name,key,key_until,received_at,status,format,body,envelope)
        values('unaccepted','hookprobe','inbox','unaccepted',?,?,'admitting','webhook','{}','{}')`, Date.now() + 60_000, Date.now());
      gate.resolve();
      await closing;
      servers.splice(servers.indexOf(instance), 1);
      const home = app.home;
      app.db.close();
      app = testApp(home);
      const reopened = await server();
      const retry = await send(reopened, auth.path, { index: HOOK_CONCURRENCY }, { "idempotency-key": `demo-${HOOK_CONCURRENCY}` });
      expect(retry.json()).toEqual({ ok: true, id: ids[HOOK_CONCURRENCY], duplicate: true });
      await vi.waitFor(() => expect(handled).toHaveLength(HOOK_CONCURRENCY + 2));
      expect(handled.toSorted()).toEqual(ids.toSorted());
      await vi.waitFor(() => expect(delivery(interrupted)).toMatchObject({ status: "done", attempts: 1 }));
      expect(delivery("unaccepted")).toMatchObject({ status: "failed", attempts: 0, body: null });
    } finally { gate.resolve(); }
  });

  it("失败按退避重试，最终错误可读；体字段和去重时间可配置", async () => {
    const handle = vi.fn(() => { throw new Error("示例处理失败"); });
    probe({ ack: "first", dedup: { headers: [], bodyFields: ["event.id"], windowHours: 1 }, handle });
    const instance = await server();
    const auth = await secret(instance, "inbox");
    const payload = { event: { id: 42 } };
    const { id } = (await send(instance, auth.path, payload)).json();
    for (const [index, delay] of HOOK_RETRY_MS.entries()) {
      const attempt = index + 1;
      await vi.waitFor(() => expect(delivery(id)).toMatchObject({ status: "pending", attempts: attempt }));
      expect(delivery(id)!.due_at! - Date.now()).toBeGreaterThan(delay - 2_000);
      run(app.db, "update plugin_hook_deliveries set due_at=0 where id=?", id);
      expect((await send(instance, auth.path, payload)).json()).toMatchObject({ id, duplicate: true });
    }
    await vi.waitFor(() => expect(delivery(id)).toMatchObject({ status: "failed", attempts: 3, body: null }));
    expect(handle).toHaveBeenCalledTimes(3);
    expect((await history(instance)).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, status: "failed", deliveryKey: "42", attempts: 3, error: expect.stringContaining("示例处理失败") }),
    ]));
    const window = one<{ ttl: number }>(app.db, "select key_until-received_at as ttl from plugin_hook_deliveries where id=?", id);
    expect(window?.ttl).toBe(3_600_000);
    run(app.db, "update plugin_hook_deliveries set key_until=0 where id=?", id);
    const next = (await send(instance, auth.path, payload)).json();
    expect(next).toMatchObject({ duplicate: false });
    expect(next.id).not.toBe(id);
  });

  it("支持路径、Bearer 与自定义头；401 一致；突发限流带等待时间；限制头数和正文", async () => {
    probe({ secretHeader: "X-Callback-Key", rateLimit: { perMinute: 6, burst: 3 }, handle: () => ({}) });
    const instance = await server();
    const auth = await secret(instance, "inbox");
    expect(auth.secretHeader).toBe("x-callback-key");
    const bad = await Promise.all([
      send(instance, auth.headerPath, {}, { authorization: "Bearer invalid" }),
      send(instance, auth.headerPath.replace("hookprobe", "missing"), {}, { authorization: `Bearer ${auth.secret}` }),
      send(instance, auth.headerPath.replace("inbox", "missing"), {}, { "x-callback-key": auth.secret }),
      send(instance, `${auth.headerPath}/incorrect`),
    ]);
    for (const response of bad) expect([response.statusCode, response.body]).toEqual([401, bad[0].body]);
    const extra = Object.fromEntries(Array.from({ length: HOOK_HEADER_MAX }, (_, index) => [`x-demo-${index}`, "v"]));
    expect((await send(instance, auth.path, {}, extra)).statusCode).toBe(431);
    expect((await send(instance, auth.path, { data: "x".repeat(1024 * 1024) })).statusCode).toBe(413);
    expect((await send(instance, auth.path)).statusCode).toBe(200);
    expect((await send(instance, auth.headerPath, {}, { authorization: `bearer ${auth.secret}` })).statusCode).toBe(200);
    expect((await send(instance, auth.headerPath, {}, { "x-callback-key": auth.secret })).statusCode).toBe(200);
    const over = await send(instance, auth.path);
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(over.headers["retry-after"])).toBeLessThanOrEqual(10);
  });

  it("自动解析 webhook 和 Chat Completions；Chat 只回执", async () => {
    const handled: PluginHookRequest[] = [];
    probe({ handle(_ctx, req) { handled.push(req); } });
    const instance = await server();
    const { path } = await secret(instance, "inbox");
    const webhook = { kind: "updated", fields: ["title"] };
    expect((await send(instance, path, webhook)).json()).toEqual({ ok: true, refreshed: 0, skipped: 0, emitted: 0 });
    expect(handled.at(-1)?.event).toMatchObject({ format: "webhook", data: webhook });
    const chat = { model: "demo", messages: [{ role: "user", content: "旧内容" }, { role: "user", content: '{"event":"updated"}' }, { role: "assistant", content: "不是投递内容" }] };
    const completion = await send(instance, path, chat);
    expect(completion.json()).toMatchObject({ object: "chat.completion", model: "demo", choices: [{ message: { role: "assistant", content: `已收到 · ${handled.at(-1)!.deliveryId}` }, finish_reason: "stop" }] });
    expect(handled.at(-1)).toMatchObject({ body: JSON.stringify(chat), event: { format: "openai-chat", data: { event: "updated" } } });
    const stream = await send(instance, path, { stream: true, messages: [{ role: "user", content: "示例纯文本" }] });
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    const frames = stream.body.trim().split("\n\n").map(frame => frame.slice(6));
    expect(frames).toHaveLength(3);
    expect(JSON.parse(frames[0])).toMatchObject({ object: "chat.completion.chunk", choices: [{ delta: { role: "assistant", content: `已收到 · ${handled.at(-1)!.deliveryId}` } }] });
    expect(JSON.parse(frames[1])).toMatchObject({ choices: [{ finish_reason: "stop" }] });
    expect(frames[2]).toBe("[DONE]");
    expect(handled.at(-1)?.event).toMatchObject({ data: "示例纯文本" });
    expect(handled).toHaveLength(3);
  });

  it.each(["inprocess", "isolated"] as const)("示例事件平台自定受理、重投、冲突和拒绝格式（%s）", async mode => {
    if (mode === "isolated") {
      untrustPlugin(app, "hookprobe");
      await trustPlugin(app, "hookprobe", mode);
    }
    const instance = await server();
    const auth = await secret(instance, "events");
    const payload = { execution_id: "demo-1", input: { parts: [{ type: "text", text: "已更新" }, { type: "data", data: { title: "项目 A" } }] }, event: { kind: "updated" } };
    const headers = { authorization: `Bearer ${auth.secret}`, "idempotency-key": payload.execution_id };
    const receive = (data: unknown = payload, overrides: Record<string, string> = {}) => send(instance, auth.headerPath, data, { ...headers, ...overrides });
    const accepted = await receive();
    expect(accepted.statusCode).toBe(202);
    expect(accepted.headers["x-demo-receipt"]).toEqual("events");
    expect(accepted.json()).toEqual({ execution_id: "demo-1", accepted: true, duplicate: false });
    const deliveries = await history(instance, "events");
    const [{ id }] = deliveries.json();
    await vi.waitFor(() => expect(delivery(id)).toMatchObject({ status: "done", attempts: 1, body: null }));
    const duplicate = await receive();
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ execution_id: "demo-1", accepted: true, duplicate: true });
    const conflict = await receive({ ...payload, event: { kind: "deleted" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ error: { code: "ID_CONFLICT", message: "这个编号已用于另一条请求" } });
    const mismatch = await receive(payload, { "idempotency-key": "wrong" });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ error: { code: "IDEMPOTENCY_MISMATCH" } });
    expect((await send(instance, auth.headerPath, payload, { authorization: headers.authorization })).statusCode).toBe(400);
    const task = { ...payload, execution_id: "demo-task", return_url: "https://example.test/reply" };
    const rejected = await receive(task, { "idempotency-key": task.execution_id });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toEqual({ error: { code: "EVENT_ONLY", message: "只接收订阅事件" } });
    const bad = await receive(payload, { authorization: "Bearer invalid" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "密钥无效" } });
    const limited = await receive();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: { code: "RATE_LIMITED", message: "请稍后再投" } });
    expect((await history(instance, "events")).json()).toMatchObject([
      { status: "failed", attempts: 0, deliveryKey: "demo-task" },
      { status: "duplicate", attempts: 0, duplicateOf: id },
      { status: "done", attempts: 1, id },
    ]);
    expect(pluginStore(app, "hookprobe", "owner", "personal").get("events", "last")).toEqual(payload);
  });

  it("自定应答在提交后拿到判定状态；默认冲突返回 409，哈希比较原始正文", async () => {
    const accept = vi.fn<NonNullable<PluginHook["accept"]>>((_req, state) => {
      expect(app.db.isTransaction).toBe(false);
      expect(delivery(state.deliveryId)).toBeDefined();
      return state.conflict ? { status: 422, body: "不同的正文" } : { status: 202, body: state };
    });
    const handle = vi.fn();
    probe({ ack: "first", accept, handle });
    probe({ name: "default-ack", ack: "first", handle });
    const instance = await server();
    const auth = await secret(instance, "inbox");
    const headers = { "idempotency-key": "same" };
    const first = await send(instance, auth.path, { demo: true }, headers);
    const { deliveryId } = first.json();
    expect(first.json()).toEqual({ deliveryId, duplicate: false, conflict: false });
    expect((await send(instance, auth.path, { demo: true }, headers)).json()).toEqual({ deliveryId, duplicate: true, conflict: false });
    const conflict = await send(instance, auth.path, { demo: false }, headers);
    expect([conflict.statusCode, conflict.body]).toEqual([422, "不同的正文"]);
    expect(accept).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryId, deliveryKey: "same" }), { deliveryId, conflict: true, duplicate: false });
    await vi.waitFor(() => expect(delivery(deliveryId)?.status).toBe("done"));
    expect(handle).toHaveBeenCalledTimes(1);
    const fallback = await secret(instance, "default-ack");
    expect((await send(instance, fallback.path, { demo: true }, headers)).statusCode).toBe(202);
    const spaced = await instance.inject({ method: "POST", url: fallback.path, headers: { ...headers, "content-type": "application/json" }, payload: '{ "demo": true }' });
    expect(spaced.statusCode).toBe(409);
    expect(spaced.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("写库失败回 503，不执行 accept 或排队；提交受理结果失败也不入队", async () => {
    const accept = vi.fn(() => ({ status: 202, body: { accepted: true } }));
    const handle = vi.fn();
    const unavailableBody = { error: { code: "BUSY", message: "请稍后再投" } };
    probe({ ack: "first", accept, handle, unavailableBody });
    const instance = await server();
    const auth = await secret(instance, "inbox");
    app.db.exec("create trigger fail_insert before insert on plugin_hook_deliveries begin select raise(abort, '示例写入失败'); end");
    const failed = await send(instance, auth.path);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual(unavailableBody);
    expect(accept).not.toHaveBeenCalled();
    app.db.exec(`drop trigger fail_insert;
      create trigger fail_admit before update on plugin_hook_deliveries when new.status='pending' begin select raise(abort, '示例提交失败'); end`);
    const notQueued = await send(instance, auth.path);
    expect(notQueued.statusCode).toBe(503);
    expect(notQueued.json()).toEqual(unavailableBody);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(handle).not.toHaveBeenCalled();
    expect((await history(instance)).json()).toMatchObject([{ status: "admitting", attempts: 0 }]);
  });

  it("accept 抛错或超时回 500，释放标识且不排队", async () => {
    const handle = vi.fn();
    probe({ ack: "first", handle, accept(req) {
      if (req.query.fail === "throw") throw new Error("示例内部错误");
      if (req.query.fail === "timeout") {
        const deadline = performance.now() + HOOK_ACCEPT_MS + 1;
        while (performance.now() < deadline) { continue; }
      }
      return { status: 202, body: true };
    } });
    const instance = await server();
    const auth = await secret(instance, "inbox");
    const headers = { "idempotency-key": "same" };
    for (const fail of ["throw", "timeout"]) {
      const response = await send(instance, `${auth.path}?fail=${fail}`, {}, headers);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: "回调受理失败" });
    }
    expect((await history(instance)).json()).toMatchObject(Array(2).fill({ status: "failed", attempts: 0 }));
    expect(handle).not.toHaveBeenCalled();
    expect((await send(instance, auth.path, {}, headers)).statusCode).toBe(202);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
  });

  it("收件箱不丢未完成的投递，清理过期历史且限制条数", async () => {
    probe({ ack: "first", handle: () => ({}) });
    const at = Date.now();
    run(app.db, `insert into plugin_hook_deliveries(id,plugin,name,received_at,status,format)
      values('old','hookprobe','inbox',?,'done','webhook')`, at - HOOK_HISTORY_MS - 1000);
    const instance = await server();
    expect(delivery("old")).toBeUndefined();
    const auth = await secret(instance, "inbox");
    run(app.db, `with recursive numbers(num) as (select 1 union all select num+1 from numbers where num<?)
      insert into plugin_hook_deliveries(id,plugin,name,received_at,status,format,body,envelope,due_at)
      select 'pending-'||num,'hookprobe','inbox',?,'pending','webhook','{}','{}',? from numbers`, HOOK_PENDING_MAX, at, at + 60_000);
    expect((await send(instance, auth.path)).statusCode).toBe(503);
    expect(delivery("pending-1")?.status).toBe("pending");
    run(app.db, "delete from plugin_hook_deliveries where status='pending'");
    run(app.db, `with recursive numbers(num) as (select 1 union all select num+1 from numbers where num<?)
      insert into plugin_hook_deliveries(id,plugin,name,received_at,status,format)
      select 'recent-'||num,'hookprobe','inbox',?+num,'done','webhook' from numbers`, HOOK_HISTORY_MAX, at - HOOK_HISTORY_MAX - 1000);
    expect((await send(instance, auth.path)).statusCode).toBe(202);
    expect(delivery("recent-1")).toBeUndefined();
    expect(one<{ count: number }>(app.db, "select count(*) as count from plugin_hook_deliveries")?.count).toBe(HOOK_HISTORY_MAX);
  });
});

// The platform sends `{"key": "1", "sig": "ok"}`: the plugin checks its own signature and names the object to read again.
const PROBE = `export default function register(api) {
  api.object({ kind: "change", label: "合并请求", statuses: { open: "进行中", merged: "已合并" }, final: ["merged"],
    match: (url) => url.startsWith("https://example.test/changes/") ? url.slice("https://example.test/changes/".length) : null,
    async read(ctx, key) {
      const state = (await ctx.store.get("states", key)) ?? {};
      return { title: "示例合并请求 " + key, status: state.status ?? "open", link: "https://example.test/changes/" + key, revision: state.revision, note: state.note };
    } });
  api.hook({ name: "change", label: "合并请求有变化",
    async handle(ctx, req) {
      const body = JSON.parse(req.body || "{}");
      if (body.sig !== "ok" || req.headers["x-platform"] !== "demo") throw new Error("签名不对");
      await ctx.store.put("hooks", "last", { query: req.query, size: req.body.length, user: ctx.userId });
      return { refresh: [{ kind: "change", key: String(body.key) }, { kind: "other:thing", key: "x" }], emit: body.emit ? [{ kind: "pushed", keys: { key: body.key } }] : [] };
    } });
  api.hook({ name: "events", label: "示例事件平台", ack: "first", format: "webhook",
    dedup: { headers: ["Idempotency-Key"], bodyFields: ["execution_id"], requireMatch: true },
    rateLimit: { perMinute: 6 },
    unauthorizedBody: { error: { code: "UNAUTHORIZED", message: "密钥无效" } },
    rateLimitedBody: { error: { code: "RATE_LIMITED", message: "请稍后再投" } },
    unavailableBody: { error: { code: "BUSY", message: "请稍后再投" } },
    accept(req, { duplicate, conflict }) {
      const event = req.event.data;
      if (conflict) return { status: 409, body: { error: { code: "ID_CONFLICT", message: "这个编号已用于另一条请求" } } };
      if (Object.hasOwn(event, "return_url") || !Array.isArray(event.input?.parts) || !event.event)
        return { status: 422, body: { error: { code: "EVENT_ONLY", message: "只接收订阅事件" } } };
      return { status: 202, headers: { "x-demo-receipt": "events" }, body: { execution_id: event.execution_id, accepted: true, duplicate } };
    },
    async handle(ctx, req) { await ctx.store.put("events", "last", req.event.data); }
  });
}`;

beforeEach(async () => {
  app = testApp();
  const dir = join(app.home, "plugins", "hookprobe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: hookprobe\nname: 示例回调\n");
  writeFileSync(join(dir, "server.mjs"), PROBE);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, "hookprobe", "inprocess");
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const undo of unregister.splice(0)) undo();
  forgetPlugin("hookprobe");
  await new Promise((resolve) => setImmediate(resolve));
  app.db.close();
  closeVault(app.home);
  rmSync(app.home, { recursive: true, force: true });
});

describe("插件回调", () => {
  it("注册校验名字；插件详情列出回调和有没有地址；SDK 类型可以声明回调", () => {
    expect(pluginHook("hookprobe", "change")).toBeTruthy();
    expect(() => registerHook("hookprobe", { name: "change", handle: () => ({}) })).toThrow("重复");
    expect(() => registerHook("hookprobe", { name: "Bad Name", handle: () => ({}) })).toThrow("不合法");
    expect(describePlugin(getPlugin("hookprobe")).hooks.find(hook => hook.name === "change")).toEqual({ name: "change", label: "合并请求有变化", path: "/api/hooks/hookprobe/change/", headerPath: "/api/hooks/hookprobe/change", url: null, secret: null, secretHeader: "authorization", ack: null, rateLimit: { perMinute: 60 }, lastDelivery: null });
    const sdk: SdkHook = { name: "mr", handle: () => ({ refresh: [{ kind: "change", key: "1" }] }) };
    expect(sdk.name).toBe("mr");
    expect(ROUTE_RULES["POST /api/hooks/:plugin/:name/:secret"]).toBe("public");
  });

  it("设置页拿到按网页地址算好的回调地址和最近一次投递（重投不算）", async () => {
    const s = await server();
    expect((await secret(s))).toMatchObject({ url: null, legacyUrl: null });
    app.config.webUrl = "https://omem.example.test/ ";
    const made = await secret(s) as Awaited<ReturnType<typeof secret>> & { url: string; legacyUrl: string };
    expect(made.url).toBe("https://omem.example.test/api/hooks/hookprobe/change");
    expect(made.legacyUrl).toBe(`https://omem.example.test/api/hooks/hookprobe/change/${made.secret}`);
    const listed = (await s.inject({ method: "GET", url: "/api/plugins" })).json() as { id: string; hooks: { name: string; url: string | null; lastDelivery: unknown }[] }[];
    expect(listed.find(p => p.id === "hookprobe")!.hooks.find(h => h.name === "change")).toMatchObject({ url: "https://omem.example.test/api/hooks/hookprobe/change", lastDelivery: null });
    const insert = (id: string, at: number, status: string, error: string | null) => run(app.db,
      "insert into plugin_hook_deliveries(id,plugin,name,received_at,status,format,error) values(?,?,?,?,?,?,?)", id, "hookprobe", "change", at, status, "webhook", error);
    insert("d1", 1_000, "done", null);
    insert("d2", 2_000, "failed", "签名不对");
    insert("d3", 3_000, "duplicate", null);
    expect(describePlugin(getPlugin("hookprobe")).hooks.find(h => h.name === "change")!.lastDelivery).toEqual({ at: 2_000, status: "failed", error: "签名不对" });
  });

  it("回调叫醒重读：修订变了记 updated，规则按 objectChanges 命中；不认识的对象跳过；写审计", async () => {
    const r = saveRule(app, { name: "有更新", description: "合并请求有更新告诉我", enabled: true, trigger: { event: "object", objectKind: kind, objectChanges: ["updated"] }, judge: "code", actions: [{ type: "notify" }] }, "user", "owner");
    const i = item(); set("1", { revision: "c1" }); await attachObject(app, i.id, url(), "owner");
    const s = await server(), { path } = await secret(s);
    set("1", { revision: "c2", note: "新提交 1 个" });
    const res = await s.inject({ method: "POST", url: `${path}?event=push`, headers: { "content-type": "application/json", "x-platform": "demo" }, payload: JSON.stringify({ key: "1", sig: "ok", emit: true }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, refreshed: 1, skipped: 1, emitted: 1 });
    expect(pluginStore(app, "hookprobe", "owner", "personal").get("hooks", "last")).toEqual({ query: { event: "push" }, size: JSON.stringify({ key: "1", sig: "ok", emit: true }).length, user: "owner" });
    expect(all<{ type: string }>(app.db, "select type from flow_signals order by id").map((x) => x.type)).toEqual([`object.${kind}.updated`, "plugin.hookprobe.pushed"]);
    expect(listFirings(app, r.id)).toHaveLength(1);
    expect(auditLog(app).find((a) => a.action === "plugin.hook")).toMatchObject({ actor: "hook", target: "hookprobe/change", detail: { ok: true, refreshed: 1, skipped: 1, emitted: 1 } });
    // A body the plugin refuses: 400, audited, nothing read.
    const bad = await s.inject({ method: "POST", url: path, headers: { "content-type": "text/plain" }, payload: "{\"key\":\"1\",\"sig\":\"no\"}" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("签名不对");
    expect(auditLog(app).filter((a) => a.action === "plugin.hook").map((a) => a.detail.ok)).toEqual([false, true]);
  });

  it("错的密钥、插件或名字一样 401；撤销后失效；重新生成后旧的失效；只有主人能管理密钥", async () => {
    const s = await server(), { path, secret: first } = await secret(s);
    const call = (p: string) => s.inject({ method: "POST", url: p, headers: { "content-type": "application/json", "x-platform": "demo" }, payload: JSON.stringify({ key: "9", sig: "ok" }) });
    expect((await call(path)).statusCode).toBe(200);
    expect((await call(`/api/hooks/hookprobe/change/omk_wrong`)).statusCode).toBe(401);
    expect((await call(`/api/hooks/hookprobe/other/${first}`)).statusCode).toBe(401);
    expect((await call(`/api/hooks/nobody/change/${first}`)).statusCode).toBe(401);
    expect(one<{ value: string }>(app.db, "select value from kv where key='plugin-hook:hookprobe/change'")!.value).not.toContain(first);
    expect(describePlugin(getPlugin("hookprobe")).hooks[0].secret).toMatchObject({ createdAt: expect.any(String), usedAt: expect.any(String) });
    const { path: second } = await secret(s);
    expect((await call(path)).statusCode).toBe(401);
    expect((await call(second)).statusCode).toBe(200);
    createUser(app, { id: "member", name: "成员甲" });
    const headers = { authorization: `Bearer ${createApiToken(app, "member", "test")}` };
    expect((await s.inject({ method: "POST", url: "/api/plugins/hookprobe/hooks/change/secret", headers })).statusCode).toBe(403);
    expect((await s.inject({ method: "GET", url: "/api/plugins/hookprobe/hooks/change/deliveries", headers })).statusCode).toBe(403);
    expect((await s.inject({ method: "GET", url: "/api/plugins/hookprobe/hooks/change/deliveries", remoteAddress: "192.0.2.7" })).statusCode).toBe(401);
    expect((await s.inject({ method: "DELETE", url: "/api/plugins/hookprobe/hooks/change/secret" })).json()).toEqual({ revoked: true });
    expect((await call(second)).statusCode).toBe(401);
    expect((await s.inject({ method: "POST", url: "/api/plugins/hookprobe/hooks/missing/secret" })).statusCode).toBe(404);
  });

  it("每分钟最多 60 次，超出 429；正文最大 1 MB", async () => {
    const s = await server(), { path } = await secret(s);
    const call = (payload = JSON.stringify({ key: "9", sig: "ok" })) => s.inject({ method: "POST", url: path, headers: { "content-type": "application/json", "x-platform": "demo" }, payload });
    expect((await call("x".repeat(1024 * 1024 + 10))).statusCode).toBe(413);
    for (let n = 0; n < HOOK_PER_MINUTE; n++) expect((await call()).statusCode).toBe(200);
    const over = await call();
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(over.headers["retry-after"])).toBeLessThanOrEqual(60);
  });

  it("隔离运行的插件也能声明回调，撤销信任后回调没有了", async () => {
    untrustPlugin(app, "hookprobe"); await trustPlugin(app, "hookprobe", "isolated");
    const i = item(); set("1", { revision: "c1" }); await attachObject(app, i.id, url(), "owner");
    const s = await server(), { path } = await secret(s);
    set("1", { revision: "c2" });
    const res = await s.inject({ method: "POST", url: path, headers: { "content-type": "application/json", "x-platform": "demo" }, payload: JSON.stringify({ key: "1", sig: "ok" }) });
    expect(res.json()).toMatchObject({ ok: true, refreshed: 1 });
    expect(one<{ type: string }>(app.db, "select type from flow_signals")?.type).toBe(`object.${kind}.updated`);
    untrustPlugin(app, "hookprobe");
    expect(pluginHook("hookprobe", "change")).toBeUndefined();
    expect((await s.inject({ method: "POST", url: path, payload: "{}" })).statusCode).toBe(401);
  });

  it("隔离运行保留先应答、协议和头白名单声明", async () => {
    untrustPlugin(app, "hookprobe");
    writeFileSync(join(app.home, "plugins", "hookprobe", "server.mjs"), PROBE.replace('name: "change", label:', 'name: "change", ack: "first", format: "webhook", headers: ["x-platform"], label:'));
    await trustPlugin(app, "hookprobe", "isolated");
    expect(pluginHook("hookprobe", "change")).toMatchObject({ ack: "first", format: "webhook", headers: ["x-platform"] });
    const instance = await server();
    const auth = await secret(instance);
    const response = await send(instance, auth.headerPath, { messages: [{ role: "user", content: "这是事件字段" }], key: "1", sig: "ok", emit: true }, {
      authorization: `Bearer ${auth.secret}`, "x-platform": "demo",
    });
    expect(response.statusCode).toBe(202);
    await vi.waitFor(() => expect(delivery(response.json().id)?.status).toBe("done"));
    expect(one<{ type: string }>(app.db, "select type from flow_signals")?.type).toBe("plugin.hookprobe.pushed");
  });
});
