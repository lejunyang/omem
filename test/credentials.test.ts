import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/core/app.ts";
import { testApp } from "./helpers.ts";
import { all, one, run } from "../src/core/db.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { closeVault, connectionSecrets, listConnections } from "../src/auth/vault.ts";
import { accountHome, accountRun, accountState, checkAccount, ensureAccountHome, loggedIn, removeAccount, saveToken, withAccount } from "../src/agents/accounts.ts";
import { agentProfileSchema, allProfiles } from "../src/core/config.ts";
import { canonical } from "../src/agents/own-sandbox.ts";
import { sandboxStatus } from "../src/agents/own-run.ts";
import { setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { allCredentials, checkCredential, credentialHold, credentialInstallDirs, logoutCredential, myCredentials, registerCredential, refreshCredential, startCredentialLogin, stopCredentialLogins, setCredentialSharing, selectedCredential, tickCredentialChecks, tickCredentialRefreshes } from "../src/agents/credentials.ts";
import type { CredentialDef } from "../packages/plugin-sdk/credential.ts";
import { forgetPlugin, loadPlugins, setPluginEnabled, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { codeHash, setTrust, trustState } from "../src/plugins/trust.ts";

// 成员的登录、供给和退出按账号目录的 POSIX 规范路径核对（accounts.ts accountStatePaths），这些只在 Linux / macOS 上跑：
// Windows 起不了成员沙箱，成员的凭据在那里本来就用不上；凭据声明的检查在 Windows 上照常跑。
const posixIt = it.skipIf(process.platform === "win32");
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

posixIt("SDK 契约、按人持有和 provide：凭据不进库、接口或日志", async () => {
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
  expect(existsSync(join(accountHome(app, "ann"), ".acme/data/login.json"))).toBe(false);
  expect(loggedIn(app, "ann", "traex")).toBe(false);
  expect(listConnections(app, "ann").some(c => c.provider.startsWith("credential:"))).toBe(false);
});
posixIt("检查凭据供给的后端沿用持有，退出后登录文件和后端登录状态一起消失", async () => {
  const check = vi.fn(async () => ({ state: "ok" as const, user: "demo" }));
  add({ check, async provide(ctx) {
    mkdirSync(ctx.env.TRAE_HOME, { recursive: true });
    writeFileSync(join(ctx.env.TRAE_HOME, "login"), "demo");
  } });
  await startCredentialLogin(app, "ann", "sample:sso");
  await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  const file = join(accountHome(app, "ann"), ".trae/login");
  expect(readFileSync(file, "utf8")).toBe("demo");
  expect(await checkAccount(app, "ann", "traex")).toMatchObject({ state: "logged-in", method: "sample:sso", user: "demo" });
  expect(check).toHaveBeenCalledOnce();
  expect(accountState(app, "ann", "traex").state).toBe("none");
  await logoutCredential(app, "ann", "sample:sso");
  expect(existsSync(file)).toBe(false);
  expect(loggedIn(app, "ann", "traex")).toBe(false);
});

posixIt.each([
  { actor: "成员", backendPath: "/api/me/agent-accounts/echo", credentialPath: "/api/credentials/sample:sso" },
  { actor: "本人", backendPath: "/api/agent-accounts/ann/echo", credentialPath: "/api/credentials/ann/sample:sso" },
])("$actor 在凭据有效或检查缺失时退出单个后端均收到 409，整份退出后解除保护", async ({ actor, backendPath, credentialPath }) => {
  const { startServer } = await import("../src/server/http.ts");
  const kind = "sample:sso", home = accountHome(app, "ann");
  const backends = ["echo", "echo-lite"];
  const profiles = backends.map(id => agentProfileSchema.parse({ id, transport: "acp", command: "fixture-backend",
    account: { owns: ["." + id] } }));
  app.config.agents.profiles = profiles;
  const dirs = [".echo", ".echo-lite", ".acme/data"];
  const refresh = vi.fn(async () => ({ expiresAt: Date.now() + 7200_000 }));
  const logout = vi.fn(async () => {});
  const check = vi.fn(async () => ({ state: "missing" as const }));
  add({ provides: { backends, commands: [{ name: "acme", state: [".acme/data"] }] }, refresh, logout, check,
    async provide(ctx) {
      for (const dir of dirs) {
        mkdirSync(join(ctx.home, dir), { recursive: true });
        writeFileSync(join(ctx.home, dir, "login"), ctx.userId);
      }
    } });
  const server = await startServer(app, { port: 0, quiet: true });
  const headers = { authorization: "Bearer " + createApiToken(app, "ann") };
  const caller = actor === "成员" ? headers : undefined;
  try {
    expect((await server.inject({ method: "POST", url: "/api/credentials/" + kind + "/login", headers })).statusCode).toBe(200);
    await until(() => credentialHold(app, "ann", kind).state === "logged-in");
    setCredentialSharing(app, "ann", kind, { scope: "members", members: ["bob"] });
    const hold = credentialHold(app, "ann", kind);
    expect(hold.refreshAt).toEqual(expect.any(Number));
    const accountList = async () => (await server.inject({ url: "/api/me/agent-accounts", headers })).json().backends;
    async function expectAvailable() {
      const accounts = await accountList();
      for (const dir of dirs) expect(readFileSync(join(home, dir, "login"), "utf8")).toBe("ann");
      for (const profile of profiles) {
        expect(accounts).toContainEqual(expect.objectContaining({ id: profile.id, state: "logged-in", method: kind }));
        expect(loggedIn(app, "ann", profile.id)).toBe(true);
        for (const requester of ["ann", "bob"])
          expect(selectedCredential(withAccount(app, requester, profile))).toMatchObject({ holder: "ann", kind, requester });
      }
      expect(credentialHold(app, "ann", kind)).toEqual(hold);
    }
    await expectAvailable();
    const refused = await server.inject({ method: "DELETE", url: backendPath, headers: caller });
    expect(refused.statusCode).toBe(409);
    const { error } = refused.json();
    for (const detail of ["示例授权", kind, ...backends, "acme", "DELETE " + credentialPath]) expect(error).toContain(detail);
    expect(error).not.toContain("fixture-secret");
    expect(logout).not.toHaveBeenCalled();
    await expectAvailable();
    expect(await tickCredentialRefreshes(app, hold.refreshAt)).toBe(1);
    expect(refresh).toHaveBeenCalledOnce();

    expect(await checkAccount(app, "ann", "echo")).toMatchObject({ state: "none", method: kind });
    const credential = async () => (await server.inject({ url: "/api/credentials", headers })).json().credentials[0];
    expect(await credential()).toMatchObject({ state: "none", supplied: true, checkedAt: expect.any(String) });
    for (const profile of profiles) {
      expect(loggedIn(app, "ann", profile.id)).toBe(false);
      for (const requester of ["ann", "bob"]) expect(() => withAccount(app, requester, profile)).toThrow(/登录/);
    }
    expect(await tickCredentialRefreshes(app, Date.now() + 86400_000)).toBe(0);
    const missing = await server.inject({ method: "DELETE", url: backendPath, headers: caller });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toContain("DELETE " + credentialPath);
    for (const dir of dirs) expect(readFileSync(join(home, dir, "login"), "utf8")).toBe("ann");

    expect((await server.inject({ method: "DELETE", url: credentialPath, headers: caller })).statusCode).toBe(200);
    expect(await credential()).toMatchObject({ state: "none", supplied: false });
    expect(logout).toHaveBeenCalledOnce();
    expect(credentialHold(app, "ann", kind)).toMatchObject({ state: "none", refreshAt: undefined });
    expect(await tickCredentialRefreshes(app, Date.now() + 86400_000)).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    const accounts = await accountList();
    for (const dir of dirs) expect(existsSync(join(home, dir, "login"))).toBe(false);
    for (const profile of profiles) {
      expect(accounts).toContainEqual(expect.objectContaining({ id: profile.id, state: "none" }));
      expect(loggedIn(app, "ann", profile.id)).toBe(false);
      for (const requester of ["ann", "bob"]) expect(() => withAccount(app, requester, profile)).toThrow(/登录/);
    }
    await checkCredential(app, "ann", kind);
    expect(await checkAccount(app, "ann", "echo")).toMatchObject({ method: "native", state: "none" });
    expect(check).toHaveBeenCalledOnce();
    expect((await server.inject({ method: "DELETE", url: backendPath, headers: caller })).statusCode).toBe(200);
  } finally { await server.close(); }
});

posixIt("自己的凭据过期会改借有效登录或提示登录，独立的原生令牌仍可用", async () => {
  const backend = "fixture", kind = "sample:sso";
  const profile = agentProfileSchema.parse({ id: backend, transport: "acp", command: process.execPath,
    account: { env: {}, dirs: [".fixture"], owns: [".fixture"], tokenEnv: "FIXTURE_TOKEN" } });
  app.config.agents.profiles = [profile];
  const probe = vi.spyOn(await import("../src/agents/probe.ts"), "probeAccount").mockResolvedValue(undefined);
  undo.push(() => probe.mockRestore());
  await saveToken(app, "bob", backend, "fixture-token");
  let state: "ok" | "expired" | "missing" = "ok";
  add({ provides: { backends: [backend] }, provide: undefined, async check() { return { state }; } });
  for (const id of ["ann", "bob"]) {
    await startCredentialLogin(app, id, kind);
    await until(() => credentialHold(app, id, kind).state === "logged-in");
  }
  setCredentialSharing(app, "bob", kind, { scope: "all" });
  expect(await checkAccount(app, "ann", backend)).toMatchObject({ state: "logged-in", method: kind });
  expect(selectedCredential(withAccount(app, "ann", profile))?.holder).toBe("ann");
  state = "expired";
  await checkCredential(app, "ann", kind);
  expect(loggedIn(app, "ann", backend)).toBe(false);
  expect(selectedCredential(withAccount(app, "ann", profile))?.holder).toBe("bob");
  setCredentialSharing(app, "bob", kind, { scope: "self" });
  expect(() => withAccount(app, "ann", profile)).toThrow(/登录/);
  await checkCredential(app, "bob", kind);
  expect(loggedIn(app, "bob", backend)).toBe(true);
  expect(accountState(app, "bob", backend)).toMatchObject({ method: "native", state: "logged-in" });
  state = "missing";
  await checkCredential(app, "ann", kind);
  expect(await checkAccount(app, "ann", backend)).toMatchObject({ method: kind, state: "none" });
  await checkCredential(app, "bob", kind);
  expect(await checkAccount(app, "bob", backend)).toMatchObject({ method: "native", state: "logged-in" });
  state = "ok";
  await checkCredential(app, "ann", kind);
  expect(loggedIn(app, "ann", backend)).toBe(true);
  for (const id of ["ann", "bob"]) {
    const dir = join(accountHome(app, id), ".fixture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "login"), id);
    await logoutCredential(app, id, kind);
    expect(existsSync(join(dir, "login"))).toBe(id === "bob");
  }
});

posixIt("退出清理独占状态，共用的后端和嵌套命令目录由最后一份持有清理", async () => {
  add();
  add({ id: "other", check: async () => ({ state: "missing" }), provides: { backends: ["traex"], commands: [{ name: "other", state: [".acme/data/other"] }] },
    async provide(ctx) {
      mkdirSync(ctx.env.TRAE_HOME, { recursive: true });
      writeFileSync(join(ctx.env.TRAE_HOME, "login"), "shared");
      writeFileSync(join(ctx.home, ".acme/data/other/login"), "other");
    } });
  for (const kind of ["sample:sso", "sample:other"]) {
    await startCredentialLogin(app, "ann", kind);
    await until(() => credentialHold(app, "ann", kind).state === "logged-in");
  }
  const home = accountHome(app, "ann");
  await checkCredential(app, "ann", "sample:other");
  await expect(removeAccount(app, "ann", "traex")).rejects.toThrow(/sample:sso[\s\S]*sample:other/);
  await logoutCredential(app, "ann", "sample:sso", "owner");
  expect(existsSync(join(home, ".acme/data/login.json"))).toBe(false);
  expect(readFileSync(join(home, ".acme/data/other/login"), "utf8")).toBe("other");
  expect(readFileSync(join(home, ".trae/login"), "utf8")).toBe("shared");
  await logoutCredential(app, "ann", "sample:other");
  expect(existsSync(join(home, ".acme/data/other"))).toBe(false);
  expect(existsSync(join(home, ".trae"))).toBe(false);
});

posixIt("只改出借设置或已整份退出时，重启后的检查不会认领后端文件", async () => {
  const kind = "sample:sso", backend = "echo";
  const profile = agentProfileSchema.parse({ id: backend, transport: "acp", command: "fixture-backend", account: { owns: [".echo"] } });
  app.config.agents.profiles = [profile];
  const check = vi.fn<NonNullable<CredentialDef["check"]>>(async () => ({ state: "ok" }));
  add({ provides: { backends: [backend] }, login: async () => ({ user: "demo" }), provide: undefined, check });
  await startCredentialLogin(app, "ann", kind);
  await logoutCredential(app, "ann", kind);
  setCredentialSharing(app, "bob", kind, { scope: "all" });

  app.db.close();
  app = App.open(app.home);
  app.config.agents.profiles = [profile];
  await tickCredentialChecks(app);
  for (const id of ["ann", "bob"]) {
    expect(await checkCredential(app, id, kind)).toMatchObject({ state: "none", suppliedBackends: [] });
    expect(loggedIn(app, id, backend)).toBe(false);
    await removeAccount(app, id, backend);
  }
  expect(check.mock.calls.map(([ctx]) => ctx.userId)).toEqual(["owner"]);
});

posixIt.each(["停用", "撤销信任"])("插件%s后成员和本人代办均可按持久声明清理，不再执行插件代码", async mode => {
  const { startServer } = await import("../src/server/http.ts");
  const dir = join(app.home, "plugins", "credprobe"), kind = "credprobe:sso";
  mkdirSync(dir, { recursive: true });
  const backend = "credprobe:echo", sharedKind = "credprobe:shared";
  writeFileSync(join(dir, "plugin.yaml"), JSON.stringify({ id: "credprobe", name: "示例插件", permissions: { credential: true },
    backends: [{ id: "echo", name: "示例", command: "fixture-backend", account: { owns: [".demo"] } },
      { id: "nested", name: "共享", command: "fixture-nested", account: { owns: [".demo/shared"] } }] }));
  writeFileSync(join(dir, "server.mjs"), `import {mkdirSync, writeFileSync} from 'node:fs'; import {join} from 'node:path';
    export default api => { api.credential({ id: 'shared', name: '共享授权', provides: {backends:['credprobe:nested']},
      async login() { return {user:'demo'} }, async provide(ctx) { mkdirSync(join(ctx.home,'.demo/shared'),{recursive:true}); writeFileSync(join(ctx.home,'.demo/shared/login'),'shared') } });
    api.credential({ id: 'sso', name: '离线授权', provides: {backends:['credprobe:echo']},
      async login(ctx, show) { await ctx.secret.set('offline-test');
        if (ctx.userId === 'bob') { writeFileSync(join(ctx.home,'.demo','login'), 'demo'); show({url:'https://auth.example.test/pending'}); return new Promise(() => {}) }
        return {user:'demo', expiresAt:Date.now()+3600000} },
      async provide(ctx) { writeFileSync(join(ctx.home,'.demo','login'), 'demo') }, async logout() { throw Error('不应调用') } }); };`);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, "credprobe", "inprocess");
  for (const user of ["ann", "bob"]) {
    await startCredentialLogin(app, user, sharedKind);
    await startCredentialLogin(app, user, kind);
  }
  if (mode === "停用") await setPluginEnabled(app, "credprobe", false);
  else untrustPlugin(app, "credprobe");
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    for (const user of ["ann", "bob"]) {
      const self = user === "ann", headers = self ? { authorization: "Bearer " + createApiToken(app, user) } : undefined;
      if (!self) forgetPlugin("credprobe");
      const url = self ? "/api/me/agent-accounts/" + backend : `/api/agent-accounts/${user}/${backend}`;
      const target = self ? `/api/credentials/${kind}` : `/api/credentials/${user}/${kind}`;
      const refused = await server.inject({ method: "DELETE", url, headers });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toContain("DELETE " + target);
      const path = join(accountHome(app, user), ".demo/login");
      expect(readFileSync(path, "utf8")).toBe("demo");
      expect((await server.inject({ method: "DELETE", url: target, headers })).statusCode).toBe(200);
      expect(existsSync(path)).toBe(false);
      const sharedFile = join(accountHome(app, user), ".demo/shared/login");
      expect(readFileSync(sharedFile, "utf8")).toBe("shared");
      expect((await server.inject({ method: "DELETE", url: target.replace(kind, sharedKind), headers })).statusCode).toBe(200);
      expect(existsSync(sharedFile)).toBe(false);
      expect(listConnections(app, user)).toHaveLength(0);
      expect(credentialHold(app, user, kind)).toMatchObject({ state: "none", refreshAt: undefined });
      expect((await server.inject({ method: "DELETE", url, headers })).statusCode).toBe(404);
    }
  } finally { await server.close(); }
});

posixIt("同种凭据从 A 改供 B，旧文件仍按持有退出，新后端要等供给成功", async () => {
  const { startServer } = await import("../src/server/http.ts");
  const kind = "sample:sso", home = accountHome(app, "ann");
  const [a, b] = ["echo-a", "echo-b"].map(id => agentProfileSchema.parse({
    id, transport: "acp", command: "fixture-backend", account: { owns: ["." + id] },
  }));
  app.config.agents.profiles = [a, b];
  add({ id: "shared", provides: { commands: [{ name: "shared", state: [".echo-a/shared"] }] },
    login: async () => ({ user: "demo" }),
    provide: async ctx => { writeFileSync(join(ctx.home, ".echo-a/shared/login"), "shared"); } });
  await startCredentialLogin(app, "ann", "sample:shared");
  const def = add({ provides: { backends: [a.id], commands: [{ name: "old-cli" }] },
    login: async () => ({ user: "demo" }),
    provide: async ctx => { writeFileSync(join(ctx.home, ".echo-a/login"), "demo"); } });
  await startCredentialLogin(app, "ann", kind);
  setCredentialSharing(app, "ann", kind, { scope: "all" });
  undo.pop()!();
  const provide = vi.fn<NonNullable<CredentialDef["provide"]>>(async ctx => {
    mkdirSync(join(ctx.home, ".echo-b"), { recursive: true });
    writeFileSync(join(ctx.home, ".echo-b/login"), "new");
  });
  add({ ...def, provides: { backends: [b.id], commands: [{ name: "new-cli" }] },
    check: async () => ({ state: "ok" }), refresh: async () => ({}), provide });
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const headers = { authorization: "Bearer " + createApiToken(app, "ann") };
    for (const [url, caller, target] of [
      ["/api/me/agent-accounts/", headers, "/api/credentials/"],
      ["/api/agent-accounts/ann/", undefined, "/api/credentials/ann/"],
    ] as const) {
      const refused = await server.inject({ method: "DELETE", url: url + a.id, headers: caller });
      expect(refused.statusCode).toBe(409);
      for (const text of [a.id, "old-cli", "DELETE " + target + kind]) expect(refused.json().error).toContain(text);
    }
    for (const id of [a.id, b.id]) expect(await checkAccount(app, "ann", id)).toMatchObject({ state: "none", method: kind });
    expect(accountState(app, "ann", a.id).state).toBe("none");
    expect(loggedIn(app, "ann", b.id)).toBe(false);
    for (const who of ["ann", "bob"]) expect(() => withAccount(app, who, b)).toThrow(/登录/);

    provide.mockRejectedValueOnce(Error("fixture"));
    await refreshCredential(app, "ann", kind);
    await checkCredential(app, "ann", kind);
    expect(loggedIn(app, "ann", b.id)).toBe(false);
    await expect(removeAccount(app, "ann", b.id)).rejects.toThrow(/new-cli/);
    await refreshCredential(app, "ann", kind);
    expect(credentialHold(app, "ann", kind)).toMatchObject({
      provision: { backends: [a.id, b.id], commands: ["old-cli", "new-cli"], paths: [".echo-a", ".echo-b"] },
      suppliedBackends: [b.id],
    });
    expect(readFileSync(join(home, ".echo-b/login"), "utf8")).toBe("new");
    for (const who of ["ann", "bob"]) expect(selectedCredential(withAccount(app, who, b))?.holder).toBe("ann");
    await expect(removeAccount(app, "ann", a.id)).rejects.toThrow(/old-cli/);
    await logoutCredential(app, "ann", kind);
    expect(existsSync(join(home, ".echo-a/login"))).toBe(false);
    expect(existsSync(join(home, ".echo-b/login"))).toBe(false);
    expect(readFileSync(join(home, ".echo-a/shared/login"), "utf8")).toBe("shared");
  } finally { await server.close(); }
});

