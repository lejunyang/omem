import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import type { CredentialContext } from "../../packages/plugin-sdk/credential.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { activeUser, findUser, OWNER, userName } from "../core/users.ts";
import { HttpError, now, untilAbort, zonedParts } from "../core/util.ts";
import { notify } from "../core/notify.ts";
import { audit } from "../auth/permissions.ts";
import { memberAccessProfile } from "../auth/capabilities.ts";
import { connectionSecrets, deleteConnection, findConnection, listConnections, storeConnection } from "../auth/vault.ts";
import { accountEntry, accountEnv, accountHome, accountStatePaths, clearAccountPaths, ensureAccountHome } from "./accounts.ts";
import { sandboxSupport } from "./sandbox.ts";
import { accountCatalog } from "./catalog.ts";
import { backendLoginReady, credentialReady, credentialWaits } from "./credential-wait.ts";

export { registerCredential } from "./credential-registry.ts";
import { credentialKindsForBackend, credentialMethod, credentialMethods, declaredPaths, defaultSharingScope, requireCredential, type CredentialMethod } from "./credential-registry.ts";
const THREE_DAYS = 3 * 86400_000;
const MINUTE = 60_000;
const REFRESH_PENDING = "正在重试续签";
const REFRESH_REJECTED = "续签凭据已失效，需要重新授权";
/**
 * The service itself said the login no longer works (a command's outcome). A check that only reads
 * what is on disk (the owner's) cannot see that, so it does not undo it unless the login changed.
 */
const COMMAND_EXPIRED = "命令报告登录已失效，需要重新登录";
const loginResult = z.object({ user: z.string().trim().min(1).max(200), expiresAt: z.number().finite().positive().optional() }).strict();
const refreshResult = loginResult.omit({ user: true });
// `expiresAt: null`: no expiry worth showing (the tool renews a short-lived token itself); left out keeps the one known.
const checkResult = refreshResult.extend({ state: z.enum(["ok", "expired", "missing"]), user: z.string().trim().min(1).max(200).optional(),
  expiresAt: z.number().finite().positive().nullable().optional() });
const sharingSchema = z.object({ scope: z.enum(["self", "members", "all"]), members: z.array(z.string()).max(200).default([]) }).strict();
export type CredentialSharing = z.infer<typeof sharingSchema>;
type Provision = { backends: string[]; commands: string[]; paths: string[] };
function declarationProvision(app: App, provides: CredentialMethod["provides"]): Provision {
  return { backends: provides.backends, commands: provides.commands.map(c => c.name),
    paths: [...provides.commands.flatMap(c => c.state ?? []),
      ...accountCatalog(app.config.agents.profiles, "declared").filter(e => provides.backends.includes(e.id)).flatMap(e => e.account.owns)] };
}
function mergeProvision(previous: Provision | undefined, next: Provision): Provision {
  if (!previous) return next;
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return { backends: union(previous.backends, next.backends), commands: union(previous.commands, next.commands), paths: union(previous.paths, next.paths) };
}
export type Hold = {
  state: "none" | "missing" | "logged-in" | "expired"; user?: string; expiresAt?: number; refreshAt?: number;
  checkedAt?: string; checkedDay: string; lastUsedAt?: string; error?: string;
  sharing: CredentialSharing; notified: Record<string, string>; provision?: Provision; suppliedBackends: string[];
};
type Row = { user_id: string; kind: string; state: Hold["state"]; account_name: string | null;
  expires_at: number | null; refresh_at: number | null; checked_at: string | null; check_day: string;
  last_used_at: string | null; error: string | null; sharing: string; notified: string; provision: string | null; supplied_backends: string };
const day = (app: App, at = Date.now()) => zonedParts(at, app.config.timezone).date;
function refreshAt(m: CredentialMethod, expiresAt?: number) {
  if (expiresAt === undefined || !m.refresh) return expiresAt;
  const at = Date.now();
  const lead = Math.min(30 * MINUTE, Math.max(MINUTE, (expiresAt - at) / 2));
  return Math.max(at + MINUTE, Math.floor(expiresAt - lead));
}
export const renewableLogin = (id: string, m: CredentialMethod, hold: Hold) => id !== OWNER && !!m.refresh && hold.state === "logged-in";
export function credentialRefreshPending(id: string, m: CredentialMethod, hold: Hold) {
  return renewableLogin(id, m, hold) &&
    (hold.error?.startsWith(REFRESH_PENDING) === true || (hold.expiresAt ?? Infinity) <= Date.now());
}
function retryRefresh(app: App, id: string, m: CredentialMethod, hold: Hold, reason: string, rejectedAccess = false) {
  const at = Date.now();
  const expiresAt = rejectedAccess ? Math.min(at, hold.expiresAt ?? at) : hold.expiresAt;
  const delay = rejectedAccess ? 0 : (expiresAt ?? Infinity) > at ? 2 * MINUTE : 5 * MINUTE;
  save(app, id, m.kind, { ...hold, expiresAt, refreshAt: at + delay, checkedAt: now(), error: `${REFRESH_PENDING}：${reason}` });
}
function member(app: App, id: string) {
  const user = findUser(app, id);
  return id !== OWNER && activeUser(user) && user.kind === "person";
}
const secretProvider = (kind: string) => `credential:${kind}`;
const keyOf = (app: App, id: string, kind: string) => `${app.home}|${id}|${kind}`;

