import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { App } from "../core/app.ts";
import { allProfiles, type AgentProfile } from "../core/config.ts";
import { all, one, run } from "../core/db.ts";
import { findUser, listUsers, OWNER, userName } from "../core/users.ts";
import { HttpError, now } from "../core/util.ts";
import { audit } from "../auth/permissions.ts";
import { deleteConnection, connectionSecrets, findConnection, listConnections, storeConnection } from "../auth/vault.ts";
import { writeAccountEntries } from "./agent-skills.ts";
import { loginMethod, loginMethodsFor, type AgentLoginContext, type AgentLoginMethod } from "./agent-logins.ts";
import { backendAvailable } from "./availability.ts";
import { sourceOf } from "./capacity.ts";
import { accountCatalog, type AccountSpec, type CatalogEntry } from "./catalog.ts";
import { forgetQuota, quotaKind, quotaView, refreshQuota } from "./quota.ts";
import { accountOf, omemInstallDir, sandboxSupport, type SandboxAccount } from "./sandbox.ts";
import { launch, stop } from "./spawn.ts";

/**
 * Each omem user's own AI accounts (docs/v2/agent-accounts.md). A member logs in to a backend once
 * here (device code, QR code, a pasted token, or a login method a plugin brings); their runs on it
 * then start in a sandbox whose HOME is their account folder `<data>/accounts/<user>/home`. Not
 * logged in: the owner's rule for that backend (`agents.accounts`) says whether they borrow the
 * owner's login, the run fails, or it moves to another backend. The owner never uses this layer:
 * their runs keep the logins on this machine.
 *
 * omem only makes, points to and removes the folders: what a backend keeps inside is its own. The
 * login state is the last check, kept per user and backend in kv with the method that logged them in;
 * a token goes in the vault, and so does the one secret a plugin's login method keeps per person.
 */

export type AccountEntry = CatalogEntry & { account: AccountSpec };
export type AccountPolicy = "owner" | "own" | "own-or-other";
type Stored = {
  state: "none" | "logged-in" | "expired";
  user?: string;
  checkedAt?: string;
  error?: string;
  /** How they logged in: the backend's own login (`native`, also a pasted token) or a plugin's method (`<plugin>:<id>`). */
  method?: string;
  /** A plugin login's credentials stop working then (ms); refreshed 10 minutes before. */
  expiresAt?: number;
  /** When the next refresh is due (ms): kept, so a restart picks it up. */
  refreshAt?: number;
};
export type AccountState = Stored["state"] | "logging-in";

const KV = (userId: string, backend: string) => `agent_account:${userId}:${backend}`;
const TOKEN_PROVIDER = (backend: string) => `agent:${backend}`;
/** A plugin login method's secret for one person: `agent:<backend>:<plugin>:<id>` (hidden from 已连接的应用 like the tokens). */
const SECRET_PROVIDER = (backend: string, method: string) => `agent:${backend}:${method}`;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
/** A login (the backend's own or a plugin's) is given up after this long. */
const PLUGIN_LOGIN_MS = 11 * 60_000;
const REFRESH_BEFORE_MS = 10 * 60_000;
const REFRESH_GAP_MS = 60_000;

/** Every backend that can run with a user's own account here: the catalog's and the owner's profiles with `account`. */
export function accountEntries(app: App): AccountEntry[] {
  return accountCatalog(app.config.agents.profiles);
}
export function accountEntry(app: App, id: string): AccountEntry | null {
  return accountEntries(app).find((e) => e.id === id) ?? null;
}
function requireEntry(app: App, id: string): AccountEntry {
  const e = accountEntry(app, id);
  if (!e) throw new HttpError(404, `后端 ${id} 不能按人登录`);
  return e;
}

