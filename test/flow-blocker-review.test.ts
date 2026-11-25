import { rmSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { createSpace } from "../src/core/spaces.ts";
import { __testHandlers, createRun, getRun, listRuns, runEvents } from "../src/agents/runs.ts";
import { createAsk } from "../src/agents/asks.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import * as runner from "../src/agents/runner.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { addItemEvent, upsertItem } from "../src/items/store.ts";
import { addChange, lineTimeline } from "../src/items/changes.ts";
import { addLocalMaterials, addMaterials } from "../src/items/materials.ts";
import { itemFacts } from "../src/flows/blocker-facts.ts";
import { queueBlockerReviews } from "../src/flows/blocker-review.ts";
import { recordFlowPush } from "../src/flows/delivery.ts";
import { reportStage, startFlow } from "../src/flows/engine.ts";
import { queueReconcile } from "../src/flows/reconcile.ts";
import { getStage } from "../src/flows/store.ts";
import { upsertSource } from "../src/sources/store.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
const owner = { actor: "owner", userId: "owner" };
const start = Date.parse("2026-01-12T01:00:00.000Z");
const minute = 60_000;
const moveTo = (m: number) => vi.setSystemTime(new Date(start + m * minute));
const wait = (id: string) => ({ id, name: id === "verify" ? "复测" : "交付", by: "wait" as const, fixed: false, needs: [] });

async function setup({ judge = true, blocked = true, dueAt, ownerStage, shared }: { judge?: boolean; blocked?: boolean; dueAt?: string; ownerStage?: { at?: string; window?: string }; shared?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  moveTo(0);
  const app = testApp(); apps.push(app);
  app.config.timezone = "UTC";
  if (judge) {
    app.config.ai.decision.provider = "test";
    app.config.ai.providers = [{ id: "test", name: "测试决策", kind: "openai", backends: [] }];
    setKey(app.home, "test", "fake-key");
  }
  if (shared) createSpace(app, { id: "project-a", name: "项目 A" });
  const item = upsertItem(app, undefined, { title: "项目 A", ...(dueAt ? { dueAt } : {}), ...(shared ? { spaceId: "project-a" } : {}) }, "user");
  await startFlow(app, item.id, { stages: [ownerStage ? { ...wait("verify"), ...ownerStage, by: "owner", effect: "read", note: "核对复测结果" } : wait("verify"), wait("deliver")] }, owner);
  if (blocked && !ownerStage) await reportStage(app, item.id, "verify", { state: "blocked", waitingOn: "复测记录", note: "等复测通过的证据" }, { actor: "agent" });
  return { app, item };
}

afterEach(async () => {
  setDecisionFetchForTests(null);
  resetDecisionCooldownForTests();
  setLarkClient(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await new Promise(setImmediate);
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

function fakeDecision(probability: number | number[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_, init) => {
    const q = JSON.parse(String(init?.body)).questions as { name: string }[];
    return new Response(JSON.stringify({ answers: q.map((v, i) => ({ ...v, type: "predicate", probability: Array.isArray(probability) ? probability[i] : probability })) }));
  });
  setDecisionFetchForTests(fetch);
  return fetch;
}
const recentReconcile = (app: App) => listRuns(app, { kind: "flow-reconcile" }).find(r => r.input.focus);
async function execute(app: App, id: string) {
  const job = getRun(app, id);
  run(app.db, "update runs set status='running',started_at=? where id=?", new Date().toISOString(), id);
  await __testHandlers.get(job.kind)!({ app, run: getRun(app, id), signal: new AbortController().signal, event: () => {}, output: () => {} });
  run(app.db, "update runs set status='done',finished_at=? where id=?", new Date().toISOString(), id);
}
async function review(app: App, at: number) {
  moveTo(at);
  const queued = queueBlockerReviews(app);
  expect(queued).toHaveLength(1);
  expect(queueBlockerReviews(app)).toHaveLength(0);
  await execute(app, queued[0].id);
  return queued[0];
}
function fakeReconcile(app: App, complete?: (ctx: ToolContext, task: string) => Promise<unknown>, steps?: object[]) {
  return vi.spyOn(runner, "runRole").mockImplementationOnce(async (_, req) => {
    const runId = req.runId!;
    const ctx: ToolContext = { app, spaceId: req.spaceId, tools: null, actor: "agent", role: "flow-reconcile", runId, spaces: [...new Set([...(req.spaces ?? []), ...req.alsoRead ?? []])], userId: "owner" };
    if (complete) await complete(ctx, req.task);
    const res = await callTool(ctx, "submit_flow_reconcile", { item: getRun(app, runId).input.itemId, summary: "已核对新材料", ...(steps ? { steps } : {}) });
    expect(res.isError).not.toBe(true);
    return { text: "已核对", agent: "fake", stopReason: "end_turn", profileId: "fake", ai: { profile: "fake" } };
  });
}
const focusWindow = (app: App, id: string) => one<{ wait: number; changed: number }>(app.db, `select json_extract(keys,'$.interval') wait,
  json_extract(keys,'$.blockerChanged') changed from flow_signals where type='reconcile' and json_extract(keys,'$.runId')=?`, id);

it("本人在未挂接会话里说明已复测：先过决策门槛，重读原话后带依据完成", async () => {
  const { app, item } = await setup({ ownerStage: {}, shared: true });
  const fetch = fakeDecision(0.95);
  moveTo(1);
  const thread = createThread(app, { channel: "web", spaceId: "personal", title: "项目 A" });
  const message = addMessage(app, thread.id, "user", "项目 A 的复测在 01:01 做完了，全部通过。");
  const ref = `msg:${message}`;
  const check = await review(app, 4);
  expect(fetch).toHaveBeenCalledTimes(1);
  const focused = recentReconcile(app)!;
  expect(focused.input.spaces).toEqual(expect.arrayContaining(["personal", "project-a"]));
  expect(check.input.spaces).toEqual(expect.arrayContaining(["personal", "project-a"]));
  expect(focused.input.focus).toMatchObject({ reviewId: check.id, blockers: [{ stageId: "verify", ownerTurn: true }], facts: [expect.objectContaining({ refs: [ref] })] });
  fakeReconcile(app, async (ctx, task) => {
    expect(task).toContain(ref);
    expect(task).not.toContain('"id":"deliver"');
    const report = (evidence: string[]) => callTool(ctx, "stage_report", { item: item.id, stage: "verify", state: "done", note: "项目 A 复测在 01:01 通过", evidence });
    expect((await report([])).isError).toBe(true);
    expect(getStage(app, item.id, "verify").state).toBe("doing");
    expect((await callTool(ctx, "stage_report", { item: item.id, stage: "deliver", state: "done", note: "其他阶段", evidence: [ref] })).isError).toBe(true);
    expect((await callTool(ctx, "read_source", { source: ref })).isError).not.toBe(true);
    expect((await report([ref])).isError).not.toBe(true);
  });
  await execute(app, focused.id);
  expect(getStage(app, item.id, "verify")).toMatchObject({ state: "done", askId: null, evidence: [ref], note: "项目 A 复测在 01:01 通过" });
  expect(all(app.db, "select id from asks")).toEqual([]);
});

it("普通本人阶段只按定向复核中的本人原话补记跳过", async () => {
  const { app, item } = await setup({ ownerStage: {} });
  fakeDecision(0.95);
  moveTo(1);
  const thread = createThread(app, { channel: "web", spaceId: "personal", title: "项目 A" });
  const ref = `msg:${addMessage(app, thread.id, "user", "项目 A 这一轮的复测不用做，跳过吧。")}`;
  const other = `msg:${addMessage(app, thread.id, "assistant", "可以不用复测。")}`;
  await review(app, 4);
  fakeReconcile(app, async (ctx) => {
    const report = (evidence: string[]) => callTool(ctx, "stage_report", { item: item.id, stage: "verify", state: "skip", note: "本人决定这次不做复测", evidence });
    expect((await report([other])).isError).toBe(true);
    expect(getStage(app, item.id, "verify").state).toBe("doing");
    expect((await report([ref])).isError).not.toBe(true);
  });
  await execute(app, recentReconcile(app)!.id);
  expect(getStage(app, item.id, "verify")).toMatchObject({ state: "skipped", askId: null, evidence: [ref] });
});

it("只有其他会话的新消息时，沿用复核间隔合批，即使上一批没有安排对账", async () => {
  const { app } = await setup({ ownerStage: {} });
  const fetch = fakeDecision(0.05);
  const thread = createThread(app, { channel: "web", spaceId: "personal", title: "另一件事" });
  moveTo(1);
  addMessage(app, thread.id, "user", "我已看过另一份说明。");
  await review(app, 4);
  expect(recentReconcile(app)).toBeUndefined();
  moveTo(7);
  addMessage(app, thread.id, "user", "我已更新另一件事项。");
  moveTo(12);
  expect(queueBlockerReviews(app)).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
  await review(app, 64);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([{ timing: "事项截止时间", dueAt: new Date(start + 15 * minute).toISOString() }, { timing: "阶段时间窗结束", window: "00:55-01:15" }])("到 $timing 后只排这段，没查到不动，继续按间隔退避", async ({ dueAt, window }) => {
  const { app, item } = await setup({ judge: false, dueAt, ownerStage: { window } });
  moveTo(14);
  expect(queueBlockerReviews(app)).toHaveLength(0);
  moveTo(15);
  const queued = queueBlockerReviews(app);
  expect(queued).toHaveLength(1);
  expect(queued[0].input.focus).toMatchObject({ scheduledAt: new Date().toISOString(), blockers: [{ stageId: "verify" }], facts: [] });
  expect(queueBlockerReviews(app)).toHaveLength(0);
  fakeReconcile(app, async (ctx, task) => {
    expect(task).toContain("到计划时间，只核对这一段");
    expect(task).not.toContain('"id":"deliver"');
    expect((await callTool(ctx, "stage_report", { item: item.id, stage: "deliver", state: "done", note: "其它段完成", evidence: [ctx.runId!] })).isError).toBe(true);
  }, [{ stage: "verify", kind: "owner", why_owner: "只有本人能查看", action: "复测通过了吗？" }]);
  await execute(app, queued[0].id);
  expect(getStage(app, item.id, "verify")).toMatchObject({ state: "doing", askId: null, evidence: [] });
  expect(all(app.db, "select body from notifications where body like '%复测通过了吗%' ")).toHaveLength(0);
  moveTo(16);
  expect(queueBlockerReviews(app)).toHaveLength(0);
});

it("对账给出的预计时间触发定向核对；确实查不到且过时，只在进展里问一次", async () => {
  const { app, item } = await setup({ judge: false, ownerStage: { at: "01:00" } });
  const initial = queueBlockerReviews(app);
  expect(initial).toHaveLength(1);
  const expected = new Date(start + 5 * 60 * minute).toISOString();
  fakeReconcile(app, undefined, [{ stage: "verify", kind: "external", action: "到时只读核对复测记录", retry_at: expected }]);
  await execute(app, initial[0].id);
  moveTo(299);
  expect(queueBlockerReviews(app)).toHaveLength(0);
  const steps = [{ stage: "verify", kind: "owner", why_owner: "记录无法读取，只有本人看到结果", action: "复测通过了吗？" }];
  for (const minute of [300, 600]) {
    moveTo(minute);
    const [check] = queueBlockerReviews(app);
    expect(check.kind).toBe("flow-reconcile");
    fakeReconcile(app, undefined, steps);
    await execute(app, check.id);
  }
  expect(getStage(app, item.id, "verify")).toMatchObject({ state: "doing", askId: null, control: { ownerAsked: true } });
  expect(all(app.db, "select body from notifications where body like '%复测通过了吗%'")).toHaveLength(1);
  expect(all(app.db, "select id from asks")).toHaveLength(0);
});

it("三分钟内的新事实合批，判是后越过巡检的六小时限制并把范围交给对账", async () => {
  const { app, item } = await setup();
  const fetch = fakeDecision([0.92, 0.1]);
  moveTo(1);
  createAsk(app, { runId: null, userId: "owner", question: "另一个未答的问题", context: { itemId: item.id } });
  const source = upsertSource(app, { kind: "doc", spaceId: "personal", uri: "notes:verify", title: "复测说明", text: "这一段原文不应交给快模型" });
  await addMaterials(app, item.id, [{ kind: "source", ref: source.id }], "owner");
  const patrol = queueReconcile(app, item.id, new Date())!;
  expect(patrol.kind).toBe("flow-reconcile");
  fakeReconcile(app);
  await execute(app, patrol.id);
  moveTo(2);
  addChange(app, { itemId: item.id, summary: "项目 A 回归通过", origin: "review", type: "result", detail: "这段详情也不应该进决策输入" });
  moveTo(3);
  addItemEvent(app, item.id, "updated", "测试记录已归档");
  expect(queueBlockerReviews(app)).toHaveLength(0);
  const check = await review(app, 4);
  expect(fetch).toHaveBeenCalledTimes(1);
  const input = String(fetch.mock.calls[0][1]?.body);
  expect(input).toContain("项目 A 回归通过");
  expect(input).toContain("测试记录已归档");
  expect(input).toContain("等复测通过的证据");
  expect(input).not.toContain("这一段原文");
  expect(input).not.toContain("这段详情");
  const focus = recentReconcile(app)!;
  expect(focus.input.focus).toMatchObject({ reviewId: check.id, blockers: [{ stageId: "verify" }], facts: expect.arrayContaining([expect.objectContaining({ summary: "测试记录已归档" })]) });
  expect(runEvents(app, check.id).some(e => JSON.stringify(e).includes("已排对账"))).toBe(true);
  expect(lineTimeline(app, item.id).some(row => row.summary.includes("已排对账"))).toBe(true);
  const executeRole = fakeReconcile(app);
  await execute(app, focus.id);
  expect(executeRole.mock.calls[0][1].task).toContain("先看这几个卡点和这些新情况");
  expect(executeRole.mock.calls[0][1].task).toContain("项目 A 回归通过");
  expect(executeRole.mock.calls[0][1].task).not.toContain('"id":"deliver"');
  expect(lineTimeline(app, item.id).find(row => row.runId === check.id)?.detail).toContain("对账结果：已核对新材料");
});

it("多卡点逐个判断，低于门槛的结果不排对账，同批不重复判断", async () => {
  const { app, item } = await setup();
  const fetch = fakeDecision([0.65, 0.15]);
  moveTo(1);
  createAsk(app, { runId: null, userId: "owner", question: "需要哪一版交付？", context: { itemId: item.id } });
  moveTo(2);
  addItemEvent(app, item.id, "updated", "新增一条待核对的结果", "host");
  await review(app, 5);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).questions).toHaveLength(2);
  expect(all(app.db, "select taken from decisions order by choice")).toEqual([{ taken: "no" }, { taken: "no" }]);
  expect(recentReconcile(app)).toBeUndefined();
  moveTo(16);
  expect(queueBlockerReviews(app)).toHaveLength(0);
});

it("对账无变化后间隔翻倍，解除卡点后重置，本人动作可缩短起始间隔", async () => {
  const { app, item } = await setup({ dueAt: new Date(start + 2 * 24 * 60 * minute).toISOString() });
  fakeDecision(0.96);
  moveTo(2);
  addItemEvent(app, item.id, "updated", "第一批复测证据");
  await review(app, 5);
  const first = recentReconcile(app)!;
  fakeReconcile(app);
  await execute(app, first.id);
  expect(focusWindow(app, first.id)).toMatchObject({ wait: 20 * minute, changed: 0 });
  moveTo(10);
  addItemEvent(app, item.id, "updated", "第二批复测证据");
  moveTo(44);
  expect(queueBlockerReviews(app)).toHaveLength(0);
  await review(app, 45);
  const second = recentReconcile(app)!;
  fakeReconcile(app, () => reportStage(app, item.id, "verify", { state: "done", note: "复测完成", evidence: [first.id] }, { actor: "agent", runId: second.id }));
  await execute(app, second.id);
  expect(focusWindow(app, second.id)).toMatchObject({ wait: 40 * minute, changed: 1 });
  moveTo(46);
  await reportStage(app, item.id, "deliver", { state: "blocked", waitingOn: "交付", note: "等发布" }, { actor: "agent" });
  moveTo(47);
  addItemEvent(app, item.id, "updated", "第三批交付证据");
  await review(app, 65);
  const third = recentReconcile(app)!;
  fakeReconcile(app);
  await execute(app, third.id);
  expect(focusWindow(app, third.id)).toMatchObject({ wait: 20 * minute, changed: 0 });
  moveTo(67);
  addItemEvent(app, item.id, "note", "本人给出了发布记录", "user");
  await review(app, 85);
  expect(focusWindow(app, recentReconcile(app)!.id)?.wait).toBe(20 * minute);
});

it("快速对账当日上限后仍走六小时巡检", async () => {
  const { app, item } = await setup();
  const fetch = fakeDecision(0.95);
  app.config.flows.follow.maxRunsPerDay = 1;
  for (let i = 0; i < 4; i++) {
    moveTo(20 * i + 1);
    addItemEvent(app, item.id, "note", `本人更新 ${i}`, "owner");
    await review(app, 20 * i + 4);
    fakeReconcile(app);
    await execute(app, recentReconcile(app)!.id);
  }
  moveTo(90);
  addItemEvent(app, item.id, "note", "本人还有一条更新", "owner");
  moveTo(435);
  expect(queueBlockerReviews(app)).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(queueReconcile(app, item.id, new Date())?.input.focus).toBeUndefined();
  expect(listRuns(app, { kind: "flow-reconcile" })).toHaveLength(5);
});

it.each([
  { judge: false, blocked: true },
  { judge: true, blocked: false },
])("没有卡点或模型时不调决策（%j）", async options => {
  const { app, item } = await setup(options);
  const fetch = fakeDecision(0.95);
  moveTo(1);
  addItemEvent(app, item.id, "note", "本人来了一条消息", "owner");
  moveTo(5);
  expect(queueBlockerReviews(app)).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it("一段刚卡住时复用此前的新情况，已经复核的状态不反复看", async () => {
  const { app, item } = await setup();
  const fetch = fakeDecision(0.1);
  moveTo(2);
  addItemEvent(app, item.id, "note", "上一段刚交付了发布记录", "agent");
  await review(app, 5);
  moveTo(8);
  await reportStage(app, item.id, "deliver", { state: "blocked", waitingOn: "owners", note: "等发布记录" }, { actor: "agent" });
  await review(app, 11);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1][1]?.body)).toContain("上一段刚交付了发布记录");
  const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
  expect(body.questions).toHaveLength(1);
  expect(String(fetch.mock.calls[1][1]?.body)).not.toContain("等复测通过的证据");
  moveTo(20);
  expect(queueBlockerReviews(app)).toHaveLength(0);
});

it("决策出错仍按旧的交付条件排对账", async () => {
  const { app, item } = await setup();
  setDecisionFetchForTests(async () => { throw new Error("假模型不可用"); });
  moveTo(400);
  const delivery = createRun(app, { kind: "agent", title: "交付" });
  run(app.db, "update runs set status='done' where id=?", delivery.id);
  await reportStage(app, item.id, "deliver", { state: "done", note: "交付已完成", evidence: [delivery.id] }, { actor: "agent" });
  await review(app, 403);
  expect(recentReconcile(app)).toBeUndefined();
  expect(listRuns(app, { kind: "flow-reconcile" })).toHaveLength(1);
});

it("复用材料、对象、交办、推送和会话的已有事实", async () => {
  const { app, item } = await setup({ judge: false });
  moveTo(1);
  const thread = createThread(app, { spaceId: "personal", channel: "web", title: "关联会话" });
  addLocalMaterials(app, item.id, [{ kind: "conversation", ref: thread.id }], "owner");
  const work = createRun(app, { kind: "code", title: "交办修复", input: { itemId: item.id }, userId: "owner" });
  addLocalMaterials(app, item.id, [{ kind: "run", ref: work.id }], "owner");
  const input = { kind: "doc" as const, spaceId: "personal", uri: "notes:verify", title: "复测记录", text: "初稿" };
  const source = upsertSource(app, input);
  await addMaterials(app, item.id, [{ kind: "source", ref: source.id }], "owner");
  moveTo(2);
  upsertSource(app, { ...input, text: "新版" });
  addMessage(app, thread.id, "user", "我已验收");
  addItemEvent(app, item.id, "updated", "关联对象《交付》：处理中 → 完成", "host");
  run(app.db, "update runs set status='done',finished_at=?,output=? where id=?", new Date().toISOString(), '{"verdict":"approved"}', work.id);
  recordFlowPush(app, work.id, "owner");
  const facts = itemFacts(app, item, new Date(start).toISOString(), new Date().toISOString()).map(f => f.summary);
  expect(facts).toEqual(expect.arrayContaining([
    "材料有更新：复测记录", "本人在关联会话说：我已验收", "关联对象《交付》：处理中 → 完成", "编码第 1 轮评审通过：交办修复", "编码交办已推到远端",
  ]));
});

it("关联群里的本人消息晚到仍算新情况，其他人的发言不算本人动作", async () => {
  const { app, item } = await setup();
  const fetch = fakeDecision(0.1);
  moveTo(1);
  const source = upsertSource(app, { kind: "chat", spaceId: "personal", uri: "lark:oc_example", title: "项目 A", text: "示例会话" });
  await addMaterials(app, item.id, [{ kind: "source", ref: source.id }], "owner");
  await review(app, 6);
  run(app.db, `insert into lark_messages(message_id,chat_id,sender_name,sender_kind,msg_type,content,create_ms,source_id,line)
    values('om_owner','oc_example','小王','owner','text','刚才的验收已通过',?, ?,1),
      ('om_other','oc_example','小李','user','text','这是别人的讨论',?, ?,1)`, start + 2 * minute, source.id, start + 5 * minute, source.id);
  await review(app, 8);
  const input = String(fetch.mock.calls[1][1]?.body);
  expect(input).toContain("刚才的验收已通过");
  expect(input).not.toContain("这是别人的讨论");
  moveTo(14);
  expect(queueBlockerReviews(app)).toHaveLength(0);
});
