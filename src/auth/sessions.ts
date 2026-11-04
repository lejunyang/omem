import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, now, sha256 } from "../core/util.ts";
import { findUser } from "../core/users.ts";

/**
 * Login sessions: a random token in an HttpOnly cookie, only its SHA-256 kept (`auth_sessions`).
 * Sliding expiry (`auth.sessionDays`); a disabled user's sessions stop working at once. A restricted
 * session may only bind the primary login provider (an account made before `auth.primary` was set).
 */
export const SESSION_COOKIE = "omem_sid";
const TOUCH_MS = 60_000;

export function cookies(req: Pick<IncomingMessage, "headers">): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    // Other sites on the same host (localhost) set cookies too; a malformed one is skipped, not fatal.
    try {
      out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {}
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}
export const clearSessionCookie = (secure: boolean) => sessionCookie("", 0, secure);

export type Session = { userId: string; restricted: boolean; idHash: string; via: string };

export function createSession(app: App, userId: string, input: { via: string; restricted?: boolean; ip?: string; userAgent?: string }) {
  const token = randomBytes(32).toString("base64url");
  const at = now();
  const days = app.config.auth.sessionDays;
  run(
    app.db,
    "insert into auth_sessions(id_hash,user_id,via,restricted,created_at,last_seen_at,expires_at,ip,user_agent) values(?,?,?,?,?,?,?,?,?)",
    sha256(token), userId, input.via, input.restricted ? 1 : 0, at, at, new Date(Date.now() + days * 86400_000).toISOString(), input.ip ?? "", (input.userAgent ?? "").slice(0, 300),
  );
  return { token, maxAge: days * 86400, idHash: sha256(token) };
}

/** Who a session token stands for; null when unknown, expired, or the user is disabled. Pending users do have sessions. */
export function sessionFor(app: App, token: string | undefined): Session | null {
  if (!token || token.length > 100) return null;
  const idHash = sha256(token);
  const r = one<{ user_id: string; restricted: number; via: string; last_seen_at: string; expires_at: string }>(app.db, "select user_id, restricted, via, last_seen_at, expires_at from auth_sessions where id_hash = ?", idHash);
  if (!r) return null;
  if (Date.parse(r.expires_at) <= Date.now()) {
    run(app.db, "delete from auth_sessions where id_hash = ?", idHash);
    return null;
  }
  const u = findUser(app, r.user_id);
  if (!u || u.disabledAt) return null;
  if (Date.now() - Date.parse(r.last_seen_at) > TOUCH_MS)
    run(app.db, "update auth_sessions set last_seen_at = ?, expires_at = ? where id_hash = ?", now(), new Date(Date.now() + app.config.auth.sessionDays * 86400_000).toISOString(), idHash);
  return { userId: r.user_id, restricted: !!r.restricted, idHash, via: r.via };
}

export type SessionSummary = { id: string; via: string; restricted: boolean; createdAt: string; lastSeenAt: string; expiresAt: string; ip: string; userAgent: string; current: boolean };

/** A user's sessions, newest first. `id` is the start of the hash: enough to sign one out, useless to sign in. */
export function listSessions(app: App, userId: string, currentHash?: string | null): SessionSummary[] {
  return all<{ id_hash: string; via: string; restricted: number; created_at: string; last_seen_at: string; expires_at: string; ip: string; user_agent: string }>(
    app.db,
    "select * from auth_sessions where user_id = ? and expires_at > ? order by last_seen_at desc",
    userId,
    now(),
  ).map((r) => ({ id: r.id_hash.slice(0, 16), via: r.via, restricted: !!r.restricted, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent, current: r.id_hash === currentHash }));
}

export function revokeSession(app: App, userId: string, id: string) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, "会话 id 不对");
  const n = run(app.db, "delete from auth_sessions where user_id = ? and substr(id_hash, 1, 16) = ?", userId, id).changes;
  if (!n) throw new HttpError(404, "没有这个登录");
}
export const revokeSessionHash = (app: App, idHash: string) => run(app.db, "delete from auth_sessions where id_hash = ?", idHash);
export const revokeUserSessions = (app: App, userId: string) => Number(run(app.db, "delete from auth_sessions where user_id = ?", userId).changes);
export const liftRestriction = (app: App, idHash: string) => run(app.db, "update auth_sessions set restricted = 0 where id_hash = ?", idHash);
/** When the user last used a session (any device). */
export const lastSeen = (app: App, userId: string) => one<{ at: string | null }>(app.db, "select max(last_seen_at) at from auth_sessions where user_id = ?", userId)?.at ?? null;
