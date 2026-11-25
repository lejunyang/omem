import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { App } from "../core/app.ts";
import { one, run, tx } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now, webBase } from "../core/util.ts";
import { runHookAccept, type HookResponder } from "./hook-accept.ts";
import { HOOK_PER_MINUTE, hookKeyHeader, hookPath, validateHookOptions } from "./hook-request.ts";
import type { PluginHook, PluginHookOptions, PluginHookRequest, PluginHookResult } from "./types.ts";

/**
 * Callbacks from outside (docs/v2/plugins.md, “回调”): a platform tells omem something changed (a merge
 * request got a commit) instead of omem polling. A plugin declares `api.hook({ name, handle })`; the
 * public address is `POST /api/hooks/<plugin>/<name>/<secret>`, the secret made and revoked by the
 * owner on the plugin's page (only its hash is kept). What `handle` returns is acted on by the host:
 * the objects it names are read again (src/flows/plugin-objects.ts) and its signals recorded.
 */
export type RegisteredHook = Omit<PluginHook, "accept"> & { plugin: string; respond?: HookResponder };
const hooks = new Map<string, RegisteredHook>();
const id = (plugin: string, name: string) => `${plugin}/${name}`;

export function validateHook(def: PluginHook) {
  if (typeof def.name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(def.name)) throw new Error(`回调名字不合法：${def.name}`);
  if (def.label !== undefined && (typeof def.label !== "string" || def.label.length > 40)) throw new Error(`回调 ${def.name} 的说明最多 40 字`);
  if (typeof def.handle !== "function") throw new Error(`回调 ${def.name} 需要 handle`);
  if (def.accept !== undefined && (def.ack !== "first" || typeof def.accept !== "function")) throw new Error(`回调 ${def.name} 的 accept 需要 ack: "first" 和同步函数`);
  validateHookOptions(def);
}
export function hookMetadata(def: PluginHookOptions): PluginHookOptions {
  const { name, label, ack, format, secretHeader, headers, dedup, rateLimit, unauthorizedBody, rateLimitedBody, unavailableBody } = def;
  const options = structuredClone({ name, label, ack, format, secretHeader, headers, dedup, rateLimit, unauthorizedBody, rateLimitedBody, unavailableBody });
  for (const body of [options.unauthorizedBody, options.rateLimitedBody, options.unavailableBody]) JSON.stringify(body);
  return options;
}
export function registerHook(plugin: string, def: PluginHook, sandboxResponder?: HookResponder) {
  validateHook(def);
  const key = id(plugin, def.name);
  if (hooks.has(key)) throw new Error(`回调重复注册：${key}`);
  const { accept } = def;
  const respond: HookResponder | undefined = accept ? (req, state) => runHookAccept(accept, req, state) : sandboxResponder;
  const entry: RegisteredHook = { ...hookMetadata(def), plugin, handle: def.handle, respond };
  hooks.set(key, entry);
  return () => { if (hooks.get(key) === entry) hooks.delete(key); };
}
export const pluginHook = (plugin: string, name: string) => hooks.get(id(plugin, name));
export const pluginHooks = (plugin: string) => [...hooks.values()].filter((h) => h.plugin === plugin);

// ------------------------------------------------------------------ secrets