it("登录排队时按该次请求拦截退出，即使插件再次重新登记", async () => {
  const kind = "sample:sso";
  const def = add({ provides: { backends: ["echo-a"] }, provide: undefined, login: async () => ({ user: "demo" }) });
  await startCredentialLogin(app, "ann", kind);
  undo.pop()!();
  add({ ...def, provides: { backends: ["echo-b"] } });
  const queued = startCredentialLogin(app, "ann", kind);
  undo.pop()!();
  add({ ...def, provides: { backends: ["echo-c"] } });
  // Both DELETE calls inspect the pending request before it gets its turn in the queue.
  const old = removeAccount(app, "ann", "echo-a"), pending = removeAccount(app, "ann", "echo-b");
  await Promise.all([expect(old).rejects.toMatchObject({ status: 409 }), expect(pending).rejects.toMatchObject({ status: 409 }),
    expect(queued).rejects.toThrow(/取消/)]);
});

posixIt("续签使用新的后端目录后，退出只清理两次实际供给的路径", async () => {
  const kind = "sample:sso", home = accountHome(app, "ann");
  const configure = (path: string) => {
    app.config.agents.profiles = [agentProfileSchema.parse({ id: "echo", transport: "acp", command: "fixture-backend",
      account: { env: { ECHO_HOME: "{home}/" + path }, owns: [path] } })];
  };
  add({ provides: { backends: ["echo"] }, login: async () => ({ user: "demo" }), refresh: async () => ({}),
    async provide(ctx) {
      mkdirSync(ctx.env.ECHO_HOME, { recursive: true });
      writeFileSync(join(ctx.env.ECHO_HOME, "login"), "demo");
    } });
  configure(".first");
  await startCredentialLogin(app, "ann", kind);
  configure(".second");
  await refreshCredential(app, "ann", kind);
  configure(".unused");
  mkdirSync(join(home, ".unused"));
  writeFileSync(join(home, ".unused/login"), "independent");
  for (const dir of [".first", ".second"]) expect(readFileSync(join(home, dir, "login"), "utf8")).toBe("demo");
  await logoutCredential(app, "ann", kind);
  for (const dir of [".first", ".second"]) expect(existsSync(join(home, dir))).toBe(false);
  expect(readFileSync(join(home, ".unused/login"), "utf8")).toBe("independent");
});

