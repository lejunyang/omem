import { describe, expect, it } from "vitest";
import { all, one } from "../src/core/db.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { checkMemory, memoryQualityStats, unreviewedMemories } from "../src/memory/quality.ts";
import { getMemory, listMemories, remember } from "../src/memory/store.ts";
import { upsertSource } from "../src/sources/store.ts";
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
    expect(codes("一".repeat(200))).toContain("too-long");
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
    const spec = ctxFor(app, { role: undefined, spec: "oncall" });
    const r = await callTool(spec, "remember", { kind: "experience", content: "遇到报警先看最近一次发布记录。", tags: ["报警"] });
    expect(r.text).toMatch(/仅 oncall 使用/);
    const m = listMemories(app, {})[0];
    expect(m).toMatchObject({ agent: "oncall", tags: ["报警"] });
    const other = ctxFor(app, { role: undefined, spec: "writer" });
    expect((await callTool(other, "recall", {})).text).toBe("没有相关记忆。");
    expect((await callTool(spec, "recall", { tag: "报警" })).text).toMatch(/oncall 专用/);
  });
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
});
