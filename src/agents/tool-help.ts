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
  "list_sources", "write_file", "list_runs", "read_run", "wake_later", "cancel_wake",
]);
/** What a background role exists to hand in: always its own tool, and only for that role. */
export const ROLE_TOOLS = ["describe_source", "classify_source", "propose_archive_rule", "review_memories", "settle_items", "submit_plan", "submit_review", "submit_change_points", "review_task", "code_workspace", "rule_review", "propose_knowledge_mapping", "plan_tasks", "finish_task", "report_task", "ask_reviewer", "dispatch_tasks", "verify_tasks", "plan_review", "rule_dispute"];
for (const t of ROLE_TOOLS) CORE_TOOLS.add(t);
/**
 * A run allowed this few tools gets every one of them directly: a background role or profile
 * with an exact list just over the line otherwise spends a turn on omem_help for each tool it
 * reaches through omem_call, which costs more than the schemas would.
 */
export const DIRECT_ALL = 30;

/**
 * The tool set by what a run uses it for, small enough that a profile takes only the purposes it
 * needs (`group:read` without `group:curate`). Every tool is in exactly one group
 * (test/tool-help.test.ts); a new tool goes into the group of its purpose, or a new group when none
 * fits, never a catch-all. `doc` is the reference page at skills/omem/references/<doc>.md (several
 * groups share one; plugin groups have none), what omem_help(<group>) returns.
 */
export const TOOL_GROUPS: { id: string; label: string; doc?: string; tools: string[] }[] = [
  { id: "read", label: "查找与阅读原件", doc: "sources", tools: ["list_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "list_conversations", "read_conversation", "peer_search", "peer_read"] },
  { id: "collect", label: "收进材料", doc: "sources", tools: ["import_url", "save_note", "write_file", "digest_sources", "lark_wiki_crawl"] },
  { id: "curate", label: "空间与原件治理", doc: "sources", tools: ["create_space", "connect_repository", "relate_spaces", "set_source_attention", "annotate_source", "attention_rules", "describe_source", "classify_source", "propose_archive_rule"] },
  { id: "memory", label: "记忆", doc: "memory", tools: ["recall", "remember", "supersede", "forget", "review_memories", "list_memory_folders", "organize_memories"] },
  { id: "track", label: "事项与需求", doc: "items", tools: ["req_tree", "req_read", "save_requirements", "split_requirements", "list_items", "read_item", "upsert_item", "settle_items", "propose_item_update", "list_item_proposals", "resolve_item_proposal"] },
  { id: "notifications", label: "事项通知排查", doc: "items", tools: ["repair_item_association", "inspect_item_notification", "read_item_repair", "refresh_item_notification", "ignore_notification_rule"] },
  { id: "wiki", label: "Wiki", doc: "wiki", tools: ["list_pages", "read_page", "write_page", "move_page", "confirm_page", "generate_wiki", "submit_plan"] },
  { id: "delegate", label: "交给别的 Agent 与查看运行", doc: "agents", tools: ["list_agents", "run_agent", "continue_agent_work", "ask_agent", "list_ai_backends", "switch_run_ai", "list_runs", "read_run"] },
  { id: "skills", label: "技能与档案", doc: "agents", tools: ["list_skills", "read_skill", "save_skill", "save_agent", "propose_profile_change"] },
  { id: "remote", label: "远程操作的录制", doc: "remote", tools: ["list_recordings", "read_recording"] },
  { id: "ask", label: "问本人与通知", doc: "owner", tools: ["ask_owner", "wait_answer", "suggest_next", "notify", "stay_quiet"] },
  { id: "wake", label: "唤醒与规则", doc: "owner", tools: ["wake_later", "wake_on_message", "cancel_wake", "list_rules", "save_rule", "report_rule_failure"] },
  { id: "coding", label: "编码交办与跟进", doc: "code", tools: ["delegate_code", "review_branch", "continue_code_run", "fix_review", "message_code_run", "set_code_review", "revise_finding", "stop_code_run", "resplit_change_points", "retry_code_progress", "apply_code_run", "settle_code_task"] },
  { id: "git", label: "代码仓库与 Git", doc: "code", tools: ["list_branches", "code_branch", "clean_code_runs", "set_code_workspaces", "code_git_status", "code_git_action"] },
  { id: "code-handin", label: "编码与评审角色交结果", doc: "code", tools: ["review_task", "code_workspace", "submit_review", "submit_change_points", "rule_review", "plan_tasks", "finish_task", "report_task", "ask_reviewer", "dispatch_tasks", "verify_tasks", "plan_review", "rule_dispute"] },
  { id: "lark-msg", label: "飞书消息与卡片", doc: "lark", tools: ["lark_send", "lark_react", "meeting_send", "lark_card", "lark_update_card", "lark_send_file", "lark_message_file"] },
  { id: "lark-docs", label: "以本人身份写飞书文档", doc: "lark", tools: ["lark_doc_fetch", "lark_doc_create", "lark_doc_update", "lark_doc_move", "lark_doc_copy", "lark_doc_authorize"] },
  { id: "lark-owner", label: "以本人身份读写飞书的表格、多维表格、任务等", doc: "lark", tools: ["lark_read", "lark_write"] },
  { id: "lark-capture", label: "飞书采集设置", doc: "lark", tools: ["list_lark_chats", "set_chat_watch", "set_lark_backfill", "set_lark_capture_policy", "set_lark_subscription", "propose_knowledge_mapping"] },
  { id: "learning", label: "学习", doc: "learning", tools: ["create_card", "set_learning_goal", "learning_progress"] },
  { id: "plugins", label: "插件", doc: "plugins", tools: ["plugin_query", "plugin_put"] },
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
export const unknownGroups = (list: string[]) => list.filter((t) => /^group:/.test(t) && !TOOL_GROUPS.some((g) => g.id === t.slice(6)));

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
      description: `查看 omem 工具的用法：topic 填工具名（可用逗号分隔多个）看完整说明和参数；填分组 id（${TOOL_GROUPS.map((g) => g.id).join("、")}，或插件 id）看这一类的做法和要点；不填列出本次能用的全部工具。`,
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
  // A group id, or a reference page several groups share.
  const groups = TOOL_GROUPS.filter((g) => g.id === t || g.doc === t);
  if (groups.length) {
    const dir = omemSkillDir();
    const docs = [...new Set(groups.map((g) => g.doc ?? g.id))].map((d) => {
      const file = dir && join(dir, "references", `${d}.md`);
      return file && existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim() : "";
    });
    const lists = groups.map((g) => {
      const mine = allowed.filter((x) => g.tools.includes(x.name));
      return `本次能用的${g.label}工具（${g.id}）：\n${mine.length ? mine.map((x) => `- ${x.name}：${summary(x.description)}`).join("\n") : "（无）"}`;
    });
    return `${docs.filter(Boolean).join("\n\n")}\n\n${lists.join("\n\n")}`.trim();
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
