import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { App } from "../core/app.ts";
import { newId, now } from "../core/util.ts";

/**
 * Connections and their tokens (docs/v2/multi-user.md, “令牌保管”): who connected which platform,
 * with what scopes, and the tokens — encrypted with AES-256-GCM under `secrets/vault.key`. Both live
 * in `secrets/vault.db`, outside the main database: they never go into a snapshot or a pull, so a
 * connection exists only on the machine where it was made, and only that machine acts with it.
 */
export type ConnectionStatus = "active" | "expired" | "error";
export type Connection = {
  id: string;
  userId: string;
  provider: string;
  accountId: string;
  accountName: string;
  scopes: string[];
  status: ConnectionStatus;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};
export type Secrets = { accessToken: string; refreshToken: string | null };

const handles = new Map<string, DatabaseSync>();

function keyOf(home: string) {
  const dir = join(home, "secrets");
  const file = join(dir, "vault.key");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {}
  }
  const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("secrets/vault.key 不是 32 字节的密钥");
  return key;
}

function db(app: App) {
  let d = handles.get(app.home);
  if (d) return d;
  mkdirSync(join(app.home, "secrets"), { recursive: true, mode: 0o700 });
  const file = join(app.home, "secrets", "vault.db");
  d = new DatabaseSync(file);
  try {
    chmodSync(file, 0o600);
  } catch {}
  d.exec(`pragma journal_mode = wal; pragma busy_timeout = 5000;
    create table if not exists connections (
      id text primary key,
      user_id text not null,
      provider text not null,
      account_id text not null,
      account_name text not null default '',
      scopes text not null default '[]',
      status text not null default 'active',
      expires_at text,
      refresh_expires_at text,
      last_error text,
      secret text not null,
      created_at text not null,
      updated_at text not null,
      unique (user_id, provider)
    );`);
  handles.set(app.home, d);
  return d;
}

/** Tests: close the vault of a data directory. */
export function closeVault(home: string) {
  handles.get(home)?.close();
  handles.delete(home);
}

function seal(app: App, s: Secrets) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(app.home), iv);
  const body = Buffer.concat([c.update(JSON.stringify(s), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}
function open(app: App, sealed: string): Secrets {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", keyOf(app.home), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8"));
}

type Row = { id: string; user_id: string; provider: string; account_id: string; account_name: string; scopes: string; status: string; expires_at: string | null; refresh_expires_at: string | null; last_error: string | null; secret: string; created_at: string; updated_at: string };
const toConnection = (r: Row): Connection => ({
  id: r.id,
  userId: r.user_id,
  provider: r.provider,
  accountId: r.account_id,
  accountName: r.account_name,
  scopes: JSON.parse(r.scopes),
  status: r.status as ConnectionStatus,
  expiresAt: r.expires_at,
  refreshExpiresAt: r.refresh_expires_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function findConnection(app: App, userId: string, provider: string): Connection | null {
  const r = db(app).prepare("select * from connections where user_id = ? and provider = ?").get(userId, provider) as Row | undefined;
  return r ? toConnection(r) : null;
}
export function getConnection(app: App, id: string): Connection | null {
  const r = db(app).prepare("select * from connections where id = ?").get(id) as Row | undefined;
  return r ? toConnection(r) : null;
}
export function listConnections(app: App, userId?: string): Connection[] {
  const rows = (userId ? db(app).prepare("select * from connections where user_id = ? order by created_at").all(userId) : db(app).prepare("select * from connections order by created_at").all()) as Row[];
  return rows.map(toConnection);
}
export function connectionSecrets(app: App, id: string): Secrets | null {
  const r = db(app).prepare("select secret from connections where id = ?").get(id) as { secret: string } | undefined;
  return r ? open(app, r.secret) : null;
}

const at = (seconds: number | undefined) => (seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null);

/** One connection per person and provider: a new authorization replaces the tokens and adds its scopes. */
export function storeConnection(
  app: App,
  input: { userId: string; provider: string; accountId: string; accountName: string; scopes: string[]; accessToken: string; refreshToken?: string | null; expiresIn?: number; refreshExpiresIn?: number },
): Connection {
  const old = findConnection(app, input.userId, input.provider);
  const keepRefresh = !input.refreshToken && old && old.accountId === input.accountId ? connectionSecrets(app, old.id)?.refreshToken ?? null : null;
  const secret = seal(app, { accessToken: input.accessToken, refreshToken: input.refreshToken ?? keepRefresh });
  const scopes = [...new Set([...(old && old.accountId === input.accountId ? old.scopes : []), ...input.scopes])].sort();
  const t = now();
  const refreshExpires = input.refreshToken ? at(input.refreshExpiresIn) : keepRefresh ? old!.refreshExpiresAt : null;
  db(app)
    .prepare(
      `insert into connections(id,user_id,provider,account_id,account_name,scopes,status,expires_at,refresh_expires_at,last_error,secret,created_at,updated_at) values(?,?,?,?,?,?,'active',?,?,null,?,?,?)
       on conflict(user_id, provider) do update set account_id = excluded.account_id, account_name = excluded.account_name, scopes = excluded.scopes, status = 'active',
         expires_at = excluded.expires_at, refresh_expires_at = excluded.refresh_expires_at, last_error = null, secret = excluded.secret, updated_at = excluded.updated_at`,
    )
    .run(old?.id ?? newId("cn"), input.userId, input.provider, input.accountId, input.accountName, JSON.stringify(scopes), at(input.expiresIn), refreshExpires, secret, old?.createdAt ?? t, t);
  return findConnection(app, input.userId, input.provider)!;
}

/** New tokens from a refresh (the old refresh token is used up). */
export function replaceTokens(app: App, id: string, t: { accessToken: string; refreshToken?: string | null; expiresIn?: number; refreshExpiresIn?: number; scope?: string }) {
  const old = connectionSecrets(app, id);
  const refresh = t.refreshToken ?? old?.refreshToken ?? null;
  const c = getConnection(app, id);
  db(app)
    .prepare("update connections set secret = ?, expires_at = ?, refresh_expires_at = coalesce(?, refresh_expires_at), scopes = coalesce(?, scopes), status = 'active', last_error = null, updated_at = ? where id = ?")
    .run(seal(app, { accessToken: t.accessToken, refreshToken: refresh }), at(t.expiresIn), t.refreshToken ? at(t.refreshExpiresIn) : null, t.scope ? JSON.stringify([...new Set([...(c?.scopes ?? []), ...t.scope.split(/\s+/).filter(Boolean)])].sort()) : null, now(), id);
}

/** The access token was turned down before its time: the next use refreshes it (connections.ts). */
export function expireAccessToken(app: App, id: string) {
  db(app).prepare("update connections set expires_at = ?, updated_at = ? where id = ?").run(now(), now(), id);
}

export function markConnection(app: App, id: string, status: ConnectionStatus, error: string | null) {
  db(app).prepare("update connections set status = ?, last_error = ?, updated_at = ? where id = ?").run(status, error?.slice(0, 500) ?? null, now(), id);
}
export function deleteConnection(app: App, id: string) {
  return Number(db(app).prepare("delete from connections where id = ?").run(id).changes) > 0;
}
