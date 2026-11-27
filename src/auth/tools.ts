import { capabilityAccess, globalCapability, isCapability } from "./capabilities.ts";
import { OWNER, scopeFor } from "../core/users.ts";
import type { App } from "../core/app.ts";
import { TOOL_GROUPS, type ToolCapability } from "../agents/tool-help.ts";
import { can, spacesWith, type GlobalPerm, type SpacePerm } from "./permissions.ts";

/** Exceptions to the capability declared on each tool group. */
const toolCapabilities: Record<string, ToolCapability> = {
  // Asking a member for the owner (items/member-progress.ts): only the owner's runs, the handler checks again.
  ask_member_progress: "owner",
  add_users: "owner", attention_rules: "owner", save_flow: "owner", lark_invite: "owner",
  lark_read: "connector.use", lark_doc_authorize: "owner",
  track_problem: "owner", revise_reply_outcome: "owner", classify_source: "owner",
  create_space: "owner", connect_repository: "owner", propose_archive_rule: "agents.manage",
  digest_sources: "agents.manage", lark_wiki_crawl: "settings.manage",
  list_skills: "agents.view", read_skill: "agents.view", list_agents: "agents.view", list_ai_backends: "agents.view",
  run_agent: "runs.operate", ask_agent: "runs.operate", dispatch_work: "runs.operate", work_cancel: "runs.operate",
  work_review: "runs.operate", work_status: "runs.view", list_item_proposals: "items.view",
  propose_item_update: "memory.write", resolve_item_proposal: "items.edit",
  peer_search: "owner", peer_read: "owner", suggest_next: "ask.send", show: "ask.send", withdraw_ask: "ask.send",
  scan: "search.use", find_symbol: "search.use", source_outline: "sources.view", list_sources: "sources.view",
  write_file: "sources.edit", save_note: "sources.edit", import_url: "sources.edit", annotate_source: "sources.edit", set_source_attention: "sources.edit",
  describe_source: "sources.edit", review_notes: "sources.edit",
  supervise_report: "items.operate",
  attach_object: "items.edit", note_item_change: "items.edit", submit_item_step: "items.edit",
  list_memory_folders: "memories.view", remember: "memory.write", supersede: "memory.write", forget: "memory.write",
  review_memories: "memory.write", organize_memories: "memory.write",
  write_page: "wiki.write", correct_page: "wiki.write", move_page: "wiki.write", confirm_page: "wiki.write", generate_wiki: "wiki.write",
  save_requirements: "memory.write", split_requirements: "memory.write",
  read_design: "designs.view", assess_design: "memory.write", settle_design: "memory.write",
  list_conversations: "conversations.view", read_conversation: "conversations.view",
  list_runs: "runs.view", read_run: "runs.view",
  metric_read: "metrics.view", metric_define: "memory.write", metric_record: "memory.write",
  read_flow_reviews: "flows.view", read_flow_object: "flows.operate", submit_flow_reconcile: "flows.operate", flow_start: "flows.operate", stage_report: "flows.operate", stage_reopen: "flows.operate",
  switch_run_ai: "runs.operate", take_over_run: "runs.operate",
  ask_user: "ask.send", wait_answer: "ask.send", list_rules: "rules.view", save_rule: "rules.edit", list_items: "items.view", read_item: "items.view",
  list_flows: "flows.view", upsert_item: "items.edit", search: "search.use", read_source: "sources.view",
  list_pages: "wiki.view", read_page: "wiki.view", recall: "memories.view", req_read: "requirements.view", req_tree: "requirements.view",
};

/**
 * Built-in plugins' tools (plugins/registry.ts groupTools: connect, the platform packs). They work as
 * whoever calls them: they read a platform through that person's own connection, and what they save
 * goes through the host, checked against the spaces that person may edit. So a read tool needs only the
 * assistant (ask.send) and one that writes needs sources.edit in some space of the run. A plugin from
 * the data directory is code the owner trusted for themself (in omem's process it can do anything
 * omem can): its tools stay the owner's, and so do the buttons on an item's platform objects
 * (the object-actions group).
 */
