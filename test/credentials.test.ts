import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { App } from "../src/core/app.ts";
import { testApp } from "./helpers.ts";
import { all, one, run } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { closeVault, connectionSecrets, listConnections } from "../src/auth/vault.ts";
import { accountHome, accountRun, ensureAccountHome, loggedIn } from "../src/agents/accounts.ts";
import { allProfiles } from "../src/core/config.ts";
import { canonical } from "../src/agents/own-sandbox.ts";
import { sandboxStatus } from "../src/agents/own-run.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { checkCredential, credentialHold, credentialInstallDirs, logoutCredential, myCredentials, registerCredential, refreshCredential, startCredentialLogin, stopCredentialLogins, tickCredentialChecks, tickCredentialRefreshes } from "../src/agents/credentials.ts";
import type { CredentialDef } from "../packages/plugin-sdk/credential.ts";
import { forgetPlugin, loadPlugins, trustPlugin } from "../src/plugins/registry.ts";
import { codeHash, setTrust, trustState } from "../src/plugins/trust.ts";

let app: App;
let undo: (() => void)[];
beforeEach(() => {
  app = testApp(); undo = [];
  createUser(app, { id: "ann", name: "成员 A" }); createUser(app, { id: "bob", name: "成员 B" });
  setSandboxSupportForTests({ ok: true, bwrap: "/missing-fixture-bwrap" });
});
afterEach(async () => {
  vi.useRealTimers();
  stopCredentialLogins(); for (const fn of undo) fn();
  for (const id of ["credprobe", "nodecl"]) forgetPlugin(id);
  await new Promise(r => setImmediate(r));
  closeVault(app.home); app.db.close(); rmSync(app.home, { recursive: true, force: true });
  setSandboxSupportForTests(undefined); vi.useRealTimers();
});
function add(overrides: Partial<CredentialDef> = {}) {
  const def: CredentialDef = { id: "sso", name: "示例授权", required: true,
    provides: { backends: ["traex"], commands: [{ name: "acme", state: [".acme/data"], readOnly: [{ subcommand: ["query"] }],
      resource: [{ match: { subcommand: ["query"] }, key: "db:{option.instance}" }], outcomes: { expired: [{ json: "$.code", equals: "EXPIRED" }] } }] },
    async login(ctx, show) { show({ url: "https://auth.example.test/device", code: "TEST-1234" }); await ctx.secret.set("fixture-secret-" + ctx.userId); return { user: ctx.userId + "@example.test", expiresAt: Date.now() + 3600_000 }; },
    async provide(ctx) { writeFileSync(join(ctx.home, ".acme/data", "login.json"), JSON.stringify({ user: ctx.userId })); },
    ...overrides,
  };
  undo.push(registerCredential("sample", def, () => ({}), app));
  return def;
}
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("状态未更新"); }