it.skipIf(process.platform === "win32")("退出时重新校验账号目录，拒绝经符号链接清理", async () => {
  add();
  await startCredentialLogin(app, "ann", "sample:sso");
  await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  const dir = join(accountHome(app, "ann"), ".acme");
  rmSync(dir, { recursive: true });
  const outside = join(app.home, "outside");
  mkdirSync(join(outside, "data"), { recursive: true });
  symlinkSync(outside, dir, "dir");
  await expect(logoutCredential(app, "ann", "sample:sso")).rejects.toThrow(/符号链接/);
  expect(existsSync(join(outside, "data"))).toBe(true);
  expect(credentialHold(app, "ann", "sample:sso").state).toBe("logged-in");
});
posixIt("续签后供给，失败变过期；同种状态一天最多通知一次", async () => {
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
posixIt("登录中重复请求共享链接；取消阻止晚回调供给和秘密写入", async () => {
  let finish!: () => void, ctx!: Parameters<CredentialDef["login"]>[0];
  const provide = vi.fn(async () => {});
  add({ provide, async login(c, show) { ctx = c; show({ url: "https://auth.example.test/device" }); await new Promise<void>(r => finish = r); return { user: "ann" }; } });
  await startCredentialLogin(app, "ann", "sample:sso");
  expect(myCredentials(app, "ann").credentials[0].state).toBe("logging-in");
  await expect(removeAccount(app, "ann", "traex")).rejects.toThrow(/sample:sso/);
  expect(await startCredentialLogin(app, "ann", "sample:sso")).toEqual({ url: "https://auth.example.test/device" });
  await logoutCredential(app, "ann", "sample:sso"); finish(); await new Promise(r => setImmediate(r));
  expect(provide).not.toHaveBeenCalled();
  await expect(ctx.secret.set("late-secret")).rejects.toThrow();
  expect(credentialHold(app, "ann", "sample:sso").state).toBe("none");
});
posixIt("总览和个人清单各查询一次持有，登录中的链接与验证码只给本人", async () => {
  const kind = "sample:sso";
  add();
  add({ id: "pending", async login(_ctx, show) {
    show({ url: "https://auth.example.test/pending", code: "DEMO" });
    return new Promise(() => {});
  } });
  for (const id of ["ann", "bob"]) {
    await startCredentialLogin(app, id, kind);
    await until(() => credentialHold(app, id, kind).state === "logged-in");
  }
  setCredentialSharing(app, "ann", "sample:pending", { scope: "self" });
  await startCredentialLogin(app, "ann", "sample:pending");
  rmSync(accountHome(app, "bob"), { recursive: true });
  run(app.db, "update credential_holds set expires_at=1 where user_id='ann' and kind=?", kind);
  const queries = vi.spyOn(app.db, "prepare");
  try {
    const own = myCredentials(app, "ann");
    expect(own.credentials.map(c => c.state)).toEqual(["expired", "logging-in"]);
    expect(own.credentials[1]).toMatchObject({ url: "https://auth.example.test/pending", code: "DEMO" });
    expect(queries.mock.calls).toHaveLength(3); // Caller profile, all holds, eligible candidates.
    queries.mockClear();
    const { people } = allCredentials(app);
    expect(queries.mock.calls).toHaveLength(1);
    expect(people.map(p => p.credentials.map(c => c.state))).toEqual([["logging-in", "expired"], ["none"]]);
    for (const c of people.flatMap(p => p.credentials)) {
      expect(c).not.toHaveProperty("url");
      expect(c).not.toHaveProperty("code");
    }
  } finally {
    queries.mockRestore();
    await logoutCredential(app, "ann", "sample:pending");
  }
});

posixIt("续签不响应取消也在两分钟内结束，不堵住退出", async () => {
  add({ provide: async () => {}, refresh: () => new Promise(() => {}) });
  await startCredentialLogin(app, "ann", "sample:sso"); await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  vi.useFakeTimers(); const job = refreshCredential(app, "ann", "sample:sso");
  await vi.advanceTimersByTimeAsync(120_001); await job;
  expect(credentialHold(app, "ann", "sample:sso").state).toBe("expired");
  await logoutCredential(app, "ann", "sample:sso");
});
it.skipIf(process.platform === "win32")("安装目录只读、状态预建；本人默认清单显示 state；拒绝逃逸和符号链接", () => {
  const install = mkdtempSync(join(tmpdir(), "credential-install-"));
  undo.push(() => rmSync(install, { recursive: true, force: true }));
  add({ provides: { backends: ["traex"], commands: [{ name: "acme", install: [install, "~/.fixture-install-missing"], state: [".fixture-state"] }] } });
  const home = ensureAccountHome(app, "ann");
  expect(existsSync(join(home, ".fixture-state"))).toBe(true);
  expect(credentialInstallDirs(app)).toEqual([canonical(install)]);
  expect(myCredentials(app, "ann").credentials[0].missingInstall).toEqual(["~/.fixture-install-missing"]);
  expect(sandboxStatus(app).defaults.writable).toContain(canonical(join(homedir(), ".fixture-state")));
  expect(() => registerCredential("bad", { id: "sso", name: "坏路径", login: async () => ({ user: "a" }), provides: { commands: [{ name: "x", state: ["../secrets"] }] } }, () => ({}), app)).toThrow();
  const rel = ".fixture-link"; symlinkSync(app.home, join(home, rel), "dir");
  undo.push(registerCredential("second", { id: "sso", name: "连接", login: async () => ({ user: "a" }), provides: { commands: [{ name: "x", state: [rel] }] } }, () => ({}), app));
  expect(() => ensureAccountHome(app, "ann")).toThrow(/符号链接/);
  expect(() => registerCredential("third", { id: "sso", name: "安装", login: async () => ({ user: "a" }), provides: { commands: [{ name: "x", install: [app.home] }] } }, () => ({}), app)).toThrow();
});
it("凭据清单返回出借方式和至多 200 位可选成员，仅含 id 和显示名", async () => {
  const { startServer } = await import("../src/server/http.ts");
  add();
  app.config.credentials.lending = "confirm";
  run(app.db, "insert into users(id,name,role,created_at,kind,status,disabled_at) values " +
    "('paused','停用','member','0','person','active','1'),('waiting','待批准','member','0','person','pending',null),('bot','服务','member','0','service','active',null)");
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const headers = { authorization: "Bearer " + createApiToken(app, "ann") };
    const list = async () => (await server.inject({ url: "/api/credentials", headers })).json();
    const initial = await list();
    expect(initial).toMatchObject({ lending: "confirm", credentials: [{ supplied: false }] });
    expect(initial.candidates).toEqual([{ id: "bob", name: "成员 B" }]);
    expect((await server.inject({ url: "/api/users", headers })).statusCode).toBe(403);
    const bot = { authorization: "Bearer " + createApiToken(app, "bot") };
    const botList = (await server.inject({ url: "/api/credentials", headers: bot })).json();
    expect(botList.candidates).toEqual([]);
    expect(botList).not.toHaveProperty("lending");
    expect((await server.inject({ url: "/api/settings", headers: bot })).statusCode).toBe(403);
    run(app.db, `with recursive n(i) as (values(1) union all select i+1 from n where i<200)
      insert into users(id,name,role,created_at) select 'member-'||i,'成员 '||i,'member','0' from n`);
    app.config.credentials.lending = "off";
    const next = await list();
    expect(next.lending).toBe("off");
    expect(next.candidates).toHaveLength(200);
  } finally { await server.close(); }
});

it("观察者可读自己的凭据清单，出借策略和候选成员对其隐藏", async () => {
  const { startServer } = await import("../src/server/http.ts");
  add();
  run(app.db, "update users set role='observer' where id='ann'");
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const headers = { authorization: "Bearer " + createApiToken(app, "ann") };
    const res = await server.inject({ url: "/api/credentials", headers });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toMatchObject({ credentials: [{ kind: "sample:sso" }], candidates: [] });
    expect(list).not.toHaveProperty("lending");
    expect((await server.inject({ url: "/api/settings?section=security", headers })).statusCode).toBe(403);
  } finally { await server.close(); }
});

