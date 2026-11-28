import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { accountEntry, accountRun } from "../src/agents/accounts.ts";
import { ownRun } from "../src/agents/own-run.ts";
import { sandboxCommand, sandboxSupport } from "../src/agents/sandbox.ts";
import { commandGateDir } from "../src/agents/command-gate.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { agentProfileSchema, loadConfig } from "../src/core/config.ts";
import { createApiToken, createUser, OWNER } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

it("本人登记、修改、清除受保护命令，持久化和沙箱垫片随设置更新", async () => {
  const app = testApp();
  const home = mkdtempSync(join(tmpdir(), "protected-home-"));
  vi.stubEnv("HOME", home);
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  const url = "/api/security/protected-commands";
  const owner = createApiToken(app, OWNER);
  createUser(app, { id: "member", name: "示例成员" });
  const member = createApiToken(app, "member");
  const profile = agentProfileSchema.parse({ id: "sample", command: "sample", transport: "acp" });
  const token = issueToolToken({ actor: "agent", userId: OWNER, commandHomeUser: OWNER, spaceId: "personal", spaces: [], tools: new Set(), runId: null,
    commandSandbox: { profile, workspace: { ro: [], rw: [] } } });
  const headers = (key: string) => ({ authorization: "Bearer " + key });
  const save = (commands: unknown[], key = owner) => server.inject({ url, method: "PUT", headers: headers(key), payload: { commands } });
  try {
    const decl = { name: "sample-cli", state: [".cache/sample-cli/login"], loginEnv: ["SAMPLE_TOKEN"] };
    for (const key of [member, token]) {
      expect([401, 403]).toContain((await server.inject({ url, headers: headers(key) })).statusCode);
      expect([401, 403]).toContain((await save([decl], key)).statusCode);
    }
    expect((await server.inject({ url, method: "PUT", payload: { commands: [decl] } })).statusCode).toBe(403);
    expect((await server.inject({ url, headers: headers(owner) })).json()).toEqual({ commands: [] });
    const guarded = commandGateDir(app, true)!;
    expect((await save([decl])).json()).toEqual({ commands: [decl] });
    expect(loadConfig(app.home).security.protectedCommands).toEqual([decl]);
    expect(existsSync(join(guarded, decl.name))).toBe(true);
    const invalid = [
      [{ ...decl, name: "../sample" }], [decl, decl], [{ ...decl, token: "value" }],
      ...[".", "../parent", "/root", "C:/private", "~/.sample", ".cache", ".npm", ".local/share/pnpm/store", ".local/share/pnpm", ".local"].map(path => [{ ...decl, state: [path] }]),
      ...["PATH", "OMEM_TOKEN", "OPENAI_API_KEY", "SAMPLE_TOKEN=value"].map(key => [{ ...decl, loginEnv: [key] }]),
    ];
    if (process.platform !== "win32") {
      mkdirSync(join(home, ".npm"));
      symlinkSync(join(home, ".npm"), join(home, "downloads"), "dir");
      invalid.push([{ ...decl, state: ["downloads"] }]);
      symlinkSync(app.home, join(home, "outside"), "dir");
      invalid.push([{ ...decl, state: ["outside"] }]);
    }
    for (const payload of invalid) expect((await save(payload)).statusCode).toBe(400);
    expect((await server.inject({ url, headers: headers(owner) })).json()).toEqual({ commands: [decl] });
    expect(loadConfig(app.home).security.protectedCommands).toEqual([decl]);
    expect(app.db.prepare("select count(*) as n from audit_events where action='command.protected.settings'").get()?.n).toBe(1);
    const approval = await server.inject({ method: "POST", url: "/api/command-gate", headers: headers(token),
      payload: { command: decl.name, args: [], cwd: home, stream: true } });
    expect(approval.json()).toMatchObject({ decision: "allow", permit: expect.any(String) });
    expect((await save([{ name: "new-cli" }])).json()).toEqual({ commands: [{ name: "new-cli", state: [], loginEnv: [] }] });
    const stale = await fetch(app.baseUrl + "/api/command-gate/stream/" + approval.json().permit, {
      method: "POST", headers: { ...headers(token), "content-type": "application/x-omem-stdin" }, body: "",
    });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain("已变化");
    expect(existsSync(join(guarded, decl.name))).toBe(false);
    expect((await save([])).json()).toEqual({ commands: [] });
    expect(existsSync(join(guarded, "new-cli"))).toBe(false);
    expect(loadConfig(app.home).security.protectedCommands).toEqual([]);
  } finally {
    revokeToolToken(token);
    await server.close();
    app.db.close();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(app.home, { recursive: true, force: true });
  }
});

const support = sandboxSupport();
it.skipIf(!support.ok)("本人和成员启动沙箱时读取最新的登记清单 " + (support.reason ?? ""), () => {
  const home = mkdtempSync(join(tmpdir(), "login-home-"));
  vi.stubEnv("HOME", home);
  const app = testApp();
  try {
    const profile = agentProfileSchema.parse({ id: "sample", command: process.execPath, transport: "acp",
      account: { owns: [".sample/backend"], dirs: [".sample/backend"] } });
    app.config.agents.profiles = [profile];
    app.config.agents.ownSandbox = { mode: "require", writable: [], hidden: [] };
    const cwd = join(app.home, "workspaces", "sample");
    mkdirSync(cwd, { recursive: true });
    const member = accountRun(app, "member", accountEntry(app, profile.id)!);
    const ownerLaunch = () => ownRun(app, profile, cwd, true);
    const memberLaunch = () => sandboxCommand({ file: process.execPath, prefix: [] }, [], {}, cwd, member);
    app.config.security.protectedCommands = [{ name: "sample-cli", state: [".sample"], loginEnv: [] }];
    for (const launch of [ownerLaunch, memberLaunch]) expect(launch).toThrow(/后端 sample.*命令 sample-cli.*重合/);
    app.config.security.protectedCommands = [];
    for (const launch of [ownerLaunch, memberLaunch]) expect(launch).not.toThrow();
  } finally {
    app.db.close();
    vi.unstubAllEnvs();
    rmSync(app.home, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
