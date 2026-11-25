import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CredentialDef } from "../packages/plugin-sdk/credential.ts";
import { credentialOutcome } from "../src/agents/credential-outcome.ts";
import { credentialWaits } from "../src/agents/credential-wait.ts";
import { checkCredential, credentialHold, myCredentials, registerCredential, startCredentialLogin, stopCredentialLogins } from "../src/agents/credentials.ts";
import { createRun } from "../src/agents/runs.ts";
import { createThread } from "../src/agents/threads.ts";
import { closeVault } from "../src/auth/vault.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";


const kind = "sample:sso";
let app: App;
let undo: (() => void)[];
let finish: (() => void) | null;
let fail: ((e: Error) => void) | null;
let check: ReturnType<typeof vi.fn<NonNullable<CredentialDef["check"]>>>;
beforeEach(() => {
  app = testApp(); undo = []; finish = null; fail = null;
  check = vi.fn<NonNullable<CredentialDef["check"]>>(async () => ({ state: "ok", user: "owner@example.test", expiresAt: Date.now() + 30 * 86400_000 }));
  const def: CredentialDef = { id: "sso", name: "示例授权",
    provides: { commands: [{ name: "acme", outcomes: { unauthenticated: [{ json: "$.error.code", equals: "AUTH_REQUIRED" }] } }] },
    async login() { throw new Error("成员登录不在这里测"); },
    // The tool's own device login: the link first, done when the test says so.
    ownerLogin: (_ctx, show) => new Promise((resolve, reject) => {
      show({ url: "https://auth.example.test/device?state=fixture" });
      finish = () => resolve({ user: "owner@example.test", expiresAt: Date.now() + 30 * 86400_000 + 1000 });
      fail = reject;
    }),
    check,
  };
  undo.push(registerCredential("sample", def, () => ({}), app));
});
afterEach(async () => {
  stopCredentialLogins(); for (const fn of undo) fn();
  await new Promise((r) => setImmediate(r));
  closeVault(app.home); app.db.close(); rmSync(app.home, { recursive: true, force: true });
});
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("状态未更新"); }
const cards = () => all<{ title: string; link: string | null; tone: string | null }>(app.db, "select title, link, json_extract(context, '$.tone') tone from notifications order by at, rowid");

it("本人的凭据可以在 omem 里登录：卡片直接打开官方页面，完成后变成有效", async () => {
  expect(myCredentials(app, "owner").credentials[0]).toMatchObject({ machine: true, login: true });
  expect(await startCredentialLogin(app, "owner", kind)).toEqual({ url: "https://auth.example.test/device?state=fixture" });
  expect(cards().at(-1)).toMatchObject({ title: "omem 正在为你登录 示例授权", link: "https://auth.example.test/device?state=fixture" });
  expect(cards().at(-1)!.tone).toBe("warning");
  finish!();
  await until(() => credentialHold(app, "owner", kind).state === "logged-in");
  expect(credentialHold(app, "owner", kind).user).toBe("owner@example.test");
  // The same card turns green, and the used link is no longer offered anywhere.
  expect(cards()).toEqual([
    { title: "omem 正在为你登录 示例授权", link: null, tone: "warning" },
    { title: "示例授权 已登录", link: null, tone: "done" },
  ]);
});

it("登录进行中有命令报过期：登录完成后不再把新登录标成过期、也不发“登录过期了”", async () => {
  await startCredentialLogin(app, "owner", kind);
  const r = createRun(app, { kind: "agent", spaceId: "personal", title: "定时查询", input: {} });
  const reported = credentialOutcome(app, "owner", r.id, { command: "acme", args: ["query"], code: 1, output: JSON.stringify({ error: { code: "AUTH_REQUIRED" } }) });
  finish!();
  await reported;
  expect(credentialHold(app, "owner", kind).state).toBe("logged-in");
  expect(cards().map((c) => c.title)).toEqual(["omem 正在为你登录 示例授权", "示例授权 已登录"]);
});

