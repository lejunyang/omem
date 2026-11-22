import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { commandGateDir, gatePaths, withGatePath } from "../src/agents/command-gate.ts";
import { credentialHold, registerCredential } from "../src/agents/credentials.ts";
import { classifyFailure, commandResource } from "../src/agents/credential-outcome.ts";
import { whoCan } from "../src/agents/credential-access.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { createRun } from "../src/agents/runs.ts";
import { COMMAND_OUTPUT_LIMIT } from "../src/core/util.ts";
import { all, run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const name = "sample-cli", kind = "fixture:login";
const command = { name, readOnly: [{ subcommand: ["show"] }],
  resource: [{ match: { subcommand: ["show"], options: { project: true } }, key: "project:{option.project}" }],
  outcomes: { denied: [{ json: "$.status", equals: 403 }], expired: [{ json: "$.code", equals: "OLD" }],
    unauthenticated: [{ json: "$.code", equals: "LOGIN" }], applyUrl: "$.links[0]" } };
it("按声明顺序识别整段或最后一行 JSON 对象，缺参数时不产生资源", () => {
  for (const output of ['{\n"status":403,\n"code":"OLD"}', 'log\n{"code":"OLD"}\n{"status":403,"code":"OLD"}\ntrailer']) {
    expect(classifyFailure(command, output).reason).toBe("denied");
  }
  expect(classifyFailure(command, "plain text").reason).toBe("failed");
  expect(commandResource(command, ["show", "--project=a"])).toBe("project:a");
  expect(commandResource(command, ["show", "--project"])).toBeUndefined();
  expect(commandResource(command, ["edit", "--project", "a"])).toBeUndefined();
});

it("通过运行令牌上报本机命令，保留输出和退出码，离线只放行未受规则保护的凭据调用", async () => {
  const app = testApp();
  const server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  const runId = createRun(app, { kind: "ask", spaceId: "personal", title: "示例", input: {} }).id;
  const token = issueToolToken({ actor: "agent", runId, spaceId: "personal", spaces: [], tools: new Set() });
  const drop = registerCredential("fixture", { id: "login", name: "示例凭据", provides: { commands: [command] }, async login() { return { user: "sample" }; } }, () => ({}), app);
  const dir = join(app.home, "commands");
  mkdirSync(dir);
  const win = process.platform === "win32";
  const file = join(dir, win ? "sample-cli.cjs" : name);
  writeFileSync(file, `#!/usr/bin/env node
const mode = process.argv.at(-1);
if (mode === 'denied') {
  process.stdout.write('a'.repeat(${COMMAND_OUTPUT_LIMIT} + 700) + '\\n', () => {
    console.error(JSON.stringify({ status: 403, code: 'OLD', links: ['https://example.test/apply'] }));
    process.exitCode = 3;
  });
} else if (mode === 'stream') {
  console.log('ready-out');
  console.error('ready-err');
  process.stdin.once('data', () => { console.log('complete'); process.stdin.destroy(); });
  setTimeout(() => process.exit(9), 3000).unref();
} else if (mode === 'expired' || mode === 'missing') {
  console.log(JSON.stringify({ code: mode === 'expired' ? 'OLD' : 'LOGIN' }));
  process.exitCode = 4;
} else console.log('sample');
`, { mode: 0o755 });
  if (win) writeFileSync(join(dir, name + ".cmd"), `@"${process.execPath}" "${file}" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  app.config.security.operationRules = [{ id: "edit", revision: 1, enabled: true, match: { kind: "command", executable: name, subcommand: ["edit"] }, action: "deny" }];
  const guarded = commandGateDir(app);
  const paths = gatePaths(app.home);
  function invoke(args: string[], baseUrl = app.baseUrl) {
    const env = withGatePath({ ...process.env, PATH: [dir, process.env.PATH].join(delimiter), OMEM_URL: baseUrl, OMEM_TOKEN: token }, guarded);
    return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [paths.script, name, ...args], { env, windowsHide: true });
      let out = "", err = "";
      function respond() {
        if (out.includes("ready-out") && err.includes("ready-err") && !child.stdin.writableEnded) child.stdin.end("continue\n");
      }
      child.stdout.setEncoding("utf8").on("data", s => { out += s; respond(); });
      child.stderr.setEncoding("utf8").on("data", s => { err += s; respond(); });
      child.once("error", reject);
      child.once("close", code => resolve({ code, out, err }));
    });
  }
  try {
    run(app.db, "insert into credential_holds(user_id,kind,state,sharing) values('owner',?,'logged-in','{}')", kind);
    const streamed = await invoke(["show", "--project", "stream"]);
    expect(streamed).toMatchObject({ code: 0, out: expect.stringContaining("complete"), err: expect.stringContaining("ready-err") });
    const result = await invoke(["show", "--project", "denied"]);
    expect(result.code).toBe(3);
    expect(result.out.trim()).toHaveLength(COMMAND_OUTPUT_LIMIT + 700);
    expect(result.err).toContain("[omem] 没有这个资源的权限");
    expect(await whoCan(app, "owner", runId, "project:denied", kind)).toMatchObject({ denied: [{ name: "本人" }], applyUrl: "https://example.test/apply" });
    expect((await invoke(["show", "--project", "ok"])).code).toBe(0);
    expect((await whoCan(app, "owner", runId, "project:ok", kind)).allowed).toHaveLength(1);
    for (const reason of ["missing", "expired"]) {
      expect((await invoke(["show", "--project", reason])).code).toBe(4);
      expect(credentialHold(app, "owner", kind)).toMatchObject({ state: "expired", notified: { expired: expect.any(String) } });
    }
    expect(all(app.db, "select id from notifications where user_id='owner' and title like '%登录过期%'")).toHaveLength(1);
    expect((await invoke(["edit"])).code).toBe(126);
    expect((await invoke(["edit"], "http://127.0.0.1:1")).code).toBe(126);
    expect((await invoke(["show"], "http://127.0.0.1:1")).code).toBe(0);
    const api = await server.inject({ method: "POST", url: "/api/credentials/outcome", payload: { command: name, args: [], code: 0, output: "" } });
    expect(api.statusCode).toBe(401);
    drop();
    app.config.security.operationRules = [];
    expect(commandGateDir(app)).toBeNull();
    expect(existsSync(join(paths.guarded, name))).toBe(false);
  } finally { drop(); revokeToolToken(token); await server.close(); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});
