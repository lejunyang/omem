import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CredentialDef } from "../packages/plugin-sdk/credential.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { accountHome } from "../src/agents/accounts.ts";
import { commandGateDir, gatePaths } from "../src/agents/command-gate.ts";
import { knownAccess, recordAccess } from "../src/agents/credential-access.ts";
import { checkCredential, credentialHold, registerCredential, setCredentialSharing } from "../src/agents/credentials.ts";
import { createRun } from "../src/agents/runs.ts";
import { sandboxSupport, setSandboxSupportForTests } from "../src/agents/sandbox.ts";
import { issueToolToken, revokeToolToken } from "../src/agents/tools.ts";
import { all, run } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const name = "sample-read", kind = "fixture:account", args = ["show", "--project", "sample"];
const resource = "project:sample", url = "https://example.test/request";
let app: ReturnType<typeof testApp>, server: Awaited<ReturnType<typeof startServer>>;
let token: string, runId: string, ownerHome: string, drop: () => void;
const linuxSandbox = process.platform === "linux" && sandboxSupport().ok;
const check = vi.fn<NonNullable<CredentialDef["check"]>>();
const verify = vi.fn<NonNullable<CredentialDef["precheck"]>>();
/** The fixture's login; a test about a member who has not logged in yet keeps it waiting on the link. */
let login: CredentialDef["login"] = async () => ({ user: "demo" });
const waitingLogin: CredentialDef["login"] = (ctx, show) => {
  show({ url: "https://example.test/login" });
  return new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true }));
};
function hold(user: string, scope: "all" | "self") {
  if (user !== "owner") mkdirSync(accountHome(app, user), { recursive: true });
  run(app.db, "insert into credential_holds(user_id,kind,state,sharing) values(?,?,'logged-in',?)", user, kind, JSON.stringify({ scope }));
}
beforeEach(async () => {
  ownerHome = mkdtempSync(join(tmpdir(), "credential-owner-"));
  vi.stubEnv("HOME", ownerHome);
  vi.stubEnv("USERPROFILE", ownerHome);
  app = testApp();
  createUser(app, { id: "reader", name: "读者" });
  runId = createRun(app, { kind: "ask", spaceId: "personal-reader", title: "示例", input: {} }).id;
  token = issueToolToken({ actor: "agent", userId: "reader", commandHomeUser: "reader", runId, spaceId: "personal-reader", spaces: [], tools: new Set() });
  check.mockReset().mockResolvedValue({ state: "ok" });
  verify.mockReset().mockImplementation(async (_ctx, req) => {
    // The fixture's resource service grants the reader one project and one complete command form.
    const allowed = req.user === "reader" && req.resource === resource;
    const exact = req.command?.name === name && JSON.stringify(req.command.args) === JSON.stringify(args);
    return { allowed, verifiedRead: allowed && exact ? true : undefined };
  });
  login = async () => ({ user: "demo" });
  drop = registerCredential("fixture", { id: "account", name: "示例账号", login: (ctx, show) => login(ctx, show),
    check, precheck: verify, provides: { commands: [{ name, readOnly: [{ subcommand: ["show"] }], state: [".sample"],
      resource: [{ key: "project:{option.project}", match: {} }], outcomes: { denied: [{ json: "$.code", equals: "DENIED" }], applyUrl: "$.url" } }] },
  }, () => ({}), app);
  commandGateDir(app);
  const bin = join(app.home, "bin-fixtures");
  mkdirSync(bin);
  const win = process.platform === "win32";
  const program = win ? name + ".cjs" : name;
  writeFileSync(join(bin, program), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.REQUESTER_ONLY) {
  console.error(JSON.stringify({code:"DENIED",url:"https://example.test/request"}));
  process.exitCode = 7;
} else {
  const path = require("node:path");
  const login = path.join(process.env.HOME, ".sample", "fixture-account");
  if (fs.existsSync(path.join(process.env.HOME, ".sample", "fixture-denied"))) {
    console.error(JSON.stringify({code:"DENIED"})); process.exit(7);
  }
  console.log(JSON.stringify({ args:process.argv.slice(2), cwd:process.cwd(), files:fs.readdirSync("."), token:!!process.env.OMEM_TOKEN,
    login:fs.existsSync(login) ? fs.readFileSync(login,"utf8") : null, privateVisible:fs.existsSync(path.join(process.env.HOME, "unshared-fixture", "private")) }));
  process.stderr.write(Buffer.from([0xff,0x0a]));
}
`, { mode: 0o755 });
  if (win) writeFileSync(join(bin, name + ".cmd"), `@node "%~dp0\\${program}" %*\r\n`);
  vi.stubEnv("PATH", bin + delimiter + process.env.PATH);
  server = await startServer(app, { port: 0, host: "127.0.0.1", quiet: true });
});
afterEach(async () => {
  revokeToolToken(token); drop(); vi.unstubAllEnvs(); setSandboxSupportForTests(undefined);
  await server.close(); app.db.close(); rmSync(app.home, { recursive: true, force: true });
  rmSync(ownerHome, { recursive: true, force: true });
});
async function gate(argv = args, extra = {}, auth = token) {
  const r = await server.inject({ method: "POST", url: "/api/command-gate", headers: { authorization: "Bearer " + auth },
    payload: { command: name, args: argv, cwd: app.home, credentialExecution: true, ...extra } });
  return { status: r.statusCode, ...r.json() };
}
function wrapper() {
  const p = spawn(process.execPath, [gatePaths(app.home).script, name, ...args], { env: { ...process.env, REQUESTER_ONLY: "1", OMEM_URL: app.baseUrl, OMEM_TOKEN: token } });
  const out: Buffer[] = [], err: Buffer[] = [];
  p.stdout.on("data", d => out.push(d)); p.stderr.on("data", d => err.push(d));
  return new Promise<{ stdout: string; stderr: Buffer; code: number | null }>((resolve, reject) => {
    p.once("error", reject);
    p.once("close", code => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err), code }));
  });
}

it("缺登录且服务确认发起人有权时由出借人执行，垫片保留两个输出流，空工作目录用后删除", async () => {
  const result = await wrapper();
  expect(result.code).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out).toMatchObject({ args, files: [], token: false });
  expect(existsSync(out.cwd)).toBe(false);
  expect(result.stderr).toEqual(Buffer.from([0xff, 0x0a]));
  expect(verify).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner" }), { resource, user: "reader", command: { name, args } });
  expect(knownAccess(app, kind, resource, "owner")?.allowed).toBe(1);
  expect(all(app.db, "select action from audit_events where action in ('credentials.command','credentials.precheck')")).toHaveLength(2);
  expect(all(app.db, "select seq from run_events where run_id=? and data like '%发起人缺少有效登录%'", runId)).toHaveLength(1);
});

it("本人登录检查超时后仍按发起人的实时读取权选人，明确缺失后停止出借", async () => {
  check.mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    const pending = checkCredential(app, "owner", kind);
    await vi.advanceTimersByTimeAsync(120_001);
    await pending;
  } finally { vi.useRealTimers(); }
  expect(credentialHold(app, "owner", kind)).toMatchObject({ state: "none", error: "检查失败，请稍后重试" });
  verify.mockResolvedValueOnce({ allowed: null });
  expect((await gate()).execution).toBeUndefined();
  expect((await gate()).execution?.code).toBe(0);
  check.mockResolvedValueOnce({ state: "missing" });
  await checkCredential(app, "owner", kind);
  expect((await gate()).execution).toBeUndefined();
  expect(verify).toHaveBeenCalledTimes(2);
});

it("本地 denied 保留退出码、输出和申请链接，已知无权时即使缺登录也继续本地执行", async () => {
  hold("reader", "self");
  for (let pass = 0; pass < 2; pass++) {
    const result = await wrapper();
    expect(result.code).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr.toString()).toContain(JSON.stringify({ code: "DENIED", url }));
    expect(result.stderr.toString()).toContain("可前往 " + url);
    expect(knownAccess(app, kind, resource, "reader")?.allowed).toBe(0);
    run(app.db, "delete from credential_holds where user_id='reader'");
  }
  expect(verify).not.toHaveBeenCalled();
});

it("未授权令牌、操作规则拒绝、缺资源、非只读、私有出借和 off 都不使用其他登录", async () => {
  expect((await gate(args, {}, "invalid")).status).toBe(401);
  app.config.security.operationRules = [{ id: "deny", revision: 1, enabled: true, action: "deny", match: { kind: "command", executable: name } }];
  expect((await gate()).decision).toBe("deny");
  app.config.security.operationRules = [];
  for (const argv of [["edit", "--project", "sample"], ["show"]]) expect((await gate(argv)).execution).toBeUndefined();
  app.config.credentials.lending = "off";
  expect((await gate()).execution).toBeUndefined();
  app.config.credentials.lending = "auto";
  run(app.db, "update credential_holds set sharing=?", JSON.stringify({ scope: "self" }));
  expect((await gate()).execution).toBeUndefined();
  expect(verify).not.toHaveBeenCalled();
});

it("缓存、持有人权限及提示性预检不授予执行权；异常、未知、拒绝和多余参数均留在本地", async () => {
  for (const user of ["owner", "reader"]) recordAccess(app, kind, resource, user, true, runId);
  for (const answer of [{ allowed: true }, { allowed: null }, { allowed: false, applyUrl: url }]) {
    verify.mockResolvedValueOnce(answer);
    expect((await gate(args, { user: "owner" })).execution).toBeUndefined();
    expect(verify.mock.lastCall?.[1].user).toBe("reader");
  }
  run(app.db, "delete from credential_access where user_id='reader'");
  verify.mockRejectedValueOnce(new Error("fixture"));
  expect((await gate()).execution).toBeUndefined();
  expect((await gate([...args, "--project", "another"])).execution).toBeUndefined();
  expect(all(app.db, "select 1 from audit_events where action='credentials.command'")).toHaveLength(0);
});

it("资源服务回复期间撤回出借时不启动命令", async () => {
  verify.mockImplementationOnce(async () => {
    run(app.db, "update credential_holds set sharing=?", JSON.stringify({ scope: "self" }));
    return { allowed: true, verifiedRead: true };
  });
  expect((await gate()).execution).toBeUndefined();
  expect(all(app.db, "select 1 from audit_events where action='credentials.command'")).toHaveLength(0);
});

// /bin/echo substitutes for bubblewrap to inspect the POSIX mount arguments.
it.skipIf(process.platform === "win32")("成员出借只挂载该命令的登录目录，沙箱不可用时不代跑", async () => {
  createUser(app, { id: "lender", name: "出借人" }); hold("lender", "all");
  setCredentialSharing(app, "owner", kind, { scope: "self" });
  const state = join(accountHome(app, "lender"), ".sample"); mkdirSync(state);
  setSandboxSupportForTests({ ok: false });
  expect((await gate()).execution).toBeUndefined();
  expect(verify).not.toHaveBeenCalled();
  setSandboxSupportForTests({ ok: true, bwrap: "/bin/echo" });
  const response = await gate();
  const plan = Buffer.from(response.execution.stdout, "base64").toString();
  expect(plan).toContain("--bind " + state + " " + state);
  expect(plan).not.toContain(accountHome(app, "reader"));
  expect(verify.mock.lastCall?.[0].home).toBe(accountHome(app, "lender"));
});


// Real namespaces require Linux with working bubblewrap.
it.skipIf(!linuxSandbox)("在成员沙箱中用出借人的登录运行假命令，只读结果返回发起人", async () => {
  createUser(app, { id: "lender", name: "出借人" }); hold("lender", "all");
  setCredentialSharing(app, "owner", kind, { scope: "self" });
  const home = accountHome(app, "lender");
  mkdirSync(join(home, ".sample"));
  writeFileSync(join(home, ".sample", "fixture-account"), "sample-lender");
  mkdirSync(join(home, "unshared-fixture"));
  writeFileSync(join(home, "unshared-fixture", "private"), "fixture");
  const result = await wrapper();
  expect(result.code, result.stderr.toString()).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out).toMatchObject({ args, files: [], token: false, login: "sample-lender", privateVisible: false });
  expect(existsSync(out.cwd)).toBe(false);
});


it.skipIf(!linuxSandbox)("本人启用沙箱时从本人 HOME 读取，隐藏目录仍不可见", async () => {
  const home = ownerHome;
  mkdirSync(join(home, ".sample"));
  writeFileSync(join(home, ".sample", "fixture-account"), "sample-owner");
  const hidden = join(home, "unshared-fixture");
  mkdirSync(hidden);
  app.config.agents.ownSandbox = { mode: "require", hidden: [hidden], writable: [] };
  // Hidden directories are replaced by empty mounts. Probe a file inside the hidden directory.
  writeFileSync(join(hidden, "private"), "fixture");
  const result = await wrapper();
  expect(result.code, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ login: "sample-owner", privateVisible: false, token: false });
});

it.skipIf(!linuxSandbox)("先用已知有权的持有人，随后用本人；两位都被拒绝时保留退出码并结束", async () => {
  for (const id of ["first", "third"]) {
    createUser(app, { id, name: id }); hold(id, "all");
  }
  recordAccess(app, kind, resource, "first", true, runId);
  for (const home of [accountHome(app, "first"), ownerHome]) {
    mkdirSync(join(home, ".sample"));
    writeFileSync(join(home, ".sample", "fixture-denied"), "");
  }
  const result = await wrapper();
  expect(result.code).toBe(7);
  expect(result.stderr.toString()).toContain("DENIED");
  expect(verify.mock.calls.map(([ctx, req]) => [ctx.userId, req.user])).toEqual([["first", "reader"], ["owner", "reader"]]);
  for (const id of ["first", "owner"]) expect(knownAccess(app, kind, resource, id)?.allowed).toBe(0);
  expect(knownAccess(app, kind, resource, "reader")?.allowed).toBe(1);
});

async function pendingConfirmation() {
  const pending = () => listAsks(app, { userId: "owner", status: "pending" })[0];
  await vi.waitFor(() => expect(pending()?.handler).toBe("credential-confirm"));
  return pending();
}

it("本人状态未知也先预检和确认，任务同意在同一根运行复用，其他根运行重新问", async () => {
  app.config.credentials.lending = "confirm";
  const first = gate();
  const ask = await pendingConfirmation();
  expect(ask.question).toContain([name, ...args].join(" "));
  await expect(answerAsk(app, ask.id, { by: "reader", choice: 1 })).rejects.toThrow("只有持有人");
  await answerAsk(app, ask.id, { by: "owner", choice: 1 });
  expect((await first).execution.code).toBe(0);
  for (const parentId of [runId, null]) {
    const child = createRun(app, { kind: "ask", spaceId: "personal-reader", title: "继续读取", input: {}, parentId }).id;
    const auth = issueToolToken({ actor: "agent", userId: "reader", commandHomeUser: "reader", runId: child, spaceId: "personal-reader", spaces: [], tools: new Set() });
    try {
      const next = gate(args, {}, auth);
      if (parentId) {
        expect((await next).execution.code).toBe(0);
        run(app.db, "update runs set status='done' where id=?", child);
      }
      else {
        await answerAsk(app, (await pendingConfirmation()).id, { by: "owner", choice: 2 });
        expect(await next).toMatchObject({ decision: "deny", message: "持有人没同意" });
      }
    } finally { revokeToolToken(auth); }
  }
  expect(verify).toHaveBeenCalledTimes(3);
  expect(all(app.db, "select root from credential_run_grants")).toEqual([{ root: runId }]);
  run(app.db, "update runs set status='done' where id=?", runId);
  expect(all(app.db, "select root from credential_run_grants")).toEqual([]);
});

it.each(["agent", "code"] as const)("聊天结束后，%s 交办的任务同意持续到最后一个运行结束", async (kind) => {
  app.config.credentials.lending = "confirm";
  const tokens: string[] = [];
  function start(kind: "agent" | "code", parentId: string, input = {}) {
    const { id } = createRun(app, { kind, spaceId: "personal-reader", userId: "reader", title: "后台读取", parentId, input });
    run(app.db, "update runs set status='running' where id=?", id);
    const auth = issueToolToken({ actor: "agent", userId: "reader", commandHomeUser: "reader", runId: id, spaceId: "personal-reader", spaces: [], tools: new Set() });
    tokens.push(auth);
    return { id, read: () => gate(args, {}, auth) };
  }
  const finish = (id: string) => run(app.db, "update runs set status='done' where id=?", id);
  try {
    const task = start(kind, runId);
    finish(runId);
    const first = task.read();
    await answerAsk(app, (await pendingConfirmation()).id, { by: "owner", choice: 1 });
    expect((await first).execution.code).toBe(0);
    expect(all(app.db, "select root from credential_run_grants")).toEqual([{ root: task.id }]);
    expect((await task.read()).execution.code).toBe(0);

    const next = kind === "code" ? start("code", runId, { continueFrom: task.id }) : start("agent", task.id);
    finish(task.id);
    expect((await next.read()).execution.code).toBe(0);
    expect(listAsks(app, { userId: "owner" })).toHaveLength(1);

    const other = start(kind, runId);
    const anotherRead = other.read();
    await answerAsk(app, (await pendingConfirmation()).id, { by: "owner", choice: 2 });
    expect(await anotherRead).toMatchObject({ decision: "deny" });
    finish(next.id);
    expect(all(app.db, "select root from credential_run_grants")).toEqual([]);
    const fresh = start(kind, runId).read();
    await answerAsk(app, (await pendingConfirmation()).id, { by: "owner", choice: 0 });
    expect((await fresh).execution.code).toBe(0);
    expect(verify).toHaveBeenCalledTimes(5);
  } finally { tokens.forEach(revokeToolToken); }
});

it("auto 对有权限记录的私有持有人等十分钟，超时返回最近的申请链接", async () => {
  setCredentialSharing(app, "owner", kind, { scope: "self" });
  recordAccess(app, kind, resource, "owner", false, runId, url);
  recordAccess(app, kind, resource, "owner", true, runId);
  vi.useFakeTimers();
  try {
    const next = gate();
    const ask = await pendingConfirmation();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await next).toMatchObject({ decision: "deny", message: expect.stringContaining(url) });
    await expect(answerAsk(app, ask.id, { by: "owner", choice: 0 })).rejects.toThrow("失效");
  } finally { vi.useRealTimers(); }
});

it("这一次同意只放行一次，下一次拒绝时垫片以 126 退出并显示申请链接", async () => {
  app.config.credentials.lending = "confirm";
  recordAccess(app, kind, resource, "owner", false, runId, url);
  recordAccess(app, kind, resource, "owner", true, runId);
  for (const choice of [0, 2]) {
    const result = wrapper();
    await answerAsk(app, (await pendingConfirmation()).id, { by: "owner", choice });
    const { code, stdout, stderr } = await result;
    if (choice === 0) expect(code).toBe(0);
    else {
      expect(code).toBe(126);
      expect(stdout).toBe("");
      expect(stderr.toString()).toContain("持有人没同意，可前往 " + url);
    }
  }
});

it("兜底打开后：成员没登录时不预检，提醒他授权并用本人的登录执行；本人的登录不借给他时只提醒", async () => {
  // He has not finished the login omem starts for him.
  login = waitingLogin;
  app.config.credentials.ownerFallback = true;
  const result = await gate();
  expect(result.execution?.code, JSON.stringify(result)).toBe(0);
  expect(result.notice).toContain("这次用");
  expect(verify).not.toHaveBeenCalled();
  expect(credentialHold(app, "reader", kind).notified.invite).toBeTruthy();
  expect(all(app.db, "select seq from run_events where run_id=? and data like '%兜底%'", runId)).toHaveLength(1);
  // A second command the same day does not ask again.
  const before = all(app.db, "select * from credential_holds where user_id='reader'");
  await gate();
  expect(all(app.db, "select * from credential_holds where user_id='reader'")).toEqual(before);
  // The owner's login is not lent to this member: nothing runs elsewhere, the member is still asked.
  setCredentialSharing(app, "owner", kind, { scope: "self" });
  const kept = await gate();
  expect(kept.execution).toBeUndefined();
  expect(kept.notice).not.toContain("这次用");
});

it("成员借用本人 HOME 的运行：兜底时不另起进程、不回报结果，只说明用了谁的登录；关掉时照旧不处理", async () => {
  login = waitingLogin;
  const borrowed = issueToolToken({ actor: "agent", userId: "reader", commandHomeUser: "owner", runId, spaceId: "personal-reader", spaces: [], tools: new Set() });
  try {
    expect(await gate(args, {}, borrowed)).toEqual({ status: 200, decision: "allow" });
    app.config.credentials.ownerFallback = true;
    const result = await gate(args, {}, borrowed);
    expect(result).toMatchObject({ decision: "allow", report: false });
    expect(result.execution).toBeUndefined();
    expect(result.notice).toContain("这次用");
    // Global options before the subcommand still match the declaration.
    expect((await gate(["--site", "cn", "show", "--project", "sample"], {}, borrowed)).notice).toContain("这次用");
    expect((await gate(["edit", "--project", "sample"], {}, borrowed)).notice).toBeUndefined();
  } finally { revokeToolToken(borrowed); }
});

it.skipIf(!linuxSandbox)("兜底时先用成员自己的登录；他没权限就把申请链接发给他，再用本人的登录执行", async () => {
  app.config.credentials.ownerFallback = true;
  hold("reader", "self");
  const home = accountHome(app, "reader");
  mkdirSync(join(home, ".sample"), { recursive: true });
  writeFileSync(join(home, ".sample", "fixture-denied"), "");
  mkdirSync(join(ownerHome, ".sample"));
  writeFileSync(join(ownerHome, ".sample", "fixture-account"), "sample-owner");
  const result = await gate();
  expect(result.execution?.code, JSON.stringify(result)).toBe(0);
  expect(Buffer.from(result.execution.stdout, "base64").toString()).toContain("sample-owner");
  expect(knownAccess(app, kind, resource, "reader")?.allowed).toBe(0);
  expect(result.notice).toContain("没有这个资源的权限");
});

it("成员的运行说明里写明这些命令用谁的登录由 omem 决定，主人的运行里不写", async () => {
  const { commandLoginNote } = await import("../src/agents/credential-execution.ts");
  expect(commandLoginNote(app, "owner")).toBe("");
  expect(commandLoginNote(app, "reader")).toContain(name);
  expect(commandLoginNote(app, "reader")).not.toContain("接着查");
  app.config.credentials.ownerFallback = true;
  expect(commandLoginNote(app, "reader")).toContain("接着查");
});
