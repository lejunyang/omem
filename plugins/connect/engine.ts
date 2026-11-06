import { createHash } from "node:crypto";
import type { App } from "../../src/core/app.ts";
import type { ProviderField, ProviderIdentity, ProviderTokens } from "../../src/auth/providers.ts";
import type { PluginApi, PluginConnector } from "../../src/plugins/types.ts";

/**
 * One description of a platform (from Nango's catalog, nango.ts, or written here, china.ts) turned
 * into a connector: the authorization page, exchanging and refreshing tokens, what a call carries.
 * Values the owner fills in once (client id and secret, the site, extra scopes) come from
 * api.appConfig; a key connection's values are its secret.
 */
export type Def = {
  /** The platform's own name: the connector is `connect-<id>`, an identity is recorded under channel `<id>`. */
  id: string;
  label: string;
  group: string;
  docs?: string;
  mode: "oauth2" | "key";
  /** Settings of the platform the owner fills in besides the app (a site's subdomain, a region), and their defaults. */
  config: ProviderField[];
  defaults?: Record<string, string>;

  authUrl?: string;
  /** Appended after `#` (WeChat's `wechat_redirect`). */
  authFragment?: string;
  authParams?: Record<string, string>;
  tokenUrl?: string;
  refreshUrl?: string;
  /** GET with the parameters in the query (WeChat, QQ, Baidu); POST by default. */
  tokenMethod?: "GET" | "POST";
  tokenParams?: Record<string, string>;
  refreshParams?: Record<string, string>;
  tokenHeaders?: Record<string, string>;
  /** The request body is JSON (DingTalk, Notion); a form by default. */
  json?: boolean;
  /** The client id and secret go in a Basic header instead of the body. */
  basicAuth?: boolean;
  pkce?: boolean;
  scopeSep?: string;
  defaultScopes?: string[];
  /** The authorization page's names for client_id, redirect_uri and scope, when not the standard ones. */
  authNames?: Partial<Record<"client_id" | "redirect_uri" | "scope", string | null>>;
  /** Token requests' names for the standard parameters (`appid`, `client_key`, `clientId`…); null leaves one out. */
  names?: Partial<Record<"client_id" | "client_secret" | "code" | "grant_type" | "redirect_uri" | "refresh_token", string | null>>;
  /** Where the response keeps them (dot paths). */
  paths?: { token?: string; refresh?: string; expires?: string; refreshExpires?: string; scope?: string };
  /** Look here too when the top level has no token (Slack's authed_user). */
  altPath?: string;
  expiresMs?: number;

  /** Where calls go and what they carry: templates over ${accessToken} / ${apiKey} / ${credentials.x} / ${connectionConfig.x}. */
  base?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  /** key mode: what the person fills in, and one call that checks it. */
  credentials?: ProviderField[];
  basic?: boolean;
  verify?: { method?: string; path: string };

  /** Can log people in: how to find out who connected. */
  who?: Who;
  /** POST calls that only read (search, GraphQL queries…), allowed to connect_request besides GET. */
  readPost?: RegExp;
};

export type WhoInput = { tokens: ProviderTokens; raw: Record<string, unknown>; cfg: Record<string, string>; call: (url: string, init?: RequestInit) => Promise<any> };
export type Who = { scopes?: string[]; get: (w: WhoInput) => Promise<ProviderIdentity> };

const fail = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });

