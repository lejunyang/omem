import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { accountBlocked, accountHome, accountRun, ensureAccountHome, saveToken, stopAccountLogins, withAccount } from "../src/agents/accounts.ts";
import { outOfQuotaUntil } from "../src/agents/capacity.ts";
import { accountCatalog } from "../src/agents/catalog.ts";
import { quotaKind } from "../src/agents/quota.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { stopWorker } from "../src/agents/runs.ts";
import { accountOf, accountTag, bwrapArgs, detectSandbox, installRoot, PROBE_ARGS, sandboxEnv, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { ROUTE_RULES } from "../src/auth/routes.ts";
import { closeVault } from "../src/auth/vault.ts";
import { allProfiles, loadConfig } from "../src/core/config.ts";
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
    // Not the owner's quota: nothing read, nothing set aside.
    expect(quotaKind(codex)).toBe("codex-app-server");
    expect(quotaKind(p)).toBeUndefined();
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

  it("hides the whole feature where the sandbox cannot start", async () => {
    setSandboxSupportForTests({ ok: false, reason: "多账号只支持 Linux" });
    const r = await (await as("ann", "/api/me/agent-accounts")).json();
    expect(r).toMatchObject({ supported: false, backends: [] });
    expect((await as("ann", "/api/me/agent-accounts/codex/login", { method: "POST", body: "{}" })).status).toBe(400);
  });
});
