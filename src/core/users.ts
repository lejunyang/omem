import { randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { createSpace, findSpace } from "./spaces.ts";
import { HttpError, now, sha256, slugify } from "./util.ts";

/**
 * People. omem is used by one owner today, but every conversation, item,
 * card and run records whose it is, channel identities map to users, and
 * spaces have members — so adding a colleague later is configuration, not a
 * migration of everything.
 *
 * Access: the owner sees every space. A member sees their own personal space
 * plus spaces they were added to (reader or editor). Tool tokens, channel
 * turns and API tokens all go through `accessibleSpaces`.
 */
export const OWNER = "owner";
export type User = { id: string; name: string; role: "owner" | "member"; createdAt: string; disabledAt: string | null };
type Row = { id: string; name: string; role: string; created_at: string; disabled_at: string | null };
const toUser = (r: Row): User => ({ id: r.id, name: r.name, role: r.role === "owner" ? "owner" : "member", createdAt: r.created_at, disabledAt: r.disabled_at });

export function getUser(app: App, id: string): User {
  const r = one<Row>(app.db, "select * from users where id = ?", id);
  if (!r) throw new HttpError(404, `用户不存在：${id}`);
  return toUser(r);
}
export function findUser(app: App, id: string): User | null {
  const r = one<Row>(app.db, "select * from users where id = ?", id);
  return r ? toUser(r) : null;
}
export function listUsers(app: App) {
  return all<Row>(app.db, "select * from users order by created_at").map(toUser);
}

/** The personal space of a user: `personal` for the owner, `personal-<id>` for others. */
export function personalSpaceId(userId: string) {
  return userId === OWNER ? "personal" : `personal-${userId}`;
}

export function createUser(app: App, input: { name: string; id?: string; role?: "member" | "owner" }) {
  const id = slugify(input.id ?? input.name).replace(/[^a-z0-9-]/g, "") || `u${Date.now().toString(36)}`;
  if (findUser(app, id)) throw new HttpError(409, `用户已存在：${id}`);
  run(app.db, "insert into users(id,name,role,created_at) values(?,?,?,?)", id, input.name, input.role ?? "member", now());
  const sp = personalSpaceId(id);
  if (!findSpace(app, sp)) createSpace(app, { id: sp, name: `${input.name} 的个人空间`, kind: "personal" });
  run(app.db, "update spaces set owner_id = ? where id = ?", id, sp);
  addMember(app, sp, id, "owner");
  return getUser(app, id);
}

export function addMember(app: App, spaceId: string, userId: string, role: "reader" | "editor" | "owner" = "reader") {
  getUser(app, userId);
  if (!findSpace(app, spaceId)) throw new HttpError(404, `空间不存在：${spaceId}`);
  run(app.db, "insert into space_members(space_id,user_id,role) values(?,?,?) on conflict(space_id,user_id) do update set role = excluded.role", spaceId, userId, role);
}
export function removeMember(app: App, spaceId: string, userId: string) {
  run(app.db, "delete from space_members where space_id = ? and user_id = ?", spaceId, userId);
}

/** Spaces a user may read; null means all (the owner). */
export function accessibleSpaces(app: App, userId: string = OWNER): string[] | null {
  const u = findUser(app, userId);
  if (!u || u.disabledAt) return [];
  if (u.role === "owner") return null;
  return all<{ space_id: string }>(app.db, "select space_id from space_members where user_id = ?", userId).map((r) => r.space_id);
}
export function canWrite(app: App, userId: string, spaceId: string) {
  const u = findUser(app, userId);
  if (!u || u.disabledAt) return false;
  if (u.role === "owner") return true;
  const m = one<{ role: string }>(app.db, "select role from space_members where space_id = ? and user_id = ?", spaceId, userId);
  return m?.role === "editor" || m?.role === "owner";
}

/** Combine a run's own scope with what its user may see. */
export function scopeFor(app: App, userId: string, requested: string[] | null): string[] | null {
  const allowed = accessibleSpaces(app, userId);
  if (allowed === null) return requested;
  if (requested === null) return allowed;
  return requested.filter((s) => allowed.includes(s));
}

// ---- channel identities ----------------------------------------------------

/** The owner's ids from the channel configs count as identities without registration. */
function configuredOwner(app: App, channel: string, externalId: string) {
  const c = app.config;
  return (
    (channel === "lark" && !!c.lark.ownerOpenId && c.lark.ownerOpenId === externalId) ||
    (channel === "telegram" && !!c.telegram.ownerChatId && String(c.telegram.ownerChatId) === externalId) ||
    (channel === "onebot" && !!c.onebot.ownerUserId && String(c.onebot.ownerUserId) === externalId)
  );
}

/** Who sent a channel message; null for people who are not users. */
export function resolveIdentity(app: App, channel: string, externalId: string | number | undefined | null): string | null {
  if (externalId === undefined || externalId === null || externalId === "") return null;
  const id = String(externalId);
  if (configuredOwner(app, channel, id)) return OWNER;
  const r = one<{ user_id: string }>(app.db, "select i.user_id from identities i join users u on u.id = i.user_id where i.channel = ? and i.external_id = ? and u.disabled_at is null", channel, id);
  return r?.user_id ?? null;
}

export function linkIdentity(app: App, userId: string, channel: string, externalId: string) {
  getUser(app, userId);
  run(app.db, "insert into identities(channel,external_id,user_id,created_at) values(?,?,?,?) on conflict(channel,external_id) do update set user_id = excluded.user_id", channel, externalId, userId, now());
}
export function identitiesOf(app: App, userId: string) {
  return all<{ channel: string; external_id: string }>(app.db, "select channel, external_id from identities where user_id = ?", userId);
}

// ---- API tokens --------------------------------------------------------------

export function createApiToken(app: App, userId: string, label = "") {
  getUser(app, userId);
  const token = "om_" + randomBytes(24).toString("base64url");
  run(app.db, "insert into api_tokens(token_hash,user_id,label,created_at) values(?,?,?,?)", sha256(token), userId, label, now());
  return token;
}

/** The user a bearer token stands for: the configured token is the owner's. */
export function userForToken(app: App, token: string): string | null {
  if (!token) return null;
  if (app.config.token && token === app.config.token) return OWNER;
  const r = one<{ user_id: string }>(app.db, "select t.user_id from api_tokens t join users u on u.id = t.user_id where t.token_hash = ? and u.disabled_at is null", sha256(token));
  if (r) run(app.db, "update api_tokens set last_used_at = ? where token_hash = ?", now(), sha256(token));
  return r?.user_id ?? null;
}

export function userName(app: App, userId: string | null | undefined) {
  if (!userId || userId === OWNER) return "本人";
  return findUser(app, userId)?.name ?? userId;
}
