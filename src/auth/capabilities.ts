import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { listRoles } from "./permissions.ts";

import { sectionNames, sections, type Section } from "./settings-sections.ts";

type SettingsCapability = `settings.${Section}.${"view" | "edit"}`;
const settingsDefinitions = Object.fromEntries(sections.flatMap(section =>
  (["view", "edit"] as const).map(action => [`settings.${section}.${action}`,
    ["global", `${action === "view" ? "查看" : "修改"}${sectionNames[section]}设置`, `${sectionNames[section]}区域的配置`]]))) as Record<SettingsCapability, ["global", string, string]>;

const definitions = {
  ...settingsDefinitions,
  "work.view": ["space", "看工作线", "看本人的工作线、变化和下一步"],
  "items.view": ["space", "看事项", "看共享空间里其他人的事项和进展"],
  "items.operate": ["space", "更新进展", "更新自己事项的状态和进展"],
  "items.edit": ["space", "改事项", "新建事项，编辑自己的事项内容、材料、业务对象和上级事项"],
  "sources.view": ["space", "看原件", "阅读有权访问的文档和其他原件"],
  "sources.edit": ["space", "改原件", "导入、标注、调整单份原件的关注程度及编辑可读原件"],
  "search.use": ["space", "检索", "在可读空间里搜索"],
  "wiki.view": ["space", "看知识页", "阅读空间的知识页"],
  "memories.view": ["space", "看记忆", "查看空间的记忆"],
  "requirements.view": ["space", "看需求", "阅读需求和测试结果"],
  "designs.view": ["space", "看方案", "阅读方案和决定"],
  "rules.view": ["global", "看规则", "查看全局规则和可读空间的规则"],
  "rules.edit": ["global", "改规则", "新建、编辑和删除规则"],
  "flows.view": ["space", "看流程", "查看流程定义、实例和看板"],
  "flows.operate": ["space", "推进流程", "推进自己的流程实例"],
  "runs.view": ["space", "看运行", "阅读可见范围内的运行记录"],
  "runs.operate": ["space", "操作运行", "停止或重试获准操作的运行，删除相应运行的产物"],
  "code.work.view": ["space", "看编码", "查看编码交办、各轮和修改项"],
  "code.review.view": ["space", "看评审", "查看评审问题和代码差异"],
  "conversations.view": ["global", "看自己的对话", "查看自己的对话记录"],
  "agents.view": ["global", "查看技能与助手档案", "列出和读取技能，查看 Agent 档案和 AI 后端选项"],
  "ask.send": ["global", "提问", "在自己的对话里向助手提问"],
  "notifications.view": ["global", "看通知", "阅读发给自己的通知"],
  "metrics.view": ["space", "看指标", "查看空间里的指标和变化"],
  "remote.view": ["global", "看远程会话", "看授权给他的远程会话"],
  "remote.operate": ["global", "操作远程会话", "操作授权给他的远程会话"],
  "settings.members": ["global", "管理成员权限", "修改成员的预设和能力覆盖"],
} as const;
export type Capability = keyof typeof definitions;
export const capabilityKeys = Object.keys(definitions) as Capability[];
export const isCapability = (key: string): key is Capability => Object.hasOwn(definitions, key);
export const globalCapability = (key: Capability) => definitions[key][0] === "global";
export const legacyCapabilities: Record<string, Capability[]> = {
  "space.read": ["sources.view", "search.use", "wiki.view", "memories.view", "requirements.view", "designs.view", "flows.view", "metrics.view"],
  "source.write": ["sources.edit"],
  "memory.write": ["items.edit", "items.operate", "flows.operate"],
  "agents.manage": ["rules.view", "rules.edit", "settings.assistant.view", "settings.assistant.edit", "settings.ai.view", "settings.ai.edit"],
  "settings.manage": ["settings.ai.view", "settings.ai.edit", "settings.channels.view", "settings.channels.edit",
    "settings.knowledge.view", "settings.knowledge.edit", "settings.system.view", "settings.system.edit"],
  "code.delegate": ["code.work.view", "code.review.view"],
  "runs.read": ["runs.view"],
  "runs.read.all": ["runs.view", "runs.operate"],
  "desktop.control": ["settings.channels.view"],
  "users.manage": ["settings.members"],
};
const personal: Capability[] = ["ask.send", "conversations.view", "notifications.view", "runs.operate"];
function presetGrants(role: string, permissions: string[], cap: Capability) {
  if (role === "owner") return true;
  if (cap === "agents.view") return role !== "observer";
  if (cap === "settings.members" && role === "admin") return true;
  if (cap === "remote.view" || cap === "remote.operate") return false;
  if (cap.startsWith("settings.") && cap !== "settings.members") return (cap === "settings.members.view" && (role === "admin" || permissions.includes("users.manage")))
    || permissions.some(p => legacyCapabilities[p]?.includes(cap));
  if (role === "observer") return cap.endsWith(".view") || cap === "ask.send" || cap === "search.use";
  return personal.includes(cap) || permissions.some(p => legacyCapabilities[p.replace(/@\*$/, "")]?.includes(cap));
}
export function capabilityCatalog(app: App) {
  const presets = listRoles(app, "global");
  return capabilityKeys.map(key => {
    const [scope, name, description] = definitions[key];
    const split = key.lastIndexOf(".");
    return { key, scope, name, description, area: key.slice(0, split), action: key === "settings.members" ? "manage" : key.slice(split + 1), presets: presets.filter(r => presetGrants(r.id, r.permissions, key)).map(r => r.id) };
  });
}
export type Override = { capability: Capability; scope_kind: "global" | "space"; scope_id: string; effect: "allow" | "deny" };
export function memberAccessProfile(app: App, userId: string) {
  const user = one<{ role: string; kind: string; active: number }>(app.db, "select role, kind, status='active' and disabled_at is null active from users where id=?", userId);
  const active = !!user?.active;
  return { preset: user?.role ?? "", kind: user?.kind, active,
    memberCredentials: active && user.kind === "person" && user.role !== "observer" };
}
/** Request-local snapshot. A null target requests only global capabilities. */
export function capabilityAccess(app: App, userId: string, targetSpace?: string | null) {
  const profile = memberAccessProfile(app, userId);
  const roles = new Map(listRoles(app).map(r => [r.id, r.permissions]));
  const { preset, active } = profile;
  const grants = roles.get(preset) ?? [];
  const overrides = all<Override>(app.db, "select capability,scope_kind,scope_id,effect from member_capability_overrides where user_id=? and revoked=0", userId);
  const spaces = targetSpace === null ? [] : all<{ id: string; kind: string; owner_id: string; mirror: number; parent_id: string }>(app.db,
    "select id,kind,owner_id,parent_id,json_extract(settings,'$.mirror') is not null mirror from spaces" + (targetSpace ? " where id=?" : ""), ...(targetSpace ? [targetSpace] : []));
  const memberships = new Map(targetSpace === null ? [] : all<{ space_id: string; role: string }>(app.db, "select space_id,role from space_members where user_id=?", userId).map(r => [r.space_id, roles.get(r.role === "owner" ? "manager" : r.role) ?? []]));
  const byId = new Map(spaces.map(s => [s.id, s]));
  const effects = new Map(overrides.map(o => [JSON.stringify([o.capability, o.scope_kind, o.scope_id]), o.effect]));
  const presetCaps = new Set(capabilityKeys.filter(c => presetGrants(preset, grants, c)));
  function source(cap: Capability, space?: string, own = false): string | null {
    if (!active) return null;
    if (byId.get(space ?? "")?.mirror && ["items.edit", "items.operate", "flows.operate", "sources.edit"].includes(cap)) return null;
    if (preset === "owner") return "preset";
    const local: string[] = [];
    if (!globalCapability(cap)) {
      const s = byId.get(space ?? "");
      if (!s || (s.kind === "personal" && s.owner_id !== userId)) return null;
      local.push(...memberships.get(s.id) ?? [], ...memberships.get(s.parent_id) ?? []);
      if (!grants.includes("space.read@*") && !local.includes("space.read")) return null;
    }
    const global = effects.get(JSON.stringify([cap, "global", ""]));
    const localEffect = space && effects.get(JSON.stringify([cap, "space", space]));
    if (global === "deny" || localEffect === "deny") return null;
    if (global === "allow" || localEffect === "allow") return "override";
    if (cap === "settings.members.view") {
      const manage = source("settings.members");
      if (manage) return manage;
    }
    if (presetCaps.has(cap) || (own && ["items.view", "runs.view"].includes(cap))) return "preset";
    // Personal spaces have an automatic manager membership, including for read-only observers.
    if (!(preset === "observer" && byId.get(space ?? "")?.kind === "personal") && local.some(p => legacyCapabilities[p]?.includes(cap))) return "spaceRole";
    return null;
  }
  const range = (cap: Capability, own = false) => active && preset === "owner" ? null : spaces.filter(s => source(cap, s.id, own)).map(s => s.id);
  return { ...profile, overrides, source, range, spaces };
}
export const spacesWithCapability = (app: App, userId: string, cap: Capability) => capabilityAccess(app, userId).range(cap);
export function memberCapabilities(app: App, userId: string) {
  const access = capabilityAccess(app, userId);
  const caps = capabilityKeys.filter(c => globalCapability(c) && access.source(c));
  const scoped = capabilityKeys.filter(c => !globalCapability(c));
  const spaceCaps = Object.fromEntries(scoped.map(c => [c, access.range(c) ?? "*"]));
  const ownSpaceCaps = Object.fromEntries((["items.view", "runs.view"] as const).map(c => [c, access.range(c, true) ?? "*"]));
  const effective = Object.fromEntries(capabilityKeys.map(c => [c, globalCapability(c) ? access.source(c) : Object.fromEntries(access.spaces.flatMap(s => {
    const from = access.source(c, s.id);
    return from ? [[s.id, from]] : [];
  }))]));
  return { preset: access.preset, spaceRoleGrants: access.preset === "observer" ? "catalogOnly" : "legacyAndCatalog", overrides: access.overrides, caps, spaceCaps, ownSpaceCaps, effective };
}
