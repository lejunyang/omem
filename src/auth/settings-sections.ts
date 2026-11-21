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
  "agents.cloudTools": "security", "agents.ownSandbox": "security", "agents.fullAccess": "security",
};

// Identity, credentials, command execution and network destinations stay under the owner's control.
export const ownerControls: Record<string, string[]> = {
  "mentions.reply": [
    "GET /api/lark/doubao-send",
    "POST /api/lark/doubao-send/test",
  ],
  "lark.commands": [],
  "lark.invite": [],
  "lark.guests": [],
  "lark.bots": [],
  "lark.ownerOpenId": [],
  "lark.appSecretEnv": [],
  "lark.appId": [],
  "lark.capture": [],
  "lark.defaultSpace": [],
  "telegram": [],
  "onebot": [],
  "security": [
    "GET /api/security/egress",
    "PUT /api/security/egress",
    "GET /api/security/operation-rules",
    "GET /api/security/rule-packs",
    "POST /api/security/rule-packs/:id/enable",
    "POST /api/security/rule-packs/:id/disable",
    "PUT /api/security/operation-rules",
    "GET /api/security/command-rules",
    "PUT /api/security/command-rules",
  ],
  "approvals": [],
  "agents.accounts": [
    "GET /api/agent-accounts",
    "PUT /api/agent-accounts/:backend/policy",
    "DELETE /api/agent-accounts/:user/:backend",
  ],
  "agents.accountIsolation": [],
  "agents.networkPolicies": [
    "GET /api/agents/network-policies",
    "PUT /api/agents/network-policies",
    "POST /api/agents/network-policies/:id/check",
  ],
  "agents.profiles": [
    "POST /api/agent-registry/:id",
    "POST /api/agents/:id/adapter/upgrade",
    "POST /api/agents/:id/probe",
  ],
  "agents.cloudTools": [
    "POST /api/cloud-tools/revoke",
    "GET /api/cloud-tools",
    "POST /api/cloud-tools/probe",
    "POST /api/cloud-tools/probe/confirm",
  ],
  "agents.ownSandbox": [
    "GET /api/security/sandbox",
    "PUT /api/security/sandbox",
  ],
  "agents.fullAccess": [],
  "ai.providers": [
    "PUT /api/ai/keys/:id",
    "POST /api/ai/providers/:id/test",
  ],
  "host": [],
  "port": [],
  "token": [],
  "https": [],
  "webUrl": [],
  "remoteGrants": [],
  "shares.expiryDays": [],
  "auth": [
    "PUT /api/auth/providers/:id/app",
    "POST /api/lark/user-permissions",
    "POST /api/lark/bot-check/:ref/scan",
  ],
  "node": [
    "GET /api/diag",
    "GET /api/peer/commands",
    "POST /api/peer/exec",
    "GET /api/peer/tools",
    "POST /api/peer/tool",
    "GET /api/peer/snapshot",
    "GET /api/peer/files",
    "POST /api/peer/files",
    "POST /api/peer/agents",
    "POST /api/peer/unpair",
    "DELETE /api/peer/paired/:id",
    "GET /api/peer/outbox",
    "POST /api/peer/outbox/flush",
    "DELETE /api/peer/outbox/:id",
    "POST /api/peer/shares",
    "PUT /api/peer/shares/:user",
    "DELETE /api/peer/shares/:user",
    "POST /api/peer/subscriptions",
    "DELETE /api/peer/subscriptions/:id",
    "POST /api/peer/subscriptions/:id/sync",
    "POST /api/peer/trial",
    "GET /api/peer/trial/:id",
    "POST /api/peer/trial/:id/cancel",
    "GET /api/peers",
    "POST /api/peer/invite",
    "POST /api/peer/add",
    "PATCH /api/peers/:id",
    "POST /api/peers/:id/back",
    "DELETE /api/peers/:id",
    "GET /api/peers/:id/status",
    "GET /api/peers/:id/api/ide/open",
    "* /api/peers/:id/*",
    "* /api/peers/:id/ide",
    "* /api/peers/:id/ide/*",
    "* /api/peers/:id/remote/*",
    "GET /api/peer/shares",
    "PUT /api/peer/grants/:user",
    "GET /api/peer/cards",
    "GET /api/peer/subscriptions",
    "GET /api/peer/offers/:peer",
  ],
  "backups": [
    "GET /api/peer/backups",
    "PUT /api/peer/backups",
    "DELETE /api/peer/backups/:peer",
    "POST /api/peer/backups/:peer/run",
  ],
  "studies.envs": [],
  "ide": [],
  "notify.outlets": [],
  "notify.outletAskGrants": [],
  "documents.converter": [],
  "embeddings.url": [],
  "embeddings.apiKeyEnv": [],
  "mcp": [
    "GET /api/library-files/agent/:name",
    "PUT /api/library-files/agent/:name",
    "GET /api/mcp",
    "PUT /api/mcp/:name",
    "DELETE /api/mcp/:name",
    "POST /api/mcp/:name/test",
    "PUT /api/roles/:name/mcp",
  ],
  "agentSkills": [],
  "plugins": [
    "POST /api/plugins/install",
    "POST /api/plugins/:id/update",
    "DELETE /api/plugins/:id",
    "POST /api/plugins/:id/trust",
    "DELETE /api/plugins/:id/trust",
    "PUT /api/plugins/:id/enabled",
    "POST /api/plugins/:id/hooks/:name/secret",
    "DELETE /api/plugins/:id/hooks/:name/secret",
    "POST /api/plugins/:id/services/:name/start",
    "POST /api/plugins/:id/services/:name/stop",
  ],
  "guard.modelDir": [],
  "guard.url": [],
  "documents.doclingArtifacts": [],
  "embeddings.model": [],
  "rerank.model": [],
  "lark.knowledge": [],
};
export const ownerSettings = Object.keys(ownerControls);
const publicOwnerFields = new Set(["shares.expiryDays", "lark.defaultSpace", "port", "agents.accountIsolation", "auth", "mentions.reply", "lark.guests", "lark.commands", "lark.invite"]);
const splitRoots = new Set([...Object.keys(sectionByPath), ...ownerSettings].filter(p => p.includes(".")).map(p => p.split(".")[0]));
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
    if (visible(sectionOf(path)) && path !== "token" && (owner || !ownerSettings.includes(path) || publicOwnerFields.has(path))) assign(result, path, value);
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
    if (!owner && (!editable(section) || ownerSettings.includes(path))) throw new HttpError(403, `没有修改设置 ${path} 的权限`);
    (changes[section] ??= []).push(path);
  }
  return changes;
}
