import { afterEach, expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, run } from "../src/core/db.ts";
import { autoFollowFor } from "../src/agents/auto-follow.ts";
import { backfillCodeFollow } from "../src/agents/code-auto-follow.ts";
import { codeChainFor, queueNextCodeRound, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { queueCodeWork } from "../src/agents/code-delegate.ts";
import { createAgentWork, onWorkRunSettled, queueAgentRound } from "../src/agents/agent-work.ts";
import { changeLongTask } from "../src/agents/long-tasks.ts";
import { __testHandlers, addRunEvent, createRun, getRun, queuedInLane } from "../src/agents/runs.ts";
import { retryRun } from "../src/agents/retry.ts";
import { supervisorFacts, supervisorUsage } from "../src/agents/supervisor.ts";
import { createWorkerAsk, longTaskForRun } from "../src/agents/supervisor-code.ts";
import { upsertItem } from "../src/items/store.ts";
import { conversationMessages, createThread } from "../src/agents/threads.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { dispatchBoard, readBoard, settleBoardRun } from "../src/agents/work-board.ts";

const apps: App[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });
function setup() {
  const app = testApp();
  apps.push(app);
  app.config.agents.profiles.push({ id: "demo", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
  app.config.longTasks.supervisor = { profile: "demo" };
  const thread = createThread(app, { spaceId: "personal", channel: "web" });
  const ask = createRun(app, { spaceId: "personal", kind: "ask", title: "核对", input: { conversationId: thread.id } });
  const ctx: ToolContext = { app, userId: "owner", spaceId: "personal", spaces: ["personal"], actor: "agent", runId: ask.id, tools: null };
  const delegate = (maxRounds?: number) => queueCodeWork(app, { spaceId: "personal", parentId: ask.id,
    title: "校对", input: { task: "校对说明并核实示例", maxRounds } });
  const startWork = () => createAgentWork(app, { askRunId: ask.id, rootConversationId: thread.id,
    spaceId: "personal", title: "核实示例", startMessage: "核实示例，保留出处" });
  return { app, ask, ctx, delegate, startWork };
}

it("编码按累计拆分项数或明确的轮数接管，保留同一会话里其他交办的归属", async () => {
  const { app, ctx, delegate } = setup();
  const small = delegate(), split = delegate();
  const plan = async (n: number, rounds?: number) => {
    const result = await callTool({ ...ctx, runId: split.id }, "plan_tasks", {
      tasks: Array.from({ length: n }, (_, i) => ({ title: "校对章节 " + i })), rounds,
    });
    expect(result.isError, result.text).toBe(false);
  };
  run(app.db, "update runs set status='running' where id=?", split.id);
  await plan(5);
  expect(longTaskForRun(app, split.id)).toBeNull();
  await plan(1);
  const task = autoFollowFor(app, "code", split.id)!;
  expect(task.goal).toBe("校对说明并核实示例");
  expect(longTaskForRun(app, small.id)).toBeNull();
  const helper = createRun(app, { kind: "agent", title: "校对助手", parentId: split.id });
  expect(longTaskForRun(app, helper.id)?.id).toBe(task.id);
  expect(createWorkerAsk(app, { runId: helper.id, question: "保留旧说明吗？" }).toName).toBe("助手");
  for (const worker of [small, split, helper]) addRunEvent(app, worker.id, "usage", { input: 80, output: 20 });
  expect(supervisorUsage(app, task)).toEqual([{ kind: "干活的", tokens: 200 }]);
  expect(supervisorFacts(app, task)).toMatchObject({ rounds: 1, active: 2, total: 6, pendingQuestions: 1 });
  expect(longTaskForRun(app, delegate(3).id)?.sourceKind).toBe("code");
});

it("来自流程阶段或已挂需求点的交办在创建时接管，普通事项仍按门槛", () => {
  const { app } = setup();
  const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "核对需求" });
  const queue = (parentId?: string) => queueCodeWork(app, { spaceId: item.spaceId, title: "核对", parentId, input: { itemId: item.id, task: "核对说明" } });
  expect(longTaskForRun(app, queue().id)).toBeNull();
  const stage = createRun(app, { kind: "flow-stage", title: "编码", spaceId: item.spaceId });
  expect(longTaskForRun(app, queue(stage.id).id)?.sourceKind).toBe("code");
  run(app.db, "insert into item_materials(item_id,kind,ref,created_at) values(?,'req','demo',?)", item.id, item.createdAt);
  expect(longTaskForRun(app, queue().id)?.sourceKind).toBe("code");
});

it("接管前的编码轮计入预算，退出后继续原交办，重复补挂也不会重开", async () => {
  const { app, delegate } = setup();
  const auto = app.config.longTasks.auto;
  auto.code = false;
  const root = delegate(4);
  const chain = codeChainFor(app, root)!;
  run(app.db, "update runs set status='done' where id=?", root.id);
  const sibling = delegate();
  codeChainFor(app, sibling);
  const next = queueNextCodeRound(app, chain, "第二轮", { manual: true })!;
  expect(next.run.input.continueFrom).toBe(root.id);
  const ended = delegate(4);
  run(app.db, "update runs set status='done' where id=?", ended.id);
  auto.code = true;
  backfillCodeFollow(app);
  backfillCodeFollow(app);
  const task = autoFollowFor(app, "code", root.id)!;
  expect(longTaskForRun(app, next.run.id)?.id).toBe(task.id);
  expect(autoFollowFor(app, "code", ended.id)).toBeNull();
  expect(all(app.db, "select id from long_tasks")).toHaveLength(1);
  expect(supervisorFacts(app, task)).toMatchObject({ rounds: 2, active: 1 });
  run(app.db, "update long_tasks set budget=json_set(budget,'$.codeRounds',2) where id=?", task.id);
  run(app.db, "update runs set status='done' where id=?", next.run.id);
  expect(() => queueNextCodeRound(app, next.chain, "第三轮", { manual: true })).toThrow(/已用完/);
  await changeLongTask(app, task.id, { action: "detach" });
  const resumed = queueNextCodeRound(app, next.chain, "第三轮", { manual: true })!;
  backfillCodeFollow(app);
  expect(longTaskForRun(app, resumed.run.id)).toBeNull();
});

