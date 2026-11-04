import { createHash, randomBytes } from "node:crypto";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { findSpace } from "../core/spaces.ts";
import { HttpError, json, newId, now, sha256 } from "../core/util.ts";
import { addMember, createUser, getUser, identitiesOf, identityOwner, linkIdentity, OWNER, setUserRole, updateUser, type User } from "../core/users.ts";
import { findRole, requirePerm } from "./permissions.ts";
import { saveConnection } from "./connections.ts";
import { findConnection } from "./vault.ts";
import { enabledProviders, loginProvider, type LoginProvider, type ProviderIdentity } from "./providers.ts";
import "./lark.ts";

/**
 * Logging in and binding (docs/v2/multi-user.md, “账号与登录”). A provider's identity maps to a
 * user through `identities`; the first login of someone unknown creates an account — pending until
 * the owner approves (`auth.signup`), or straight in with an invite. Once `auth.primary` is set only
 * that provider logs in: an account without the primary identity gets a restricted session that can
 * only bind it, other providers are for binding. Accounts are never merged: an identity that already
 * belongs to someone else is refused, for the owner to sort out.
 */

const STATE_MS = 10 * 60_000;
const LINK_MS = 5 * 60_000;
const b64 = (n: number) => randomBytes(n).toString("base64url");

/** connect: like bind, asking for a feature's scopes and keeping the tokens (src/auth/connections.ts). */
export type Purpose = "login" | "bind" | "connect";

function requireProvider(app: App, id: string): LoginProvider {
  const p = loginProvider(id);
  if (!p) throw new HttpError(404, `没有这个登录方式：${id}`);
  const why = p.unavailable(app);
  if (why) throw new HttpError(400, `${p.label}登录暂时不能用：${why}`);
  return p;
}

