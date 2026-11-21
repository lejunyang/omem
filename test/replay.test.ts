import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { sandboxSupport } from "../src/agents/sandbox.ts";
import { stopWorker } from "../src/agents/runs.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { applyEffects, checkArm, combine, crossCheck, JUDGE_NOT_CHOSEN, judgeChoice, modelStep, replayDigest, resolveEffect, scheduleReplays, selectQuestions, touchedBy } from "../src/agents/replay.ts";
import { axisApplies, precheck, questionOf } from "../src/agents/replay.ts";
import { fittingSkills, skillCandidates, skillTally } from "../src/agents/replay-skills.ts";
import { saveAgentSpec, saveSkill, readSkill } from "../src/agents/specs.ts";
import { createProposal, expireProposals } from "../src/agents/proposals.ts";
import { profileDetail } from "../src/agents/profiles.ts";
import { setEmbedderForTests } from "../src/search/embeddings.ts";
import { visibleLines, visibleMemories, type RunView } from "../src/agents/replay-view.ts";
import { createRun, getRun, listRuns, waitForRun } from "../src/agents/runs.ts";
import { addMessage, ensureConversation } from "../src/agents/threads.ts";
import { callTool } from "../src/agents/tools.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { remember, retract, supersede } from "../src/memory/store.ts";
import { setAttention } from "../src/sources/attention.ts";
import { upsertSource } from "../src/sources/store.ts";
import { fakeEmbedder, testApp as makeTestApp } from "./helpers.ts";

// These tests exercise file writes and adoption without creating library Git history.
vi.mock("../src/core/git.ts", async (original) => ({ ...await original<typeof import("../src/core/git.ts")>(), ensureLibraryRepo: () => {}, commitLibrary: () => null }));

const cleanupApps: App[] = [];
function testApp() { const app = makeTestApp(); cleanupApps.push(app); return app; }
afterAll(async () => {
  stopWorker();
  for (const app of cleanupApps) app.db.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const app of cleanupApps) {
    try { rmSync(app.home, { recursive: true, force: true }); }
    catch { console.log(`Temporary test directory awaiting process exit: ${app.home}`); }
  }
}, 60000);

