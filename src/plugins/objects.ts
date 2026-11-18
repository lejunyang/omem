import type { PluginObject, PluginObjectAction } from "./types.ts";
import type { ToolContext } from "../agents/tools.ts";

/** Both in-process definitions and IPC proxies use this registry. */
export type RegisteredObject = Omit<PluginObject, "match"> & { plugin: string; match(url: string): string | null | Promise<string | null> };
const objects = new Map<string, RegisteredObject>();
export function validateObject(def: Pick<PluginObject, "kind" | "label" | "statuses" | "final" | "poll" | "actions">) {
  if (!/^[a-z][a-z0-9-]*$/.test(def.kind)) throw new Error(`对象 kind 不合法：${def.kind}`);
  if (def.statuses && Object.hasOwn(def.statuses, "updated")) throw new Error("对象状态不能叫 updated：它留给“有更新”（修订变了）");
  if (!def.label?.trim() || !def.statuses || !Object.keys(def.statuses).length || Object.values(def.statuses).some((s) => typeof s !== "string" || !s.trim())) throw new Error("对象 statuses 不能为空，状态要有名称");
  if (!Array.isArray(def.final) || def.final.some((s) => !Object.hasOwn(def.statuses, s))) throw new Error("对象 final 必须都在 statuses 里");
  if (def.poll && (!Number.isFinite(def.poll.minutes) || def.poll.minutes < 1)) throw new Error("对象 poll.minutes 最短 1 分钟");
  if (def.actions !== undefined && !Array.isArray(def.actions)) throw new Error("对象 actions 要是数组");
  const ids = new Set<string>();
  for (const a of def.actions ?? []) {
    if (!a || typeof a.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(a.id)) throw new Error(`对象动作 id 不合法：${a?.id}`);
    if (ids.has(a.id)) throw new Error(`对象动作重复：${a.id}`);
    ids.add(a.id);
    if (typeof a.label !== "string" || !a.label.trim() || a.label.length > 20) throw new Error(`对象动作 ${a.id} 要有 20 字以内的名称`);
    if (typeof a.tool !== "string" || !a.tool) throw new Error(`对象动作 ${a.id} 要写对应的工具`);
    if (a.arg !== undefined && (typeof a.arg !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(a.arg))) throw new Error(`对象动作 ${a.id} 的 arg 不合法`);
    if (a.statuses !== undefined && (!Array.isArray(a.statuses) || a.statuses.some((s) => !Object.hasOwn(def.statuses, s)))) throw new Error(`对象动作 ${a.id} 的 statuses 必须都在 statuses 里`);
    if (a.confirm !== undefined && (typeof a.confirm !== "string" || a.confirm.length > 300)) throw new Error(`对象动作 ${a.id} 的 confirm 最多 300 字`);
  }
}
export function registerObject(plugin: string, def: Omit<RegisteredObject, "plugin">) {
  validateObject(def);
  const kind = `${plugin}:${def.kind}`;
  if (objects.has(kind)) throw new Error(`对象类型重复注册：${kind}`);
  if (typeof def.match !== "function" || typeof def.read !== "function") throw new Error("对象需要 match 和 read");
  // An action is one of this plugin's own tools: a button never reaches another plugin's code.
  for (const a of def.actions ?? []) if (!a.tool.startsWith(`${plugin}_`)) throw new Error(`对象动作 ${a.id} 的工具要是本插件的（以 ${plugin}_ 开头）：${a.tool}`);
  const actions = (def.actions ?? []).map((a): PluginObjectAction => ({ id: a.id, label: a.label.trim(), tool: a.tool, ...(a.arg ? { arg: a.arg } : {}), ...(a.statuses ? { statuses: [...a.statuses] } : {}), ...(a.confirm ? { confirm: a.confirm } : {}) }));
  const entry = { ...def, statuses: { ...def.statuses }, final: [...def.final], actions, plugin, kind, poll: { minutes: def.poll?.minutes ?? 5 } };
  objects.set(kind, entry);
  return () => { if (objects.get(kind) === entry) objects.delete(kind); };
}
export const pluginObjectKind = (kind: string) => objects.get(kind);
export const pluginObjectKinds = () => [...objects.values()];

/** The object kind and action a plugin tool stands for, if any (the first kind declaring it). */
export function objectActionOf(plugin: string, tool: string): { def: RegisteredObject; action: PluginObjectAction } | null {
  for (const def of objects.values()) {
    if (def.plugin !== plugin) continue;
    const action = def.actions?.find((a) => a.tool === tool);
    if (action) return { def, action };
  }
  return null;
}

/**
 * A plugin tool's handler, as the host registers it: when the tool is an object action, every call
 * (a button on the item page, an agent's call, an approved call running later) is written to
 * audit_events and the object is read again right after (src/flows/object-actions.ts). Which
 * tools are actions is looked up at call time, so an object declared after its tool still counts.
 */
export function withObjectActions(plugin: string, tool: string, handler: (ctx: ToolContext, args: Record<string, unknown>) => string | Promise<string>) {
  return async (ctx: ToolContext, args: Record<string, unknown>) => {
    const found = objectActionOf(plugin, tool);
    if (!found) return handler(ctx, args);
    const { actionTarget, afterAction } = await import("../flows/object-actions.ts");
    const target = await actionTarget(ctx, found.def, found.action, args);
    let text = "";
    let error: unknown = null;
    try {
      text = String(await handler(ctx, args));
    } catch (e) {
      error = e;
    }
    const note = await afterAction(ctx, found.def, found.action, target, error ? { ok: false, text: (error as Error).message ?? String(error) } : { ok: true, text });
    if (error) throw error;
    return text + note;
  };
}