function fromRow(r: Row): Hold {
  return { state: r.state, user: r.account_name ?? undefined, expiresAt: r.expires_at ?? undefined,
    refreshAt: r.refresh_at ?? undefined, checkedAt: r.checked_at ?? undefined, checkedDay: r.check_day,
    lastUsedAt: r.last_used_at ?? undefined, error: r.error ?? undefined, sharing: JSON.parse(r.sharing), notified: JSON.parse(r.notified),
    provision: r.provision === null ? undefined : JSON.parse(r.provision), suppliedBackends: JSON.parse(r.supplied_backends) };
}
function emptyHold(id: string): Hold {
  return { state: "none", suppliedBackends: [], checkedDay: "", sharing: { scope: defaultSharingScope(id), members: [] }, notified: {} };
}
export function credentialHold(app: App, userId: string, kind: string): Hold {
  const r = one<Row>(app.db, "select * from credential_holds where user_id=? and kind=?", userId, kind);
  return r ? fromRow(r) : emptyHold(userId);
}
function save(app: App, userId: string, kind: string, hold: Hold) {
  run(app.db, `insert into credential_holds(user_id,kind,state,account_name,expires_at,refresh_at,check_day,checked_at,sharing,notified,last_used_at,error,provision,supplied_backends)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(user_id,kind) do update set state=excluded.state,account_name=excluded.account_name,
    expires_at=excluded.expires_at,refresh_at=excluded.refresh_at,check_day=excluded.check_day,checked_at=excluded.checked_at,
    sharing=excluded.sharing,notified=excluded.notified,last_used_at=excluded.last_used_at,error=excluded.error,provision=excluded.provision,supplied_backends=excluded.supplied_backends`,
    userId, kind, hold.state, hold.user ?? null, hold.expiresAt ?? null, hold.refreshAt ?? null, hold.checkedDay,
    hold.checkedAt ?? null, JSON.stringify(hold.sharing), JSON.stringify(hold.notified), hold.lastUsedAt ?? null, hold.error ?? null,
    hold.provision ? JSON.stringify(hold.provision) : null, JSON.stringify(hold.suppliedBackends));
}
export function usableCredential(app: App, id: string, kind: string, s: Pick<Hold, "state" | "expiresAt"> = credentialHold(app, id, kind)) {
  return s.state === "logged-in" && (s.expiresAt === undefined || s.expiresAt > Date.now()) && (id === OWNER || existsSync(accountHome(app, id)));
}
/**
 * The owner's hold is this machine's own login, which runs were borrowing before credentials existed:
 * only a check that says so (`missing` / `expired`) makes it unusable. Never checked, or a check that
 * failed (`none`, the error kept on the hold), leaves it as it was.
 */