const FAKE = { id: "fake", transport: "acp" as const, command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: {}, idleTimeoutMs: 600_000 };
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("K1 candidates, rotation and expiry", () => {
  it("matches drafts and proposals, respects profile/role ownership and tries each candidate once per question", async () => {
    const app = testApp();
    try {
      saveSkill(app, { name: "refund", description: "退款对账如何核对", body: "先核对流水", status: "draft" });
      saveAgentSpec(app, { name: "accounting", description: "核对账目", prompt: "核对账目", skills: ["refund"] });
      saveAgentSpec(app, { name: "other", description: "其他档案", prompt: "回答问题" });
      const q = { question: "退款对账如何核对", spec: "other", run: { id: "r-other" } };
      expect(await fittingSkills(app, q)).toEqual([]);
      expect(await fittingSkills(app, { ...q, spec: null })).toEqual([]);
      expect((await fittingSkills(app, { ...q, spec: "accounting" }))[0].id).toBe("skill:refund");
      const proposal = createProposal(app, { target: "assistant", kind: "skill", title: "核对", reason: "反复使用", content: { name: "audit", description: q.question, body: "先查原件" }, runId: null });
      expect((await fittingSkills(app, { ...q, spec: null }))[0].id).toBe(`proposal:${proposal}`);
      expect(skillCandidates(app)).toHaveLength(2);
      run(app.db, "insert into replays(id, axis, signal, variant, base_run_id, as_of, status, at) values('rp-tried', 'K1', 'normal', ?, ?, ?, 'done', ?)", JSON.stringify({ candidateId: `proposal:${proposal}` }), q.run.id, at(-1), at(-1));
      expect(await fittingSkills(app, { ...q, spec: null })).toEqual([]);
      // The async precheck supplies K1 applicability; axisApplies itself stays synchronous.
      const base = pastAsk(app, q.question, "原回答");
      const question = questionOf(app, one<any>(app.db, "select * from runs where id = ?", base.runId)!)!;
      const pre = await precheck(app, question);
      expect(axisApplies(app, "K1", { q: question, pre, signal: "normal", touched: { memories: [], sources: [], pages: [] }, tried: new Set() })).toBe(true);
      app.config.embeddings.provider = "local";
      setEmbedderForTests(fakeEmbedder());
      expect((await fittingSkills(app, { ...q, spec: "accounting", run: { id: "r-vector" } }))[0].score).toBeGreaterThanOrEqual(0.5);
      expect(await fittingSkills(app, { ...q, question: "天气晴朗", spec: "accounting" })).toEqual([]);
    } finally { setEmbedderForTests(null);  }
  });

  it("swaps only the weakest unprotected pick for the best fitting recent question, at most once", async () => {
    const app = testApp();
    {
      app.config.agents.profiles = [FAKE];
      app.config.agents.roles["replay-judge"] = "fake";
      app.config.replay.plan.normal = ["A1"];
      app.config.replay.max = 2;
      saveSkill(app, { name: "refund", description: "退款对账如何核对", body: "核对流水", status: "draft" });
      const best = pastAsk(app, "退款对账如何核对", "原回答", { minutesAgo: 100 });
      pastAsk(app, "退款对账是否完成", "原回答", { minutesAgo: 90 });
      pastAsk(app, "周报写了吗", "原回答", { minutesAgo: 10 });
      const neg = pastAsk(app, "发布窗口是哪天", "原回答", { minutesAgo: 5 });
      run(app.db, "insert into feedback(id, channel, message_id, run_id, actor_id, actor_kind, emoji, polarity, at) values('fb-k1', 'lark', 'om_demo', ?, 'u1', 'owner', 'ThumbsDown', 'negative', ?)", neg.runId, at(-4));
      const picks = await selectQuestions(app, { skillTurn: true });
      const inputs = picks.map((p) => ({ baseRunId: p.runId, signal: p.signal, axis: p.axis, candidateId: p.candidateId }));
      expect(inputs).toEqual(expect.arrayContaining([
        expect.objectContaining({ baseRunId: neg.runId, signal: "negative" }),
        expect.objectContaining({ baseRunId: best.runId, axis: "K1", candidateId: "skill:refund" }),
      ]));
      expect(inputs.filter((p) => p.axis === "K1")).toHaveLength(1);
      app.config.replay.max = 1;
      expect((await selectQuestions(app, { skillTurn: true }))[0]).toMatchObject({ runId: neg.runId, signal: "negative" });
      run(app.db, "delete from feedback where id = 'fb-k1'");
      const correction = addMessage(app, neg.conv, "user", "不对，是周五");
      run(app.db, "update messages set created_at = ? where id = ?", at(-2), correction);
      const corrected = questionOf(app, one<any>(app.db, "select * from runs where id = ?", neg.runId)!)!;
      expect(corrected.reaction.said).toBe("不对，是周五");
      expect((await selectQuestions(app, { skillTurn: true }))[0]).toMatchObject({ runId: neg.runId, signal: "correction" });
    }
  });

  it("keeps a winning proposal while it awaits more wins, including when automatic adoption is disabled", async () => {
    const app = testApp();
    {
      const id = createProposal(app, { target: "assistant", kind: "skill", title: "核对", reason: "反复使用", content: { name: "audit", description: "退款核对", body: "先查原件" }, runId: null });
      const ignored = createProposal(app, { target: "assistant", kind: "skill", title: "其他", reason: "建议", content: { name: "other", description: "其他", body: "做法" }, runId: null });
      run(app.db, "update profile_proposals set created_at = ?, expiry_notice_at = ?", at(-30 * 1440), at(-5 * 1440));
      run(app.db, "insert into replays(id, axis, signal, variant, base_run_id, as_of, status, verdict, at) values('rp-expiry', 'K1', 'normal', ?, 'r0', ?, 'done', 'win', ?)", JSON.stringify({ candidateId: `proposal:${id}` }), at(-60), at(-1));
      applyEffects(app, "rp-expiry");
      expect((await expireProposals(app)).expired).toBe(1);
      expect(one<any>(app.db, "select status from profile_proposals where id = ?", id).status).toBe("pending");
      expect(one<any>(app.db, "select status from profile_proposals where id = ?", ignored).status).toBe("expired");
      app.config.replay.skills.adoptAfter = 0;
      expect((await expireProposals(app, Date.now() + 60 * 86400_000)).expired).toBe(0);
      expect(profileDetail(app, "assistant").proposals.find((p) => p.id === id)?.replay).toMatchObject({ wins: 1, losses: 0, adopted: false });
    }
  });
});

