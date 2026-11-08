import { afterAll, describe, expect, it } from "vitest";
import { callTool, dropUnavailable, issueToolToken, toolContextForToken, toolList } from "../src/agents/tools.ts";
import { appConfig, setAppConfig } from "../src/auth/apps.ts";
import { connectWithCredentials } from "../src/auth/connections.ts";
import { beginLogin, completeLogin } from "../src/auth/login.ts";
import { canLogIn, loginProvider, loginProviders, setAuthFetchForTests } from "../src/auth/providers.ts";
import { findConnection, storeConnection } from "../src/auth/vault.ts";
import { one } from "../src/core/db.ts";
import { createUser, identitiesOf } from "../src/core/users.ts";
import { loadPlugins } from "../src/plugins/registry.ts";
import { testApp } from "./helpers.ts";

/**
 * The built-in connect plugin (docs/v2/connectors.md): Nango's catalog and the platforms written here
 * become connectors; identities can be bound, capabilities only keep a token; agents read through a
 * connection and keep what they read as sources.
 */
type Call = { url: string; method: string; headers: Headers; body: string };
const calls: Call[] = [];
const answers: [RegExp, (c: Call) => Response][] = [];
setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
  const c = { url: String(url), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
  calls.push(c);
  const a = answers.find(([re]) => re.test(c.url));
  return a ? a[1](c) : new Response("not found", { status: 404 });
}) as typeof fetch);
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const last = (re: RegExp) => [...calls].reverse().find((c) => re.test(c.url))!;