export const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * Fill a template; null when something it needs is missing. `${base64(…)}` wraps what is inside,
 * after the inner placeholders are filled (Nango's notation, the only function used here).
 */
export function fill(t: string, vars: { accessToken?: string; apiKey?: string; credentials?: Record<string, string>; connectionConfig?: Record<string, string> }): string | null {
  let s = t;
  let missing = false;
  for (let i = 0; i < 5 && s.includes("${"); i++) {
    const before = s;
    s = s.replace(/\$\{(accessToken|apiKey|credentials\.\w+|connectionConfig\.\w+)\}/g, (_, k: string) => {
      const v = k === "accessToken" ? vars.accessToken : k === "apiKey" ? (vars.apiKey ?? vars.credentials?.apiKey) : k.startsWith("credentials.") ? vars.credentials?.[k.slice(12)] : vars.connectionConfig?.[k.slice(17)];
      if (!v) missing = true;
      return v ?? "";
    });
    s = s.replace(/\$\{base64\(([^${}]*)\)\}/g, (_, x: string) => Buffer.from(x).toString("base64"));
    if (s === before) break;
  }
  return missing || s.includes("${") ? null : s;
}

/** The placeholders a template needs (connectionConfig.x, credentials.x…), to tell whether it can ever be filled. */
export const needs = (t: string) => [...t.matchAll(/\$\{(?:base64\()?([\w.]+)/g)].map((m) => m[1]).filter((k) => k !== "base64");

const appFields = (d: Def): ProviderField[] => [
  ...(d.mode === "oauth2"
    ? [
        { key: "clientId", label: d.authNames?.client_id === "appid" ? "AppID" : d.authNames?.client_id === "client_key" ? "Client Key" : "Client ID" },
        { key: "clientSecret", label: d.authNames?.client_id === "appid" ? "AppSecret" : "Client Secret", secret: true },
        { key: "scopes", label: "额外的权限（scope）", optional: true, hint: d.defaultScopes?.length ? `默认已申请：${d.defaultScopes.join(d.scopeSep ?? " ")}；这里写要再加的，空格分隔` : "按平台文档写要申请的 scope，空格分隔" },
      ]
    : []),
  ...d.config,
];

/** Build the connector of a description. */
export function connector(api: PluginApi, d: Def, opts: { identity: boolean }): PluginConnector {
  const pid = `${api.id}-${d.id}`;
  const cfg = () => ({ ...d.defaults, ...api.appConfig(pid) });
  const vars = (c: Record<string, string>) => ({ connectionConfig: c, credentials: { clientId: c.clientId ?? "", clientSecret: c.clientSecret ?? "" } });
  const name = (k: keyof NonNullable<Def["names"]>) => (d.names && k in d.names ? d.names[k] : k);
  const aname = (k: keyof NonNullable<Def["authNames"]>) => (d.authNames && k in d.authNames ? d.authNames[k] : k);
  const scopes = (c: Record<string, string>) => [...new Set([...(d.defaultScopes ?? []), ...(opts.identity ? (d.who?.scopes ?? []) : []), ...(c.scopes ?? "").split(/[\s,]+/).filter(Boolean)])];

  async function tokenCall(url: string, params: Record<string, string>, c: Record<string, string>, refreshing: boolean): Promise<ProviderTokens> {
    const headers = new Headers({ accept: "application/json" });
    for (const [k, v] of Object.entries(d.tokenHeaders ?? {})) {
      const x = fill(v, vars(c));
      if (x) headers.set(k, x);
    }
    const body: Record<string, string> = { ...params };
    const id = name("client_id");
    const secret = name("client_secret");
    if (d.basicAuth) headers.set("authorization", `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`);
    else {
      if (id) body[id] = c.clientId;
      if (secret) body[secret] = c.clientSecret;
    }
    let target = url;
    let init: RequestInit;
    if (d.tokenMethod === "GET") {
      const u = new URL(url);
      for (const [k, v] of Object.entries(body)) u.searchParams.set(k, v);
      target = u.toString();
      init = { method: "GET", headers };
    } else if (d.json) {
      headers.set("content-type", "application/json");
      init = { method: "POST", headers, body: JSON.stringify(body) };
    } else {
      headers.set("content-type", "application/x-www-form-urlencoded");
      init = { method: "POST", headers, body: new URLSearchParams(body).toString() };
    }
    const res = await api.fetch(target, init);
    const text = await res.text();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = Object.fromEntries(new URLSearchParams(text));
    }
    const err = str(raw.error) || str(raw.error_description) || (raw.errcode && raw.errcode !== 0 ? `${raw.errcode} ${str(raw.errmsg)}` : "") || (get(raw, "data.error_code") ? `${get(raw, "data.error_code")} ${str(get(raw, "data.description"))}` : "");
    const token = str(get(raw, d.paths?.token ?? "access_token")) || (d.altPath ? str(get(raw, `${d.altPath}.access_token`)) : "");
    if (!res.ok || err || !token) {
      const why = `${d.label}：${err || `HTTP ${res.status}`}`.slice(0, 300);
      // A refused refresh token needs the person; anything else is retried later (connections.ts).
      if (refreshing && (res.status === 400 || res.status === 401 || /invalid_grant|expired|revoked/i.test(err))) throw Object.assign(new Error(why), { grantRejected: true });
      throw fail(400, why);
    }
    const expires = Number(get(raw, d.paths?.expires ?? "expires_in") ?? (d.altPath ? get(raw, `${d.altPath}.expires_in`) : undefined));
    const scope = get(raw, d.paths?.scope ?? "scope") ?? (d.altPath ? get(raw, `${d.altPath}.scope`) : undefined);
    return {
      accessToken: token,
      refreshToken: str(get(raw, d.paths?.refresh ?? "refresh_token")) || (d.altPath ? str(get(raw, `${d.altPath}.refresh_token`)) : "") || null,
      expiresIn: Number.isFinite(expires) && expires > 0 ? expires : d.expiresMs ? d.expiresMs / 1000 : undefined,
      refreshExpiresIn: Number(get(raw, d.paths?.refreshExpires ?? "refresh_token_expires_in")) || undefined,
      // Scopes are not what decides a feature here (the connector has one, with none of its own).
      scope: Array.isArray(scope) ? scope.join(" ") : str(scope).replace(/,/g, " "),
      raw,
    };
  }

  const base = (c: Record<string, string>) => (d.base ? fill(d.base, vars(c)) : null);
  const missing = (c: Record<string, string>) => {
    const fields = appFields(d).filter((f) => !f.optional && !c[f.key]);
    return fields.length ? `还没填${fields.map((f) => f.label).join("、")}（omem 的主人在 设置 → 成员 → 平台应用 里填）` : null;
  };

  const sign = (c: Record<string, string>, req: { url: URL; headers: Headers }, secret: string) => {
    const creds: Record<string, string> = d.mode === "key" ? JSON.parse(secret) : {};
    const v = { accessToken: d.mode === "oauth2" ? secret : undefined, apiKey: creds.apiKey, credentials: { ...creds, clientId: c.clientId ?? "", clientSecret: c.clientSecret ?? "" }, connectionConfig: c };
    let auth = false;
    for (const [k, t] of Object.entries(d.headers ?? {})) {
      const x = fill(t, v);
      if (x === null) continue;
      req.headers.set(k, x);
      if (/accessToken|apiKey|credentials\./.test(t)) auth = true;
    }
    for (const [k, t] of Object.entries(d.query ?? {})) {
      const x = fill(t, v);
      if (x === null) continue;
      req.url.searchParams.set(k, x);
      if (/accessToken|apiKey|credentials\./.test(t)) auth = true;
    }
    if (auth) return;
    if (d.mode === "oauth2") req.headers.set("authorization", `Bearer ${secret}`);
    else if (d.basic) req.headers.set("authorization", `Basic ${Buffer.from(`${creds.username ?? ""}:${creds.password ?? ""}`).toString("base64")}`);
    else if (creds.apiKey) req.headers.set("authorization", `Bearer ${creds.apiKey}`);
  };

  /** A call to the platform with a token, for whoami. */
  const callWith = (c: Record<string, string>, token: string) => async (url: string, init: RequestInit = {}) => {
    const u = new URL(/^https?:\/\//.test(url) ? url : `${(base(c) ?? "").replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`);
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    sign(c, { url: u, headers }, token);
    const res = await api.fetch(u, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw fail(400, `${d.label}：查账号信息失败（HTTP ${res.status}）${text.slice(0, 120)}`);
    try {
      return JSON.parse(text);
    } catch {
      return Object.fromEntries(new URLSearchParams(text));
    }
  };

  const def: PluginConnector = {
    id: pid,
    label: d.label,
    channel: d.id,
    identity: opts.identity,
    group: d.group,
    docs: d.docs,
    appFields: appFields(d),
    unavailable: () => {
      const c = cfg();
      return missing(c) ?? (d.base && !base(c) ? `${d.label}的接口地址要填：${needs(d.base).filter((k) => k.startsWith("connectionConfig.")).map((k) => k.slice(17)).join("、")}` : null);
    },
    apiBase: () => base(cfg()),
    sign: (_app: App, req, secret) => sign(cfg(), req, secret),
    features: [{ id: "access", label: opts.identity ? "读取数据" : "读取", description: `助手和采集以你的身份读你在${d.label}上能看到的内容`, scopes: [] }],
  };

  if (d.mode === "key") {
    def.credentials = {
      fields: d.credentials ?? [],
      verify: async (_app, values) => {
        if (!d.verify) return { accountId: createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16), accountName: "" };
        const c = cfg();
        const b = base(c);
        if (!b) throw fail(400, `${d.label}的接口地址还没有设置`);
        const u = new URL(`${b.replace(/\/+$/, "")}/${d.verify.path.replace(/^\/+/, "")}`);
        const headers = new Headers({ accept: "application/json" });
        sign(c, { url: u, headers }, JSON.stringify(values));
        const res = await api.fetch(u, { method: d.verify.method ?? "GET", headers });
        if (!res.ok) throw fail(400, `${d.label}没有接受这个密钥（HTTP ${res.status}）`);
        const body = await res.json().catch(() => ({}));
        const id = str(get(body, "id")) || str(get(body, "data.id")) || str(get(body, "user.id")) || str(get(body, "account_id"));
        const nm = str(get(body, "name")) || str(get(body, "data.name")) || str(get(body, "user.name")) || str(get(body, "email")) || str(get(body, "login"));
        return { accountId: id || createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16), accountName: nm };
      },
    };
    return def;
  }

  def.authorizeUrl = (_app, p) => {
    const c = cfg();
    const url = fill(d.authUrl ?? "", vars(c));
    if (!url) throw fail(400, missing(c) ?? `${d.label}的授权地址缺少设置`);
    const u = new URL(url);
    const q: Record<string, string> = { response_type: "code" };
    const id = aname("client_id");
    if (id) q[id] = c.clientId;
    const redirect = aname("redirect_uri");
    if (redirect) q[redirect] = p.redirectUri;
    q.state = p.state;
    const sc = [...scopes(c), ...p.scopes];
    const scopeName = aname("scope");
    if (sc.length && scopeName) q[scopeName] = sc.join(d.scopeSep ?? " ");
    for (const [k, v] of Object.entries(d.authParams ?? {})) q[k] = fill(v, vars(c)) ?? v;
    if (d.pkce !== false) Object.assign(q, { code_challenge: p.challenge, code_challenge_method: "S256" });
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return d.authFragment ? `${u.toString()}#${d.authFragment}` : u.toString();
  };
  def.exchange = async (_app, p) => {
    const c = cfg();
    const url = fill(d.tokenUrl ?? "", vars(c));
    if (!url) throw fail(400, `${d.label}的令牌地址缺少设置`);
    const params: Record<string, string> = {};
    const set = (k: keyof NonNullable<Def["names"]>, v: string) => {
      const n = name(k);
      if (n) params[n] = v;
    };
    set("grant_type", "authorization_code");
    set("code", p.code);
    set("redirect_uri", p.redirectUri);
    if (d.pkce !== false) params.code_verifier = p.verifier;
    for (const [k, v] of Object.entries(d.tokenParams ?? {})) params[k] = fill(v, vars(c)) ?? v;
    return tokenCall(url, params, c, false);
  };
  def.refresh = async (_app, refreshToken) => {
    const c = cfg();
    const url = fill(d.refreshUrl ?? d.tokenUrl ?? "", vars(c));
    if (!url) throw fail(400, `${d.label}的令牌地址缺少设置`);
    const params: Record<string, string> = {};
    const g = name("grant_type");
    if (g) params[g] = "refresh_token";
    const r = name("refresh_token");
    if (r) params[r] = refreshToken;
    for (const [k, v] of Object.entries(d.refreshParams ?? {})) params[k] = fill(v, vars(c)) ?? v;
    return tokenCall(url, params, c, true);
  };
  def.whoami = async (_app, tokens) => {
    const c = cfg();
    const raw = tokens.raw ?? {};
    if (opts.identity && d.who) return d.who.get({ tokens, raw, cfg: c, call: callWith(c, tokens.accessToken) });
    return accountOf(raw, d.label);
  };
  return def;
}

/** A capability connection only needs a name for the account page: whatever the token response says about it. */
function accountOf(raw: Record<string, unknown>, label: string): ProviderIdentity {
  const pick = (...paths: string[]) => paths.map((p) => str(get(raw, p))).find(Boolean) ?? "";
  const id = pick("owner.user.id", "workspace_id", "team.id", "authed_user.id", "user_id", "account_id", "user.id", "open_id", "openid", "uid", "data.open_id");
  const name = pick("workspace_name", "team.name", "owner.user.name", "user.name", "user.email", "email", "account_name");
  return { externalId: id || "default", name: name || label };
}
