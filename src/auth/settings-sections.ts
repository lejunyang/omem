import { isDeepStrictEqual } from "node:util";
import type { Config } from "../core/config.ts";
import { HttpError } from "../core/util.ts";

export const sectionNames = {
  knowledge: "知识", assistant: "助手", ai: "AI", channels: "渠道与协作",
  members: "成员", security: "安全", system: "系统",
} as const;
export type Section = keyof typeof sectionNames;
export const sections = Object.keys(sectionNames) as Section[];
export const settingSections = {
  host: "system", port: "system", token: "security", webUrl: "channels", https: "system",
  plugins: "ai", remoteGrants: "channels", shares: "channels", auth: "members", timezone: "assistant",
  language: "system", concurrency: "ai", interactiveConcurrency: "ai", dream: "assistant", sessions: "ai",
  agents: "ai", review: "assistant", approvals: "security", asks: "assistant", archive: "knowledge",
  security: "security", ide: "system", preview: "system", node: "channels", backups: "channels",
  wiki: "knowledge", replies: "assistant", notes: "knowledge", memory: "knowledge", embeddings: "knowledge",
  search: "knowledge", rerank: "knowledge", documents: "knowledge", ai: "ai", guard: "security",
  lark: "channels", telegram: "channels", mentions: "assistant", notify: "assistant", mcp: "ai",
  quality: "assistant", heartbeat: "assistant", feedback: "assistant", agentSkills: "ai",
  replay: "assistant", items: "assistant", studies: "assistant", flows: "assistant", workLines: "assistant",
  workState: "assistant", media: "knowledge", onebot: "channels",
} satisfies Record<keyof Config, Section>;
export const sectionByPath: Record<string, Section> = {
  ...settingSections, "agents.accounts": "members", "agents.accountIsolation": "members",
  "agents.progress": "assistant", "agents.design": "assistant", "agents.autoAdvance": "assistant",
  "agents.workBoard": "assistant", "lark.capture": "knowledge", "lark.knowledge": "knowledge",
  "lark.commands": "assistant", "lark.guests": "assistant", "lark.invite": "assistant",
  "agents.cloudTools": "security",
};

// Identity, credentials, command execution and network destinations stay under the owner's control.
export const ownerSettings = [
  "mentions.reply", "lark.commands", "lark.invite", "lark.guests", "lark.bots", "lark.ownerOpenId",
  "lark.appSecretEnv", "lark.appId", "lark.capture", "lark.defaultSpace", "telegram", "onebot", "security", "approvals",
  "agents.accounts", "agents.accountIsolation", "agents.networkPolicies", "agents.profiles", "agents.cloudTools", "ai.providers",
  "host", "port", "token", "https", "webUrl", "shares.expiryDays", "auth", "node", "backups", "studies.envs", "ide",
  "documents.converter", "embeddings", "rerank", "mcp", "agentSkills", "plugins",
];
const privatePaths = new Set(["agents.profiles", "agents.networkPolicies", "mcp", "ai.providers"]);
const splitRoots = new Set([...Object.keys(sectionByPath), ...ownerSettings, "embeddings.provider"].filter(p => p.includes(".")).map(p => p.split(".")[0]));
type Values = Record<string, unknown>;
const object = (v: unknown): v is Values => !!v && typeof v === "object" && !Array.isArray(v);
const sectionOf = (path: string) => sectionByPath[path] ?? sectionByPath[path.split(".")[0]];
function entries(values: Values): [string, unknown][] {
  return Object.entries(values).flatMap(([key, val]): [string, unknown][] => splitRoots.has(key) && object(val)
    ? Object.entries(val).map(([child, v]) => [key + "." + child, v]) : [[key, val]]);
}
function assign(values: Values, path: string, value: unknown) {
  const [key, child] = path.split(".");
  if (!child) values[key] = value;
  else values[key] = { ...(values[key] as Values), [child]: value };
}
export function settingsView(config: Config, visible: (s: Section) => boolean, owner: boolean) {
  const result: Values = {};
  for (const [path, value] of entries(config)) {
    if (visible(sectionOf(path)) && path !== "token" && (owner || !privatePaths.has(path))) assign(result, path, value);
  }
  return result;
}
export function settingsPatch(config: Config, body: unknown): Values {
  if (!object(body)) throw new HttpError(400, "设置必须是对象");
  const result = { ...config };
  for (const [key, val] of Object.entries(body)) {
    if (!Object.hasOwn(settingSections, key)) throw new HttpError(400, `不认识的设置：${key}`);
    if (splitRoots.has(key) && object(val)) Object.assign(result, { [key]: { ...(config[key as keyof Config] as Values), ...val } });
    else Object.assign(result, { [key]: val });
  }
  return result;
}
export function changedSettings(before: Config, after: Config, editable: (s: Section) => boolean, owner: boolean) {
  const old = new Map(entries(before)), next = new Map(entries(after));
  const changes: Partial<Record<Section, string[]>> = {};
  for (const path of new Set([...old.keys(), ...next.keys()])) {
    if (isDeepStrictEqual(old.get(path), next.get(path))) continue;
    const section = sectionOf(path);
    if (!owner && (!editable(section) || (ownerSettings.includes(path) || ownerSettings.includes(path.split(".")[0])))) throw new HttpError(403, `没有修改设置 ${path} 的权限`);
    (changes[section] ??= []).push(path);
  }
  return changes;
}
