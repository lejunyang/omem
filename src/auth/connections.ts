import type { App } from "../core/app.ts";
import { notify } from "../core/notify.ts";
import { findUser, updateUser } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { featuresOf, grantedFeatures } from "./features.ts";
import { apiBaseOf, authFetch, grantRejected, loginProvider, type ProviderIdentity, type ProviderTokens } from "./providers.ts";
import { connectionSecrets, deleteConnection, expireAccessToken, findConnection, listConnections, markConnection, replaceTokens, storeConnection, type Connection } from "./vault.ts";

/**
 * Using a person's connection (docs/v2/multi-user.md, “连接器”): a current access token, refreshed
 * shortly before it runs out; a refresh token is used once and its successor written before anything
 * else uses it, so refreshes of one connection run one at a time. When refreshing fails the connection
 * waits for the person to authorize again (they are told once), instead of being retried.
 */
const EARLY_MS = 10 * 60_000;
const RENEW_REFRESH_MS = 2 * 86400_000;
const refreshing = new Map<string, Promise<string>>();

/** Keep the tokens a login or a connect brought (identity checked by the caller). */
export function saveConnection(app: App, userId: string, provider: string, who: ProviderIdentity, tokens: ProviderTokens) {
  return storeConnection(app, {
    userId,
    provider,
    accountId: who.externalId,
    accountName: who.name,
    scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    refreshExpiresIn: tokens.refreshExpiresIn,
  });
}

/**
 * Connect by filling in what the provider asks for (an API key, a user name and password): checked
 * with the provider's own call when it has one, then kept in the vault as the connection's secret.
 */
export async function connectWithCredentials(app: App, userId: string, provider: string, values: Record<string, unknown>) {
  const p = loginProvider(provider);
  if (!p?.credentials) throw new HttpError(404, `${provider} 不用填写密钥连接`);
  const why = p.unavailable(app);
  if (why) throw new HttpError(400, `${p.label}暂时不能连接：${why}`);
  const clean: Record<string, string> = {};
  for (const f of p.credentials.fields) {
    const v = typeof values[f.key] === "string" ? (values[f.key] as string).trim() : "";
    if (!v && !f.optional) throw new HttpError(400, `请填写${f.label}`);
    if (v) clean[f.key] = v.slice(0, 4000);
  }
  const who = p.credentials.verify ? await p.credentials.verify(app, clean) : { accountId: "default", accountName: "" };
  return storeConnection(app, { userId, provider, accountId: who.accountId, accountName: who.accountName, scopes: [], accessToken: JSON.stringify(clean) });
}

/**
 * Features a person turned off in omem (the account page): the platform still grants them — a Feishu
 * authorization is never taken back by asking for less — but omem does not use them: no capture, and
 * the tools that would refuse (agents/tools.ts). Turned on again, they work at once.
 */
export function featuresOff(app: App, userId: string, provider: string): string[] {
  return findUser(app, userId)?.settings.featuresOff?.[provider] ?? [];
}
/** What omem may use of a connection: granted on the platform and not turned off here. */
export function usableFeatures(app: App, c: Pick<Connection, "userId" | "provider" | "scopes">) {
  const off = new Set(featuresOff(app, c.userId, c.provider));
  return grantedFeatures(c.provider, c.scopes).filter((f) => !off.has(f));
}
export function setFeatureOff(app: App, userId: string, provider: string, feature: string, off: boolean) {
  if (!featuresOf(provider).some((f) => f.id === feature) || feature === "offline") throw new HttpError(400, `没有这个功能：${feature}`);
  const u = findUser(app, userId);
  if (!u) throw new HttpError(404, "没有这个用户");
  const all = { ...(u.settings.featuresOff ?? {}) };
  const now = new Set(all[provider] ?? []);
  if (off) now.add(feature);
  else now.delete(feature);
  all[provider] = [...now];
  updateUser(app, userId, { settings: { featuresOff: all } });
}

export type ConnectionView = Connection & { label: string; features: { id: string; label: string; description: string; on: boolean; paused: boolean }[]; background: boolean; credentials: boolean };
export function connectionView(app: App, c: Connection): ConnectionView {
  const on = new Set(grantedFeatures(c.provider, c.scopes));
  const off = new Set(featuresOff(app, c.userId, c.provider));
  return {
    ...c,
    label: loginProvider(c.provider)?.label ?? c.provider,
    features: featuresOf(c.provider).map((f) => ({ id: f.id, label: f.label, description: f.description, on: on.has(f.id), paused: on.has(f.id) && off.has(f.id) })),
    // A key does not run out: it works in the background as long as it is valid.
    background: !!loginProvider(c.provider)?.credentials || !!connectionSecrets(app, c.id)?.refreshToken,
    credentials: !!loginProvider(c.provider)?.credentials,
  };
}
export const connectionsOf = (app: App, userId: string) => listConnections(app, userId).map((c) => connectionView(app, c));