describe("connect plugin", async () => {
  const app = testApp();
  afterAll(() => setAuthFetchForTests(null));
  await loadPlugins(app);
  createUser(app, { name: "小安", id: "ann" });
  const connect = async (provider: string, code: string) => {
    const url = beginLogin(app, { provider, purpose: "connect", redirectUri: `https://omem.test/api/auth/${provider}/callback`, userId: "ann" });
    const state = new URL(url.split("#")[0]).searchParams.get("state")!;
    return { url, result: await completeLogin(app, { provider, state, code }) };
  };
  const ctx = () => toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal-ann", spaces: null, tools: null, actor: "agent", userId: "ann" }))!;

  it("registers the catalog as identities and capabilities", () => {
    const ids = loginProviders().map((p) => p.id);
    expect(ids.filter((id) => id.startsWith("connect-")).length).toBeGreaterThan(400);
    expect(canLogIn(loginProvider("connect-github")!)).toBe(true);
    expect(canLogIn(loginProvider("connect-dingtalk")!)).toBe(true);
    expect(canLogIn(loginProvider("connect-jira")!)).toBe(false);
    expect(loginProvider("connect-fireflies")?.credentials?.fields.map((f) => f.key)).toEqual(["apiKey"]);
    // Not usable before the owner fills in the app.
    expect(loginProvider("connect-github")!.unavailable(app)).toMatch(/Client ID/);
  });

  it("offers its tools only to someone with a connection", () => {
    const tool = toolList().find((t) => t.name === "connect_read")!;
    createUser(app, { name: "小陈", id: "chen" });
    expect(tool.available?.(app, "chen")).toBe(false);
    storeConnection(app, { userId: "chen", provider: "connect-gitee", accountId: "g", accountName: "小陈", scopes: [], accessToken: "t" });
    expect(tool.available?.(app, "chen")).toBe(true);
    const names = new Set(["connect_read", "search"]);
    dropUnavailable(app, "nobody", names);
    expect([...names]).toEqual(["search"]);
  });

  it("keeps the owner's app settings in secrets, and asks for them on the authorization page", async () => {
    setAppConfig(app, "connect-github", { clientId: "gh-id", clientSecret: "gh-secret" });
    expect(appConfig(app, "connect-github")).toEqual({ clientId: "gh-id", clientSecret: "gh-secret" });
    expect(loginProvider("connect-github")!.unavailable(app)).toBeNull();
    expect(() => setAppConfig(app, "connect-github", { nope: "x" })).toThrow(/没有配置项/);
    answers.push([/github\.com\/login\/oauth\/access_token/, () => new Response("access_token=gt1&scope=read%3Auser&token_type=bearer")]);
    answers.push([/api\.github\.com\/user$/, () => json({ id: 42, login: "ann-gh", name: "Ann" })]);
    const { url } = await connect("connect-github", "c-gh");
    const q = new URL(url).searchParams;
    expect(q.get("client_id")).toBe("gh-id");
    expect(q.get("scope")).toBe("read:user");
    expect(q.get("code_challenge_method")).toBe("S256");
    const tok = last(/access_token$/);
    expect(new URLSearchParams(tok.body).get("client_secret")).toBe("gh-secret");
    expect(new URLSearchParams(tok.body).get("code_verifier")).toBeTruthy();
    // An identity: bound to the account under the platform's own id, not the login name.
    expect(identitiesOf(app, "ann").some((i) => i.channel === "github" && i.external_id === "42")).toBe(true);
    expect(findConnection(app, "ann", "connect-github")?.accountName).toBe("Ann");
  });

  it("connects a capability without recording an identity, and never logs in with it", async () => {
    setAppConfig(app, "connect-jira", { clientId: "j-id", clientSecret: "j-secret" });
    answers.push([/auth\.atlassian\.com\/oauth\/token/, () => json({ access_token: "jt1", refresh_token: "jr1", expires_in: 3600, scope: "read:jira-work" })]);
    const { url, result } = await connect("connect-jira", "c-j");
    expect(new URL(url).searchParams.get("scope")).toContain("read:jira-work");
    expect(result).toMatchObject({ kind: "bound", connected: true });
    expect(findConnection(app, "ann", "connect-jira")?.status).toBe("active");
    expect(identitiesOf(app, "ann").some((i) => i.channel === "jira")).toBe(false);
    expect(() => beginLogin(app, { provider: "connect-jira", purpose: "login", redirectUri: "https://omem.test/cb" })).toThrow(/只用来连接/);
  });

  it("follows platforms that name things their own way (DingTalk: JSON, camelCase, its own token header)", async () => {
    setAppConfig(app, "connect-dingtalk", { clientId: "dk", clientSecret: "ds" });
    answers.push([/userAccessToken$/, () => json({ accessToken: "dt1", refreshToken: "dr1", expireIn: 7200 })]);
    answers.push([/contact\/users\/me$/, () => json({ unionId: "union-1", nick: "安" })]);
    const { url } = await connect("connect-dingtalk", "c-d");
    expect(new URL(url).searchParams.get("client_id")).toBe("dk");
    expect(JSON.parse(last(/userAccessToken$/).body)).toEqual({ grantType: "authorization_code", code: "c-d", clientId: "dk", clientSecret: "ds" });
    expect(last(/users\/me$/).headers.get("x-acs-dingtalk-access-token")).toBe("dt1");
    expect(identitiesOf(app, "ann").some((i) => i.channel === "dingtalk" && i.external_id === "union-1")).toBe(true);
  });

  it("connects with a key, checked with the platform's own call", async () => {
    answers.push([/api\.fireflies\.ai\/graphql\?/, (c) => (c.headers.get("authorization") === "Bearer ff-ok" ? json({ data: {} }) : json({ errors: [] }, 401))]);
    await expect(connectWithCredentials(app, "ann", "connect-fireflies", { apiKey: "ff-bad" })).rejects.toThrow(/没有接受/);
    await connectWithCredentials(app, "ann", "connect-fireflies", { apiKey: "ff-ok" });
    expect(findConnection(app, "ann", "connect-fireflies")?.status).toBe("active");
  });

  it("lets agents read through a connection, only reading", async () => {
    answers.push([/api\.fireflies\.ai\/graphql$/, () => json({ data: { user: { name: "Ann" } } })]);
    expect((await callTool(ctx(), "connect_list", {})).text).toMatch(/fireflies/);
    const r = await callTool(ctx(), "connect_request", { provider: "fireflies", method: "POST", path: "/graphql", body: { query: "{ user { name } }" } });
    expect(r.text).toMatch(/HTTP 200/);
    expect(r.text).toMatch(/"Ann"/);
    expect(last(/fireflies\.ai\/graphql$/).headers.get("authorization")).toBe("Bearer ff-ok");
    const n = calls.length;
    expect((await callTool(ctx(), "connect_request", { provider: "fireflies", method: "POST", path: "/graphql", body: { query: "mutation { deleteTranscript(id: 1) }" } })).text).toMatch(/只能读/);
    expect((await callTool(ctx(), "connect_request", { provider: "jira", method: "POST", path: "/ex/jira/1/rest/api/3/issue", body: {} })).text).toMatch(/只能读/);
    expect((await callTool(ctx(), "connect_request", { provider: "fireflies", path: "https://evil.example/x" })).text).toMatch(/只能请求/);
    expect(calls.length).toBe(n);
    expect((await callTool(ctx(), "connect_request", { provider: "notion", path: "/v1/users/me" })).isError).toBe(true);
  });

  it("keeps what it read as a source, the same platform id updating it", async () => {
    const save = (text: string) => callTool(ctx(), "connect_save", { provider: "jira", id: "ACME-12", title: "ACME-12 退款失败", text, url: "https://acme.atlassian.net/browse/ACME-12" });
    expect((await save("正文一")).text).toMatch(/已新建/);
    expect((await save("正文一")).text).toMatch(/没有变化/);
    expect((await save("正文二")).text).toMatch(/已更新/);
    const row = one<{ origin_key: string; space_id: string }>(app.db, "select origin_key, space_id from sources where uri = ?", "jira:ACME-12")!;
    expect(row).toEqual({ origin_key: "jira:ACME-12", space_id: "personal-ann" });
  });
});
