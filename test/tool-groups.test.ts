import { expect, it } from "vitest";
import { parseRoleText } from "../src/agents/builtin-roles.ts";
import { loadRole } from "../src/agents/runner.ts";
import { expandTools, TOOL_GROUPS } from "../src/agents/tool-help.ts";

it("expands tool groups, never with a role's own hand-in tools, and takes out what is excluded", () => {
  const tools = expandTools(["group:code", "-apply_code_run", "search"]);
  expect(tools).toEqual(expect.arrayContaining(["delegate_code", "clean_code_runs", "set_code_workspaces", "search"]));
  expect(tools).not.toContain("apply_code_run");
  expect(tools).not.toContain("submit_review");
  expect(tools).not.toContain("rule_review");
  expect(tools.some((t) => t.startsWith("group:") || t.startsWith("-"))).toBe(false);
});

it("gives the assistant every tool of its groups, so a new tool in a group needs no edit of the role", () => {
  const tools = loadRole("assistant").tools;
  const code = TOOL_GROUPS.find((g) => g.id === "code")!.tools.filter((t) => !["submit_review", "submit_change_points", "rule_review"].includes(t));
  expect(tools).toEqual(expect.arrayContaining(code));
  for (const t of ["write_page", "propose_item_update", "propose_profile_change", "meeting_send", "plugin_put"]) expect(tools).not.toContain(t);
});

it("rejects a group that does not exist when a role is saved", () => {
  expect(() => parseRoleText("---\ndescription: x\ntools: [group:nope]\n---\nbody\n")).toThrow(/group:nope/);
  expect(parseRoleText("---\ndescription: x\ntools: [group:code, -apply_code_run]\n---\nbody\n").meta.tools).toEqual(["group:code", "-apply_code_run"]);
});
