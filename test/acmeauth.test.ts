import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createUser } from "../src/core/users.ts";
import { closeVault } from "../src/auth/vault.ts";
import { catalogProfile } from "../src/agents/catalog.ts";
import { accountEntry, withAccount } from "../src/agents/accounts.ts";
import { setCredentialSharing, startCredentialLogin } from "../src/agents/credentials.ts";
import { accountOf, sandboxCommand, sandboxSupport, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { forgetPlugin, loadPlugins, trustPlugin } from "../src/plugins/registry.ts";
import { testApp } from "./helpers.ts";

it("示例插件一次登录供给命令行与后端，借用沙箱只挂本凭据的状态", async () => {
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