it("清单只显示 HOME 相对的安装声明，绝对路径只计入缺失数量", async () => {
  const { startServer } = await import("../src/server/http.ts");
  const privateDir = join(tmpdir(), "fixture-private-" + basename(app.home));
  const relative = "~/.fixture-install-missing";
  add({ provides: { commands: [{ name: "demo", install: [relative, privateDir] }] } });
  setSandboxSupportForTests({ ok: false, reason: "spawn " + privateDir + " ENOENT" });
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const headers = { authorization: "Bearer " + createApiToken(app, "ann") };
    const res = await server.inject({ url: "/api/credentials", headers });
    expect(res.json().credentials[0]).toMatchObject({ missingInstall: [relative], missingInstallCount: 2, login: false });
    expect(res.body).not.toContain(basename(privateDir));
  } finally { await server.close(); }
});

it("成员可读出借的三项设置，授予安全区域编辑权限后也只能由本人改", async () => {
  const { startServer } = await import("../src/server/http.ts");
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const headers = { authorization: "Bearer " + createApiToken(app, "ann") };
    const policy = { credentials: { lending: "confirm", confirm: { inviteAsOwner: true } }, agents: { accountsDefault: "own" } };
    expect((await server.inject({ method: "PUT", url: "/api/settings", payload: policy })).statusCode).toBe(200);
    for (const url of ["/api/settings", "/api/settings?section=security"]) {
      const res = await server.inject({ url, headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ config: policy });
    }
    expect((await server.inject({ url: "/api/settings?section=system", headers })).statusCode).toBe(403);
    for (const action of ["view", "edit"])
      run(app.db, "insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by) values('ann',?,'global','','allow','0','owner')", "settings.security." + action);
    const config = (await server.inject({ url: "/api/settings?section=security", headers })).json().config;
    expect(config).toMatchObject(policy);
    expect(config.credentials).toEqual(policy.credentials);
    for (const key of ["security", "approvals", "agents.ownSandbox", "agents.fullAccess", "token"]) expect(config).not.toHaveProperty(key);
    for (const payload of [
      { credentials: { ...policy.credentials, lending: "off" } },
      { credentials: { ...policy.credentials, confirm: { inviteAsOwner: false } } },
      { agents: { accountsDefault: "owner" } },
    ])
      expect((await server.inject({ method: "PUT", url: "/api/settings", headers, payload })).statusCode).toBe(403);
  } finally { await server.close(); }
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

posixIt("出借按自己、本人、最近使用的成员选，逐后端覆盖全局规则", async () => {
  const { withAccount } = await import("../src/agents/accounts.ts");
  const { credentialSucceeded, selectedCredential, setCredentialSharing } = await import("../src/agents/credentials.ts");
  const { accountOf } = await import("../src/agents/sandbox.ts");
  const { recordIsolation } = await import("../src/agents/runner.ts");
  const { createRun, runEvents } = await import("../src/agents/runs.ts");
  const profile = allProfiles(app.config).find(p => p.id === "traex")!;
  const choose = (id = "ann") => withAccount(app, id, profile);
  expect(choose()).toBe(profile);
  createUser(app, { id: "cora", name: "成员 C" });
  add({ check: async ctx => ({ state: "ok", user: ctx.userId }) });
  const kind = "sample:sso";
  for (const id of ["bob", "cora"]) {
    await startCredentialLogin(app, id, kind);
    await until(() => credentialHold(app, id, kind).state === "logged-in");
    setCredentialSharing(app, id, kind, { scope: "members", members: ["ann"] });
  }
  credentialSucceeded(app, choose("cora"));
  const borrowed = choose();
  expect(accountOf(borrowed)).toMatchObject({ userId: "cora", home: accountHome(app, "cora") });
  const runId = createRun(app, { kind: "ask", userId: "ann", title: "测试出借" }).id;
  recordIsolation(app, runId, "ann", borrowed);
  expect(JSON.stringify(runEvents(app, runId))).toContain("sample:sso");
  expect(one(app.db, "select actor from audit_events where action='credentials.borrow'")).toEqual({ actor: "ann" });
  await checkCredential(app, "owner", kind);
  expect(selectedCredential(choose())?.holder).toBe("owner");
  app.config.agents.accountIsolation = "require";
  expect(selectedCredential(choose())?.holder).toBe("cora");
  app.config.agents.accountIsolation = "prefer";
  app.config.agents.accountsDefault = "own";
  expect(() => choose()).toThrow(/只能用自己/);
  app.config.agents.accounts.traex = "owner";
  expect(selectedCredential(choose())?.holder).toBe("owner");
  for (const mode of ["confirm", "off"] as const) {
    app.config.credentials.lending = mode;
    expect(() => choose()).toThrow(/没有可用的登录/);
    expect(() => recordIsolation(app, runId, "ann", borrowed)).toThrow(/出借设置/);
  }
  await startCredentialLogin(app, "ann", kind);
  await until(() => credentialHold(app, "ann", kind).state === "logged-in");
  expect(selectedCredential(choose())?.holder).toBe("ann");
});

posixIt("CLI 续接成功后即使最近使用时间写入失败也只执行一次", async () => {
  const cli = await import("../src/agents/cli.ts");
  const { threadTurn } = await import("../src/agents/sessions.ts");
  const { createRun } = await import("../src/agents/runs.ts");
  const { createThread } = await import("../src/agents/threads.ts");
  const { personalSpaceId } = await import("../src/core/users.ts");
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fixture", transport: "claude-cli", command: process.execPath,
    account: { env: {}, dirs: [".fixture"], owns: [".fixture"] } })];
  add({ provides: { backends: ["fixture"] }, provide: undefined });
  await startCredentialLogin(app, "ann", "sample:sso");
  await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  const thread = createThread(app, { channel: "web", userId: "ann", spaceId: personalSpaceId("ann"), settings: { profile: "fixture" } });
  const backend = vi.spyOn(cli, "runCli").mockResolvedValue({ text: "完成", agent: "fixture", sessionId: "session-test", stopReason: "end_turn" });
  const turn = () => threadTurn({ app, run: createRun(app, { kind: "ask", userId: "ann", title: "续接", lane: thread.id }),
    signal: new AbortController().signal, event() {}, output() {} }, thread.id, [], "ann", "测试消息");
  try {
    expect((await turn()).mode).toBe("fresh");
    backend.mockClear();
    app.db.exec("create temp trigger fail_recency before update of last_used_at on credential_holds begin select raise(abort,'recency unavailable'); end");
    expect(await turn()).toMatchObject({ text: "完成", mode: "resumed" });
    expect(backend).toHaveBeenCalledTimes(1);
    expect(backend.mock.calls[0][1].resumeSessionId).toBe("session-test");
  } finally { backend.mockRestore(); }
});