it("登录没完成：同一张卡片改成失败，旧链接去掉、打开它会重新登录；登录进行中不另发“过期”提醒", async () => {
  await startCredentialLogin(app, "owner", kind);
  // A command reports the login expired while this login is still waiting.
  const r = createRun(app, { kind: "agent", spaceId: "personal", title: "定时查询", input: {} });
  const reported = credentialOutcome(app, "owner", r.id, { command: "acme", args: ["query"], code: 1, output: JSON.stringify({ error: { code: "AUTH_REQUIRED" } }) });
  fail!(new Error("设备码过期"));
  await reported;
  await until(() => cards().length >= 2);
  await new Promise((r) => setTimeout(r, 50));
  expect(cards()).toEqual([
    { title: "omem 正在为你登录 示例授权", link: null, tone: "warning" },
    { title: "示例授权 没有登录成功", link: "#/account?login=sample%3Asso", tone: "warning" },
  ]);
});

it("对话里的命令报没登录：宿主发起登录、告诉助手别自己轮询，授权完成后这段对话接着做", async () => {
  const thread = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: "查审核记录", input: { conversationId: thread.id } });
  const out = await credentialOutcome(app, "owner", r.id, { command: "acme", args: ["query"], code: 1, output: JSON.stringify({ status: "error", error: { code: "AUTH_REQUIRED" } }) });
  expect(out).toMatchObject({ reason: "unauthenticated" });
  expect((out as { notice?: string }).notice).toContain("授权完成后这段对话会自动接着做");
  expect(credentialHold(app, "owner", kind).state).toBe("expired");
  expect(credentialWaits(app, "owner", kind)).toHaveLength(1);
  await until(() => !!finish);
  // One card, with the official link; no separate “登录过期了” reminder pointing at the settings page.
  expect(cards().map((c) => c.title)).toEqual(["omem 正在为你登录 示例授权"]);
  expect(cards()[0]!.link).toBe("https://auth.example.test/device?state=fixture");
  finish!();
  const said = () => one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and text like '[授权]%'", thread.id)?.text ?? "";
  // The first turn loads the inbox and the runner: allow for it.
  await expect.poll(said, { timeout: 15_000 }).toMatch(/^\[授权\] .*已完成示例授权登录/);
  expect(credentialWaits(app, "owner", kind)).toHaveLength(0);
});

it("命令报过期后，只读本机文件的检查看到的还是同一份登录就不改回有效；换了新登录才接着做", async () => {
  const expiresAt = Date.now() + 30 * 86400_000;
  check.mockResolvedValue({ state: "ok", user: "owner@example.test", expiresAt });
  await checkCredential(app, "owner", kind);
  expect(credentialHold(app, "owner", kind).state).toBe("logged-in");
  // A rule's run: no conversation to go on with, so only the reminder (whose link starts the login on the account page).
  const r = createRun(app, { kind: "agent", spaceId: "personal", title: "定时查询", input: {} });
  await credentialOutcome(app, "owner", r.id, { command: "acme", args: ["query"], code: 1, output: JSON.stringify({ error: { code: "AUTH_REQUIRED" } }) });
  expect(cards().at(-1)).toMatchObject({ title: "示例授权 登录过期了", link: "#/account?login=sample%3Asso" });
  expect(credentialWaits(app, "owner", kind)).toHaveLength(0);
  run(app.db, "update credential_holds set check_day = '' where user_id = 'owner'");
  await checkCredential(app, "owner", kind);
  expect(credentialHold(app, "owner", kind).state).toBe("expired");
  // Logged in again outside omem: the renewal date on disk moved.
  check.mockResolvedValue({ state: "ok", user: "owner@example.test", expiresAt: expiresAt + 3600_000 });
  await checkCredential(app, "owner", kind);
  expect(credentialHold(app, "owner", kind).state).toBe("logged-in");
});

it("工具自己续签短期令牌时，检查给 expiresAt: null：清掉旧的到期时间，不提醒到期、也不按日期判过期", async () => {
  check.mockResolvedValue({ state: "ok", user: "owner@example.test", expiresAt: Date.now() + 3600_000 });
  await checkCredential(app, "owner", kind);
  expect(credentialHold(app, "owner", kind).expiresAt).toBeDefined();
  run(app.db, "update credential_holds set check_day = '' where user_id = 'owner'");
  check.mockResolvedValue({ state: "ok", user: "owner@example.test", expiresAt: null });
  await checkCredential(app, "owner", kind);
  expect(credentialHold(app, "owner", kind)).toMatchObject({ state: "logged-in", expiresAt: undefined });
  expect(cards().filter((c) => c.title.includes("三天内到期")).length).toBeLessThanOrEqual(1);
});
