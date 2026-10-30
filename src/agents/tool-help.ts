/**
 * How omem's tools are offered to agents. A run sees its frequently used tools as MCP tools
 * of their own; everything else it may use goes through omem_help / omem_call (or `omem tool`
 * in a shell), so 100 tool schemas do not sit in every session's context. Which tools a run
 * may use is still decided by its token (tools.ts callTool), whichever way it calls them.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Offered as their own MCP tools whenever a run may use them. */
export const CORE_TOOLS = new Set([
  "list_spaces", "search", "scan", "read_source", "source_outline", "find_symbol", "list_pages", "read_page", "write_page",
  "recall", "remember", "supersede", "list_items", "read_item", "upsert_item", "notify",
  "list_conversations", "read_conversation", "list_skills", "read_skill",
  "ask_owner", "wait_answer", "suggest_next", "lark_send",
]);
/** What a background role exists to hand in: always its own tool, and only for that role. */
export const ROLE_TOOLS = ["describe_source", "classify_source", "propose_archive_rule", "review_memories", "settle_items", "submit_plan", "submit_review", "submit_change_points", "rule_review", "propose_knowledge_mapping"];
for (const t of ROLE_TOOLS) CORE_TOOLS.add(t);
/** A run allowed this few tools gets every one of them directly. */
export const DIRECT_ALL = 20;

/** Areas of the tool set; each has a reference page at skills/omem/references/<id>.md. */
export const TOOL_GROUPS: { id: string; label: string; tools: string[] }[] = [
  { id: "sources", label: "原件、检索与材料", tools: ["list_spaces", "create_space", "connect_repository", "relate_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "describe_source", "set_source_attention", "annotate_source", "attention_rules", "digest_sources", "import_url", "save_note", "write_file", "list_conversations", "read_conversation", "classify_source", "propose_archive_rule"] },
  { id: "memory", label: "记忆", tools: ["recall", "remember", "supersede", "forget", "review_memories", "list_memory_folders", "organize_memories"] },
  { id: "items", label: "事项与通知", tools: ["list_items", "read_item", "upsert_item", "settle_items", "propose_item_update", "list_item_proposals", "resolve_item_proposal", "repair_item_association", "inspect_item_notification", "read_item_repair", "refresh_item_notification", "notify", "ignore_notification_rule"] },
  { id: "wiki", label: "Wiki", tools: ["list_pages", "read_page", "write_page", "move_page", "confirm_page", "generate_wiki", "submit_plan"] },
  { id: "agents", label: "Agent、技能与运行", tools: ["list_agents", "save_agent", "run_agent", "continue_agent_work", "ask_agent", "list_ai_backends", "switch_run_ai", "list_skills", "read_skill", "save_skill", "propose_profile_change", "list_runs", "read_run"] },
  { id: "owner", label: "问本人、唤醒与规则", tools: ["ask_owner", "wait_answer", "suggest_next", "wake_later", "wake_on_message", "cancel_wake", "list_rules", "save_rule"] },
  { id: "code", label: "编码交办、评审与 Git", tools: ["delegate_code", "review_branch", "list_branches", "continue_code_run", "fix_review", "message_code_run", "set_code_review", "stop_code_run", "resplit_change_points", "retry_code_progress", "apply_code_run", "code_branch", "clean_code_runs", "set_code_workspaces", "code_git_status", "code_git_action", "submit_review", "submit_change_points", "rule_review"] },
  { id: "lark", label: "飞书", tools: ["lark_send", "lark_react", "meeting_send", "lark_card", "lark_update_card", "lark_send_file", "set_chat_watch", "lark_wiki_crawl", "propose_knowledge_mapping", "lark_doc_create", "lark_doc_update", "lark_doc_move", "list_lark_chats", "set_lark_backfill", "set_lark_capture_policy", "set_lark_subscription"] },
  { id: "learning", label: "学习", tools: ["create_card", "set_learning_goal", "learning_progress"] },
  { id: "plugins", label: "插件", tools: ["plugin_query", "plugin_put"] },
];

/**
 * A role's or profile's `tools` as tool names: `group:<id>` stands for every tool of that group
 * (so a tool added to the group needs no edit of the roles, nor of the owner's customized copies),
 * `-<name>` takes one back out. A role's own hand-in tools (ROLE_TOOLS) never come with a group.
 */
export function expandTools(list: string[]): string[] {
  const out = new Set<string>();
  for (const t of list) {
    const g = /^group:(.+)$/.exec(t);
    if (g) {
      for (const name of TOOL_GROUPS.find((x) => x.id === g[1])?.tools ?? []) if (!ROLE_TOOLS.includes(name)) out.add(name);
    } else if (!t.startsWith("-")) out.add(t);
  }
  for (const t of list) if (t.startsWith("-")) out.delete(t.slice(1));
  return [...out];
}

/** `group:<id>` entries that name no group. */
export const unknownGroups = (list: string[]) => list.filter((t) => /^group:/.test(t) && !TOOL_GROUPS.some((g) => `group:${g.id}` === t));

type ToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Which of the allowed tools are offered directly; the rest go through omem_call. */
export function splitDirect<T extends { name: string }>(allowed: T[]): { direct: T[]; rest: T[] } {
  if (allowed.length <= DIRECT_ALL) return { direct: allowed, rest: [] };
  return { direct: allowed.filter((t) => CORE_TOOLS.has(t.name)), rest: allowed.filter((t) => !CORE_TOOLS.has(t.name)) };
}

/** skills/omem sits at the package root both in source (src/agents) and build (dist/src/agents). */
export function omemSkillDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [resolve(here, "../../skills/omem"), resolve(here, "../../../skills/omem")]) if (existsSync(join(c, "SKILL.md"))) return c;
  return null;
}

