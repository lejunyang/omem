import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, now } from "../core/util.ts";
import type { PluginContext, PluginHook, PluginHookRequest, PluginHookResult } from "./types.ts";

/**
 * Callbacks from outside (docs/v2/plugins.md, “回调”): a platform tells omem something changed (a merge
 * request got a commit) instead of omem polling. A plugin declares `api.hook({ name, handle })`; the
 * public address is `POST /api/hooks/<plugin>/<name>/<secret>`, the secret made and revoked by the
 * owner on the plugin's page (only its hash is kept). What `handle` returns is acted on by the host:
 * the objects it names are read again (src/flows/plugin-objects.ts) and its signals recorded.
 */
export type RegisteredHook = { plugin: string; name: string; label?: string; handle(ctx: PluginContext, req: PluginHookRequest): PluginHookResult | void | Promise<PluginHookResult | void> };
const hooks = new Map<string, RegisteredHook>();
const id = (plugin: string, name: string) => `${plugin}/${name}`;

export function validateHook(def: Pick<PluginHook, "name" | "label">) {
  if (typeof def.name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(def.name)) throw new Error(`回调名字不合法：${def.name}`);
  if (def.label !== undefined && (typeof def.label !== "string" || def.label.length > 40)) throw new Error(`回调 ${def.name} 的说明最多 40 字`);
}
export function registerHook(plugin: string, def: Omit<RegisteredHook, "plugin">) {
  validateHook(def);
  if (typeof def.handle !== "function") throw new Error(`回调 ${def.name} 需要 handle`);
  const key = id(plugin, def.name);
  if (hooks.has(key)) throw new Error(`回调重复注册：${key}`);
  const entry: RegisteredHook = { plugin, name: def.name, ...(def.label ? { label: def.label } : {}), handle: def.handle };
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
export function checkHookSecret(app: App, plugin: string, name: string, secret: string) {
  const s = stored(app, plugin, name);
  if (!s || !secret.startsWith("omk_")) return false;
  const a = Buffer.from(hash(secret)), b = Buffer.from(s.hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  run(app.db, "update kv set value=? where key=?", JSON.stringify({ ...s, usedAt: now() }), kvKey(plugin, name));
  return true;
}
/** The plugin's callbacks as its page shows them: whether a secret is set, when it was last used. */
export function describeHooks(app: App | null, plugin: string) {
  return pluginHooks(plugin).map((h) => {
    const s = app ? stored(app, plugin, h.name) : null;
    return { name: h.name, label: h.label ?? null, path: `/api/hooks/${plugin}/${h.name}/`, secret: s ? { createdAt: s.createdAt, usedAt: s.usedAt ?? null } : null };
  });
}
/** Secrets of callbacks no plugin declares any more go with the plugin (forgetPlugin). */
export function forgetHookSecrets(app: App, plugin: string) {
  for (const r of all<{ key: string }>(app.db, "select key from kv where key like ?", `plugin-hook:${plugin}/%`)) run(app.db, "delete from kv where key=?", r.key);
}

// ------------------------------------------------------------------ calls

export const HOOK_PER_MINUTE = 60;
export const HOOK_BODY_MAX = 1024 * 1024;
const calls = new WeakMap<App, Map<string, number[]>>();
/** At most HOOK_PER_MINUTE calls a minute per callback; false when over. */
export function hookAllowed(app: App, plugin: string, name: string, at = Date.now()) {
  let map = calls.get(app); if (!map) calls.set(app, map = new Map());
  const key = id(plugin, name), recent = (map.get(key) ?? []).filter((t) => at - t < 60_000);
  if (recent.length >= HOOK_PER_MINUTE) { map.set(key, recent); return false; }
  recent.push(at);
  map.set(key, recent);
  return true;
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
export async function runHook(app: App, plugin: string, name: string, req: PluginHookRequest) {
  const hook = pluginHook(plugin, name);
  if (!hook) throw new HttpError(404, "没有这个回调");
  const { getPlugin } = await import("./registry.ts");
  const { pluginContext } = await import("./blocks.ts");
  const p = getPlugin(plugin);
  const ctx = pluginContext(app, p.env, { userId: OWNER, spaceId: p.manifest.space?.id ?? "personal", runId: null, actor: "user" });
  const { audit } = await import("../auth/permissions.ts");
  const started = Date.now();
  try {
    const { timed, refreshObjectByKey } = await import("../flows/plugin-objects.ts");
    const result = parseResult(await timed(() => hook.handle(ctx, req)));
    const refreshed: string[] = [], skipped: string[] = [];
    for (const r of result.refresh ?? []) {
      const kind = r.kind.includes(":") ? r.kind : `${plugin}:${r.kind}`;
      if (!kind.startsWith(`${plugin}:`)) { skipped.push(`${kind} ${r.key}`); continue; }
      (await refreshObjectByKey(app, kind, r.key) ? refreshed : skipped).push(`${kind} ${r.key}`);
    }
    for (const s of result.emit ?? []) await ctx.emit(s);
    const out = { ok: true, refreshed: refreshed.length, skipped: skipped.length, emitted: result.emit?.length ?? 0 };
    audit(app, "hook", "plugin.hook", `${plugin}/${name}`, { ...out, refreshedKeys: refreshed.slice(0, 20), ms: Date.now() - started });
    return out;
  } catch (e) {
    audit(app, "hook", "plugin.hook", `${plugin}/${name}`, { ok: false, error: (e as Error).message, ms: Date.now() - started });
    throw new HttpError(400, `回调处理失败：${(e as Error).message}`);
  }
}