/** A finished ask run: the owner's question in a conversation and the assistant's answer. */
function pastAsk(app: App, question: string, answer: string, opts: { minutesAgo?: number; ai?: Record<string, string> } = {}) {
  const conv = ensureConversation(app, { spaceId: "personal" });
  const q = addMessage(app, conv, "user", question);
  const r = createRun(app, { kind: "ask", spaceId: "personal", title: question, input: { conversationId: conv, messageIds: [q] } });
  addMessage(app, conv, "assistant", answer, r.id);
  const t = at(-(opts.minutesAgo ?? 60));
  run(app.db, "update messages set created_at = ? where id = ?", t, q);
  run(app.db, "update runs set status = 'done', created_at = ?, started_at = ?, finished_at = ?, output = ?, ai = ? where id = ?", t, t, at(-(opts.minutesAgo ?? 60) + 1), JSON.stringify({ answer }), JSON.stringify(opts.ai ?? { profile: "fake", model: "m1", effort: "medium" }), r.id);
  return { runId: r.id, conv, asOf: t };
}

describe("replay: as of the question's time", () => {
  const app = testApp();

  it("sees memories through the supersede chain and nothing written later", () => {
    const old = remember(app, { spaceId: "personal", kind: "fact", content: "发布在周四。" });
    const later = remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 的值班表在共享盘。" });
    const gone = remember(app, { spaceId: "personal", kind: "fact", content: "小王负责退款对账。" });
    run(app.db, "update memories set created_at = ? where id in (?, ?)", at(-120), old.id, gone.id);
    run(app.db, "update memories set created_at = ? where id = ?", at(-10), later.id);
    const fixed = supersede(app, old.id, { content: "发布改到周五。" });
    retract(app, gone.id, "本人说小王已经调岗");
    const view: RunView = { asOf: at(-60) };
    const seen = visibleMemories(app, view, [old.id, fixed.id, later.id, gone.id]);
    // The old version held then; its correction and the later memory did not exist yet; the retraction came later.
    expect([...seen].sort()).toEqual([old.id, gone.id].sort());
    expect(visibleMemories(app, { ...view, memoryFilter: { exclude: [old.id] } }, [old.id, gone.id])).toEqual(new Set([gone.id]));
    expect(visibleMemories(app, { ...view, memoryFilter: { all: true } }, [old.id]).size).toBe(0);
    // Without as-of only what is active now.
    expect([...visibleMemories(app, {}, [old.id, fixed.id, gone.id])]).toEqual([fixed.id]);
  });

  it("recall and read_source give the memory as it was, without the later retraction note", async () => {
    const m = remember(app, { spaceId: "personal", kind: "fact", content: "报销单每月 25 日截止。" });
    run(app.db, "update memories set created_at = ? where id = ?", at(-200), m.id);
    retract(app, m.id, "制度已改");
    const ctx = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const, userId: "owner", view: { asOf: at(-100), cache: new Map() } };
    const r = await callTool(ctx, "recall", { query: "报销单" });
    expect(r.text).toContain(m.id);
    expect(r.text).not.toContain("撤回原因");
    expect(r.text).not.toContain("retracted");
    const s = await callTool(ctx, "read_source", { source: `mem:${m.id}` });
    expect(s.isError).toBe(false);
    const now = await callTool({ ...ctx, view: undefined }, "recall", { query: "报销单" });
    expect(now.text).not.toContain(m.id);
  });

  it("cuts chats and conversations at the question, hides sources captured later, flags later documents", async () => {
    const t = new Date(Date.now() - 3 * 3600_000);
    const minute = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
    const before = new Date(t.getTime() - 30 * 60_000);
    const afterT = new Date(t.getTime() + 30 * 60_000);
    const chat = upsertSource(app, {
      spaceId: "personal", kind: "chat", uri: "chat:demo-group", title: "项目 A 群",
      text: [`[${minute(before)}] 小王: 退款上线定在周三 (om_1)`, "  （补充：先灰度）", `[${minute(afterT)}] 小李: 不对，改到周五了 (om_2)`].join("\n"),
    });
    run(app.db, "update sources set captured_at = ? where id = ?", new Date(t.getTime() - 3600_000).toISOString(), chat.id);
    const view: RunView = { asOf: t.toISOString(), cache: new Map() };
    expect(visibleLines(app, view, chat.id, one<{ text: string }>(app.db, "select text from sources where id = ?", chat.id)!.text)).toEqual([true, true, false]);
    const ctx = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const, userId: "owner", view };
    const read = await callTool(ctx, "read_source", { source: chat.id });
    expect(read.text).toContain("周三");
    expect(read.text).not.toContain("周五");
    expect(read.text).toContain("晚于提问时间");
    const scan = await callTool(ctx, "scan", { terms: ["周五", "周三"] });
    expect(scan.text).toContain("周三");
    expect(scan.text).not.toContain("周五");
    // A document captured after the question does not exist for the arm.
    const late = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "late.md", title: "复盘纪要", text: "退款上线最终定在周五。" });
    const hidden = await callTool(ctx, "read_source", { source: late.id });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain("提问之后");
    // One that existed but changed later is shown, flagged.
    run(app.db, "update sources set captured_at = ? where id = ?", new Date(t.getTime() - 3600_000).toISOString(), late.id);
    const flagged = await callTool(ctx, "read_source", { source: late.id });
    expect(flagged.text).toContain("可能包含提问之后的信息");
    // Source levels: S1 leaves normal sources out.
    const s1 = await callTool({ ...ctx, view: { ...view, sourceLevels: ["focus", "reference"] } }, "read_source", { source: late.id });
    expect(s1.isError).toBe(true);
    setAttention(app, [late.id], "reference", "owner");
    expect((await callTool({ ...ctx, view: { ...view, sourceLevels: ["focus", "reference"] } }, "read_source", { source: late.id })).isError).toBe(false);
  });
});

