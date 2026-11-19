import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { App } from "../core/app.ts";
import type { AgentProfile } from "../core/config.ts";
import { one, run } from "../core/db.ts";
import { findUser, listUsers, OWNER, userName } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import { deleteConnection, connectionSecrets, findConnection, storeConnection } from "../auth/vault.ts";
import { sourceOf } from "./capacity.ts";
import { accountCatalog, type AccountSpec, type CatalogEntry } from "./catalog.ts";
import { accountOf, omemInstallDir, sandboxSupport, type SandboxAccount } from "./sandbox.ts";
import { launch, stop } from "./spawn.ts";

/**
 * Each omem user's own AI accounts (docs/v2/agent-accounts.md). A member logs in to a backend once
 * here (device code, QR code, or a pasted token); their runs on it then start in a sandbox whose HOME
 * is their account folder `<data>/accounts/<user>/home`. Not logged in: the owner's rule for that
 * backend (`agents.accounts`) says whether they borrow the owner's login or the run fails. The owner
 * never uses this layer: their runs keep the logins on this machine.
 *
 * omem only makes, points to and removes the folders: what a backend keeps inside is its own. The
 * login state is the last `status` check, kept per user and backend in kv; a token goes in the vault.
 */

export type AccountEntry = CatalogEntry & { account: AccountSpec };
export type AccountPolicy = "owner" | "own";
type Stored = { state: "none" | "logged-in" | "expired"; user?: string; checkedAt?: string; error?: string };
export type AccountState = Stored["state"] | "logging-in";

const KV = (userId: string, backend: string) => `agent_account:${userId}:${backend}`;
const TOKEN_PROVIDER = (backend: string) => `agent:${backend}`;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;

export function accountEntry(id: string): AccountEntry | null {
  return accountCatalog().find((e) => e.id === id) ?? null;
}
function requireEntry(id: string): AccountEntry {
  const e = accountEntry(id);
  if (!e) throw new HttpError(404, `后端 ${id} 不能按人登录`);
  return e;
}

/** The account backend a profile runs on (its source: an ACP agent and its CLI fallback are one), or null. */
export function accountEntryFor(p: AgentProfile): AccountEntry | null {
  if (p.keyRef || p.peer || p.transport === "doubao") return null;
  return accountEntry(sourceOf(p));
}

export function accountPolicy(app: App, backend: string): AccountPolicy {
  return app.config.agents.accounts?.[backend] ?? "owner";
}

// ---------------------------------------------------------------- folders

export function accountRoot(app: App, userId: string) {
  if (!SAFE_ID.test(userId) || userId === OWNER) throw new HttpError(400, "这个用户没有账号目录");
  return join(app.home, "accounts", userId);
}
export function accountHome(app: App, userId: string) {
  return join(accountRoot(app, userId), "home");
}

/** mkdir 0700, refusing a symbolic link anywhere from the data folder down. */
function privateDir(base: string, rel: string) {
  let at = base;
  for (const part of normalize(rel).split(/[\\/]/).filter(Boolean)) {
    if (part === "..") throw new Error(`账号目录里不能有 ..：${rel}`);
    at = join(at, part);
    if (existsSync(at) || isLink(at)) {
      if (lstatSync(at).isSymbolicLink()) throw new Error(`账号目录不能是符号链接：${at}`);
    } else mkdirSync(at, { mode: 0o700 });
    try {
      chmodSync(at, 0o700);
    } catch {}
  }
  return at;
}
function isLink(p: string) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The user's account folder with what this backend needs made beforehand. */
export function ensureAccountHome(app: App, userId: string, entry?: AccountEntry) {
  privateDir(app.home, join("accounts", userId, "home"));
  const home = accountHome(app, userId);
  for (const d of entry?.account.dirs ?? []) privateDir(home, d);
  return home;
}

const expandHome = (v: string, home: string) => v.replaceAll("{home}", home);

/** The service's own `~` and `${VAR:-default}` / `${VAR}` in a catalog path (where this machine installed something). */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env) {
  let s = p.replace(/\$\{(\w+):-([^}]*)\}/g, (_, v: string, d: string) => env[v] || d).replace(/\$\{(\w+)\}/g, (_, v: string) => env[v] ?? "");
  if (s === "~" || s.startsWith("~/")) s = join(env.HOME || homedir(), s.slice(1));
  return s;
}

