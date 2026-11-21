import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { accountBlocked, accountEntry, accountFor, accountHome, accountRun, ensureAccountHome, loggedIn as loggedInNow, saveToken, stopAccountLogins, withAccount } from "../src/agents/accounts.ts";
import { accountSkillDirs } from "../src/agents/agent-skills.ts";
import { markOutOfQuota, outOfQuotaList, outOfQuotaUntil } from "../src/agents/capacity.ts";
import { probeFor, saveProbe, userProbe } from "../src/agents/probe.ts";
import { auditLog } from "../src/auth/permissions.ts";
import { listConnections, storeConnection } from "../src/auth/vault.ts";
import { accountCatalog } from "../src/agents/catalog.ts";
import { noteRateLimit, quotaAvoid, quotaKey, quotaKind, quotaOf } from "../src/agents/quota.ts";
import * as sandbox from "../src/agents/sandbox.ts";
import { prepareRun, runRole } from "../src/agents/runner.ts";
import { createRun, runEvents, stopWorker } from "../src/agents/runs.ts";
import { accountOf, accountTag, bwrapArgs, detectSandbox, installRoot, PROBE_ARGS, sandboxEnv, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { closeVault } from "../src/auth/vault.ts";
import { allProfiles, configSchema, loadConfig } from "../src/core/config.ts";
import { one as sqlOne, run as sqlRun } from "../src/core/db.ts";
import { recoverSessionCleanup, sessionCleanup } from "../src/agents/session-cleanup.ts";
import { createApiToken, createUser, OWNER, personalSpaceId } from "../src/core/users.ts";
import { boot } from "../src/main.ts";

describe("bubblewrap arguments", () => {
  const plan = {
    hide: ["/srv/omem-data", "/home/svc"],
    ro: ["/home/svc/.npm-global/lib", "/srv/omem-data/bin", "/opt/doubao/app"],
    rw: ["/srv/omem-data/accounts/ann/home", "/work/repo"],
    cwd: "/work/repo",
    command: "/home/svc/.npm-global/bin/codex-acp",
    args: ["--flag"],
  };
  const args = bwrapArgs(plan);
  const at = (...xs: string[]) => args.findIndex((_, i) => xs.every((x, k) => args[i + k] === x));

  it("starts from a read-only root in new user and PID namespaces, network shared", () => {
    expect(args.slice(0, 10)).toEqual(["--die-with-parent", "--unshare-pid", "--unshare-user", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev"]);
    expect(args).not.toContain("--unshare-net");
    expect(args).not.toContain("--unshare-all");
    expect(args.slice(-5)).toEqual(["--chdir", "/work/repo", "--", "/home/svc/.npm-global/bin/codex-acp", "--flag"]);
  });

  it("hides the data folder, the service's HOME and /tmp, then binds back what the run needs", () => {
    for (const p of ["/srv/omem-data", "/home/svc", "/tmp"]) expect(at("--tmpfs", p)).toBeGreaterThan(-1);
    expect(at("--bind", "/srv/omem-data/accounts/ann/home", "/srv/omem-data/accounts/ann/home")).toBeGreaterThan(at("--tmpfs", "/srv/omem-data"));
    expect(at("--bind", "/work/repo", "/work/repo")).toBeGreaterThan(-1);
    expect(at("--ro-bind-try", "/srv/omem-data/bin", "/srv/omem-data/bin")).toBeGreaterThan(at("--tmpfs", "/srv/omem-data"));
    expect(at("--ro-bind-try", "/home/svc/.npm-global/lib", "/home/svc/.npm-global/lib")).toBeGreaterThan(at("--tmpfs", "/home/svc"));
    expect(at("--ro-bind-try", "/opt/doubao/app", "/opt/doubao/app")).toBeGreaterThan(-1);
    // The account folder is never mounted read-only, and nobody else's is mounted at all.
    expect(args.filter((a) => a.includes("/accounts/") && !a.includes("/accounts/ann/"))).toEqual([]);
  });

  it("keeps a data folder hidden when it sits inside a read-only checkout", () => {
    const a = bwrapArgs({ hide: ["/home/svc/omem/.omem"], ro: ["/home/svc/omem"], rw: ["/home/svc/omem/.omem/accounts/ann/home"], cwd: "/x", command: "/bin/true", args: [] });
    const i = (...xs: string[]) => a.findIndex((_, k) => xs.every((x, j) => a[k + j] === x));
    expect(i("--ro-bind-try", "/home/svc/omem", "/home/svc/omem")).toBeLessThan(i("--tmpfs", "/home/svc/omem/.omem"));
    expect(i("--tmpfs", "/home/svc/omem/.omem")).toBeLessThan(i("--bind", "/home/svc/omem/.omem/accounts/ann/home", "/home/svc/omem/.omem/accounts/ann/home"));
  });

  it("lets writable win over read-only at the same path and ignores the root", () => {
    const a = bwrapArgs({ hide: ["/"], ro: ["/w", "/"], rw: ["/w"], cwd: "/w", command: "/bin/true", args: [] });
    expect(a.filter((x) => x === "--ro-bind-try")).toEqual([]);
    expect(a).toContain("--bind");
    expect(a.filter((x) => x === "--tmpfs").length).toBe(1);
  });

  it("finds the install a command lives in", () => {
    expect(installRoot("/home/svc/.npm-global/lib/node_modules/@scope/codex-acp/dist/index.js")).toBe("/home/svc/.npm-global/lib");
    expect(installRoot("/home/svc/.local/share/pnpm/global/5/.pnpm/x@1/node_modules/x/bin.js")).toBe("/home/svc/.local/share/pnpm/global/5");
    expect(installRoot("/home/svc/.local/bin/traex")).toBe("/home/svc/.local/bin");
  });
});

describe("the sandbox environment", () => {
  const env = sandboxEnv(
    { HOME: "/home/svc", PATH: "/usr/bin", LANG: "C.UTF-8", OPENAI_API_KEY: "sk-owner", ANTHROPIC_AUTH_TOKEN: "owner", CODEX_HOME: "/home/svc/.codex", XDG_CONFIG_HOME: "/home/svc/.config", SSH_AUTH_SOCK: "/run/ssh.sock", OMEM_HOME: "/srv/omem-data", GIT_EDITOR: "vi" },
    { OMEM_URL: "http://127.0.0.1:4317", OMEM_TOKEN: "run-token", PATH: "/srv/omem-data/bin:/usr/bin" },
    { home: "/srv/omem-data/accounts/ann/home", env: { CODEX_HOME: "/srv/omem-data/accounts/ann/home/.codex" } },
    ["/srv/omem-data", "/home/svc", "/tmp"],
    "/opt/node/bin",
  );
  it("sets HOME and the account's variables, keeps the run's token and drops the owner's credentials", () => {
    expect(env.HOME).toBe("/srv/omem-data/accounts/ann/home");
    expect(env.CODEX_HOME).toBe("/srv/omem-data/accounts/ann/home/.codex");
    expect(env.OMEM_TOKEN).toBe("run-token");
    expect(env.OMEM_URL).toBe("http://127.0.0.1:4317");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.GIT_EDITOR).toBe("vi");
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "OMEM_HOME"]) expect(env[k]).toBeUndefined();
    expect(env.PATH.split(":")).toEqual(["/opt/node/bin", "/srv/omem-data/bin", "/usr/bin"]);
  });
});

