import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRun } from "../src/agents/runner.ts";
import { prepareSkillVectors, skillBlock, skillSuggestReady, suggestSkills } from "../src/agents/skill-suggest.ts";
import { saveSkill } from "../src/agents/specs.ts";
import { revokeToolToken } from "../src/agents/tools.ts";
import { setEmbedderForTests } from "../src/search/embeddings.ts";
import { fakeEmbedder, testApp } from "./helpers.ts";

type TestApp = ReturnType<typeof testApp>;
const apps: TestApp[] = [];
function setup() {
  const app = testApp();
  apps.push(app);
  app.baseUrl = "http://127.0.0.1:1";
  saveSkill(app, { name: "refund-checklist", description: "改退款金额之前逐项核对满减分摊和部分退款的清单", body: "1. 核对分摊。" }, "user");
  saveSkill(app, { name: "weekly-report", description: "按本周的事项和提交写周报初稿", body: "1. 列事项。" }, "user");
  saveSkill(app, { name: "birthday-card", description: "给同事写生日祝福卡片", body: "1. 写祝福。" }, "user");
  return app;
}
const system = (app: TestApp, role: "assistant" | "summarizer") => {
  const prep = prepareRun(app, { actor: { role }, spaceId: "personal", runId: null });
  revokeToolToken(prep.token);
  return prep;
};
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); setEmbedderForTests(null); });

describe("skills in a run's instructions", () => {
  it("describes every skill to the main assistant without vectors, with the way to read one said once", () => {
    const app = setup();
    expect(skillSuggestReady(app)).toBe(false);
    const prep = system(app, "assistant");
    expect(prep.skillSuggest).toBeNull();
    expect(prep.system).toContain("- refund-checklist：改退款金额之前逐项核对满减分摊和部分退款的清单\n");
    expect(prep.system).toContain("- birthday-card：给同事写生日祝福卡片");
    // No file path on every line: the section says how to read one.
    expect(prep.system).not.toContain("SKILL.md");
    expect(prep.system).toContain("## 可用技能（做对应的事之前先读全文并照做）");
  }, 30000);

  it("lists skills by name once every skill has a vector, and suggests the close ones per message", async () => {
    const app = setup();
    app.config.embeddings.provider = "local";
    setEmbedderForTests(fakeEmbedder());
    expect(await prepareSkillVectors(app)).toBe(true);
    expect(existsSync(join(app.home, "cache", "skill-vectors.json"))).toBe(true);
    expect(skillSuggestReady(app)).toBe(true);

    const prep = system(app, "assistant");
    expect(prep.skillSuggest).toMatchObject({ sourceSpace: "personal", told: [] });
    expect(prep.system).toMatch(/- 其他技能：.*birthday-card.*refund-checklist.*weekly-report/);
    expect(prep.system).not.toContain("给同事写生日祝福卡片");
    expect(prep.system).toContain("说明会自动附在那条消息后面");

    const hits = await suggestSkills(app, { text: "改退款金额之前要核对满减分摊吗", sourceSpace: "personal" });
    expect(hits.map((h) => h.name)).toEqual(["refund-checklist"]);
    expect(skillBlock(hits)).toContain("- refund-checklist：改退款金额之前逐项核对满减分摊和部分退款的清单");
    // Nothing close, or already described to this session: nothing is added.
    expect(await suggestSkills(app, { text: "今天天气怎么样", sourceSpace: "personal" })).toEqual([]);
    expect(await suggestSkills(app, { text: "改退款金额之前要核对满减分摊吗", sourceSpace: "personal", exclude: new Set(["refund-checklist"]) })).toEqual([]);
    expect(skillBlock([])).toBe("");

    // A new skill has no vector yet: runs get descriptions again until it does.
    saveSkill(app, { name: "oncall-notes", description: "值班时记录报警和处理经过", body: "1. 记时间。" }, "user");
    expect(skillSuggestReady(app)).toBe(false);
    expect(await prepareSkillVectors(app)).toBe(true);
    expect(skillSuggestReady(app)).toBe(true);

    app.config.agents.skillSuggest.enabled = false;
    expect(skillSuggestReady(app)).toBe(false);
    expect(await suggestSkills(app, { text: "改退款金额之前要核对满减分摊吗", sourceSpace: "personal" })).toEqual([]);
  }, 30000);
});