/** What a run (or a login) with this user's account of this backend carries (agents/sandbox.ts). */
export function accountRun(app: App, userId: string, entry: AccountEntry): SandboxAccount {
  const home = accountHome(app, userId);
  const spec = entry.account;
  const token = spec.tokenEnv ? accountToken(app, userId, entry.id) : null;
  const env = Object.fromEntries(Object.entries(spec.env).map(([k, v]) => [k, expandHome(v, home)]));
  if (spec.tokenEnv && token) env[spec.tokenEnv] = token;
  return {
    userId,
    backend: entry.id,
    home,
    env,
    hide: [app.home],
    ro: [join(app.home, "bin"), omemInstallDir(), ...(spec.mounts ?? []).map((m) => expandPath(m))],
  };
}

// ---------------------------------------------------------------- state

function stored(app: App, userId: string, backend: string): Stored {
  try {
    return JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = ?", KV(userId, backend))?.value ?? "") as Stored;
  } catch {
    return { state: "none" };
  }
}
function save(app: App, userId: string, backend: string, s: Stored) {
  run(app.db, "insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", KV(userId, backend), JSON.stringify(s));
}

export function accountToken(app: App, userId: string, backend: string): string | null {
  const c = findConnection(app, userId, TOKEN_PROVIDER(backend));
  return c ? connectionSecrets(app, c.id)?.accessToken ?? null : null;
}

/** Logged in at the last check, and the folder is still there. */
export function loggedIn(app: App, userId: string, backend: string) {
  if (!SAFE_ID.test(userId) || userId === OWNER) return false;
  return stored(app, userId, backend).state === "logged-in" && existsSync(accountHome(app, userId));
}

// ---------------------------------------------------------------- choosing the account of a run

/** A person who can have accounts here: an active omem user other than the owner (not a guest). */
function member(app: App, userId: string) {
  if (userId === OWNER || !SAFE_ID.test(userId)) return false;
  const u = findUser(app, userId);
  return !!u && u.role !== "owner" && u.kind === "person";
}

/**
 * Why this user's run cannot use this backend at all (the owner set it to own accounts only, and they
 * have not logged in), or null. Used to leave such backends out of a run's fallbacks.
 */
export function accountBlocked(app: App, userId: string, p: AgentProfile): string | null {
  if (!member(app, userId)) return null;
  const entry = accountEntryFor(p);
  if (!entry || !sandboxSupport().ok || loggedIn(app, userId, entry.id)) return null;
  return accountPolicy(app, entry.id) === "own" ? `${entry.name} 只能用自己的账号：在 账号 → 我的 AI 账号 里登录 ${entry.name} 后再试` : null;
}

/**
 * The profile a run of this user starts with (runner.ts prepareRun). The owner, a backend without an
 * account entry, or a machine without the sandbox: unchanged. A member logged in to it: their account.
 * Not logged in: the owner's rule — borrow the owner's login, or fail with what to do.
 */
export function withAccount<P extends AgentProfile>(app: App, userId: string, p: P): P {
  if (accountOf(p)) return p;
  if (!member(app, userId)) return p;
  const entry = accountEntryFor(p);
  if (!entry || !sandboxSupport().ok) return p;
  if (loggedIn(app, userId, entry.id)) return { ...p, account: accountRun(app, userId, entry) };
  const blocked = accountBlocked(app, userId, p);
  if (blocked) throw new Error(blocked);
  return p;
}

/**
 * The same profile with this user's account whether or not they are logged in now: for cleaning up
 * a session their account made earlier (session-cleanup.ts). Null when the account folder is gone.
 */
export function recordedAccount<P extends AgentProfile>(app: App, userId: string, p: P): P | null {
  const entry = accountEntryFor(p);
  if (!entry || !SAFE_ID.test(userId) || userId === OWNER || !existsSync(accountHome(app, userId))) return null;
  return { ...p, account: accountRun(app, userId, entry) };
}

/** Carry the account of `from` onto another profile of the same run (a fallback step keeps its user's account). */
export function carryAccount<P extends AgentProfile>(from: AgentProfile, to: P): P {
  const a = accountOf(from);
  return a && !accountOf(to) ? { ...to, account: a } : to;
}

// ---------------------------------------------------------------- commands in the user's sandbox

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const clean = (s: string) => s.replace(ANSI, "");

function cliOf(entry: AccountEntry) {
  const c = entry.account.cli ?? entry.command;
  return /[~$/]/.test(c) ? expandPath(c) : c;
}

function start(app: App, userId: string, entry: AccountEntry, args: string[]): ChildProcessWithoutNullStreams {
  const home = ensureAccountHome(app, userId, entry);
  return launch(cliOf(entry), args, { cwd: home, env: {}, sandbox: accountRun(app, userId, entry) });
}