describe("whether this machine can sandbox", () => {
  const never = () => {
    throw new Error("should not run");
  };
  it("is off on Windows and macOS", () => {
    expect(detectSandbox("win32", {}, never)).toMatchObject({ ok: false });
    expect(detectSandbox("darwin", {}, never).reason).toContain("macOS");
  });
  it("is off on Linux without bubblewrap or when it cannot start", () => {
    expect(detectSandbox("linux", { PATH: "" }, never)).toMatchObject({ ok: false, reason: expect.stringContaining("bubblewrap") });
    const fails = detectSandbox("linux", { OMEM_BWRAP: "/opt/bwrap" }, (_f, a) => (a[0] === "--version" ? { status: 0, stdout: "bubblewrap 0.9.0\n", stderr: "" } : { status: 1, stdout: "", stderr: "setting up uid map: Permission denied" }));
    expect(fails).toMatchObject({ ok: false, bwrap: "/opt/bwrap", version: "0.9.0" });
    expect(fails.reason).toContain("命名空间");
  });
  it("is on when the probe runs", () => {
    const seen: string[][] = [];
    const ok = detectSandbox("linux", { OMEM_BWRAP: "/opt/bwrap" }, (_f, a) => {
      seen.push(a);
      return { status: 0, stdout: a[0] === "--version" ? "bubblewrap 0.9.0" : "", stderr: "" };
    });
    expect(ok).toEqual({ ok: true, bwrap: "/opt/bwrap", version: "0.9.0" });
    expect(seen).toContainEqual(PROBE_ARGS);
  });
});

