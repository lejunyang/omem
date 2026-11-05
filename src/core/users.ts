import { randomBytes } from "node:crypto";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { createSpace, findSpace } from "./spaces.ts";
import { can, findRole, spacesWith } from "../auth/permissions.ts";
import { HttpError, json, now, sameSecret, sha256, slugify } from "./util.ts";

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
/** `pending`: signed up by logging in, waiting for the owner (src/auth); cannot use anything yet. */
export type UserStatus = "active" | "pending";
/** Per-user switches the owner sets. loginAny: may log in with providers other than auth.primary. */
/** `featuresOff`: connection features the person turned off in omem, by provider (auth/connections.ts). */
export type UserSettings = { loginAny?: boolean; featuresOff?: Record<string, string[]> };
export type User = {
  id: string;
  name: string;
  /** Global role id (src/auth/permissions.ts): owner, admin, member, viewer or a custom role. */
  role: string;
  kind: "person" | "service";
  status: UserStatus;
  email: string | null;
  avatar: string | null;
  settings: UserSettings;
  createdAt: string;
  disabledAt: string | null;
};
type Row = { id: string; name: string; role: string; kind: string; status: string; email: string | null; avatar: string | null; settings: string; created_at: string; disabled_at: string | null };
const toUser = (r: Row): User => ({
  id: r.id,
  name: r.name,
  role: r.role,
  kind: r.kind === "service" ? "service" : "person",
  status: r.status === "pending" ? "pending" : "active",
  email: r.email,
  avatar: r.avatar,
  settings: json<UserSettings>(r.settings, {}),
  createdAt: r.created_at,
  disabledAt: r.disabled_at,
});
/** Can act: not disabled, not waiting for approval. */
export const activeUser = (u: User | null | undefined): u is User => !!u && !u.disabledAt && u.status === "active";

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

