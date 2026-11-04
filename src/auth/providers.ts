import type { App } from "../core/app.ts";

/**
 * Login providers (docs/v2/multi-user.md): a platform a person proves who they are with. Each is an
 * OAuth 2 authorization-code flow with PKCE; what the provider says about the person comes from a
 * server-side call with the token it gave (`whoami`), never from the browser. Feishu is built in
 * (`lark.ts`); others are registered the same way (later by plugins). Identities live in
 * `identities` under the provider's `channel`.
 */
export type ProviderTokens = { accessToken: string; refreshToken?: string | null; expiresIn?: number; refreshExpiresIn?: number; scope?: string };
export type ProviderIdentity = {
  /** The id the provider logs people in by (Feishu: union_id). */
  externalId: string;
  tenant?: string;
  name: string;
  email?: string | null;
  avatar?: string | null;
  /** The same person under other ids of this channel (Feishu: the open_id in this app). */
  aliases?: { externalId: string; appId?: string | null }[];
};
export type LoginProvider = {
  id: string;
  label: string;
  /** identities.channel of this provider's ids. */
  channel: string;
  /** Why it cannot be used now (not configured), or null. */
  unavailable(app: App): string | null;
  authorizeUrl(app: App, p: { state: string; challenge: string; redirectUri: string; scopes: string[] }): string;
  exchange(app: App, p: { code: string; verifier: string; redirectUri: string }): Promise<ProviderTokens>;
  whoami(app: App, tokens: ProviderTokens): Promise<ProviderIdentity>;
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

/** Providers people may log in with: the listed ones plus the primary one. */
export function enabledProviders(app: App): string[] {
  const { providers, primary } = app.config.auth;
  return [...new Set([...(primary ? [primary] : []), ...providers])].filter((id) => registry.has(id));
}

let fetcher: typeof fetch = (...a) => fetch(...a);
/** Tests: answer the providers' HTTP calls without the network. */
export function setAuthFetchForTests(fn: typeof fetch | null) {
  fetcher = fn ?? ((...a) => fetch(...a));
}
export const authFetch: typeof fetch = (...a) => fetcher(...a);
