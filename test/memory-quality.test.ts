import { describe, expect, it } from "vitest";
import { all, one, run } from "../src/core/db.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { checkMemory, memoryQualityStats, unreviewedMemories } from "../src/memory/quality.ts";
import { getMemory, listMemories, remember } from "../src/memory/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { createRun } from "../src/agents/runs.ts";
import { readAgentSpec, saveAgentSpec } from "../src/agents/specs.ts";
import { testApp } from "./helpers.ts";

const ctxFor = (app: ReturnType<typeof testApp>, extra: Record<string, unknown> = {}) =>
  toolContextForToken(app, issueToolToken({ runId: "r_test", spaceId: "personal", spaces: null, tools: null, actor: "agent", agentProfile: "codex", model: "gpt-x", effort: "low", role: "ingest", ...extra }))!;

describe("memory write-time checks", () => {
  it("flags hedging, document retelling, event logs, self reports, missing sources and duplicates", () => {
    const app = testApp();
    const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "note:a", title: "a", text: "项目 A 没有独立的测试环境" });
    const ok = { spaceId: "personal", kind: "fact" as const, sourceRefs: [`src:${src.id}#L1-L1`], requireSource: true };
    const codes = (content: string, extra: Record<string, unknown> = {}) => checkMemory(app, { ...ok, content, ...extra }).map((p) => p.code);
    expect(codes("项目 A 没有独立的测试环境。")).toEqual([]);
    expect(codes("机器人建议切换网络，但不能证明是网络问题，也无法确认用户版本，材料未见修复回执，后续应核对设备。")).toContain("hedge");
    expect(codes("截至2026-10-15入库的《开发机指南》说明，SSH 使用 Kerberos 认证。")).toContain("restates-source");
    expect(codes("2026-10-16小李反馈头像空白，机器人建议切换网络。")).toContain("event-log");
    expect(codes("2026-10-15，助理报告已提交修复。")).toContain("self-report");
    expect(codes("本次排查读取了日志然后发现超时。", { kind: "experience" })).toContain("process-log");
    expect(codes("一".repeat(450))).toContain("too-long");
    expect(codes(`项目 A 的发布约定：${"每周二下午发布，".repeat(30)}`)).not.toContain("too-long");
    expect(codes("项目 A 没有测试环境", { sourceRefs: [] })).toContain("no-source");
    expect(codes("项目 A 没有测试环境", { sourceRefs: ["src:nope#L1"] })).toContain("bad-source");
    remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 没有独立的测试环境。" });
    expect(codes("项目 A 没有独立的测试环境")).toContain("duplicate");
  });

  it("rejects through the tool with what to do instead, logs it per model, and lets the owner write freely", async () => {
    const app = testApp();
    const r = await callTool(ctxFor(app), "remember", { kind: "fact", content: "截至2026-10-16收录的《差旅报销制度》说明，住宿标准为每晚 500 元。", source_refs: [] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/没有保存/);
    expect(r.text).toMatch(/原件本身可检索/);
    expect(listMemories(app, { status: "all" })).toHaveLength(0);
    const rej = all<{ model: string; codes: string }>(app.db, "select model, codes from memory_rejections");
    expect(rej[0].model).toBe("gpt-x");
    expect(JSON.parse(rej[0].codes)).toContain("restates-source");

    const user = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "user" }))!;
    expect((await callTool(user, "remember", { kind: "fact", content: "截至今天收录的说明：随便写" })).isError).toBe(false);
    const stats = memoryQualityStats(app);
    expect(stats.find((s) => s.model.includes("gpt-x"))).toMatchObject({ rejected: 1 });
  });

  it("scopes an agent spec's procedures to that spec and supports tags", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "oncall", description: "值班", prompt: "处理报警。" }, "user");
    const spec = ctxFor(app, { role: undefined, spec: "oncall" });
    const r = await callTool(spec, "remember", { kind: "experience", content: "遇到报警先看最近一次发布记录。", tags: ["报警"] });
    expect(r.text).toMatch(/仅 oncall 使用/);
    const m = listMemories(app, {})[0];
    expect(m).toMatchObject({ agent: "oncall", tags: ["报警"] });
    const other = ctxFor(app, { role: undefined, spec: "writer" });
    expect((await callTool(other, "recall", {})).text).toBe("没有相关记忆。");
    expect((await callTool(spec, "recall", { tag: "报警" })).text).toMatch(/oncall 专用/);
  });

  it("lets the main assistant teach a named spec and read that spec's memories back", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "reviewer", description: "代码评审", prompt: "按项目约定评审。" }, "user");
    // Main assistant has no spec of its own; naming the taught agent writes into its scope.
    const main = ctxFor(app, { role: undefined, spec: null });
    const r = await callTool(main, "remember", { kind: "preference", subject: "风格", content: "评审时先报阻塞问题，风格建议放最后。", agent: "reviewer" });
    expect(r.text).toMatch(/仅 reviewer 使用/);
    expect(listMemories(app, {})[0]).toMatchObject({ agent: "reviewer" });
    // The main assistant orchestrates and sees everything; a different spec sees none,
    // and naming the taught spec scopes the recall to it.
    expect((await callTool(main, "recall", {})).text).toMatch(/reviewer 专用/);
    expect((await callTool(ctxFor(app, { role: undefined, spec: "other-agent" }), "recall", {})).text).toBe("没有相关记忆。");
    expect((await callTool(main, "recall", { agent: "reviewer" })).text).toMatch(/reviewer 专用/);
    // Unknown spec names are rejected rather than silently creating garbage scope.
    const bad = await callTool(main, "remember", { kind: "preference", content: "测试。", agent: "ghost" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/没有 Agent 档案 ghost/);
  });

  it("attaches a saved skill to a named agent, to the running spec by default, or nowhere with attach=false", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "reviewer", description: "代码评审", prompt: "按项目约定评审。" }, "user");
    saveAgentSpec(app, { name: "oncall", description: "值班", prompt: "处理报警。" }, "user");
    const main = ctxFor(app, { role: undefined, spec: null });

    // Main assistant teaches a specific spec.
    const r1 = await callTool(main, "save_skill", { name: "review-rules", description: "评审规则", body: "# 步骤\n1. 先看阻塞问题。", agent: "reviewer" });
    expect(r1.text).toMatch(/挂到 reviewer/);
    expect(readAgentSpec(app, "reviewer").skills).toContain("review-rules");
    expect(readAgentSpec(app, "oncall").skills).not.toContain("review-rules");

    // Re-saving does not duplicate the frontmatter entry.
    await callTool(main, "save_skill", { name: "review-rules", description: "评审规则", body: "# 步骤\n1. 更新。", agent: "reviewer" });
    expect(readAgentSpec(app, "reviewer").skills.filter((x) => x === "review-rules")).toHaveLength(1);

    // A run inside a spec attaches the skill to that spec by default.
    const oncall = ctxFor(app, { role: undefined, spec: "oncall" });
    await callTool(oncall, "save_skill", { name: "alarm-checklist", description: "报警检查", body: "# x" });
    expect(readAgentSpec(app, "oncall").skills).toContain("alarm-checklist");

    // attach=false keeps the skill global and changes no spec.
    await callTool(main, "save_skill", { name: "general-thing", description: "通用做法", body: "# x", attach: false });
    expect(readAgentSpec(app, "reviewer").skills).not.toContain("general-thing");

    // Unknown target spec is rejected after the skill file is created (caller learns the name problem).
    const bad = await callTool(main, "save_skill", { name: "orphan-skill", description: "x", body: "# x", agent: "ghost" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/没有 Agent 档案 ghost/);
  }, 60_000);
});

