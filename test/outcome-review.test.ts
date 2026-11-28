import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/core/app.ts";

/** What the fake reviewer hands in for a run's task (the `tasks` of review_reply_outcomes); every task it was given is kept. */
let hand: (task: string) => unknown[] = () => [];
const tasks: string[] = [];
vi.mock("../src/agents/runner.ts", async (orig) => ({
  ...(await orig<typeof import("../src/agents/runner.ts")>()),
  runRole: vi.fn(async (app: App, input: { role: string; runId: string; task: string }) => {
    tasks.push(input.task);
    const { callTool, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
    const ctx = toolContextForToken(app, issueToolToken({ runId: input.runId, actor: "agent", role: input.role, spaceId: "personal", spaces: ["personal"], tools: null, agentProfile: "strong", model: "model-x" }))!;
    const given = hand(input.task);
    const r = given.length ? await callTool(ctx, "review_reply_outcomes", { tasks: given }) : { text: "" };
    return { text: r.text, profileId: "fake", agent: "fake", ai: { profile: "fake" } };
  }),
}));

const { __testHandlers: handlers, getRun } = await import("../src/agents/runs.ts");
const { createRun } = await import("../src/agents/runs.ts");
const { addMessage, createThread } = await import("../src/agents/threads.ts");
const { callTool, issueToolToken, toolContextForToken } = await import("../src/agents/tools.ts");
const { all, one, run } = await import("../src/core/db.ts");
const { createUser } = await import("../src/core/users.ts");
const { ensureDefaultSchedules, listSchedules } = await import("../src/core/scheduler.ts");
const { clearInsightsCache, insights } = await import("../src/insights/insights.ts");
const { replyOutcome, replyOutcomeText, reviseReply } = await import("../src/agents/reply-outcomes.ts");
const { batchOf, listReplyTasks, reviewTask, scheduleOutcomeReview, startSweepJob, sweepStatus } = await import("../src/agents/outcome-review.ts");
const { defineTaskType, listTaskTypes, resolveTaskType, updateTaskType } = await import("../src/agents/task-types.ts");
const { testApp } = await import("./helpers.ts");

const apps: App[] = [];
const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
afterEach(() => { hand = () => []; tasks.length = 0; for (const app of apps.splice(0)) app.db.close(); });
const fresh = () => { const app = testApp(); apps.push(app); return app; };

/** A conversation; `ask` adds a question and the run that answered it `hours` ago, with a first label already on it. */
function conversation(app: App, title = "虚构会话") {
  const conversationId = createThread(app, { spaceId: "personal", channel: "web", title }).id;
  const ask = (hours: number, question: string, answer: string, o: { label?: string; by?: string; confidence?: number | null; userId?: string } = {}) => {
    const q = addMessage(app, conversationId, "user", question, null, o.userId ? { userId: o.userId } : {});
    const r = createRun(app, { kind: "ask", title: question, input: { conversationId } });
    const a = addMessage(app, conversationId, "assistant", answer, r.id);
    run(app.db, "update messages set created_at = ? where id = ?", ago(hours + 0.05), q);
    run(app.db, "update messages set created_at = ? where id = ?", ago(hours), a);
    run(app.db, "update runs set status = 'done', created_at = ?, finished_at = ?, trigger_by = ? where id = ?", ago(hours + 0.05), ago(hours), o.userId ? `user:${o.userId}` : "user:owner", r.id);
    run(app.db, "update reply_outcomes set at = ?, due_at = ?, label = ?, \"by\" = ?, confidence = ?, labelled_at = ? where run_id = ?",
      ago(hours), ago(hours - 6), o.label ?? "resolved", o.by ?? "决策模型 A", o.confidence === undefined ? 0.9 : o.confidence, ago(hours - 6), r.id);
    return r.id;
  };
  const says = (hours: number, text: string, userId?: string) => {
    const id = addMessage(app, conversationId, "user", text, null, userId ? { userId } : {});
    run(app.db, "update messages set created_at = ? where id = ?", ago(hours), id);
  };
  return { conversationId, ask, says };
}
const reviewer = (app: App, runId: string | null, role = "outcome-reviewer") =>
  toolContextForToken(app, issueToolToken({ runId, actor: "agent", role, spaceId: "personal", spaces: ["personal"], tools: null, agentProfile: "strong", model: "model-x" }))!;
const handle = (app: App, runId: string) => handlers.get("outcome-review")!({ app, run: getRun(app, runId), signal: new AbortController().signal, event: () => {}, output: () => {} } as never);
const answer = (run_id: string, label: string, why = "依据：之后的那句话", missing?: string) => ({ run_id, label, why, ...(missing ? { missing } : {}) });

describe("回扫回答", () => {
  it("从最早的开始，一段是一个会话当天的回答；几个短会话可以一起；满一天才扫；一次只排一段；默认开着", () => {
    const app = fresh();
    const a = conversation(app, "会话甲"), b = conversation(app, "会话乙");
    const a1 = a.ask(30, "退款申请页上周的 UV 是多少？", "上周 UV 是 1,284。");
    const a2 = a.ask(29.5, "要日均的", "日均 183。");
    const b1 = b.ask(29, "排期表在哪？", "在项目 A 的文档里。");
    a.ask(5, "今天的呢？", "今天还没出数。");
    const [r] = scheduleOutcomeReview(app);
    expect(batchOf(r.input).map((p) => p.runId)).toEqual([a1, a2, b1]);
    expect(r.title).toBe("回扫回答（2 个会话，3 次回答）");
    expect(scheduleOutcomeReview(app)).toEqual([]);
    expect(sweepStatus(app).pending).toBe(3);
    ensureDefaultSchedules(app);
    expect(listSchedules(app).find((s) => s.kind === "outcome-review")).toMatchObject({ enabled: true });
  });

  it("材料：整段对话按时间排，回答标着 id，成员说的话署他的名字，不给第一遍的标注；之前的件和类型清单都在", () => {
    const app = fresh();
    createUser(app, { id: "xiaowang", name: "小王" });
    const c = conversation(app);
    const r1 = c.ask(30, "退款申请页上周的 UV 是多少？", "上周 UV 是 1,284。", { userId: "xiaowang", label: "followup" });
    c.says(29.9, "PC 和移动端分开", "xiaowang");
    defineTaskType(app, { name: "取数分析", description: "从数据平台查数", by: "owner" });
    run(app.db, "insert into reply_tasks(id, place, conversation_id, first_at, last_at, title, outcome, created_at, updated_at) values('rt_old', ?, ?, ?, ?, '上上周的退款 UV', 'done', ?, ?)", c.conversationId, c.conversationId, ago(50), ago(49), ago(49), ago(49));
    const task = reviewTask(app, [{ runId: r1 }]);
    expect(task).toMatch(/\*\*回答 r[0-9a-z]+\*\*（答小王，成员）：上周 UV 是 1,284。/);
    expect(task).toContain("小王：PC 和移动端分开");
    expect(task).not.toContain("本人：PC 和移动端分开");
    expect(task).not.toContain("被追问");
    expect(task).toContain("件 rt_old「上上周的退款 UV」");
    expect(task).toContain("- 取数分析：从数据平台查数");
    expect(task.indexOf("上周 UV 是 1,284")).toBeLessThan(task.indexOf("PC 和移动端分开"));
  });

  it("交结论：分件、标注和缺的是什么、类型（没有的自动建）、查数记录；同意第一遍的记同意，不同的改判；本人标的不动", async () => {
    const app = fresh();
    const c = conversation(app);
    const r1 = c.ask(30, "退款申请页上周的 UV 是多少？分 PC 和移动端", "上周 UV 是 1,284。", { label: "followup" });
    const r2 = c.ask(29.5, "我说了要分 PC 和移动端", "PC 912，移动端 372。", { label: "resolved" });
    const r3 = c.ask(29, "排期表在哪？", "在项目 A 的文档里。", { by: "本人", label: "corrected" });
    const [sweep] = scheduleOutcomeReview(app);
    hand = () => [
      { title: "退款申请页上周的 UV，分端", answers: [answer(r1, "supplement", "他原话要分端，回答没分", "没分 PC 和移动端"), answer(r2, "resolved")], outcome: "done", type: "取数分析", new_type: { description: "从数据平台、日志查数和明细" }, topics: ["退款改造", "UV"],
        queries: [{ run_id: r2, question: "退款申请页上周的 UV，分 PC 和移动端", definition: "上周一到周日，按天去重后相加", sources: ["埋点平台：refund_apply_view"], result: "PC 912，移动端 372" }] },
      { title: "排期表在哪", answers: [answer(r3, "resolved")], outcome: "done", type: "咨询答疑", new_type: { description: "问在哪、怎么用、是什么" } },
    ];
    expect(await handle(app, sweep.id)).toMatchObject({ quiet: true, swept: 3, tasks: 2, left: 0 });
    expect(replyOutcome(app, r1)).toMatchObject({ label: "supplement", missing: "没分 PC 和移动端", swept: true, first: { label: "followup" }, revised: { label: "supplement", by: "回扫（strong · model-x）" }, checked: { verdict: "revised", pick: "sweep" } });
    expect(replyOutcome(app, r2)).toMatchObject({ label: "resolved", revised: null, checked: { verdict: "confirmed", pick: "sweep" } });
    expect(replyOutcomeText(replyOutcome(app, r2)!)).toContain("回扫（strong · model-x）同意");
    expect(replyOutcome(app, r3)).toMatchObject({ label: "corrected", revised: null, swept: true });
    const [t2, t1] = listReplyTasks(app, { limit: 10 });
    expect(t1).toMatchObject({ title: "退款申请页上周的 UV，分端", type: "取数分析", rounds: 2, supplements: 1, corrections: 0, outcome: "done", topics: ["退款改造", "UV"], asker_kind: "owner" });
    expect(t2).toMatchObject({ title: "排期表在哪", type: "咨询答疑" });
    expect(listTaskTypes(app).map((t) => [t.name, t.definedBy])).toEqual([["取数分析", "agent"], ["咨询答疑", "agent"]]);
    expect(one(app.db, "select question, definition, sources, task_id from data_queries where run_id = ?", r2)).toMatchObject({ question: "退款申请页上周的 UV，分 PC 和移动端", sources: JSON.stringify(["埋点平台：refund_apply_view"]), task_id: t1.id });
    // Each answer once; only this stretch's; only the reviewer, inside a sweep run.
    const again = await callTool(reviewer(app, sweep.id), "review_reply_outcomes", { tasks: [{ title: "再交一次", answers: [answer(r1, "resolved")], outcome: "done", type: "取数分析" }] });
    expect(again.text).toContain("已经交过了");
    expect((await callTool(reviewer(app, sweep.id, "coach"), "review_reply_outcomes", { tasks: [{ title: "换个角色", answers: [answer(r1, "resolved")], outcome: "done", type: "取数分析" }] })).isError).toBe(true);
    expect((await callTool(reviewer(app, null), "review_reply_outcomes", { tasks: [{ title: "不在回扫里", answers: [answer(r1, "resolved")], outcome: "done", type: "取数分析" }] })).isError).toBe(true);
    // The owner still has the last word.
    reviseReply(app, r1, "next", "本人", "其实是后来才想到的");
    expect(replyOutcome(app, r1)!.label).toBe("next");
  });

  it("交得不对的件退回原因：不在这一段、类型不存在又没给新建、跨会话；没交的下一段再看，两回都没交按第一遍留着", async () => {
    const app = fresh();
    const a = conversation(app, "会话甲"), b = conversation(app, "会话乙");
    const a1 = a.ask(30, "问题一", "回答一");
    const b1 = b.ask(29, "问题二", "回答二");
    const [sweep] = scheduleOutcomeReview(app);
    const ctx = reviewer(app, sweep.id);
    const out = await callTool(ctx, "review_reply_outcomes", { tasks: [
      { title: "跨两个会话", answers: [answer(a1, "resolved"), answer(b1, "resolved")], outcome: "done", type: "随便" },
      { title: "没有这个类型", answers: [answer(a1, "resolved")], outcome: "done", type: "不存在的类型" },
      { title: "不在这一段", answers: [answer("r_other", "resolved")], outcome: "done", type: "不存在的类型" },
    ] });
    expect(out.text).toContain("在不同的会话");
    expect(out.text).toContain("没有类型「不存在的类型」");
    expect(out.text).toContain("不在这一段要判的回答里");
    expect(out.text).toContain(`还没交的回答：${a1}、${b1}`);
    hand = () => [];
    await handle(app, sweep.id);
    expect(one(app.db, "select sweep_tries, swept_at from reply_outcomes where run_id = ?", a1)).toMatchObject({ sweep_tries: 1, swept_at: null });
    run(app.db, "update runs set status = 'done' where id = ?", sweep.id);
    const [again] = scheduleOutcomeReview(app);
    await handle(app, again.id);
    expect(one(app.db, "select sweep_tries from reply_outcomes where run_id = ?", a1)).toMatchObject({ sweep_tries: 2 });
    expect(replyOutcome(app, a1)).toMatchObject({ label: "resolved", swept: true, checked: null });
  });

  it("接着之前的件：写它的 id 就并进去，轮数和缺的跟着算", async () => {
    const app = fresh();
    const c = conversation(app);
    const r1 = c.ask(53, "退款申请页上周的 UV", "1,284");
    const [s1] = scheduleOutcomeReview(app, Date.now() - 24 * HOUR);
    hand = () => [{ title: "退款申请页 UV", answers: [answer(r1, "resolved")], outcome: "unfinished", note: "还要分端", type: "取数分析", new_type: { description: "从数据平台查数" } }];
    await handle(app, s1.id);
    run(app.db, "update runs set status = 'done' where id = ?", s1.id);
    const r2 = c.ask(30, "分一下 PC 和移动端", "PC 912，移动端 372");
    const [s2] = scheduleOutcomeReview(app);
    const id = listReplyTasks(app, { limit: 5 })[0].id;
    expect(tasks.length).toBe(1);
    hand = (task) => (task.includes(`件 ${id}「退款申请页 UV」`) ? [{ task: id, title: "退款申请页 UV，分端", answers: [answer(r2, "next")], outcome: "done", type: "取数分析" }] : []);
    await handle(app, s2.id);
    expect(listReplyTasks(app, { limit: 5 })).toMatchObject([{ id, title: "退款申请页 UV，分端", rounds: 2, outcome: "done" }]);
  });

  it("类型两级：细类挂在大类下，本人删掉的不再自动建，一段最多新建三个，合并后件跟过去", async () => {
    const app = fresh();
    const top = defineTaskType(app, { name: "问题排查", description: "查出问题出在哪", by: "owner" });
    const alarm = defineTaskType(app, { name: "报警排查", parent: "问题排查", description: "按报警查", by: "agent" });
    expect(alarm.parentId).toBe(top.id);
    expect(() => defineTaskType(app, { name: "更细的", parent: "报警排查", description: "第三级", by: "agent" })).toThrow(/只有两级/);
    const dropped = defineTaskType(app, { name: "闲聊", description: "无关", by: "agent" });
    updateTaskType(app, dropped.id, { status: "dropped", note: "不是工作" });
    expect(() => defineTaskType(app, { name: "闲聊", description: "再建", by: "agent" })).toThrow(/删掉过/);
    const c = conversation(app);
    const ids = [c.ask(30, "一", "一"), c.ask(29.9, "二", "二"), c.ask(29.8, "三", "三"), c.ask(29.7, "四", "四")];
    const [sweep] = scheduleOutcomeReview(app);
    const out = await callTool(reviewer(app, sweep.id), "review_reply_outcomes", { tasks: ids.map((id, i) => ({ title: `第 ${i + 1} 件`, answers: [answer(id, "resolved")], outcome: "done", type: `新类型${i}`, new_type: { description: "一句定义" } })) });
    expect(out.text).toContain("已经新建了 3 个类型");
    const merged = updateTaskType(app, resolveTaskType(app, "新类型0")!.id, { mergeInto: "问题排查" });
    expect(merged.status).toBe("merged");
    expect(resolveTaskType(app, "新类型0")!.name).toBe("问题排查");
    expect(listReplyTasks(app, { limit: 10 }).filter((t) => t.type === "问题排查")).toHaveLength(1);
  });

  it("回补：补登记更早的回答（先标没判），按条数上限停；reset 清掉回扫的结论重扫", async () => {
    const app = fresh();
    const c = conversation(app);
    const old = c.ask(24 * 40, "很早以前的问题", "很早以前的回答");
    run(app.db, "delete from reply_outcomes where run_id = ?", old);
    const recent = c.ask(30, "最近的问题", "最近的回答");
    const s = startSweepJob(app, { since: ago(24 * 45), limit: 1 });
    expect(s.registered).toBe(1);
    expect(replyOutcome(app, old)).toMatchObject({ label: "unjudged" });
    const [sweep] = all<{ id: string }>(app.db, "select id from runs where kind = 'outcome-review'");
    expect(batchOf(getRun(app, sweep.id).input).map((p) => p.runId)).toEqual([old]);
    hand = () => [{ title: "很早以前的事", answers: [answer(old, "resolved")], outcome: "done", type: "咨询答疑", new_type: { description: "问在哪、是什么" } }];
    await handle(app, sweep.id);
    expect(replyOutcome(app, old)).toMatchObject({ label: "resolved", first: { label: "unjudged" }, swept: true });
    run(app.db, "update runs set status = 'done' where id = ?", sweep.id);
    // The job's limit is reached: it ends, and the regular days go on.
    const [next] = scheduleOutcomeReview(app);
    expect(sweepStatus(app).job).toBeNull();
    expect(batchOf(next.input).map((p) => p.runId)).toEqual([recent]);
    run(app.db, "update runs set status = 'done' where id = ?", next.id);
    const again = startSweepJob(app, { since: ago(24 * 45), until: ago(24 * 30), reset: true });
    expect(again.reset).toBe(1);
    expect(replyOutcome(app, old)).toMatchObject({ label: "unjudged", swept: false, taskId: null, revised: null });
    expect(one(app.db, "select count(*) n from reply_tasks")).toMatchObject({ n: 0 });
  });

  it("回补时一段交完马上排下一段，不等巡检；什么都没交的不接着排", async () => {
    const app = fresh();
    const c = conversation(app);
    const d1 = c.ask(24 * 40, "第一天的问题", "第一天的回答");
    const d2 = c.ask(24 * 39, "第二天的问题", "第二天的回答");
    startSweepJob(app, { since: ago(24 * 45) });
    const [first] = all<{ id: string }>(app.db, "select id from runs where kind = 'outcome-review'");
    expect(batchOf(getRun(app, first.id).input).map((p) => p.runId)).toEqual([d1]);
    run(app.db, "update runs set status = 'running' where id = ?", first.id);
    hand = () => [{ title: "第一天的事", answers: [answer(d1, "resolved")], outcome: "done", type: "咨询答疑", new_type: { description: "问在哪、是什么" } }];
    await handle(app, first.id);
    const queued = all<{ id: string }>(app.db, "select id from runs where kind = 'outcome-review' and status = 'queued'");
    expect(queued).toHaveLength(1);
    expect(batchOf(getRun(app, queued[0].id).input).map((p) => p.runId)).toEqual([d2]);
    // Nothing handed in: the patrol picks it up again, not the run itself.
    run(app.db, "update runs set status = 'running' where id = ?", queued[0].id);
    hand = () => [];
    await handle(app, queued[0].id);
    expect(all(app.db, "select id from runs where kind = 'outcome-review' and status = 'queued'")).toHaveLength(0);
  });

  it("数据页按回扫后的结果算：接着往下算有用、要补充单列，给出回扫同意第一遍的占比", async () => {
    const app = fresh();
    const c = conversation(app);
    const r1 = c.ask(30, "一", "一", { label: "resolved" });
    const r2 = c.ask(29.9, "二", "二", { label: "followup" });
    const r3 = c.ask(29.8, "三", "三", { label: "resolved" });
    const [sweep] = scheduleOutcomeReview(app);
    hand = () => [{ title: "一件事", answers: [answer(r1, "resolved"), answer(r2, "next"), answer(r3, "supplement", "漏了", "没给时间段")], outcome: "done", type: "取数分析", new_type: { description: "从数据平台查数" } }];
    await handle(app, sweep.id);
    clearInsightsCache(app);
    const quality = insights(app, "owner", {}).sections.find((x) => x.id === "quality")!;
    const value = (key: string) => quality.metrics.find((m) => m.key === key)?.value;
    expect(value("quality:reply:对话里的回答:resolved")).toBe(1);
    expect(value("quality:reply:对话里的回答:next")).toBe(1);
    expect(value("quality:reply:对话里的回答:supplement")).toBe(1);
    expect(value("quality:reply:对话里的回答:followup")).toBeUndefined();
    expect(value("quality:reply:rate")).toBe(66.7);
    expect(value("quality:reply:checked")).toBe(3);
    expect(value("quality:reply:agree")).toBe(33.3);
    expect(quality.metrics.find((m) => m.key === "quality:reply:checked")?.label).toBe("回扫过的");
  });
});