export function availableLogin(app: App, id: string, kind: string, hold = credentialHold(app, id, kind)) {
  return (id === OWNER && hold.state === "none") || usableCredential(app, id, kind, hold);
}
function backendUsable(app: App, id: string, backend: string, kind: string, hold = credentialHold(app, id, kind)) {
  const backends = id === OWNER ? credentialMethod(kind)?.provides.backends : hold.suppliedBackends;
  return !!backends?.includes(backend) && availableLogin(app, id, kind, hold);
}
export const credentialBackendLogin = (app: App, id: string, backend: string) => credentialKindsForBackend(backend).some(m => backendUsable(app, id, backend, m.kind));
export type CredentialUse = { holder: string; kind: string; requester: string; backend: string };
export const credentialUse = Symbol("credentialUse");
export function selectedCredential(profile: object) {
  return (profile as { [credentialUse]?: CredentialUse })[credentialUse];
}
export function mayUseCredential(app: App, use: CredentialUse, hold = credentialHold(app, use.holder, use.kind)) {
  if (!credentialMethod(use.kind)?.provides.backends.includes(use.backend) || !backendUsable(app, use.holder, use.backend, use.kind, hold)) return false;
  if (use.holder === use.requester) return true;
  return app.config.credentials.lending === "auto" && (use.holder === OWNER || member(app, use.holder)) &&
    (hold.sharing.scope === "all" || hold.sharing.scope === "members" && hold.sharing.members.includes(use.requester));
}
export function selectCredential(app: App, requester: string, backend: string, allowLoan: boolean, sandbox: boolean, ownerOnly = false) {
  const methods = credentialKindsForBackend(backend);
  const own = methods.find(m => sandbox && backendUsable(app, requester, backend, m.kind));
  if (own && !ownerOnly) return { requester, backend, holder: requester, kind: own.kind };
  if (!allowLoan || !methods.length || app.config.credentials.lending !== "auto") return;
  const kinds = methods.map(m => m.kind);
  const rows = all<Row>(app.db, `select * from credential_holds where kind in (${kinds.map(() => "?").join(",")})
    and (state='logged-in' or user_id=?) order by (user_id=?) desc,last_used_at desc,user_id,kind`, ...kinds, OWNER, OWNER);
  for (const row of rows) {
    const holder = row.user_id;
    if (holder === requester || (holder === OWNER ? app.config.agents.accountIsolation === "require" : ownerOnly || !sandbox)) continue;
    const use = { requester, backend, holder, kind: row.kind };
    if (mayUseCredential(app, use, fromRow(row))) return use;
  }
}
export function credentialSucceeded(app: App, profile: object) {
  const use = selectedCredential(profile);
  if (!use) return;
  try {
    run(app.db, "update credential_holds set last_used_at=? where user_id=? and kind=?", now(), use.holder, use.kind);
  } catch {
    // Recency only ranks future loans. Retrying this completed turn could repeat tool actions.
    console.warn("[omem] 更新凭据最近使用时间失败，已保留本轮结果");
  }
}
export function credentialAccountView(app: App, id: string, backend: string) {
  for (const m of credentialKindsForBackend(backend)) {
    const hold = credentialHold(app, id, m.kind);
    if (backendUsable(app, id, backend, m.kind, hold)) return { ...hold, kind: m.kind, name: m.name };
  }
  return null;
}
export function credentialMemberEnv(app: App, id: string, m: CredentialMethod): Record<string, string> {
  return Object.assign({}, ...m.provides.backends.map(b => {
    const e = accountEntry(app, b); return e ? accountEnv(app, id, e) : {};
  }));
}
function context(app: App, id: string, m: CredentialMethod, signal: AbortSignal, mode: "supply" | "check" | "logout"): CredentialContext {
  const home = id === OWNER ? homedir() : accountHome(app, id);
  if (id !== OWNER) {
    const provision = declarationProvision(app, m.provides);
    if (mode === "supply") {
      signal.throwIfAborted();
      const hold = credentialHold(app, id, m.kind);
      const merged = mergeProvision(hold.provision, provision);
      accountStatePaths(app, id, merged.paths);
      save(app, id, m.kind, { ...hold, state: hold.state === "none" ? "missing" : hold.state, provision: merged });
    } else accountStatePaths(app, id, provision.paths);
  }
  const env = id === OWNER ? process.env : credentialMemberEnv(app, id, m);
  return { userId: id, home, env: { ...env, HOME: home }, signal, settings: m.settings(), secret: {
    async get() { signal.throwIfAborted(); const c = findConnection(app, id, secretProvider(m.kind)); return c ? connectionSecrets(app, c.id)?.accessToken ?? null : null; },
    async set(value) {
      signal.throwIfAborted();
      if (mode === "check" || id === OWNER) throw new Error("检查凭据时不能写入秘密");
      const provider = secretProvider(m.kind);
      if (value === null) { const c = findConnection(app, id, provider); if (c) deleteConnection(app, c.id); return; }
      if (!value || value.length > 65_536) throw new Error("秘密需要 1–65536 个字符");
      storeConnection(app, { userId: id, provider, accountId: m.kind, accountName: m.name, scopes: [], accessToken: value });
    },
  } };
}

// All lifecycle operations for one hold serialize, including cancellation before logout.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const job = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, job);
  void job.finally(() => { if (queues.get(key) === job) queues.delete(key); }).catch(() => {});
  return job;
}
async function timed<T>(m: CredentialMethod, ms: number, work: (signal: AbortSignal) => Promise<T>) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("凭据操作超时", "TimeoutError")), ms);
  const signal = AbortSignal.any([m.signal, ctrl.signal]);
  try { return await untilAbort(signal, () => work(signal)); }
  finally { clearTimeout(timer); ctrl.abort(); }
}
/**
 * Who a precheck asks about, beyond the omem id (which a resource service does not know): the account
 * this person last logged in with for this credential (from the plugin's verified login or check) and
 * the email omem has for them (their sign-in, or as the owner added them). Either is left out when
 * unknown; the plugin maps them to the principal its service checks.
 */
function precheckSubject(app: App, user: string, kind: string) {
  const account = credentialHold(app, user, kind).user;
  const email = findUser(app, user)?.email ?? undefined;
  return { ...(account ? { account } : {}), ...(email ? { email } : {}) };
}
export function precheckCredential(app: App, holder: string, m: CredentialMethod, resource: string, user: string, command?: { name: string; args: readonly string[] }) {
  const check = m.precheck!;
  const subject = precheckSubject(app, user, m.kind);
  return timed(m, 20_000, signal => check(context(app, holder, m, signal, "check"), { resource, user, ...subject, ...(command ? { command } : {}) }));
}