describe("shadow runs and review", () => {
  it("records shadow writes without applying them, still checks memories, and grades them blind", async () => {
    const app = testApp();
    const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "note:b", title: "b", text: "预算 120 元" });
    const shadow = ctxFor(app, { runId: "r_shadow", model: "other-model", shadow: { parentRunId: "r_main" } });
    const ok = await callTool(shadow, "remember", { kind: "fact", content: "项目 A 预算 120 元。", source_refs: [`src:${src.id}#L1`] });
    expect(ok.text).toMatch(/对比运行/);
    expect(await callTool(shadow, "upsert_item", { kind: "todo", title: "x" })).toMatchObject({ isError: false });
    expect(listMemories(app, { status: "all" })).toHaveLength(0);
    expect(one<{ n: number }>(app.db, "select count(*) n from items")!.n).toBe(0);
    const bad = await callTool(shadow, "remember", { kind: "fact", content: "无法确认预算，不能证明已批准，材料未见回执，须进一步核对，暂不能视为结论。", source_refs: [`src:${src.id}#L1`] });
    expect(bad.text).toMatch(/没有保存/);
    expect(one<{ shadow: number }>(app.db, "select shadow from memory_rejections")!.shadow).toBe(1);

    const live = remember(app, { spaceId: "personal", kind: "fact", content: "项目 B 由小王负责。", createdBy: "agent", model: "gpt-x" });
    expect(unreviewedMemories(app).map((m) => m.id)).toEqual([live.id]);
    const sw = one<{ id: string }>(app.db, "select id from shadow_writes where tool = 'remember'")!.id;
    const reviewer = ctxFor(app, { role: "memory-reviewer", model: "judge" });
    const out = await callTool(reviewer, "review_memories", {
      verdicts: [
        { memory_id: live.id, verdict: "rewrite", reason: "主语不清", content: "小王负责项目 B。" },
        { memory_id: sw, verdict: "keep", reason: "有来源" },
      ],
    });
    expect(out.text).toMatch(/已改写/);
    expect(getMemory(app, live.id)).toMatchObject({ status: "superseded", reviewVerdict: "rewrite" });
    const next = listMemories(app, { status: "active" })[0];
    expect(next).toMatchObject({ content: "小王负责项目 B。", reviewVerdict: "keep" });
    const stats = memoryQualityStats(app);
    expect(stats.find((s) => s.model.includes("other-model"))).toMatchObject({ shadow: 1, kept: 1, rejected: 1 });
    expect(stats.find((s) => s.model.includes("gpt-x"))).toMatchObject({ stored: 1, rewritten: 1 });
  });

  it("splits a memory that holds several independent conclusions", async () => {
    const app = testApp();
    const m = remember(app, { spaceId: "personal", kind: "agreement", subject: "项目 A", content: "项目 A 周四评审，预算 120 元，由小王负责。", createdBy: "agent", tags: ["项目A"] });
    const reviewer = ctxFor(app, { role: "memory-reviewer", model: "judge" });
    const out = await callTool(reviewer, "review_memories", {
      verdicts: [{ memory_id: m.id, verdict: "split", reason: "三件事", contents: ["项目 A 在周四评审。", "项目 A 预算 120 元。", "小王负责项目 A。"] }],
    });
    expect(out.text).toMatch(/已拆成/);
    const now = listMemories(app, { status: "active" });
    expect(now.map((x) => x.content).sort()).toEqual(["小王负责项目 A。", "项目 A 在周四评审。", "项目 A 预算 120 元。"].sort());
    expect(now.every((x) => x.reviewVerdict === "keep" && x.tags?.includes("项目A"))).toBe(true);
    expect(getMemory(app, m.id)).toMatchObject({ status: "superseded", reviewVerdict: "rewrite" });
  });
});

