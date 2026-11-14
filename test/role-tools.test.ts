import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyProposal, createProposal } from "../src/agents/proposals.ts";
import { skillCandidates } from "../src/agents/replay-skills.ts";
import { roleState, roleTools, setRoleTools } from "../src/agents/builtin-roles.ts";
import { loadRole } from "../src/agents/runner.ts";
import { DEFAULT_SPEC_TOOLS, readAgentSpec, saveAgentSpec, saveSkill, setSkillStatus, skillHeld } from "../src/agents/specs.ts";
import { expandTools } from "../src/agents/tool-help.ts";
import { testApp } from "./helpers.ts";

describe("picking tools by group", () => {
  it("keeps the owner's pick for a built-in role as an overlay: the role goes on following the source", () => {
    const app = testApp();
    const before = roleTools(app, "assistant");
    expect(before).toMatchObject({ changed: false, fixed: false });
    expect(before.tools).toEqual(before.base);
    expect(before.tools).toContain("group:memory");
    expect(loadRole("assistant", app).tools).toContain("forget");

    // Leave one tool of a whole group out, add a single tool the role did not have.
    const extra = "plugin_query";
    expect(loadRole("assistant", app).tools).not.toContain(extra);
    setRoleTools(app, "assistant", [...before.base, "-forget", extra]);
    expect(roleState(app, "assistant")).toMatchObject({ customized: false, overlay: { tools: { add: ["-forget", extra], remove: [] } } });
    expect(roleTools(app, "assistant")).toMatchObject({ changed: true, base: before.base });
    const tools = loadRole("assistant", app).tools;
    expect(tools).not.toContain("forget");
    expect(tools).toContain("remember");
    expect(tools).toContain(extra);

    // Dropping a whole group takes its tools away; the source's own exclusions stay as they were.
    setRoleTools(app, "assistant", before.base.filter((t) => t !== "group:learning"));
    expect(roleState(app, "assistant").overlay.tools).toEqual({ add: [], remove: ["group:learning"] });
    expect(loadRole("assistant", app).tools).not.toContain("create_card");
    expect(loadRole("assistant", app).tools).toContain("forget");

    // Back to what the version lists: nothing of the owner's is left.
    setRoleTools(app, "assistant", before.base);
    expect(roleTools(app, "assistant")).toMatchObject({ changed: false, tools: before.base });
    expect(roleState(app, "assistant")).toMatchObject({ customized: false, overlay: { tools: { add: [], remove: [] } } });
  });

  it("does not let a role lose the tool it hands its result in with, nor widen what a guest role reaches", () => {
    const app = testApp();
    const planner = roleTools(app, "wiki-planner");
    expect(planner.handIn).toEqual(["submit_plan"]);
    expect(() => setRoleTools(app, "wiki-planner", planner.base.filter((t) => t !== "submit_plan"))).toThrow(/靠 submit_plan 交结果/);
    setRoleTools(app, "wiki-planner", planner.base.filter((t) => t !== "move_page"));
    expect(loadRole("wiki-planner", app).tools).toEqual(expect.arrayContaining(["submit_plan", "write_page"]));
    expect(loadRole("wiki-planner", app).tools).not.toContain("move_page");

    expect(roleTools(app, "guest").fixed).toBe(true);
    expect(() => setRoleTools(app, "guest", [...roleTools(app, "guest").base, "remember"])).toThrow(/回答访客/);
    expect(() => setRoleTools(app, "assistant", ["group:read", "group:nope"])).toThrow(/没有这些工具分组：group:nope/);
    expect(() => setRoleTools(app, "no-such-role", [])).toThrow(/没有内置角色/);
  });

  it("a profile's tools take groups and exclusions too, and a group that does not exist is refused", () => {
    const app = testApp();
    saveAgentSpec(app, { name: "reader", description: "只读查资料", tools: ["group:read", "group:wiki", "-write_page", "recall"], prompt: "查资料。" }, "user");
    expect(readAgentSpec(app, "reader").tools).toEqual(["group:read", "group:wiki", "-write_page", "recall"]);
    const given = expandTools(readAgentSpec(app, "reader").tools);
    expect(given).toEqual(expect.arrayContaining(["search", "read_page", "recall"]));
    expect(given).not.toContain("write_page");
    // A role's own hand-in tools never come with a group.
    expect(given).not.toContain("submit_plan");
    expect(() => saveAgentSpec(app, { name: "reader", tools: ["group:nope"] }, "user")).toThrow(/没有这些工具分组：group:nope/);
    expect(readAgentSpec(app, "reader").tools).toContain("group:wiki");
  });

  it("a suggestion that takes a tool away or adds one works on groups and on the default read tools", () => {
    const app = testApp();
    // The tool comes with a whole group: it is left out of the group, not looked for by name.
    const off = createProposal(app, { target: "assistant", kind: "settings", title: "不用忘记", reason: "它不该删记忆", content: { remove_tools: ["forget"] }, runId: null });
    applyProposal(app, off);
    expect(loadRole("assistant", app).tools).not.toContain("forget");
    expect(roleTools(app, "assistant").tools).toContain("-forget");
    // Adding it back takes the exclusion away.
    const on = createProposal(app, { target: "assistant", kind: "settings", title: "还是要", reason: "要清理过期的", content: { add_tools: ["forget"] }, runId: null });
    applyProposal(app, on);
    expect(loadRole("assistant", app).tools).toContain("forget");
    expect(roleTools(app, "assistant").tools).not.toContain("-forget");

    // A profile that lists no tools has the default read tools: adding one keeps them.
    saveAgentSpec(app, { name: "plain", description: "默认工具", prompt: "查资料。" }, "user");
    expect(readAgentSpec(app, "plain").tools).toEqual([]);
    const more = createProposal(app, { target: "plain", kind: "settings", title: "能记", reason: "要记下结论", content: { add_tools: ["remember"] }, runId: null });
    applyProposal(app, more);
    expect(readAgentSpec(app, "plain").tools).toEqual([...DEFAULT_SPEC_TOOLS, "remember"]);
  });

  it("turning a skill off keeps its frontmatter, and one the owner turned off is not tried out by the nightly replay", () => {
    const app = testApp();
    saveSkill(app, { name: "weekly-note", description: "写周报的做法", body: "先列事实。", status: "draft" }, "agent");
    expect(skillCandidates(app).map((c) => c.id)).toContain("skill:weekly-note");
    // An agent enabling it (the replay), then the owner turning it off: held, and other frontmatter untouched.
    writeFileSync(join(app.libraryDir, "_skills", "weekly-note", "SKILL.md"), ["---", "name: weekly-note", "description: 写周报的做法", "status: draft", "requires: [ai:image]", "---", "", "先列事实。", ""].join("\n"));
    setSkillStatus(app, "weekly-note", "active", "agent");
    expect(readFileSync(join(app.libraryDir, "_skills", "weekly-note", "SKILL.md"), "utf8")).toContain("requires:");
    expect(skillHeld(app, "weekly-note")).toBe(false);
    setSkillStatus(app, "weekly-note", "draft", "user");
    const raw = readFileSync(join(app.libraryDir, "_skills", "weekly-note", "SKILL.md"), "utf8");
    expect(raw).toContain("status: draft");
    expect(raw).toContain("requires:");
    expect(skillHeld(app, "weekly-note")).toBe(true);
    expect(skillCandidates(app).map((c) => c.id)).not.toContain("skill:weekly-note");
    // Enabled again by the owner: the mark goes with the draft status.
    setSkillStatus(app, "weekly-note", "active", "user");
    expect(skillHeld(app, "weekly-note")).toBe(false);
  });
});