const kvKey = (plugin: string, name: string) => `plugin-hook:${plugin}/${name}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
type Stored = { hash: string; createdAt: string; usedAt?: string };
const stored = (app: App, plugin: string, name: string) => json<Stored | null>(one<{ value: string }>(app.db, "select value from kv where key=?", kvKey(plugin, name))?.value, null);

/** A new secret (the old one stops working); shown once, kept only as its hash. */
export function createHookSecret(app: App, plugin: string, name: string) {
  if (!pluginHook(plugin, name)) throw new HttpError(404, `插件 ${plugin} 没有回调 ${name}`);
  const secret = "omk_" + randomBytes(24).toString("base64url");
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value", kvKey(plugin, name), JSON.stringify({ hash: hash(secret), createdAt: now() }));
  return secret;
}
export function revokeHookSecret(app: App, plugin: string, name: string) {
  return run(app.db, "delete from kv where key=?", kvKey(plugin, name)).changes > 0;
}
export function checkHookSecret(app: App, plugin: string, name: string, secret: string, markUsed = true) {
  const s = stored(app, plugin, name);
  const expected = typeof s?.hash === "string" && /^[0-9a-f]{64}$/.test(s.hash) ? s.hash : "00".repeat(32);
  const match = timingSafeEqual(Buffer.from(hash(secret), "hex"), Buffer.from(expected, "hex"));
  if (!match || !s || !pluginHook(plugin, name)) return false;
  if (markUsed) run(app.db, "update kv set value=? where key=?", JSON.stringify({ ...s, usedAt: now() }), kvKey(plugin, name));
  return true;
}
/**
 * The last request a callback refused before it became a delivery (wrong secret, too many, a malformed or
 * mismatched request, the plugin's own refusal): the page shows it so "the platform says it sent, nothing
 * arrived" can be told from "it arrived and was refused". In memory, one entry per registered callback.
 */
const refused = new Map<string, { at: number; status: number; count: number }>();
export function noteHookRefused(plugin: string, name: string, status: number) {
  if (!pluginHooks(plugin).some((h) => h.name === name)) return;
  const key = `${plugin}/${name}`;
  refused.set(key, { at: Date.now(), status, count: (refused.get(key)?.count ?? 0) + 1 });
}

/**
 * The plugin's callbacks as its page shows them: whether a secret is set, when it was last used, the last
 * delivery (repeats of an earlier one left out) and, with `webUrl` configured, the address to give the
 * platform (`url`; null: the page falls back to where it was opened from).
 */
export function describeHooks(app: App | null, plugin: string) {
  const base = app ? webBase(app) : null;
  return pluginHooks(plugin).map((h) => {
    const s = app ? stored(app, plugin, h.name) : null;
    const headerPath = hookPath(plugin, h.name);
    const last = app ? one<{ at: number; status: string; error: string | null }>(app.db, `select received_at as at,status,error from plugin_hook_deliveries
      where plugin=? and name=? and status!='duplicate' order by received_at desc,rowid desc limit 1`, plugin, h.name) ?? null : null;
    return { name: h.name, label: h.label ?? null, path: `${headerPath}/`, headerPath, url: base ? `${base}${headerPath}` : null,
      secretHeader: hookKeyHeader(h), ack: h.ack ?? null, rateLimit: h.rateLimit ?? { perMinute: HOOK_PER_MINUTE },
      secret: s ? { createdAt: s.createdAt, usedAt: s.usedAt ?? null } : null, lastDelivery: last,
      lastRefused: refused.get(`${plugin}/${h.name}`) ?? null };
  });
}
export function forgetPluginHooks(app: App, plugin: string) {
  tx(app.db, () => {
    const prefix = `plugin-hook:${plugin}/`;
    run(app.db, "delete from kv where substr(key,1,length(?))=?", prefix, prefix);
    run(app.db, `update plugin_hook_deliveries set status='failed',error='插件已移除',body=null,envelope=null,due_at=null,key_until=null
      where plugin=? and status in ('admitting','pending','running')`, plugin);
    run(app.db, "update plugin_hook_deliveries set key_until=null where plugin=? and key_until is not null", plugin);
  });
}

// ------------------------------------------------------------------ calls

type Rate = { recent: number[]; tokens: number; last: number };
const calls = new WeakMap<App, WeakMap<RegisteredHook, Rate>>();
export function hookRetryAfter(app: App, hook: RegisteredHook, at = Date.now()) {
  const { perMinute, burst } = hook.rateLimit ?? { perMinute: HOOK_PER_MINUTE };
  let map = calls.get(app); if (!map) calls.set(app, map = new WeakMap());
  let rate = map.get(hook);
  if (!rate) map.set(hook, rate = { recent: [], last: at, tokens: burst ?? 0 });
  if (burst !== undefined) {
    const step = 60_000 / perMinute;
    rate.tokens = Math.min(burst, rate.tokens + Math.max(0, at - rate.last) / step);
    rate.last = at;
    if (rate.tokens < 1) return Math.max(1, Math.ceil((1 - rate.tokens) * step / 1000));
    rate.tokens--;
  } else {
    rate.recent = rate.recent.filter(time => at - time < 60_000);
    if (rate.recent.length >= perMinute) return Math.max(1, Math.ceil((60_000 - (at - rate.recent[0])) / 1000));
    rate.recent.push(at);
  }
  return 0;
}

const parseResult = (v: unknown): PluginHookResult => {
  if (v == null) return {};
  if (typeof v !== "object") throw new Error("回调要返回对象：{ refresh?, emit? }");
  const r = v as PluginHookResult;
  if (r.refresh !== undefined && (!Array.isArray(r.refresh) || r.refresh.length > 50 || r.refresh.some((x) => !x || typeof x.kind !== "string" || typeof x.key !== "string" || x.key.length > 4000))) throw new Error("refresh 要是 [{ kind, key }]，最多 50 个");
  if (r.emit !== undefined && (!Array.isArray(r.emit) || r.emit.length > 20)) throw new Error("emit 最多 20 个信号");
  return r;
};

/**
 * One call from outside, already past its secret and the limit: the plugin's handle runs as the owner
 * in the plugin's space, then the host reads again the objects it names (only this plugin's kinds, only
 * ones omem already follows) and records its signals. Written to audit_events either way.
 */
export async function runHook(app: App, hook: RegisteredHook, req: PluginHookRequest, track: (work: Promise<unknown>) => void) {
  const { plugin, name } = hook;
  const { getPlugin } = await import("./registry.ts");
  const { pluginContext } = await import("./blocks.ts");
  const { audit } = await import("../auth/permissions.ts");
  const assertActive = () => { if (pluginHook(plugin, name) !== hook) throw new Error("回调已停用或重新加载"); };
  const started = Date.now();
  try {
    const { timed, refreshObjectByKey } = await import("../flows/plugin-objects.ts");
    assertActive();
    const p = getPlugin(plugin);
    const ctx = pluginContext(app, p.env, { userId: OWNER, spaceId: p.manifest.space?.id ?? "personal", runId: null, actor: "user" });
    const work = Promise.resolve().then(() => { assertActive(); return hook.handle(ctx, req); });
    track(work);
    const result = parseResult(await timed(() => work));
    assertActive();
    const refreshed: string[] = [], skipped: string[] = [];
    for (const r of result.refresh ?? []) {
      assertActive();
      const kind = r.kind.includes(":") ? r.kind : `${plugin}:${r.kind}`;
      if (!kind.startsWith(`${plugin}:`)) { skipped.push(`${kind} ${r.key}`); continue; }
      (await refreshObjectByKey(app, kind, r.key) ? refreshed : skipped).push(`${kind} ${r.key}`);
    }
    for (const s of result.emit ?? []) { assertActive(); await ctx.emit(s); }
    const out = { ok: true, refreshed: refreshed.length, skipped: skipped.length, emitted: result.emit?.length ?? 0 };
    audit(app, "hook", "plugin.hook", `${plugin}/${name}`, { ...out, refreshedKeys: refreshed.slice(0, 20), ms: Date.now() - started });
    return out;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    audit(app, "hook", "plugin.hook", `${plugin}/${name}`, { ok: false, error, ms: Date.now() - started });
    throw new HttpError(400, `回调处理失败：${error}`);
  }
}
