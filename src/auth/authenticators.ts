import type { App } from "../core/app.ts";
import { findUser } from "../core/users.ts";
import { HttpError, sha256 } from "../core/util.ts";
import { bearerLogin } from "./login.ts";
import type { ProviderIdentity } from "./providers.ts";

/**
 * Authenticator plugins (docs/v2/remote-clients.md §6): a bearer credential omem did not issue (an
 * organization's JWT, read from an environment variable or a command on someone's computer) that a
 * plugin can check. The plugin verifies it and says who it is; omem maps that to an account like a
 * login (src/auth/login.ts bearerLogin) and never keeps the credential. How a credential is checked
 * (issuer, keys, claims, any internal service) lives in the plugin in the data directory, not here.
 */
export type Authenticator = {
  /** Also the `identities.channel` of the people it recognizes; a plugin's starts with `<plugin id>-`. */
  id: string;
  label: string;
  /** Whether this credential is one of its kind, by shape only (a prefix, a JWT's `iss`); no network. */
  claims(token: string): boolean;
  /** Check it (signature, expiry…): who it is, or null when it is not valid. Throwing counts as not valid. */
  verify(token: string): Promise<AuthenticatedIdentity | null>;
};

export type AuthenticatedIdentity = {
  /** A stable id of the person (`sub`, an employee number). */
  externalId: string;
  name: string;
  email?: string | null;
  /** Only a verified email may claim an account made ahead of time (§7). */
  emailVerified?: boolean;
  avatar?: string | null;
  /** When the credential stops being valid (ms); omem remembers the result until then (10 minutes at most). */
  expiresAt?: number;
};

const registry = new Map<string, Authenticator>();

export function registerAuthenticator(a: Authenticator) {
  if (registry.has(a.id)) throw new Error(`已经有鉴权方式 ${a.id}`);
  registry.set(a.id, a);
  return () => {
    if (registry.get(a.id) === a) registry.delete(a.id);
    for (const [k, v] of cache) if (v.result?.provider === a.id) cache.delete(k);
  };
}
export const authenticators = () => [...registry.values()];

type Result = { userId: string; provider: string } | null;
const cache = new Map<string, { result: Result; until: number }>();
const MAX = 2000;
const OK_MS = 10 * 60_000;
const BAD_MS = 60_000;
/** Not issued by omem: what the authenticators get to look at. */
const foreign = (token: string) => !!token && !token.startsWith("om_") && !token.startsWith("ot_") && !token.startsWith("os_");

/** What an earlier check found for this credential (src/auth/http.ts resolveAuth): the account and the authenticator. */
export function knownBearer(token: string): Result {
  if (!foreign(token)) return null;
  const hit = cache.get(sha256(token));
  if (!hit) return null;
  if (hit.until <= Date.now()) {
    cache.delete(sha256(token));
    return null;
  }
  return hit.result;
}

/**
 * Before a request is resolved: let the authenticators check a credential omem did not issue, once
 * per credential until it expires. Throws for an account that may not be used (disabled, or nobody
 * new while multi-user login is off), so the person gets the reason rather than “invalid token”.
 */
export async function checkBearer(app: App, token: string): Promise<void> {
  if (!foreign(token) || !registry.size) return;
  const key = sha256(token);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return;
  const a = [...registry.values()].find((x) => {
    try {
      return x.claims(token);
    } catch {
      return false;
    }
  });
  if (!a) return;
  let who: AuthenticatedIdentity | null = null;
  try {
    who = await a.verify(token);
  } catch (e) {
    console.warn(`[omem] 鉴权插件 ${a.id} 验证凭据时出错：${(e as Error).message}`);
  }
  const remember = (result: Result, ms: number) => {
    if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { result, until: Date.now() + ms });
  };
  if (!who?.externalId) return remember(null, BAD_MS);
  const identity: ProviderIdentity = {
    externalId: String(who.externalId),
    name: who.name || String(who.externalId),
    email: who.email ?? null,
    avatar: who.avatar ?? null,
    verifiedEmails: who.emailVerified && who.email ? [who.email] : [],
  };
  const userId = bearerLogin(app, { id: a.id, channel: a.id, label: a.label }, identity);
  const u = findUser(app, userId);
  if (u?.disabledAt) throw new HttpError(403, "这个 omem 账号已停用");
  const ms = Math.max(0, Math.min(OK_MS, (who.expiresAt ?? Date.now() + OK_MS) - Date.now()));
  if (ms > 0) remember({ userId, provider: a.id }, ms);
}

/** Tests: start from nothing remembered. */
export function clearBearerCache() {
  cache.clear();
}
