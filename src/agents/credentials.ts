import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import type { CredentialContext } from "../../packages/plugin-sdk/credential.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { activeUser, findUser, OWNER } from "../core/users.ts";
import { HttpError, now, untilAbort, zonedParts } from "../core/util.ts";
import { notify } from "../core/notify.ts";
import { audit } from "../auth/permissions.ts";
import { connectionSecrets, deleteConnection, findConnection, listConnections, storeConnection } from "../auth/vault.ts";
import { accountEntry, accountEnv, accountHome, accountStatePaths, clearAccountPaths, ensureAccountHome } from "./accounts.ts";
import { sandboxSupport } from "./sandbox.ts";
import { accountCatalog } from "./catalog.ts";

export { registerCredential } from "./credential-registry.ts";
import { credentialKindsForBackend, credentialMethod, credentialMethods, declaredPaths, requireCredential, type CredentialMethod } from "./credential-registry.ts";
const THREE_DAYS = 3 * 86400_000;
const loginResult = z.object({ user: z.string().trim().min(1).max(200), expiresAt: z.number().finite().positive().optional() }).strict();
const refreshResult = loginResult.omit({ user: true });
const checkResult = refreshResult.extend({ state: z.enum(["ok", "expired", "missing"]), user: z.string().trim().min(1).max(200).optional() });
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
    lastUsedAt: r.last_used_at ?? undefined, error: r.error ?? undefined, sharing: JSON.parse(r.sharing), notified: JSON.parse(r.notified),
    provision: r.provision === null ? undefined : JSON.parse(r.provision), suppliedBackends: JSON.parse(r.supplied_backends) };
}
function emptyHold(id: string): Hold {
  return { state: "none", suppliedBackends: [], checkedDay: "", sharing: { scope: id === OWNER ? "all" : "self", members: [] }, notified: {} };
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
function backendUsable(app: App, id: string, backend: string, kind: string, hold = credentialHold(app, id, kind)) {
  return hold.suppliedBackends.includes(backend) && usableCredential(app, id, kind, hold);
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
export function selectCredential(app: App, requester: string, backend: string, allowLoan: boolean, sandbox: boolean) {
  const methods = credentialKindsForBackend(backend);
  const own = methods.find(m => sandbox && backendUsable(app, requester, backend, m.kind));
  if (own) return { requester, backend, holder: requester, kind: own.kind };
  if (!allowLoan || !methods.length || app.config.credentials.lending !== "auto") return;
  const kinds = methods.map(m => m.kind);
  const rows = all<Row>(app.db, `select * from credential_holds where kind in (${kinds.map(() => "?").join(",")})
    and state='logged-in' order by (user_id=?) desc,last_used_at desc,user_id,kind`, ...kinds, OWNER);
  for (const row of rows) {
    if (row.user_id === requester || (row.user_id === OWNER ? app.config.agents.accountIsolation === "require" : !sandbox)) continue;
    const use = { requester, backend, holder: row.user_id, kind: row.kind };
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
  const timer = setTimeout(() => ctrl.abort(new Error("凭据操作超时")), ms);
  const signal = AbortSignal.any([m.signal, ctrl.signal]);
  try { return await untilAbort(signal, () => work(signal)); }
  finally { clearTimeout(timer); ctrl.abort(); }
}
export function precheckCredential(app: App, holder: string, m: CredentialMethod, resource: string, user: string, command?: { name: string; args: readonly string[] }) {
  const check = m.precheck!;
  return timed(m, 20_000, signal => check(context(app, holder, m, signal, "check"), { resource, user, ...(command ? { command } : {}) }));
}

function reminder(app: App, id: string, m: CredentialMethod, state: "expired" | "expiring" | "failed") {
  const hold = credentialHold(app, id, m.kind), today = day(app);
  if (hold.notified[state] === today) return;
  notify(app, { userId: id, title: `${m.name} ${state === "expired" ? "登录过期了" : state === "failed" ? "授权或检查失败" : "三天内到期"}`,
    body: id === OWNER ? "用的是这台机器上已有的登录，请在本机重新授权。" : `请重新授权 ${m.name}。此前的账号文件会保留。`, link: "#/account" });
  save(app, id, m.kind, { ...hold, notified: { ...hold.notified, [state]: today } });
}
export function expireCommandCredential(app: App, id: string, m: CredentialMethod) {
  return serial(keyOf(app, id, m.kind), async () => {
    const hold = credentialHold(app, id, m.kind);
    if (hold.state === "none" || m.signal.aborted) return;
    save(app, id, m.kind, { ...hold, state: "expired", refreshAt: undefined });
    reminder(app, id, m, "expired");
  });
}
function remindHold(app: App, id: string, m: CredentialMethod) {
  const s = credentialHold(app, id, m.kind);
  if (s.state === "expired" || s.expiresAt !== undefined && s.expiresAt <= Date.now()) reminder(app, id, m, "expired");
  else if (s.state === "logged-in" && s.expiresAt !== undefined && s.expiresAt - Date.now() <= THREE_DAYS) reminder(app, id, m, "expiring");
}
type LoginReply = { url?: string; code?: string; done?: boolean };
type Pending = { method: CredentialMethod; abort: AbortController; reply: Promise<LoginReply>; url?: string; code?: string };
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
  const p: Pending = { method: m, abort, reply: new Promise((yes, no) => { resolve = yes; reject = no; }) };
  logins.set(key, p);
  let replied = false;
  const answer = (fn: () => void) => { if (!replied) { replied = true; clearTimeout(first); fn(); } };
  const first = setTimeout(() => abort.abort(new Error("60 秒内没有给出登录链接")), 60_000);
  const timeout = AbortSignal.timeout(660_000);
  const signal = AbortSignal.any([abort.signal, m.signal, timeout]);
  void serial(key, async () => {
    try {
      const ctx = context(app, id, m, signal, "supply");
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
      save(app, id, kind, { ...credentialHold(app, id, kind), ...result, suppliedBackends: m.provides.backends, expiresAt: result.expiresAt, state: "logged-in", refreshAt: refreshAt(result.expiresAt), checkedAt: now(), error: undefined });
      remindHold(app, id, m);
      answer(() => resolve({ done: true }));
    } catch {
      if (!signal.aborted || timeout.aborted || !replied) {
        const hold = credentialHold(app, id, kind);
        save(app, id, kind, { ...hold, state: "expired", error: "授权或供给失败，请重新登录", checkedAt: now() });
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
          const ctx = context(app, id, m, signal, "supply");
          const r = await untilAbort(signal, () => m.refresh!(ctx));
          if (r === null) throw new Error("重新授权");
          const result = refreshResult.parse(r);
          if (m.provide) await untilAbort(signal, () => m.provide!(ctx));
          return result;
        });
        save(app, id, kind, { ...credentialHold(app, id, kind), ...result, suppliedBackends: m.provides.backends, expiresAt: result.expiresAt, refreshAt: refreshAt(result.expiresAt), checkedAt: now(), error: undefined });
      } else if (s.expiresAt !== undefined && s.expiresAt <= Date.now()) save(app, id, kind, { ...credentialHold(app, id, kind), state: "expired", refreshAt: undefined });
      else save(app, id, kind, { ...credentialHold(app, id, kind), refreshAt: s.expiresAt });
    } catch { save(app, id, kind, { ...credentialHold(app, id, kind), state: "expired", refreshAt: undefined, error: "续签或供给失败，请重新授权", checkedAt: now() }); }
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
    try {
      const result = checkResult.parse(await timed(m, 120_000, signal => m.check!(context(app, id, m, signal, "check"))));
      const expiresAt = result.state === "missing" ? undefined : result.expiresAt ?? s.expiresAt;
      save(app, id, kind, { ...credentialHold(app, id, kind), state: result.state === "missing" ? "missing" : result.state === "expired" || expiresAt !== undefined && expiresAt <= Date.now() ? "expired" : "logged-in",
        suppliedBackends: id === OWNER ? m.provides.backends : s.suppliedBackends,
        user: result.state === "missing" ? undefined : result.user ?? s.user, expiresAt, refreshAt: id === OWNER ? undefined : refreshAt(expiresAt), checkedAt: now(), checkedDay: day(app), error: undefined });
    } catch { save(app, id, kind, { ...credentialHold(app, id, kind), checkedAt: now(), checkedDay: day(app), error: "检查失败，请稍后重试" }); reminder(app, id, m, "failed"); }
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
  for (const m of credentialMethods()) if (m.check) {
    const s = credentialHold(app, OWNER, m.kind);
    if (!one(app.db, "select 1 from credential_holds where user_id=? and kind=?", OWNER, m.kind)) save(app, OWNER, m.kind, s);
  }
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
  return [...new Set(credentialMethods().flatMap(m => declaredPaths(app, m).install).filter(installed))];
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
export type CredentialState = "none" | "ok" | "expiring" | "expired" | "logging-in";
function viewOf(app: App, id: string, m: CredentialMethod, s: Hold) {
  const p = logins.get(keyOf(app, id, m.kind));
  const state: CredentialState = p ? "logging-in" : s.state === "expired" || s.expiresAt !== undefined && s.expiresAt <= Date.now() ? "expired"
    : !usableCredential(app, id, m.kind, s) ? "none" : s.expiresAt !== undefined && s.expiresAt - Date.now() <= THREE_DAYS ? "expiring" : "ok";
  const missing = declaredPaths(app, m).install.filter(p => !installed(p));
  return { kind: m.kind, plugin: m.plugin, name: m.name, describe: m.describe ?? "", required: !!m.required, state,
    user: s.user, expiresAt: s.expiresAt, checkedAt: s.checkedAt, error: s.error, sharing: s.sharing,
    backends: m.provides.backends, commands: m.provides.commands.map(c => c.name), login: id !== OWNER && sandboxSupport().ok,
    machine: id === OWNER, url: p?.url, code: p?.code,
    reason: id === OWNER ? "用的是这台机器上已有的登录" : !sandboxSupport().ok ? sandboxSupport().reason : undefined,
    missingInstall: missing };
}
export function myCredentials(app: App, id: string) {
  const rows = all<Row>(app.db, "select * from credential_holds where user_id=?", id);
  const holds = new Map(rows.map(r => [r.kind, fromRow(r)]));
  return { credentials: credentialMethods().map(m => viewOf(app, id, m, holds.get(m.kind) ?? emptyHold(id))) };
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
