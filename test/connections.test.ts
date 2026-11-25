import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { releaseAll } from "../src/agents/sessions.ts";
import { accessToken, disconnect, renewConnections } from "../src/auth/connections.ts";
import { grantedFeatures, scopesFor } from "../src/auth/features.ts";
import { asLarkUser, larkCliAs } from "../src/auth/lark-user.ts";
import { asOwner } from "../src/channels/lark-auth.ts";
import { personalLibrary } from "../src/channels/lark-wiki.ts";
import { setAuthFetchForTests } from "../src/auth/providers.ts";
import { findConnection, storeConnection } from "../src/auth/vault.ts";
import { larkCli, LarkScopeError, setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { captureSpace } from "../src/core/capture-space.ts";
import { one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser, linkIdentity } from "../src/core/users.ts";
import { boot } from "../src/main.ts";

let refreshCalls = 0;
setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith("/open-apis/authen/v2/oauth/token")) {
    const b = JSON.parse(String(init?.body));
    if (b.grant_type === "refresh_token") {
      refreshCalls++;
      // As Feishu answers (checked with a made-up token): OAuth's invalid_grant with its own code.
      if (b.refresh_token === "rt_dead") return new Response(JSON.stringify({ error: "invalid_grant", error_description: "The refresh token provided is invalid.", code: 20026 }), { status: 400 });
      if (b.refresh_token === "rt_flaky") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ code: 0, access_token: `at_new${refreshCalls}`, refresh_token: `rt_new${refreshCalls}`, expires_in: 7200, refresh_token_expires_in: 604800, scope: "offline_access" }));
    }
    return new Response(JSON.stringify({ code: 0, access_token: "at_ann", refresh_token: "rt_ann", expires_in: 7200, refresh_token_expires_in: 604800, scope: "offline_access im:chat:read im:message:readonly" }));
  }
  if (u.endsWith("/open-apis/authen/v1/user_info")) return new Response(JSON.stringify({ code: 0, data: { open_id: "ou_ann", union_id: "on_ann", name: "小安", tenant_key: "t1" } }));
  return new Response("not found", { status: 404 });
}) as typeof fetch);