import { recordRecalls, recallStats, memoriesWithRecall, usedMemoryIds, markUsed } from "../src/memory/recall-stats.ts";

describe("recall accounting", () => {
  it("counts recalls and whether a run used the memory", async () => {
    const app = testApp();
    const m1 = remember(app, { spaceId: "personal", kind: "fact", content: "事实 A：用于回答的。", sourceRefs: [] });
    const m2 = remember(app, { spaceId: "personal", kind: "fact", content: "事实 B：召回了但没用。", sourceRefs: [] });
    const r1 = createRun(app, { kind: "ask", spaceId: "personal", title: "t", input: {} });
    recordRecalls(app, [m1.id, m2.id], { runId: r1.id, profile: "p", spec: undefined });
    // An earlier run recalled m1 without using it: run 1 using it must not count for that run.
    const r0 = createRun(app, { kind: "ask", spaceId: "personal", title: "t0", input: {} });
    recordRecalls(app, [m1.id], { runId: r0.id, profile: "p", spec: undefined });
    // run 1 references m1 in its output
    run(app.db, "update runs set output=? where id=?", JSON.stringify({ answer: `参考 ${m1.id}` }), r1.id);
    markUsed(app, r1.id, usedMemoryIds(app, r1.id, [m1.id, m2.id]));
    const s = recallStats(app);
    expect(s.total).toBe(2);
    expect(s.recalled).toBe(2);
    expect(s.totalRecalls).toBe(3);
    expect(s.usedRecalls).toBe(1);
    const rows = memoriesWithRecall(app, { sort: "unused" });
    const a = rows.find((x) => x.id === m1.id)!;
    const b = rows.find((x) => x.id === m2.id)!;
    expect(a.recalls).toBe(2);
    expect(a.used).toBe(1);
    expect(b.used).toBe(0);
    app.db.close();
  });
});
