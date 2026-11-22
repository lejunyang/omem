import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { z } from "zod";
import type { CredentialDef, CredentialContext, CredentialCommand, CredentialOutcome } from "../../packages/plugin-sdk/credential.ts";
import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { HttpError } from "../core/util.ts";
import { canonical, normalizeSandbox, under } from "./own-sandbox.ts";

export type { CredentialDef, CredentialContext, CredentialCommand, CredentialOutcome };
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const registry = new Map<string, CredentialMethod>();
export type CredentialMethod = Omit<CredentialDef, "provides"> & {
  plugin: string; kind: string;
  provides: { backends: string[]; commands: CredentialCommand[] };
  settings(): Record<string, string | number | boolean>;
  signal: AbortSignal;
};
const match = z.object({ subcommand: z.array(z.string().min(1)).min(1).optional(),
  args: z.array(z.string()).optional(), options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional() }).strict();
const outcome = z.object({ json: z.string().startsWith("$."), equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict();
const providesSchema = z.object({
  backends: z.array(z.string().min(1).max(100)).max(32).default([]),
  commands: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/),
    install: z.array(z.string().min(1).max(1024)).max(32).default([]),
    state: z.array(z.string().min(1).max(1024)).max(32).default([]),
    readOnly: z.array(match).max(64).optional(),
    resource: z.array(z.object({ match, key: z.string().min(1).max(1024) }).strict()).max(64).optional(),
    outcomes: z.object({ unauthenticated: z.array(outcome).optional(), expired: z.array(outcome).optional(),
      denied: z.array(outcome).optional(), applyUrl: z.string().startsWith("$.").optional() }).strict().optional(),
  }).strict()).max(32).default([]),
}).strict();
/** Declarations use the same canonical path restrictions as the machine-login sandbox. */
function stateRel(path: string) {
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || /[\x00-\x1f]/.test(path) || !path || path === "." || path.startsWith("~"))
    throw new Error("凭据状态目录必须相对 HOME，不能有 ..、反斜线或控制字符");
  return path;
}
export function declaredPaths(app: App, m: Pick<CredentialMethod, "provides">) {
  const home = canonical(homedir()), data = canonical(app.home);
  const state = m.provides.commands.flatMap(c => (c.state ?? []).map(p => join(home, stateRel(p))));
  const writable = normalizeSandbox({ mode: "off", writable: state, hidden: [] }, home, data).writable;
  const install = m.provides.commands.flatMap(c => c.install ?? []).map(p => {
    if (!(isAbsolute(p) || p.startsWith("~/"))) throw new Error("凭据安装目录需要绝对路径或 ~/ 开头");
    const path = canonical(p.startsWith("~/") ? join(home, p.slice(2)) : p);
    normalizeSandbox({ mode: "off", writable: [], hidden: [path] }, home, data);
    if (under(path, data)) throw new Error("凭据安装目录不能位于 omem 数据目录");
    return path;
  });
  return { state: writable, install };
}

export function registerCredential(plugin: string, def: CredentialDef, settings = () => ({} as Record<string, string | number | boolean>), app?: App) {
  if (!ID.test(def.id) || !def.name?.trim() || typeof def.login !== "function") throw new Error("凭据需要有效的 id、name 和 login");
  for (const name of ["refresh", "check", "logout", "provide", "precheck"] as const)
    if (def[name] !== undefined && typeof def[name] !== "function") throw new Error(`凭据 ${name} 需要回调函数`);
  const provides = providesSchema.parse(def.provides);
  for (const c of provides.commands) for (const p of c.state) stateRel(p);
  const kind = `${plugin}:${def.id}`;
  if (registry.has(kind)) throw new Error("凭据重复注册：" + kind);
  const lifetime = new AbortController();
  const m = { ...def, provides, kind, plugin, settings, signal: lifetime.signal };
  if (app) {
    declaredPaths(app, m);
    run(app.db, "insert into credential_kinds(kind,plugin,declaration) values(?,?,?) on conflict(kind) do update set declaration=excluded.declaration",
      kind, plugin, JSON.stringify({ id: def.id, name: def.name, describe: def.describe, required: !!def.required, provides }));
  }
  registry.set(kind, m);
  return () => { lifetime.abort(); if (registry.get(kind) === m) registry.delete(kind); };
}
export const credentialMethods = () => [...registry.values()];
export const credentialMethod = (kind: string) => registry.get(kind) ?? null;
export const credentialKindsForBackend = (backend: string) => credentialMethods().filter(m => m.provides.backends.includes(backend));
export function requireCredential(kind: string) {
  const m = credentialMethod(kind);
  if (!m) throw new HttpError(404, "凭据不可用：插件未启用或未信任，请在插件设置中选择在 omem 里运行");
  return m;
}