describe("replay: checks, judge, effects", () => {
  const app = testApp();

  it("checks references without a model: missing, out of range, after the question (void)", () => {
    const s = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "plan.md", title: "计划", text: "第一行\n第二行\n第三行" });
    run(app.db, "update sources set captured_at = ? where id = ?", at(-300), s.id);
    const asOf = at(-60);
    const ok = checkArm(app, asOf, `见 [计划](src:${s.id}#L2-L3)`, null);
    expect(ok.ok).toBe(true);
    expect(ok.cites[0].text).toContain("第二行");
    const bad = checkArm(app, asOf, `见 src:${s.id}#L2-L9 和 src:nosuchsource`, null);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/行号越界/);
    expect(bad.problems.join(" ")).toMatch(/不存在/);
    const m = remember(app, { spaceId: "personal", kind: "fact", content: "后来才记下的事实。" });
    const leak = checkArm(app, asOf, `依据 mem:${m.id}`, null);
    expect(leak.leaks.length).toBe(1);
    expect(checkArm(app, asOf, "", "模型 600 秒内没有开始回答").problems[0]).toMatch(/运行失败/);
    // "Not found" while the other arm cites a line that is there: the not-found arm fails.
    const a = checkArm(app, asOf, "没有找到相关记录。", null);
    const b = checkArm(app, asOf, `在 src:${s.id}#L1`, null);
    crossCheck(a, b);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
  });

  it("counts a win only when both orders agree", () => {
    const v = (better: "甲" | "乙" | "平") => ({ better, reason: "", taskType: null });
    // Order 1: 甲 = baseline; order 2: 甲 = variant.
    expect(combine(v("乙"), v("甲"))).toEqual({ verdict: "win", agree: true });
    expect(combine(v("甲"), v("乙"))).toEqual({ verdict: "loss", agree: true });
    expect(combine(v("平"), v("平"))).toEqual({ verdict: "tie", agree: true });
    expect(combine(v("乙"), v("乙"))).toEqual({ verdict: "tie", agree: false });
    expect(combine(null, v("甲"))).toMatchObject({ verdict: "tie", agree: false });
  });

  it("applies what a decided replay says: memory re-review, helped counts, suggestions the owner adopts", () => {
    const mem = remember(app, { spaceId: "personal", kind: "experience", content: "查退款时先看对账群。" });
    run(app.db, "update memories set reviewed_at = ?, review_verdict = 'keep' where id = ?", at(-10), mem.id);
    const base = pastAsk(app, "退款对账去哪看", "去对账群看。").runId;
    const row = (axis: string, verdict: string, extra: Record<string, unknown> = {}) => {
      const id = `rp${Math.random().toString(36).slice(2, 14)}`;
      run(app.db, "insert into replays(id, signal, axis, variant, as_of, base_run_id, checks, verdict, status, at, finished_at) values(?,?,?,?,?,?,?,?,?,?,?)", id, "correction", axis, JSON.stringify({ question: "退款对账去哪看", ...extra }), at(-60), base, JSON.stringify(extra.checks ?? {}), verdict, "done", now(), now());
      return id;
    };
    const now = () => new Date().toISOString();
    applyEffects(app, row("M1", "win", { exclude: [mem.id] }));
    const m = one<{ reviewed_at: string | null; review_note: string }>(app.db, "select reviewed_at, review_note from memories where id = ?", mem.id)!;
    expect(m.reviewed_at).toBeNull();
    expect(m.review_note).toMatch(/^复盘 rp/);
    applyEffects(app, row("M1", "loss", { exclude: [mem.id] }));
    expect(one<{ n: number }>(app.db, "select count(*) n from replay_effects where effect = 'helped' and target_id = ?", mem.id)!.n).toBe(1);
    // S1: the baseline cited a normal-level source and lost → a suggestion to lower it, applied only when adopted.
    const src = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "old-guide.md", title: "旧指南", text: "对账在旧系统。" });
    const s1 = row("S1", "win", { checks: { baseline: { cites: [{ ref: `src:${src.id}#L1`, ok: true }] }, variant: { cites: [] } } });
    const [effect] = applyEffects(app, s1);
    expect(one<{ status: string }>(app.db, "select status from replay_effects where id = ?", effect)!.status).toBe("pending");
    expect(one<{ attention: string | null }>(app.db, "select attention from sources where id = ?", src.id)!.attention).toBeNull();
    expect(resolveEffect(app, effect, "adopt").status).toBe("adopted");
    expect(one<{ attention: string | null }>(app.db, "select attention from sources where id = ?", src.id)!.attention).toBe("reference");
    expect(resolveEffect(app, effect, "ignore").message).toBe("已经处理过了");
    // The morning card section lists them; nothing ran → no section.
    const d = replayDigest(app, at(-30));
    expect(d?.text).toMatch(/昨晚复盘（3 题）/);
    expect(replayDigest(app, at(30))).toBeNull();
  });

  it("turns model-axis replays into routing evidence per model and task type (n < 3 left out)", async () => {
    const { replayModelEvidence } = await import("../src/agents/replay.ts");
    const add = (verdict: string, type: string) => {
      const arm = createRun(app, { kind: "replay-arm", spaceId: "personal", title: "基线" });
      run(app.db, "update runs set status = 'done', ai = ? where id = ?", JSON.stringify({ profile: "fake", model: "big" }), arm.id);
      run(app.db, "insert into replays(id, signal, axis, variant, as_of, base_run_id, baseline_run_id, verdict, task_type, cost, status, at) values(?, 'normal', 'A1', ?, ?, 'r0', ?, ?, ?, ?, 'done', ?)",
        `rp${Math.random().toString(36).slice(2, 14)}`, JSON.stringify({ ai: { profile: "fake", model: "small" } }), at(-60), arm.id, verdict, type, JSON.stringify({ baseline: { peak: 1000 }, variant: { peak: 500 } }), at(-5));
    };
    for (const v of ["tie", "tie", "win"]) add(v, "事实查询");
    add("loss", "排查");
    const ev = replayModelEvidence(app);
    expect(ev.get("fake|small")).toEqual([{ type: "事实查询", vs: "fake · big", w: 1, t: 2, l: 0, tokens: 0.5 }]);
    expect(ev.get("fake|big")).toEqual([{ type: "事实查询", vs: "fake · small", w: 0, t: 2, l: 1, tokens: 2 }]);
  });

  it("steps the model along the owner's ladder, else one effort level", () => {
    app.config.agents.profiles = [FAKE];
    expect(modelStep(app, { profile: "fake", model: "m1", effort: "medium" }, -1)).toEqual({ profile: "fake", model: "m1", effort: "low" });
    expect(modelStep(app, { profile: "fake", model: "m1", effort: "xhigh" }, 1)).toBeNull();
    app.config.replay.models = [{ profile: "fake", model: "small" }, { profile: "fake", model: "m1" }, { profile: "fake", model: "large", effort: "high" }];
    expect(modelStep(app, { profile: "fake", model: "m1", effort: "medium" }, 1)).toEqual({ profile: "fake", model: "large", effort: "high" });
    expect(modelStep(app, { profile: "fake", model: "m1", effort: "medium" }, -1)).toEqual({ profile: "fake", model: "small", effort: undefined });
    app.config.replay.models = [];
  });
});