/** Whether omem can start this person's login (a member's in their account sandbox, the owner's through the plugin's ownerLogin). */
export const canStartLogin = (app: App, id: string, m: CredentialMethod) => id === OWNER ? !!m.ownerLogin : member(app, id) && sandboxSupport().ok;
/** The account page, starting this credential's login as it opens. */
export const loginLink = (kind: string) => `#/account?login=${encodeURIComponent(kind)}`;
function reminder(app: App, id: string, m: CredentialMethod, state: "expired" | "expiring" | "failed") {
  const hold = credentialHold(app, id, m.kind), today = day(app);
  // A login is under way: its own card says how it ends.
  if (hold.notified[state] === today || state === "expired" && hold.error === REFRESH_REJECTED && hold.notified.expired || logins.has(keyOf(app, id, m.kind))) return;
  const startable = canStartLogin(app, id, m);
  notify(app, { userId: id, title: `${m.name} ${state === "expired" ? "登录过期了" : state === "failed" ? "授权或检查失败" : "三天内到期"}`,
    body: startable ? `打开这条通知会开始重新登录 ${m.name}，在官方页面确认即可。${id === OWNER ? "" : "此前的账号文件会保留。"}`
      : id === OWNER ? "用的是这台机器上已有的登录，请在本机重新授权。" : `请重新授权 ${m.name}。此前的账号文件会保留。`,
    link: startable ? loginLink(m.kind) : "#/account" });
  save(app, id, m.kind, { ...hold, notified: { ...hold.notified, [state]: today } });
}
/** `remind` false: the caller asks them itself (inviteCredential), with the login link. */
export function expireCommandCredential(app: App, id: string, m: CredentialMethod, remind = true) {
  const key = keyOf(app, id, m.kind), reported = Date.now();
  return serial(key, async () => {
    const hold = credentialHold(app, id, m.kind);
    // A login that finished after the command failed replaced the login it failed with.
    if (!canCheck(id, hold.state) || hold.error === REFRESH_REJECTED || m.signal.aborted || (loggedInAt.get(key) ?? 0) >= reported) return;
    if (renewableLogin(id, m, hold)) {
      if (!credentialRefreshPending(id, m, hold) || (hold.expiresAt ?? Infinity) > Date.now())
        retryRefresh(app, id, m, hold, "命令报告访问令牌不可用", true);
      return;
    }
    save(app, id, m.kind, { ...hold, state: "expired", refreshAt: undefined, error: COMMAND_EXPIRED });
    if (remind) reminder(app, id, m, "expired");
  });
}
/**
 * A member's own login gave nothing for a read-only command (credential-execution.ts, owner fallback):
 * ask them once a day to authorize — omem starts the login and sends them its link — or, when the
 * service said no permission, send the application link. Never waits for them.
 */