describe("connections", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-conn-"));
  process.env.OMEM_TEST_LARK_SECRET2 = "test-secret";
  writeFileSync(join(home, "config.json"), JSON.stringify({
    webUrl: "http://omem.test",
    lark: { appId: "cli_test", appSecretEnv: "OMEM_TEST_LARK_SECRET2", ownerOpenId: "ou_owner" },
    auth: { enabled: true },
    agents: { default: "fake", profiles: [{ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" } }] },
  }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    setLarkCliForTests(null);
    releaseAll();
    server.close();
  });
  const base = app.baseUrl!;
  createUser(app, { name: "小安", id: "ann" });
  linkIdentity(app, "ann", "lark", "ou_ann");
  const remote = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { "x-forwarded-for": "203.0.113.9", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string>) } });

  it("keeps tokens encrypted, outside the main database", () => {
    storeConnection(app, { userId: "owner", provider: "test", accountId: "x", accountName: "x", scopes: [], accessToken: "secret-access-token", refreshToken: "secret-refresh-token", expiresIn: 3600 });
    const raw = readFileSync(join(home, "secrets", "vault.db"));
    expect(raw.includes(Buffer.from("secret-access-token"))).toBe(false);
    expect(one(app.db, "select name from sqlite_master where name = 'connections'")).toBeUndefined();
  });

  it("connects a feature: just its scopes on the authorization page, the tokens kept", async () => {
    // Log in first (no scopes: nothing kept).
    const start = await remote("/api/auth/lark/start");
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await remote(`/api/auth/lark/callback?code=c&state=${state}`);
    const cookie = /omem_sid=([^;]+)/.exec(cb.headers.get("set-cookie") ?? "")![1];
    expect(findConnection(app, "ann", "lark")).not.toBeNull(); // the fake token brings scopes, so it is kept

    const connect = await remote("/api/auth/lark/start?purpose=connect&features=messages", { cookie: `omem_sid=${cookie}` });
    const to = new URL(connect.headers.get("location")!);
    expect(to.search).not.toContain("+");
    const asked = to.searchParams.get("scope")!.split(" ");
    expect(asked).toEqual(expect.arrayContaining([...scopesFor("lark", ["messages"])]));
    expect(asked).toContain("offline_access");
    expect(asked).not.toContain("docx:document:write_only");
    const back = await remote(`/api/auth/lark/callback?code=c2&state=${to.searchParams.get("state")}`, { cookie: `omem_sid=${cookie}` });
    expect(decodeURIComponent(new URL(back.headers.get("location")!).hash)).toBe("#/account?connected=lark");
    const list = await (await remote("/api/auth/connections", { cookie: `omem_sid=${cookie}` })).json();
    const lark = list.connections.find((c: { provider: string }) => c.provider === "lark");
    expect(lark.background).toBe(true);
    expect(lark.features.find((f: { id: string }) => f.id === "messages").on).toBe(false); // the fake grants only two of its scopes
    expect(lark.scopes).toEqual(expect.arrayContaining(["offline_access", "im:chat:read"]));
    // A viewer may not connect platforms.
    const { setUserRole } = await import("../src/core/users.ts");
    setUserRole(app, "ann", "viewer");
    const refused = await remote("/api/auth/lark/start?purpose=connect&features=docs", { cookie: `omem_sid=${cookie}` });
    expect(decodeURIComponent(new URL(refused.headers.get("location")!).hash)).toMatch(/^#\/account\?error=/);
    setUserRole(app, "ann", "member");
  });

  it("refreshes a token about to run out, once for calls at the same time", async () => {
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: ["offline_access"], accessToken: "at_old", refreshToken: "rt_ok", expiresIn: 60, refreshExpiresIn: 604800 });
    refreshCalls = 0;
    const [a, b] = await Promise.all([accessToken(app, "ann", "lark"), accessToken(app, "ann", "lark")]);
    expect(a).toBe("at_new1");
    expect(b).toBe("at_new1");
    expect(refreshCalls).toBe(1);
    expect(await accessToken(app, "ann", "lark")).toBe("at_new1");
  });

  it("the peer command `connections` lists without tokens and checks a refresh against Feishu", async () => {
    const { runPeerCommand } = await import("../src/core/peer-exec.ts");
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: scopesFor("lark", ["calendar"]), accessToken: "at_old", refreshToken: "rt_ok", expiresIn: 60, refreshExpiresIn: 604800 });
    const list = (await runPeerCommand(app, "connections", {})) as any;
    const ann = list.connections.find((c: { user: string }) => c.user === "ann");
    expect(ann).toMatchObject({ provider: "lark", status: "active", background: true });
    expect(ann.usable).toContain("calendar");
    expect(JSON.stringify(list)).not.toMatch(/at_old|rt_ok/);
    const checked = (await runPeerCommand(app, "connections", { check: "ann" })) as any;
    expect(checked.refreshed).toBe(true);
    expect(checked.whoami).toEqual({ name: "小安", sameAccount: true });
    expect(Date.parse(checked.after.expiresAt)).toBeGreaterThan(Date.parse(checked.before.expiresAt));
    expect(JSON.stringify(checked)).not.toMatch(/at_new|rt_new/);
    // Still fresh: no second refresh.
    expect(((await runPeerCommand(app, "connections", { check: "ann" })) as any).refreshed).toBe(false);
    await expect(runPeerCommand(app, "connections", { check: "nobody" })).rejects.toThrow(/没有连接/);
    await expect(runPeerCommand(app, "connections", { check: "../x" })).rejects.toThrow();
  });

  it("asks for the features ticked on the login page, and for nothing else without them", async () => {
    // Only what recognizes an account made ahead of time: the email; the enterprise email's scope only when the app has it.
    const { larkProvider } = await import("../src/auth/lark.ts");
    const real = larkProvider.grantedScopes;
    larkProvider.grantedScopes = async () => new Set(["contact:user.email:readonly"]);
    const plain = new URL((await remote("/api/auth/lark/start")).headers.get("location")!);
    expect(plain.searchParams.get("scope")!.split(" ").sort()).toEqual(["contact:user.email:readonly"]);
    larkProvider.grantedScopes = async () => new Set(["contact:user.email:readonly", "contact:user.employee:readonly"]);
    const both = new URL((await remote("/api/auth/lark/start")).headers.get("location")!);
    expect(both.searchParams.get("scope")!.split(" ").sort()).toEqual(["contact:user.email:readonly", "contact:user.employee:readonly"]);
    // The app's scopes cannot be read: the optional one is left out rather than risk a refused login.
    larkProvider.grantedScopes = async () => null;
    expect(new URL((await remote("/api/auth/lark/start")).headers.get("location")!).searchParams.get("scope")).toBe("contact:user.email:readonly");
    const ticked = new URL((await remote("/api/auth/lark/start?features=calendar")).headers.get("location")!);
    const asked = ticked.searchParams.get("scope")!.split(" ");
    expect(asked).toEqual(expect.arrayContaining([...scopesFor("lark", ["calendar"])]));
    expect(asked).toContain("offline_access");
    expect(asked).not.toContain("im:message:readonly");
    const docs = new URL((await remote("/api/auth/lark/start?features=docs")).headers.get("location")!);
    const originalDocScopes = ["docx:document:readonly", "docs:document.content:read", "wiki:node:read", "wiki:wiki:readonly", "drive:file:download"];
    expect(docs.searchParams.get("scope")!.split(" ").sort()).toEqual([
      ...originalDocScopes, "search:docs:read", "wiki:node:retrieve", "wiki:space:retrieve", "wiki:space:read", "space:document:retrieve", "drive:drive.metadata:readonly",
      "docs:document.media:download", "board:whiteboard:node:read", "docs:permission.member:auth", "offline_access", "contact:user.email:readonly",
    ].sort());
    expect(grantedFeatures("lark", originalDocScopes)).not.toContain("docs");
    expect(grantedFeatures("lark", [...originalDocScopes, "search:docs:read"])).toContain("docs");
    const write = new URL((await remote("/api/auth/lark/start?features=doc-write")).headers.get("location")!);
    expect(write.searchParams.get("scope")!.split(" ").sort()).toEqual([
      "docx:document:readonly", "wiki:node:read", "wiki:node:retrieve", "wiki:space:read", "drive:drive.metadata:readonly",
      "docx:document:create", "docx:document:write_only", "docs:document.media:upload", "wiki:node:create", "wiki:node:move", "wiki:node:copy", "space:document:move",
      "offline_access", "contact:user.email:readonly",
    ].sort());
    // The login page lists what can be ticked (background access comes along, not listed).
    const session = await (await remote("/api/auth/session")).json();
    expect(session.login.providers[0].features.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(["messages", "calendar"]));
    expect(session.login.providers[0].features.map((f: { id: string }) => f.id)).not.toContain("offline");
    larkProvider.grantedScopes = real;
  });

  it("登录页勾的“存进 omem”在授权回来时生效，只改勾了功能的那几项；读过的文档关掉后不再搜", async () => {
    const { pollMembers } = await import("../src/channels/lark-member-capture.ts");
    const { findUser, updateUser } = await import("../src/core/users.ts");
    const original = findUser(app, "ann")?.settings.larkCapture;
    const login = await remote("/api/auth/lark/start?features=messages,docs&capture=group");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    await remote(`/api/auth/lark/callback?code=c&state=${state}`);
    const before = findUser(app, "ann")!.settings.larkCapture;
    onTestFinished(() => {
      updateUser(app, "ann", { settings: { larkCapture: original ?? {} } });
      run(app.db, "delete from kv where key like 'lark_recent_doc%' or key in ('lark_calendar_at:ann', 'lark_minutes_at:ann')");
      disconnect(app, "ann", "lark");
    });
    expect(before).toMatchObject({ group: true, docs: false });
    expect(before?.p2p).toBeUndefined();
    expect(one(app.db, "select 1 from kv where key = ?", `auth_capture:${state}`)).toBeUndefined();
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: scopesFor("lark", ["docs"]), accessToken: "at_ann6", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const calls: string[][] = [];
    setLarkCliForTests(async (args) => {
      if (args.includes("--help")) return "Risk: read";
      calls.push(args);
      return { ok: true, data: { results: [], has_more: false } };
    });
    await pollMembers(app);
    expect(calls.some((a) => a.includes("+search"))).toBe(false);
    updateUser(app, "ann", { settings: { larkCapture: { ...before, docs: true } } });
    await pollMembers(app);
    expect(calls.some((a) => a.includes("+search"))).toBe(true);
  });

  it("does not use a feature turned off in omem, though Feishu still grants it; nor an account waiting for approval", async () => {
    const { pollMembers } = await import("../src/channels/lark-member-capture.ts");
    const { callTool } = await import("../src/agents/tools.ts");
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: scopesFor("lark", ["messages", "calendar"]), accessToken: "at_ann5", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    createUser(app, { name: "小波", id: "bob", status: "pending" });
    storeConnection(app, { userId: "bob", provider: "lark", accountId: "on_bob", accountName: "小波", scopes: scopesFor("lark", ["messages"]), accessToken: "at_bob", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const calls: { args: string[]; as?: string }[] = [];
    setLarkCliForTests(async (args, _cwd, as) => {
      if (args.includes("--help")) return "Risk: read";
      calls.push({ args, as });
      return { ok: true, data: { chats: [], events: [] } };
    });
    // Turned off through the account page's switch.
    const login = await remote("/api/auth/lark/start");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    const cookie = `omem_sid=${/omem_sid=([^;]+)/.exec((await remote(`/api/auth/lark/callback?code=c&state=${state}`)).headers.get("set-cookie") ?? "")![1]}`;
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: scopesFor("lark", ["messages", "calendar"]), accessToken: "at_ann5", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const off = await remote("/api/auth/connections/lark/features/messages", { method: "PUT", cookie, headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ on: false }) });
    expect(off.status).toBe(200);
    const messages = (await off.json()).connections[0].features.find((f: { id: string }) => f.id === "messages");
    expect(messages).toMatchObject({ on: true, paused: true });
    onTestFinished(() => {
      disconnect(app, "ann", "lark");
      run(app.db, "delete from kv where key in ('lark_calendar_at:ann', 'lark_minutes_at:ann')");
    });
    await pollMembers(app);
    expect(calls.some((c) => c.as === "ann" && c.args.includes("+chat-list"))).toBe(false);
    expect(calls.some((c) => c.as === "ann" && c.args.includes("+agenda"))).toBe(true); // calendar is still on
    expect(calls.some((c) => c.as === "bob")).toBe(false); // waiting for approval: nothing read as them
    const ctx = { app, runId: null, spaceId: "personal-ann", spaces: null, tools: null, actor: "agent" as const, userId: "ann", larkChats: [] };
    const refused = await callTool(ctx, "lark_read", { command: ["im", "+chat-list"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("关掉了「群聊消息」");
    expect((await callTool(ctx, "lark_read", { command: ["calendar", "+agenda"] })).isError).toBe(false);
    // Back on: used again at once.
    await remote("/api/auth/connections/lark/features/messages", { method: "PUT", cookie, headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ on: true }) });
    expect((await callTool(ctx, "lark_read", { command: ["im", "+chat-list"] })).isError).toBe(false);
    expect((await remote("/api/auth/connections/lark/features/offline", { method: "PUT", cookie, headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ on: false }) })).status).toBe(400);
  });

  it("asks the person to authorize again when refreshing fails, and tells them once", async () => {
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: [], accessToken: "at_old", refreshToken: "rt_dead", expiresIn: 60, refreshExpiresIn: 3600 });
    await expect(accessToken(app, "ann", "lark")).rejects.toThrow(/重新授权/);
    await expect(accessToken(app, "ann", "lark")).rejects.toThrow(/重新授权/);
    expect(findConnection(app, "ann", "lark")!.status).toBe("expired");
    expect(one<{ n: number }>(app.db, "select count(*) n from notifications where user_id = 'ann' and title like '%重新授权%'")!.n).toBe(1);
    expect((await renewConnections(app)).lost).toBe(0); // expired ones are not retried
  });

  it("keeps the connection when refreshing fails for another reason, and tries again later", async () => {
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: [], accessToken: "at_old", refreshToken: "rt_flaky", expiresIn: 60, refreshExpiresIn: 3600 });
    const before = one<{ n: number }>(app.db, "select count(*) n from notifications where user_id = 'ann'")!.n;
    await expect(accessToken(app, "ann", "lark")).rejects.toThrow(/稍后再试/);
    expect(findConnection(app, "ann", "lark")!.status).toBe("active");
    expect((await renewConnections(app)).lost).toBe(0);
    expect(findConnection(app, "ann", "lark")!.status).toBe("active");
    expect(one<{ n: number }>(app.db, "select count(*) n from notifications where user_id = 'ann'")!.n).toBe(before);
  });

  it("runs lark-cli with the person's own token, never the owner's login in their place", async () => {
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: ["im:chat:read"], accessToken: "at_ann2", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const seen: (string | undefined)[] = [];
    setLarkCliForTests(async (args, _cwd, as) => {
      seen.push(as);
      if (args.includes("+chat-list")) throw new LarkScopeError(["im:chat:read:extra"], "缺少权限");
      return { ok: true, data: {} };
    });
    await larkCliAs(app, "ann", ["im", "+messages-search", "--as", "user"]);
    await larkCliAs(app, "owner", ["im", "+messages-search", "--as", "user"]);
    expect(seen).toEqual(["ann", undefined]);
    createUser(app, { name: "小陈", id: "chen" });
    await expect(larkCliAs(app, "chen", ["im", "+messages-search"])).rejects.toThrow(/还没有连接飞书/);
    await expect(asLarkUser(app, "ann", () => asOwner(app, "读消息", () => larkCli(["im", "+chat-list", "--as", "user"])))).rejects.toThrow(/授权链接：http:\/\/omem\.test\/#\/login\?provider=lark&scopes=im%3Achat%3Aread%3Aextra/);
    const n = one<{ link: string }>(app.db, "select link from notifications where user_id = 'ann' order by rowid desc limit 1")!;
    expect(n.link).toBe("http://omem.test/#/login?provider=lark&scopes=im%3Achat%3Aread%3Aextra");
    // Everything inside a person's context runs as them, and caches stay per person.
    setLarkCliForTests(async (args, _cwd, as) => (args.includes("spaces") ? { ok: true, data: { space: { space_id: as ? `lib_${as}` : "lib_owner" } } } : { ok: true }));
    expect(await personalLibrary(app)).toBe("lib_owner");
    expect(await asLarkUser(app, "ann", () => personalLibrary(app))).toBe("lib_ann");
  });

  it("runs a member's tool calls on Feishu as the member", async () => {
    const { callTool, contextToolNames, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
    const seen: (string | undefined)[] = [];
    setLarkCliForTests(async (args, _cwd, as) => {
      if (args.includes("--help")) return "Risk: read";
      seen.push(as);
      return { ok: true, data: { chats: [] } };
    });
    const ctx = (user: string) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: `personal-${user}`, spaces: null, tools: null, actor: "agent", userId: user, larkChats: [] }))!;
    createUser(app, { name: "小周", id: "zhou" });
    const refused = await callTool(ctx("zhou"), "lark_read", { command: ["im", "+chat-list"] });
    expect(refused.text).toMatch(/还没有连接飞书/);
    expect(refused.text).toContain("http://omem.test/#/login?provider=lark&features=messages");
    expect(seen).toEqual([]);
    storeConnection(app, { userId: "zhou", provider: "lark", accountId: "on_zhou", accountName: "小周", scopes: scopesFor("lark", ["messages", "docs", "doc-write"]), accessToken: "at_zhou", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const member = ctx("zhou");
    const directory = contextToolNames(member);
    createUser(app, { name: "观察者", id: "observer", role: "observer" });
    const limited = ctx("observer");
    const limitedDirectory = contextToolNames(limited);
    for (const name of ["lark_read", "lark_doc_fetch", "lark_doc_create", "lark_doc_update", "lark_doc_move", "lark_doc_copy"]) {
      expect(directory.has(name)).toBe(true);
      expect(limitedDirectory.has(name)).toBe(false);
      expect(await callTool(limited, name, {})).toMatchObject({ deniedCapability: "connector.use" });
    }
    for (const name of ["lark_write", "lark_invite", "lark_doc_authorize"]) {
      expect(directory.has(name)).toBe(false);
      expect(await callTool(member, name, {})).toMatchObject({ isError: true, deniedCapability: "owner" });
    }
    const doc = "https://tenant.larkoffice.com/docx/abc";
    for (const name of ["lark_doc_fetch", "lark_doc_update"]) {
      const result = await callTool(member, name, { doc, identity: "bot", command: "append", content: "进度" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("自己的飞书连接");
    }
    for (const user of ["zhou", "owner"]) {
      expect((await callTool(ctx(user), "lark_read", { command: ["im", "+chat-list"] })).isError).toBe(false);
    }
    expect(seen).toEqual(["zhou", undefined]);
  });

  it("checks Drive document ownership and asks the member to approve shared edits", async () => {
    const { callTool } = await import("../src/agents/tools.ts");
    const ctx = { app, runId: null, spaceId: "personal-ann", spaces: null, tools: null, actor: "agent" as const, userId: "ann", larkChats: [] };
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: scopesFor("lark", ["docs", "doc-write"]), accessToken: "at_ann", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const writes: string[] = [];
    setLarkCliForTests(async (args, _cwd, as) => {
      expect(as).toBe("ann");
      if (args.includes("+node-get")) throw new Error("131014 not mounted in wiki");
      if (args.includes("batch_query")) {
        const { request_docs } = JSON.parse(args[args.indexOf("--data") + 1]);
        return { data: { metas: [{ owner_id: request_docs[0].doc_token === "Mine" ? "ou_ann" : "ou_owner" }] } };
      }
      if (args.includes("+update")) writes.push(args[args.indexOf("--doc") + 1]);
      return { ok: true, data: {} };
    });
    const edit = (doc: string) => callTool(ctx, "lark_doc_update", { doc, command: "append", content: "进度" });
    const mine = "https://tenant.larkoffice.com/docx/Mine";
    const shared = "https://tenant.larkoffice.com/docx/Shared";
    const waitSeconds = app.config.approvals.waitSeconds;
    app.config.approvals.waitSeconds = 0;
    onTestFinished(() => { app.config.approvals.waitSeconds = waitSeconds; });
    expect((await edit(mine)).text).toContain("已编辑");
    expect((await edit(shared)).text).toContain("批准");
    expect(writes).toEqual([mine]);
    expect(one(app.db, "select user_id from asks where tool = 'lark_doc_update' and status = 'pending'")).toEqual({ user_id: "ann" });
  });

  it("a member without Feishu gets a link with what is missing ticked; once granted, the conversation goes on by itself", async () => {
    const { callTool } = await import("../src/agents/tools.ts");
    const { createRun } = await import("../src/agents/runs.ts");
    const { connectionGranted } = await import("../src/auth/connect-wait.ts");
    const { createThread } = await import("../src/agents/threads.ts");
    createUser(app, { name: "小吴", id: "wu" });
    const thread = createThread(app, { spaceId: "personal-wu", channel: "lark", userId: "wu" });
    const r = createRun(app, { kind: "agent", spaceId: "personal-wu", title: "改文档", input: { conversationId: thread.id }, userId: "wu" });
    const refused = await callTool({ app, runId: r.id, spaceId: "personal-wu", spaces: null, tools: null, actor: "agent", userId: "wu", larkChats: [] }, "lark_doc_update", { doc: "https://tenant.larkoffice.com/docx/abc", command: "append", content: "进度" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("http://omem.test/#/login?provider=lark&features=doc-write");
    expect(refused.text).toContain("自动接着做");
    // Granted something else: still waiting. Granted what was asked: an [授权] turn in that conversation.
    storeConnection(app, { userId: "wu", provider: "lark", accountId: "on_wu", accountName: "小吴", scopes: scopesFor("lark", ["calendar"]), accessToken: "at_wu", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    connectionGranted(app, "wu", "lark");
    const said = () => one<{ text: string }>(app.db, "select text from messages where conversation_id = ? and text like '[授权]%'", thread.id)?.text;
    await new Promise((res) => setTimeout(res, 50));
    expect(said()).toBeUndefined();
    storeConnection(app, { userId: "wu", provider: "lark", accountId: "on_wu", accountName: "小吴", scopes: scopesFor("lark", ["doc-write"]), accessToken: "at_wu2", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    connectionGranted(app, "wu", "lark");
    await new Promise((res) => setTimeout(res, 50));
    expect(said()).toContain("小吴已在飞书完成授权");
    expect(one(app.db, "select 1 from kv where key = 'connect_wait:wu'")).toBeUndefined();
  });

  it("offers the full sheets feature to a connected member and resumes on the required scope", async () => {
    const { callTool } = await import("../src/agents/tools.ts");
    const { createRun } = await import("../src/agents/runs.ts");
    const { connectionGranted } = await import("../src/auth/connect-wait.ts");
    const { createThread } = await import("../src/agents/threads.ts");
    const userId = "sheet-reader", spaceId = "personal-sheet-reader";
    createUser(app, { name: "小许", id: userId });
    const thread = createThread(app, { spaceId, channel: "lark", userId });
    const r = createRun(app, { kind: "agent", spaceId, title: "读表格", input: { conversationId: thread.id }, userId });
    const grant = (scopes: string[]) => storeConnection(app, { userId, provider: "lark", accountId: "on_xu", accountName: "小许", scopes, accessToken: "at_xu", refreshToken: "rt_ok", expiresIn: 7200 });
    const missing = "sheets:spreadsheet:read";
    grant(["offline_access"]);
    setLarkCliForTests(async (args) => {
      if (args.includes("--help")) return "Risk: read";
      throw new LarkScopeError(["sheets:spreadsheet", missing], "缺少权限");
    });
    onTestFinished(() => setLarkCliForTests(null));
    const ctx = { app, runId: r.id, spaceId, spaces: null, tools: null, actor: "agent" as const, userId, larkChats: [] };
    const read = () => callTool(ctx, "lark_read", { command: ["sheets", "+workbook-info", "--spreadsheet-token", "example"] });
    const link = "http://omem.test/#/login?provider=lark&features=sheets";
    for (let i = 0; i < 2; i++) {
      const refused = await read();
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(`授权链接：${link}。`);
    }
    const notices = () => app.db.prepare("select link from notifications where user_id = ?").all(userId);
    expect(notices()).toEqual([{ link }]);
    const login = new URL((await remote(`/api/auth/lark/start?${new URL(link).hash.split("?")[1]}`)).headers.get("location")!);
    expect(login.searchParams.get("scope")!.split(" ").sort()).toEqual([...scopesFor("lark", ["sheets"]), "contact:user.email:readonly"].sort());
    grant(["base:record:read"]);
    connectionGranted(app, userId, "lark");
    const pending = () => one(app.db, "select 1 from kv where key = ?", `connect_wait:${userId}`);
    expect(pending()).toBeDefined();
    grant([missing]);
    connectionGranted(app, userId, "lark");
    expect(pending()).toBeUndefined();
    await expect.poll(() => one(app.db, "select 1 from messages where conversation_id = ? and text like '[授权]%'", thread.id)).toBeDefined();
    expect((await read()).text).toContain(`当前连接已授权 ${missing}`);
    expect(notices()).toEqual([{ link }]);
  });

  it("uses the relevant member feature for other CLI domains and leaves uncatalogued scopes specific", async () => {
    const { callTool } = await import("../src/agents/tools.ts");
    const { setFeatureOff } = await import("../src/auth/connections.ts");
    const userId = "cli-reader", spaceId = "personal-cli-reader";
    createUser(app, { name: "小何", id: userId });
    storeConnection(app, { userId, provider: "lark", accountId: "on_he", accountName: "小何", scopes: ["offline_access"], accessToken: "at_he", refreshToken: "rt_ok", expiresIn: 7200 });
    let missing: string[];
    setLarkCliForTests(async (args) => {
      if (args.includes("--help")) return "Risk: read";
      throw new LarkScopeError(missing, "缺少权限");
    });
    onTestFinished(() => setLarkCliForTests(null));
    const ctx = { app, runId: null, spaceId, spaces: null, tools: null, actor: "agent" as const, userId, larkChats: [] };
    const read = (command: string[]) => callTool(ctx, "lark_read", { command });
    const cases = [
      { command: ["base", "+record-list"], scopes: ["base:record:read"], query: "features=sheets" },
      { command: ["calendar", "+agenda"], scopes: ["calendar:calendar.event:read"], query: "features=calendar" },
      { command: ["minutes", "+info"], scopes: ["minutes:minutes:readonly"], query: "features=minutes" },
      { command: ["wiki", "+node-get"], scopes: ["wiki:wiki", "wiki:node:read"], query: "features=docs" },
      { command: ["im", "+chat-list"], scopes: ["im:chat:readonly", "im:chat:read"], query: "features=messages" },
      { command: ["im", "+messages-search", "--chat-type=p2p"], scopes: ["im:message:readonly"], query: "features=messages-p2p" },
      { command: ["im", "+messages-mget"], scopes: ["im:message.p2p_msg:get_as_user"], query: "features=messages-p2p" },
      { command: ["im", "+messages-search"], scopes: ["search:message"], query: "scopes=search%3Amessage" },
      { command: ["task", "+list"], scopes: ["task:task:read"], query: "scopes=task%3Atask%3Aread" },
    ];
    for (const { command, scopes, query } of cases) {
      missing = scopes;
      expect((await read(command)).text).toContain(`授权链接：http://omem.test/#/login?provider=lark&${query}。`);
    }
    setFeatureOff(app, userId, "lark", "messages-p2p", true);
    missing = ["im:message.p2p_msg:get_as_user"];
    const paused = await read(["im", "+messages-mget"]);
    expect(paused.text).toContain("关掉了「单聊消息」");
    expect(paused.text).not.toContain("授权链接");
  });

  it("offers the read-only docs feature for a doc fetch and resumes old waits with the new scope", async () => {
    const { callTool } = await import("../src/agents/tools.ts");
    const { createRun } = await import("../src/agents/runs.ts");
    const { connectionGranted } = await import("../src/auth/connect-wait.ts");
    const { createThread } = await import("../src/agents/threads.ts");
    const userId = "doc-reader", spaceId = "personal-doc-reader";
    createUser(app, { name: "小林", id: userId });
    const thread = createThread(app, { spaceId, channel: "lark", userId });
    const legacy = createThread(app, { spaceId, channel: "lark", userId });
    const r = createRun(app, { kind: "agent", spaceId, title: "读文档", input: { conversationId: thread.id }, userId });
    const grant = (scopes: string[]) => storeConnection(app, { userId, provider: "lark", accountId: "on_lin", accountName: "小林", scopes, accessToken: "at_lin", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    grant(["offline_access"]);
    let missing = "docx:document";
    setLarkCliForTests(async () => { throw new LarkScopeError([missing], "缺少权限"); });
    onTestFinished(() => setLarkCliForTests(null));
    const read = () => callTool({ app, runId: r.id, spaceId, spaces: null, tools: null, actor: "agent", userId, larkChats: [] }, "lark_doc_fetch", { doc: "https://tenant.larkoffice.com/docx/abc" });
    const link = "http://omem.test/#/login?provider=lark&features=docs";
    for (const scope of ["docx:document", "docx:document:readonly"]) {
      missing = scope;
      const refused = await read();
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain(`授权链接：${link}。`);
      expect(refused.text).toContain("文档与知识库");
      expect(one(app.db, "select link from notifications where user_id = ? order by rowid desc limit 1", userId)).toEqual({ link });
    }
    const key = `connect_wait:${userId}`;
    const pending = () => JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? "[]");
    run(app.db, "update kv set value = ? where key = ?", JSON.stringify([...pending(), {
      conversationId: legacy.id, features: [], scopes: ["docx:document"], reason: "读取飞书文档缺少飞书权限 docx:document", at: new Date().toISOString(),
    }]), key);
    grant(["docx:document:write_only"]);
    connectionGranted(app, userId, "lark");
    expect(pending()).toHaveLength(2);
    grant(["docx:document:readonly"]);
    connectionGranted(app, userId, "lark");
    expect(pending()).toEqual([]);
    await expect.poll(() => [thread.id, legacy.id].map((id) => !!one(app.db, "select 1 from messages where conversation_id = ? and text like '[授权]%'", id))).toEqual([true, true]);
  });

  it("requests one combined card before copying a Wiki doc and resumes legacy copy waits", async () => {
    const { callTool } = await import("../src/agents/tools.ts");
    const { createRun } = await import("../src/agents/runs.ts");
    const { connectionGranted } = await import("../src/auth/connect-wait.ts");
    const { createThread } = await import("../src/agents/threads.ts");
    const userId = "wiki-copier", spaceId = "personal-wiki-copier";
    createUser(app, { name: "小李", id: userId });
    const thread = createThread(app, { spaceId, channel: "lark", userId });
    const legacy = createThread(app, { spaceId, channel: "lark", userId });
    const r = createRun(app, { kind: "agent", spaceId, title: "复制周报", input: { conversationId: thread.id }, userId });
    const grant = (scopes: string[]) => storeConnection(app, { userId, provider: "lark", accountId: "on_li", accountName: "小李", scopes, accessToken: "at_li", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    grant(["offline_access", "docx:document:write_only"]);
    const doc = "https://tenant.larkoffice.com/wiki/Test";
    const ctx = { app, runId: r.id, spaceId, spaces: null, tools: null, actor: "agent" as const, userId, larkChats: [] };
    const commands: string[][] = [];
    setLarkCliForTests(async (args) => { commands.push(args); throw new LarkScopeError(["docx:document"], "缺少权限"); });
    onTestFinished(() => setLarkCliForTests(null));
    const copy = () => callTool(ctx, "lark_doc_copy", { doc, target: "my_library", summary: "复制周报" });
    const link = "http://omem.test/#/login?provider=lark&features=doc-write";
    expect((await copy()).text).toContain(link);
    expect(commands).toEqual([]);
    expect((await callTool(ctx, "lark_doc_fetch", { doc })).text).toContain(link);
    expect((await copy()).text).toContain(link);
    expect(one(app.db, "select count(*) n, min(link) link from notifications where user_id = ?", userId)).toEqual({ n: 1, link });
    const key = `connect_wait:${userId}`;
    const pending = () => JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", key)?.value ?? "[]");
    run(app.db, "update kv set value = ? where key = ?", JSON.stringify([...pending(), {
      conversationId: legacy.id, features: [], scopes: ["wiki:wiki"], reason: "以本人身份复制飞书文档缺少飞书权限 wiki:wiki", at: new Date().toISOString(),
    }]), key);
    grant(scopesFor("lark", ["docs"]));
    connectionGranted(app, userId, "lark");
    expect(pending()).toHaveLength(2);
    grant(scopesFor("lark", ["doc-write"]));
    connectionGranted(app, userId, "lark");
    expect(pending()).toEqual([]);
    await expect.poll(() => [thread.id, legacy.id].map((id) => !!one(app.db, "select 1 from messages where conversation_id = ? and text like '[授权]%'", id))).toEqual([true, true]);
    await expect(asLarkUser(app, userId, () => asOwner(app, "复制文档", async () => {
      throw new LarkScopeError(["wiki:wiki", "wiki:node:copy"], "缺少权限");
    }, { feature: "doc-write", alternatives: ["wiki:node:copy", "wiki:wiki"] }))).rejects.toThrow(/当前连接已授权 wiki:node:copy/);
    expect(one(app.db, "select count(*) n from notifications where user_id = ?", userId)).toEqual({ n: 1 });
  });

  it("captures a member's own chats with their token, and does not read again what they can already see", async () => {
    const { captureForMember } = await import("../src/channels/lark-member-capture.ts");
    const { persistChatMessages, sourceMessages } = await import("../src/channels/lark-messages.ts");
    createSpace(app, { id: "team-chat", name: "团队群" });
    addMember(app, "team-chat", "ann", "reader");
    const t = Date.now() - 3600_000;
    const msg = (id: string, chat: string, text: string, i: number) => ({ message_id: id, chat_id: chat, msg_type: "text", content: text, create_time: String(t + i * 1000), sender: { id: i % 2 ? "ou_ann" : "ou_owner", name: i % 2 ? "小安" : "本人" } });
    // The owner captured both chats before: the group into a shared space, the private chat into their own.
    persistChatMessages(app, { chatId: "oc_team", spaceId: "team-chat", name: "团队", messages: [msg("om_t1", "oc_team", "周会改到周三", 0)] });
    const ownerCopy = persistChatMessages(app, { chatId: "oc_dm", spaceId: "personal", name: "和小安", messages: [msg("om_d1", "oc_dm", "你好", 0)] });
    const ownerText = one<{ text: string }>(app.db, "select text from sources where id = ?", ownerCopy.id!)!.text;
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: scopesFor("lark", ["messages", "messages-p2p"]), accessToken: "at_ann3", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const calls: { args: string[]; as?: string }[] = [];
    // Granted, but capture not turned on: nothing is read.
    setLarkCliForTests(async (args, _cwd, as) => (calls.push({ args, as }), { ok: true, data: { chats: [] } }));
    expect(await captureForMember(app, "ann")).toBe(0);
    expect(calls.some((c) => c.args.includes("+chat-list"))).toBe(false);
    const { setChatCapture } = await import("../src/auth/connections.ts");
    setChatCapture(app, "ann", { group: true, p2p: true });
    setLarkCliForTests(async (args, _cwd, as) => {
      calls.push({ args, as });
      if (args.includes("+chat-list")) return { ok: true, data: { chats: [{ chat_id: "oc_team", name: "团队", chat_mode: "group" }, { chat_id: "oc_dm", name: "和本人", chat_mode: "p2p" }] } };
      const chat = args[args.indexOf("--chat-id") + 1];
      return { ok: true, data: { has_more: false, messages: chat === "oc_dm" ? [msg("om_d1", "oc_dm", "你好", 0), msg("om_d2", "oc_dm", "在吗", 1)] : [msg("om_t2", "oc_team", "收到", 1)] } };
    });
    expect(await captureForMember(app, "ann")).toBe(2);
    expect(calls.every((c) => c.as === "ann")).toBe(true);
    // The group: not read (a copy is in a space ann reads); ann is recorded as seeing it.
    expect(calls.some((c) => c.args.includes("oc_team") && c.args.includes("+chat-messages-list"))).toBe(false);
    expect(one(app.db, "select 1 from source_viewers v join sources s on s.id = v.source_id where s.space_id = 'team-chat' and v.user_id = 'ann'")).toBeTruthy();
    // The private chat: ann's own copy in her space; the owner's copy is untouched.
    const annCopy = one<{ id: string }>(app.db, "select id from sources where uri = 'lark:oc_dm' and space_id = 'personal-ann'")!;
    expect(sourceMessages(app, annCopy.id).messages.map((m: { id: string }) => m.id)).toEqual(["om_d1", "om_d2"]);
    expect(one<{ text: string }>(app.db, "select text from sources where id = ?", ownerCopy.id!)!.text).toBe(ownerText);
    expect(sourceMessages(app, ownerCopy.id!).messages.map((m: { id: string }) => m.id)).toEqual(["om_d1"]);
    expect(one<{ origin_key: string }>(app.db, "select origin_key from sources where id = ?", annCopy.id)!.origin_key).toBe("lark:chat:oc_dm");
  });

  it("reads someone's calendar and minutes into their space, not what a shared space they read holds", async () => {
    const { captureForMember } = await import("../src/channels/lark-member-capture.ts");
    createSpace(app, { id: "weekly", name: "周会" });
    addMember(app, "weekly", "ann", "reader");
    const at = new Date().toISOString();
    // The owner's capture already put this meeting's minutes in a space ann reads.
    app.db.prepare("insert into sources(id,space_id,kind,uri,title,hash,text,captured_at,updated_at,origin_key) values('s_min','weekly','meeting','lark:minutes:obc_weekly','妙记：周会','h','',?,?,'lark:minutes:obc_weekly')").run(at, at);
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: scopesFor("lark", ["messages", "calendar", "minutes"]), accessToken: "at_ann4", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const calls: { args: string[]; as?: string }[] = [];
    setLarkCliForTests(async (args, _cwd, as) => {
      calls.push({ args, as });
      if (args.includes("+chat-list")) return { ok: true, data: { chats: [] } };
      if (args.includes("+agenda")) return { ok: true, data: { events: [{ event_id: "evt_a", summary: "和小王一对一", start_time: { date_time: at }, end_time: { date_time: at } }] } };
      if (args.includes("+search")) return { ok: true, data: { items: [{ minute_token: "obc_weekly", title: "周会" }, { minute_token: "obc_talk", title: "用户访谈" }] } };
      if (args.includes("+detail")) return { ok: true, data: { minutes: [{ title: "用户访谈", artifacts: { summary: "谈了退款流程" } }] } };
      return { ok: true, data: {} };
    });
    await captureForMember(app, "ann");
    expect(calls.every((c) => c.as === "ann")).toBe(true);
    expect(one(app.db, "select 1 from sources where uri = 'lark:calendar:evt_a' and space_id = 'personal-ann'")).toBeTruthy();
    expect(one<{ text: string }>(app.db, "select text from sources where uri = 'lark:minutes:obc_talk' and space_id = 'personal-ann'")!.text).toContain("谈了退款流程");
    // The weekly minutes: not read again, ann recorded as seeing the shared copy.
    expect(calls.filter((c) => c.args.includes("+detail")).map((c) => c.args[c.args.indexOf("--minute-tokens") + 1])).toEqual(["obc_talk"]);
    expect(one(app.db, "select 1 from source_viewers where source_id = 's_min' and user_id = 'ann'")).toBeTruthy();
    // Their own state: the owner's hourly checks are not used up.
    expect(one(app.db, "select 1 from kv where key = 'lark_calendar_at:ann'")).toBeTruthy();
    expect(one(app.db, "select 1 from kv where key = 'lark_calendar_at'")).toBeFalsy();
    expect(one(app.db, "select 1 from kv where key = 'lark_minutes_seen'")).toBeFalsy();
  });

  it("captures someone's chat into a space they may capture into, else their own", () => {
    createSpace(app, { id: "proj", name: "项目" });
    // The owner captured this private chat first, into the owner's personal space.
    app.db.prepare("insert into sources(id,space_id,kind,uri,title,hash,text,captured_at,updated_at) values('s_p2p','personal','chat','lark:oc_shared','私聊','h','',?,?)").run(new Date().toISOString(), new Date().toISOString());
    expect(captureSpace(app, "oc_shared")).toBe("personal");
    expect(captureSpace(app, "oc_shared", "ann")).toBe("personal-ann");
    app.db.prepare("insert into sources(id,space_id,kind,uri,title,hash,text,captured_at,updated_at) values('s_grp','proj','chat','lark:oc_group','群','h','',?,?)").run(new Date().toISOString(), new Date().toISOString());
    expect(captureSpace(app, "oc_group", "ann")).toBe("personal-ann");
    addMember(app, "proj", "ann", "editor");
    expect(captureSpace(app, "oc_group", "ann")).toBe("proj");
  });

  it("lets a colleague who is not a user grant their own Feishu from a link only they can complete", async () => {
    const { grantLink, guestUserId } = await import("../src/auth/grants.ts");
    // The fake Feishu says the authorizing person is ou_ann: a link made for someone else is refused.
    const other = new URL(grantLink(app, { openId: "ou_someone", name: "小周" }));
    expect(other.origin).toBe("http://omem.test");
    const go = await remote(other.pathname);
    const to = new URL(go.headers.get("location")!);
    expect(to.searchParams.get("scope")).toContain("offline_access");
    const refused = await remote(`/api/auth/lark/callback?code=c&state=${to.searchParams.get("state")}`);
    expect(decodeURIComponent(refused.headers.get("location") ?? "")).toContain("发给别人");
    expect(findConnection(app, guestUserId("ou_someone"), "lark")).toBeNull();
    // Theirs: kept like a member's connection, under their Feishu id.
    const mine = await remote(new URL(grantLink(app, { openId: "ou_ann", name: "小安" })).pathname);
    const state = new URL(mine.headers.get("location")!).searchParams.get("state")!;
    const done = await remote(`/api/auth/lark/callback?code=c&state=${state}`);
    expect(await done.text()).toContain("已授权");
    expect(findConnection(app, guestUserId("ou_ann"), "lark")).toMatchObject({ status: "active" });
    // An unknown or expired link says so.
    expect(await (await remote("/api/auth/lark/grant/nope")).text()).toContain("链接已失效");
  });
});