describe("replay: choosing questions", () => {
  const app = testApp();
  app.config.agents.profiles = [FAKE];

  it("does not run without a judge the owner chose, and says why", async () => {
    expect(judgeChoice(app).chosen).toBe(false);
    const r = await scheduleReplays(app);
    expect(r).toEqual({ skipped: JUDGE_NOT_CHOSEN, runs: [] });
    expect(JSON.parse(one<{ value: string }>(app.db, "select value from kv where key = 'replay_last'")!.value).skipped).toBe(JUDGE_NOT_CHOSEN);
    expect(listRuns(app, { kind: "replay" })).toHaveLength(0);
  });

  it("ranks by signal, picks one axis per question, keeps to replay.max and never repeats an axis", async () => {
    const neg = pastAsk(app, "项目 A 的发布窗口是哪天", "周四。", { minutesAgo: 30 });
    run(app.db, "insert into feedback(id, channel, message_id, run_id, actor_id, actor_kind, emoji, polarity, at) values('fb1', 'lark', 'om_x', ?, 'u1', 'owner', 'ThumbsDown', 'negative', ?)", neg.runId, at(-20));
    const mem = remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 每周四发布。" });
    run(app.db, "insert into memory_recalls(memory_id, run_id, used, at, via) values(?, ?, 1, ?, 'recall')", mem.id, neg.runId, at(-29));
    expect(touchedBy(app, neg.runId, "周四。").memories).toEqual([mem.id]);
    const normal = pastAsk(app, "上周的周报写了吗", "写了，见周报。", { minutesAgo: 50 });
    const nf = pastAsk(app, "差旅报销制度在哪", "没有找到相关资料。", { minutesAgo: 40 });
    const ignored = upsertSource(app, { spaceId: "personal", kind: "doc", uri: "travel.md", title: "差旅报销制度", text: "差旅报销制度：住宿按城市分档。" });
    run(app.db, "update sources set captured_at = ? where id = ?", at(-500), ignored.id);
    setAttention(app, [ignored.id], "ignore", "owner");

    app.config.replay.max = 1;
    const one_ = await selectQuestions(app);
    expect(one_).toEqual([expect.objectContaining({ runId: neg.runId, signal: "negative", axis: "M1" })]);

    app.config.replay.max = 3;
    const three = await selectQuestions(app);
    expect(three.map((p) => [p.runId, p.signal, p.axis])).toEqual([
      [neg.runId, "negative", "M1"],
      [nf.runId, "notFound", "S2"],
      [normal.runId, "normal", "A1"],
    ]);
    // An axis tried on a question is not tried again: the next one in the plan, or none.
    run(app.db, "insert into replays(id, signal, axis, as_of, base_run_id, status, verdict, at) values('rpdone1', 'negative', 'M1', ?, ?, 'done', 'tie', ?)", neg.asOf, neg.runId, at(-1));
    const again = await selectQuestions(app);
    expect(again.find((p) => p.runId === neg.runId)?.axis).not.toBe("M1");
    app.config.replay.max = 2;
    expect((await selectQuestions(app)).length).toBeLessThanOrEqual(2);
  });
});

