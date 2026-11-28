import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAgentSpecs, readAgentSpec, saveAgentSpec } from "../src/agents/specs.ts";
import { roleGroupOf, roleGroups, roleNames } from "../src/core/config.ts";
import { testApp } from "./helpers.ts";

describe("groups on the Agent page", () => {
  it("puts every built-in role in exactly one group", () => {
    const listed = roleGroups.flatMap((g) => g.roles);
    expect([...listed].sort()).toEqual([...roleNames].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(new Set(roleGroups.map((g) => g.id)).size).toBe(roleGroups.length);
    expect(roleGroupOf("wiki-writer")?.id).toBe("wiki");
    expect(roleGroupOf("no-such-role")).toBeUndefined();
  });

  it("keeps the owner's group in a profile's file and drops it when emptied", () => {
    const app = testApp();
    saveAgentSpec(app, { name: "oncall-helper", description: "值班群里的问题先查日志", group: " 值班 ", prompt: "先查日志再回答。" }, "user");
    expect(readAgentSpec(app, "oncall-helper").group).toBe("值班");
    expect(listAgentSpecs(app).find((s) => s.name === "oncall-helper")?.group).toBe("值班");
    // A change to something else keeps it; an empty value takes it out of the file.
    saveAgentSpec(app, { name: "oncall-helper", description: "值班群里的问题先查日志和发布" }, "agent");
    expect(readAgentSpec(app, "oncall-helper").group).toBe("值班");
    saveAgentSpec(app, { name: "oncall-helper", group: "" }, "user");
    expect(readAgentSpec(app, "oncall-helper").group).toBeUndefined();
    expect(readFileSync(join(app.libraryDir, "_agents", "oncall-helper.md"), "utf8")).not.toContain("group:");
    expect(() => saveAgentSpec(app, { name: "oncall-helper", group: "很".repeat(25) }, "user")).toThrow();
  });
});