/** The account backend a profile runs on (its source: an ACP agent and its CLI fallback are one), or null. */
export function accountEntryFor(app: App, p: AgentProfile): AccountEntry | null {
  if (p.keyRef || p.peer || p.transport === "doubao") return null;
  return accountEntry(app, sourceOf(p));
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

/** mkdir 0700, refusing a symbolic link anywhere from the data folder down. Whether anything was made. */
function privateDir(base: string, rel: string) {
  let at = base;
  let made = false;
  for (const part of normalize(rel).split(/[\\/]/).filter(Boolean)) {
    if (part === "..") throw new Error(`账号目录里不能有 ..：${rel}`);
    at = join(at, part);
    if (existsSync(at) || isLink(at)) {
      if (lstatSync(at).isSymbolicLink()) throw new Error(`账号目录不能是符号链接：${at}`);
    } else {
      mkdirSync(at, { mode: 0o700 });
      made = true;
    }
    try {
      chmodSync(at, 0o700);
    } catch {}
  }
  return made;
}
function isLink(p: string) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The user's account folder with what this backend needs made beforehand. When it is new (or a
 * backend's folder in it is), omem's guide and the skill group hubs go in too, as in the agents'
 * own skill folders (agent-skills.ts), while the owner has the takeover on.
 */
export function ensureAccountHome(app: App, userId: string, entry?: AccountEntry) {
  let made = privateDir(app.home, join("accounts", userId, "home"));
  const home = accountHome(app, userId);
  for (const d of entry?.account.dirs ?? []) made = privateDir(home, d) || made;
  if (made && app.config.agentSkills.takeOver) {
    try {
      writeAccountEntries(app, [home]);
    } catch (e) {
      console.warn(`[omem] 往账号目录写技能入口失败：${(e as Error).message}`);
    }
  }
  return home;
}

const expandHome = (v: string, home: string) => v.replaceAll("{home}", home);

/** The service's own `~` and `${VAR:-default}` / `${VAR}` in a catalog path (where this machine installed something). */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env) {
  let s = p.replace(/\$\{(\w+):-([^}]*)\}/g, (_, v: string, d: string) => env[v] || d).replace(/\$\{(\w+)\}/g, (_, v: string) => env[v] ?? "");
  if (s === "~" || s.startsWith("~/")) s = join(env.HOME || homedir(), s.slice(1));
  return s;
}

/** The backend's `account.env` for this user's folder (no token). */
export function accountEnv(app: App, userId: string, entry: AccountEntry): Record<string, string> {
  const home = accountHome(app, userId);
  return Object.fromEntries(Object.entries(entry.account.env).map(([k, v]) => [k, expandHome(v, home)]));
}

