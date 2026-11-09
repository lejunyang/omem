import { expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { all } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

it("run_agent in a rule's run hands the trigger over within the rule's limits", async () => {
  const app = testApp();
  try {
    saveAgentSpec(app, { name: "investigator-x", description: "排查", prompt: "自己排查", status: "active" }, "user");
    const lark = { chats: ["oc_alerts"], draft: false };
    const parent = createRun(app, {
      kind: "agent", spaceId: "personal", title: "assistant（规则「报警」）",
      input: {
        spec: "assistant", task: "# 规则「报警」触发\n\n原始任务",
        assistantScope: { spaces: ["personal"], userId: "owner", denyTools: ["delegate_code"], lark },
        rule: { id: "rule_x", name: "报警", failureTo: "owner" }, lark, hideThinking: true,
        silent: { chatId: "oc_alerts", messageId: "om_1", topicId: null },
      },
    });
    const ctx: ToolContext = { app, runId: parent.id, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent", userId: "owner" };
    const out = await callTool(ctx, "run_agent", { name: "investigator-x", task: "查这条报警的原因" });
    expect(out.isError).toBe(false);
    const [child] = all<{ id: string }>(app.db, "select id from runs where parent_id = ?", parent.id);
    const input = getRun(app, child.id).input as Record<string, unknown>;
    expect(input).toMatchObject({ spec: "investigator-x", rule: { id: "rule_x" }, lark, hideThinking: true, silent: { chatId: "oc_alerts" }, handoff: { from: "assistant", runId: parent.id } });
    expect(input.denyTools).toEqual(expect.arrayContaining(["run_agent", "ask_agent", "continue_agent_work"]));
    expect(String(input.task)).toMatch(/查这条报警的原因[\s\S]*静默排查[\s\S]*原始任务/);
    expect(input.assistantScope).toBeUndefined();
    // Not to itself.
    expect((await callTool(ctx, "run_agent", { name: "assistant", task: "再看看" })).isError).toBe(true);
  } finally { app.db.close(); }
});
