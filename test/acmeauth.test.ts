import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { agentProfileSchema } from "../src/core/config.ts";
import { createUser } from "../src/core/users.ts";
import { closeVault } from "../src/auth/vault.ts";
import { catalogProfile } from "../src/agents/catalog.ts";
import { accountEntry, withAccount } from "../src/agents/accounts.ts";
import { registerCredential, setCredentialSharing, startCredentialLogin } from "../src/agents/credentials.ts";
import { accountOf, sandboxCommand, sandboxSupport, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { forgetPlugin, loadPlugins, trustPlugin } from "../src/plugins/registry.ts";
import { testApp } from "./helpers.ts";

it("示例命令按虚构项目读取权限输出 JSON 与退出码", () => {
  const app = testApp();
  const file = resolve("examples/plugins/acmeauth/bin/acme-demo");
  const show = (project: string) => spawnSync(process.execPath, [file, "show", "--project", project], {
    env: { ...process.env, HOME: app.home }, encoding: "utf8",
  });
  try {
    expect(JSON.parse(show("sample").stderr).code).toBe("AUTH_REQUIRED");
    mkdirSync(join(app.home, ".acme-demo"));
    const account = join(app.home, ".acme-demo/account.json");
    writeFileSync(account, JSON.stringify({ user: "member-a", expiresAt: Date.now() + 60_000 }));
    expect(show("sample").status).toBe(0);
    const denied = show("other");
    expect(denied.status).toBe(3);
    expect(JSON.parse(denied.stderr)).toMatchObject({ code: "DENIED", details: { links: ["https://example.test/request"] } });
    writeFileSync(account, JSON.stringify({ user: "member-a", expiresAt: 1 }));
    expect(JSON.parse(show("sample").stderr).code).toBe("EXPIRED");
  } finally { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

// 成员登录要按 POSIX 路径核对账号目录（见 credentials.test.ts 的说明），Windows 上跳过。
it.skipIf(process.platform === "win32")("示例插件一次登录供给命令行与后端，借用沙箱只挂本凭据的状态", async () => {
  const app = testApp(), support = sandboxSupport();
  setSandboxSupportForTests(support.ok ? support : { ok: true, bwrap: "bwrap" });
  try {
    const dir = join(app.home, "plugins/acmeauth");
    cpSync(resolve("examples/plugins/acmeauth"), dir, { recursive: true });
    createUser(app, { id: "ann", name: "成员 A" });
    createUser(app, { id: "bob", name: "成员 B" });
    await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
    await trustPlugin(app, "acmeauth", "inprocess");
    const kind = "acmeauth:demo";
    expect(await startCredentialLogin(app, "bob", kind)).toEqual({ done: true });
    setCredentialSharing(app, "owner", kind, { scope: "self" });
    setCredentialSharing(app, "bob", kind, { scope: "all" });
    const entry = accountEntry(app, kind)!;
    const account = accountOf(withAccount(app, "ann", catalogProfile(entry)))!;
    const bin = resolve("examples/plugins/acmeauth/bin");
    expect(JSON.parse(execFileSync(process.execPath, [join(bin, "acme-demo"), "whoami"], { env: { ...process.env, HOME: account.home }, encoding: "utf8" }))).toEqual({ user: "bob" });
    const cwd = join(app.home, "workspaces/example");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(account.home, "private.txt"), "private");
    const prompt = JSON.stringify({ id: 1, method: "session/prompt", params: { sessionId: "demo" } });
    const command = sandboxCommand({ file: process.execPath, prefix: [join(bin, "acme-demo-agent")] }, [], {}, cwd, account);
    expect(command.args).toContain(join(account.home, ".acme-demo"));
    expect(command.args.slice(command.args.indexOf(account.home) - 1, command.args.indexOf(account.home) + 1)).toEqual(["--tmpfs", account.home]);
    if (support.ok) {
      const output = execFileSync(command.file, command.args, { input: prompt + "\n", env: command.env, encoding: "utf8" });
      expect(output).toContain("当前示例账号 bob");
      const files = sandboxCommand({ file: "/bin/ls", prefix: [] }, [account.home], {}, cwd, account);
      expect(execFileSync(files.file, files.args, { env: files.env, encoding: "utf8" })).not.toContain("private.txt");
    }
  } finally {
    forgetPlugin("acmeauth"); setSandboxSupportForTests(undefined);
    closeVault(app.home); app.db.close(); rmSync(app.home, { recursive: true, force: true });
  }
});

it.skipIf(!sandboxSupport().ok)("借用沙箱可在私有目录创建临时文件和套接字，持有人的其他文件不可见", async () => {
  const app = testApp();
  const profile = agentProfileSchema.parse({ id: "echo", transport: "acp", command: process.execPath, account: {
    env: { TMPDIR: "{home}/.tmp", XDG_RUNTIME_DIR: "{home}/.run" }, dirs: [".tmp", ".run", ".login/cache"], owns: [".login"],
  } });
  app.config.agents.profiles = [profile];
  const unregister = registerCredential("example", { id: "login", name: "示例登录", provides: { backends: ["echo"] },
    async login(ctx) { return { user: ctx.userId }; },
  }, () => ({}), app);
  try {
    createUser(app, { id: "ann", name: "成员 A" });
    createUser(app, { id: "bob", name: "成员 B" });
    await startCredentialLogin(app, "bob", "example:login");
    setCredentialSharing(app, "owner", "example:login", { scope: "self" });
    setCredentialSharing(app, "bob", "example:login", { scope: "all" });
    const acct = accountOf(withAccount(app, "ann", profile))!;
    for (const dir of ["", ".tmp", ".run"]) writeFileSync(join(acct.home, dir, "private.txt"), "private");
    writeFileSync(join(acct.home, ".login/cache/session"), "shared");
    const cwd = join(app.home, "workspace");
    mkdirSync(cwd);
    const script = `
      import assert from "node:assert/strict";
      import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
      import { createServer } from "node:net";
      import { join } from "node:path";
      const { HOME, TMPDIR, XDG_RUNTIME_DIR } = process.env;
      for (const dir of [TMPDIR, XDG_RUNTIME_DIR]) assert.equal(statSync(dir).mode & 0o777, 0o700);
      for (const dir of [HOME, TMPDIR, XDG_RUNTIME_DIR]) assert.equal(existsSync(join(dir, "private.txt")), false);
      assert.equal(readFileSync(join(HOME, ".login/cache/session"), "utf8"), "shared");
      writeFileSync(join(TMPDIR, "temporary"), "ok", { flag: "wx" });
      process.chdir(XDG_RUNTIME_DIR);
      const server = createServer();
      server.listen("test.sock", () => { assert.ok(statSync("test.sock").isSocket()); server.close(); });
    `;
    const cmd = sandboxCommand({ file: process.execPath, prefix: [] }, ["--input-type=module", "-e", script], {}, cwd, acct);
    execFileSync(cmd.file, cmd.args, { env: cmd.env, timeout: 5000 });
    expect(existsSync(join(acct.home, ".tmp/temporary"))).toBe(false);
  } finally {
    unregister(); closeVault(app.home); app.db.close(); rmSync(app.home, { recursive: true, force: true });
  }
});
