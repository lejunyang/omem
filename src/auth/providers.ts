import type { App } from "../core/app.ts";

/**
 * Login providers (docs/v2/multi-user.md): a platform a person proves who they are with. Each is an
 * OAuth 2 authorization-code flow with PKCE; what the provider says about the person comes from a
 * server-side call with the token it gave (`whoami`), never from the browser. Feishu is built in
 * (`lark.ts`); others are registered the same way (later by plugins). Identities live in
 * `identities` under the provider's `channel`.
 */
/**
 * The provider refused a code or refresh token (revoked, expired, already used): only authorizing again
 * helps. Any other failure (network, the provider's own trouble) leaves the connection to retry later.
 */
export class GrantRejected extends Error {
  readonly grantRejected = true;
}
export const grantRejected = (e: unknown) => !!(e as { grantRejected?: boolean } | null)?.grantRejected;

export type ProviderTokens = {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number;
  refreshExpiresIn?: number;
  scope?: string;
  /** The provider's whole token response, for a whoami that reads the account from it (Notion, Slack). */
  raw?: Record<string, unknown>;
};
/** A value someone fills in: the owner for the platform's app (client id, secret, site), or a person connecting with a key. */
export type ProviderField = { key: string; label: string; secret?: boolean; optional?: boolean; hint?: string };
export type ProviderIdentity = {
  /** The id the provider logs people in by (Feishu: union_id). */
  externalId: string;
  tenant?: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
  /** The same person under other ids of this channel (Feishu: the open_id in this app). */
  aliases?: { externalId: string; appId?: string | null }[];
  /**
   * Emails the provider vouches for, best first (docs/v2/remote-clients.md §7): someone new whose
   * email is on exactly one account made ahead of time gets that account instead of a new one.
   * Feishu: the enterprise mailbox, then the email the tenant's admin entered.
   */
  verifiedEmails?: string[];
};
export type LoginProvider = {
  id: string;
  label: string;
  /** identities.channel of this provider's ids. */
  channel: string;
  /**
   * false: a capability only (reading, capture). Connecting keeps the tokens, but it never logs anyone
   * in, binds or records an identity: whoami only names the account on the account page.
   */
  identity?: boolean;
  /** For the person choosing among many: what it is for (文档与知识库, 聊天与通讯…) and where its API is described. */
  group?: string;
  docs?: string;
  /** What the owner fills in once for this platform (src/auth/apps.ts): client id and secret, a site, scopes. */
  appFields?: ProviderField[];
  /**
   * Connected by filling these in (an API key, a user name and password) instead of an authorization
   * page. `verify` checks them with one call and names the account; the values are kept as the secret.
   */
  credentials?: { fields: ProviderField[]; verify?(app: App, values: Record<string, string>): Promise<{ accountId: string; accountName: string }> };
  /** Why it cannot be used now (not configured), or null. */
  unavailable(app: App): string | null;
  /**
   * Scopes asked for with every login and bind, beyond who the person is: what `whoami` reads to
   * recognize an account made ahead of time (Feishu: the email fields, docs/v2/remote-clients.md §7.4).
   */
  identityScopes?: string[];
  /** The authorization flow; a provider with `credentials` only has none. */
  authorizeUrl?(app: App, p: { state: string; challenge: string; redirectUri: string; scopes: string[] }): string;
  exchange?(app: App, p: { code: string; verifier: string; redirectUri: string }): Promise<ProviderTokens>;
  whoami?(app: App, tokens: ProviderTokens): Promise<ProviderIdentity>;
  /**
   * New tokens for a refresh token (src/auth/connections.ts); providers without it cannot keep a connection
   * alive. When the provider refuses the refresh token itself, throw an error with `grantRejected: true`
   * (`GrantRejected`): only then does the person have to authorize again.
   */
  refresh?(app: App, refreshToken: string): Promise<ProviderTokens>;
  /**
   * Where a connection's API calls may go (a plugin's ctx.connection().fetch): the token is never sent
   * anywhere else. A function when it depends on the owner's settings (a site's own domain); null: not set up.
   */
  apiBase?: string | ((app: App) => string | null);
  /**
   * Put the connection's secret on a call: the access token, or for a credentials provider the values as
   * JSON. Absent: `authorization: Bearer <token>`.
   */
  sign?(app: App, req: { url: URL; headers: Headers }, secret: string): void;
  /** The owner, known from configuration before any login (Feishu: lark.ownerOpenId among the aliases). */
  isOwner?(app: App, identity: ProviderIdentity): boolean;
};

const registry = new Map<string, LoginProvider>();

export function registerLoginProvider(p: LoginProvider) {
  registry.set(p.id, p);
  return () => {
    if (registry.get(p.id) === p) registry.delete(p.id);
  };
}
export const loginProvider = (id: string) => registry.get(id) ?? null;
export const loginProviders = () => [...registry.values()];

/** It can log people in and be bound: an identity with an authorization flow. */
export const canLogIn = (p: LoginProvider) => p.identity !== false && !!p.authorizeUrl && !!p.exchange && !!p.whoami;

/** Providers people may log in with: the listed ones plus the primary one. */
export function enabledProviders(app: App): string[] {
  const { providers, primary } = app.config.auth;
  return [...new Set([...(primary ? [primary] : []), ...providers])].filter((id) => {
    const p = registry.get(id);
    return !!p && canLogIn(p);
  });
}

/** Platforms people may connect: Feishu, the ones the owner offers (`auth.connectors`) and the login ones. */
export function offeredConnectors(app: App): string[] {
  return [...new Set(["lark", ...app.config.auth.connectors, ...enabledProviders(app)])].filter((id) => registry.has(id));
}

export const apiBaseOf = (app: App, p: LoginProvider) => (typeof p.apiBase === "function" ? p.apiBase(app) : (p.apiBase ?? null));

let fetcher: typeof fetch = (...a) => fetch(...a);
/** Tests: answer the providers' HTTP calls without the network. */
export function setAuthFetchForTests(fn: typeof fetch | null) {
  fetcher = fn ?? ((...a) => fetch(...a));
}
export const authFetch: typeof fetch = (...a) => fetcher(...a);
