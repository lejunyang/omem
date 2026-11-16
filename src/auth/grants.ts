import { randomBytes } from "node:crypto";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { scopesFor } from "./features.ts";
import { findConnection } from "./vault.ts";

/**
 * A colleague who is not an omem user asks the assistant (in a group the owner is in) to change a
 * Feishu doc of theirs. Rather than asking them to give the owner edit access, or to add the bot as a
 * collaborator by hand, they get a link: Feishu's own authorization page for omem's app, which only
 * they can complete, asking for one thing, adding collaborators. Their token is kept like a member's
 * connection (src/auth/connections.ts: the refresh token renewed in the background) under
 * `lark:<open_id>`; when the bot cannot open a doc they asked about, it adds omem's bot as an editor
 * of that doc (`drive +member-add --member-type appid`), and the bot does the edit.
 */

/** Where a colleague's grant is kept: not an omem user, so the Feishu id stands in for one. */
export const guestUserId = (openId: string) => `lark:${openId}`;
export const isGuestUserId = (userId: string) => userId.startsWith("lark:");

const ADD_MEMBER = "docs:permission.member:create";
/** What the colleague is asked for: adding a collaborator to their docs (the bot), kept with a refresh token. */
export const grantScopes = () => [...new Set([ADD_MEMBER, ...scopesFor("lark", ["offline"])])];

const GRANT_MS = 30 * 60_000;
type Ticket = { openId: string; name: string; at: number };

/** Their working grant, if any (one that can add the bot to a doc). */
export function hasGrant(app: App, openId: string) {
  const c = findConnection(app, guestUserId(openId), "lark");
  return !!c && c.status === "active" && c.scopes.some((s) => s === ADD_MEMBER || s === "docs:doc" || s === "drive:drive");
}

/** A link for this person to authorize omem's app as themselves (valid half an hour; the page checks it is them). */
export function grantLink(app: App, who: { openId: string; name: string }) {
  const base = (app.config.webUrl || app.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new HttpError(400, "没有配置 omem 的网页地址（设置 → 安全 → 网页地址），发不了授权链接");
  run(app.db, "delete from kv where key glob 'lark_grant:*' and cast(json_extract(value, '$.at') as integer) < ?", Date.now() - GRANT_MS);
  const ticket = randomBytes(18).toString("base64url");
  run(app.db, "insert into kv(key,value) values(?,?)", `lark_grant:${ticket}`, JSON.stringify({ openId: who.openId, name: who.name, at: Date.now() } satisfies Ticket));
  return `${base}/api/auth/lark/grant/${ticket}`;
}

/** The person a grant link was made for; null when it is unknown or expired. */
export function readGrant(app: App, ticket: string): Ticket | null {
  const v = one<{ value: string }>(app.db, "select value from kv where key = ?", `lark_grant:${ticket}`)?.value;
  if (!v) return null;
  const t = JSON.parse(v) as Ticket;
  return Date.now() - t.at > GRANT_MS ? null : t;
}