posixIt("长驻会话重建换出借人时，启动、审计、最近使用和后续会话都跟随新的持有", async () => {
  const acp = await import("../src/agents/acp.ts");
  const dispatch = await import("../src/agents/dispatch.ts");
  const { releaseThreadSession, threadTurn } = await import("../src/agents/sessions.ts");
  const { createRun } = await import("../src/agents/runs.ts");
  const { createThread, getThread } = await import("../src/agents/threads.ts");
  const { personalSpaceId } = await import("../src/core/users.ts");
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fixture", transport: "acp", command: process.execPath,
    account: { env: {}, dirs: [".fixture"], owns: [".fixture"] } })];
  createUser(app, { id: "cora", name: "成员 C" });
  const kind = "sample:sso";
  add({ provides: { backends: ["fixture"] }, provide: undefined });
  for (const id of ["bob", "cora"]) {
    await startCredentialLogin(app, id, kind);
    await until(() => credentialHold(app, id, kind).state === "logged-in");
    setCredentialSharing(app, id, kind, { scope: "all" });
  }
  const thread = createThread(app, { channel: "web", userId: "ann", spaceId: personalSpaceId("ann"), settings: { profile: "fixture" } });
  const open = vi.spyOn(acp, "openAcp").mockImplementation(async profile => {
    const holder = selectedCredential(profile)!.holder;
    let turns = 0;
    return { sessionId: "session-" + holder, agent: "fixture", resumed: false, system: false, alive: () => true,
      close() {}, async discard() {}, steer: async () => "idle",
      async prompt() {
        if (holder === "bob" && ++turns === 2) {
          setCredentialSharing(app, holder, kind, { scope: "self" });
          throw new Error("会话已失效");
        }
        return { text: holder, stopReason: "end_turn", agent: "fixture" };
      },
    };
  });
  const retire = vi.spyOn(dispatch, "retireSession").mockResolvedValue();
  const turn = () => threadTurn({ app, run: createRun(app, { kind: "ask", userId: "ann", title: "测试出借", lane: thread.id }),
    signal: new AbortController().signal, event() {}, output() {} }, thread.id, [], "ann", "测试消息");
  try {
    expect(await turn()).toMatchObject({ text: "bob", mode: "fresh" });
    const firstUse = credentialHold(app, "bob", kind).lastUsedAt;
    expect(firstUse).toBeTruthy();
    expect(await turn()).toMatchObject({ text: "cora", mode: "fresh" });
    expect(credentialHold(app, "bob", kind).lastUsedAt).toBe(firstUse);
    expect(credentialHold(app, "cora", kind).lastUsedAt).toBeTruthy();
    expect(getThread(app, thread.id).agentProfile).toContain("|acct:cora");
    expect(all(app.db, "select json_extract(detail,'$.holder') as holder from audit_events where action='credentials.borrow' order by rowid"))
      .toEqual([{ holder: "bob" }, { holder: "bob" }, { holder: "cora" }]);
    expect(await turn()).toMatchObject({ text: "cora", mode: "live" });
    expect(open).toHaveBeenCalledTimes(2);
  } finally { releaseThreadSession(thread.id); open.mockRestore(); retire.mockRestore(); }
});

