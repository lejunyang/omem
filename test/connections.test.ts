import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { accessToken, renewConnections } from "../src/auth/connections.ts";
import { scopesFor } from "../src/auth/features.ts";
import { asLarkUser, larkCliAs } from "../src/auth/lark-user.ts";
import { asOwner } from "../src/channels/lark-auth.ts";
import { personalLibrary } from "../src/channels/lark-wiki.ts";
import { setAuthFetchForTests } from "../src/auth/providers.ts";
import { findConnection, storeConnection } from "../src/auth/vault.ts";
import { larkCli, LarkScopeError, setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { captureSpace } from "../src/core/capture-space.ts";
import { one } from "../src/core/db.ts";
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
      if (b.refresh_token === "rt_dead") return new Response(JSON.stringify({ code: 20064, error_description: "refresh token revoked" }), { status: 400 });
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
  writeFileSync(join(home, "config.json"), JSON.stringify({ webUrl: "http://omem.test", lark: { appId: "cli_test", appSecretEnv: "OMEM_TEST_LARK_SECRET2", ownerOpenId: "ou_owner" }, auth: { enabled: true } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    setLarkCliForTests(null);
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
    const asked = to.searchParams.get("scope")!.split(" ");
    expect(asked).toEqual(expect.arrayContaining([...scopesFor("lark", ["messages"])]));
    expect(asked).toContain("offline_access");
    expect(asked).not.toContain("docx:document");
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

  it("asks the person to authorize again when refreshing fails, and tells them once", async () => {
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: [], accessToken: "at_old", refreshToken: "rt_dead", expiresIn: 60, refreshExpiresIn: 3600 });
    await expect(accessToken(app, "ann", "lark")).rejects.toThrow(/重新授权/);
    await expect(accessToken(app, "ann", "lark")).rejects.toThrow(/重新授权/);
    expect(findConnection(app, "ann", "lark")!.status).toBe("expired");
    expect(one<{ n: number }>(app.db, "select count(*) n from notifications where user_id = 'ann' and title like '%重新授权%'")!.n).toBe(1);
    expect((await renewConnections(app)).lost).toBe(0); // expired ones are not retried
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
    await expect(asLarkUser(app, "ann", () => asOwner(app, "读消息", () => larkCli(["im", "+chat-list", "--as", "user"])))).rejects.toThrow(/已把授权链接发给/);
    const n = one<{ link: string }>(app.db, "select link from notifications where user_id = 'ann' order by rowid desc limit 1")!;
    expect(n.link).toBe("#/account?connect=lark&scopes=im%3Achat%3Aread%3Aextra");
    // Everything inside a person's context runs as them, and caches stay per person.
    setLarkCliForTests(async (args, _cwd, as) => (args.includes("spaces") ? { ok: true, data: { space: { space_id: as ? `lib_${as}` : "lib_owner" } } } : { ok: true }));
    expect(await personalLibrary(app)).toBe("lib_owner");
    expect(await asLarkUser(app, "ann", () => personalLibrary(app))).toBe("lib_ann");
  });

  it("runs a member's tool calls on Feishu as the member", async () => {
    const { callTool, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
    const seen: (string | undefined)[] = [];
    setLarkCliForTests(async (args, _cwd, as) => {
      seen.push(as);
      if (args[1] === "--help" || args.includes("--help")) return "read";
      return { ok: true, data: { chats: [] } };
    });
    const ctx = (user: string) => toolContextForToken(app, issueToolToken({ runId: null, spaceId: `personal-${user}`, spaces: null, tools: null, actor: "agent", userId: user, larkChats: [] }))!;
    createUser(app, { name: "小周", id: "zhou" });
    const refused = await callTool(ctx("zhou"), "lark_read", { command: ["im", "+chat-list"] });
    expect(refused.text).toMatch(/还没有连接飞书/);
    expect(seen).toEqual([]);
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
    storeConnection(app, { userId: "ann", provider: "lark", accountId: "on_ann", accountName: "小安", scopes: ["offline_access", "im:chat:read", "im:message:readonly"], accessToken: "at_ann3", refreshToken: "rt_ok", expiresIn: 7200, refreshExpiresIn: 604800 });
    const calls: { args: string[]; as?: string }[] = [];
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
});