/** Run one short command of the backend in the user's sandbox: its exit code and what it printed. */
function runShort(app: App, userId: string, entry: AccountEntry, args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = start(app, userId, entry, args);
    } catch (e) {
      return resolve({ code: null, out: (e as Error).message });
    }
    child.stdin.end();
    child.stdout.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
    child.stderr.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-20_000)));
    const timer = setTimeout(() => stop(child), timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: e.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: clean(out) });
    });
  });
}

/** Ask the backend whether this user is logged in, and keep the answer. */
export async function checkAccount(app: App, userId: string, backend: string): Promise<Stored> {
  const entry = requireEntry(backend);
  const before = stored(app, userId, backend);
  const spec = entry.account;
  let next: Stored;
  if (!spec.status) next = { state: spec.tokenEnv && accountToken(app, userId, backend) ? "logged-in" : before.state };
  else {
    const r = await runShort(app, userId, entry, spec.status.args);
    if (r.code === 0) {
      const user = spec.status.user ? new RegExp(spec.status.user, "i").exec(r.out)?.[1] : undefined;
      next = { state: "logged-in", ...(user ? { user } : {}) };
    } else next = { state: before.state === "logged-in" || before.state === "expired" ? "expired" : "none", error: r.out.trim().slice(-300) || `退出码 ${r.code}` };
  }
  next.checkedAt = now();
  save(app, userId, backend, next);
  return next;
}

type Pending = { child: ChildProcessWithoutNullStreams; url: string; code?: string; startedAt: string };
const logins = new Map<string, Pending>();
const loginKey = (app: App, userId: string, backend: string) => `${app.home}|${userId}|${backend}`;

/**
 * Start the backend's login in the user's sandbox and return the link (and code) it prints. The
 * command is kept until it ends or times out; then the state is checked and kept.
 */
export function startLogin(app: App, userId: string, backend: string): Promise<{ url: string; code?: string }> {
  const entry = requireEntry(backend);
  const spec = entry.account.login;
  if (!spec) throw new HttpError(400, `${entry.name} 没有无界面登录：${entry.account.tokenEnv ? "粘贴令牌" : "这个后端暂时不能按人登录"}`);
  const support = sandboxSupport();
  if (!support.ok) throw new HttpError(400, `这台机器不能按人登录 AI 账号：${support.reason}`);
  const key = loginKey(app, userId, backend);
  const running = logins.get(key);
  if (running) return Promise.resolve({ url: running.url, ...(running.code ? { code: running.code } : {}) });
  let child: ChildProcessWithoutNullStreams;
  try {
    child = start(app, userId, entry, spec.args);
  } catch (e) {
    throw new HttpError(500, `启动登录失败：${(e as Error).message}`);
  }
  const urlRe = new RegExp(spec.url);
  const codeRe = spec.code ? new RegExp(spec.code) : null;
  let out = "";
  return new Promise((resolve, reject) => {
    let found: { url: string; code?: string } | null = null;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstTimer);
      clearTimeout(codeTimer);
      if (err || !found) {
        stop(child);
        return reject(err ?? new HttpError(502, "登录命令没有给出链接"));
      }
      const pending: Pending = { child, ...found, startedAt: now() };
      logins.set(key, pending);
      const overall = setTimeout(() => stop(child), spec.timeoutMs ?? 600_000);
      overall.unref?.();
      child.once("close", () => {
        clearTimeout(overall);
        if (logins.get(key) === pending) logins.delete(key);
        void checkAccount(app, userId, backend).catch(() => {});
      });
      resolve(found);
    };
    const firstTimer = setTimeout(() => finish(new HttpError(504, `登录命令 60 秒内没有给出链接：${clean(out).trim().slice(-300) || "没有输出"}`)), 60_000);
    let codeTimer: NodeJS.Timeout | undefined;
    const look = (d: Buffer) => {
      out = (out + d.toString()).slice(-20_000);
      const text = clean(out);
      const url = urlRe.exec(text)?.[0];
      if (!url) return;
      const code = codeRe?.exec(text.replace(url, ""))?.[0];
      found = { url, ...(code ? { code } : {}) };
      if (!codeRe || code) finish();
      // The code may come a line after the link.
      else codeTimer ??= setTimeout(() => finish(), 3000);
    };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.once("error", (e) => finish(new HttpError(500, `启动登录失败：${e.message}`)));
    child.once("close", (code) => {
      if (!settled) finish(new HttpError(502, `登录命令退出了（${code}），没有给出链接：${clean(out).trim().slice(-300) || "没有输出"}`));
    });
  });
}