/** What a run (or a login) with this user's account of this backend carries (agents/sandbox.ts). */
export function accountRun(app: App, userId: string, entry: AccountEntry): SandboxAccount {
  const home = accountHome(app, userId);
  const spec = entry.account;
  const token = spec.tokenEnv ? accountToken(app, userId, entry.id) : null;
  const env = accountEnv(app, userId, entry);
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

/** This user's account on each installed profile of the backend, ACP ones first (for probing and reading quota). */
export function accountProfiles(app: App, userId: string, backend: string): AgentProfile[] {
  const entry = accountEntry(app, backend);
  if (!entry) return [];
  const list = allProfiles(app.config).filter((p) => accountEntryFor(app, p)?.id === backend && (p.transport === "acp" || p.transport === "doubao-cli") && backendAvailable(p, app.home));
  return list.sort((a, b) => Number(b.transport === "acp") - Number(a.transport === "acp")).map((p) => ({ ...p, ownAccount: accountRun(app, userId, entry) }));
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
/** Tests and the owner's tools: what is kept for one user and backend. */
export function accountState(app: App, userId: string, backend: string): Stored {
  return stored(app, userId, backend);
}
const isPlugin = (method?: string) => !!method && method !== "native";

export function accountToken(app: App, userId: string, backend: string): string | null {
  const c = findConnection(app, userId, TOKEN_PROVIDER(backend));
  return c ? connectionSecrets(app, c.id)?.accessToken ?? null : null;
}

/** Logged in at the last check, the folder is still there, and a plugin login has not run out. */
export function loggedIn(app: App, userId: string, backend: string) {
  if (!SAFE_ID.test(userId) || userId === OWNER) return false;
  const s = stored(app, userId, backend);
  return s.state === "logged-in" && (s.expiresAt === undefined || s.expiresAt > Date.now()) && existsSync(accountHome(app, userId));
}

// ---------------------------------------------------------------- choosing the account of a run

/** A person who can have accounts here: an active omem user other than the owner (not a guest). */
function member(app: App, userId: string) {
  if (userId === OWNER || !SAFE_ID.test(userId)) return false;
  const u = findUser(app, userId);
  return !!u && u.role !== "owner" && u.kind === "person";
}

/**
 * Why this user's run cannot start on this backend as it is (the owner set it to own accounts —
 * only, or before trying another backend — and they have not logged in), or null. Used to leave
 * such backends out of a run's fallbacks.
 */
export function accountBlocked(app: App, userId: string, p: AgentProfile): string | null {
  if (accountOf(p) || !member(app, userId)) return null;
  const entry = accountEntryFor(app, p);
  if (!entry || !sandboxSupport().ok || loggedIn(app, userId, entry.id)) return null;
  const policy = accountPolicy(app, entry.id);
  if (policy === "own") return `${entry.name} 只能用自己的账号：在 账号 → 我的 AI 账号 里登录 ${entry.name} 后再试`;
  if (policy === "own-or-other") return `${entry.name} 要用自己的账号（没登录时换别的后端）：在 账号 → 我的 AI 账号 里登录 ${entry.name}`;
  return null;
}

/** The profile with this user's own account when they are logged in to its backend; else as it is. Never throws. */
export function accountFor<P extends AgentProfile>(app: App, userId: string | undefined, p: P): P {
  if (!userId || accountOf(p) || !member(app, userId) || !sandboxSupport().ok) return p;
  const entry = accountEntryFor(app, p);
  return entry && loggedIn(app, userId, entry.id) ? { ...p, ownAccount: accountRun(app, userId, entry) } : p;
}

/**
 * The profile a run of this user starts with (runner.ts prepareRun). The owner, a backend without an
 * account entry, or a machine without the sandbox: unchanged. A member logged in to it: their account.
 * Not logged in: the owner's rule — borrow the owner's login, fail with what to do, or (`own-or-other`)
 * the first of `others` (the run's fallback order) they are logged in to or may borrow.
 */
export function withAccount<P extends AgentProfile>(app: App, userId: string, p: P, others?: () => AgentProfile[]): P {
  if (accountOf(p)) return p;
  if (!member(app, userId)) return p;
  const entry = accountEntryFor(app, p);
  if (!entry || !sandboxSupport().ok) return p;
  if (loggedIn(app, userId, entry.id)) return { ...p, ownAccount: accountRun(app, userId, entry) };
  const policy = accountPolicy(app, entry.id);
  if (policy === "owner") return p;
  if (policy === "own-or-other") {
    for (const q of others?.() ?? []) {
      if (sourceOf(q) === sourceOf(p) || accountBlocked(app, userId, q) || !backendAvailable(q, app.home)) continue;
      return withAccount(app, userId, q as P);
    }
    throw new Error(`${entry.name} 要用你自己的账号，你还没登录；也没有别的你登录过、或允许借用的后端可换：在 账号 → 我的 AI 账号 里登录 ${entry.name} 后再试`);
  }
  throw new Error(accountBlocked(app, userId, p) ?? `${entry.name} 只能用自己的账号`);
}

/**
 * The same profile with this user's account whether or not they are logged in now: for cleaning up
 * a session their account made earlier (session-cleanup.ts). Null when the account folder is gone.
 */
export function recordedAccount<P extends AgentProfile>(app: App, userId: string, p: P): P | null {
  const entry = accountEntryFor(app, p);
  if (!entry || !SAFE_ID.test(userId) || userId === OWNER || !existsSync(accountHome(app, userId))) return null;
  return { ...p, ownAccount: accountRun(app, userId, entry) };
}

/** Carry the account of `from` onto another profile of the same run (a fallback step keeps its user's account). */
export function carryAccount<P extends AgentProfile>(from: AgentProfile, to: P): P {
  const a = accountOf(from);
  return a && !accountOf(to) ? { ...to, ownAccount: a } : to;
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

/** The backend's own check (`account.status`, or a pasted token), kept. */
async function checkNative(app: App, userId: string, entry: AccountEntry): Promise<Stored> {
  const backend = entry.id;
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
  next.method = "native";
  next.checkedAt = now();
  save(app, userId, backend, next);
  if (next.state === "logged-in" && before.state !== "logged-in") afterLogin(app, userId, backend);
  return next;
}

/** Ask whether this user is still logged in (检查): the backend's own check, or the plugin's refresh for a plugin login. */
export async function checkAccount(app: App, userId: string, backend: string): Promise<Stored> {
  const entry = requireEntry(app, backend);
  const s = stored(app, userId, backend);
  if (isPlugin(s.method) && s.state !== "none") return refreshPluginLogin(app, userId, backend);
  return checkNative(app, userId, entry);
}

/** Just logged in: what their account offers (models, quota) is read in the background. */
function afterLogin(app: App, userId: string, backend: string) {
  void import("./probe.ts").then((m) => m.probeAccount(app, userId, backend)).catch(() => {});
  for (const p of accountProfiles(app, userId, backend).filter((x) => quotaKind(x)).slice(0, 1)) void refreshQuota(app, p, 0).catch(() => {});
}

// ---------------------------------------------------------------- logging in

type Pending = { stop(): void; url: string; code?: string; startedAt: string; method: string };
const logins = new Map<string, Pending>();
const loginKey = (app: App, userId: string, backend: string) => `${app.home}|${userId}|${backend}`;

/** The link and code also go to the person's Feishu private chat (through the bot), saying it is omem asking. */
async function tell(app: App, userId: string, entry: AccountEntry, how: string, link: { url: string; code?: string }, minutes: number) {
  try {
    const { notify } = await import("../core/notify.ts");
    notify(app, {
      userId,
      title: `omem 正在为你登录 ${entry.name}`,
      body: [
        `这是 omem 为你（${userName(app, userId)}）发起的 ${entry.name} 登录（${how}）。只有你刚在 omem 的 账号 → 我的 AI 账号 里点了“登录”时才打开下面的链接；不是你点的就不要理会，也不要把验证码告诉别人。`,
        `链接：${link.url}`,
        ...(link.code ? [`验证码：${link.code}`] : []),
        `${minutes} 分钟内有效。`,
      ].join("\n\n"),
      link: "#/account",
      urgency: "urgent",
    });
  } catch (e) {
    console.warn(`[omem] 把 ${entry.name} 的登录链接发给 ${userId} 失败：${(e as Error).message}`);
  }
}

/** The ways to log in to one backend: its own (when it has a screenless login), then each plugin's. */
export function loginMethods(app: App, entry: AccountEntry) {
  return [
    ...(entry.account.login ? [{ id: "native", label: `${entry.name} 自己的登录` }] : []),
    ...loginMethodsFor(entry.id).map((m) => ({ id: m.key, label: m.label, plugin: m.plugin })),
  ];
}

/**
 * Start a login for this user: the backend's own (`native`, in their sandbox) or a plugin's method
 * (`<plugin>:<id>`, in omem's process). Returns the link and code to show; `done` when it finished
 * without needing one. The link and code also go to their Feishu private chat.
 */
export function startLogin(app: App, userId: string, backend: string, method = "native"): Promise<{ url?: string; code?: string; done?: boolean }> {
  const entry = requireEntry(app, backend);
  const support = sandboxSupport();
  if (!support.ok) throw new HttpError(400, `这台机器不能按人登录 AI 账号：${support.reason}`);
  if (method !== "native") return startPluginLogin(app, userId, entry, method);
  const spec = entry.account.login;
  if (!spec) throw new HttpError(400, `${entry.name} 没有无界面登录：${entry.account.tokenEnv ? "粘贴令牌" : loginMethodsFor(entry.id).length ? "选一个插件提供的登录方式" : "这个后端暂时不能按人登录"}`);
  const key = loginKey(app, userId, backend);
  const running = logins.get(key);
  if (running?.method === "native") return Promise.resolve({ url: running.url, ...(running.code ? { code: running.code } : {}) });
  if (running) {
    logins.delete(key);
    running.stop();
  }
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
      const pending: Pending = { stop: () => stop(child), ...found, startedAt: now(), method: "native" };
      logins.set(key, pending);
      const overall = setTimeout(() => stop(child), spec.timeoutMs ?? 600_000);
      overall.unref?.();
      child.once("close", () => {
        clearTimeout(overall);
        if (logins.get(key) === pending) logins.delete(key);
        void checkNative(app, userId, entry).catch(() => {});
      });
      void tell(app, userId, entry, `${entry.name} 自己的登录`, found, Math.round((spec.timeoutMs ?? 600_000) / 60_000));
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

/** What a plugin's method gets for one person (docs/v2/agent-accounts.md §6). */
function pluginContext(app: App, userId: string, entry: AccountEntry, m: AgentLoginMethod, signal: AbortSignal): AgentLoginContext {
  const provider = SECRET_PROVIDER(entry.id, m.key);
  return {
    userId,
    home: accountHome(app, userId),
    env: accountEnv(app, userId, entry),
    secret: {
      get: async () => {
        const c = findConnection(app, userId, provider);
        return c ? connectionSecrets(app, c.id)?.accessToken ?? null : null;
      },
      set: async (value) => {
        if (value === null) {
          const c = findConnection(app, userId, provider);
          if (c) deleteConnection(app, c.id);
          return;
        }
        if (typeof value !== "string" || !value || value.length > 65_536) throw new Error("秘密要是 1–65536 个字符的字符串");
        storeConnection(app, { userId, provider, accountId: entry.id, accountName: `${entry.name} · ${m.label}`, scopes: [], accessToken: value });
      },
    },
    settings: m.settings(),
    signal,
  };
}

const errText = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 300);
const validExpiry = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
/** Ten minutes before it runs out, and never sooner than a minute from now. */
const nextRefresh = (expiresAt: number | undefined, at = Date.now()) => (expiresAt === undefined ? undefined : Math.max(expiresAt - REFRESH_BEFORE_MS, at + REFRESH_GAP_MS));

function startPluginLogin(app: App, userId: string, entry: AccountEntry, key: string): Promise<{ url?: string; code?: string; done?: boolean }> {
  const m = loginMethod(key);
  if (!m || m.backend !== entry.id) throw new HttpError(404, `${entry.name} 没有登录方式 ${key}（插件停用或没被信任时它的登录方式不在）`);
  const lk = loginKey(app, userId, entry.id);
  const running = logins.get(lk);
  if (running?.method === key && running.url) return Promise.resolve({ url: running.url, ...(running.code ? { code: running.code } : {}) });
  if (running) {
    logins.delete(lk);
    running.stop();
  }
  ensureAccountHome(app, userId, entry);
  const ctrl = new AbortController();
  const overall = setTimeout(() => ctrl.abort(new Error("登录超时（11 分钟）")), PLUGIN_LOGIN_MS);
  overall.unref?.();
  const pending: Pending = { stop: () => ctrl.abort(new Error("登录已取消")), url: "", startedAt: now(), method: key };
  logins.set(lk, pending);
  return new Promise((resolve, reject) => {
    let answered = false;
    const answer = (fn: () => void) => {
      if (answered) return;
      answered = true;
      clearTimeout(first);
      fn();
    };
    const first = setTimeout(() => answer(() => {
      ctrl.abort(new Error("60 秒内没有给出链接"));
      reject(new HttpError(504, `${m.label} 60 秒内没有给出登录链接`));
    }), 60_000);
    const show = (link: { url: string; code?: string }) => {
      if (ctrl.signal.aborted || logins.get(lk) !== pending) return;
      const url = typeof link?.url === "string" ? link.url.trim() : "";
      if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2000) return console.warn(`[omem] 登录方式 ${key} 给的链接不是 http(s) 地址，没有显示`);
      const code = typeof link.code === "string" && link.code.trim() ? link.code.trim().slice(0, 64) : undefined;
      if (pending.url === url && pending.code === code) return;
      pending.url = url;
      pending.code = code;
      void tell(app, userId, entry, m.label, { url, ...(code ? { code } : {}) }, 11);
      answer(() => resolve({ url, ...(code ? { code } : {}) }));
    };
    Promise.resolve()
      .then(() => m.login({ ...pluginContext(app, userId, entry, m, ctrl.signal), show }))
      .then((r) => {
        if (ctrl.signal.aborted) throw ctrl.signal.reason;
        if (!r || typeof r.user !== "string" || !r.user.trim()) throw new Error("登录方式没有说登录的是哪个账号（user）");
        const expiresAt = validExpiry(r.expiresAt);
        save(app, userId, entry.id, { state: "logged-in", user: r.user.trim().slice(0, 200), method: key, checkedAt: now(), ...(expiresAt ? { expiresAt, refreshAt: nextRefresh(expiresAt) } : {}) });
        afterLogin(app, userId, entry.id);
        answer(() => resolve({ done: true }));
      })
      .catch((e) => {
        const msg = errText(ctrl.signal.aborted ? ctrl.signal.reason ?? e : e);
        const before = stored(app, userId, entry.id);
        save(app, userId, entry.id, { ...before, error: `${m.label}没有完成：${msg}`, checkedAt: now() });
        answer(() => reject(new HttpError(502, `${m.label}没有完成：${msg}`)));
      })
      .finally(() => {
        clearTimeout(overall);
        clearTimeout(first);
        if (logins.get(lk) === pending) logins.delete(lk);
      });
  });
}

const refreshing = new Map<string, Promise<Stored>>();

/**
 * Refresh a plugin login now (its time came, or the person pressed 检查). Null from the plugin, an
 * error, or a login past its `expiresAt` that cannot be refreshed: 登录过期, and the person is told;
 * the folder stays, so logging in again is enough.
 */
export function refreshPluginLogin(app: App, userId: string, backend: string): Promise<Stored> {
  const k = loginKey(app, userId, backend);
  const running = refreshing.get(k);
  if (running) return running;
  const job = (async () => {
    const entry = requireEntry(app, backend);
    const s = stored(app, userId, backend);
    if (!isPlugin(s.method) || s.state === "none") return s;
    const m = loginMethod(s.method!);
    const at = Date.now();
    const pastExpiry = s.expiresAt !== undefined && s.expiresAt <= at;
    const expire = (why: string): Stored => ({ ...s, state: "expired", error: why, checkedAt: now(), refreshAt: undefined });
    let next: Stored;
    if (!m) next = pastExpiry ? expire(`登录过期了，登录方式 ${s.method} 现在不在（插件停用或没被信任）`) : { ...s, error: `登录方式 ${s.method} 现在不在（插件停用或没被信任），到期前续不了`, checkedAt: now() };
    else if (!m.refresh) next = pastExpiry ? expire(`${m.label}的登录到期了，要重新登录`) : { ...s, checkedAt: now(), error: undefined };
    else {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error("续签超时（2 分钟）")), 120_000);
      try {
        const r = await m.refresh(pluginContext(app, userId, entry, m, ctrl.signal));
        if (r === null) next = expire(`${m.label}说续不了，要重新登录`);
        else {
          const expiresAt = validExpiry(r?.expiresAt);
          next = { ...s, state: "logged-in", error: undefined, checkedAt: now(), expiresAt, refreshAt: nextRefresh(expiresAt) };
        }
      } catch (e) {
        next = expire(`续签失败：${errText(ctrl.signal.aborted ? ctrl.signal.reason ?? e : e)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    // A logout or another login meanwhile wins over what this refresh found.
    const now2 = stored(app, userId, backend);
    if (now2.method !== s.method || now2.state === "none") return now2;
    save(app, userId, backend, next);
    if (next.state === "expired" && s.state !== "expired") await tellExpired(app, userId, entry, next.error ?? "");
    return next;
  })().finally(() => refreshing.delete(k));
  refreshing.set(k, job);
  return job;
}

async function tellExpired(app: App, userId: string, entry: AccountEntry, why: string) {
  try {
    const { notify } = await import("../core/notify.ts");
    notify(app, { userId, title: `你在 omem 的 ${entry.name} 登录过期了`, body: `${why}。在 omem 的 账号 → 我的 AI 账号 里重新登录 ${entry.name}；之前的文件都还在。重新登录前，你的运行${accountPolicy(app, entry.id) === "owner" ? "借用 omem 主人的登录" : accountPolicy(app, entry.id) === "own" ? "用不了这个后端" : "换别的后端"}。`, link: "#/account" });
  } catch (e) {
    console.warn(`[omem] 告诉 ${userId} 登录过期失败：${(e as Error).message}`);
  }
}

/**
 * Plugin logins whose refresh is due (10 minutes before `expiresAt`) or that ran out: refreshed or
 * marked expired. Every minute (main.ts); what is due is read from kv, so a restart loses nothing.
 */
export async function tickAgentLogins(app: App, at = Date.now()) {
  let n = 0;
  for (const r of all<{ key: string; value: string }>(app.db, "select key, value from kv where key like 'agent_account:%'")) {
    let s: Stored;
    try {
      s = JSON.parse(r.value) as Stored;
    } catch {
      continue;
    }
    if (!isPlugin(s.method) || s.state !== "logged-in") continue;
    const due = (s.refreshAt !== undefined && s.refreshAt <= at) || (s.expiresAt !== undefined && s.expiresAt <= at);
    if (!due) continue;
    const [, userId, ...rest] = r.key.split(":");
    const backend = rest.join(":");
    if (!accountEntry(app, backend) || !findUser(app, userId)) continue;
    try {
      await refreshPluginLogin(app, userId, backend);
      n++;
    } catch (e) {
      console.warn(`[omem] 续签 ${userId} 的 ${backend} 登录失败：${errText(e)}`);
    }
  }
  return n;
}

/** A pasted token (`account.tokenEnv`): kept in the vault for this user, then checked. */
export async function saveToken(app: App, userId: string, backend: string, token: string) {
  const entry = requireEntry(app, backend);
  if (!entry.account.tokenEnv) throw new HttpError(400, `${entry.name} 不能用令牌登录`);
  const t = token.trim();
  if (t.length < 8 || t.length > 4096 || /\s/.test(t)) throw new HttpError(400, "令牌格式不对");
  ensureAccountHome(app, userId, entry);
  storeConnection(app, { userId, provider: TOKEN_PROVIDER(backend), accountId: backend, accountName: entry.name, scopes: [], accessToken: t });
  return checkNative(app, userId, entry);
}

/**
 * Log this user out of a backend: a plugin login's own `logout`, the backend's logout command (failing
 * is fine), the token and the plugin secrets, the backend's part of the folder — the whole account
 * folder when nothing else is left in it.
 */
export async function removeAccount(app: App, userId: string, backend: string) {
  const entry = requireEntry(app, backend);
  const key = loginKey(app, userId, backend);
  const pending = logins.get(key);
  if (pending) {
    logins.delete(key);
    pending.stop();
  }
  const home = accountHome(app, userId);
  const s = stored(app, userId, backend);
  const m = isPlugin(s.method) ? loginMethod(s.method!) : null;
  if (m?.logout && existsSync(home)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("退出超时")), 20_000);
    try {
      await Promise.race([m.logout(pluginContext(app, userId, entry, m, ctrl.signal)), new Promise((_, no) => ctrl.signal.addEventListener("abort", () => no(ctrl.signal.reason), { once: true }))]);
    } catch (e) {
      console.warn(`[omem] ${m.label}退出时出错（照样删除）：${errText(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (entry.account.logout && existsSync(home) && sandboxSupport().ok) await runShort(app, userId, entry, entry.account.logout.args, 20_000).catch(() => {});
  for (const c of listConnections(app, userId)) if (c.provider === TOKEN_PROVIDER(backend) || c.provider.startsWith(`${TOKEN_PROVIDER(backend)}:`)) deleteConnection(app, c.id);
  run(app.db, "delete from kv where key = ?", KV(userId, backend));
  try {
    forgetQuota(app, userId, backend);
  } catch {}
  for (const rel of entry.account.owns) {
    const p = join(home, normalize(rel));
    if (!p.startsWith(home + sep)) continue;
    rmSync(p, { recursive: true, force: true });
  }
  const others = accountEntries(app).some((e) => e.id !== backend && (stored(app, userId, e.id).state !== "none" || accountToken(app, userId, e.id) || logins.has(loginKey(app, userId, e.id))));
  if (!others) rmSync(accountRoot(app, userId), { recursive: true, force: true });
}

/**
 * A user was disabled: every login of theirs goes — logins in progress stop, each backend's logout
 * runs in their sandbox (best effort), their tokens and plugin secrets and the whole account folder
 * are deleted, and it is written to audit_events. Enabled again, they log in again.
 */
export async function removeAllAccounts(app: App, userId: string, actor: string) {
  if (!SAFE_ID.test(userId) || userId === OWNER) return { backends: [] as string[] };
  const backends: string[] = [];
  for (const e of accountEntries(app)) {
    const has = stored(app, userId, e.id).state !== "none" || logins.has(loginKey(app, userId, e.id)) || listConnections(app, userId).some((c) => c.provider === TOKEN_PROVIDER(e.id) || c.provider.startsWith(`${TOKEN_PROVIDER(e.id)}:`));
    if (!has) continue;
    backends.push(e.id);
    await removeAccount(app, userId, e.id).catch((err) => console.warn(`[omem] 删除 ${userId} 的 ${e.id} 账号时出错：${errText(err)}`));
  }
  // What a backend no longer in the catalog left behind: logins, secrets, states, the folder.
  for (const [k, p] of logins) if (k.startsWith(`${app.home}|${userId}|`)) {
    logins.delete(k);
    p.stop();
  }
  for (const c of listConnections(app, userId)) if (c.provider.startsWith("agent:")) deleteConnection(app, c.id);
  const prefix = `agent_account:${userId}:`;
  run(app.db, "delete from kv where substr(key, 1, ?) = ?", prefix.length, prefix);
  try {
    forgetQuota(app, userId);
  } catch {}
  rmSync(accountRoot(app, userId), { recursive: true, force: true });
  audit(app, actor, "agent-accounts.remove-all", userId, { backends });
  return { backends };
}

// ---------------------------------------------------------------- views

export type AccountBackendView = {
  id: string;
  name: string;
  policy: AccountPolicy;
  login: boolean;
  token: boolean;
  /** The ways to log in: the backend's own (`native`) and the plugins'. */
  methods: { id: string; label: string; plugin?: string }[];
  state: AccountState;
  /** How they logged in, and its label. */
  method?: string;
  methodLabel?: string;
  user?: string;
  checkedAt?: string;
  expiresAt?: string;
  error?: string;
  url?: string;
  code?: string;
  quota?: ReturnType<typeof quotaView>;
};

function viewOf(app: App, userId: string, e: AccountEntry, withQuota = false): AccountBackendView {
  const s = userId === OWNER ? ({ state: "none" } as Stored) : stored(app, userId, e.id);
  const pending = logins.get(loginKey(app, userId, e.id));
  const methods = loginMethods(app, e);
  const gone = s.state === "logged-in" && !existsSync(accountHome(app, userId));
  const ranOut = s.state === "logged-in" && s.expiresAt !== undefined && s.expiresAt <= Date.now();
  const state: AccountState = pending ? "logging-in" : gone ? "none" : ranOut ? "expired" : s.state;
  const label = s.method && s.state !== "none" ? (methods.find((x) => x.id === s.method)?.label ?? (s.method === "native" ? (accountToken(app, userId, e.id) ? "令牌" : `${e.name} 自己的登录`) : s.method)) : undefined;
  let quota: AccountBackendView["quota"];
  if (withQuota && state === "logged-in") {
    const p = accountProfiles(app, userId, e.id).find((x) => quotaKind(x));
    if (p) {
      quota = quotaView(app, p);
      // Kept current while the page is looked at (read again when older than two hours; see 读额度 for now).
      void refreshQuota(app, p, 2 * 3_600_000).catch(() => {});
    }
  }
  return {
    id: e.id,
    name: e.name,
    policy: accountPolicy(app, e.id),
    login: !!e.account.login,
    token: !!e.account.tokenEnv,
    methods,
    state,
    ...(s.method && s.state !== "none" ? { method: s.method, ...(label ? { methodLabel: label } : {}) } : {}),
    ...(s.user ? { user: s.user } : {}),
    ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
    ...(s.expiresAt ? { expiresAt: new Date(s.expiresAt).toISOString() } : {}),
    ...(s.error && state !== "logged-in" ? { error: s.error } : {}),
    ...(pending?.url ? { url: pending.url, ...(pending.code ? { code: pending.code } : {}) } : {}),
    ...(quota ? { quota } : {}),
  };
}

/** One person's backends and states (GET /api/me/agent-accounts), with their own plan quota where it can be read. */
export function myAccounts(app: App, userId: string) {
  const s = sandboxSupport();
  const self = userId !== OWNER && member(app, userId);
  return {
    supported: s.ok,
    ...(s.ok ? {} : { reason: s.reason }),
    owner: !self,
    backends: s.ok ? accountEntries(app).map((e) => viewOf(app, userId, e, self)) : [],
  };
}

/** Read this member's own plan quota of a backend now (读额度 on 我的 AI 账号). */
export async function readMyQuota(app: App, userId: string, backend: string) {
  requireEntry(app, backend);
  if (!loggedIn(app, userId, backend)) throw new HttpError(400, "先登录这个后端");
  const p = accountProfiles(app, userId, backend).find((x) => quotaKind(x));
  if (!p) throw new HttpError(400, "这个后端读不了套餐额度");
  await refreshQuota(app, p, 0);
  return quotaView(app, p);
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
          backends: accountEntries(app)
            .map((e) => viewOf(app, u.id, e))
            .filter((b) => b.state !== "none" || accountToken(app, u.id, b.id)),
        }))
    : [];
  return { supported: s.ok, ...(s.ok ? {} : { reason: s.reason }), bwrap: s.version ?? null, backends: s.ok ? accountEntries(app).map((e) => ({ id: e.id, name: e.name, policy: accountPolicy(app, e.id) })) : [], people };
}

/** Members logged in to a backend whose plan quota can be read, with the profile to read it on (quota.ts startQuotaWatch). */
export function memberQuotaProfiles(app: App): { userId: string; profile: AgentProfile }[] {
  if (!sandboxSupport().ok) return [];
  const out: { userId: string; profile: AgentProfile }[] = [];
  for (const r of all<{ key: string }>(app.db, "select key from kv where key like 'agent_account:%'")) {
    const [, userId, ...rest] = r.key.split(":");
    const backend = rest.join(":");
    if (!member(app, userId) || !loggedIn(app, userId, backend)) continue;
    const p = accountProfiles(app, userId, backend).find((x) => quotaKind(x));
    if (p) out.push({ userId, profile: p });
  }
  return out;
}

/** Tests: forget logins in progress. */
export function stopAccountLogins() {
  for (const p of logins.values()) p.stop();
  logins.clear();
}
