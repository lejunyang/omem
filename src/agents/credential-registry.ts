import { homedir } from "node:os";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import { z } from "zod";
import type { CredentialDef, CredentialContext, CredentialCommand, CredentialOutcome } from "../../packages/plugin-sdk/credential.ts";
import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { cachePaths, canonical, normalizeSandbox, under } from "./own-sandbox.ts";
import { setBackendStateCheck } from "./sandbox.ts";
import { commandNameSchema, configuredCommandsForHome, loginEnvSchema } from "../core/protected-commands.ts";

export type { CredentialDef, CredentialContext, CredentialCommand, CredentialOutcome };
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const registry = new Map<string, CredentialMethod>();
export type CredentialMethod = Omit<CredentialDef, "provides"> & {
  plugin: string; kind: string;
  provides: { backends: string[]; commands: CredentialCommand[] };
  settings(): Record<string, string | number | boolean | string[]>;
  signal: AbortSignal;
};
const match = z.object({ subcommand: z.array(z.string().min(1)).min(1).optional(),
  args: z.array(z.string()).optional(), options: z.record(z.string(), z.union([z.string(), z.boolean()])).optional() }).strict();
const outcome = z.object({ json: z.string().startsWith("$."), equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict();
const providesSchema = z.object({
  backends: z.array(z.string().min(1).max(100)).max(32).default([]),
  commands: z.array(z.object({
    name: commandNameSchema,
    subcommand: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
    install: z.array(z.string().min(1).max(1024)).max(32).default([]),
    state: z.array(z.string().min(1).max(1024)).max(32).default([]),
    loginEnv: loginEnvSchema.optional(),
    judge: z.custom<NonNullable<CredentialCommand["judge"]>>(v => typeof v === "function").optional(),
    readOnly: z.array(match).max(256).optional(),
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
function containsDirectory(parent: string, child: string) {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}
export function declaredPaths(app: App, commands: CredentialCommand[]) {
  const home = process.platform === "win32" ? homedir() : canonical(homedir());
  const state = commands.flatMap(c => (c.state ?? []).map(p => join(home, stateRel(p))));
  const caches = cachePaths.map(rel => join(home, rel));
  for (const path of state) {
    const login = canonical(path);
    if (caches.some(cache => containsDirectory(path, cache) || containsDirectory(login, canonical(cache)))) throw new Error("登录路径不能覆盖缓存目录：" + path);
  }
  // Windows starts no sandbox. The POSIX mount checks below would reject every path there.
  if (process.platform === "win32") {
    const install = commands.flatMap(c => c.install ?? []).map(p => {
      if (p.split("/").includes("..")) throw new Error("安装目录不能包含 ..");
      if (!(isAbsolute(p) || p.startsWith("~/"))) throw new Error("凭据安装目录需要绝对路径或 ~/ 开头");
      return { declared: p, path: p.startsWith("~/") ? join(home, p.slice(2)) : p };
    });
    return { state, install };
  }
  const data = canonical(app.home);
  const writable = normalizeSandbox({ mode: "off", writable: state, hidden: [] }, home, data).writable;
  if (writable.some(p => !under(p, home))) throw new Error("凭据状态目录必须位于 HOME 内");
  const install = commands.flatMap(c => c.install ?? []).map(p => {
    if (p.split("/").includes("..")) throw new Error("安装目录不能包含 ..");
    if (!(isAbsolute(p) || p.startsWith("~/"))) throw new Error("凭据安装目录需要绝对路径或 ~/ 开头");
    const path = canonical(p.startsWith("~/") ? join(home, p.slice(2)) : p);
    if (p.startsWith("~/") && !under(path, home)) throw new Error("HOME 中的安装目录不能指向 HOME 外");
    normalizeSandbox({ mode: "off", writable: [], hidden: [path] }, home, data);
    if (under(path, data)) throw new Error("凭据安装目录不能位于 omem 数据目录");
    return { declared: p, path };
  });
  return { state: writable, install };
}

/** Owner declarations protect commands without creating a credential provider or lending login. */
export function commandDeclarations(configured: CredentialCommand[] = []): CredentialCommand[] {
  return [...credentialMethods().flatMap(method => method.provides.commands), ...configured];
}

/** The backend starts its own tools in the same mount namespace. Check only when starting a sandbox. */
export function checkBackendCommandState(backend: string, home: string, backendPaths: string[]) {
  const paths = [...new Set(backendPaths.map(canonical))];
  for (const command of commandDeclarations(configuredCommandsForHome(home))) {
    for (const rel of command.state ?? []) {
      const login = canonical(join(home, rel));
      const conflict = paths.find(path => under(path, login) || under(login, path));
      if (conflict) throw new Error(
        `后端 ${backend} 的状态路径 ${conflict} 与命令 ${command.name} 的登录路径 ~/${rel} 重合。后端和工具共用文件视图，已拒绝启动沙箱。请为后端和命令分别供给独立凭据并分开目录，或改用其他后端。`,
      );
    }
  }
}

setBackendStateCheck(checkBackendCommandState);

export const defaultSharingScope = (id: string) => id === OWNER ? "all" : "self";

export function registerCredential(plugin: string, def: CredentialDef, settings = () => ({} as Record<string, string | number | boolean | string[]>), app?: App) {
  if (!ID.test(def.id) || !def.name?.trim() || typeof def.login !== "function") throw new Error("凭据需要有效的 id、name 和 login");
  for (const name of ["ownerLogin", "refresh", "check", "logout", "provide", "precheck"] as const)
    if (def[name] !== undefined && typeof def[name] !== "function") throw new Error(`凭据 ${name} 需要回调函数`);
  const provides = providesSchema.parse(def.provides);
  for (const [i, c] of provides.commands.entries()) {
    for (const p of c.state) stateRel(p);
    // Zod objects enumerate fields in schema order. Outcome precedence belongs to the declaration.
    if (c.outcomes) {
      const validated = c.outcomes;
      const keys = Object.keys(def.provides.commands![i]!.outcomes!) as (keyof typeof validated)[];
      c.outcomes = Object.fromEntries(keys.map(key => [key, validated[key]]));
    }
  }
  const kind = `${plugin}:${def.id}`;
  if (registry.has(kind)) throw new Error("凭据重复注册：" + kind);
  const lifetime = new AbortController();
  const m = { ...def, provides, kind, plugin, settings, signal: lifetime.signal };
  if (app) {
    declaredPaths(app, m.provides.commands);
    run(app.db, "insert into credential_kinds(kind,plugin,declaration) values(?,?,?) on conflict(kind) do update set declaration=excluded.declaration",
      kind, plugin, JSON.stringify({ id: def.id, name: def.name, describe: def.describe, required: !!def.required, provides }));
    // Registered again (new code, trust given again): the owner's last check is stale, check on the next tick.
    run(app.db, `insert into credential_holds(user_id,kind,sharing) values(?,?,?)
      on conflict(user_id,kind) do update set check_day=''`, OWNER, kind, JSON.stringify({ scope: defaultSharingScope(OWNER), members: [] }));
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