const summary = (d: string) => {
  const s = d.split(/[。\n]/)[0].trim();
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
};

function grouped(tools: ToolInfo[]) {
  const names = new Set(tools.map((t) => t.name));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of TOOL_GROUPS) {
    const mine = tools.filter((t) => g.tools.includes(t.name) && !seen.has(t.name));
    if (!mine.length) continue;
    for (const t of mine) seen.add(t.name);
    out.push(`${g.label}（${g.id}）：\n${mine.map((t) => `- ${t.name}：${summary(t.description)}`).join("\n")}`);
  }
  const other = [...names].filter((n) => !seen.has(n));
  if (other.length) out.push(`其他：\n${other.map((n) => `- ${n}`).join("\n")}`);
  return out.join("\n\n");
}

/** The two tools that stand in for everything not offered directly. */
export function metaSchemas(rest: ToolInfo[]): ToolInfo[] {
  return [
    {
      name: "omem_help",
      description: "查看 omem 工具的用法：topic 填工具名（可用逗号分隔多个）看完整说明和参数；填分组 id（sources、memory、items、wiki、agents、owner、code、lark、learning、plugins，或插件 id）看这一类的做法和要点；不填列出本次能用的全部工具。",
      inputSchema: { type: "object", properties: { topic: { type: "string", description: "工具名、分组 id，或不填" } } },
    },
    {
      name: "omem_call",
      description: `调用下面这些没有单独列出的 omem 工具（权限和直接调用一样）。不确定参数时先 omem_help(topic=工具名)。\n\n${grouped(rest)}`,
      inputSchema: {
        type: "object",
        properties: { tool: { type: "string", description: "工具名" }, args: { type: "object", description: "该工具的参数（对象）", additionalProperties: true } },
        required: ["tool"],
      },
    },
  ];
}

/** Readable parameter list from a JSON Schema: what a model needs to fill the call. */
export function describeParams(schema: Record<string, unknown>, indent = ""): string {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);
  const lines: string[] = [];
  for (const [name, p] of Object.entries(props)) {
    const s = unwrap(p);
    const desc = (p.description ?? s.description ?? "") as string;
    lines.push(`${indent}- ${name}（${typeName(s)}${required.has(name) ? "，必填" : ""}）${desc ? `：${desc}` : ""}`);
    const item = s.type === "array" ? unwrap((s.items ?? {}) as Record<string, unknown>) : s;
    if (item.properties && indent.length < 8) lines.push(describeParams(item, indent + "  "));
  }
  return lines.join("\n");
}

function unwrap(s: Record<string, unknown>): Record<string, unknown> {
  const alt = (s.anyOf ?? s.oneOf) as Record<string, unknown>[] | undefined;
  if (alt) {
    const real = alt.filter((a) => a.type !== "null");
    if (real.length === 1) return { ...unwrap(real[0]), description: s.description ?? real[0].description };
  }
  return s;
}

function typeName(s: Record<string, unknown>): string {
  if (s.enum) return (s.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  const alt = (s.anyOf ?? s.oneOf) as Record<string, unknown>[] | undefined;
  if (alt) return alt.map((a) => typeName(unwrap(a))).join(" | ");
  if (s.type === "array") return `${typeName(unwrap((s.items ?? {}) as Record<string, unknown>))}[]`;
  return Array.isArray(s.type) ? s.type.join(" | ") : ((s.type as string) ?? "任意");
}

/** omem_help: one or more tools in full, an area's reference page, or everything this run may use. */
export function helpText(allowed: ToolInfo[], topic?: string | null): string {
  const t = topic?.trim();
  if (!t)
    return `本次能用的 omem 工具（omem_help(topic=工具名) 看参数，omem_help(topic=分组) 看这类的做法）：\n\n${grouped(allowed)}\n\n${SHELL_NOTE}`;
  const group = TOOL_GROUPS.find((g) => g.id === t);
  if (group) {
    const dir = omemSkillDir();
    const file = dir && join(dir, "references", `${group.id}.md`);
    const doc = file && existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim() : "";
    const mine = allowed.filter((x) => group.tools.includes(x.name));
    return `${doc}\n\n本次能用的${group.label}工具：\n${mine.length ? mine.map((x) => `- ${x.name}：${summary(x.description)}`).join("\n") : "（无）"}`.trim();
  }
  const names = t.split(/[,，\s]+/).filter(Boolean);
  return names
    .map((n) => {
      const x = allowed.find((a) => a.name === n);
      if (!x) return `${n}：本次不能用或没有这个工具。`;
      const params = describeParams(x.inputSchema);
      return `## ${x.name}\n\n${x.description}\n\n参数：\n${params || "（无）"}`;
    })
    .join("\n\n");
}

export const SHELL_NOTE =
  "在终端里也能调：`omem tool <工具名> '<JSON参数>'`、`omem tool <工具名> 键=值 …`（值是 JSON 就按 JSON 解析）、`omem tool <工具名> -f 参数.json`，`omem tool help [主题]` 看说明。权限与这里相同。";
