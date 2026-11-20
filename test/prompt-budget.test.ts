import { expect, it } from "vitest";
import { createSpace } from "../src/core/spaces.ts";
import { agentProfileSchema, type RoleName } from "../src/core/config.ts";
import { prepareRun } from "../src/agents/runner.ts";
import { seedBuiltinSkills } from "../src/agents/specs.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { testApp } from "./helpers.ts";

it("bounds standing instructions for a fixed space, skill library and four lessons", () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  createSpace(app, { id: "project-a", name: "项目 A" });
  seedBuiltinSkills(app, process.cwd());
  const lessons = "- 偏好：直接回答。\n- 偏好：日期写全。\n- 偏好：列出依据。\n- 经验：先核对版本。";
  for (const transport of ["acp", "doubao-cli", "doubao"] as const) {
    const profile = agentProfileSchema.parse({ id: "candidate", command: "test", transport });
    app.config.agents.profiles = [profile];
    const budgets: Partial<Record<RoleName, number>> = transport === "doubao"
      ? { assistant: 16500, gatekeeper: 3000, "replay-judge": 3000, summarizer: 3000, "mention-triage": 3000 }
      : transport === "acp" ? { assistant: 34976, "item-keeper": 6090, "memory-reviewer": 5879 }
      : { assistant: 35055, "item-keeper": 6169, "memory-reviewer": 5958 };
    for (const [role, limit] of Object.entries(budgets)) {
      const prep = prepareRun(app, { actor: { role: role as RoleName }, profileId: profile.id, spaceId: "project-a", runId: null, lessons });
      revokeToolToken(prep.token);
      const largest = Object.entries(prep.parts).filter(([k]) => k !== "lessonCount").sort((a, b) => b[1] - a[1]).slice(0, 3);

      expect.soft(prep.system.length, JSON.stringify({ transport, role, largest })).toBeLessThanOrEqual(limit);
    }
  }
  app.db.close();
});
