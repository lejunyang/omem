import { capabilityAccess, globalCapability, type Capability } from "./capabilities.ts";
import type { App } from "../core/app.ts";
import { TOOL_GROUPS } from "../agents/tool-help.ts";
import { can, isOwner, type GlobalPerm } from "./permissions.ts";

/**
 * Agent tools that need a global permission of whoever the run works for (docs/v2/multi-user.md,
 * “在哪里检查”). Space permissions are the tools' own business (scopeFor / canWrite / wiki.write);
 * these are the ones that act on the whole machine or the shared setup. A run's tool list leaves out
 * what its user may not do (so the agent does not keep trying), and a call is refused anyway.
 */
const BY_GROUP: Record<string, GlobalPerm> = {
  coding: "code.delegate",
  improve: "code.delegate",
  git: "code.delegate",
  "lark-capture": "settings.manage",
  notifications: "agents.manage",
};
const BY_TOOL: Record<string, GlobalPerm> = {
  save_flow: "agents.manage",
  save_skill: "agents.manage",
  save_agent: "agents.manage",
  propose_profile_change: "agents.manage",
  attention_rules: "agents.manage",
  propose_archive_rule: "agents.manage",
  digest_sources: "agents.manage",
  lark_wiki_crawl: "settings.manage",
  connect_repository: "code.delegate",
  create_space: "spaces.create",
};

/** The global permission a tool needs, if any. */
export function toolPermission(name: string): GlobalPerm | null {
  if (BY_TOOL[name]) return BY_TOOL[name];
  const group = TOOL_GROUPS.find((g) => g.tools.includes(name));
  return (group && BY_GROUP[group.id]) || null;
}

export const toolCapabilities: Record<string, Capability> = {
  ask_user: "ask.send", wait_answer: "ask.send", list_rules: "rules.view", save_rule: "rules.edit", list_items: "items.view", read_item: "items.view",
  list_flows: "flows.view", upsert_item: "items.edit", search: "search.use", read_source: "sources.view",
  list_pages: "wiki.view", read_page: "wiki.view", recall: "memories.view", req_read: "requirements.view", req_tree: "requirements.view",
};
function allowed(app: App, userId: string, name: string, access: ReturnType<typeof capabilityAccess>) {
  const cap = toolCapabilities[name];
  if (cap) {
    if (globalCapability(cap)) return !!access.source(cap);
    return access.range(cap, cap === "items.view")?.length !== 0 || (name === "upsert_item" && access.range("items.operate")?.length !== 0);
  }
  if (access.preset === "observer") return name === "list_spaces";
  const perm = toolPermission(name);
  return !perm || can(app, userId, perm);
}

export function toolAllowed(app: App, userId: string | undefined | null, name: string) {
  return !userId || isOwner(app, userId) || allowed(app, userId, name, capabilityAccess(app, userId));
}

export function trimTools(app: App, userId: string, tools: Set<string>) {
  if (isOwner(app, userId)) return;
  const access = capabilityAccess(app, userId);
  for (const t of tools) if (!allowed(app, userId, t, access)) tools.delete(t);
}
