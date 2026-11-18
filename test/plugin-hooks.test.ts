import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { App } from "../src/core/app.ts";
import { all, one } from "../src/core/db.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { closeVault } from "../src/auth/vault.ts";
import { auditLog } from "../src/auth/permissions.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { upsertItem } from "../src/items/store.ts";
import { attachObject } from "../src/flows/plugin-objects.ts";
import { HOOK_PER_MINUTE, pluginHook, registerHook } from "../src/plugins/hooks.ts";
import { describePlugin, forgetPlugin, getPlugin, loadPlugins, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import type { PluginHook as SdkHook } from "../packages/plugin-sdk/objects.ts";
import { listFirings, saveRule } from "../src/rules/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

let app: App;
const servers: FastifyInstance[] = [];
const kind = "hookprobe:change";
const url = (key = "1") => `https://example.test/changes/${key}`;
const item = () => upsertItem(app, undefined, { title: "示例商城退款", spaceId: "personal", userId: "owner" }, "user");
const set = (key: string, value: Record<string, unknown>) => pluginStore(app, "hookprobe", "owner", "personal").put("states", key, value);
async function server() { const s = await startServer(app, { port: 0, quiet: true }); servers.push(s); return s; }
async function secret(s: FastifyInstance, name = "change") {
  const r = await s.inject({ method: "POST", url: `/api/plugins/hookprobe/hooks/${name}/secret` });
  expect(r.statusCode).toBe(200);
  return r.json() as { secret: string; path: string };
}

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
    expect(describePlugin(getPlugin("hookprobe")).hooks).toEqual([{ name: "change", label: "合并请求有变化", path: "/api/hooks/hookprobe/change/", secret: null }]);
    const sdk: SdkHook = { name: "mr", handle: () => ({ refresh: [{ kind: "change", key: "1" }] }) };
    expect(sdk.name).toBe("mr");
    expect(ROUTE_RULES["POST /api/hooks/:plugin/:name/:secret"]).toBe("public");
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

  it("错的密钥、插件或名字一样 404；撤销后失效；重新生成后旧的失效；只有主人能管理密钥", async () => {
    const s = await server(), { path, secret: first } = await secret(s);
    const call = (p: string) => s.inject({ method: "POST", url: p, headers: { "content-type": "application/json", "x-platform": "demo" }, payload: JSON.stringify({ key: "9", sig: "ok" }) });
    expect((await call(path)).statusCode).toBe(200);
    expect((await call(`/api/hooks/hookprobe/change/omk_wrong`)).statusCode).toBe(404);
    expect((await call(`/api/hooks/hookprobe/other/${first}`)).statusCode).toBe(404);
    expect((await call(`/api/hooks/nobody/change/${first}`)).statusCode).toBe(404);
    expect(one<{ value: string }>(app.db, "select value from kv where key='plugin-hook:hookprobe/change'")!.value).not.toContain(first);
    expect(describePlugin(getPlugin("hookprobe")).hooks[0].secret).toMatchObject({ createdAt: expect.any(String), usedAt: expect.any(String) });
    const { path: second } = await secret(s);
    expect((await call(path)).statusCode).toBe(404);
    expect((await call(second)).statusCode).toBe(200);
    createUser(app, { id: "member", name: "成员甲" });
    const headers = { authorization: `Bearer ${createApiToken(app, "member", "test")}` };
    expect((await s.inject({ method: "POST", url: "/api/plugins/hookprobe/hooks/change/secret", headers })).statusCode).toBe(403);
    expect((await s.inject({ method: "DELETE", url: "/api/plugins/hookprobe/hooks/change/secret" })).json()).toEqual({ revoked: true });
    expect((await call(second)).statusCode).toBe(404);
    expect((await s.inject({ method: "POST", url: "/api/plugins/hookprobe/hooks/missing/secret" })).statusCode).toBe(404);
  });

  it("每分钟最多 60 次，超出 429；正文最大 1 MB", async () => {
    const s = await server(), { path } = await secret(s);
    const call = (payload = JSON.stringify({ key: "9", sig: "ok" })) => s.inject({ method: "POST", url: path, headers: { "content-type": "application/json", "x-platform": "demo" }, payload });
    expect((await call("x".repeat(1024 * 1024 + 10))).statusCode).toBe(413);
    for (let n = 0; n < HOOK_PER_MINUTE; n++) expect((await call()).statusCode).toBe(200);
    const over = await call();
    expect(over.statusCode).toBe(429);
    expect(over.headers["retry-after"]).toBe("60");
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
    expect((await s.inject({ method: "POST", url: path, payload: "{}" })).statusCode).toBe(404);
  });
});