const pluginTools = new Map<string, ToolCapability>();
export function setPluginToolCapabilities(tools: { name: string; write: boolean }[]) {
  for (const t of tools) pluginTools.set(t.name, t.write ? "sources.edit" : "ask.send");
}
export function forgetPluginToolCapabilities(names: string[]) {
  for (const name of names) pluginTools.delete(name);
}

type ToolScope = { spaces: string[] | null; writable?: string[] };
const unrestricted: ToolScope = { spaces: null };

export function toolCapability(name: string): ToolCapability {
  if (Object.hasOwn(toolCapabilities, name)) return toolCapabilities[name];
  const plugin = pluginTools.get(name);
  if (plugin) return plugin;
  return TOOL_GROUPS.find(g => g.tools.includes(name))?.capability ?? "owner";
}

/** One permission snapshot per call or directory listing. */
export function memberToolAccess(app: App, userId: string, scope: ToolScope = unrestricted) {
  const access = capabilityAccess(app, userId);
  const spaces = scopeFor(app, userId, scope.spaces);
  const allowedScope = { spaces, writable: scope.writable?.filter(id => !spaces || spaces.includes(id)) };
  const writableInRun = (ids: string[]) => ids.filter(id => (!spaces || spaces.includes(id)) && (!scope.writable || scope.writable.includes(id)));
  const global = new Map<GlobalPerm, boolean>();
  const legacy = new Map<SpacePerm, string[]>();
  return (name: string): ToolScope | { deniedCapability: ToolCapability; reason: string } => {
    const cap = toolCapability(name);
    const denied = { deniedCapability: cap, reason: "在本次范围内没有这项权限" };
    if (!access.active) return { ...denied, reason: "成员账号未启用" };
    if (["create_space", "connect_repository"].includes(name) && scope.spaces !== null)
      return { ...denied, reason: "这项操作需要本人在不限空间的会话中发起" };
    if (cap === "owner") return userId === OWNER && access.preset === "owner"
      ? scope : { ...denied, reason: "这项操作仅限本人" };
    if (access.preset === "owner") return scope;
    if (cap === "memory.write" || cap === "wiki.write") {
      if (!legacy.has(cap)) legacy.set(cap, writableInRun(spacesWith(app, userId, cap) ?? []));
      const writable = legacy.get(cap)!;
      return writable.length ? { ...allowedScope, writable } : denied;
    }
    if (!isCapability(cap)) {
      if (!global.has(cap)) global.set(cap, can(app, userId, cap));
      return global.get(cap) ? allowedScope : denied;
    }
    if (globalCapability(cap)) return access.source(cap) ? allowedScope : denied;
    const write = cap.endsWith(".edit") || cap.endsWith(".operate");
    const own = cap === "items.view" || cap === "runs.view";
    const capable = access.spaces.filter(s => (!scope.spaces || scope.spaces.includes(s.id)) &&
      (name !== "find_symbol" || access.source("sources.view", s.id)) &&
      (access.source(cap, s.id, own) || (name === "upsert_item" && access.source("items.operate", s.id)))).map(s => s.id);
    if (write) {
      const writable = writableInRun(capable);
      return writable.length ? { ...allowedScope, writable } : denied;
    }
    return capable.length ? { ...allowedScope, spaces: capable } : denied;
  };
}

export function toolAllowed(app: App, userId: string | undefined | null, name: string) {
  return !("deniedCapability" in memberToolAccess(app, userId ?? OWNER)(name));
}

export function trimTools(app: App, userId: string, tools: Set<string>, scope?: ToolScope) {
  const allowed = memberToolAccess(app, userId, scope);
  for (const name of tools) if ("deniedCapability" in allowed(name)) tools.delete(name);
}