describe("the catalog", () => {
  it("lists the account backends with what each needs", () => {
    const ids = accountCatalog().map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["codex", "claude", "traex", "doubao-cli"]));
    for (const e of accountCatalog()) {
      expect(e.account.owns.length).toBeGreaterThan(0);
      expect(Object.values(e.account.env).every((v) => v.startsWith("{home}"))).toBe(true);
      expect(e.account.login || e.account.tokenEnv).toBeTruthy();
    }
    expect(accountCatalog().find((e) => e.id === "codex")!.account.cli).toBe("codex");
    expect(accountCatalog().find((e) => e.id === "claude")!.account.tokenEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(accountCatalog().find((e) => e.id === "traex")!.account.dirs).toEqual(expect.arrayContaining([".run", ".tmp"]));
  });
  it("defaults members to borrowing the owner's login", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-accounts-config-"));
    expect(loadConfig(home).agents.accounts).toEqual({});
    rmSync(home, { recursive: true, force: true });
  });
});

describe("accounts of members", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-accounts-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({}));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(async () => {
    setSandboxSupportForTests(undefined);
    stopAccountLogins();
    await server.close();
    stopWorker();
    app.db.close();
    closeVault(home);
    rmSync(home, { recursive: true, force: true });
  });
  for (const id of ["ann", "bob"]) createUser(app, { name: id, id });
  const tokens = Object.fromEntries(["ann", "bob"].map((u) => [u, createApiToken(app, u, "test")]));
  const as = (user: string | null, path: string, init: RequestInit = {}) =>
    fetch(app.baseUrl + path, { ...init, headers: { ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) } });
  const codex = allProfiles(app.config).find((p) => p.id === "codex")!;
  const codexCli = allProfiles(app.config).find((p) => p.id === "codex-cli")!;
  const loggedIn = (user: string, backend: string) => {
    ensureAccountHome(app, user);
    sqlRun(app.db, "insert or replace into kv(key, value) values(?, ?)", `agent_account:${user}:${backend}`, JSON.stringify({ state: "logged-in", checkedAt: new Date().toISOString() }));
  };

  it("leaves the owner and machines without the sandbox as they were", () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    expect(withAccount(app, OWNER, codex)).toBe(codex);
    setSandboxSupportForTests({ ok: false, reason: "test" });
    app.config.agents.accounts = { codex: "own" };
    loggedIn("ann", "codex");
    expect(withAccount(app, "ann", codex)).toBe(codex);
    expect(accountBlocked(app, "ann", codex)).toBeNull();
    app.config.agents.accounts = {};
    sqlRun(app.db, "delete from kv where key like 'agent_account:%'");
  });

  it("enforces isolation across backend selection and records prefer-mode exceptions", async () => {
    const fake = { id: "local-test", name: "本机测试", command: process.execPath, transport: "acp" as const, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" }, idleTimeoutMs: 10_000 };
    const previous = { profiles: app.config.agents.profiles, fallback: app.config.agents.fallback };
    app.config.agents.profiles = [fake];
    app.config.agents.fallback = [{ profile: fake.id }];
    const launch = vi.spyOn(sandbox, "sandboxCommand");
    const start = (userId: string, profileId: string) => {
      const spaceId = personalSpaceId(userId);
      const runId = createRun(app, { kind: "code", title: "验证隔离", userId, spaceId }).id;
      return { runId, result: runRole(app, { role: "assistant", task: "回答一个词", runId, spaceId, profileId, requiredTools: [] }) };
    };
    try {
      setSandboxSupportForTests({ ok: false, reason: "测试机不支持命名空间" });
      app.config.agents.accountIsolation = "require";
      await expect(start("bob", fake.id).result).rejects.toThrow(/不能隔离成员的运行.*命名空间/);
      expect((await start(OWNER, fake.id).result).profileId).toBe(fake.id);
      expect(launch).not.toHaveBeenCalled();
      app.config.agents.accountIsolation = "prefer";
      const preferred = start("bob", fake.id);
      await preferred.result;
      expect(JSON.stringify(runEvents(app, preferred.runId))).toContain("这次运行没有隔离：测试机不支持命名空间");
      expect((await (await as(null, "/api/agent-accounts")).json()).isolation).toMatchObject({ mode: "prefer", ok: false, reason: "测试机不支持命名空间" });

      // This test replaces the filesystem launcher; the network namespace has its own integration test.
      app.config.security.egress.mode = "off";
      setSandboxSupportForTests({ ok: true, bwrap: "test-bwrap" });
      app.config.agents.accountIsolation = "require";
      launch.mockImplementation((cmd, args, env, _cwd, account) => ({
        file: cmd.file, args: [...cmd.prefix, ...args], env: { ...env, HOME: account.home } as Record<string, string>,
      }));
      // Bob cannot borrow the owner's Codex login in strict mode. The configured local ACP can run in his HOME.
      expect((await start("bob", "codex").result).profileId).toBe(fake.id);
      expect(launch.mock.calls.at(-1)?.[4]).toMatchObject({ userId: "bob", home: accountHome(app, "bob") });
      launch.mockImplementation(() => ({
        file: process.execPath, args: ["-e", "console.error('bwrap: mount failed'); process.exit(1)"], env: {},
      }));
      await expect(start("bob", fake.id).result).rejects.toThrow(/不能隔离成员的运行.*mount failed/);
      expect(accountBlocked(app, "bob", { ...fake, transport: "doubao" })).toContain("云端");
      expect(accountBlocked(app, "bob", { ...fake, peer: { id: "device", agent: "other" } })).toContain("设备代跑");
    } finally {
      app.config.security.egress.mode = "strict-only";
      launch.mockRestore();
      Object.assign(app.config.agents, previous, { accountIsolation: "prefer" });
      setSandboxSupportForTests(undefined);
    }
  });

  it("borrows the owner's login, or fails, for a member not logged in", () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    expect(accountOf(withAccount(app, "ann", codex))).toBeUndefined();
    app.config.agents.accounts = { codex: "own" };
    expect(() => withAccount(app, "ann", codex)).toThrow(/只能用自己的账号/);
    // The CLI fallback is the same account (source codex).
    expect(accountBlocked(app, "ann", codexCli)).toMatch(/我的 AI 账号/);
    app.config.agents.accounts = {};
  });

  it("runs a logged-in member in their own account folder", () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    app.config.agents.accounts = { codex: "own" };
    loggedIn("ann", "codex");
    const p = withAccount(app, "ann", codex);
    const a = accountOf(p)!;
    expect(a.userId).toBe("ann");
    expect(a.home).toBe(accountHome(app, "ann"));
    expect(a.env.CODEX_HOME).toBe(`${accountHome(app, "ann")}/.codex`);
    expect(a.hide).toContain(app.home);
    expect(accountTag(p)).toBe("acct:ann");
    // Their own quota, kept apart from the owner's.
    expect(quotaKind(codex)).toBe("codex-app-server");
    expect(quotaKind(p)).toBe("codex-app-server");
    expect(quotaKey(p)).toBe("codex@acct:ann");
    expect(quotaKey(codex)).toBe("codex");
    expect(outOfQuotaUntil(app, p)).toBeNull();
    // Bob is not logged in: own policy still blocks him.
    expect(() => withAccount(app, "bob", codex)).toThrow(/只能用自己的账号/);
    // prepareRun picks it for the member's run.
    const prep = prepareRun(app, { actor: { role: "assistant" }, spaceId: personalSpaceId("ann"), runId: null, userId: "ann", profileId: "codex" });
    revokeToolToken(prep.token);
    expect(accountOf(prep.profile)?.userId).toBe("ann");
    const own = prepareRun(app, { actor: { role: "assistant" }, spaceId: "personal", runId: null, userId: OWNER, profileId: "codex" });
    revokeToolToken(own.token);
    expect(accountOf(own.profile)).toBeUndefined();
    app.config.agents.accounts = {};
  });

  it("records a member's sessions under their account, and drops them once the account is gone", async () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    loggedIn("ann", "codex");
    const p = withAccount(app, "ann", codex);
    const c = await sessionCleanup(app, p, { cwd: home, persistSession: true }, () => {});
    c.created("sess-ann-1");
    const owner = await sessionCleanup(app, codex, { cwd: home, persistSession: true }, () => {});
    owner.created("sess-owner-1");
    const key = (id: string) => (sqlOne(app.db, "select backend_key k from session_cleanup where session_id = ?", id) as { k: string }).k;
    expect(key("sess-ann-1")).toMatch(/@acct:ann$/);
    expect(key("sess-owner-1")).not.toContain("@acct:");
    rmSync(join(home, "accounts", "ann"), { recursive: true, force: true });
    sqlRun(app.db, "update session_cleanup set ready = 1, retry_at = '2000-01-01' where session_id = 'sess-ann-1'");
    await recoverSessionCleanup(app, () => {});
    expect(sqlOne(app.db, "select 1 from session_cleanup where session_id = 'sess-ann-1'")).toBeUndefined();
    sqlRun(app.db, "delete from session_cleanup");
    sqlRun(app.db, "delete from kv where key like 'agent_account:%'");
  });

  it("keeps a pasted token in the vault, not in the config or the account folder", async () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap-missing" });
    const claude = accountCatalog().find((e) => e.id === "claude")!;
    await saveToken(app, "bob", "claude", "tok-example-1234567890");
    expect(accountRun(app, "bob", claude).env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-example-1234567890");
    expect(readFileSync(join(home, "config.json"), "utf8")).not.toContain("tok-example");
    expect(existsSync(join(accountHome(app, "bob"), ".claude"))).toBe(true);
  });

  it("lets each member see and remove only their own accounts", async () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    loggedIn("ann", "codex");
    loggedIn("bob", "codex");
    const mine = await (await as("ann", "/api/me/agent-accounts")).json();
    expect(mine).toMatchObject({ supported: true, owner: false });
    expect(mine.backends.find((b: { id: string }) => b.id === "codex").state).toBe("logged-in");
    expect(JSON.stringify(mine)).not.toContain("bob");
    expect((await as("ann", "/api/agent-accounts")).status).toBe(403);
    expect((await as("ann", "/api/agent-accounts/bob/codex", { method: "DELETE" })).status).toBe(403);
    expect((await as("ann", "/api/me/agent-accounts/codex", { method: "DELETE" })).status).toBe(200);
    expect(existsSync(accountHome(app, "ann"))).toBe(false);
    expect(existsSync(accountHome(app, "bob"))).toBe(true);
    // The owner's overview: who logged in to what, no tokens.
    const all = await (await as(null, "/api/agent-accounts")).json();
    const bob = all.people.find((p: { userId: string }) => p.userId === "bob");
    expect(bob.backends.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining(["codex", "claude"]));
    expect(JSON.stringify(all)).not.toContain("tok-example");
  });

  it("only the owner can save sandbox settings and explicitly confirm unrestricted backends", async () => {
    const path = "/api/security/sandbox";
    const read = await (await as(null, path)).json();
    expect(read).toMatchObject({ mode: "off", fullAccess: "per-role", defaults: { hidden: [home] } });
    const put = (patch: Record<string, unknown>, user: string | null = null) => as(user, path, { method: "PUT",
      body: JSON.stringify({ mode: "prefer", writable: [], hidden: [], fullAccess: "all", ...patch }) });
    expect((await as("ann", path)).status).toBe(403);
    expect((await put({ confirmAll: true }, "ann")).status).toBe(403);
    expect((await put({})).status).toBe(400);
    expect((await put({ writable: [home], confirmAll: true })).status).toBe(400);
    expect((await (await put({ confirmAll: true })).json()).warning).toContain("没进沙箱");
    expect(loadConfig(home).agents.fullAccess).toBe("all");
    expect(sqlOne(app.db, "select 1 from audit_events where action='sandbox.settings'")).toBeTruthy();
    await put({ mode: "off", fullAccess: "per-role" });
  });

  it("keeps the rule per backend to the owner", async () => {
    expect(ROUTE_RULES["PUT /api/agent-accounts/:backend/policy"]).toBe("owner");
    expect(ROUTE_RULES["GET /api/me/agent-accounts"]).toBe("self");
    const body = JSON.stringify({ policy: "own" });
    expect((await as("ann", "/api/agent-accounts/codex/policy", { method: "PUT", body })).status).toBe(403);
    expect((await as(null, "/api/agent-accounts/codex/policy", { method: "PUT", body })).status).toBe(200);
    expect(app.config.agents.accounts.codex).toBe("own");
    expect(loadConfig(home).agents.accounts.codex).toBe("own");
    expect((await as(null, "/api/agent-accounts/nothing/policy", { method: "PUT", body })).status).toBe(404);
    // The owner keeps the machine's logins: nothing to log in to here.
    expect((await as(null, "/api/me/agent-accounts/codex/login", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("keeps a member's quota and spent marks under their account, apart from the owner's", () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    loggedIn("ann", "claude");
    const claude = allProfiles(app.config).find((p) => p.id === "claude")!;
    const mine = withAccount(app, "ann", claude);
    expect(quotaKey(mine)).toBe("claude@acct:ann");
    noteRateLimit(app, mine, { type: "rate-limit", window: "five_hour", usedPercent: 97, resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(quotaOf(app, mine)?.windows[0]).toMatchObject({ name: "5h", usedPercent: 97 });
    expect(quotaOf(app, claude)).toBeNull();
    expect(quotaAvoid(app, mine)).toMatch(/5h 已用 97%/);
    expect(quotaAvoid(app, claude)).toBeNull();
    // Spent: set aside for her runs only, not listed among the owner's.
    markOutOfQuota(app, mine, "You've hit your usage limit");
    expect(outOfQuotaUntil(app, mine)).toBeTruthy();
    expect(outOfQuotaUntil(app, claude)).toBeNull();
    expect(outOfQuotaList(app)).toEqual([]);
    // The member's view carries her own numbers; the owner's records stay as they are.
    expect(accountFor(app, "ann", claude)).toMatchObject({ ownAccount: { userId: "ann" } });
    expect(accountFor(app, "bob", claude)).toBe(claude);
    sqlRun(app.db, "delete from kv where key in ('agent_quota', 'agent_quota_exhausted')");
    sqlRun(app.db, "delete from kv where key like 'agent_account:%'");
  });

  it("caches probes per account and offers a logged-in member their own models", () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    const probe = (models: string[]) => ({ at: new Date().toISOString(), agent: "codex", models, efforts: [] });
    saveProbe(app, "codex", probe(["owner-model"]));
    saveProbe(app, "codex", probe(["ann-model"]), "ann");
    expect(userProbe(app, "ann", "codex")?.models).toEqual(["owner-model"]);
    loggedIn("ann", "codex");
    expect(userProbe(app, "ann", "codex")?.models).toEqual(["ann-model"]);
    expect(userProbe(app, "bob", "codex")?.models).toEqual(["owner-model"]);
    expect(userProbe(app, OWNER, "codex")?.models).toEqual(["owner-model"]);
    expect(probeFor(app, withAccount(app, "ann", codex))?.models).toEqual(["ann-model"]);
    expect(probeFor(app, codex)?.models).toEqual(["owner-model"]);
    sqlRun(app.db, "delete from kv where key like 'probe:%' or key like 'agent_account:%'");
  });

  it("writes omem's skill entries into a new account folder while the takeover is on", () => {
    const codexEntry = accountCatalog().find((e) => e.id === "codex")!;
    app.config.agentSkills.takeOver = false;
    createUser(app, { name: "carl", id: "carl" });
    ensureAccountHome(app, "carl", codexEntry);
    expect(existsSync(join(accountHome(app, "carl"), ".agents", "skills", "omem"))).toBe(false);
    rmSync(join(home, "accounts", "carl"), { recursive: true, force: true });
    app.config.agentSkills.takeOver = true;
    ensureAccountHome(app, "carl", codexEntry);
    expect(existsSync(join(accountHome(app, "carl"), ".agents", "skills", "omem", "SKILL.md"))).toBe(true);
    // Its skill folders are its own, never the service's HOME.
    expect(accountSkillDirs(app, accountHome(app, "carl")).every((d) => d.path.startsWith(accountHome(app, "carl")))).toBe(true);
    app.config.agentSkills.takeOver = false;
    rmSync(join(home, "accounts", "carl"), { recursive: true, force: true });
  });

  it("lets the owner's own profiles carry an account, checked on save", () => {
    const base = { id: "mycli", name: "我的命令行", transport: "acp", command: "mycli" };
    const ok = configSchema.parse({ agents: { profiles: [{ ...base, account: { env: { MYCLI_HOME: "{home}/.mycli", MODE: "user" }, dirs: [".mycli"], owns: [".mycli"], mounts: ["/opt/mycli"], login: { args: ["login"], url: "https://\\S+" } } }] } });
    expect(accountCatalog(ok.agents.profiles).find((e) => e.id === "mycli")?.account.env.MYCLI_HOME).toBe("{home}/.mycli");
    const bad = (account: unknown) => configSchema.safeParse({ agents: { profiles: [{ ...base, account }] } }).success;
    const good = { env: {}, owns: [".mycli"] };
    expect(bad(good)).toBe(true);
    expect(bad({ ...good, extra: 1 })).toBe(false);
    expect(bad({ ...good, env: { X: "/opt/x" } })).toBe(false);
    expect(bad({ ...good, env: { X: "~/x" } })).toBe(false);
    expect(bad({ ...good, env: { X: "${HOME}/x" } })).toBe(false);
    expect(bad({ ...good, env: { X: "{home}/../x" } })).toBe(false);
    expect(bad({ ...good, env: { X: "a{home}" } })).toBe(false);
    expect(bad({ ...good, login: { args: ["--dir={home}"], url: "https://\\S+" } })).toBe(false);
    expect(bad({ ...good, owns: ["../x"] })).toBe(false);
    expect(bad({ ...good, owns: [] })).toBe(false);
    expect(bad({ ...good, login: { args: [], url: "(" } })).toBe(false);
    // Saved through the settings it is refused the same way.
    app.config.agents.profiles = ok.agents.profiles;
    expect(accountEntry(app, "mycli")?.name).toBe("我的命令行");
    app.config.agents.profiles = [];
  });

  it("moves a member's run to another backend under own-or-other, or fails when there is none", () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap" });
    app.config.agents.accounts = { codex: "own-or-other", claude: "own" };
    const alt = { id: "alt", name: "备用", transport: "acp" as const, command: process.execPath, args: [], env: {}, idleTimeoutMs: 600_000 };
    const claude = allProfiles(app.config).find((p) => p.id === "claude")!;
    // Claude is "own" and Ann is not logged in to it: skipped; alt has no accounts: she may borrow it.
    expect(withAccount(app, "ann", codex, () => [claude, alt]).id).toBe("alt");
    expect(() => withAccount(app, "ann", codex, () => [claude])).toThrow(/也没有别的/);
    expect(accountBlocked(app, "ann", codexCli)).toMatch(/换别的后端/);
    // Logged in to Claude: it is hers and comes first in that order (a profile of the same source that is installed here).
    loggedIn("ann", "claude");
    const claudeHere = { ...alt, id: "claude-here", source: "claude" };
    const picked = withAccount(app, "ann", codex, () => [claudeHere, alt]);
    expect(picked.id).toBe("claude-here");
    expect(accountOf(picked)?.userId).toBe("ann");
    // prepareRun follows the run's fallback order.
    sqlRun(app.db, "delete from kv where key like 'agent_account:%'");
    app.config.agents.profiles = [alt];
    app.config.agents.fallback = [{ profile: "alt" }];
    const prep = prepareRun(app, { actor: { role: "assistant" }, spaceId: personalSpaceId("ann"), runId: null, userId: "ann", profileId: "codex" });
    revokeToolToken(prep.token);
    expect(prep.profile.id).toBe("alt");
    app.config.agents.profiles = [];
    app.config.agents.fallback = [];
    app.config.agents.accounts = {};
  });

  it("takes every login of a disabled member away, and writes it down", async () => {
    setSandboxSupportForTests({ ok: true, bwrap: "/usr/bin/bwrap-missing" });
    createUser(app, { name: "dora", id: "dora" });
    loggedIn("dora", "codex");
    storeConnection(app, { userId: "dora", provider: "agent:claude", accountId: "claude", accountName: "Claude Code", scopes: [], accessToken: "tok-dora-1234567890" });
    storeConnection(app, { userId: "dora", provider: "agent:traex:company:sso", accountId: "traex", accountName: "TraeX", scopes: [], accessToken: "refresh-dora" });
    sqlRun(app.db, "insert or replace into kv(key, value) values(?, ?)", "agent_account:dora:traex", JSON.stringify({ state: "logged-in", method: "company:sso" }));
    const r = await as(null, "/api/users/dora", { method: "PATCH", body: JSON.stringify({ disabled: true }) });
    expect(r.status).toBe(200);
    expect(existsSync(join(home, "accounts", "dora"))).toBe(false);
    expect(listConnections(app, "dora").filter((c) => c.provider.startsWith("agent:"))).toEqual([]);
    expect(sqlOne(app.db, "select 1 from kv where key like 'agent_account:dora:%'")).toBeUndefined();
    const ev = auditLog(app).find((a) => a.action === "agent-accounts.remove-all" && a.target === "dora");
    expect(ev?.detail.backends).toEqual(expect.arrayContaining(["codex", "claude", "traex"]));
    // Enabled again: nothing to come back to, they log in again.
    expect((await as(null, "/api/users/dora", { method: "PATCH", body: JSON.stringify({ disabled: false }) })).status).toBe(200);
    expect(loggedInNow(app, "dora", "codex")).toBe(false);
  });

  it("offers the owner three rules per backend", async () => {
    const body = JSON.stringify({ policy: "own-or-other" });
    expect((await as(null, "/api/agent-accounts/codex/policy", { method: "PUT", body })).status).toBe(200);
    expect(loadConfig(home).agents.accounts.codex).toBe("own-or-other");
    expect((await as(null, "/api/agent-accounts/codex/policy", { method: "PUT", body: JSON.stringify({ policy: "other" }) })).status).toBe(400);
    expect(ROUTE_RULES["POST /api/me/agent-accounts/:backend/quota"]).toBe("self");
    app.config.agents.accounts = {};
  });

  it("hides the whole feature where the sandbox cannot start", async () => {
    setSandboxSupportForTests({ ok: false, reason: "多账号只支持 Linux" });
    const r = await (await as("ann", "/api/me/agent-accounts")).json();
    expect(r).toMatchObject({ supported: false, backends: [] });
    expect((await as("ann", "/api/me/agent-accounts/codex/login", { method: "POST", body: "{}" })).status).toBe(400);
  });
});
