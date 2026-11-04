import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { receive } from "../src/agents/inbox.ts";
import { createLoginLink } from "../src/auth/login.ts";
import { registerLoginProvider, setAuthFetchForTests } from "../src/auth/providers.ts";
import { all, one } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createUser, identitiesOf, linkIdentity, resolveIdentity } from "../src/core/users.ts";
import { boot } from "../src/main.ts";

/** Feishu as the fake sees it: each authorization code is one person. */
const people: Record<string, { open_id: string; union_id: string; name: string; tenant_key?: string }> = {
  c_owner: { open_id: "ou_owner", union_id: "on_owner", name: "本人" },
  c_wang: { open_id: "ou_wang", union_id: "on_wang", name: "小王" },
  c_li: { open_id: "ou_li", union_id: "on_li", name: "小李" },
  c_zhao: { open_id: "ou_zhao", union_id: "on_zhao", name: "小赵" },
  c_qian: { open_id: "ou_qian", union_id: "on_qian", name: "小钱" },
  c_sun: { open_id: "ou_sun", union_id: "on_sun", name: "小孙" },
};
setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith("/open-apis/authen/v2/oauth/token")) {
    const b = JSON.parse(String(init?.body));
    if (!b.code_verifier || b.client_secret !== "test-secret") return new Response(JSON.stringify({ code: 20003, error_description: "bad request" }), { status: 400 });
    return new Response(JSON.stringify({ code: 0, access_token: `at_${b.code}`, expires_in: 7200, token_type: "Bearer" }));
  }
  if (u.endsWith("/open-apis/authen/v1/user_info")) {
    const code = String((init?.headers as Record<string, string>).authorization).replace("Bearer at_", "");
    const p = people[code];
    return new Response(JSON.stringify(p ? { code: 0, data: { ...p, tenant_key: p.tenant_key ?? "t1" } } : { code: 99991663, msg: "invalid token" }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch);

// A second provider (as a plugin would add): its authorization code is the person's id there.
registerLoginProvider({
  id: "gh",
  label: "GitHub",
  channel: "github",
  unavailable: () => null,
  authorizeUrl: (_app, p) => `https://gh.example/authorize?state=${p.state}`,
  exchange: async (_app, p) => ({ accessToken: p.code }),
  whoami: async (_app, t) => ({ externalId: t.accessToken, name: `gh-${t.accessToken}` }),
});

describe("logging in", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-auth-"));
  process.env.OMEM_TEST_LARK_SECRET = "test-secret";
  writeFileSync(join(home, "config.json"), JSON.stringify({ webUrl: "http://omem.test", lark: { appId: "cli_test", appSecretEnv: "OMEM_TEST_LARK_SECRET", ownerOpenId: "ou_owner" }, auth: { enabled: true } }));
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => server.close());
  const base = app.baseUrl!;

  // From another machine: through a reverse proxy, so not this machine.
  const remote = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { "x-forwarded-for": "203.0.113.9", ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as Record<string, string>) } });
  const local = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) } });
  const cookieOf = (r: Response) => /omem_sid=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
  const hashOf = (r: Response) => decodeURIComponent(new URL(r.headers.get("location")!).hash);

  /** Log in with Feishu as the person behind `code`; returns the redirect and the session cookie. */
  async function loginAs(code: string, opts: { provider?: string; invite?: string; cookie?: string; purpose?: "bind" } = {}) {
    const provider = opts.provider ?? "lark";
    const q = new URLSearchParams({ ...(opts.invite ? { invite: opts.invite } : {}), ...(opts.purpose ? { purpose: opts.purpose } : {}) });
    const start = await remote(`/api/auth/${provider}/start?${q}`, { cookie: opts.cookie ? `omem_sid=${opts.cookie}` : undefined });
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get("location")!);
    if (to.hostname === "omem.test") return { redirect: decodeURIComponent(to.hash), cookie: undefined };
    const state = to.searchParams.get("state")!;
    if (provider === "lark") {
      expect(to.origin).toBe("https://accounts.feishu.cn");
      expect(to.searchParams.get("redirect_uri")).toBe("http://omem.test/api/auth/lark/callback");
      expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    }
    const back = await remote(`/api/auth/${provider}/callback?code=${code}&state=${state}`, { cookie: opts.cookie ? `omem_sid=${opts.cookie}` : undefined });
    expect(back.status).toBe(302);
    return { redirect: hashOf(back), cookie: cookieOf(back) };
  }
  const me = (cookie?: string) => remote("/api/me", { cookie: cookie ? `omem_sid=${cookie}` : undefined });

  it("asks a browser on another machine to log in; this machine stays the owner", async () => {
    const r = await me();
    expect(r.status).toBe(401);
    expect((await r.json()).login).toBe(true);
    expect((await (await local("/api/me")).json()).id).toBe("owner");
    const s = await (await remote("/api/auth/session")).json();
    expect(s.user).toBeNull();
    expect(s.login.providers.map((p: { id: string }) => p.id)).toContain("lark");
  });

  it("recognises the owner by the configured open_id and records the union_id", async () => {
    const { redirect, cookie } = await loginAs("c_owner");
    expect(redirect).toBe("#/");
    expect((await (await me(cookie)).json()).id).toBe("owner");
    expect(identitiesOf(app, "owner").map((i) => [i.external_id, i.kind])).toEqual(expect.arrayContaining([["on_owner", "login"], ["ou_owner", "alias"]]));
  });

  it("makes a newcomer wait for the owner's approval", async () => {
    const { cookie } = await loginAs("c_wang");
    const mine = await (await me(cookie)).json();
    expect(mine.status).toBe("pending");
    const blocked = await remote("/api/conversations", { cookie: `omem_sid=${cookie}` });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe("pending");
    expect(one<{ title: string }>(app.db, "select title from notifications where user_id = 'owner' order by rowid desc limit 1")?.title).toMatch(/申请/);
    // Not a user in the channels yet either: the bot treats them as a stranger.
    expect(resolveIdentity(app, "lark", "ou_wang")).toBeNull();
    const users = (await (await local("/api/users")).json()) as { id: string; status: string }[];
    const wang = users.find((u) => u.status === "pending")!;
    expect((await local(`/api/users/${wang.id}`, { method: "PATCH", body: JSON.stringify({ approve: true }) })).status).toBe(200);
    expect((await remote("/api/conversations", { cookie: `omem_sid=${cookie}` })).status).toBe(200);
    expect(resolveIdentity(app, "lark", "ou_wang")).toBe(wang.id);
    // Still a member: owner routes stay closed.
    expect((await remote("/api/runs", { cookie: `omem_sid=${cookie}` })).status).toBe(403);
  });

  it("recognises someone already registered by their open_id", async () => {
    createUser(app, { name: "小李", id: "li" });
    linkIdentity(app, "li", "lark", "ou_li");
    const { cookie } = await loginAs("c_li");
    expect((await (await me(cookie)).json()).id).toBe("li");
    expect(identitiesOf(app, "li").some((i) => i.external_id === "on_li" && i.kind === "login")).toBe(true);
  });

  it("lets an invite in at once, with its spaces", async () => {
    createSpace(app, { id: "team", name: "团队" });
    const inv = await (await local("/api/invites", { method: "POST", body: JSON.stringify({ spaces: [{ space: "team", role: "reader" }] }) })).json();
    const token = new URL(inv.url.replace("#/", "")).searchParams.get("invite")!;
    expect((await (await remote(`/api/auth/session?invite=${token}`)).json()).login.invite.invalid).toBeUndefined();
    const { cookie } = await loginAs("c_zhao", { invite: token });
    const zhao = await (await me(cookie)).json();
    expect(zhao.status).toBe("active");
    expect(zhao.spaces).toContain("team");
    // Used once.
    expect((await (await remote(`/api/auth/session?invite=${token}`)).json()).login.invite.invalid).toBe(true);
  });

  it("refuses newcomers when sign-up is closed", async () => {
    app.config.auth.signup = { lark: "closed" };
    const { redirect, cookie } = await loginAs("c_qian");
    expect(cookie).toBeUndefined();
    expect(redirect).toMatch(/^#\/login\?error=.*邀请/);
    app.config.auth.signup = {};
  });

  it("once a primary provider is set, an account without it can only bind it", async () => {
    app.config.auth.providers = ["lark", "gh"];
    app.config.auth.signup = { gh: "open" };
    const first = await loginAs("octo", { provider: "gh" });
    const octo = (await (await me(first.cookie)).json()).id;
    expect((await remote("/api/conversations", { cookie: `omem_sid=${first.cookie}` })).status).toBe(200);

    app.config.auth.primary = "lark";
    const second = await loginAs("octo", { provider: "gh" });
    const blocked = await remote("/api/conversations", { cookie: `omem_sid=${second.cookie}` });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe("restricted");
    // Someone new cannot sign up with it any more.
    expect((await loginAs("newbie", { provider: "gh" })).redirect).toMatch(/请用飞书登录/);

    // Binding Feishu lifts the restriction of this very session.
    const bound = await loginAs("c_sun", { purpose: "bind", cookie: second.cookie });
    expect(bound.redirect).toMatch(/^#\/account\?bound=lark/);
    expect((await remote("/api/conversations", { cookie: `omem_sid=${second.cookie}` })).status).toBe(200);
    expect(identitiesOf(app, octo).some((i) => i.external_id === "on_sun")).toBe(true);
    // From now on it has to be Feishu.
    expect((await loginAs("octo", { provider: "gh" })).redirect).toMatch(/请用飞书登录/);
    expect((await (await me((await loginAs("c_sun")).cookie)).json()).id).toBe(octo);
    app.config.auth.primary = null;
    app.config.auth.providers = ["lark"];
  });

  it("refuses to bind an identity that is someone else's", async () => {
    const { cookie } = await loginAs("c_li");
    const r = await loginAs("c_owner", { purpose: "bind", cookie });
    expect(r.redirect).toMatch(/另一个 omem 账号/);
    expect(identitiesOf(app, "li").some((i) => i.external_id === "on_owner")).toBe(false);
  });

  it("does not let another site write with the cookie", async () => {
    const { cookie } = await loginAs("c_li");
    const r = await remote("/api/ask", { method: "POST", cookie: `omem_sid=${cookie}`, headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ text: "/whoami" }) });
    expect(r.status).toBe(401);
    const ok = await remote("/api/ask", { method: "POST", cookie: `omem_sid=${cookie}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/whoami" }) });
    expect((await ok.json()).reply).toMatch(/小李/);
  });

  it("signs in with a one-time link from the bot; a preview fetching it does not use it up", async () => {
    const reply = (await receive(app, { channel: "lark", chatId: "oc_li", text: "/login", userId: "li" })).reply ?? "";
    const code = /\/api\/auth\/link\/([A-Za-z0-9_-]+)/.exec(reply)![1];
    expect(await (await remote(`/api/auth/link/${code}`)).text()).toMatch(/<form method="post">/);
    expect(await (await remote(`/api/auth/link/${code}`)).text()).toMatch(/<form method="post">/);
    const used = await remote(`/api/auth/link/${code}`, { method: "POST" });
    expect(used.status).toBe(303);
    expect((await (await me(cookieOf(used))).json()).id).toBe("li");
    expect(cookieOf(await remote(`/api/auth/link/${code}`, { method: "POST" }))).toBeUndefined();
    expect((await receive(app, { channel: "lark", chatId: "oc_g", text: "/login", userId: "li", isGroup: true })).reply).toMatch(/私聊/);
    // Expired.
    const old = createLoginLink(app, "li", "lark");
    app.db.prepare("update login_links set expires_at = '2000-01-01' where used_at is null").run();
    expect(cookieOf(await remote(`/api/auth/link/${old}`, { method: "POST" }))).toBeUndefined();
  });

  it("lists and signs out sessions; disabling a user ends them all", async () => {
    const { cookie } = await loginAs("c_li");
    const acc = await (await remote("/api/auth/account", { cookie: `omem_sid=${cookie}` })).json();
    const current = acc.sessions.find((s: { current: boolean }) => s.current);
    expect(current).toBeTruthy();
    expect((await remote(`/api/auth/sessions/${current.id}`, { method: "DELETE", cookie: `omem_sid=${cookie}` })).status).toBe(200);
    expect((await me(cookie)).status).toBe(401);

    const again = (await loginAs("c_li")).cookie;
    expect((await local("/api/users/li", { method: "PATCH", body: JSON.stringify({ disabled: true }) })).status).toBe(200);
    expect((await me(again)).status).toBe(401);
    expect(all(app.db, "select 1 from auth_sessions where user_id = 'li'")).toHaveLength(0);
    expect((await loginAs("c_li")).redirect).toMatch(/停用/);
    await local("/api/users/li", { method: "PATCH", body: JSON.stringify({ disabled: false }) });
  });

  it("trusts a proxied request from this machine only while logging in is off", async () => {
    expect((await remote("/api/me")).status).toBe(401);
    app.config.auth.enabled = false;
    expect((await remote("/api/me")).status).toBe(200);
    app.config.auth.enabled = true;
  });
});