posixIt("网页与机器人首次入口只发一次清单，成员只能管理自己的凭据", async () => {
  const { startServer } = await import("../src/server/http.ts");
  const { createApiToken } = await import("../src/core/users.ts");
  const { createLoginLink } = await import("../src/auth/login.ts");
  const { answerFromChannel } = await import("../src/channels/common.ts");
  add({ required: false });
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const headers = { authorization: "Bearer " + createApiToken(app, "ann") };
    const base = "/api/credentials", path = base + "/sample:sso";
    await server.inject({ method: "POST", url: "/api/auth/link/" + createLoginLink(app, "ann", "cli") });
    for (const id of ["ann", "bob", "bob"]) {
      await answerFromChannel(app, { channel: "telegram", chatId: id, userId: id, text: "/whoami" });
    }
    expect(all(app.db, "select user_id from notifications where title='接入清单' and body like '%可选%' order by user_id"))
      .toEqual([{ user_id: "ann" }, { user_id: "bob" }]);
    expect((await server.inject({ method: "POST", url: path + "/login", headers, payload: { userId: "bob" } })).statusCode).toBe(200);
    await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
    expect(credentialHold(app, "bob", "sample:sso").state).toBe("none");
    expect((await server.inject({ url: base, headers })).json().credentials[0].user).toBe("ann@example.test");
    expect((await server.inject({ method: "PUT", url: path + "/sharing", headers, payload: { scope: "all" } })).statusCode).toBe(200);
    expect((await server.inject({ url: base + "/all", headers })).statusCode).toBe(403);
    expect((await server.inject({ method: "DELETE", url: base + "/ann/sample:sso", headers })).statusCode).toBe(403);
    expect((await server.inject({ url: base + "/all" })).json().people[0].credentials[0].sharing.scope).toBe("all");
    expect((await server.inject({ method: "DELETE", url: base + "/ann/sample:sso" })).statusCode).toBe(200);
    expect(credentialHold(app, "ann", "sample:sso").state).toBe("none");
    run(app.db, "insert into member_capability_overrides(user_id,capability,scope_kind,scope_id,effect,created_at,created_by,updated_at) values('ann','settings.security.edit','global','','allow','0','owner','0')");
    for (const payload of [{ agents: { accountsDefault: "own" } }, { credentials: { lending: "off" } }]) {
      expect((await server.inject({ method: "PUT", url: "/api/settings", headers, payload })).statusCode).toBe(403);
      expect((await server.inject({ method: "PUT", url: "/api/settings", payload })).statusCode).toBe(200);
    }
    const config = (await server.inject({ url: "/api/settings?section=security" })).json().config;
    expect(config.agents.accountsDefault).toBe("own");
    expect(config.credentials.lending).toBe("off");
  } finally { await server.close(); }
});