/** A pasted token (`account.tokenEnv`): kept in the vault for this user, then checked. */
export async function saveToken(app: App, userId: string, backend: string, token: string) {
  const entry = requireEntry(backend);
  if (!entry.account.tokenEnv) throw new HttpError(400, `${entry.name} 不能用令牌登录`);
  const t = token.trim();
  if (t.length < 8 || t.length > 4096 || /\s/.test(t)) throw new HttpError(400, "令牌格式不对");
  ensureAccountHome(app, userId, entry);
  storeConnection(app, { userId, provider: TOKEN_PROVIDER(backend), accountId: backend, accountName: entry.name, scopes: [], accessToken: t });
  return checkAccount(app, userId, backend);
}

/**
 * Log this user out of a backend: the backend's own logout (failing is fine), the token, the backend's
 * part of the folder — the whole account folder when nothing else is left in it.
 */
export async function removeAccount(app: App, userId: string, backend: string) {
  const entry = requireEntry(backend);
  const key = loginKey(app, userId, backend);
  const pending = logins.get(key);
  if (pending) {
    logins.delete(key);
    stop(pending.child);
  }
  const home = accountHome(app, userId);
  if (entry.account.logout && existsSync(home) && sandboxSupport().ok) await runShort(app, userId, entry, entry.account.logout.args, 20_000).catch(() => {});
  const c = findConnection(app, userId, TOKEN_PROVIDER(backend));
  if (c) deleteConnection(app, c.id);
  run(app.db, "delete from kv where key = ?", KV(userId, backend));
  for (const rel of entry.account.owns) {
    const p = join(home, normalize(rel));
    if (!p.startsWith(home + sep)) continue;
    rmSync(p, { recursive: true, force: true });
  }
  const others = accountCatalog().some((e) => e.id !== backend && (stored(app, userId, e.id).state !== "none" || accountToken(app, userId, e.id) || logins.has(loginKey(app, userId, e.id))));
  if (!others) rmSync(accountRoot(app, userId), { recursive: true, force: true });
}

// ---------------------------------------------------------------- views

export type AccountBackendView = { id: string; name: string; policy: AccountPolicy; login: boolean; token: boolean; state: AccountState; user?: string; checkedAt?: string; error?: string; url?: string; code?: string };

function viewOf(app: App, userId: string, e: AccountEntry): AccountBackendView {
  const s = userId === OWNER ? ({ state: "none" } as Stored) : stored(app, userId, e.id);
  const pending = logins.get(loginKey(app, userId, e.id));
  return {
    id: e.id,
    name: e.name,
    policy: accountPolicy(app, e.id),
    login: !!e.account.login,
    token: !!e.account.tokenEnv,
    state: pending ? "logging-in" : s.state === "logged-in" && !existsSync(accountHome(app, userId)) ? "none" : s.state,
    ...(s.user ? { user: s.user } : {}),
    ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
    ...(s.error && s.state !== "logged-in" ? { error: s.error } : {}),
    ...(pending ? { url: pending.url, ...(pending.code ? { code: pending.code } : {}) } : {}),
  };
}

/** One person's backends and states (GET /api/me/agent-accounts). */
export function myAccounts(app: App, userId: string) {
  const s = sandboxSupport();
  return {
    supported: s.ok,
    ...(s.ok ? {} : { reason: s.reason }),
    owner: userId === OWNER || !member(app, userId),
    backends: s.ok ? accountCatalog().map((e) => viewOf(app, userId, e)) : [],
  };
}

/** The owner's view: every member and the backends they logged in to (no tokens). */
export function allAccounts(app: App) {
  const s = sandboxSupport();
  const people = s.ok
    ? listUsers(app)
        .filter((u) => member(app, u.id))
        .map((u) => ({
          userId: u.id,
          name: userName(app, u.id),
          backends: accountCatalog()
            .map((e) => viewOf(app, u.id, e))
            .filter((b) => b.state !== "none" || accountToken(app, u.id, b.id)),
        }))
    : [];
  return { supported: s.ok, ...(s.ok ? {} : { reason: s.reason }), bwrap: s.version ?? null, backends: s.ok ? accountCatalog().map((e) => ({ id: e.id, name: e.name, policy: accountPolicy(app, e.id) })) : [], people };
}

/** Tests: forget logins in progress. */
export function stopAccountLogins() {
  for (const p of logins.values()) stop(p.child);
  logins.clear();
}
