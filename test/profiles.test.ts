import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { customizeRole, listRoleStates, mergeRole, resetRole, roleOverrideText, roleSourceText, roleState, saveRoleOverride } from "../src/agents/builtin-roles.ts";
import { applyProposal, createProposal, rejectProposal } from "../src/agents/proposals.ts";
import { reviewTask } from "../src/agents/profile-jobs.ts";
import { profileDetail } from "../src/agents/profiles.ts";
import { loadRole, prepareRun } from "../src/agents/runner.ts";
import { createRun } from "../src/agents/runs.ts";
import { findSkill, readAgentSpec, saveAgentSpec, saveSkill } from "../src/agents/specs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { run } from "../src/core/db.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { testApp } from "./helpers.ts";

const ctxFor = (app: ReturnType<typeof testApp>, extra: Record<string, unknown> = {}) =>
  toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", ...extra }))!;

/** Pretend the package's role source changed after the owner customized it. */
function changeBase(app: ReturnType<typeof testApp>, name: string, edit: (s: string) => string) {
  const base = join(app.libraryDir, "_roles", ".base", `${name}.md`);
  writeFileSync(base, edit(readFileSync(base, "utf8")));
}

describe("task routing in view", () => {
  it("shows the owner's candidates to runs that delegate, only while automatic choice is on", () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.routing = { automatic: true, guidance: "评审用不同于编码的模型", candidates: [{ profile: "codex", model: "fast-1", when: "简单判断" }] };
    const main = prepareRun(app, { actor: { role: "assistant" }, spaceId: "personal", runId: null });
    expect(main.system).toContain("## 任务选型");
    expect(main.system).toContain("- codex / fast-1：简单判断");
    expect(main.system).toContain("评审用不同于编码的模型");
    // Time-of-day preferences are compared with the time each turn opens with; the load is looked up
    // (the instructions stay the same for a whole session, so neither is written into them).
    expect(main.system).toContain("按每轮消息开头的现在时间对照着选");
    expect(main.system).toContain("交办前用 list_ai_backends 看各模型现在的占用");
    expect(main.system).not.toMatch(/正在用 \d+\/\d+/);
    // A background role hands nothing on.
    expect(prepareRun(app, { actor: { role: "ingest" }, spaceId: "personal", runId: null }).system).not.toContain("## 任务选型");
    app.config.agents.routing.automatic = false;
    expect(prepareRun(app, { actor: { role: "assistant" }, spaceId: "personal", runId: null }).system).not.toContain("## 任务选型");
    app.db.close();
  });
});

