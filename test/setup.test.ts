import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { checkLarkApp, knownLarkApps, LARK_BOT_ADDONS, larkAppSecret, larkCliState, registerLarkBot, saveLarkSecret, setRegisterAppForTests } from "../src/channels/lark-setup.ts";
import { ensureDefaultSchedules, listSchedules } from "../src/core/scheduler.ts";
import { installSpec, setToolResolverForTests, toolCommand } from "../src/core/tools.ts";
import { guardEnabled } from "../src/sources/guard.ts";
import { judgeModelFile, judgeProject } from "../src/sources/judge.ts";
import { testApp } from "./helpers.ts";

afterEach(() => {
  setLarkCliForTests(null);
  setRegisterAppForTests(null);
  setToolResolverForTests(null);
  delete process.env.OMEM_TEST_LARK_SECRET;
});

describe("feishu bot setup", () => {
  it("creates an app through the SDK device flow with omem's permissions, events and card callback", async () => {
    let seen: any;
    setRegisterAppForTests((async (opts: any) => {
      seen = opts;
      opts.onQRCodeReady({ url: "https://accounts.feishu.cn/x", expireIn: 600 });
      return { client_id: "cli_new1", client_secret: "s3cret", user_info: { open_id: "ou_owner", tenant_brand: "feishu" } };
    }) as never);
    const qrs: string[] = [];
    const c = await registerLarkBot({ name: "测试助理", onQr: (u) => qrs.push(u) });
    expect(c).toMatchObject({ appId: "cli_new1", appSecret: "s3cret", ownerOpenId: "ou_owner" });
    expect(qrs).toEqual(["https://accounts.feishu.cn/x"]);
    expect(seen.createOnly).toBe(true);
    expect(seen.appPreset.name).toBe("测试助理");
    expect(seen.addons.events.items.tenant).toContain("im.message.receive_v1");
    expect(seen.addons.callbacks.items).toContain("card.action.trigger");
    expect(seen.addons.scopes.tenant).toEqual(expect.arrayContaining(["im:message", "im:message:send_as_bot", "im:resource", "cardkit:card:write"]));
    expect(LARK_BOT_ADDONS.scopes.tenant.some((s) => /permission|chat:delete|chat.members:write/.test(s))).toBe(false);
  });

  it("updates an existing app and refuses credentials for a different one", async () => {
    setRegisterAppForTests((async (opts: any) => ({ client_id: opts.appId === "cli_a" ? "cli_a" : "cli_other", client_secret: "x" })) as never);
    const c = await registerLarkBot({ appId: "cli_a", onQr: () => {} });
    expect(c.appId).toBe("cli_a");
    await expect(registerLarkBot({ appId: "cli_b", onQr: () => {} })).rejects.toThrow(/另一个应用/);
  });

  it("keeps the secret out of config in an owner-only file; the env var wins", () => {
    const app = testApp();
    saveLarkSecret(app.home, { appId: "cli_a", appSecret: "file-secret", name: "助理" });
    const file = join(app.home, "secrets", "lark.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(larkAppSecret(app.home, "cli_a", "OMEM_TEST_LARK_SECRET")).toBe("file-secret");
    process.env.OMEM_TEST_LARK_SECRET = "env-secret";
    expect(larkAppSecret(app.home, "cli_a", "OMEM_TEST_LARK_SECRET")).toBe("env-secret");
  });

  it("lists apps omem holds and the one lark-cli uses, and reads lark-cli login state", async () => {
    const app = testApp();
    saveLarkSecret(app.home, { appId: "cli_saved", appSecret: "x" });
    setLarkCliForTests(async (args) => {
      if (args[0] === "profile") return [{ name: "cli_cli", appId: "cli_cli" }, { name: "cli_saved", appId: "cli_saved" }];
      if (args[0] === "auth") return { appId: "cli_cli", identities: { user: { available: false, message: "refresh token expired", openId: "ou_me", userName: "我" }, bot: { available: true } } };
      throw new Error("unexpected");
    });
    const apps = await knownLarkApps(app.home);
    expect(apps.map((a) => [a.appId, a.source, a.hasSecret])).toEqual([
      ["cli_saved", "omem", true],
      ["cli_cli", "lark-cli", false],
    ]);
    const s = await larkCliState();
    expect(s).toMatchObject({ appId: "cli_cli", user: { ok: false, openId: "ou_me", name: "我" }, bot: { ok: true } });
  });

  it("verifies credentials and reports missing message scopes without sending anything", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const body = url.includes("tenant_access_token") ? { code: 0, tenant_access_token: "t" } : url.includes("bot/v3") ? { code: 0, bot: { open_id: "ou_bot", app_name: "助理" } } : { code: 0, data: { app: { scopes: [{ scope: "im:message" }] } } };
      return { json: async () => body } as Response;
    }) as typeof fetch;
    const r = await checkLarkApp("cli_a", "s", fake);
    expect(r).toMatchObject({ botName: "助理", botOpenId: "ou_bot" });
    // Compared with everything the bot needs, including what @-mentions take.
    expect(r.missingScopes).toEqual(expect.arrayContaining(["im:message:send_as_bot", "im:resource", "contact:user.id:readonly", "contact:user.employee_id:readonly"]));
    expect(r.missingScopes).not.toContain("im:message");
    expect(r.scopesUnknown).toBeUndefined();
    expect(calls.every((u) => !/message\/|messages/.test(u))).toBe(true);
    const bad = await checkLarkApp("cli_a", "s", (async () => ({ json: async () => ({ code: 10014, msg: "app secret invalid" }) }) as Response) as typeof fetch);
    expect(bad.error).toMatch(/App Secret/);
  });
});

describe("setup helpers", () => {
  it("schedules exist before the service has ever started", () => {
    const app = testApp();
    ensureDefaultSchedules(app);
    expect(listSchedules(app).map((s) => s.id)).toContain("lark-poll");
  });

  it("runs uv and llama-server through osdk when they are not on PATH", () => {
    expect(installSpec("uv")).toBe("conda:uv"); // standalone binary: no osdk-managed Python needed
    setToolResolverForTests((n) => (n === "uv" ? ["osdk", "exec", "--no-deps", "-t", "conda:uv", "--", "uv"] : null));
    expect(toolCommand("uv")?.slice(0, 5)).toEqual(["osdk", "exec", "--no-deps", "-t", "conda:uv"]);
    expect(toolCommand("llama-server")).toBeNull();
  });

  it("the judge is enabled by a model directory (omem starts it) or an external url", () => {
    const app = testApp();
    app.config.guard = { ...app.config.guard, provider: "startlux" };
    expect(guardEnabled(app)).toBe(false);
    app.config.guard.modelDir = "/nowhere";
    expect(guardEnabled(app)).toBe(true);
    expect(judgeModelFile("/nowhere")).toBeNull();
    expect(judgeProject()).toMatch(/scripts[\\/]startlux$/);
  });
});