async function refresh(app: App, c: Connection): Promise<string> {
  const p = loginProvider(c.provider);
  const secrets = connectionSecrets(app, c.id);
  if (!p?.refresh || !secrets?.refreshToken) throw expired(app, c, "没有刷新令牌（授权时没有打开“后台访问”）");
  try {
    const t = await p.refresh(app, secrets.refreshToken);
    replaceTokens(app, c.id, t);
    return t.accessToken;
  } catch (e) {
    // Only a refused refresh token needs the person; a network or provider failure is tried again on the next use.
    if (grantRejected(e)) throw expired(app, c, (e as Error).message);
    throw new HttpError(503, `${loginProvider(c.provider)?.label ?? c.provider}授权暂时刷新不了，稍后再试：${(e as Error).message}`);
  }
}

/** The connection cannot be used until its person authorizes again; they hear about it once. */
function expired(app: App, c: Connection, why: string) {
  const fresh = findConnection(app, c.userId, c.provider);
  if (fresh?.status !== "expired") {
    markConnection(app, c.id, "expired", why);
    const label = loginProvider(c.provider)?.label ?? c.provider;
    notify(app, { userId: c.userId, title: `${label}连接需要重新授权`, body: `omem 用不了你的${label}授权了（${why.slice(0, 120)}）。在 omem 的账号页重新连接${label}。`, link: "#/account", urgency: "normal" });
  }
  return new HttpError(403, `${loginProvider(c.provider)?.label ?? c.provider}连接需要重新授权：在账号页重新连接`);
}

/** A current access token of this person's connection; null when they have not connected the provider. */
export async function accessToken(app: App, userId: string, provider: string): Promise<string | null> {
  const c = findConnection(app, userId, provider);
  if (!c) return null;
  if (c.status === "expired") throw new HttpError(403, `${loginProvider(provider)?.label ?? provider}连接需要重新授权：在账号页重新连接`);
  const fresh = !c.expiresAt || Date.parse(c.expiresAt) - Date.now() > EARLY_MS;
  if (fresh) return connectionSecrets(app, c.id)!.accessToken;
  let p = refreshing.get(c.id);
  if (!p) {
    p = refresh(app, c).finally(() => refreshing.delete(c.id));
    refreshing.set(c.id, p);
  }
  return p;
}

/** The provider turned this person's access token down before its time (revoked, signed out elsewhere): the next use refreshes it. */
export function staleToken(app: App, userId: string, provider: string) {
  const c = findConnection(app, userId, provider);
  if (c?.status === "active") expireAccessToken(app, c.id);
}

/**
 * The scheduler's pass: refresh tokens whose refresh token runs out within two days, so a connection
 * nobody used for a while stays alive. Returns how many were renewed and how many need the person.
 */
export async function renewConnections(app: App) {
  let renewed = 0;
  let lost = 0;
  for (const c of listConnections(app)) {
    if (c.status !== "active" || !c.refreshExpiresAt) continue;
    if (Date.parse(c.refreshExpiresAt) - Date.now() > RENEW_REFRESH_MS) continue;
    try {
      await (refreshing.get(c.id) ?? refresh(app, c));
      renewed++;
    } catch {
      if (findConnection(app, c.userId, c.provider)?.status === "expired") lost++;
    }
  }
  return { renewed, lost };
}

export function disconnect(app: App, userId: string, provider: string) {
  const c = findConnection(app, userId, provider);
  if (!c) throw new HttpError(404, "没有这个连接");
  deleteConnection(app, c.id);
}

/**
 * A plugin's view of this person's connection (src/plugins/types.ts PluginContext.connection): calls go
 * to the provider's `apiBase` only, with a current token added; the token itself never leaves here.
 */
export function pluginConnection(app: App, userId: string, provider: string) {
  const c = findConnection(app, userId, provider);
  if (!c || c.status !== "active") return null;
  const p = loginProvider(provider);
  const base = p ? apiBaseOf(app, p)?.replace(/\/+$/, "") : null;
  return {
    account: c.accountName || c.accountId,
    scopes: c.scopes,
    base: base ?? null,
    async fetch(path: string, init: RequestInit = {}) {
      if (!base) throw new HttpError(400, `${provider} 没有声明 apiBase，不能代发请求`);
      const url = /^https?:\/\//.test(path) ? path : `${base}/${path.replace(/^\/+/, "")}`;
      if (url !== base && !url.startsWith(`${base}/`) && !url.startsWith(`${base}?`)) throw new HttpError(400, `只能请求 ${base} 下的地址`);
      const token = (await accessToken(app, userId, provider))!;
      const headers = new Headers(init.headers);
      const target = new URL(url);
      if (p?.sign) p.sign(app, { url: target, headers }, token);
      else headers.set("authorization", `Bearer ${token}`);
      // sign may add query parameters (a key in the query), never another host.
      if (target.origin !== new URL(base).origin) throw new HttpError(400, `只能请求 ${base} 下的地址`);
      return authFetch(target, { ...init, headers, redirect: "manual" });
    },
  };
}