posixIt("成员的每日检查只能读取秘密，检查失败当天只提醒一次", async () => {
  add({ async check(ctx) { await ctx.secret.set("changed"); return { state: "ok" }; } });
  await startCredentialLogin(app, "ann", "sample:sso");
  await until(() => credentialHold(app, "ann", "sample:sso").state === "logged-in");
  await checkCredential(app, "ann", "sample:sso");
  await checkCredential(app, "ann", "sample:sso");
  const c = listConnections(app, "ann")[0];
  expect(connectionSecrets(app, c.id)?.accessToken).toBe("fixture-secret-ann");
  expect(all(app.db, "select id from notifications where user_id='ann' and title like '%检查失败%'")).toHaveLength(1);
});

it("同一份插件代码登记的安装和状态声明改变时需要重新确认", async () => {
  const dir = join(app.home, "plugins", "credprobe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: credprobe\nname: 示例插件\npermissions:\n  credential: true\n");
  writeFileSync(join(dir, "server.mjs"), `export default api => api.credential({
    id: "demo", name: "示例", provides: { commands: [{name: "demo", state: [process.env.FIXTURE_CREDENTIAL_STATE]}] },
    async login() { return {user:"demo"} }
  });`);
  vi.stubEnv("FIXTURE_CREDENTIAL_STATE", ".demo-a");
  try {
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    await trustPlugin(app, "credprobe", "inprocess");
    await setPluginEnabled(app, "credprobe", false);
    vi.stubEnv("FIXTURE_CREDENTIAL_STATE", ".demo-b");
    expect((await setPluginEnabled(app, "credprobe", true)).trust).toBe("changed");
    expect(myCredentials(app, "ann").credentials).toHaveLength(0);
    await trustPlugin(app, "credprobe", "inprocess");
    expect(myCredentials(app, "ann").credentials[0].kind).toBe("credprobe:demo");
  } finally { vi.unstubAllEnvs(); }
});

it.runIf(process.platform === "win32")("Windows 上登记带状态和安装目录的凭据不抛错（那里不挂载目录）", () => {
  add({ provides: { backends: ["traex"], commands: [{ name: "acme", state: [".acme/data"], install: ["~/.local/share/acme"] }] } as CredentialDef["provides"] });
  expect(one(app.db, "select kind from credential_kinds where kind = ?", "sample:sso")).toBeTruthy();
  expect(() => add({ id: "bad", provides: { backends: [], commands: [{ name: "acme", state: ["../escape"] }] } as CredentialDef["provides"] })).toThrow(/相对 HOME/);
});
