import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createSpace } from "../src/core/spaces.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { saveLarkSecret } from "../src/channels/lark-setup.ts";
import { saveDoubaoToken, setDoubaoFetchForTests } from "../src/agents/doubao.ts";
import { seedBuiltinSkills } from "../src/agents/specs.ts";
import { runRole } from "../src/agents/runner.ts";
import { testApp } from "./helpers.ts";

it("sends space material and drops unreachable directories from the first OpenAPI message", async () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "cloud", transport: "doubao", command: "test" })];
  app.config.agents.default = "cloud";
  seedBuiltinSkills(app, process.cwd());
  createSpace(app, { id: "project-a", name: "项目 A" });
  app.config.lark.appId = "cli_test";
  saveLarkSecret(app.home, { appId: "cli_test", appSecret: "test" });
  saveDoubaoToken(app.home, { appId: "cli_test", accessToken: "test", expiresAt: new Date(Date.now() + 3600000).toISOString(), savedAt: "" });
  let message = "";
  setDoubaoFetchForTests(async (_url, init) => {
    message = JSON.parse(String(init?.body)).initial_events[0].contents[0].text;
    return new Response("fixture complete", { status: 400 });
  });
  try {
    await expect(runRole(app, { role: "assistant", spaceId: "project-a", runId: null, task: "总结给出的材料" })).rejects.toThrow(/400/);
    expect(message).toContain("项目 A");
    expect(message).toContain("总结给出的材料");
    for (const label of ["## 可用技能", "## 这个空间和仓库的技能", "## 已有的 Agent 档案", "## 任务选型", "常用的 omem 工具直接列出", "- 工作目录"]) expect(message).not.toContain(label);
    for (const file of ["_common", "assistant"]) {
      for (const [, heading] of readFileSync(`roles/${file}.md`, "utf8").matchAll(/^(## .+)\r?\n<!-- tools:/gm)) {
        expect(message).not.toContain(heading);
      }
    }
  } finally {
    setDoubaoFetchForTests(null);
    app.db.close();
  }
});
