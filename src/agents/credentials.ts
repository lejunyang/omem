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
import { connectionSecrets, deleteConnection, findConnection, listConnections, storeConnection } from "../auth/vault.ts";
import { accountEntry, accountEnv, accountHome, ensureAccountHome } from "./accounts.ts";
import { sandboxSupport } from "./sandbox.ts";

export { registerCredential } from "./credential-registry.ts";
import { credentialKindsForBackend, credentialMethod, credentialMethods, declaredPaths, requireCredential, type CredentialMethod } from "./credential-registry.ts";
const THREE_DAYS = 3 * 86400_000;
const loginResult = z.object({ user: z.string().trim().min(1).max(200), expiresAt: z.number().finite().positive().optional() }).strict();
const refreshResult = loginResult.omit({ user: true });
const checkResult = refreshResult.extend({ state: z.enum(["ok", "expired", "missing"]), user: z.string().trim().min(1).max(200).optional() });
const sharingSchema = z.object({ scope: z.enum(["self", "members", "all"]), members: z.array(z.string()).max(200).default([]) }).strict();
export type CredentialSharing = z.infer<typeof sharingSchema>;
export type Hold = {
  state: "none" | "logged-in" | "expired"; user?: string; expiresAt?: number; refreshAt?: number;
  checkedAt?: string; checkedDay: string; lastUsedAt?: string; error?: string;
  sharing: CredentialSharing; notified: Record<string, string>;
};
type Row = { user_id: string; kind: string; state: Hold["state"]; account_name: string | null;
  expires_at: number | null; refresh_at: number | null; checked_at: string | null; check_day: string;
  last_used_at: string | null; error: string | null; sharing: string; notified: string };
const day = (app: App, at = Date.now()) => zonedParts(at, app.config.timezone).date;
const refreshAt = (expiresAt?: number) => expiresAt === undefined ? undefined : Math.max(expiresAt - 600_000, Date.now() + 60_000);
function member(app: App, id: string) {
  const user = findUser(app, id);
  return id !== OWNER && activeUser(user) && user.kind === "person";
}
const secretProvider = (kind: string) => `credential:${kind}`;
const keyOf = (app: App, id: string, kind: string) => `${app.home}|${id}|${kind}`;