export function inviteCredential(app: App, id: string, m: CredentialMethod, reason: "none" | "unauthenticated" | "expired" | "denied",
  detail: { command: string; applyUrl: string | null; covered: boolean }) {
  if (!member(app, id) || m.signal.aborted || (reason === "denied" && !detail.applyUrl)) return;
  const hold = credentialHold(app, id, m.kind), today = day(app);
  const key = reason === "denied" ? `denied:${detail.applyUrl!.slice(0, 300)}` : "invite";
  if (hold.notified[key] === today) return;
  const kept = Object.entries(hold.notified).filter(([k, v]) => !(k === "invite" || k.startsWith("denied:")) || v === today);
  save(app, id, m.kind, { ...hold, notified: { ...Object.fromEntries(kept), [key]: today } });
  const covered = detail.covered ? `这次先用${userName(app, OWNER)}的登录查了；` : "";
  if (reason === "denied") {
    notify(app, { userId: id, title: `${m.name}：你没有这个资源的权限`,
      body: `运行 ${detail.command} 时资源服务说你没有权限。${covered}需要以后用你自己的账号查，可前往 ${detail.applyUrl} 申请。`, link: "#/account" });
    return;
  }
  const state = reason === "none" ? `你还没有在 omem 里授权${m.name}` : `你的${m.name}登录${reason === "expired" ? "过期了" : "失效了"}`;
  const why = `运行 ${detail.command} 要用${m.name}，${state}。${covered}授权后 omem 就用你自己的账号查。`;
  try {
    startCredentialLogin(app, id, m.kind, why).catch(() => { /* Failure is reported to them by the login itself. */ });
  } catch {
    notify(app, { userId: id, title: `请授权 ${m.name}`, body: why, link: "#/account" });
  }
}
function remindHold(app: App, id: string, m: CredentialMethod) {
  const s = credentialHold(app, id, m.kind);
  if (renewableLogin(id, m, s)) return;
  if (s.state === "expired" || s.expiresAt !== undefined && s.expiresAt <= Date.now()) reminder(app, id, m, "expired");
  else if (s.state === "logged-in" && s.expiresAt !== undefined && s.expiresAt - Date.now() <= THREE_DAYS) reminder(app, id, m, "expiring");
}
type LoginReply = { url?: string; code?: string; done?: boolean };
type Pending = { method: CredentialMethod; abort: AbortController; reply: Promise<LoginReply>; url?: string; code?: string; notice?: string };
const logins = new Map<string, Pending>();
/** When each hold last received a login through omem (expireCommandCredential). */
const loggedInAt = new Map<string, number>();
/** `why`: said before the link when omem starts the login on its own (inviteCredential). */
export function startCredentialLogin(app: App, id: string, kind: string, why?: string, notifyPrivate = true): Promise<LoginReply> {
  const m = requireCredential(kind);
  const owner = id === OWNER;
  if (owner && !m.ownerLogin) throw new HttpError(400, "用的是这台机器上已有的登录，请在本机授权");
  if (!owner && !member(app, id)) throw new HttpError(400, "只有已启用的成员可以登录凭据");
  const support = sandboxSupport();
  if (!owner && !support.ok) throw new HttpError(400, "成员凭据需要账号沙箱：" + support.reason);
  const key = keyOf(app, id, kind), pending = logins.get(key);
  if (pending) return pending.reply;
  if (!owner) ensureAccountHome(app, id);
  const abort = new AbortController();
  let resolve!: (v: LoginReply) => void, reject!: (e: unknown) => void;
  const p: Pending = { method: m, abort, reply: new Promise((yes, no) => { resolve = yes; reject = no; }) };
  logins.set(key, p);
  let replied = false;
  const answer = (fn: () => void) => { if (!replied) { replied = true; clearTimeout(first); fn(); } };
  const first = setTimeout(() => abort.abort(new Error("60 秒内没有给出登录链接")), 60_000);
  const timeout = AbortSignal.timeout(660_000);
  const signal = AbortSignal.any([abort.signal, m.signal, timeout]);
  void serial(key, async () => {
    try {
      const ctx = context(app, id, m, signal, owner ? "check" : "supply");
      const show = (link: { url: string; code?: string }) => {
        signal.throwIfAborted();
        const l = z.object({ url: z.httpUrl().max(2000), code: z.string().max(64).optional() }).parse(link);
        p.url = l.url; p.code = l.code;
        // The card opens the official page itself: no stop at the account page on the way.
        if (notifyPrivate) p.notice = notify(app, { userId: id, title: `omem 正在为你登录 ${m.name}`, tone: "warning",
          body: `${why ? why + "\n" : ""}打开链接${l.code ? `，验证码 ${l.code}` : ""}，在官方页面确认。11 分钟内完成授权${credentialWaits(app, id, kind).length ? "，完成后助手会接着做刚才的事" : ""}。`, link: l.url, urgency: "urgent" }).id;
        answer(() => resolve(l));
      };
      const result = loginResult.parse(await untilAbort(signal, () => owner ? m.ownerLogin!(ctx, show) : m.login(ctx, show)));
      if (!owner && m.provide) await untilAbort(signal, () => m.provide!(ctx));
      signal.throwIfAborted();
      save(app, id, kind, { ...credentialHold(app, id, kind), ...result, suppliedBackends: m.provides.backends, expiresAt: result.expiresAt, state: "logged-in",
        refreshAt: owner ? undefined : refreshAt(m, result.expiresAt), checkedAt: now(), checkedDay: day(app), error: undefined, notified: {} });
      loggedInAt.set(key, Date.now());
      settleLoginCard(app, id, m, p, "done");
      remindHold(app, id, m);
      credentialReady(app, id, kind, m.name);
      for (const backend of m.provides.backends) backendLoginReady(app, id, backend);
      answer(() => resolve({ done: true }));
    } catch (e) {
      const reason = e instanceof Error ? e.message.replace(/\s+/g, " ").slice(0, 200) : "";
      if (!signal.aborted) console.warn(`[omem] ${m.name} 登录没有完成（${id}）：${reason}`);
      if (!signal.aborted || timeout.aborted || !replied) {
        const hold = credentialHold(app, id, kind);
        // The owner's login on this machine is what it was: only the attempt failed.
        save(app, id, kind, { ...hold, ...(owner ? {} : { state: "expired" as const }), error: "授权或供给失败，请重新登录", checkedAt: now() });
        if (p.notice) settleLoginCard(app, id, m, p, timeout.aborted || abort.signal.aborted ? "expired" : "failed", signal.aborted ? "" : reason);
        else if (notifyPrivate && (!owner || hold.state !== "logged-in")) reminder(app, id, m, "failed");
      } else if (p.notice) settleLoginCard(app, id, m, p, "cancelled");
      answer(() => reject(new HttpError(502, signal.aborted ? "登录取消或超时，请重试" : "授权或供给失败，请重新登录")));
    } finally { clearTimeout(first); abort.abort(); if (logins.get(key) === p) logins.delete(key); }
  });
  return p.reply;
}
/**
 * The login card says how this login ended, on the same card (green when done; otherwise its link is
 * gone and opening it starts a new login), so an expired link is not left to be tried in Feishu or in
 * the web list.
 */
function settleLoginCard(app: App, id: string, m: CredentialMethod, p: Pending, end: "done" | "expired" | "failed" | "cancelled", reason = "") {
  const asked = p.notice;
  if (!asked) return;
  p.notice = undefined;
  const again = canStartLogin(app, id, m);
  const why = end === "expired" ? "授权链接已过期" : end === "failed" ? `授权没有完成${reason ? `（${reason}）` : ""}` : "这次登录已取消";
  try {
    notify(app, end === "done"
      ? { userId: id, replaces: asked, tone: "done", title: `${m.name} 已登录`, body: "授权完成，之后用到它时直接用这次的登录。", link: null }
      : { userId: id, replaces: asked, tone: "warning", title: `${m.name} 没有登录成功`, body: `${why}，原来的链接不能再用。${again ? "打开这条通知会重新发起登录。" : "请重新授权。"}`, link: again ? loginLink(m.kind) : "#/account" });
    run(app.db, "update notifications set link = null where id = ?", asked);
    if (end !== "done") {
      const hold = credentialHold(app, id, m.kind);
      // It already asks them to log in again: today's 过期 / 失败 reminders are this card.
      save(app, id, m.kind, { ...hold, notified: { ...hold.notified, failed: day(app), expired: day(app) } });
    }
  } catch (e) { console.warn(`[omem] 更新 ${m.name} 的登录卡片失败：${(e as Error).message}`); }
}

