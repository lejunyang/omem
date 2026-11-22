import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { App } from "../src/core/app.ts";
import { all } from "../src/core/db.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { closeVault, connectionSecrets, listConnections } from "../src/auth/vault.ts";
import { accountHome, accountState, loggedIn, stopAccountLogins, tickAgentLogins, withAccount } from "../src/agents/accounts.ts";
import { loginMethodsFor, type AgentLoginDef } from "../src/agents/agent-logins.ts";
import { allProfiles } from "../src/core/config.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { describePlugin, forgetPlugin, getPlugin, loadPlugins, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import type { AgentLoginDef as SdkLoginDef } from "../packages/plugin-sdk/agent-login.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/**
 * Login methods plugins bring for members' own AI accounts (docs/v2/agent-accounts.md §6): a fake
 * plugin that "signs in" by writing a credentials file where the backend's env points, keeps a refresh
 * secret, refreshes and logs out. Runs in this process, so globalThis tells the test what it saw.
 */
const PROBE = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function register(api) {
  api.agentLogin({
    backend: "traex", id: "sso", label: "用示例公司账号登录",
    async login(ctx) {
      ctx.show({ url: "https://sso.example.test/device", code: "WXYZ-1234" });
      await new Promise((r) => setTimeout(r, 20));
      if (globalThis.__loginFail) throw new Error("示例公司账号拒绝了");
      mkdirSync(ctx.env.TRAE_HOME, { recursive: true });
      writeFileSync(join(ctx.env.TRAE_HOME, "credentials.json"), JSON.stringify({ user: ctx.userId, appKey: ctx.settings.appKey, live: api.settings().appKey }));
      await ctx.secret.set("refresh-" + ctx.userId);
      return { user: ctx.userId + "@example.test", expiresAt: Date.now() + (globalThis.__expiresIn ?? 3600000) };
    },
    async refresh(ctx) {
      globalThis.__refreshed = (globalThis.__refreshed ?? []).concat(ctx.userId + ":" + (await ctx.secret.get()));
      if (globalThis.__refreshNull) return null;
      return { expiresAt: Date.now() + 7200000 };
    },
    async logout(ctx) {
      globalThis.__loggedOut = (globalThis.__loggedOut ?? []).concat(ctx.userId + ":" + existsSync(join(ctx.env.TRAE_HOME, "credentials.json")));
      await ctx.secret.set(null);
    },
  });
}`;

type G = { __loginFail?: boolean; __expiresIn?: number; __refreshed?: string[]; __refreshNull?: boolean; __loggedOut?: string[] };
const g = globalThis as G;

let app: App;
let server: FastifyInstance;
const tokens: Record<string, string> = {};

function writePlugin(id: string, yaml: string, code = PROBE) {
  const dir = join(app.home, "plugins", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), yaml);
  writeFileSync(join(dir, "server.mjs"), code);
}
const as = (user: string | null, path: string, init: RequestInit = {}) =>
  fetch(app.baseUrl + path, { ...init, headers: { ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) } });
const login = (user: string, method = "loginprobe:sso") => as(user, "/api/me/agent-accounts/traex/login", { method: "POST", body: JSON.stringify({ method }) });
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("等不到");
    await new Promise((r) => setTimeout(r, 10));
  }
}
const secretOf = (user: string) => {
  const c = listConnections(app, user).find((x) => x.provider === "agent:traex:loginprobe:sso");
  return c ? connectionSecrets(app, c.id)?.accessToken ?? null : null;
};

beforeEach(async () => {
  for (const k of ["__loginFail", "__expiresIn", "__refreshed", "__refreshNull", "__loggedOut"] as const) delete g[k];
  app = testApp();
  setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap-missing" });
  writePlugin("loginprobe", "id: loginprobe\nname: 示例登录\npermissions:\n  agentLogin: [traex]\nsettings:\n  - { key: appKey, label: 应用标识, type: text, default: \"\" }\n");
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, "loginprobe", "inprocess");
  for (const id of ["ann", "bob"]) {
    createUser(app, { name: id, id });
    tokens[id] = createApiToken(app, id, "test");
  }
  server = await startServer(app, { port: 0, quiet: true });
});
afterEach(async () => {
  stopAccountLogins();
  await server.close();
  for (const id of ["loginprobe", "nodecl", "badbackend", "dupe"]) {
    try { forgetPlugin(id); } catch {}
  }
  setSandboxSupportForTests(undefined);
  await new Promise((r) => setImmediate(r));
  app.db.close();
  closeVault(app.home);
  rmSync(app.home, { recursive: true, force: true });
});

describe("插件提供的 AI 账号登录方式", () => {
  it("我的 AI 账号按后端列出自己的登录和插件的登录方式；SDK 类型和宿主一致", async () => {
    const mine = await (await as("ann", "/api/me/agent-accounts")).json();
    const traex = mine.backends.find((b: { id: string }) => b.id === "traex");
    expect(traex.methods).toEqual([{ id: "native", label: "TraeX 自己的登录" }, { id: "loginprobe:sso", label: "用示例公司账号登录", plugin: "loginprobe" }]);
    expect(mine.backends.find((b: { id: string }) => b.id === "codex").methods.map((m: { id: string }) => m.id)).toEqual(["native"]);
    expect(describePlugin(getPlugin("loginprobe")).permissions.agentLogin).toEqual(["traex"]);
    const sdk: SdkLoginDef = { backend: "traex", id: "x", label: "x", login: async (ctx) => ({ user: ctx.userId }) };
    const host: AgentLoginDef = sdk;
    expect(host.id).toBe("x");
  });

  it("登录：链接和验证码给页面、也发到本人的私聊；凭据写进 env 指的位置，秘密存进密钥库；插件读得到本人在设置里填的值", async () => {
    expect((await as(null, "/api/plugins/loginprobe/settings", { method: "PUT", body: JSON.stringify({ appKey: "example_app" }) })).status).toBe(200);
    const r = await login("ann");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: "https://sso.example.test/device", code: "WXYZ-1234" });
    const note = all<{ title: string; body: string }>(app.db, "select title, body from notifications where user_id = 'ann'").at(-1)!;
    expect(note.title).toContain("TraeX");
    expect(note.body).toContain("omem 为你");
    expect(note.body).toContain("https://sso.example.test/device");
    expect(note.body).toContain("WXYZ-1234");
    await until(() => accountState(app, "ann", "traex").state === "logged-in");
    const s = accountState(app, "ann", "traex");
    expect(s).toMatchObject({ user: "ann@example.test", method: "loginprobe:sso" });
    expect(JSON.parse(readFileSync(join(accountHome(app, "ann"), ".trae", "credentials.json"), "utf8"))).toEqual({ user: "ann", appKey: "example_app", live: "example_app" });
    expect(secretOf("ann")).toBe("refresh-ann");
    // Not among the connected apps, not in the account folder.
    expect((await (await as("ann", "/api/auth/connections")).text())).not.toContain("refresh-ann");
    // Her runs on TraeX now start with her account.
    const traex = allProfiles(app.config).find((p) => p.id === "traex")!;
    expect(withAccount(app, "ann", traex)).toMatchObject({ ownAccount: { userId: "ann" } });
    const view = (await (await as("ann", "/api/me/agent-accounts")).json()).backends.find((b: { id: string }) => b.id === "traex");
    expect(view).toMatchObject({ state: "logged-in", method: "loginprobe:sso", methodLabel: "用示例公司账号登录" });
  });

  it("登录失败留下原因；不认识的登录方式 404", async () => {
    g.__loginFail = true;
    expect((await login("ann")).status).toBe(200);
    await until(() => !!accountState(app, "ann", "traex").error);
    expect(accountState(app, "ann", "traex")).toMatchObject({ state: "none", error: expect.stringContaining("示例公司账号拒绝了") });
    expect((await login("ann", "loginprobe:nothing")).status).toBe(404);
  });

  it("续签：到期前 10 分钟（最短 1 分钟）安排；按 kv 里的时间续；返回 null 改成登录过期并告诉本人，目录留着", async () => {
    g.__expiresIn = 5 * 60_000;
    await login("ann");
    await until(() => accountState(app, "ann", "traex").state === "logged-in");
    const first = accountState(app, "ann", "traex");
    expect(first.refreshAt! - Date.now()).toBeGreaterThan(50_000);
    expect(first.refreshAt! - Date.now()).toBeLessThanOrEqual(60_000);
    expect(await tickAgentLogins(app)).toBe(0);
    expect(await tickAgentLogins(app, Date.now() + 2 * 60_000)).toBe(1);
    expect(g.__refreshed).toEqual(["ann:refresh-ann"]);
    const second = accountState(app, "ann", "traex");
    expect(second.expiresAt! - Date.now()).toBeGreaterThan(7_000_000);
    expect(second.refreshAt).toBe(second.expiresAt! - 10 * 60_000);
    // 检查 runs the refresh too.
    expect((await as("ann", "/api/me/agent-accounts/traex/check", { method: "POST" })).status).toBe(200);
    expect(g.__refreshed).toHaveLength(2);
    g.__refreshNull = true;
    expect(await tickAgentLogins(app, Date.now() + 3 * 3_600_000)).toBe(1);
    expect(accountState(app, "ann", "traex")).toMatchObject({ state: "expired", error: expect.stringContaining("续不了") });
    expect(loggedIn(app, "ann", "traex")).toBe(false);
    expect(existsSync(join(accountHome(app, "ann"), ".trae", "credentials.json"))).toBe(true);
    expect(all<{ title: string }>(app.db, "select title from notifications where user_id = 'ann'").map((n) => n.title)).toContainEqual(expect.stringContaining("登录过期"));
    // Expired: nothing more to refresh.
    expect(await tickAgentLogins(app, Date.now() + 6 * 3_600_000)).toBe(0);
  });

  it("退出：先调插件的 logout，再删秘密和目录；别人的登录不受影响；主人也能让他退出", async () => {
    await login("ann");
    await login("bob");
    await until(() => accountState(app, "ann", "traex").state === "logged-in" && accountState(app, "bob", "traex").state === "logged-in");
    // Bob logging himself out touches only his own.
    expect((await as("bob", "/api/me/agent-accounts/traex", { method: "DELETE" })).status).toBe(200);
    expect(g.__loggedOut).toEqual(["bob:true"]);
    expect(secretOf("bob")).toBeNull();
    expect(existsSync(accountHome(app, "bob"))).toBe(false);
    expect(secretOf("ann")).toBe("refresh-ann");
    expect(accountState(app, "ann", "traex").state).toBe("logged-in");
    const bobView = await (await as("bob", "/api/me/agent-accounts")).text();
    expect(bobView).not.toContain("ann@example.test");
    // A member cannot reach another's: the owner's route is refused, the owner's works and calls logout.
    expect((await as("bob", "/api/agent-accounts/ann/traex", { method: "DELETE" })).status).toBe(403);
    expect((await as(null, "/api/agent-accounts/ann/traex", { method: "DELETE" })).status).toBe(200);
    expect(g.__loggedOut).toEqual(["bob:true", "ann:true"]);
    expect(secretOf("ann")).toBeNull();
    expect(existsSync(accountHome(app, "ann"))).toBe(false);
  });

  it("没有声明、没被信任、隔离运行或后端不能按人登录时都不生效", async () => {
    // Not declared in permissions.agentLogin: trusting it fails.
    writePlugin("nodecl", "id: nodecl\nname: 没声明\n");
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    await expect(trustPlugin(app, "nodecl", "inprocess")).rejects.toThrow(/permissions\.agentLogin/);
    // Gemini 已支持成员粘贴 API key，改用目录中没有 account 声明的 Qwen。
    writePlugin("badbackend", "id: badbackend\nname: 后端不对\npermissions:\n  agentLogin: [qwen]\n", PROBE.replace('backend: "traex"', 'backend: "qwen"'));
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    await expect(trustPlugin(app, "badbackend", "inprocess")).rejects.toThrow(/不能按人登录/);
    // Untrusted: its method goes away at once.
    untrustPlugin(app, "loginprobe");
    expect(loginMethodsFor("traex")).toEqual([]);
    expect((await login("ann")).status).toBe(404);
    // Isolated: its code runs in its own process, which refuses the method.
    await expect(trustPlugin(app, "loginprobe", "isolated")).rejects.toThrow(/AI 账号的登录方式/);
    expect(loginMethodsFor("traex")).toEqual([]);
    // Trusted inside omem again: back.
    await trustPlugin(app, "loginprobe", "inprocess");
    expect(loginMethodsFor("traex").map((m) => m.key)).toEqual(["loginprobe:sso"]);
  });
});