function fromRow(r: Row): Hold {
  return { state: r.state, user: r.account_name ?? undefined, expiresAt: r.expires_at ?? undefined,
    refreshAt: r.refresh_at ?? undefined, checkedAt: r.checked_at ?? undefined, checkedDay: r.check_day,
    lastUsedAt: r.last_used_at ?? undefined, error: r.error ?? undefined, sharing: JSON.parse(r.sharing), notified: JSON.parse(r.notified) };
}
export function credentialHold(app: App, userId: string, kind: string): Hold {
  const r = one<Row>(app.db, "select * from credential_holds where user_id=? and kind=?", userId, kind);
  return r ? fromRow(r) : { state: "none", checkedDay: "", sharing: { scope: userId === OWNER ? "all" : "self", members: [] }, notified: {} };
}
function save(app: App, userId: string, kind: string, hold: Hold) {
  run(app.db, `insert into credential_holds(user_id,kind,state,account_name,expires_at,refresh_at,check_day,checked_at,sharing,notified,last_used_at,error)
    values(?,?,?,?,?,?,?,?,?,?,?,?) on conflict(user_id,kind) do update set state=excluded.state,account_name=excluded.account_name,
    expires_at=excluded.expires_at,refresh_at=excluded.refresh_at,check_day=excluded.check_day,checked_at=excluded.checked_at,
    sharing=excluded.sharing,notified=excluded.notified,last_used_at=excluded.last_used_at,error=excluded.error`,
    userId, kind, hold.state, hold.user ?? null, hold.expiresAt ?? null, hold.refreshAt ?? null, hold.checkedDay,
    hold.checkedAt ?? null, JSON.stringify(hold.sharing), JSON.stringify(hold.notified), hold.lastUsedAt ?? null, hold.error ?? null);
}
function usable(app: App, id: string, kind: string, s = credentialHold(app, id, kind)) {
  return s.state === "logged-in" && (s.expiresAt === undefined || s.expiresAt > Date.now()) && (id === OWNER || existsSync(accountHome(app, id)));
}
export const hasCredentials = (app: App, id: string) => !!one(app.db, "select 1 from credential_holds where user_id=? and state!='none' limit 1", id);
export const credentialBackendLogin = (app: App, id: string, backend: string) => credentialKindsForBackend(backend).some(m => usable(app, id, m.kind));
export type CredentialUse = { holder: string; kind: string; requester: string; backend: string };
export const credentialUse = Symbol("credentialUse");
export function selectedCredential(profile: object) {
  return (profile as { [credentialUse]?: CredentialUse })[credentialUse];
}
export function mayUseCredential(app: App, use: CredentialUse) {
  const hold = credentialHold(app, use.holder, use.kind);
  if (!credentialMethod(use.kind)?.provides.backends.includes(use.backend) || !usable(app, use.holder, use.kind, hold)) return false;
  if (use.holder === use.requester) return true;
  return app.config.credentials.lending === "auto" && (use.holder === OWNER || member(app, use.holder)) &&
    (hold.sharing.scope === "all" || hold.sharing.scope === "members" && hold.sharing.members.includes(use.requester));
}
export function selectCredential(app: App, requester: string, backend: string, allowLoan: boolean, sandbox: boolean) {
  const methods = credentialKindsForBackend(backend);
  const own = methods.find(m => sandbox && usable(app, requester, m.kind));
  if (own) return { requester, backend, holder: requester, kind: own.kind };
  if (!allowLoan || !methods.length || app.config.credentials.lending !== "auto") return;
  const kinds = methods.map(m => m.kind);
  const rows = all<Row>(app.db, `select * from credential_holds where kind in (${kinds.map(() => "?").join(",")})
    and state='logged-in' order by (user_id=?) desc,last_used_at desc,user_id,kind`, ...kinds, OWNER);
  for (const row of rows) {
    if (row.user_id === requester || (row.user_id === OWNER ? app.config.agents.accountIsolation === "require" : !sandbox)) continue;
    const use = { requester, backend, holder: row.user_id, kind: row.kind };
    if (mayUseCredential(app, use)) return use;
  }
}
export function credentialSucceeded(app: App, profile: object) {
  const use = selectedCredential(profile);
  if (use) run(app.db, "update credential_holds set last_used_at=? where user_id=? and kind=?", now(), use.holder, use.kind);
}
export function credentialAccountView(app: App, id: string, backend: string) {
  const m = credentialKindsForBackend(backend).find(m => usable(app, id, m.kind));
  return m ? { ...credentialHold(app, id, m.kind), kind: m.kind, name: m.name } : null;
}
function context(app: App, id: string, m: CredentialMethod, signal: AbortSignal): CredentialContext {
  const home = id === OWNER ? homedir() : ensureAccountHome(app, id);
  const env = id === OWNER ? { ...process.env } : Object.assign({}, ...m.provides.backends.map(b => {
    const e = accountEntry(app, b); return e ? accountEnv(app, id, e) : {};
  }));
  return { userId: id, home, env: { ...env, HOME: home }, signal, settings: m.settings(), secret: {
    async get() { signal.throwIfAborted(); const c = findConnection(app, id, secretProvider(m.kind)); return c ? connectionSecrets(app, c.id)?.accessToken ?? null : null; },
    async set(value) {
      signal.throwIfAborted();
      if (id === OWNER) throw new Error("本机凭据只检查，不写入");
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
  const timer = setTimeout(() => ctrl.abort(new Error("凭据操作超时")), ms);
  const signal = AbortSignal.any([m.signal, ctrl.signal]);
  try { return await untilAbort(signal, () => work(signal)); }
  finally { clearTimeout(timer); ctrl.abort(); }
}
function reminder(app: App, id: string, m: CredentialMethod, state: "expired" | "expiring" | "failed") {
  const hold = credentialHold(app, id, m.kind), today = day(app);
  if (hold.notified[state] === today) return;
  notify(app, { userId: id, title: `${m.name} ${state === "expired" ? "登录过期了" : state === "failed" ? "授权或检查失败" : "三天内到期"}`,
    body: id === OWNER ? "用的是这台机器上已有的登录，请在本机重新授权。" : `请重新授权 ${m.name}。此前的账号文件会保留。`, link: "#/account" });
  save(app, id, m.kind, { ...hold, notified: { ...hold.notified, [state]: today } });
}
function remindHold(app: App, id: string, m: CredentialMethod) {
  const s = credentialHold(app, id, m.kind);
  if (s.state === "expired" || s.expiresAt !== undefined && s.expiresAt <= Date.now()) reminder(app, id, m, "expired");
  else if (s.state === "logged-in" && s.expiresAt !== undefined && s.expiresAt - Date.now() <= THREE_DAYS) reminder(app, id, m, "expiring");
}
type LoginReply = { url?: string; code?: string; done?: boolean };
type Pending = { abort: AbortController; reply: Promise<LoginReply>; url?: string; code?: string };
const logins = new Map<string, Pending>();
export function startCredentialLogin(app: App, id: string, kind: string): Promise<LoginReply> {
  const m = requireCredential(kind);
  if (!member(app, id)) throw new HttpError(400, "用的是这台机器上已有的登录，请在本机授权");
  const support = sandboxSupport();
  if (!support.ok) throw new HttpError(400, "成员凭据需要账号沙箱：" + support.reason);
  const key = keyOf(app, id, kind), pending = logins.get(key);
  if (pending) return pending.reply;
  ensureAccountHome(app, id);
  const abort = new AbortController();
  let resolve!: (v: LoginReply) => void, reject!: (e: unknown) => void;
  const p: Pending = { abort, reply: new Promise((yes, no) => { resolve = yes; reject = no; }) };
  logins.set(key, p);
  let replied = false;
  const answer = (fn: () => void) => { if (!replied) { replied = true; clearTimeout(first); fn(); } };
  const first = setTimeout(() => abort.abort(new Error("60 秒内没有给出登录链接")), 60_000);
  const timeout = AbortSignal.timeout(660_000);
  const signal = AbortSignal.any([abort.signal, m.signal, timeout]);
  void serial(key, async () => {
    try {
      const ctx = context(app, id, m, signal);
      const result = loginResult.parse(await untilAbort(signal, () => m.login(ctx, link => {
        signal.throwIfAborted();
        const l = z.object({ url: z.httpUrl().max(2000), code: z.string().max(64).optional() }).parse(link);
        p.url = l.url; p.code = l.code;
        notify(app, { userId: id, title: `omem 正在为你登录 ${m.name}`,
          body: `请打开 ${l.url}${l.code ? `，验证码 ${l.code}` : ""}。11 分钟内完成授权。`, link: "#/account", urgency: "urgent" });
        answer(() => resolve(l));
      })));
      if (m.provide) await untilAbort(signal, () => m.provide!(ctx));
      signal.throwIfAborted();
      save(app, id, kind, { ...credentialHold(app, id, kind), ...result, expiresAt: result.expiresAt, state: "logged-in", refreshAt: refreshAt(result.expiresAt), checkedAt: now(), error: undefined });
      remindHold(app, id, m);
      answer(() => resolve({ done: true }));
    } catch {
      if (!signal.aborted || timeout.aborted || !replied) {
        save(app, id, kind, { ...credentialHold(app, id, kind), state: "expired", error: "授权或供给失败，请重新登录", checkedAt: now() });
        reminder(app, id, m, "failed");
      }
      answer(() => reject(new HttpError(502, signal.aborted ? "登录取消或超时，请重试" : "授权或供给失败，请重新登录")));
    } finally { clearTimeout(first); abort.abort(); if (logins.get(key) === p) logins.delete(key); }
  });
  return p.reply;
}
export function refreshCredential(app: App, id: string, kind: string) {
  const m = requireCredential(kind);
  if (id === OWNER) return checkCredential(app, id, kind);
  return serial(keyOf(app, id, kind), async () => {
    const s = credentialHold(app, id, kind);
    if (s.state !== "logged-in") return s;
    try {
      if (m.refresh) {
        const result = await timed(m, 120_000, async signal => {
          const ctx = context(app, id, m, signal);
          const r = await untilAbort(signal, () => m.refresh!(ctx));
          if (r === null) throw new Error("重新授权");
          const result = refreshResult.parse(r);
          if (m.provide) await untilAbort(signal, () => m.provide!(ctx));
          return result;
        });
        save(app, id, kind, { ...credentialHold(app, id, kind), ...result, expiresAt: result.expiresAt, refreshAt: refreshAt(result.expiresAt), checkedAt: now(), error: undefined });
      } else if (s.expiresAt !== undefined && s.expiresAt <= Date.now()) save(app, id, kind, { ...credentialHold(app, id, kind), state: "expired", refreshAt: undefined });
      else save(app, id, kind, { ...credentialHold(app, id, kind), refreshAt: s.expiresAt });
    } catch { save(app, id, kind, { ...credentialHold(app, id, kind), state: "expired", refreshAt: undefined, error: "续签或供给失败，请重新授权", checkedAt: now() }); }
    remindHold(app, id, m);
    return credentialHold(app, id, kind);
  });
}
export function checkCredential(app: App, id: string, kind: string) {
  const m = requireCredential(kind);
  return serial(keyOf(app, id, kind), async () => {
    const s = credentialHold(app, id, kind);
    if (!m.check) return s;
    try {
      const result = checkResult.parse(await timed(m, 120_000, signal => m.check!(context(app, id, m, signal))));
      const expiresAt = result.state === "missing" ? undefined : result.expiresAt ?? s.expiresAt;
      save(app, id, kind, { ...credentialHold(app, id, kind), state: result.state === "missing" ? "none" : result.state === "expired" || expiresAt !== undefined && expiresAt <= Date.now() ? "expired" : "logged-in",
        user: result.state === "missing" ? undefined : result.user ?? s.user, expiresAt, refreshAt: id === OWNER ? undefined : refreshAt(expiresAt), checkedAt: now(), checkedDay: day(app), error: undefined });
    } catch { save(app, id, kind, { ...credentialHold(app, id, kind), checkedAt: now(), checkedDay: day(app), error: "检查失败，请稍后重试" }); reminder(app, id, m, "failed"); }
    remindHold(app, id, m);
    return credentialHold(app, id, kind);
  });
}
export function logoutCredential(app: App, id: string, kind: string, actor = id) {
  const m = requireCredential(kind);
  if (id === OWNER) throw new HttpError(400, "用的是这台机器上已有的登录，请在本机退出");
  logins.get(keyOf(app, id, kind))?.abort.abort();
  return serial(keyOf(app, id, kind), async () => {
    if (m.logout && existsSync(accountHome(app, id))) await timed(m, 20_000, signal => m.logout!(context(app, id, m, signal))).catch(() => {});
    const c = findConnection(app, id, secretProvider(kind)); if (c) deleteConnection(app, c.id);
    save(app, id, kind, { ...credentialHold(app, id, kind), state: "none", user: undefined, expiresAt: undefined, refreshAt: undefined, checkedAt: now(), error: undefined });
    audit(app, actor, "credentials.logout", kind, { holder: id });
  });
}
export async function removeAllCredentials(app: App, id: string) {
  for (const m of credentialMethods()) await logoutCredential(app, id, m.kind);
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
  for (const m of credentialMethods()) if (m.check) {
    const s = credentialHold(app, OWNER, m.kind);
    if (!one(app.db, "select 1 from credential_holds where user_id=? and kind=?", OWNER, m.kind)) save(app, OWNER, m.kind, s);
  }
  const rows = all<Row>(app.db, "select * from credential_holds indexed by credential_check_due where check_day<? order by check_day limit 32", day(app, at));
  let count = 0;
  for (const r of rows) {
    const m = credentialMethod(r.kind);
    if (!m?.check || r.user_id !== OWNER && (r.state === "none" || !member(app, r.user_id))) {
      if (m && r.state !== "none" && member(app, r.user_id)) remindHold(app, r.user_id, m);
      run(app.db, "update credential_holds set check_day=? where user_id=? and kind=?", day(app, at), r.user_id, r.kind);
      continue;
    }
    await checkCredential(app, r.user_id, r.kind); count++;
  }
  return count;
}
const installed = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory();
export function credentialInstallDirs(app: App) {
  return [...new Set(credentialMethods().flatMap(m => declaredPaths(app, m).install).filter(installed))];
}
export function credentialStatePaths(app: App) { return [...new Set(credentialMethods().flatMap(m => declaredPaths(app, m).state))]; }
export function credentialStateRels(app: App) {
  credentialStatePaths(app);
  return [...new Set(credentialMethods().flatMap(m => m.provides.commands.flatMap(c => c.state ?? [])))];
}
export function maybeSendCredentialOnboarding(app: App, id: string) {
  if (!member(app, id)) return false;
  const missing = credentialMethods().filter(m => !usable(app, id, m.kind));
  if (!missing.length || !run(app.db, "insert into credential_onboarding(user_id,notified_at) values(?,?) on conflict(user_id) do nothing", id, now()).changes) return false;
  notify(app, { userId: id, title: "接入清单", body: missing.map(m => `${m.name}（${m.required ? "必做" : "可选"}）${m.describe ? "：" + m.describe : ""}；覆盖 ${[...m.provides.backends, ...m.provides.commands.map(c => c.name)].join("、")}`).join("\n"), link: "#/account" });
  return true;
}
export type CredentialState = "none" | "ok" | "expiring" | "expired" | "logging-in";
function viewOf(app: App, id: string, m: CredentialMethod) {
  const s = credentialHold(app, id, m.kind), p = logins.get(keyOf(app, id, m.kind));
  const state: CredentialState = p ? "logging-in" : s.state === "expired" || s.expiresAt !== undefined && s.expiresAt <= Date.now() ? "expired"
    : !usable(app, id, m.kind) ? "none" : s.expiresAt !== undefined && s.expiresAt - Date.now() <= THREE_DAYS ? "expiring" : "ok";
  const missing = declaredPaths(app, m).install.filter(p => !installed(p));
  return { kind: m.kind, plugin: m.plugin, name: m.name, describe: m.describe ?? "", required: !!m.required, state,
    user: s.user, expiresAt: s.expiresAt, checkedAt: s.checkedAt, error: s.error, sharing: s.sharing,
    backends: m.provides.backends, commands: m.provides.commands.map(c => c.name), login: id !== OWNER && sandboxSupport().ok,
    machine: id === OWNER, url: p?.url, code: p?.code,
    reason: id === OWNER ? "用的是这台机器上已有的登录" : !sandboxSupport().ok ? sandboxSupport().reason : undefined,
    missingInstall: missing };
}
export const myCredentials = (app: App, id: string) => ({ credentials: credentialMethods().map(m => viewOf(app, id, m)) });
export function allCredentials(app: App) {
  const rows = all<Row>(app.db, "select * from credential_holds order by user_id,kind limit 2000");
  const people = new Map<string, { userId: string; name: string; credentials: Omit<ReturnType<typeof viewOf>, "url" | "code">[] }>();
  for (const r of rows) {
    const m = credentialMethod(r.kind); if (!m) continue;
    let person = people.get(r.user_id);
    if (!person) { person = { userId: r.user_id, name: userName(app, r.user_id), credentials: [] }; people.set(r.user_id, person); }
    const { url, code, ...v } = viewOf(app, r.user_id, m);
    person.credentials.push(v);
  }
  return { kinds: credentialMethods().map(m => ({ kind: m.kind, name: m.name })), people: [...people.values()], limit: 2000 };
}
export function stopCredentialLogins() { for (const p of logins.values()) p.abort.abort(); }
