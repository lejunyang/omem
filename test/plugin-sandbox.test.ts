import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callTool, issueToolToken, toolContextForToken, toolList } from "../src/agents/tools.ts";
import { setAuthFetchForTests } from "../src/auth/providers.ts";
import { storeConnection } from "../src/auth/vault.ts";
import { one } from "../src/core/db.ts";
import { createUser } from "../src/core/users.ts";
import { syncWatches } from "../src/plugins/platforms.ts";
import { describePlugin, getPlugin, loadPlugins, trustPlugin, untrustPlugin } from "../src/plugins/registry.ts";
import { testApp } from "./helpers.ts";

/**
 * A plugin's code in its own process (docs/v2/plugins.md, “隔离运行”): its tools and platform readers
 * work through omem, as the person of the call; it cannot read omem's secrets or start programs.
 */
describe("isolated plugins", async () => {
  const app = testApp();
  const seen: { url: string; auth: string | null }[] = [];
  setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    if (String(url).includes("/v1/files/")) return new Response(JSON.stringify({ name: "设计稿", lastModified: "2026-11-07T00:00:00Z", document: { id: "0", name: "d", type: "DOCUMENT", children: [] } }));
    return new Response(JSON.stringify({ name: "小安在示例平台" }));
  }) as typeof fetch);
  afterAll(() => {
    setAuthFetchForTests(null);
    untrustPlugin(app, "probe2");
  });
  await loadPlugins(app);
  const dir = join(app.home, "plugins", "probe2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), "id: probe2\nname: 探针\npermissions: { write: true, platforms: [connect-probe] }\n");
  writeFileSync(
    join(dir, "server.mjs"),
    `import { readFileSync } from "node:fs";
export default function register(api) {
  const z = api.z;
  api.tool({ name: "probe2_secret", description: "读 omem 的密钥", schema: z.object({ path: z.string() }), handler: async (_ctx, a) => {
    try { return readFileSync(a.path, "utf8"); } catch (e) { return "拒绝：" + e.code; }
  } });
  api.tool({ name: "probe2_exec", description: "运行程序", schema: z.object({}), handler: async () => {
    try { (await import("node:child_process")).execSync("echo x"); return "运行了"; } catch (e) { return "拒绝：" + e.code; }
  } });
  api.tool({ name: "probe2_me", description: "以本人身份查平台", schema: z.object({ n: z.number() }), write: true, handler: async (ctx, a) => {
    await ctx.store.put("visits", "last", { n: a.n });
    const c = await ctx.connection("connect-github");
    const body = c ? await (await c.fetch("/user")).json() : null;
    const saved = await ctx.saveSource({ uri: "probe:note/" + a.n, title: "记一笔", text: "第 " + a.n + " 次" });
    return [ctx.userId, JSON.stringify(await ctx.store.get("visits", "last")), body?.name ?? "未连接", saved.created].join(" | ");
  } });
  api.platform({ provider: "connect-probe", readers: [{ kind: "file", label: "文件", id: "key", read: async (c, id) => {
    const f = await (await c.fetch("/v1/files/" + id)).json();
    return { title: f.name, text: "读到了 " + id };
  } }] });
}
`,
  );
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  createUser(app, { name: "小安", id: "ann" });
  const ctx = (user: string) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: `personal-${user}`, spaces: null, tools: null, actor: "agent", userId: user }))!;
  const call = async (user: string, name: string, args: Record<string, unknown>) => (await callTool(ctx(user), name, args)).text;

  it("runs trusted code in its own process by default", async () => {
    const d = await trustPlugin(app, "probe2");
    expect(d.runMode).toBe("isolated");
    expect(toolList().find((t) => t.name === "probe2_me")).toBeTruthy();
    expect(describePlugin(getPlugin("probe2")).permissions.platforms).toEqual(["connect-probe"]);
  });

  it("cannot read omem's secrets or start programs", async () => {
    expect(await call("ann", "probe2_secret", { path: join(app.home, "secrets", "vault.key") })).toBe("拒绝：ERR_ACCESS_DENIED");
    expect(await call("ann", "probe2_secret", { path: join(app.home, "config.json") })).toBe("拒绝：ERR_ACCESS_DENIED");
    expect(await call("ann", "probe2_exec", {})).toBe("拒绝：ERR_ACCESS_DENIED");
    // Its arguments are checked by its own schema.
    expect(await call("ann", "probe2_me", { n: "x" })).toMatch(/n:/);
  });

  it("asks omem for the person's records, connection and sources, as the person of the call", async () => {
    expect(await call("ann", "probe2_me", { n: 1 })).toBe('ann | {"n":1} | 未连接 | true');
    storeConnection(app, { userId: "ann", provider: "connect-github", accountId: "a", accountName: "小安", scopes: [], accessToken: "tok-ann", expiresIn: 3600 });
    expect(await call("ann", "probe2_me", { n: 2 })).toBe('ann | {"n":2} | 小安在示例平台 | true');
    // The token was added by omem; the plugin never had it.
    expect(seen.at(-1)).toEqual({ url: "https://api.github.com/user", auth: "Bearer tok-ann" });
    expect(one<{ space_id: string }>(app.db, "select space_id from sources where uri = 'probe:note/2'")?.space_id).toBe("personal-ann");
  });

  it("serves its platform readers to watches", async () => {
    storeConnection(app, { userId: "ann", provider: "connect-probe", accountId: "a", accountName: "小安", scopes: [], accessToken: "tok-probe", expiresIn: 3600 });
    // connect-probe is not a real connector: register the provider the reader builds on.
    const { registerLoginProvider } = await import("../src/auth/providers.ts");
    const undo = registerLoginProvider({ id: "connect-probe", label: "探针平台", channel: "probe", identity: false, unavailable: () => null, apiBase: "https://api.probe.test" });
    const { addWatch } = await import("../src/plugins/platforms.ts");
    addWatch(app, "ann", { provider: "connect-probe", kind: "file", target: "K9", spaceId: "personal-ann" });
    const r = await syncWatches(app, { force: true });
    expect(r.failed).toBe(0);
    expect(one<{ text: string }>(app.db, "select text from sources where uri = 'probe:file/K9'")?.text).toBe("读到了 K9");
    undo();
  });

  it("stops the process when trust is withdrawn", async () => {
    untrustPlugin(app, "probe2");
    expect(toolList().find((t) => t.name === "probe2_me")).toBeUndefined();
    expect((await callTool(ctx("ann"), "probe2_me", { n: 3 })).isError).toBe(true);
  });
});