it("SDK 契约、按人持有和 provide：凭据不进库、接口或日志", async () => {
  add();
  expect(await startCredentialLogin(app, "ann", "sample:sso")).toEqual({ url: "https://auth.example.test/device", code: "TEST-1234" });
  await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  expect(loggedIn(app, "ann", "traex")).toBe(true);
  expect(loggedIn(app, "bob", "traex")).toBe(false);
  expect(JSON.parse(readFileSync(join(accountHome(app, "ann"), ".acme/data/login.json"), "utf8"))).toEqual({ user: "ann" });
  const c = listConnections(app, "ann").find(c => c.provider === "credential:sample:sso")!;
  expect(connectionSecrets(app, c.id)?.accessToken).toBe("fixture-secret-ann");
  expect(JSON.stringify(myCredentials(app, "ann"))).not.toContain("fixture-secret");
  expect(JSON.stringify(all(app.db, "select * from credential_holds"))).not.toContain("fixture-secret");
  expect(credentialHold(app, "ann", "sample:sso").sharing.scope).toBe("self");
  await logoutCredential(app, "ann", "sample:sso");
  expect(loggedIn(app, "ann", "traex")).toBe(false);
  expect(listConnections(app, "ann").some(c => c.provider.startsWith("credential:"))).toBe(false);
});
it("续签后供给，失败变过期；同种状态一天最多通知一次", async () => {
  const provide = vi.fn(async () => {}), refresh = vi.fn(async () => ({ expiresAt: Date.now() + 2 * 3600_000 }));
  add({ provide, refresh }); await startCredentialLogin(app, "ann", "sample:sso");
  await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  expect(provide).toHaveBeenCalledTimes(1);
  expect(await tickCredentialRefreshes(app)).toBe(0);
  await tickCredentialRefreshes(app, Date.now() + 3600_000);
  expect(refresh).toHaveBeenCalledOnce(); expect(provide).toHaveBeenCalledTimes(2);
  refresh.mockRejectedValue(new Error("secret=not-for-logs"));
  await refreshCredential(app, "ann", "sample:sso");
  expect(credentialHold(app, "ann", "sample:sso").state).toBe("expired");
  expect(JSON.stringify(credentialHold(app, "ann", "sample:sso"))).not.toContain("not-for-logs");
  expect(all(app.db, "select * from notifications where user_id='ann' and title like '%登录过期%' ")).toHaveLength(1);
  await refreshCredential(app, "ann", "sample:sso");
  expect(all(app.db, "select * from notifications where user_id='ann' and title like '%登录过期%' ")).toHaveLength(1);
});
it("本人只检查本机 HOME；每日检查在重启后仍去重", async () => {
  const check = vi.fn(async () => ({ state: "ok" as const, user: "machine", expiresAt: Date.now() + 2 * 86400_000 }));
  const def = add({ check });
  expect(credentialHold(app, "owner", "sample:sso").sharing.scope).toBe("all");
  await tickCredentialChecks(app); await tickCredentialChecks(app);
  expect(check).toHaveBeenCalledOnce();
  expect(check.mock.calls[0]).toBeDefined();
  expect(myCredentials(app, "owner").credentials[0]).toMatchObject({ machine: true, login: false, state: "expiring", reason: "用的是这台机器上已有的登录" });
  expect(() => startCredentialLogin(app, "owner", "sample:sso")).toThrow();
  expect(all(app.db, "select * from notifications where title like '%三天内到期%'")).toHaveLength(1);
  expect(def.check).toBe(check);
});
it("登录中重复请求共享链接；取消阻止晚回调供给和秘密写入", async () => {
  let finish!: () => void, ctx!: Parameters<CredentialDef["login"]>[0];
  const provide = vi.fn(async () => {});
  add({ provide, async login(c, show) { ctx = c; show({ url: "https://auth.example.test/device" }); await new Promise<void>(r => finish = r); return { user: "ann" }; } });
  await startCredentialLogin(app, "ann", "sample:sso");
  expect(myCredentials(app, "ann").credentials[0].state).toBe("logging-in");
  expect(await startCredentialLogin(app, "ann", "sample:sso")).toEqual({ url: "https://auth.example.test/device" });
  await logoutCredential(app, "ann", "sample:sso"); finish(); await new Promise(r => setImmediate(r));
  expect(provide).not.toHaveBeenCalled();
  await expect(ctx.secret.set("late-secret")).rejects.toThrow();
  expect(credentialHold(app, "ann", "sample:sso").state).toBe("none");
});
it("续签不响应取消也在两分钟内结束，不堵住退出", async () => {
  add({ provide: async () => {}, refresh: () => new Promise(() => {}) });
  await startCredentialLogin(app, "ann", "sample:sso"); await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  vi.useFakeTimers(); const job = refreshCredential(app, "ann", "sample:sso");
  await vi.advanceTimersByTimeAsync(120_001); await job;
  expect(credentialHold(app, "ann", "sample:sso").state).toBe("expired");
  await logoutCredential(app, "ann", "sample:sso");
});
it.skipIf(process.platform === "win32")("安装目录只读、状态预建；本人默认清单显示 state；拒绝逃逸和符号链接", () => {
  const install = join(app.home, "outside-install");
  mkdirSync(install);
  add({ provides: { backends: ["traex"], commands: [{ name: "acme", install: ["~/.fixture-install-missing"], state: [".fixture-state"] }] } });
  const home = ensureAccountHome(app, "ann");
  expect(existsSync(join(home, ".fixture-state"))).toBe(true);
  expect(credentialInstallDirs(app)).toEqual([]);
  expect(myCredentials(app, "ann").credentials[0].missingInstall).toContain(canonical(join(homedir(), ".fixture-install-missing")));
  expect(sandboxStatus(app).defaults.writable).toContain(canonical(join(homedir(), ".fixture-state")));
  expect(() => registerCredential("bad", { id: "sso", name: "坏路径", login: async () => ({ user: "a" }), provides: { commands: [{ name: "x", state: ["../secrets"] }] } }, () => ({}), app)).toThrow();
  const rel = ".fixture-link"; symlinkSync(app.home, join(home, rel), "dir");
  undo.push(registerCredential("second", { id: "sso", name: "连接", login: async () => ({ user: "a" }), provides: { commands: [{ name: "x", state: [rel] }] } }, () => ({}), app));
  expect(() => ensureAccountHome(app, "ann")).toThrow(/符号链接/);
  expect(() => registerCredential("third", { id: "sso", name: "安装", login: async () => ({ user: "a" }), provides: { commands: [{ name: "x", install: [app.home] }] } }, () => ({}), app)).toThrow();
});
it("凭据声明拒绝错误 readOnly/resource/outcomes，保存声明且查询走索引", () => {
  const def = add();
  expect(one<{declaration:string}>(app.db, "select declaration from credential_kinds")?.declaration).toContain("db:{option.instance}");
  expect(() => registerCredential("invalid", { ...def, provides: { commands: [{ name: "x", readOnly: [{ subcommand: 1 } as never] }] } })).toThrow();
  const plan = app.db.prepare("explain query plan select * from credential_holds where kind=? and state='logged-in' order by last_used_at desc limit 32").all("sample:sso");
  expect(JSON.stringify(plan)).toContain("credential_lenders");
});
it("插件必须声明权限并信任进程内运行；隔离方式解释原因", async () => {
  const make = (id: string, permission: boolean) => {
    const dir = join(app.home, "plugins", id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.yaml"), `id: ${id}\nname: 示例插件\npermissions:\n  credential: ${permission}\n`);
    writeFileSync(join(dir, "server.mjs"), `export default api => api.credential({ id: "sso", name: "示例授权", provides: {}, async login(ctx, show) { return {user: "demo"} } });`);
    return dir;
  };
  const dir = make("credprobe", true); make("nodecl", false);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await expect(trustPlugin(app, "nodecl", "inprocess")).rejects.toThrow(/permissions.credential/);
  await expect(trustPlugin(app, "credprobe", "isolated")).rejects.toThrow(/凭据.*omem/);
  await trustPlugin(app, "credprobe", "inprocess");
  expect(myCredentials(app, "ann").credentials.map(c => c.kind)).toEqual(["credprobe:sso"]);
  setTrust(app, "credprobe", dir, "inprocess", true, undefined, false, [], undefined, true);
  expect(trustState(app, "credprobe", dir, true, undefined, false, [], undefined, true)).toBe("trusted");
  writeFileSync(join(dir, "server.mjs"), "export default () => {};\n");
  expect(trustState(app, "credprobe", dir, true, undefined, false, [], undefined, true)).toBe("changed");
  expect(codeHash(dir)).toBeTruthy();
});