export function refreshCredential(app: App, id: string, kind: string) {
  const m = requireCredential(kind);
  if (id === OWNER) return checkCredential(app, id, kind);
  return serial(keyOf(app, id, kind), async () => {
    const s = credentialHold(app, id, kind);
    if (s.state !== "logged-in") return s;
    let phase = "刷新访问令牌";
    let recovered = false;
    try {
      if (m.refresh) {
        const result = await timed(m, 120_000, async signal => {
          const ctx = context(app, id, m, signal, "supply");
          const r = await untilAbort(signal, () => m.refresh!(ctx));
          if (r === null) return null;
          const result = refreshResult.parse(r);
          phase = "向工具供给新令牌";
          if (m.provide) await untilAbort(signal, () => m.provide!(ctx));
          return result;
        });
        const hold = credentialHold(app, id, kind);
        if (result === null) {
          const notified = { ...hold.notified };
          delete notified.expired;
          save(app, id, kind, { ...hold, notified, state: "expired", refreshAt: undefined, error: REFRESH_REJECTED, checkedAt: now() });
        } else {
          save(app, id, kind, { ...hold, ...result, suppliedBackends: m.provides.backends, expiresAt: result.expiresAt, refreshAt: refreshAt(m, result.expiresAt), checkedAt: now(), error: undefined });
          loggedInAt.set(keyOf(app, id, kind), Date.now());
          recovered = credentialRefreshPending(id, m, hold);
        }
      } else if (s.expiresAt !== undefined && s.expiresAt <= Date.now()) save(app, id, kind, { ...credentialHold(app, id, kind), state: "expired", refreshAt: undefined });
      else save(app, id, kind, { ...credentialHold(app, id, kind), refreshAt: s.expiresAt });
    } catch (error) {
      if (!m.signal.aborted) {
        const detail = error instanceof z.ZodError ? "返回格式无效" : error instanceof Error && error.name === "TimeoutError" ? "超时" : "失败";
        retryRefresh(app, id, m, credentialHold(app, id, kind), phase + detail);
        audit(app, id, "credentials.refresh.retry", kind, { phase, reason: detail });
      }
    }
    if (recovered) {
      credentialReady(app, id, kind, m.name);
      for (const backend of m.provides.backends) backendLoginReady(app, id, backend);
    }
    remindHold(app, id, m);
    return credentialHold(app, id, kind);
  });
}
function canCheck(id: string, state: Hold["state"]) {
  return id === OWNER || state !== "none";
}
export function checkCredential(app: App, id: string, kind: string) {
  const m = requireCredential(kind);
  return serial(keyOf(app, id, kind), async () => {
    const s = credentialHold(app, id, kind);
    if (!m.check || !canCheck(id, s.state)) return s;
    if (renewableLogin(id, m, s) && s.error?.startsWith(REFRESH_PENDING)) {
      run(app.db, "update credential_holds set check_day=? where user_id=? and kind=?", day(app), id, kind);
      return { ...s, checkedDay: day(app) };
    }
    try {
      const result = checkResult.parse(await timed(m, 120_000, signal => m.check!(context(app, id, m, signal, "check"))));
      const expiresAt = result.state === "missing" || result.expiresAt === null ? undefined : result.expiresAt ?? s.expiresAt;
      let state: Hold["state"] = result.state === "missing" ? "missing" : result.state === "expired" || expiresAt !== undefined && expiresAt <= Date.now() ? "expired" : "logged-in";
      if (state !== "logged-in" && renewableLogin(id, m, s)) {
        retryRefresh(app, id, m, { ...s, checkedDay: day(app) }, "检查发现访问令牌不可用", true);
        return credentialHold(app, id, kind);
      }
      // The same login on disk the service already turned down: still expired until a new login.
      const unchanged = s.state === "expired" && (s.error === REFRESH_REJECTED ||
        s.error === COMMAND_EXPIRED && expiresAt === s.expiresAt && (result.user ?? s.user) === s.user);
      if (unchanged) state = "expired";
      save(app, id, kind, { ...credentialHold(app, id, kind), state,
        suppliedBackends: id === OWNER ? m.provides.backends : s.suppliedBackends,
        user: result.state === "missing" && !unchanged ? undefined : result.user ?? s.user, expiresAt,
        refreshAt: id === OWNER || state !== "logged-in" ? undefined : (expiresAt === s.expiresAt ? s.refreshAt : undefined) ?? refreshAt(m, expiresAt), checkedAt: now(), checkedDay: day(app),
        error: unchanged ? s.error : undefined });
      if (state === "logged-in" && s.state !== "logged-in") {
        credentialReady(app, id, kind, m.name);
        for (const backend of s.suppliedBackends) backendLoginReady(app, id, backend);
      }
    } catch {
      save(app, id, kind, { ...credentialHold(app, id, kind), checkedAt: now(), checkedDay: day(app), error: s.error === REFRESH_REJECTED ? s.error : "检查失败，请稍后重试" });
      if (!renewableLogin(id, m, s) && s.error !== REFRESH_REJECTED) reminder(app, id, m, "failed");
    }
    remindHold(app, id, m);
    return credentialHold(app, id, kind);
  });
}
/** The files a callback may have written, even if the plugin has since changed or stopped. */
export function heldCredentialDeclarations(app: App, id: string) {
  const rows = all<Row & { name: string }>(app.db, `select h.*,json_extract(k.declaration,'$.name') as name from credential_holds h
    join credential_kinds k on k.kind=h.kind where h.user_id=? and h.provision is not null
    order by (h.state='missing'), h.checked_at desc,h.kind`, id);
  const held = new Map<string, { name: string; provision: Provision; hold: Hold; pending?: boolean }>();
  for (const row of rows) {
    const hold = fromRow(row);
    held.set(row.kind, { name: row.name, provision: hold.provision!, hold });
  }
  for (const [key, { method: m }] of logins) {
    if (key !== keyOf(app, id, m.kind)) continue;
    const previous = held.get(m.kind);
    held.set(m.kind, { name: m.name, pending: true, hold: previous?.hold ?? emptyHold(id),
      provision: mergeProvision(previous?.provision, declarationProvision(app, m.provides)) });
  }
  return held;
}

