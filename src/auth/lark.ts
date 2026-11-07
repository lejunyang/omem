import type { App } from "../core/app.ts";
import { larkAppSecret, readLarkSecrets } from "../channels/lark-setup.ts";
import { authFetch, GrantRejected, registerLoginProvider, type ProviderIdentity, type ProviderTokens } from "./providers.ts";

/**
 * Logging in with Feishu through the main bot's app (`lark.appId`): the authorization page, the v2
 * token endpoint and user_info. Only people of the app's tenant within its availability range can
 * authorize. Basic identity (name, avatar, open_id, union_id) needs no scope; scopes for reading the
 * person's own Feishu are asked for later, a feature at a time (incremental authorization).
 *
 * The identity is the union_id (the same in every app of the tenant); the open_id in this app is an
 * alias, which is what the bot sees in messages, so a person who already talks to the bot (or was
 * registered with `omem user add --lark ou_…`) is recognised on their first login.
 */
const hosts = (app: App) => {
  const brand = readLarkSecrets(app.home)[app.config.lark.appId ?? ""]?.brand === "lark" ? "lark" : "feishu";
  return brand === "lark" ? { accounts: "https://accounts.larksuite.com", open: "https://open.larksuite.com" } : { accounts: "https://accounts.feishu.cn", open: "https://open.feishu.cn" };
};
const secret = (app: App) => larkAppSecret(app.home, app.config.lark.appId, app.config.lark.appSecretEnv);

async function call<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  let v: { code?: number; msg?: string; error?: string; error_description?: string } & Record<string, unknown>;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`飞书${what}返回的不是 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || (v.code !== undefined && v.code !== 0)) {
    const why = `飞书${what}失败：${v.error_description ?? v.msg ?? v.error ?? `HTTP ${res.status}`}${v.code ? `（${v.code}）` : ""}`;
    // A refused code or refresh token comes back as OAuth's invalid_grant (20003 code not found, 20026
    // refresh token invalid, …); a bad access token is HTTP 200 with its own code (user_info: 20005).
    throw v.error === "invalid_grant" ? new GrantRejected(why) : new Error(why);
  }
  return v as T;
}

export const larkProvider = {
  id: "lark",
  label: "飞书",
  channel: "lark",
  unavailable(app: App) {
    if (!app.config.lark.appId) return "还没有飞书机器人应用（设置 → 渠道）";
    if (!secret(app)) return "缺少机器人应用的 App Secret";
    return null;
  },
  authorizeUrl(app: App, p: { state: string; challenge: string; redirectUri: string; scopes: string[] }) {
    const q = new URLSearchParams({ client_id: app.config.lark.appId ?? "", response_type: "code", redirect_uri: p.redirectUri, state: p.state, code_challenge: p.challenge, code_challenge_method: "S256" });
    if (p.scopes.length) q.set("scope", p.scopes.join(" "));
    // Scopes separated by %20 as Feishu documents it (URLSearchParams writes a space as +).
    return `${hosts(app).accounts}/open-apis/authen/v1/authorize?${q.toString().replace(/\+/g, "%20")}`;
  },
  async exchange(app: App, p: { code: string; verifier: string; redirectUri: string }): Promise<ProviderTokens> {
    const res = await authFetch(`${hosts(app).open}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      // A code from the web app's requestAccess (no authorization page) comes without redirect_uri and PKCE.
      body: JSON.stringify({ grant_type: "authorization_code", client_id: app.config.lark.appId, client_secret: secret(app), code: p.code, ...(p.redirectUri ? { redirect_uri: p.redirectUri } : {}), ...(p.verifier ? { code_verifier: p.verifier } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const v = await call<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string }>(res, "换取令牌");
    if (!v.access_token) throw new Error("飞书没有返回 access_token");
    return { accessToken: v.access_token, refreshToken: v.refresh_token ?? null, expiresIn: v.expires_in, refreshExpiresIn: v.refresh_token_expires_in, scope: v.scope };
  },
  /** A refresh token works once: the new one comes back with the new access token. */
  async refresh(app: App, refreshToken: string): Promise<ProviderTokens> {
    const res = await authFetch(`${hosts(app).open}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: app.config.lark.appId, client_secret: secret(app), refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
    const v = await call<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; scope?: string }>(res, "刷新令牌");
    if (!v.access_token) throw new Error("飞书没有返回 access_token");
    return { accessToken: v.access_token, refreshToken: v.refresh_token ?? null, expiresIn: v.expires_in, refreshExpiresIn: v.refresh_token_expires_in, scope: v.scope };
  },
  async whoami(app: App, tokens: ProviderTokens): Promise<ProviderIdentity> {
    const res = await authFetch(`${hosts(app).open}/open-apis/authen/v1/user_info`, { headers: { authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const v = await call<{ data?: { name?: string; en_name?: string; avatar_url?: string; open_id?: string; union_id?: string; email?: string; enterprise_email?: string; tenant_key?: string } }>(res, "读取用户信息");
    const d = v.data ?? {};
    const id = d.union_id || d.open_id;
    if (!id) throw new Error("飞书没有返回用户 id");
    return {
      externalId: id,
      tenant: d.tenant_key ?? "",
      name: d.name || d.en_name || "飞书用户",
      email: d.enterprise_email || d.email || null,
      avatar: d.avatar_url || null,
      aliases: d.union_id && d.open_id ? [{ externalId: d.open_id, appId: app.config.lark.appId ?? null }] : [],
    };
  },
  isOwner(app: App, identity: ProviderIdentity) {
    const owner = app.config.lark.ownerOpenId;
    return !!owner && (identity.externalId === owner || !!identity.aliases?.some((a) => a.externalId === owner));
  },
};

registerLoginProvider(larkProvider);
