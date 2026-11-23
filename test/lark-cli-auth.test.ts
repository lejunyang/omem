import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ exec: vi.fn(), token: vi.fn(), clients: [] as Record<string, unknown>[] }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  const execFile = Object.assign(() => {}, { [Symbol.for("nodejs.util.promisify.custom")]: calls.exec });
  return { ...real, execFile };
});
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Domain: { Feishu: "feishu", Lark: "lark" }, LoggerLevel: { fatal: "fatal" },
  Client: class {
    appSecret: unknown;
    tokenManager = { getTenantAccessToken: calls.token };
    constructor(options: Record<string, unknown>) { this.appSecret = options.appSecret; calls.clients.push(options); }
  },
}));
import { larkCliAsBot } from "../src/channels/lark-cli.ts";

afterEach(() => { vi.unstubAllEnvs(); calls.exec.mockReset(); calls.token.mockReset(); calls.clients.length = 0; });

describe("bot credentials passed to lark-cli", () => {
  it("passes a minted tenant token and removes inherited user, secret and proxy credentials", async () => {
    for (const key of ["APP_SECRET", "USER_ACCESS_TOKEN", "AUTH_PROXY", "TENANT_ACCESS_TOKEN_SOURCE", "PROFILE"]) vi.stubEnv(`LARKSUITE_CLI_${key}`, "stale");
    calls.token.mockResolvedValue("tenant-fresh");
    calls.exec.mockResolvedValue({ stdout: JSON.stringify({ ok: true, data: { document: { content: "项目 A" } } }) });
    const bot = { appId: "bot-read", appSecret: "secret-current", brand: "lark" };
    const args = ["docs", "+fetch", "--as", "bot", "--doc", "DocA"];
    expect(await larkCliAsBot(bot, args, 1200, "/workspace")).toMatchObject({ ok: true });
    expect(calls.clients[0]).toMatchObject({ appId: bot.appId, appSecret: bot.appSecret, domain: "lark", loggerLevel: "fatal" });
    const [exe, command, options] = calls.exec.mock.calls[0];
    expect(exe).toBe(process.execPath);
    expect(command.slice(1)).toEqual(args);
    expect(options).toMatchObject({ cwd: "/workspace", timeout: 1200, env: { LARKSUITE_CLI_APP_ID: bot.appId, LARKSUITE_CLI_BRAND: "lark", LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "tenant-fresh", LARKSUITE_CLI_STRICT_MODE: "bot" } });
    for (const key of ["APP_SECRET", "USER_ACCESS_TOKEN", "AUTH_PROXY", "TENANT_ACCESS_TOKEN_SOURCE", "PROFILE"]) expect(options.env).not.toHaveProperty(`LARKSUITE_CLI_${key}`);
    calls.token.mockResolvedValue("tenant-renewed");
    await larkCliAsBot(bot, args);
    expect(calls.clients).toHaveLength(1);
    expect(calls.exec.mock.calls[1][2].env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("tenant-renewed");
    await larkCliAsBot({ ...bot, appSecret: "secret-rotated" }, args);
    expect(calls.clients).toHaveLength(2);
  });

  it("stops before invoking the CLI when minting fails or returns no token", async () => {
    calls.token.mockRejectedValue(new Error("app_secret=private-secret failed"));
    await expect(larkCliAsBot({ appId: "bot-failure", appSecret: "private-secret" }, [])).rejects.toThrow("app_secret=[已隐藏]");
    calls.token.mockResolvedValue("");
    await expect(larkCliAsBot({ appId: "bot-empty", appSecret: "fixture" }, [])).rejects.toThrow("未能获取机器人的访问令牌");
    expect(calls.exec).not.toHaveBeenCalled();
  });
});
