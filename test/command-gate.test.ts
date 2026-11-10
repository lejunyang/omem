import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { GATE_EXIT, matchCommandRule, syncCommandGate } from "../src/agents/command-gate.ts";
import { agentToolEnv } from "../src/agents/tool-cli.ts";
import { issueToolToken } from "../src/agents/tools.ts";
import { createThread } from "../src/agents/threads.ts";
import type { App } from "../src/core/app.ts";
import { commandRuleSchema, type CommandRule } from "../src/core/config.ts";
import { all, run } from "../src/core/db.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/**
 * Command rules (src/agents/command-gate.ts) end to end: a fake `acmectl`, the generated wrappers in
 * front of PATH, and a real omem server the wrapper asks. Windows differences are noted per case.
 */
const win = process.platform === "win32";
const rule = (r: Partial<CommandRule> & { command: string }) => commandRuleSchema.parse(r);

/** Git Bash on Windows (never WSL's bash.exe in System32); plain bash elsewhere. */
function findBash(): string | null {
  if (!win) return spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0 ? "bash" : null;
  for (const p of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) if (existsSync(p)) return p;
  return null;
}
function findPython(): string | null {
  for (const p of win ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(p, ["-c", "import subprocess"], { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return p;
  }
  return null;
}

let app: App;
let server: FastifyInstance;
let realDir: string;
let runId: string;
let token: string;
let conversationId: string;

const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
function envWith(extra: Record<string, string | undefined> = {}) {
  const guarded = syncCommandGate(app.home, app.config.security.commandRules);
  const env: Record<string, string | undefined> = { ...process.env, OMEM_URL: app.baseUrl, OMEM_TOKEN: token, ...extra };
  env[pathKey] = [guarded, realDir, process.env[pathKey]].filter(Boolean).join(delimiter);
  return env;
}

function exec(cmd: string, args: string[], env: Record<string, string | undefined>, opts: { shell?: boolean } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    // Never spawnSync: the omem server answering the wrapper runs in this same process.
    const p = spawn(cmd, args, { env: env as NodeJS.ProcessEnv, shell: opts.shell ?? false, windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    p.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    p.on("error", (e) => resolve({ code: -1, out, err: err + e.message }));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
/** `acmectl …` as a shell would find it: directly through PATH on Unix, through cmd.exe on Windows (.cmd needs a shell). */
const acmectl = (args: string[], env = envWith()) => (win ? exec(`acmectl ${args.join(" ")}`, [], env, { shell: true }) : exec("acmectl", args, env));

async function pendingAsk(command: string, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const a = listAsks(app, { status: "pending" }).find((x) => x.handler === "command-gate" && x.question.includes(command));
    if (a) return a;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("没有等到审批");
}

beforeAll(async () => {
  app = testApp();
  realDir = mkdtempSync(join(tmpdir(), "omem-acme-"));
  if (win) writeFileSync(join(realDir, "acmectl.cmd"), "@echo REAL %*\r\n");
  else {
    writeFileSync(join(realDir, "acmectl"), '#!/bin/sh\necho REAL "$@"\n');
    chmodSync(join(realDir, "acmectl"), 0o755);
  }
  server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
  conversationId = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" }).id;
  runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", runId, "ask", "personal", "running", "测试运行", JSON.stringify({ conversationId }), new Date().toISOString());
  token = issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" });
});
afterAll(async () => {
  await server?.close();
});

describe("command rules", () => {
  it("matches the first rule in order; allow opens a hole in a wider rule", () => {
    const rules = [rule({ command: "acmectl", args: "^status\\b", action: "allow" }), rule({ command: "acmectl", action: "approve" })];
    expect(matchCommandRule(rules, "acmectl", ["status"])?.rule.action).toBe("allow");
    expect(matchCommandRule(rules, "acmectl", ["deploy", "prod"])?.index).toBe(1);
    expect(matchCommandRule(rules, "other", [])).toBeNull();
    expect(() => rule({ command: "bin/acmectl" })).toThrow();
    expect(() => rule({ command: "acmectl", args: "(" })).toThrow();
    expect(() => rule({ command: "acmectl", approver: "someone" })).toThrow();
  });

  it("with no rules there are no wrappers and PATH is left alone", () => {
    const home = mkdtempSync(join(tmpdir(), "omem-gate-"));
    expect(syncCommandGate(home, [rule({ command: "acmectl" })])).toBeTruthy();
    expect(existsSync(join(home, "bin", "guarded", "acmectl"))).toBe(true);
    expect(syncCommandGate(home, [])).toBeNull();
    expect(existsSync(join(home, "bin", "guarded"))).toBe(false);
    const env = agentToolEnv(home, "http://127.0.0.1:1", "ot_x", null);
    expect(env.OMEM_COMMAND_GATE).toBeUndefined();
    expect((env[pathKey] ?? "").split(delimiter)).not.toContain(join(home, "bin", "guarded"));
    const guarded = agentToolEnv(home, "http://127.0.0.1:1", "ot_x", join(home, "bin", "guarded"));
    expect(guarded[pathKey]!.split(delimiter)[0]).toBe(join(home, "bin", "guarded"));
  });

  it("a call no rule matches runs the real command", async () => {
    app.config.security.commandRules = [rule({ command: "acmectl", args: "^deploy" })];
    const r = await acmectl(["status"]);
    expect(r.err).toBe("");
    expect(r.out).toContain("REAL status");
    expect(r.code).toBe(0);
  });

  it("approved while it waits: runs; refused: exit 126", async () => {
    app.config.security.commandRules = [rule({ command: "acmectl", args: "^deploy", waitSeconds: 30, note: "改线上配置" })];
    const ok = acmectl(["deploy", "prod"]);
    const a = await pendingAsk("acmectl deploy prod");
    expect(a.question).toContain("acmectl deploy prod");
    expect(a.question).toContain("改线上配置");
    await answerAsk(app, a.id, { approved: true, by: "owner" });
    const r = await ok;
    expect(r.out).toContain("REAL deploy prod");
    expect(r.code).toBe(0);

    const no = acmectl(["deploy", "staging"]);
    const b = await pendingAsk("acmectl deploy staging");
    await answerAsk(app, b.id, { approved: false, text: "先等发布窗口", by: "owner" });
    const d = await no;
    expect(d.code).toBe(GATE_EXIT);
    expect(d.err).toContain("拒绝");
    expect(d.err).toContain("先等发布窗口");
    expect(d.out).not.toContain("REAL");
    const actions = all<{ action: string }>(app.db, "select action from audit_events where action like 'command.%'").map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["command.ask", "command.approve", "command.allow", "command.reject"]));
    expect(all(app.db, "select 1 from run_events where run_id = ? and type = 'status' and json_extract(data, '$.commandGate.command') = 'acmectl'", runId).length).toBeGreaterThan(0);
  }, 60_000);

  it("not approved in time: held with the message; a later approval wakes the run; once means once", async () => {
    app.config.security.commandRules = [rule({ command: "acmectl", args: "^migrate", waitSeconds: 5, reuse: "once" })];
    const r = await acmectl(["migrate", "--all"]);
    expect(r.code).toBe(GATE_EXIT);
    expect(r.err).toContain("需要 本人 批准");
    expect(r.err).toContain("不要改用其他路径或方式绕过");
    const a = await pendingAsk("acmectl migrate --all");
    await answerAsk(app, a.id, { approved: true, by: "owner" });
    // Woken: a note in its conversation and a turn queued for it.
    const woke = all<{ text: string }>(app.db, "select text from messages where conversation_id = ? and json_extract(meta, '$.wake') is not null", conversationId);
    expect(woke.some((m) => m.text.includes("已批准命令") && m.text.includes("acmectl migrate --all"))).toBe(true);
    expect(all(app.db, "select 1 from runs where kind = 'ask' and json_extract(input, '$.conversationId') = ? and json_extract(input, '$.wake') = 1", conversationId).length).toBe(1);
    // The same command again (same conversation): through, once.
    const again = await acmectl(["migrate", "--all"]);
    expect(again.out).toContain("REAL migrate --all");
    const third = await acmectl(["migrate", "--all"]);
    expect(third.code).toBe(GATE_EXIT);
    expect(third.err).toContain("需要 本人 批准");
  }, 60_000);

  it("window reuse lets the same command through until it expires", async () => {
    app.config.security.commandRules = [rule({ command: "acmectl", args: "^rotate", waitSeconds: 30, reuse: "window" })];
    const first = acmectl(["rotate"]);
    await answerAsk(app, (await pendingAsk("acmectl rotate")).id, { approved: true, by: "owner" });
    expect((await first).out).toContain("REAL rotate");
    expect((await acmectl(["rotate"])).out).toContain("REAL rotate");
    expect((await acmectl(["rotate"])).out).toContain("REAL rotate");
  }, 60_000);

  describe("calls from scripts are held the same way", () => {
    const bash = findBash();
    const python = findPython();
    const denyDrop = () => (app.config.security.commandRules = [rule({ command: "acmectl", args: "^drop", action: "deny", note: "删库" })]);

    it.skipIf(!bash)("bash -c", async () => {
      denyDrop();
      const held = await exec(bash!, ["-c", "acmectl drop users"], envWith());
      expect(held.code).toBe(GATE_EXIT);
      expect(held.err).toContain("不允许");
      const through = await exec(bash!, ["-c", "acmectl status"], envWith());
      expect(through.out).toContain("REAL status");
    }, 30_000);

    // On Windows Node finds only .exe / .com without a shell, so a .cmd command is run with shell: true there.
    it("node child_process.execFileSync", async () => {
      denyDrop();
      const code = win
        ? "try{require('child_process').execFileSync('acmectl drop users',{stdio:'inherit',shell:true})}catch(e){process.exit(e.status)}"
        : "try{require('child_process').execFileSync('acmectl',['drop','users'],{stdio:'inherit'})}catch(e){process.exit(e.status)}";
      const held = await exec(process.execPath, ["-e", code], envWith());
      expect(held.code).toBe(GATE_EXIT);
      expect(held.err).toContain("删库");
    }, 30_000);

    // Same on Windows: CreateProcess looks for .exe only, so the list form needs shell=True for a .cmd.
    it.skipIf(!python)("python subprocess.run", async () => {
      denyDrop();
      const code = win ? "import subprocess,sys; sys.exit(subprocess.run('acmectl drop users', shell=True).returncode)" : "import subprocess,sys; sys.exit(subprocess.run(['acmectl','drop','users']).returncode)";
      const held = await exec(python!, ["-c", code], envWith());
      expect(held.code).toBe(GATE_EXIT);
    }, 30_000);
  });

  it("a rule's script runs with the wrappers in front of PATH and a token of its own", async () => {
    app.config.security.commandRules = [rule({ command: "acmectl", args: "^drop", action: "deny" })];
    const { createRun } = await import("../src/agents/runs.ts");
    const { runScript } = await import("../src/rules/script.ts");
    // Scripts run as .mjs.
    const code = `import { execFileSync } from "node:child_process";\nexecFileSync(${win ? `"acmectl drop users", { stdio: "inherit", shell: true }` : `"acmectl", ["drop", "users"], { stdio: "inherit" }`});`;
    const input = { ruleId: "rule_x", ruleName: "测试", runtime: "node", code, timeoutSec: 30, event: { type: "schedule" }, approval: { by: "none", status: "none" } };
    const r = createRun(app, { kind: "rule-script", spaceId: "personal", title: "t", input });
    // The script's own PATH does not have the fake command's directory: put it there for this test.
    const before = process.env[pathKey];
    process.env[pathKey] = [realDir, before].join(delimiter);
    try {
      await expect(runScript(app, r)).rejects.toThrow(/退出码/);
    } finally {
      process.env[pathKey] = before;
    }
    expect(all(app.db, "select 1 from audit_events where action = 'command.deny' and json_extract(detail, '$.runId') = ?", r.id).length).toBe(1);
  }, 30_000);

  it("boundary: calling the real command by its absolute path is not intercepted", async () => {
    app.config.security.commandRules = [rule({ command: "acmectl", args: "^drop", action: "deny" })];
    const real = join(realDir, win ? "acmectl.cmd" : "acmectl");
    const r = win ? await exec(`"${real}" drop users`, [], envWith(), { shell: true }) : await exec(real, ["drop", "users"], envWith());
    expect(r.out).toContain("REAL drop users");
  });

  it("fails closed without a token or when omem cannot be reached", async () => {
    app.config.security.commandRules = [rule({ command: "acmectl", args: "^deploy" })];
    const noToken = await acmectl(["status"], envWith({ OMEM_TOKEN: undefined }));
    expect(noToken.code).toBe(GATE_EXIT);
    expect(noToken.err).toContain("OMEM_TOKEN");
    expect(noToken.out).not.toContain("REAL");
    const badToken = await acmectl(["status"], envWith({ OMEM_TOKEN: "ot_nope" }));
    expect(badToken.code).toBe(GATE_EXIT);
    const down = await acmectl(["status"], envWith({ OMEM_URL: "http://127.0.0.1:1" }));
    expect(down.code).toBe(GATE_EXIT);
    expect(down.err).toContain("连不上 omem");
  });

  it("only the owner reads or changes the rules; the general settings route leaves them alone", async () => {
    const put = await server.inject({ method: "PUT", url: "/api/security/command-rules", payload: { rules: [{ command: "acmectl", args: "^deploy", approver: "owner" }] } });
    expect(put.statusCode).toBe(200);
    expect(app.config.security.commandRules).toHaveLength(1);
    expect((await server.inject({ method: "PUT", url: "/api/security/command-rules", payload: { rules: [{ command: "acmectl", args: "(" }] } })).statusCode).toBe(400);
    await server.inject({ method: "PUT", url: "/api/settings", payload: { security: { commandRules: [] } } });
    expect(app.config.security.commandRules).toHaveLength(1);
    // The gate route is not for other machines or other credentials.
    const remote = await server.inject({ method: "POST", url: "/api/command-gate", remoteAddress: "192.0.2.5", headers: { authorization: `Bearer ${token}` }, payload: { command: "acmectl", args: [] } });
    expect(remote.statusCode).toBe(403);
  });
});
