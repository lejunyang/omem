import { afterEach, expect, it } from "vitest";
import { resetLarkAuthForTests, watchOwnerLogin } from "../src/channels/lark-auth.ts";
import { larkCli, onOwnerLoginMissing, setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { all, run } from "../src/core/db.ts";
import { asLarkUser } from "../src/auth/lark-user.ts";
import { testApp } from "./helpers.ts";

afterEach(() => {
  setLarkCliForTests(null);
  onOwnerLoginMissing(null);
  resetLarkAuthForTests();
});

it("asks the owner to log in again, once, when lark-cli has no login left, and finishes the login itself", async () => {
  const app = testApp();
  const calls: string[][] = [];
  let confirm!: () => void;
  const confirmed = new Promise<void>((ok) => { confirm = ok; });
  setLarkCliForTests(async (args) => {
    calls.push(args);
    if (args[0] === "auth" && args.includes("--no-wait")) return { ok: true, data: { verification_url: "https://tenant.larkoffice.com/auth?code=X", device_code: "dc1", expires_in: 600 } };
    if (args[0] === "auth" && args.includes("--device-code")) { await confirmed; return { ok: true }; }
    return { ok: false, error: { type: "authentication", message: "token_missing need_user_authorization (user: ou_owner)" } };
  });
  watchOwnerLogin(app);
  // During quiet hours the ten-minute link would wait until morning, expired: not asked then.
  app.config.notify.quietStart = 0; app.config.notify.quietEnd = 24;
  await expect(larkCli(["im", "+chat-list"])).rejects.toThrow();
  expect(calls.some((c) => c[0] === "auth")).toBe(false);
  app.config.notify.quietStart = 0; app.config.notify.quietEnd = 0;
  // Capture and the rules fail every minute: one link, not one per failure.
  for (let i = 0; i < 3; i++) await expect(larkCli(["im", "+chat-list"])).rejects.toThrow();
  await new Promise((r) => setTimeout(r, 20));
  const logins = calls.filter((c) => c[0] === "auth" && c.includes("--no-wait"));
  expect(logins).toHaveLength(1);
  expect(logins[0]).toEqual(expect.arrayContaining(["--domain"]));
  const asked = all<{ title: string; body: string }>(app.db, "select title, body from notifications");
  expect(asked).toHaveLength(1);
  expect(asked[0].body).toContain("https://tenant.larkoffice.com/auth?code=X");
  // The confirmed login is claimed with the device code (an agent's own login once left this out).
  expect(calls.some((c) => c.includes("--device-code") && c.includes("dc1"))).toBe(true);
  confirm();
  await new Promise((r) => setTimeout(r, 20));
  expect(all<{ title: string }>(app.db, "select title from notifications").map((n) => n.title)).toContain("飞书授权已完成");
  app.db.close();
});

it("sends a new link when a run needs the login and the last link expired unconfirmed; capture alone waits", async () => {
  const app = testApp();
  app.config.notify.quietStart = 0; app.config.notify.quietEnd = 0;
  const calls: string[][] = [];
  let n = 0;
  setLarkCliForTests(async (args) => {
    calls.push(args);
    if (args[0] === "auth" && args.includes("--no-wait")) return { ok: true, data: { verification_url: `https://tenant.larkoffice.com/auth?code=${++n}`, device_code: `dc${n}`, expires_in: 600 } };
    if (args[0] === "auth" && args.includes("--device-code")) throw new Error("expired_token");
    return { ok: false, error: { type: "authentication", message: "token_missing need_user_authorization (user: ou_owner)" } };
  });
  watchOwnerLogin(app);
  await expect(larkCli(["im", "+chat-list"])).rejects.toThrow(/已把重新登录的授权链接发给本人/);
  await new Promise((r) => setTimeout(r, 20));
  const logins = () => calls.filter((c) => c[0] === "auth" && c.includes("--no-wait")).length;
  expect(logins()).toBe(1);
  // The owner was away: the link expired. Forty minutes later a rule's run needs the login.
  run(app.db, "update kv set value = ? where key = 'lark_relogin_asked_at'", String(Date.now() - 40 * 60_000));
  await expect(larkCli(["im", "+chat-list"])).rejects.toThrow(/没有确认/);
  expect(logins()).toBe(1);
  await expect(asLarkUser(app, "owner", () => larkCli(["im", "+messages-mget"]))).rejects.toThrow(/已把重新登录的授权链接发给本人/);
  expect(logins()).toBe(2);
  app.db.close();
});