export function retainedCredentialPaths(app: App, id: string, except?: string) {
  const held = heldCredentialDeclarations(app, id);
  if (except) held.delete(except);
  return [...held.values()].map(m => m.provision.paths);
}

export function suppliedCredentialKind(app: App, id: string, backend: string, hasIndependentLogin: boolean) {
  const held = heldCredentialDeclarations(app, id);
  const sources = [...held].filter(([, h]) => h.provision.backends.includes(backend));
  return sources.find(([kind, h]) => credentialMethod(kind)?.provides.backends.includes(backend) && backendUsable(app, id, backend, kind, h.hold))?.[0]
    ?? sources.find(([, h]) => h.pending)?.[0]
    ?? sources.find(([, h]) => !hasIndependentLogin || h.hold.state !== "missing")?.[0]
    // Checking a newly advertised backend must not turn a shared file into a native login.
    ?? (!hasIndependentLogin ? credentialKindsForBackend(backend).find(m => held.has(m.kind))?.kind : undefined);
}
export function logoutCredential(app: App, id: string, kind: string, actor = id) {
  if (id === OWNER) throw new HttpError(400, "用的是这台机器上已有的登录，请在本机退出");
  const key = keyOf(app, id, kind);
  logins.get(key)?.abort.abort();
  return serial(key, async () => {
    const row = one(app.db, "select 1 from credential_kinds where kind=?", kind);
    if (!row) throw new HttpError(404, "没有这个凭据种类");
    const hold = credentialHold(app, id, kind);
    if (hold.state === "none") return;
    const m = credentialMethod(kind);
    if (m?.logout && existsSync(accountHome(app, id))) {
      try { await timed(m, 20_000, signal => m.logout!(context(app, id, m, signal, "logout"))); }
      catch { throw new HttpError(502, "退出凭据失败，请重试"); }
    }
    clearAccountPaths(app, id, hold.provision?.paths ?? [], { kind });
    const c = findConnection(app, id, secretProvider(kind)); if (c) deleteConnection(app, c.id);
    save(app, id, kind, { ...credentialHold(app, id, kind), state: "none", provision: undefined, suppliedBackends: [], user: undefined, expiresAt: undefined, refreshAt: undefined, checkedAt: now(), error: undefined });
    audit(app, actor, "credentials.logout", kind, { holder: id });
  });
}
export async function removeAllCredentials(app: App, id: string) {
  for (const kind of heldCredentialDeclarations(app, id).keys()) await logoutCredential(app, id, kind).catch(() => {});
  for (const c of listConnections(app, id)) if (c.provider.startsWith("credential:")) deleteConnection(app, c.id);
  run(app.db, "delete from credential_holds where user_id=?", id);
}
export function setCredentialSharing(app: App, id: string, kind: string, body: unknown) {
  requireCredential(kind);
  const parsed = sharingSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "出借设置无效");
  const sharing = parsed.data;
  sharing.members = sharing.scope === "members" ? [...new Set(sharing.members)] : [];
  if (sharing.members.some(id => !member(app, id))) throw new HttpError(400, "出借对象必须是已启用的成员");
  save(app, id, kind, { ...credentialHold(app, id, kind), sharing });
  audit(app, id, "credentials.sharing", kind, { scope: sharing.scope, members: sharing.members });
  return { kind, sharing };
}
export async function tickCredentialRefreshes(app: App, at = Date.now()) {
  const kinds = credentialMethods().map(m => m.kind);
  if (!kinds.length) return 0;
  const rows = all<Row>(app.db, `select h.* from credential_holds h indexed by credential_refresh_due
    join users u on u.id=h.user_id where h.state='logged-in' and h.refresh_at<=? and h.user_id!=?
    and h.kind in (${kinds.map(() => "?").join(",")}) and u.disabled_at is null and u.status='active'
    order by h.refresh_at limit 32`, at, OWNER, ...kinds);
  for (const r of rows) await refreshCredential(app, r.user_id, r.kind);
  return rows.length;
}
export async function tickCredentialChecks(app: App, at = Date.now()) {
  const rows = all<Row>(app.db, "select * from credential_holds indexed by credential_check_due where check_day<? order by check_day limit 32", day(app, at));
  let count = 0;
  for (const r of rows) {
    const m = credentialMethod(r.kind);
    const eligible = canCheck(r.user_id, r.state) && (r.user_id === OWNER || member(app, r.user_id));
    if (!m?.check || !eligible) {
      if (m && eligible && r.user_id !== OWNER) remindHold(app, r.user_id, m);
      run(app.db, "update credential_holds set check_day=? where user_id=? and kind=?", day(app, at), r.user_id, r.kind);
      continue;
    }
    await checkCredential(app, r.user_id, r.kind); count++;
  }
  return count;
}
const installed = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory();
export function credentialInstallDirs(app: App) {
  return [...new Set(credentialMethods().flatMap(m => declaredPaths(app, m).install.map(d => d.path)).filter(installed))];
}
export function credentialStatePaths(app: App) { return [...new Set(credentialMethods().flatMap(m => declaredPaths(app, m).state))]; }
export function credentialStateRels(app: App) {
  credentialStatePaths(app);
  return [...new Set(credentialMethods().flatMap(m => m.provides.commands.flatMap(c => c.state ?? [])))];
}
export function maybeSendCredentialOnboarding(app: App, id: string) {
  if (!member(app, id)) return false;
  const missing = credentialMethods().filter(m => !usableCredential(app, id, m.kind));
  if (!missing.length || !run(app.db, "insert into credential_onboarding(user_id,notified_at) values(?,?) on conflict(user_id) do nothing", id, now()).changes) return false;
  notify(app, { userId: id, title: "接入清单", body: missing.map(m => `${m.name}（${m.required ? "必做" : "可选"}）${m.describe ? "：" + m.describe : ""}；覆盖 ${[...m.provides.backends, ...m.provides.commands.map(c => c.name)].join("、")}`).join("\n"), link: "#/account" });
  return true;
}
export type CredentialState = "unknown" | "none" | "ok" | "expiring" | "expired" | "logging-in";
function viewOf(app: App, id: string, m: CredentialMethod, s: Hold) {
  const p = logins.get(keyOf(app, id, m.kind));
  const renewable = renewableLogin(id, m, s);
  const state: CredentialState = p ? "logging-in" : s.state === "expired" || !renewable && (s.expiresAt ?? Infinity) <= Date.now() ? "expired"
    : id === OWNER && s.state === "none" ? "unknown"
    : !usableCredential(app, id, m.kind, s) ? "none" : !renewable && (s.expiresAt ?? Infinity) - Date.now() <= THREE_DAYS ? "expiring" : "ok";
  const missing = declaredPaths(app, m).install.filter(d => !installed(d.path));
  // As canStartLogin, without reading the person again for every row (the caller is an active person).
  const login = id === OWNER ? !!m.ownerLogin : sandboxSupport().ok;
  return { kind: m.kind, plugin: m.plugin, name: m.name, describe: m.describe ?? "", required: !!m.required, state,
    user: s.user, expiresAt: renewable ? undefined : s.expiresAt, checkedAt: s.checkedAt, error: s.error, sharing: s.sharing,
    backends: m.provides.backends, commands: m.provides.commands.map(c => c.name), supplied: s.provision !== undefined, login,
    machine: id === OWNER, url: p?.url, code: p?.code,
    reason: id === OWNER ? (login ? undefined : "用的是这台机器上已有的登录") : !login ? "成员账号沙箱不可用" : undefined,
    missingInstall: missing.map(d => d.declared).filter(p => p.startsWith("~/")), missingInstallCount: missing.length };
}
export function myCredentials(app: App, id: string) {
  const rows = all<Row>(app.db, "select * from credential_holds where user_id=?", id);
  const holds = new Map(rows.map(r => [r.kind, fromRow(r)]));
  const { memberCredentials } = memberAccessProfile(app, id);
  const candidates = memberCredentials ? all<{ id: string; name: string }>(app.db, `select id,name from users
    where status='active' and disabled_at is null and kind='person' and id not in (?,?)
    order by id limit 200`, OWNER, id) : [];
  return { ...(memberCredentials && { lending: app.config.credentials.lending }), candidates,
    credentials: credentialMethods().map(m => viewOf(app, id, m, holds.get(m.kind) ?? emptyHold(id))) };
}
export function allCredentials(app: App) {
  const rows = all<Row & { holder_name: string | null }>(app.db, `select h.*, u.name as holder_name from credential_holds h
    left join users u on u.id=h.user_id order by h.user_id,h.kind limit 2000`);
  const people = new Map<string, { userId: string; name: string; credentials: Omit<ReturnType<typeof viewOf>, "url" | "code">[] }>();
  for (const r of rows) {
    const m = credentialMethod(r.kind); if (!m) continue;
    let person = people.get(r.user_id);
    if (!person) { person = { userId: r.user_id, name: r.user_id === OWNER ? "本人" : r.holder_name ?? r.user_id, credentials: [] }; people.set(r.user_id, person); }
    const { url, code, ...v } = viewOf(app, r.user_id, m, fromRow(r));
    person.credentials.push(v);
  }
  return { kinds: credentialMethods().map(m => ({ kind: m.kind, name: m.name })), people: [...people.values()], limit: 2000 };
}
export function stopCredentialLogins() { for (const p of logins.values()) p.abort.abort(); }