/** Start a login or a bind: where the browser goes next. */
export function beginLogin(app: App, input: { provider: string; purpose: Purpose; redirectUri: string; userId?: string; sessionHash?: string | null; invite?: string | null; returnTo?: string; scopes?: string[] }) {
  const p = requireProvider(app, input.provider);
  if (input.purpose === "login" && !app.config.auth.enabled) throw new HttpError(403, "omem 没有打开多人登录");
  if (input.purpose === "login" && !enabledProviders(app).includes(p.id)) throw new HttpError(403, `没有打开${p.label}登录`);
  if (input.purpose !== "login" && !input.userId) throw new HttpError(401, "先登录再绑定");
  if (input.purpose === "connect") requirePerm(app, input.userId!, "connector.use");
  run(app.db, "delete from auth_states where created_at < ?", new Date(Date.now() - STATE_MS).toISOString());
  const state = b64(24);
  const verifier = b64(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  run(
    app.db,
    "insert into auth_states(state,provider,verifier,purpose,user_id,session_hash,invite,redirect_uri,return_to,created_at) values(?,?,?,?,?,?,?,?,?,?)",
    state, p.id, verifier, input.purpose, input.userId ?? null, input.sessionHash ?? null, input.invite ?? null, input.redirectUri, safeReturn(input.returnTo), now(),
  );
  return p.authorizeUrl(app, { state, challenge, redirectUri: input.redirectUri, scopes: input.scopes ?? [] });
}

/** Only a path inside the page (`/ask/…`), never another site. */
export const safeReturn = (to: string | undefined | null) => (to && /^\/[^/\\]/.test(to) && !/[\r\n]/.test(to) ? to.slice(0, 300) : "");

export type LoginResult =
  | { kind: "session"; userId: string; restricted: boolean; via: string; returnTo: string; created: boolean }
  | { kind: "bound"; userId: string; via: string; returnTo: string; lifted: string | null; connected: boolean };

/** The provider sent the browser back: check the state, ask the provider who this is, find or create the user. */
export async function completeLogin(app: App, input: { provider: string; state: string; code?: string; error?: string }): Promise<LoginResult> {
  const st = one<{ state: string; provider: string; verifier: string; purpose: Purpose; user_id: string | null; session_hash: string | null; invite: string | null; redirect_uri: string; return_to: string; created_at: string }>(
    app.db,
    "select * from auth_states where state = ?",
    input.state ?? "",
  );
  if (st) run(app.db, "delete from auth_states where state = ?", st.state);
  if (!st || st.provider !== input.provider || Date.now() - Date.parse(st.created_at) > STATE_MS) throw new HttpError(400, "登录已过期或不是从这里发起的，请重新登录");
  if (input.error) throw new HttpError(400, input.error === "access_denied" ? "你取消了授权" : `授权没有完成：${input.error}`);
  if (!input.code) throw new HttpError(400, "授权没有返回 code");
  const p = requireProvider(app, st.provider);
  const tokens = await p.exchange(app, { code: input.code, verifier: st.verifier, redirectUri: st.redirect_uri });
  const who = await p.whoami(app, tokens);
  const r = st.purpose === "login" ? login(app, p, who, st.invite, st.return_to) : bind(app, p, who, st.user_id!, st.session_hash, st.return_to);
  // The tokens are kept for a connect, and whenever they bring scopes or there is a connection already:
  // a Feishu token carries every scope granted before, so a later login renews the connection.
  const keep = st.purpose === "connect" || !!tokens.refreshToken || !!tokens.scope?.trim() || !!findConnection(app, r.userId, p.id);
  if (keep) saveConnection(app, r.userId, p.id, who, tokens);
  return r.kind === "bound" ? { ...r, connected: keep } : r;
}

/** The account has the primary login provider bound (always true while none is set). */
export const hasPrimary = (app: App, userId: string) => {
  const primary = app.config.auth.primary ? loginProvider(app.config.auth.primary) : null;
  return !primary || identitiesOf(app, userId).some((i) => i.channel === primary.channel && i.kind === "login");
};

/** Record the identity (and its aliases) on the user; aliases someone else holds are left alone. */
function record(app: App, p: LoginProvider, who: ProviderIdentity, userId: string) {
  linkIdentity(app, userId, p.channel, who.externalId, { kind: "login", tenant: who.tenant, display: who.name, verified: true });
  for (const a of who.aliases ?? []) {
    const holder = identityOwner(app, p.channel, a.externalId);
    if (!holder || holder === userId) linkIdentity(app, userId, p.channel, a.externalId, { kind: "alias", tenant: who.tenant, appId: a.appId ?? null, display: who.name, verified: true });
  }
}

function login(app: App, p: LoginProvider, who: ProviderIdentity, inviteToken: string | null, returnTo: string): LoginResult {
  const primary = app.config.auth.primary;
  let userId = identityOwner(app, p.channel, who.externalId);
  for (const a of who.aliases ?? []) userId ??= identityOwner(app, p.channel, a.externalId);
  if (!userId && p.isOwner?.(app, who)) userId = OWNER;
  if (userId) {
    const u = getUser(app, userId);
    if (u.disabledAt) throw new HttpError(403, "这个账号已停用");
    let restricted = false;
    if (primary && primary !== p.id && !u.settings.loginAny) {
      const label = loginProvider(primary)?.label ?? primary;
      if (hasPrimary(app, userId)) throw new HttpError(403, `请用${label}登录`);
      restricted = true;
    }
    record(app, p, who, userId);
    if (!u.email && who.email) updateUser(app, userId, { email: who.email });
    if (!u.avatar && who.avatar) updateUser(app, userId, { avatar: who.avatar });
    return { kind: "session", userId, restricted, via: p.id, returnTo, created: false };
  }

  // Someone new.
  const invite = inviteToken ? validInvite(app, inviteToken) : null;
  if (inviteToken && !invite) throw new HttpError(400, "邀请链接无效、已用过或已过期");
  if (primary && primary !== p.id && !invite?.allowAny) throw new HttpError(403, `请用${loginProvider(primary)?.label ?? primary}登录`);
  const policy = invite ? "invite" : (app.config.auth.signup[p.id] ?? "approve");
  if (policy === "closed") throw new HttpError(403, "这里只接受邀请：请向 omem 的主人要一个邀请链接");
  const status = policy === "approve" ? "pending" : "active";
  const user = tx(app.db, () => {
    const u = createUser(app, { name: who.name, status, email: who.email ?? null, avatar: who.avatar ?? null });
    record(app, p, who, u.id);
    if (invite) useInvite(app, invite, u);
    return u;
  });
  if (status === "pending")
    notify(app, { title: "有人申请使用 omem", body: `${who.name}${who.email ? `（${who.email}）` : ""}用${p.label}登录，等你批准：设置 → 成员。`, link: "#/settings?tab=members", urgency: "normal" });
  return { kind: "session", userId: user.id, restricted: false, via: invite ? "invite" : p.id, returnTo, created: true };
}

function bind(app: App, p: LoginProvider, who: ProviderIdentity, userId: string, sessionHash: string | null, returnTo: string): LoginResult {
  const holder = identityOwner(app, p.channel, who.externalId) ?? (who.aliases ?? []).map((a) => identityOwner(app, p.channel, a.externalId)).find(Boolean) ?? (p.isOwner?.(app, who) ? OWNER : null);
  if (holder && holder !== userId) throw new HttpError(409, `这个${p.label}账号已经对应另一个 omem 账号，请联系 omem 的主人`);
  record(app, p, who, userId);
  const lifted = sessionHash && app.config.auth.primary === p.id ? sessionHash : null;
  return { kind: "bound", userId, via: p.id, returnTo, lifted, connected: false };
}

// ---- approving ---------------------------------------------------------------

export function approveUser(app: App, id: string) {
  const u = getUser(app, id);
  if (u.status !== "pending") return u;
  const next = updateUser(app, id, { status: "active" });
  notify(app, { userId: id, title: "omem：已经可以使用了", body: "omem 的主人批准了你的账号，刷新网页即可使用。", urgency: "normal" });
  return next;
}

// ---- invites -----------------------------------------------------------------

/** A space and the space role the invited person gets in it (reader, contributor, editor, manager or a custom one). */
export type InviteSpace = { space: string; role: string };
export type Invite = { id: string; role: string; spaces: InviteSpace[]; allowAny: boolean; note: string; createdBy: string; createdAt: string; expiresAt: string; usedBy: string | null; usedAt: string | null; revokedAt: string | null };
type InviteRow = { id: string; token_hash: string; role: string; spaces: string; allow_any: number; note: string; created_by: string; created_at: string; expires_at: string; used_by: string | null; used_at: string | null; revoked_at: string | null };
const toInvite = (r: InviteRow): Invite => ({ id: r.id, role: r.role, spaces: json<InviteSpace[]>(r.spaces, []), allowAny: !!r.allow_any, note: r.note, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, usedBy: r.used_by, usedAt: r.used_at, revokedAt: r.revoked_at });

/** An invite link: whoever logs in with it gets an account at once (no approval), with this global role and these spaces. */
export function createInvite(app: App, by: string, input: { role?: string; spaces?: InviteSpace[]; allowAny?: boolean; note?: string; days?: number }) {
  for (const s of input.spaces ?? []) {
    if (!findSpace(app, s.space)) throw new HttpError(404, `空间不存在：${s.space}`);
    if (findRole(app, s.role)?.scope !== "space") throw new HttpError(400, `不是空间角色：${s.role}`);
  }
  const role = input.role ?? "member";
  const r = findRole(app, role);
  if (!r || r.scope !== "global" || r.id === "owner") throw new HttpError(400, `不是可以分配的全局角色：${role}`);
  const token = b64(24);
  const id = newId("inv");
  const days = Math.min(Math.max(input.days ?? 7, 1), 90);
  run(
    app.db,
    "insert into invites(id,token_hash,role,spaces,allow_any,note,created_by,created_at,expires_at) values(?,?,?,?,?,?,?,?,?)",
    id, sha256(token), role, JSON.stringify(input.spaces ?? []), input.allowAny ? 1 : 0, (input.note ?? "").slice(0, 200), by, now(), new Date(Date.now() + days * 86400_000).toISOString(),
  );
  return { id, token };
}
export const listInvites = (app: App) => all<InviteRow>(app.db, "select * from invites order by created_at desc limit 200").map(toInvite);
export function revokeInvite(app: App, id: string) {
  if (!run(app.db, "update invites set revoked_at = coalesce(revoked_at, ?) where id = ?", now(), id).changes) throw new HttpError(404, "没有这个邀请");
}
export function validInvite(app: App, token: string): Invite | null {
  const r = one<InviteRow>(app.db, "select * from invites where token_hash = ?", sha256(token));
  if (!r || r.used_at || r.revoked_at || Date.parse(r.expires_at) <= Date.now()) return null;
  return toInvite(r);
}
function useInvite(app: App, invite: Invite, user: User) {
  run(app.db, "update invites set used_by = ?, used_at = ? where id = ? and used_at is null", user.id, now(), invite.id);
  if (invite.role !== "member" && findRole(app, invite.role)) setUserRole(app, user.id, invite.role);
  for (const s of invite.spaces) if (findSpace(app, s.space) && findRole(app, s.role)) addMember(app, s.space, user.id, s.role);
  if (invite.allowAny) updateUser(app, user.id, { settings: { loginAny: true } });
}

// ---- one-time links from a channel ---------------------------------------------

/**
 * A login link the bot sends someone in a private chat: Feishu (or Telegram, QQ) already told us who
 * sent the message. Five minutes, once. Opening it shows a button; only pressing it (a POST) signs in,
 * so a link preview fetching the page does not use it up.
 */
export function createLoginLink(app: App, userId: string, channel: string) {
  const code = b64(24);
  run(app.db, "delete from login_links where expires_at < ?", now());
  run(app.db, "insert into login_links(code_hash,user_id,channel,created_at,expires_at) values(?,?,?,?,?)", sha256(code), userId, channel, now(), new Date(Date.now() + LINK_MS).toISOString());
  return code;
}
export function peekLoginLink(app: App, code: string) {
  const r = one<{ user_id: string; expires_at: string; used_at: string | null }>(app.db, "select user_id, expires_at, used_at from login_links where code_hash = ?", sha256(code));
  return !!r && !r.used_at && Date.parse(r.expires_at) > Date.now();
}
export function consumeLoginLink(app: App, code: string): { userId: string; channel: string } | null {
  const r = one<{ code_hash: string; user_id: string; channel: string; expires_at: string; used_at: string | null }>(app.db, "select * from login_links where code_hash = ?", sha256(code));
  if (!r || r.used_at || Date.parse(r.expires_at) <= Date.now()) return null;
  if (!run(app.db, "update login_links set used_at = ? where code_hash = ? and used_at is null", now(), r.code_hash).changes) return null;
  const u = getUser(app, r.user_id);
  if (u.disabledAt || u.status !== "active") return null;
  return { userId: r.user_id, channel: r.channel };
}
