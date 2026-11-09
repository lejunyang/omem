import { randomBytes, randomInt } from "node:crypto";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { createApiToken, getUser } from "../core/users.ts";
import { HttpError, now, sameSecret, sha256 } from "../core/util.ts";

/**
 * `omem login <地址>` (docs/v2/remote-clients.md §4.2): the command line asks for a code, the person
 * opens the page, logs in as usual (Feishu…) and allows this client; the command line, polling with
 * the secret only it has, then gets an API token of that person for this client. The code is shown
 * in the terminal and on the page so the person can see they are the same.
 */

const CODE_MS = 10 * 60_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const human = () => Array.from({ length: 8 }, (_, i) => (i === 4 ? "-" : "") + ALPHABET[randomInt(ALPHABET.length)]).join("");
export const normalizeCode = (code: string) => {
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

type Row = { code_hash: string; secret_hash: string; client: string; user_id: string | null; created_at: string; expires_at: string; approved_at: string | null; issued_at: string | null };
const find = (app: App, code: string) => one<Row>(app.db, "select * from cli_logins where code_hash = ?", sha256(normalizeCode(code)));
const live = (r: Row | undefined): r is Row => !!r && !r.issued_at && Date.parse(r.expires_at) > Date.now();

export function startCliLogin(app: App, client: string) {
  run(app.db, "delete from cli_logins where expires_at < ?", new Date(Date.now() - CODE_MS).toISOString());
  const code = human();
  const secret = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + CODE_MS).toISOString();
  run(app.db, "insert into cli_logins(code_hash,secret_hash,client,created_at,expires_at) values(?,?,?,?,?)", sha256(code), sha256(secret), client.replace(/[\x00-\x1f]/g, " ").trim().slice(0, 60) || "命令行", now(), expiresAt);
  return { code, secret, expiresAt };
}

/** What the confirmation page shows. */
export function cliLoginInfo(app: App, code: string) {
  const r = find(app, code);
  if (!live(r)) return null;
  return { client: r.client, approved: !!r.approved_at, expiresAt: r.expires_at };
}

export function approveCliLogin(app: App, code: string, userId: string) {
  const r = find(app, code);
  if (!live(r)) throw new HttpError(410, "这个确认码已失效：在命令行里重新 omem login");
  if (r.approved_at && r.user_id !== userId) throw new HttpError(409, "这个确认码已经被另一个账号允许了");
  run(app.db, "update cli_logins set user_id = ?, approved_at = ? where code_hash = ?", userId, now(), r.code_hash);
}

export function denyCliLogin(app: App, code: string) {
  run(app.db, "delete from cli_logins where code_hash = ? and issued_at is null", sha256(normalizeCode(code)));
}

/** The command line asking: waiting, or the token (once), or gone. */
export function pollCliLogin(app: App, code: string, secret: string): { status: "waiting" } | { status: "done"; token: string; user: { id: string; name: string } } {
  const r = find(app, code);
  if (!r || !sameSecret(sha256(secret), r.secret_hash)) throw new HttpError(404, "确认码不存在或已被拒绝");
  if (r.issued_at) throw new HttpError(410, "令牌已经发过了");
  if (Date.parse(r.expires_at) <= Date.now()) throw new HttpError(410, "确认码已过期：重新 omem login");
  if (!r.approved_at || !r.user_id) return { status: "waiting" };
  if (!run(app.db, "update cli_logins set issued_at = ? where code_hash = ? and issued_at is null", now(), r.code_hash).changes) throw new HttpError(410, "令牌已经发过了");
  const u = getUser(app, r.user_id);
  if (u.disabledAt || u.status !== "active") throw new HttpError(403, "这个账号现在不能使用");
  return { status: "done", token: createApiToken(app, u.id, `cli:${r.client}`, r.client), user: { id: u.id, name: u.name } };
}