const scope = { userId: "owner", spaces: ["personal"], denyTools: [], lark: { chats: [] } };
it("补挂工作 Agent 后报告与预算归跟进助手，退出后在原工作话题协调", async () => {
  const { app, startWork } = setup();
  app.config.longTasks.auto.agentWork = false;
  const work = startWork();
  const round = { agent: "assistant", task: "核实", assistantScope: scope };
  const worker = queueAgentRound(app, work, round);
  app.config.longTasks.auto.agentWork = true;
  backfillCodeFollow(app);
  const task = autoFollowFor(app, "agentWork", work.askRunId)!;
  expect(task.goal).toBe("核实示例，保留出处");
  expect(conversationMessages(app, work.rootConversationId)).toContainEqual(expect.objectContaining({ meta: { command: true, autoFollowId: task.id } }));
  expect(supervisorFacts(app, task)).toMatchObject({ rounds: 1, active: 1 });
  run(app.db, "update long_tasks set budget=json_set(budget,'$.codeRounds',1) where id=?", task.id);
  expect(() => queueAgentRound(app, work, round)).toThrow(/已用完/);
  run(app.db, "update runs set status='done' where id=?", worker);
  expect(getRun(app, onWorkRunSettled(app, getRun(app, worker))!.coordinateRunId!).kind).toBe("supervise");
  await changeLongTask(app, task.id, { action: "detach" });
  const next = queueAgentRound(app, work, round);
  run(app.db, "update runs set status='done' where id=?", next);
  expect(getRun(app, onWorkRunSettled(app, getRun(app, next))!.coordinateRunId!).kind).toBe("ask");
});

it("仅剩排队协调轮时重启，原消息由跟进 AI 接手", async () => {
  const { app, startWork } = setup();
  app.config.longTasks.auto.agentWork = false;
  const work = startWork();
  const id = queueAgentRound(app, work, { agent: "assistant", task: "核实出处", assistantScope: scope });
  run(app.db, "update runs set status='done' where id=?", id);
  const pending = onWorkRunSettled(app, getRun(app, id))!.coordinateRunId!;
  app.config.longTasks.auto.agentWork = true;
  backfillCodeFollow(app);
  const task = autoFollowFor(app, "agentWork", work.askRunId)!;
  await import("../src/agents/jobs.ts");
  const output = await __testHandlers.get("ask")!({ app, run: getRun(app, pending), signal: new AbortController().signal,
    event() {}, output() {} });
  expect(output).toMatchObject({ quiet: true, supervisedBy: task.id });
  expect(JSON.stringify(queuedInLane(app, "supervisor:" + task.id, "supervise")!.input.events)).toContain(pending);
});

it("接管任务板后在必选块收齐时验收，未验收的块计入未完成项", async () => {
  const { app, ctx, startWork } = setup();
  const work = startWork();
  const task = autoFollowFor(app, "agentWork", work.askRunId)!;
  const ids = dispatchBoard(app, work, ["示例", "用法"].map(title => ({ title, goal: title, accept: "核实出处", scope })), work.askRunId);
  for (const t of readBoard(app, work.askRunId).tasks) {
    run(app.db, "update runs set status='done' where id=?", t.attempts[0].runId);
    settleBoardRun(app, getRun(app, t.attempts[0].runId));
  }
  const lead = queuedInLane(app, "supervisor:" + task.id, "supervise")!;
  expect(JSON.stringify(lead.input.events)).toContain("必选块已收齐");
  expect(supervisorFacts(app, task)).toMatchObject({ openItems: 2, total: 2, rounds: 2 });
  const result = await callTool({ ...ctx, role: "supervisor", runId: lead.id }, "work_review",
    { work_id: work.askRunId, decisions: ids.map(task => ({ task, decision: "accept" })) });
  expect(result.isError, result.text).toBe(false);
  expect(supervisorFacts(app, task)).toMatchObject({ openItems: 0, done: 2 });
});

it("检出前失败的编码轮重试仍受原跟进的预算限制", async () => {
  const { app, delegate } = setup();
  const root = delegate(3);
  const task = autoFollowFor(app, "code", root.id)!;
  run(app.db, "update runs set status='failed' where id=?", root.id);
  run(app.db, "update long_tasks set budget=json_set(budget,'$.codeRounds',1) where id=?", task.id);
  await expect(retryRun(app, root.id)).rejects.toThrow(/已用完/);
  expect(supervisorFacts(app, task).rounds).toBe(1);
});

it("网页发起的无会话交办完成时，把结果交回跟进助手", () => {
  const { app } = setup();
  const root = queueCodeWork(app, { spaceId: "personal", title: "校对", input: { task: "校对示例", maxRounds: 3 } });
  const task = autoFollowFor(app, "code", root.id)!;
  run(app.db, "update runs set status='done',output=json_object('verdict','approved') where id=?", root.id);
  trySettleCodeChain(app, root.id);
  expect(JSON.stringify(queuedInLane(app, "supervisor:" + task.id, "supervise")!.input.events)).toContain("approved");
});