export function createUser(app: App, input: { name: string; id?: string; role?: string; status?: UserStatus; email?: string | null; avatar?: string | null }) {
  let id = slugify(input.id ?? input.name).replace(/[^a-z0-9-]/g, "") || `u${Date.now().toString(36)}`;
  if (findUser(app, id)) {
    // Someone logging in for the first time has no say in the id: take the next free one.
    if (input.id) throw new HttpError(409, `用户已存在：${id}`);
    let n = 2;
    while (findUser(app, `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  run(app.db, "insert into users(id,name,role,status,email,avatar,created_at) values(?,?,?,?,?,?,?)", id, input.name, input.role ?? "member", input.status ?? "active", input.email ?? null, input.avatar ?? null, now());
  const sp = personalSpaceId(id);
  if (!findSpace(app, sp)) createSpace(app, { id: sp, name: `${input.name} 的个人空间`, kind: "personal" });
  run(app.db, "update spaces set owner_id = ? where id = ?", id, sp);
  addMember(app, sp, id, "manager");
  return getUser(app, id);
}

/** A space role (src/auth/permissions.ts): reader | contributor | editor | manager, or a custom one. */
export function addMember(app: App, spaceId: string, userId: string, role = "reader") {
  getUser(app, userId);
  if (!findSpace(app, spaceId)) throw new HttpError(404, `空间不存在：${spaceId}`);
  const r = findRole(app, role === "owner" ? "manager" : role);
  if (!r || r.scope !== "space") throw new HttpError(400, `不是空间角色：${role}`);
  run(app.db, "insert into space_members(space_id,user_id,role) values(?,?,?) on conflict(space_id,user_id) do update set role = excluded.role", spaceId, userId, r.id);
}
export function removeMember(app: App, spaceId: string, userId: string) {
  run(app.db, "delete from space_members where space_id = ? and user_id = ?", spaceId, userId);
}
/** A user's global role (admin, member, viewer or a custom one); the owner's stays. */
export function setUserRole(app: App, userId: string, role: string) {
  if (userId === OWNER) throw new HttpError(400, "本人的角色不能改");
  const r = findRole(app, role);
  if (!r || r.scope !== "global" || r.id === "owner") throw new HttpError(400, `不是可以分配的全局角色：${role}`);
  getUser(app, userId);
  run(app.db, "update users set role = ? where id = ?", r.id, userId);
}

/** Spaces a user may read; null means all (the owner). */
export function accessibleSpaces(app: App, userId: string = OWNER): string[] | null {
  return spacesWith(app, userId, "space.read");
}
/** May write memories, items and originals in the space (Wiki pages need `wiki.write`). */
export function canWrite(app: App, userId: string, spaceId: string) {
  return can(app, userId, "memory.write", spaceId);
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
  const r = one<{ user_id: string }>(app.db, "select i.user_id from identities i join users u on u.id = i.user_id where i.channel = ? and i.external_id = ? and u.disabled_at is null and u.status = 'active'", channel, id);
  return r?.user_id ?? null;
}

/**
 * `login`: what a provider logs someone in by (Feishu union_id); `alias`: the same person in one app's
 * id space (a Feishu open_id differs per app), so channel messages still resolve to them.
 */
export type IdentityKind = "login" | "alias";
export type Identity = { channel: string; external_id: string; user_id: string; kind: IdentityKind; tenant: string; app_id: string | null; display: string; created_at: string; verified_at: string | null };

export function linkIdentity(app: App, userId: string, channel: string, externalId: string, opts: { kind?: IdentityKind; tenant?: string; appId?: string | null; display?: string; verified?: boolean } = {}) {
  getUser(app, userId);
  const kind = opts.kind ?? (channel.startsWith("lark") && externalId.startsWith("ou_") ? "alias" : "login");
  run(
    app.db,
    `insert into identities(channel,external_id,user_id,created_at,kind,tenant,app_id,display,verified_at) values(?,?,?,?,?,?,?,?,?)
     on conflict(channel,external_id) do update set user_id = excluded.user_id, kind = excluded.kind,
       tenant = case when excluded.tenant != '' then excluded.tenant else identities.tenant end,
       app_id = coalesce(excluded.app_id, identities.app_id),
       display = case when excluded.display != '' then excluded.display else identities.display end,
       verified_at = coalesce(excluded.verified_at, identities.verified_at)`,
    channel, externalId, userId, now(), kind, opts.tenant ?? "", opts.appId ?? null, opts.display ?? "", opts.verified ? now() : null,
  );
}
export function identitiesOf(app: App, userId: string) {
  return all<Identity>(app.db, "select * from identities where user_id = ? order by kind, created_at", userId);
}
/**
 * A user's open_id in the main bot's app (what the bot sends to). Aliases recorded without an app are
 * the bot's: `omem user add --lark` and the bot's own events. Other apps' open_ids do not work there.
 */
export function larkOpenIdOf(app: App, userId: string): string | undefined {
  const appId = app.config.lark.appId ?? null;
  return identitiesOf(app, userId).find((i) => i.channel === "lark" && i.kind === "alias" && (!i.app_id || i.app_id === appId))?.external_id;
}
/** Who an identity belongs to (whatever their status), or null. */
export function identityOwner(app: App, channel: string, externalId: string): string | null {
  return one<{ user_id: string }>(app.db, "select user_id from identities where channel = ? and external_id = ?", channel, externalId)?.user_id ?? null;
}
export function unlinkIdentity(app: App, channel: string, externalId: string) {
  return run(app.db, "delete from identities where channel = ? and external_id = ?", channel, externalId).changes > 0;
}

export function updateUser(app: App, id: string, patch: { name?: string; status?: UserStatus; email?: string | null; avatar?: string | null; settings?: UserSettings; disabled?: boolean }) {
  const u = getUser(app, id);
  if (id === OWNER && (patch.disabled || patch.status === "pending")) throw new HttpError(400, "不能停用本人");
  run(
    app.db,
    "update users set name = ?, status = ?, email = ?, avatar = ?, settings = ?, disabled_at = ? where id = ?",
    patch.name ?? u.name,
    patch.status ?? u.status,
    patch.email === undefined ? u.email : patch.email,
    patch.avatar === undefined ? u.avatar : patch.avatar,
    JSON.stringify(patch.settings ? { ...u.settings, ...patch.settings } : u.settings),
    patch.disabled === undefined ? u.disabledAt : patch.disabled ? (u.disabledAt ?? now()) : null,
    id,
  );
  return getUser(app, id);
}

// ---- API tokens --------------------------------------------------------------

export function createApiToken(app: App, userId: string, label = "") {
  getUser(app, userId);
  const token = "om_" + randomBytes(24).toString("base64url");
  run(app.db, "insert into api_tokens(token_hash,user_id,label,created_at) values(?,?,?,?)", sha256(token), userId, label, now());
  return token;
}

export function listApiTokens(app: App, userId?: string) {
  return all<{ user_id: string; label: string; created_at: string; last_used_at: string | null }>(
    app.db,
    `select user_id, label, created_at, last_used_at from api_tokens${userId ? " where user_id = ?" : ""} order by created_at`,
    ...(userId ? [userId] : []),
  );
}

/** Revoke a user's tokens by label (a pairing is `peer:<label>`); returns how many. */
export function revokeApiTokens(app: App, userId: string, label: string) {
  const n = all(app.db, "select 1 from api_tokens where user_id = ? and label = ?", userId, label).length;
  run(app.db, "delete from api_tokens where user_id = ? and label = ?", userId, label);
  return n;
}

/**
 * Devices holding a pairing token of the owner (`omem peer invite`, label `peer:<label>`). `id` is
 * the start of the token's hash: enough to revoke one when several share a label, useless as a token.
 */
export function pairedTokens(app: App) {
  return all<{ token_hash: string; label: string; created_at: string; last_used_at: string | null }>(
    app.db,
    "select token_hash, label, created_at, last_used_at from api_tokens where user_id = ? and label like 'peer:%' order by created_at",
    OWNER,
  ).map((t) => ({ id: t.token_hash.slice(0, 16), label: t.label.slice(5), createdAt: t.created_at, lastUsedAt: t.last_used_at }));
}

export function revokePairedToken(app: App, id: string) {
  if (!/^[0-9a-f]{16}$/.test(id)) return false;
  const r = one<{ token_hash: string }>(app.db, "select token_hash from api_tokens where user_id = ? and label like 'peer:%' and substr(token_hash, 1, 16) = ?", OWNER, id);
  if (r) run(app.db, "delete from api_tokens where token_hash = ?", r.token_hash);
  return !!r;
}

/** Revoke the token itself (a paired device unpairing, `/api/peer/unpair`); true when it existed. */
export function revokeTokenValue(app: App, token: string) {
  const n = all(app.db, "select 1 from api_tokens where token_hash = ?", sha256(token)).length;
  run(app.db, "delete from api_tokens where token_hash = ?", sha256(token));
  return n > 0;
}

/** The user a bearer token stands for: the configured token is the owner's. */
export function userForToken(app: App, token: string): string | null {
  if (!token) return null;
  if (app.config.token && sameSecret(token, app.config.token)) return OWNER;
  const r = one<{ user_id: string }>(app.db, "select t.user_id from api_tokens t join users u on u.id = t.user_id where t.token_hash = ? and u.disabled_at is null and u.status = 'active'", sha256(token));
  if (r) run(app.db, "update api_tokens set last_used_at = ? where token_hash = ?", now(), sha256(token));
  return r?.user_id ?? null;
}

export function userName(app: App, userId: string | null | undefined) {
  if (!userId || userId === OWNER) return "本人";
  return findUser(app, userId)?.name ?? userId;
}
