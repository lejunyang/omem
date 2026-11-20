import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/core/app.ts";

type Verdict = { run_id: string; label: string; why: string };
/** What the fake reviewer hands in for a run's task; every task it was given is kept. */
let hand: (task: string) => Verdict[] = () => [];
const tasks: string[] = [];
vi.mock("../src/agents/runner.ts", async (orig) => ({
  ...(await orig<typeof import("../src/agents/runner.ts")>()),
  runRole: vi.fn(async (app: App, input: { role: string; runId: string; task: string }) => {
    tasks.push(input.task);
    const { callTool, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
    const ctx = toolContextForToken(app, issueToolToken({ runId: input.runId, actor: "agent", role: input.role, spaceId: "personal", spaces: ["personal"], tools: null, agentProfile: "strong", model: "model-x" }))!;
    const r = await callTool(ctx, "review_reply_outcomes", { verdicts: hand(input.task) });
    return { text: r.text, profileId: "fake", agent: "fake", ai: { profile: "fake" } };
  }),
}));

const { __testHandlers: handlers, getRun } = await import("../src/agents/runs.ts");
const { createRun } = await import("../src/agents/runs.ts");
const { addMessage, createThread } = await import("../src/agents/threads.ts");
const { callTool, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
const { recordLarkSent } = await import("../src/channels/lark-feedback.ts");
const { run } = await import("../src/core/db.ts");
const { ensureDefaultSchedules, listSchedules } = await import("../src/core/scheduler.ts");
const { metricPoints } = await import("../src/data/metrics.ts");
const { snapshotOmemUsage } = await import("../src/data/omem-usage.ts");
const { clearInsightsCache, insights } = await import("../src/insights/insights.ts");
const { checkReply, replyOutcome, replyOutcomeText, reviseReply } = await import("../src/agents/reply-outcomes.ts");
const { batchOf, pickForReview, reviewCandidates, reviewTask, scheduleOutcomeReview, SIGNAL_TEXT } = await import("../src/agents/outcome-review.ts");
const { testApp } = await import("./helpers.ts");

const apps: App[] = [];
const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
afterEach(() => { hand = () => []; tasks.length = 0; for (const app of apps.splice(0)) app.db.close(); });
const fresh = () => { const app = testApp(); apps.push(app); return app; };

/** A question in a conversation, answered `hours` ago, with a first label already on it. */
function answered(app: App, hours: number, o: { label?: string; by?: string; confidence?: number | null } = {}) {
  const conversationId = createThread(app, { spaceId: "personal", channel: "web", title: "虚构会话" }).id;
  const question = addMessage(app, conversationId, "user", "退款改造什么时候上线？");
  const r = createRun(app, { kind: "ask", title: "虚构问答", input: { conversationId } });
  const answer = addMessage(app, conversationId, "assistant", "周四上线，依据是排期表。", r.id);
  run(app.db, "update messages set created_at = ? where id = ?", ago(hours + 0.1), question);
  run(app.db, "update messages set created_at = ? where id = ?", ago(hours), answer);
  run(app.db, "update runs set status = 'done', created_at = ?, finished_at = ? where id = ?", ago(hours + 0.1), ago(hours), r.id);
  run(app.db, "update reply_outcomes set at = ?, due_at = ?, label = ?, \"by\" = ?, confidence = ?, labelled_at = ? where run_id = ?",
    ago(hours), ago(hours - 6), o.label ?? "resolved", o.by ?? "决策模型 A", o.confidence === undefined ? 0.9 : o.confidence, ago(hours - 6), r.id);
  return { runId: r.id, conversationId };
}
function says(app: App, conversationId: string, text: string, hoursAgo: number) {
  const id = addMessage(app, conversationId, "user", text);
  run(app.db, "update messages set created_at = ? where id = ?", ago(hoursAgo), id);
}
const reviewer = (app: App, runId: string | null, role = "outcome-reviewer") =>
  toolContextForToken(app, issueToolToken({ runId, actor: "agent", role, spaceId: "personal", spaces: ["personal"], tools: null, agentProfile: "strong", model: "model-x" }))!;
const handle = (app: App, runId: string) => handlers.get("outcome-review")!({ app, run: getRun(app, runId), signal: new AbortController().signal, event: () => {}, output: () => {} } as never);

describe("夜里复查回复结果", () => {
  it("只挑一到三天前、决策模型标的；本人标的、改过的、按表情记的、没人接话又没动静的都不挑", () => {
    const app = fresh();
    const sure = answered(app, 30), unsure = answered(app, 30, { confidence: 0.4 }), unclear = answered(app, 30, { label: "unrelated" });
    const emoji = answered(app, 30, { by: "表情" }), owner = answered(app, 30, { by: "本人" });
    const ownerRevised = answered(app, 30);
    reviseReply(app, ownerRevised.runId, "corrected", "本人", "他说不对");
    const recent = answered(app, 10), old = answered(app, 5 * 24);
    const quiet = answered(app, 30, { label: "silent", by: "宿主", confidence: null });
    const quietThenAsked = answered(app, 30, { label: "silent", by: "宿主", confidence: null });
    says(app, quietThenAsked.conversationId, "退款改造到底什么时候上线", 12);
    const askedAgain = answered(app, 30);
    says(app, askedAgain.conversationId, "退款改造到底什么时候上线啊", 20);
    const got = new Map(reviewCandidates(app).map((c) => [c.runId, c]));
    expect(got.get(sure.runId)?.pick).toBe("sample");
    expect(got.get(unsure.runId)?.pick).toBe("unsure");
    expect(got.get(unclear.runId)?.pick).toBe("unclear");
    expect(got.get(quietThenAsked.runId)).toMatchObject({ pick: "signal", signals: ["asked-again"] });
    expect(got.get(askedAgain.runId)).toMatchObject({ pick: "signal", signals: ["asked-again"] });
    for (const x of [emoji, owner, ownerRevised, recent, old, quiet]) expect(got.has(x.runId)).toBe(false);
    expect(got.size).toBe(5);
  });

  it("先挑对不上的、再挑把握低的和看不出的，随机抽几条有把握的，每晚有上限", () => {
    const c = (runId: string, pick: "signal" | "unsure" | "unclear" | "sample", extra: Record<string, unknown> = {}) =>
      ({ runId, at: ago(30), label: "resolved" as const, confidence: 0.9, pick, signals: [], ...extra });
    const cands = [c("s1", "sample"), c("u1", "unsure", { confidence: 0.5 }), c("g1", "signal", { signals: ["negative"] }), c("u2", "unsure", { confidence: 0.2 }), c("x1", "unclear"),
      c("g2", "signal", { signals: ["negative", "correction"] }), c("s2", "sample"), c("s3", "sample")] as Parameters<typeof pickForReview>[0];
    expect(pickForReview(cands, { max: 5, sample: 2 }, () => 0.5).map((x) => x.runId)).toEqual(["g2", "g1", "u2", "s1", "s2"]);
    // Room left over does not grow the random share.
    expect(pickForReview(cands, { max: 20, sample: 2 }, () => 0.5).map((x) => x.runId)).toEqual(["g2", "g1", "u2", "u1", "x1", "s1", "s2"]);
    expect(pickForReview(cands, { max: 20, sample: 0 }).every((x) => x.pick !== "sample")).toBe(true);
  });

  it("按批排运行，一晚不超过上限；还有没跑完的不再排；默认每晚开着", () => {
    const app = fresh();
    ensureDefaultSchedules(app);
    expect(listSchedules(app).find((s) => s.id === "outcome-review")).toMatchObject({ kind: "outcome-review", enabled: true });
    app.config.replies.outcome.review = { enabled: true, max: 7, batch: 3, sample: 1, days: 3 };
    for (let i = 0; i < 10; i++) answered(app, 30, { confidence: 0.3 });
    answered(app, 30);
    answered(app, 30);
    const runs = scheduleOutcomeReview(app);
    expect(runs.map((r) => batchOf(r.input).length)).toEqual([3, 3, 1]);
    const picks = runs.flatMap((r) => batchOf(r.input));
    expect(new Set(picks.map((p) => p.runId)).size).toBe(7);
    expect(picks.filter((p) => p.pick === "sample")).toHaveLength(1);
    expect(scheduleOutcomeReview(app)).toEqual([]);
    run(app.db, "update runs set status = 'cancelled' where kind = 'outcome-review'");
    app.config.replies.outcome.review.enabled = false;
    expect(scheduleOutcomeReview(app)).toEqual([]);
  });

  it("复查交的结论：一样的记同意（把握低的也就按它算），不一样的改判，第一遍留着；别的回答、别的角色、本人标的都不动", async () => {
    const app = fresh();
    const unsure = answered(app, 30, { confidence: 0.4 });
    const wrong = answered(app, 30);
    says(app, wrong.conversationId, "不对，排期表上写的是下周二", 29);
    const owner = answered(app, 30, { by: "本人" });
    const [r] = scheduleOutcomeReview(app);
    expect(batchOf(r.input).map((p) => p.runId).sort()).toEqual([unsure.runId, wrong.runId].sort());
    expect(replyOutcome(app, unsure.runId)!.label).toBe("unrelated");
    hand = () => [
      { run_id: unsure.runId, label: "resolved", why: "对方晚上说照这个做好了" },
      { run_id: wrong.runId, label: "corrected", why: "本人一小时后说不对，是下周二" },
      { run_id: owner.runId, label: "corrected", why: "试一下" },
    ];
    expect(await handle(app, r.id)).toMatchObject({ quiet: true, reviewed: 2, confirmed: 1, revised: 1 });
    expect(tasks[0]).toContain("不对，排期表上写的是下周二");
    expect(tasks[0]).toContain("review_reply_outcomes");
    expect(replyOutcome(app, unsure.runId)).toMatchObject({ label: "resolved", first: { label: "resolved", confidence: 0.4 }, revised: null, checked: { verdict: "confirmed", by: "strong · model-x", pick: "unsure" } });
    expect(replyOutcomeText(replyOutcome(app, unsure.runId)!)).toContain("夜里复查（strong · model-x）同意");
    expect(replyOutcome(app, wrong.runId)).toMatchObject({ label: "corrected", first: { label: "resolved", confidence: 0.9 }, revised: { label: "corrected", by: "夜里复查（strong · model-x）", why: "本人一小时后说不对，是下周二" }, checked: { verdict: "revised", pick: "signal" } });
    expect(replyOutcome(app, owner.runId)).toMatchObject({ label: "resolved", revised: null, checked: null });

    // Read once: again, from the wrong role or outside such a run, it changes nothing.
    const again = await callTool(reviewer(app, r.id), "review_reply_outcomes", { verdicts: [{ run_id: unsure.runId, label: "followup", why: "再交一次" }] });
    expect(again.text).toContain("已经复查过");
    expect((await callTool(reviewer(app, r.id, "coach"), "review_reply_outcomes", { verdicts: [{ run_id: unsure.runId, label: "followup", why: "换个角色" }] })).isError).toBe(true);
    expect((await callTool(reviewer(app, null), "review_reply_outcomes", { verdicts: [{ run_id: unsure.runId, label: "followup", why: "不在复查里" }] })).isError).toBe(true);
    expect(() => checkReply(app, owner.runId, { label: "corrected", by: "x", why: "直接改" })).toThrow(/本人标的/);
    // The owner still has the last word; after them nobody else changes it.
    reviseReply(app, wrong.runId, "taken_over", "本人", "其实是我自己答的");
    expect(replyOutcome(app, wrong.runId)).toMatchObject({ label: "taken_over", checked: { verdict: "revised" } });
    expect(() => reviseReply(app, wrong.runId, "resolved", "coach", "我觉得解决了")).toThrow(/以本人的为准/);
    // A run whose answers all have their reading already ends quietly.
    expect(await handle(app, r.id)).toMatchObject({ quiet: true, summary: expect.stringContaining("都已经有了结论") });
  });

  it("群里的回答：材料里有一整天的后续、本人自己答的和提问的人又问的，后来的动静对不上就先挑", () => {
    const app = fresh();
    const r = createRun(app, { kind: "guest", title: "群里的提问", input: {} });
    run(app.db, "update runs set status = 'done', created_at = ?, finished_at = ?, output = ? where id = ?", ago(30.05), ago(30), JSON.stringify({ answer: "周四上线，依据是排期表。" }), r.id);
    const line = (id: string, hoursAgo: number, text: string, who: { name: string; id: string; kind?: string }) =>
      run(app.db, "insert into lark_messages(message_id, chat_id, sender_id, sender_name, sender_kind, content, create_ms) values(?,?,?,?,?,?,?)", id, "oc_demo", who.id, who.name, who.kind ?? "user", text, Date.now() - hoursAgo * HOUR);
    const li = { name: "小李", id: "ou_li" };
    line("q1", 30.1, "退款改造什么时候上线？", li);
    recordLarkSent(app, { messageId: `om_${r.id}`, chatId: "oc_demo", runId: r.id, purpose: "answer", bot: "main" });
    run(app.db, "update reply_outcomes set at = ?, due_at = ?, label = 'resolved', \"by\" = '决策模型 A', confidence = 0.92, labelled_at = ? where run_id = ?", ago(30), ago(24), ago(24), r.id);
    line("m1", 29.5, "我补充一下：是下周二上线，排期表改过了", { name: "本人的名字", id: "ou_owner", kind: "owner" });
    line("m2", 12, "退款改造到底哪天上线？", li);
    line("m3", 3, "这条是一天以后说的", li);
    const c = reviewCandidates(app).find((x) => x.runId === r.id)!;
    expect(c.pick).toBe("signal");
    expect(c.signals.sort()).toEqual(["asked-again", "owner-answered"]);
    const task = reviewTask(app, [{ runId: r.id, pick: c.pick, signals: c.signals }]);
    for (const text of ["退款改造什么时候上线", "周四上线，依据是排期表", "小李（提问的人）", "退款改造到底哪天上线", "本人在那里说：我补充一下", SIGNAL_TEXT["owner-answered"], "第一遍标的：解决了（决策模型 A，把握 0.92）"])
      expect(task).toContain(text);
    expect(task).not.toContain("这条是一天以后说的");
  });

  it("数据页和每天的用量按复查后的结果算，并给出复查同意的占比", () => {
    const app = fresh();
    const a = answered(app, 30, { confidence: 0.4 }), b = answered(app, 30), s = answered(app, 30);
    snapshotOmemUsage(app, { maxDays: 3 });
    const before = metricPoints(app, "omem.reply_outcomes");
    expect(before.some((p) => p.dims.review)).toBe(false);
    checkReply(app, a.runId, { label: "resolved", by: "strong", why: "晚上说做好了", pick: "unsure" });
    checkReply(app, b.runId, { label: "corrected", by: "strong", why: "本人说不对", pick: "signal" });
    checkReply(app, s.runId, { label: "resolved", by: "strong", why: "道谢了", pick: "sample" });
    clearInsightsCache(app);
    const quality = insights(app, "owner", {}).sections.find((x) => x.id === "quality")!;
    const value = (key: string) => quality.metrics.find((m) => m.key === key)?.value;
    expect(value("quality:reply:对话里的回答:resolved")).toBe(2);
    expect(value("quality:reply:对话里的回答:corrected")).toBe(1);
    expect(value("quality:reply:对话里的回答:unclear") ?? 0).toBe(0);
    expect(value("quality:reply:checked")).toBe(3);
    expect(value("quality:reply:agree")).toBe(66.7);
    expect(value("quality:reply:agree:sample")).toBe(100);
    // The next day's snapshot counts the last days again, with the reading in them.
    snapshotOmemUsage(app, { maxDays: 3, now: new Date(Date.now() + 24 * HOUR) });
    const after = metricPoints(app, "omem.reply_outcomes").filter((p) => p.at === before[0].at);
    expect(after.find((p) => p.dims.review === "复查同意")).toMatchObject({ value: 2, dims: { label: "resolved", judge: "模型" } });
    expect(after.find((p) => p.dims.review === "复查改判")).toMatchObject({ value: 1, dims: { label: "corrected", revised: "改判过" } });
    expect(after.filter((p) => !p.dims.review)).toEqual([]);
  });
});
