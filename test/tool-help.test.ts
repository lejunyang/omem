import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testApp } from "./helpers.ts";
import { callTool, mcpTools, toolList, type ToolContext } from "../src/agents/tools.ts";
import { CORE_TOOLS, DIRECT_ALL, describeParams, expandTools, MERGED_TOOLS, omemSkillDir, ROLE_TOOLS, TOOL_GROUPS } from "../src/agents/tool-help.ts";
import { agentToolEnv, toolArgs } from "../src/agents/tool-cli.ts";
import { toolCapability } from "../src/auth/tools.ts";
import { remember } from "../src/memory/store.ts";

const ctxFor = (tools: string[] | null): ToolContext => ({ app: testApp(), runId: null, spaceId: "personal", spaces: null, tools: tools && new Set(tools), actor: "agent", userId: "owner" });

describe("omem tools offered to agents", () => {
  it("puts every tool in exactly one group, each with a reference page", () => {
    expect(expandTools(["group:improve"])).toEqual(["improve_start", "improve_round", "improve_status"]);
    expect(expandTools(["group:study"])).toEqual(["propose_directions", "trial_report", "read_ledger", "record_finding", "revise_study_finding", "queue_study_fixes", "close_direction"]);
    for (const t of expandTools(["group:study"])) expect(CORE_TOOLS).not.toContain(t);
    expect(expandTools(["group:coding"])).toContain("propose_repo_lesson");
    expect(CORE_TOOLS).not.toContain("propose_repo_lesson");
    expect(TOOL_GROUPS.find((g) => g.id === "wiki")?.tools).toContain("correct_page");
    expect(CORE_TOOLS).not.toContain("correct_page");
    expect(ROLE_TOOLS).toContain("submit_level_check");
    expect(expandTools(["group:wiki"])).not.toContain("submit_level_check");
    const names = toolList().map((t) => t.name);
    for (const name of names) expect(toolCapability(name), name).toBeTruthy();
    expect(toolCapability("unknown_write")).toBe("owner");
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

  it("maps a merged tool's old name to the tool that does it now", async () => {
    const names = new Set(toolList().map((t) => t.name));
    for (const [old, m] of Object.entries(MERGED_TOOLS)) {
      expect(names.has(old), old).toBe(false);
      expect(names.has(m.into), m.into).toBe(true);
    }
    expect(expandTools(["wake_later", "continue_agent_work", "-lark_update_card", "lark_card"])).toEqual(["wake", "run_agent"]);
    const r = await callTool(ctxFor(null), "flow_round", { item: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("flow_start");
    expect((await callTool(ctxFor(null), "omem_help", { topic: "wake_on_message" })).text).toContain("on_message");
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
