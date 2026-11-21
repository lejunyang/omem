import { capabilityAccess, globalCapability, type Capability } from "./capabilities.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import type { App } from "../core/app.ts";
import { TOOL_GROUPS } from "../agents/tool-help.ts";
import { can, spacesWith, type GlobalPerm, type SpacePerm } from "./permissions.ts";

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

const toolCapabilities: Record<string, Capability | "memory.write" | "wiki.write"> = {
  scan: "search.use", find_symbol: "search.use", source_outline: "sources.view", list_sources: "sources.view",
  write_file: "sources.edit", save_note: "sources.edit", import_url: "sources.edit", annotate_source: "sources.edit", set_source_attention: "sources.edit",
  describe_source: "sources.edit", review_notes: "sources.edit",
  attach_object: "items.edit",
  list_memory_folders: "memories.view", remember: "memory.write", supersede: "memory.write", forget: "memory.write",
  review_memories: "memory.write", organize_memories: "memory.write",
  write_page: "wiki.write", correct_page: "wiki.write", move_page: "wiki.write", confirm_page: "wiki.write", generate_wiki: "wiki.write",
  save_requirements: "memory.write", split_requirements: "memory.write",
  read_design: "designs.view", assess_design: "memory.write", settle_design: "memory.write",
  list_conversations: "conversations.view", read_conversation: "conversations.view",
  list_runs: "runs.view", read_run: "runs.view",
  metric_read: "metrics.view", metric_define: "memory.write", metric_record: "memory.write",
  read_flow_reviews: "flows.view", flow_start: "flows.operate", stage_report: "flows.operate", stage_reopen: "flows.operate",
  switch_run_ai: "runs.operate", take_over_run: "runs.operate",
  ask_user: "ask.send", wait_answer: "ask.send", list_rules: "rules.view", save_rule: "rules.edit", list_items: "items.view", read_item: "items.view",
  list_flows: "flows.view", upsert_item: "items.edit", search: "search.use", read_source: "sources.view",
  list_pages: "wiki.view", read_page: "wiki.view", recall: "memories.view", req_read: "requirements.view", req_tree: "requirements.view",
};

type ToolScope = { spaces: string[] | null; writable?: string[] };
const ownerOnlyTools = new Set(["add_users", "attention_rules", "save_flow", "lark_invite", "track_problem", "revise_reply_outcome", "classify_source"]);
const unrestricted: ToolScope = { spaces: null };

/** One permission snapshot per call or directory listing. */
export function memberToolAccess(app: App, userId: string, scope: ToolScope = unrestricted) {
  const access = capabilityAccess(app, userId);
  const spaces = scopeFor(app, userId, scope.spaces);
  const allowedScope = { spaces, writable: scope.writable?.filter(id => !spaces || spaces.includes(id)) };
  const writableInRun = (ids: string[]) => ids.filter(id => (!spaces || spaces.includes(id)) && (!scope.writable || scope.writable.includes(id)));
  const legacy = new Map<SpacePerm, string[]>();
  return (name: string): ToolScope | null => {
    if (!access.active) return null;
    if (ownerOnlyTools.has(name) && userId !== OWNER) return null;
    if (["create_space", "connect_repository"].includes(name) && (scope.spaces !== null || access.preset !== "owner")) return null;
    if (access.preset === "owner") return scope;
    const cap = toolCapabilities[name];
    if (!cap) {
      if (access.preset === "observer") return name === "list_spaces" ? allowedScope : null;
      const perm = toolPermission(name);
      return !perm || can(app, userId, perm) ? allowedScope : null;
    }
    if (cap === "memory.write" || cap === "wiki.write") {
      if (!legacy.has(cap)) legacy.set(cap, writableInRun(spacesWith(app, userId, cap) ?? []));
      const writable = legacy.get(cap)!;
      return writable.length ? { ...allowedScope, writable } : null;
    }
    if (globalCapability(cap)) return access.source(cap) ? allowedScope : null;
    const write = cap.endsWith(".edit") || cap.endsWith(".operate");
    const own = cap === "items.view" || cap === "runs.view";
    const capable = access.spaces.filter(s => (!scope.spaces || scope.spaces.includes(s.id)) &&
      (name !== "find_symbol" || access.source("sources.view", s.id)) &&
      (access.source(cap, s.id, own) || (name === "upsert_item" && access.source("items.operate", s.id)))).map(s => s.id);
    if (write) {
      const writable = writableInRun(capable);
      return writable.length ? { ...allowedScope, writable } : null;
    }
    return capable.length ? { ...allowedScope, spaces: capable } : null;
  };
}

export function toolAllowed(app: App, userId: string | undefined | null, name: string) {
  return !!memberToolAccess(app, userId ?? OWNER)(name);
}

export function trimTools(app: App, userId: string, tools: Set<string>, scope?: ToolScope) {
  const allowed = memberToolAccess(app, userId, scope);
  for (const name of tools) if (!allowed(name)) tools.delete(name);
}