describe("built-in roles as profiles", () => {
  it("customizes into the library, runs use the copy, reset goes back to the source", () => {
    const app = testApp();
    expect(listRoleStates(app).find((r) => r.name === "reviewer")).toMatchObject({ customized: false, sourceChanged: false });
    customizeRole(app, "reviewer");
    const own = roleOverrideText(app, "reviewer")!;
    saveRoleOverride(app, "reviewer", own.replace("你是独立评审者。", "你是独立评审者。评审先报阻塞问题。"));
    expect(loadRole("reviewer", app)).toMatchObject({ customized: true });
    expect(loadRole("reviewer", app).body).toContain("评审先报阻塞问题");
    // Without the app (or after reset) the package version is used.
    expect(loadRole("reviewer").body).not.toContain("评审先报阻塞问题");
    expect(() => saveRoleOverride(app, "reviewer", "没有 frontmatter")).toThrow(/frontmatter/);
    resetRole(app, "reviewer");
    expect(roleState(app, "reviewer").customized).toBe(false);
    expect(loadRole("reviewer", app).body).toBe(loadRole("reviewer").body);
    app.db.close();
  });

  it("merges source changes into the owner's copy, and returns conflicts instead of writing them", () => {
    const app = testApp();
    customizeRole(app, "reviewer");
    const source = roleSourceText("reviewer");
    // The owner changed the last paragraph; the copy was taken from an older source whose first
    // body line differed. A clean three-way merge keeps both.
    const lines = source.split("\n");
    const last = lines.length - 2;
    saveRoleOverride(app, "reviewer", lines.map((l, i) => (i === last ? `${l}（本人补充：说明依据）` : l)).join("\n"));
    changeBase(app, "reviewer", (s) => s.replace("你是独立评审者。", "你是评审者。"));
    expect(roleState(app, "reviewer").sourceChanged).toBe(true);
    const clean = mergeRole(app, "reviewer");
    expect(clean.conflicts).toBe(0);
    const merged = roleOverrideText(app, "reviewer")!;
    expect(merged).toContain("你是独立评审者。");
    expect(merged).toContain("（本人补充：说明依据）");
    expect(roleState(app, "reviewer").sourceChanged).toBe(false);

    // Both sides changed the same line: conflict, nothing written.
    saveRoleOverride(app, "reviewer", merged.replace("你是独立评审者。", "你是严格的评审者。"));
    changeBase(app, "reviewer", (s) => s.replace("你是独立评审者。", "你是宽松的评审者。"));
    const before = roleOverrideText(app, "reviewer");
    const conflicted = mergeRole(app, "reviewer");
    expect(conflicted.conflicts).toBeGreaterThan(0);
    expect(conflicted.text).toMatch(/^<{7} 自定义/m);
    expect(roleOverrideText(app, "reviewer")).toBe(before);
    app.db.close();
  });

  it("teaches a built-in role: its own memories reach its runs, skills attach to its copy", async () => {
    const app = testApp();
    const main = ctxFor(app);
    const r = await callTool(main, "remember", { kind: "preference", content: "评审 TypeScript 改动时先看类型是否被 any 绕过。", agent: "reviewer" });
    expect(r.isError).toBe(false);
    // Runs are only told memories the reviewer kept (or the owner wrote).
    run(app.db, "update memories set review_verdict = 'keep', reviewed_at = datetime('now')");
    saveSkill(app, { name: "ts-review", description: "TypeScript 评审清单", body: "1. 看 any。" }, "user");
    const s = await callTool(main, "save_skill", { name: "ts-review", description: "TypeScript 评审清单", body: "1. 看 any。\n2. 看 as。", agent: "reviewer" });
    expect(s.text).toMatch(/挂到 reviewer/);
    expect(loadRole("reviewer", app).skills).toEqual(["ts-review"]);
    expect(roleOverrideText(app, "reviewer")).toMatch(/^skills: \[ts-review\]$/m);
    // A reviewer run is told its own preference and lists its skill first; another role is not.
    app.baseUrl = "http://127.0.0.1:1";
    const rev = prepareRun(app, { actor: { role: "reviewer" }, spaceId: "personal", runId: null });
    expect(rev.system).toContain("先看类型是否被 any 绕过");
    expect(rev.system).toMatch(/- ts-review：TypeScript 评审清单/);
    const other = prepareRun(app, { actor: { role: "tutor" }, spaceId: "personal", runId: null });
    expect(other.system).not.toContain("先看类型是否被 any 绕过");
    // Another role knows the skill by name only.
    expect(other.system).toMatch(/其他技能（用到时 read_skill 读全文）：.*ts-review/);
    expect(other.system).not.toContain("TypeScript 评审清单");
    // Inside a reviewer run, recall sees shared + its own.
    expect((await callTool(ctxFor(app, { role: "reviewer" }), "recall", {})).text).toMatch(/reviewer 专用/);
    expect((await callTool(ctxFor(app, { role: "tutor" }), "recall", {})).text).toBe("没有相关记忆。");
    // A spec cannot take a role's name.
    expect(() => saveAgentSpec(app, { name: "reviewer", description: "x", prompt: "y" }, "user")).toThrow(/内置角色/);
    app.db.close();
  });

  it("applies or rejects proposed changes; nothing changes before the owner says so", () => {
    const app = testApp();
    saveAgentSpec(app, { name: "code-review", description: "评审代码", prompt: "按约定评审。" }, "user");
    const p1 = createProposal(app, { target: "code-review", kind: "prompt", title: "先报阻塞问题", reason: "本人两次纠正 msg:m1", content: { prompt: "按约定评审。阻塞问题放在最前面，风格建议放最后。" }, runId: null });
    // The same title refines the pending proposal instead of adding another.
    expect(createProposal(app, { target: "code-review", kind: "prompt", title: "先报阻塞问题", reason: "又一次", content: { prompt: "按约定评审。阻塞问题放最前，风格建议放最后。" }, runId: null })).toBe(p1);
    expect(readAgentSpec(app, "code-review").prompt).toBe("按约定评审。");
    applyProposal(app, p1);
    expect(readAgentSpec(app, "code-review").prompt).toBe("按约定评审。阻塞问题放最前，风格建议放最后。");
    expect(() => applyProposal(app, p1)).toThrow(/处理过/);

    const p2 = createProposal(app, { target: "reviewer", kind: "skill", title: "Go 评审清单", reason: "评审 Go 改动反复漏 err 检查", content: { name: "go-review", description: "评审 Go 改动", body: "1. 每个 err 都处理了吗。" }, runId: null });
    applyProposal(app, p2);
    expect(findSkill(app, "go-review")?.status).toBe("active");
    expect(loadRole("reviewer", app).skills).toContain("go-review");

    const p3 = createProposal(app, { target: "code-review", kind: "settings", title: "加读会话", reason: "需要读本人原话", content: { add_tools: ["read_conversation"] }, runId: null });
    rejectProposal(app, p3);
    expect(readAgentSpec(app, "code-review").tools).not.toContain("read_conversation");
    expect(profileDetail(app, "code-review").proposals.map((p) => p.status).sort()).toEqual(["applied", "rejected"]);
    expect(() => createProposal(app, { target: "ghost", kind: "prompt", title: "x", reason: "", content: { prompt: "x".repeat(30) }, runId: null })).toThrow(/没有/);
    app.db.close();
  });

  it("gives the coach the profile's runs and what the owner said after each", () => {
    const app = testApp();
    saveAgentSpec(app, { name: "code-review", description: "评审代码", prompt: "按约定评审。" }, "user");
    const t = createThread(app, { spaceId: "personal", channel: "web" });
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "code-review：评审改动", input: { spec: "code-review", task: "评审", threadId: t.id } });
    const done = new Date().toISOString();
    run(app.db, "update runs set status = 'done', finished_at = ?, output = ? where id = ?", done, JSON.stringify({ answer: "没有问题。" }), r.id);
    // The owner corrects it right after.
    addMessage(app, t.id, "user", "漏了：错误码没有处理，以后评审先看错误处理。", null, {});
    const { runs, task } = reviewTask(app, "code-review", new Date(Date.now() - 3600_000).toISOString());
    expect(runs).toBe(1);
    expect(task).toContain(r.id);
    expect(task).toContain("以后评审先看错误处理");
    app.db.close();
  });
});
