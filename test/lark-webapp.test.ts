import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { larkAppLink, uiLink } from "../src/agents/asks.ts";
import { setAuthFetchForTests } from "../src/auth/providers.ts";
import { boot } from "../src/main.ts";

/** Feishu as the fake sees it: a requestAccess code, exchanged without redirect_uri or PKCE. */
const people: Record<string, { open_id: string; union_id: string; name: string }> = {
  a_owner: { open_id: "ou_owner", union_id: "on_owner", name: "本人" },
  a_wang: { open_id: "ou_wang", union_id: "on_wang", name: "小王" },
};
const bodies: Record<string, unknown>[] = [];
setAuthFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith("/open-apis/authen/v2/oauth/token")) {
    const b = JSON.parse(String(init?.body));
    bodies.push(b);
    if (b.client_secret !== "test-secret" || !people[b.code]) return new Response(JSON.stringify({ code: 20003, error: "invalid_grant", error_description: "bad code" }), { status: 400 });
    return new Response(JSON.stringify({ code: 0, access_token: `at_${b.code}`, expires_in: 7200, token_type: "Bearer" }));
  }
  if (u.endsWith("/open-apis/authen/v1/user_info")) {
    const code = String((init?.headers as Record<string, string>).authorization).replace("Bearer at_", "");
    return new Response(JSON.stringify({ code: 0, data: { ...people[code], tenant_key: "t1" } }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch);

async function start(config: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), "omem-larkapp-"));
  process.env.OMEM_TEST_LARK_SECRET = "test-secret";
  writeFileSync(join(home, "config.json"), JSON.stringify({ webUrl: "https://omem.example.test/", lark: { appId: "cli_test", appSecretEnv: "OMEM_TEST_LARK_SECRET", ownerOpenId: "ou_owner", webApp: true }, ...config }));
  return boot(home, { port: 0, quiet: true, background: false });
}
const post = (base: string, code: string) => fetch(`${base}/api/auth/lark/app`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ code }) });

describe("the Feishu web app", async () => {
  const multi = await start({ auth: { enabled: true, providers: ["lark"], signup: { lark: "open" } } });
  const single = await start({});
  afterAll(() => Promise.all([multi.server.close(), single.server.close()]));

  it("links open /lark/ in Feishu's sidebar once the web app is on, and the site otherwise", () => {
    const app = multi.app;
    expect(uiLink(app, "ask1")).toBe(`https://applink.feishu.cn/client/web_app/open?appId=cli_test&mode=sidebar&lk_target_url=${encodeURIComponent("https://omem.example.test/lark/#/ui/ask1")}`);
    app.config.lark.webApp = false;
    expect(larkAppLink(app, "/lark/#/ui/ask1")).toBeNull();
    expect(uiLink(app, "ask1")).toBe("https://omem.example.test/#/ui/ask1");
    app.config.lark.webApp = true;
  });

  it("a requestAccess code signs in with the Feishu identity; the session says which app to ask", async () => {
    const base = multi.app.baseUrl!;
    expect((await (await fetch(`${base}/api/auth/session`)).json()).larkApp).toBe("cli_test");
    const bad = await post(base, "nope");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const r = await post(base, "a_wang");
    expect(r.status).toBe(200);
    expect(bodies.at(-1)).toMatchObject({ grant_type: "authorization_code", client_id: "cli_test", code: "a_wang" });
    expect(bodies.at(-1)).not.toHaveProperty("redirect_uri");
    expect(bodies.at(-1)).not.toHaveProperty("code_verifier");
    const cookie = /omem_sid=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
    expect(cookie).toBeTruthy();
    const me = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: `omem_sid=${cookie}`, "x-forwarded-for": "203.0.113.9" } })).json();
    expect(me.user.name).toBe("小王");
  });

  it("with multi-user login off only the owner gets in, and not at all while the web app is off", async () => {
    const base = single.app.baseUrl!;
    expect((await post(base, "a_wang")).status).toBe(403);
    const ok = await post(base, "a_owner");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, userId: "owner" });
    single.app.config.lark.webApp = false;
    expect((await post(base, "a_owner")).status).toBe(403);
    expect((await (await fetch(`${base}/api/auth/session`)).json()).larkApp).toBeNull();
  });
});
