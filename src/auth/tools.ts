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
  git: "code.delegate",
  "lark-capture": "settings.manage",
  notifications: "agents.manage",
};
const BY_TOOL: Record<string, GlobalPerm> = {
  save_skill: "agents.manage",
  save_agent: "agents.manage",
  propose_profile_change: "agents.manage",
  save_rule: "agents.manage",
  list_rules: "agents.manage",
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

export function toolAllowed(app: App, userId: string | undefined | null, name: string) {
  const perm = toolPermission(name);
  return !perm || !userId || isOwner(app, userId) || can(app, userId, perm);
}

/** Take out of a run's tools what its user may not use. */
export function trimTools(app: App, userId: string, tools: Set<string>) {
  if (isOwner(app, userId)) return;
  for (const t of [...tools]) if (!toolAllowed(app, userId, t)) tools.delete(t);
}
