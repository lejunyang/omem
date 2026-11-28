import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ensureAccountHome, localAccount } from "../src/agents/accounts.ts";
import { receive } from "../src/agents/inbox.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { createRun } from "../src/agents/runs.ts";
import { acquireSandboxTmp, pruneSandboxTmp } from "../src/agents/sandbox-tmp.ts";
import { sandboxSupport } from "../src/agents/sandbox.ts";
import { launch } from "../src/agents/spawn.ts";
import { takeSteering } from "../src/agents/steer.ts";
import { revokeToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { createUser, personalSpaceId } from "../src/core/users.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>;
beforeEach(() => { app = testApp(); });
afterEach(() => { app.db.close(); rmSync(app.home, { force: true, recursive: true }); });

function job(kind: Parameters<typeof createRun>[1]["kind"], input: Record<string, unknown> = {}) {
  return createRun(app, { title: "示例", kind, input }).id;
}
function retained(run: string, user = "owner", guest = false, sender?: string) {
  const tmp = acquireSandboxTmp(app, run, user, guest, sender);
  tmp.release();
  return tmp.path;
}

it("按交办首轮共享助手和评审的文件，流程各阶段按事项，其他任务按运行", () => {
  const code = job("code", { itemId: "one", conversationId: "chat" });
  const round = job("code", { continueFrom: code });
  const file = join(retained(code), "交接");
  writeFileSync(file, "第一轮");
  for (const run of [round, job("agent", { helperOf: round }), job("review", { codeRunId: round })])
    expect(readFileSync(join(retained(run), "交接"), "utf8")).toBe("第一轮");
  expect(retained(job("code"))).not.toBe(dirname(file));
  const stage = retained(job("flow-stage", { itemId: "one" }));
  expect(retained(job("flow-reconcile", { itemId: "one" }))).toBe(stage);
  expect(retained(job("flow-stage", { itemId: "two" }))).not.toBe(stage);
  expect(stage).not.toBe(dirname(file));
  expect(retained(job("heartbeat"))).not.toBe(retained(job("heartbeat")));
});

it("同名同事按发送者 ID 隔离，访客、本人、不同会话和运行互不复用", () => {
  const turn = () => job("ask", { conversationId: "shared" });
  const guest = retained(turn(), "owner", true, "guest-a");
  expect(retained(turn(), "owner", true, "guest-a")).toBe(guest);
  expect(retained(turn(), "owner", true, "guest-b")).not.toBe(guest);
  expect(retained(turn())).not.toBe(guest);
  expect(retained(turn(), "owner", true)).not.toBe(retained(turn(), "owner", true));
  expect(retained(job("ask", { conversationId: "other" }), "owner", true, "guest-a")).not.toBe(guest);
  const standalone = () => job("guest", { senderId: "guest-a", chatId: "group" });
  expect(retained(standalone(), "owner", true)).toBe(retained(standalone(), "owner", true));
});

it("同事的消息只并入自己正在使用临时目录的会话轮次", async () => {
  const chat = { channel: "lark", chatId: "group", isGroup: true, mergeMs: 0, text: "示例", asker: "同名" };
  const a = await receive(app, { ...chat, askerId: "guest-a" });
  const same = await receive(app, { ...chat, askerId: "guest-a" });
  expect(same.runId).toBe(a.runId);
  app.db.prepare("update runs set status='running' where id=?").run(a.runId);
  const b = await receive(app, { ...chat, askerId: "guest-b" });
  expect(b.runId).not.toBe(a.runId);
  expect(takeSteering(app, a.runId!)).toBeNull();
});

it.skipIf(process.platform !== "linux")("按最近使用清理过期和超量目录，保留活跃目录及符号链接的宿主目标", async () => {
  const old = retained(job("heartbeat"));
  const recent = retained(job("heartbeat"));
  const expired = retained(job("heartbeat"));
  const target = join(app.home, "keep");
  writeFileSync(target, "保留");
  const locked = join(expired, "locked");
  mkdirSync(locked);
  symlinkSync(target, join(locked, "link"));
  chmodSync(locked, 0);
  for (const path of [old, recent]) writeFileSync(join(path, "large"), Buffer.alloc(700 * 1024, 1));
  const at = Date.now();
  for (const [path, age] of [[old, 3000], [recent, 2000], [expired, 20000]] as const)
    utimesSync(dirname(path), new Date(at - age), new Date(at - age));
  const id = job("code");
  const first = acquireSandboxTmp(app, id, "owner", false);
  const second = acquireSandboxTmp(app, id, "owner", false);
  first.release();
  await pruneSandboxTmp(app.home, 1024 * 1024, 10000);
  expect([old, recent, expired, second.path, target].map(p => existsSync(p))).toEqual([false, true, false, true, true]);
  second.release();
  await pruneSandboxTmp(app.home, 0);
  expect(existsSync(second.path)).toBe(false);
  expect(existsSync(recent)).toBe(false);
});

it.skipIf(!sandboxSupport().ok)("本人和成员自有账号在真实沙箱里按会话续用，执行器单独挂载 /tmp", async () => {
  const profile = agentProfileSchema.parse({ id: "fixture", transport: "acp", command: "/bin/sh" });
  const member = createUser(app, { id: "member", name: "示例成员" }).id;
  ensureAccountHome(app, member);
  const memberProfile = { ...profile, ownAccount: localAccount(app, member, profile.id) };
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.ownSandbox.mode = "require";
  const cwd = join(app.home, "workspaces", "example");
  mkdirSync(cwd, { recursive: true });
  async function turn(user: string, script: string) {
    const runId = job("ask", { conversationId: "shared" });
    const account = user === member;
    const prep = prepareRun(app, { actor: { role: "assistant" }, userId: user, spaceId: personalSpaceId(user), cwd: account ? "/tmp" : cwd, runId, profile: account ? memberProfile : profile });
    try {
      const executor = toolContextForToken(app, prep.token)!.commandSandbox!;
      expect(executor.workspace.privateTmp).toBeUndefined();
      const child = launch("/bin/sh", ["-ec", script, "sh", join("/tmp", basename(app.home) + "-marker")], { cwd: prep.cwd, ownSandbox: prep.isolation.box, sandbox: account ? memberProfile.ownAccount : undefined, workspace: prep.workspace });
      let err = "";
      child.stderr.on("data", chunk => err += chunk);
      expect((await once(child, "close"))[0], err).toBe(0);
    } finally { revokeToolToken(prep.token); }
  }
  await turn("owner", 'echo owner > "$1"');
  await turn(member, 'test ! -e "$1"; echo member > "$1"');
  await turn("owner", 'test "$(cat "$1")" = owner');
  await turn(member, 'test "$(cat "$1")" = member');
});