describe("replay end to end over ACP: both arms read only, the judge in both orders", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-replay-"));
  const judgeSays = JSON.stringify({ better: "乙", reason: "乙引用了原文", taskType: "事实查询" });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      agents: {
        default: "fake",
        roles: { "replay-judge": "fake-judge" },
        profiles: [
          { id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")] },
          { id: "fake-judge", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_SAY: judgeSays } },
        ],
      },
    }),
  );
  const { boot } = await import("../src/main.ts");
  const { ask } = await import("../src/agents/jobs.ts");
  const { importText } = await import("../src/sources/import.ts");
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  cleanupApps.push(app);
  afterAll(async () => { await server.close(); });

  it.skipIf(!sandboxSupport().ok)("runs the sandboxed Doubao replay judge with backend approvals off", async () => {
    const fixture = { ...FAKE, id: "fixture-judge", transport: "doubao-cli" as const,
      args: [resolve("test/fake-doubao-cli.ts")], env: { FAKE_PERMISSION: "1" } };
    const original = app.config.agents;
    const login = mkdtempSync(join(tmpdir(), "judge-home-"));
    vi.stubEnv("HOME", login);
    app.config.agents = { ...original, roles: { ...original.roles, "replay-judge": fixture.id },
      profiles: [...original.profiles, fixture], ownSandbox: { mode: "require", writable: [], hidden: [] }, fullAccess: "sandboxed" };
    try {
      const q = pastAsk(app, "材料约定了什么", "请查看原文", { ai: { profile: "fake" } });
      const scheduled = await scheduleReplays(app, { runId: q.runId, axis: "R1" });
      const done = await waitForRun(app, scheduled.runs[0]);
      const judges = listRuns(app, { parentId: done.id }).filter(r => r.kind === "replay-judge");
      expect(judges).toHaveLength(2);
      for (const judge of judges) expect(getRun(app, judge.id).output.verdict).toMatchObject({ reason: "always_allow" });
    } finally {
      app.config.agents = original; vi.unstubAllEnvs(); rmSync(login, { recursive: true, force: true });
    }
  }, 60000);

  it("replays an answered question: a baseline and an R1 variant, checked and judged, nothing written", async () => {
    importText(app, "personal", { title: "约定", text: "每周四下午三点和小王同步项目A进度。" });
    const { runId } = await ask(app, { text: "和小王什么时候同步" });
    const original = await waitForRun(app, runId!);
    expect(original.status).toBe("done");
    const toolsOf = (answer: unknown) => Number(/^tools=(\d+);/.exec(String(answer))?.[1]);
    const memoriesBefore = one<{ n: number }>(app.db, "select count(*) n from memories")!.n;
    const r = await scheduleReplays(app, { runId: runId!, axis: "R1" });
    expect(r.skipped).toBeNull();
    const done = await waitForRun(app, r.runs[0]);
    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    const rp = one<{ verdict: string; axis: string; judge: string; task_type: string | null; baseline_run_id: string; arm_run_id: string }>(app.db, "select * from replays where task_run_id = ?", done.id)!;
    expect(rp.axis).toBe("R1");
    expect(getRun(app, rp.baseline_run_id).status).toBe("done");
    // The fake judge prefers 乙 in both orders, which names different arms: no agreement, a tie.
    expect(rp.verdict).toBe("tie");
    expect(JSON.parse(rp.judge)).toMatchObject({ by: "judge", agree: false, profile: "fake-judge" });
    expect(rp.task_type).toBe("事实查询");
    const children = listRuns(app, { parentId: done.id });
    expect(children.filter((c) => c.kind === "replay-arm")).toHaveLength(2);
    expect(children.filter((c) => c.kind === "replay-judge")).toHaveLength(2);
    // Each arm only had the read tools (the fake agent reports how many it saw) and wrote nothing.
    const arm = getRun(app, rp.arm_run_id);
    expect(String(arm.output.answer)).toMatch(/^tools=\d+; search=/);
    expect(toolsOf(arm.output.answer)).toBeLessThan(toolsOf(original.output.answer));
    expect(one<{ n: number }>(app.db, "select count(*) n from memories")!.n).toBe(memoriesBefore);
    expect(all(app.db, "select * from shadow_writes where run_id in (?, ?)", rp.baseline_run_id, rp.arm_run_id)).toHaveLength(0);
  }, 180_000);
});

