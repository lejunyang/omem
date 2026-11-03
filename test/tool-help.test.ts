import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testApp } from "./helpers.ts";
import { callTool, mcpTools, toolList, type ToolContext } from "../src/agents/tools.ts";
import { CORE_TOOLS, DIRECT_ALL, describeParams, expandTools, omemSkillDir, ROLE_TOOLS, TOOL_GROUPS } from "../src/agents/tool-help.ts";
import { agentToolEnv, toolArgs } from "../src/agents/tool-cli.ts";
import { remember } from "../src/memory/store.ts";

const ctxFor = (tools: string[] | null): ToolContext => ({ app: testApp(), runId: null, spaceId: "personal", spaces: null, tools: tools && new Set(tools), actor: "agent", userId: "owner" });

describe("omem tools offered to agents", () => {
  it("puts every tool in exactly one group, each with a reference page", () => {
    const names = toolList().map((t) => t.name);
    const grouped = TOOL_GROUPS.flatMap((g) => g.tools);
    expect(grouped.length).toBe(new Set(grouped).size);
    expect(names.filter((n) => !grouped.includes(n))).toEqual([]);
    expect(grouped.filter((n) => !names.includes(n))).toEqual([]);
    for (const n of CORE_TOOLS) expect(names).toContain(n);
    const dir = omemSkillDir()!;
    const skill = readFileSync(join(dir, "SKILL.md"), "utf8");
    for (const g of TOOL_GROUPS) {
      expect(existsSync(join(dir, "references", `${g.doc}.md`))).toBe(true);
      expect(skill).toContain(`references/${g.doc}.md`);
      expect(skill).toContain(`| \`${g.id}\` |`);
      // Groups are by purpose: a profile takes the few it needs, so none grows into a catch-all.
      if (g.id !== "plugins") expect(g.tools.length, g.id).toBeLessThanOrEqual(15);
    }
  });

  it("keeps the earlier group names meaning the same tools", () => {
    const before: Record<string, string[]> = {
      sources: ["list_spaces", "create_space", "connect_repository", "relate_spaces", "search", "scan", "read_source", "source_outline", "list_sources", "find_symbol", "describe_source", "set_source_attention", "annotate_source", "attention_rules", "digest_sources", "import_url", "save_note", "write_file", "list_conversations", "read_conversation", "classify_source", "propose_archive_rule"],
      items: ["req_tree", "req_read", "save_requirements", "split_requirements", "list_items", "read_item", "upsert_item", "settle_items", "propose_item_update", "list_item_proposals", "resolve_item_proposal", "repair_item_association", "inspect_item_notification", "read_item_repair", "refresh_item_notification", "notify", "ignore_notification_rule"],
      agents: ["list_agents", "save_agent", "run_agent", "continue_agent_work", "ask_agent", "list_ai_backends", "switch_run_ai", "list_skills", "read_skill", "save_skill", "propose_profile_change", "list_runs", "read_run"],
      owner: ["ask_owner", "wait_answer", "suggest_next", "wake_later", "wake_on_message", "cancel_wake", "list_rules", "save_rule"],
      code: ["delegate_code", "review_branch", "list_branches", "continue_code_run", "fix_review", "message_code_run", "set_code_review", "revise_finding", "stop_code_run", "resplit_change_points", "retry_code_progress", "apply_code_run", "code_branch", "clean_code_runs", "set_code_workspaces", "code_git_status", "code_git_action", "settle_code_task"],
      lark: ["lark_send", "lark_react", "meeting_send", "lark_card", "lark_update_card", "lark_send_file", "set_chat_watch", "lark_wiki_crawl", "lark_doc_fetch", "lark_doc_create", "lark_doc_update", "lark_doc_move", "list_lark_chats", "set_lark_backfill", "set_lark_capture_policy", "set_lark_subscription"],
    };
    for (const [id, tools] of Object.entries(before)) {
      const now = expandTools([`group:${id}`]);
      const expected = tools.filter((t) => !ROLE_TOOLS.includes(t));
      expect(now, id).toEqual(expect.arrayContaining(expected));
      // An old name gains only a tool that moved into a group it stands for (lark_wiki_crawl → collect, notify → ask) or a tool added later to a group it stands for (lark_read / lark_write).
      expect(now.filter((t) => !expected.includes(t)), id).toEqual(({ sources: ["lark_wiki_crawl"], owner: ["notify"], lark: ["lark_read", "lark_write"] } as Record<string, string[]>)[id] ?? []);
    }
  });

  it("lists core tools directly and the rest behind omem_help / omem_call", () => {
    const many = toolList().map((t) => t.name);
    const listed = mcpTools(new Set(many));
    const names = listed.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("omem_call");
    expect(names).not.toContain("delegate_code");
    expect(listed.find((t) => t.name === "omem_call")!.description).toContain("delegate_code");
    // A small role gets everything it may use directly.
    const few = ["search", "read_source", "set_source_attention"];
    expect(few.length).toBeLessThanOrEqual(DIRECT_ALL);
    expect(mcpTools(new Set(few)).map((t) => t.name)).toEqual(few);
  });

  it("omem_call runs only what the run may use, omem_help explains it", async () => {
    const ctx = ctxFor(["search", "recall", "list_memory_folders"]);
    remember(ctx.app, { spaceId: "personal", kind: "fact", content: "项目 A 的发布窗口是每周二。", subject: "项目 A" });
    const ok = await callTool(ctx, "omem_call", { tool: "list_memory_folders", args: {} });
    expect(ok.isError).toBe(false);
    const denied = await callTool(ctx, "omem_call", { tool: "forget", args: { memory_id: "m_x", reason: "x" } });
    expect(denied).toMatchObject({ isError: true });
    expect((await callTool(ctx, "omem_call", { tool: "omem_call", args: {} })).isError).toBe(true);
    const help = await callTool(ctx, "omem_help", { topic: "recall" });
    expect(help.text).toContain("## recall");
    expect(help.text).toContain("参数：");
    expect((await callTool(ctx, "omem_help", { topic: "forget" })).text).toContain("本次不能用");
    const group = await callTool(ctx, "omem_help", { topic: "memory" });
    expect(group.text).toContain("supersede");
    expect(group.text).toContain("- recall：");
    expect(group.text).not.toContain("- forget：");
    const all = await callTool(ctx, "omem_help", {});
    expect(all.text).toContain("list_memory_folders");
    expect(all.text).not.toContain("delegate_code");
  });

  it("describes nested and optional parameters", () => {
    const text = describeParams({
      type: "object",
      required: ["a"],
      properties: {
        a: { type: "string", description: "必填项" },
        b: { anyOf: [{ type: "number" }, { type: "null" }], description: "可空" },
        c: { type: "array", items: { type: "object", properties: { x: { enum: ["p", "q"] } } } },
      },
    });
    expect(text).toContain("- a（string，必填）：必填项");
    expect(text).toContain("- b（number）：可空");
    expect(text).toContain("  - x（\"p\" | \"q\"）");
  });

  it("parses command-line arguments for omem tool", () => {
    expect(toolArgs(['{"query":"退款","limit":3}'])).toEqual({ query: "退款", limit: 3 });
    expect(toolArgs(["query=退款 幂等", "limit=3", 'tags=["a"]', "raw=true"])).toEqual({ query: "退款 幂等", limit: 3, tags: ["a"], raw: true });
    expect(() => toolArgs(["oops"])).toThrow(/键=值/);
    const app = testApp();
    const f = join(app.home, "args.json");
    writeFileSync(f, '{"kind":"fact"}');
    expect(toolArgs([], f)).toEqual({ kind: "fact" });
  });

  it("gives the agent process its token and an omem command on PATH", () => {
    const app = testApp();
    const env = agentToolEnv(app.home, "http://127.0.0.1:1", "ot_x");
    expect(env).toMatchObject({ OMEM_URL: "http://127.0.0.1:1", OMEM_TOKEN: "ot_x" });
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH")!;
    expect(env[pathKey].startsWith(join(app.home, "bin"))).toBe(true);
    expect(existsSync(join(app.home, "bin", process.platform === "win32" ? "omem.cmd" : "omem"))).toBe(true);
  });
});
