import type { PluginObject } from "./types.ts";

/** Both in-process definitions and IPC proxies use this registry. */
export type RegisteredObject = Omit<PluginObject, "match"> & { plugin: string; match(url: string): string | null | Promise<string | null> };
const objects = new Map<string, RegisteredObject>();
export function validateObject(def: Pick<PluginObject, "kind" | "label" | "statuses" | "final" | "poll">) {
  if (!/^[a-z][a-z0-9-]*$/.test(def.kind)) throw new Error(`对象 kind 不合法：${def.kind}`);
  if (!def.label?.trim() || !def.statuses || !Object.keys(def.statuses).length || Object.values(def.statuses).some((s) => typeof s !== "string" || !s.trim())) throw new Error("对象 statuses 不能为空，状态要有名称");
  if (!Array.isArray(def.final) || def.final.some((s) => !Object.hasOwn(def.statuses, s))) throw new Error("对象 final 必须都在 statuses 里");
  if (def.poll && (!Number.isFinite(def.poll.minutes) || def.poll.minutes < 1)) throw new Error("对象 poll.minutes 最短 1 分钟");
}
export function registerObject(plugin: string, def: Omit<RegisteredObject, "plugin">) {
  validateObject(def);
  const kind = `${plugin}:${def.kind}`;
  if (objects.has(kind)) throw new Error(`对象类型重复注册：${kind}`);
  if (typeof def.match !== "function" || typeof def.read !== "function") throw new Error("对象需要 match 和 read");
  const entry = { ...def, statuses: { ...def.statuses }, final: [...def.final], plugin, kind, poll: { minutes: def.poll?.minutes ?? 5 } };
  objects.set(kind, entry);
  return () => { if (objects.get(kind) === entry) objects.delete(kind); };
}
export const pluginObjectKind = (kind: string) => objects.get(kind);
export const pluginObjectKinds = () => [...objects.values()];