describe("K1 end to end over ACP", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-k1-"));
  const resultFile = join(home, "result.txt");
  const promptFile = join(home, "prompts.jsonl");
  writeFileSync(resultFile, "win");
  writeFileSync(join(home, "config.json"), JSON.stringify({ agents: {
    default: "fake", roles: { "replay-judge": "fake-judge" }, profiles: [
      { ...FAKE, env: { FAKE_REPLAY_RESULT: resultFile, FAKE_PROMPT_LOG: promptFile } },
      { ...FAKE, id: "fake-judge", env: { FAKE_MODE: "replay-judge", FAKE_REPLAY_RESULT: resultFile } },
    ],
  } }));
  const { boot } = await import("../src/main.ts");
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  cleanupApps.push(app);
  afterAll(async () => { await server.close(); });

  async function replay(question = "退款对账如何核对") {
    const base = pastAsk(app, question, "原回答");
    const scheduled = await scheduleReplays(app, { runId: base.runId, axis: "K1" });
    const task = await waitForRun(app, scheduled.runs[0]);
    expect(task.error).toBeNull();
    expect(task.status).toBe("done");
    return one<{ id: string; verdict: string; variant: string; baseline_run_id: string; arm_run_id: string }>(app.db, "select * from replays where task_run_id = ?", task.id)!;
  }

  it("injects only candidate text, records helped, activates after the second win, notifies once with later", async () => {
    const body = `先核对流水，再读原件。${"候选正文".repeat(1800)}尾部不应传入`;
    saveSkill(app, { name: "refund", description: "退款对账如何核对", body, status: "draft" });
    const first = await replay();
    expect(first.verdict).toBe("win");
    expect(JSON.parse(first.variant)).toMatchObject({ candidateId: "skill:refund", skillName: "refund" });
    expect(skillTally(app, "skill:refund")).toEqual({ wins: 1, losses: 0, adopted: false });
    expect(readSkill(app, "refund").status).toBe("draft");
    const prompts = readFileSync(promptFile, "utf8").trim().split("\n").map((s) => JSON.parse(s) as string);
    expect(prompts[0]).not.toContain("这次多给你一份做法");
    expect(prompts[1]).toContain(`这次多给你一份做法（候选技能「refund」）。适用就照着做，不适用就忽略：\n\n${body.slice(0, 6000)}`);
    expect(prompts[1]).not.toContain("尾部不应传入");
    const tools = (id: string) => /^tools=(\d+);/.exec(String(getRun(app, id).output.answer))?.[1];
    expect(tools(first.arm_run_id)).toBe(tools(first.baseline_run_id));
    expect(all(app.db, "select * from shadow_writes where run_id in (?, ?)", first.arm_run_id, first.baseline_run_id)).toHaveLength(0);
    const second = await replay();
    expect(second.verdict).toBe("win");
    expect(readSkill(app, "refund").status).toBe("active");
    expect(skillTally(app, "skill:refund")).toEqual({ wins: 2, losses: 0, adopted: true });
    expect(applyEffects(app, second.id)).toEqual([]);
    const notices = all<{ body: string; context: string }>(app.db, "select body, context from notifications where title = ?", "技能「refund」复盘后自动启用");
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("在 2 次复盘里让回答变好");
    expect(JSON.parse(notices[0].context).urgency).toBe("later");
  }, 180_000);

  it("applies a proposal through its existing path after two wins, attributed to the replay", async () => {
    const id = createProposal(app, { target: "assistant", kind: "skill", title: "对账做法", reason: "复用", content: { name: "audit", description: "退款对账如何核对", body: "查原件，逐笔核对" }, runId: null });
    await replay();
    expect(one<any>(app.db, "select status from profile_proposals where id = ?", id)!.status).toBe("pending");
    const second = await replay();
    expect(one<any>(app.db, "select status, resolved_by from profile_proposals where id = ?", id)).toMatchObject({ status: "applied", resolved_by: `replay:${second.id}` });
    expect(readSkill(app, "audit").status).toBe("active");
    expect(profileDetail(app, "assistant").skills.find((s) => s.name === "audit")?.replay).toEqual({ wins: 2, losses: 0, adopted: true });
    expect(profileDetail(app, "assistant").proposals.find((p) => p.id === id)?.replay).toEqual({ wins: 2, losses: 0, adopted: true });
    expect(all(app.db, "select id from notifications where title = ?", "技能「audit」复盘后自动启用")).toHaveLength(1);
  }, 180_000);

  it("rejects a proposal after two losses and no win; a losing draft stays a draft", async () => {
    writeFileSync(resultFile, "loss");
    const id = createProposal(app, { target: "assistant", kind: "skill", title: "另一做法", reason: "试用", content: { name: "bad", description: "退款对账如何核对", body: "错误做法" }, runId: null });
    expect((await replay()).verdict).toBe("loss");
    expect((await replay()).verdict).toBe("loss");
    expect(one<any>(app.db, "select status, reason from profile_proposals where id = ?", id)).toMatchObject({ status: "rejected", reason: "试用\n复盘里加上它两次都答得更差" });
    expect(skillTally(app, `proposal:${id}`)).toEqual({ wins: 0, losses: 2, adopted: false });
    saveSkill(app, { name: "draft", description: "退款对账如何核对", body: "另一做法", status: "draft" });
    await replay(); await replay();
    expect(readSkill(app, "draft").status).toBe("draft");
    expect(skillTally(app, "skill:draft")).toMatchObject({ wins: 0, losses: 2 });
  }, 180_000);

  it("does not adopt by itself when adoptAfter is zero", async () => {
    writeFileSync(resultFile, "win");
    app.config.replay.skills.adoptAfter = 0;
    const question = "检查报销发票金额与日期";
    saveSkill(app, { name: "no-auto", description: question, body: "核对发票", status: "draft" });
    await replay(question); await replay(question);
    expect(readSkill(app, "no-auto").status).toBe("draft");
    expect(skillTally(app, "skill:no-auto")).toMatchObject({ wins: 2, losses: 0, adopted: false });
  }, 180_000);
});
