import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { all, run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { answerAsk, createAsk, describeAnswer, getAsk, listAsks, waitForAnswer } from "../src/agents/asks.ts";
import { codeChainFor, queueNextCodeRound, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { queueCodeWork } from "../src/agents/code-delegate.ts";
import { addTask, getTask, recordCheckpoint, toDecide, updateTask } from "../src/agents/code-tasks.ts";
import { confirmLongTaskBrief, getLongTask, startLongTask } from "../src/agents/long-tasks.ts";
import { queueSupervisedAgent, onWorkRunSettled } from "../src/agents/agent-work.ts";
import { checkTaskDuration } from "../src/agents/drift.ts";
import { createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { answerWorkerQuestion, checkSupervisorBasis, createWorkerAsk, longTaskForRun } from "../src/agents/supervisor-code.ts";
import { testApp } from "./helpers.ts";
import { submitSupervisorReport } from "../src/agents/supervisor-report.ts";

async function setup(rounds = 5) {
  const app = testApp();
  app.config.agents.profiles.push({ id: "stub", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
  const task = await startLongTask(app, { spaceId: "personal", userId: "owner", goal: "校对说明", ai: { profile: "stub" } });
  run(app.db, "update long_tasks set status='active', budget=json_set(budget,'$.codeRounds',?), brief=json_set(brief,'$.scope',json(?)) where id=?", rounds, '["docs"]', task.id);
  const lead = createRun(app, { kind: "supervise", title: "监工", lane: `supervisor:${task.id}`, input: { longTaskId: task.id, conversationId: task.threadId } });
  const delegate = () => queueCodeWork(app, { parentId: lead.id, userId: "owner", spaceId: "personal", title: "校对", input: { task: "核对说明", taskMode: true, goal: "校对说明" } });
  return { app, task: getLongTask(app, task.id), lead, delegate };
}

describe("监工的编码交办", () => {
  it("共用总预算，每个交办只续自己的编码轮", async () => {
    const { app, delegate, lead, task } = await setup(3);
    const first = delegate();
    const one = codeChainFor(app, first)!;
    const second = delegate();
    codeChainFor(app, second);
    run(app.db, "update runs set status='done' where id=?", first.id);
    const next = queueNextCodeRound(app, one, "继续第一件", { manual: true })!.run;
    expect(next.input.continueFrom).toBe(first.id);
    expect(next.input.longTaskId).toBe(task.id);
    expect(longTaskForRun(app, createRun(app, { kind: "agent", title: "编码助手", parentId: next.id }).id)?.id).toBe(task.id);
    expect(() => delegate()).toThrow(/轮次/);
    expect(() => checkSupervisorBasis(app, lead.id, next.id, "按计划")).toThrow(/basis/);
    expect(() => checkSupervisorBasis(app, lead.id, next.id, first.id)).not.toThrow();
    expect(() => checkSupervisorBasis(app, lead.id, next.id, task.goal)).not.toThrow();
    const unrelated = createRun(app, { kind: "code", title: "另一件事" });
    expect(() => checkSupervisorBasis(app, lead.id, unrelated.id, task.goal)).toThrow(/自己长任务/);
    expect(getRun(app, second.id).output.codeChain).toMatchObject({ lastCodeRunId: second.id });
  });

  it("工作 Agent 和编码共用预算，工作结束仍由监工接手", async () => {
    const { app, lead, delegate, task } = await setup(1);
    const scope = { spaces: ["personal"], denyTools: [], userId: "owner", lark: { chats: [] } };
    const id = queueSupervisedAgent(app, lead.id, { agent: "assistant", task: "核对说明", assistantScope: scope });
    expect(() => delegate()).toThrow(/工作轮次/);
    run(app.db, "update runs set status='done' where id=?", id);
    const next = onWorkRunSettled(app, getRun(app, id))!;
    expect(getRun(app, next.coordinateRunId!)).toMatchObject({ kind: "supervise", input: { longTaskId: task.id } });
    expect(all(app.db, "select id from runs where kind='ask'")).toHaveLength(0);
  });

  it.each([1, 2])("工作者结束后收到答复，按总预算 %i 决定续轮或叫醒监工", async rounds => {
    const { app, lead, task } = await setup(rounds);
    const scope = { spaces: ["personal"], denyTools: [], userId: "owner", lark: { chats: [] } };
    const id = queueSupervisedAgent(app, lead.id, { agent: "assistant", task: "核对说明", assistantScope: scope });
    const ask = createWorkerAsk(app, { runId: id, question: "保留示例？" });
    run(app.db, "update runs set status='done' where id=?", id);
    await answerWorkerQuestion(app, task.id, ask.id, "保留");
    const next = all<{ id: string }>(app.db, "select id from runs where kind='agent' and id!=?", id);
    expect(next.length).toBe(rounds - 1);
    expect(getAsk(app, ask.id).answer).toBe("保留");
    if (next[0]) {
      expect(getRun(app, next[0].id).input).toMatchObject({ longTaskId: task.id, resumeFromRun: id });
      expect(getRun(app, lead.id).output.agentWork).toMatchObject({ runs: 2 });
    } else {
      const queued = all<{ input: string }>(app.db, "select input from runs where kind='supervise' and status='queued'");
      expect(queued.some(r => r.input.includes("已用完 1 个工作轮次"))).toBe(true);
    }
  });

  it("本交办轮数已满或长任务超时，增加单次续轮额度也无法入队", async () => {
    const { app, task, delegate } = await setup(10);
    app.config.agents.autoAdvance.codeRoundsMax = 1;
    const first = delegate();
    const chain = codeChainFor(app, first)!;
    run(app.db, "update runs set status='done' where id=?", first.id);
    expect(() => queueNextCodeRound(app, chain, "继续", { manual: true })).toThrow(/单个交办/);
    run(app.db, "update long_tasks set budget=json_set(budget,'$.hours',0) where id=?", task.id);
    expect(() => delegate()).toThrow(/总时长/);
    expect(all(app.db, "select id from runs where kind='code'")).toHaveLength(1);
  });

  it("三次尝试或回退立刻带上原项，普通完成合批", async () => {
    const { app, delegate } = await setup();
    const worker = delegate();
    const item = addTask(app, worker.id, { kind: "build", title: "核对说明" }, "coder");
    expect(item.origin.goal).toBe("校对说明");
    updateTask(app, worker.id, item.seq, { attempts: 3 });
    updateTask(app, worker.id, item.seq, { state: "done" });
    updateTask(app, worker.id, item.seq, { state: "reverted" });
    const events = all<{ input: string }>(app.db, "select input from runs where kind='supervise' and status='queued'").flatMap(r => JSON.parse(r.input).events ?? []);
    for (const [text, drift] of [["已尝试 3 次", true], ["已回退", true], ["已完成", false]] as const)
      expect(events).toContainEqual(expect.objectContaining({ drift, note: expect.stringContaining(text) }));
    const late = addTask(app, worker.id, { kind: "build", title: "核对剩余说明", origin: { deadline: new Date(Date.now() - 1000).toISOString() } }, "coder");
    expect(checkTaskDuration(app, late)).toContain("超过指定时限");
  });

  it("只处理本长任务的普通问题，监工答复返回工作者", async () => {
    const { app, task, delegate } = await setup();
    const worker = delegate();
    const ask = createWorkerAsk(app, { runId: worker.id, question: "是否保留原示例？" });
    expect(listAsks(app, { runId: worker.id })).toEqual([]);
    expect(getAsk(app, ask.id).shownAt).toBeNull();
    await expect(answerWorkerQuestion(app, "other", ask.id, "保留")).rejects.toThrow();
    const approval = createAsk(app, { runId: worker.id, kind: "approval", question: "批准推送？" });
    await expect(answerWorkerQuestion(app, task.id, approval.id, "批准")).rejects.toThrow();
    const waiting = waitForAnswer(app, ask.id, 2000);
    await answerWorkerQuestion(app, task.id, ask.id, "保留");
    expect(describeAnswer(await waiting)).toContain("监工回答");
    expect(getAsk(app, approval.id).status).toBe("pending");
  });

  it("修改项的新问题取代旧问题，完成结果只叫醒监工", async () => {
    const { app, task, delegate } = await setup();
    const worker = delegate();
    codeChainFor(app, worker);
    const t = addTask(app, worker.id, { kind: "build", title: "校对说明" }, "coder");
    const ask = toDecide(app, worker.id, t.seq, { question: "保留原示例？", options: ["保留","替换"], why: "尚在使用" });
    expect(ask.state).toBe("assistant");
    await expect(answerWorkerQuestion(app, task.id, `task:${t.id}:过期`, "替换")).rejects.toThrow(/变化/);
    await answerWorkerQuestion(app, task.id, `task:${t.id}:${ask.origin.questionId}`, "保留");
    expect(getTask(app, worker.id, t.seq)).toMatchObject({ state: "todo", notes: expect.arrayContaining([expect.objectContaining({ by: "supervisor", text: "重做：保留" })]) });
    run(app.db, "update runs set status='done' where id=?", worker.id);
    setRunOutput(app, worker.id, { verdict: "approved" });
    trySettleCodeChain(app, worker.id);
    expect(all(app.db, "select id from runs where kind='ask'")).toHaveLength(0);
    expect(getRun(app, worker.id).output.codeResultHandedOff).toBe(true);
  });

  it.each([1, 2])("监工已重做两次，本人回答汇总卡后按总预算 %i 续轮", async rounds => {
    const { app, task, lead, delegate } = await setup(rounds);
    confirmLongTaskBrief(app, task.id, { doneWhen: ["说明已校对"] });
    const worker = delegate();
    codeChainFor(app, worker);
    const item = addTask(app, worker.id, { kind: "build", title: "核对示例" }, "coder");
    const question = { question: "示例怎么处理？", options: ["保留", "替换"], why: "需要确定示例" };
    const askAgain = () => {
      const pending = toDecide(app, worker.id, item.seq, question);
      return `task:${item.id}:${pending.origin.questionId}`;
    };
    await answerWorkerQuestion(app, task.id, askAgain(), "保留");
    await answerWorkerQuestion(app, task.id, askAgain(), "保留");
    const questionId = askAgain();
    await expect(answerWorkerQuestion(app, task.id, questionId, "替换")).rejects.toThrow(/重做过 2 次/);

    run(app.db, "update runs set status='done' where id=?", worker.id);
    run(app.db, "update runs set status='running' where id=?", lead.id);
    await submitSupervisorReport(app, lead.id, {
      stage: "校对", status: "needs-owner", goalCheck: [], progress: { done: [], doing: [], next: [] },
      decisions: [], actions: [], askOwner: [{ ...question, questionId, prefer: "保留" }],
    });
    const [card] = listAsks(app, { conversationId: task.threadId, status: "pending" });
    const value = { q0: "替换" };
    await expect(answerAsk(app, card.id, { by: "another", value })).rejects.toThrow(/只有/);
    await answerAsk(app, card.id, { by: task.userId, value });

    const decided = getTask(app, worker.id, item.seq);
    expect(decided).toMatchObject({ state: "todo", answer: "替换" });
    expect(decided.notes.at(-1)).toMatchObject({ kind: "owner", by: task.userId, text: "本人决定：替换" });
    expect(getLongTask(app, task.id).supplements.at(-1)?.text).toBe("示例怎么处理？：替换");
    const next = all<{ id: string }>(app.db, "select id from runs where kind='code' and json_extract(input,'$.continueFrom')=?", worker.id);
    expect(next).toHaveLength(rounds - 1);
    if (next.length) expect(getRun(app, next[0].id)).toMatchObject({ status: "queued", input: { longTaskId: task.id } });
  });

  it("检查点按路径边界识别范围外文件", async () => {
    const { app, delegate } = await setup();
    const worker = delegate();
    const dir = mkdtempSync(join(tmpdir(), "supervised-checkpoints-"));
    git(dir, ["init", "-q"]);
    mkdirSync(join(dir, "docs"));
    const commit = (inside: string, outside: string) => {
      writeFileSync(join(dir, "docs", "guide"), inside);
      writeFileSync(join(dir, "docs-old"), outside);
      git(dir, ["add", "."]);
      expect(git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "修改"]).ok).toBe(true);
      return git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    };
    const base = commit("A\n", "A\n");
    const wt = [{ space: "repo", path: dir, branch: "work", base }];
    commit("B\n", "B\n");
    recordCheckpoint(app, worker.id, wt, worker.id, [], "第一轮");
    commit("A\n", "C\n");
    recordCheckpoint(app, worker.id, wt, worker.id, [], "第二轮");
    const events = all<{ input: string }>(app.db, "select input from runs where kind='supervise' and status='queued'").flatMap(r => JSON.parse(r.input).events ?? []);
    expect(events).toContainEqual(expect.objectContaining({ drift: true, note: expect.stringContaining("超出任务书范围：repo/docs-old") }));
    expect(events.filter(e => e.drift).map(e => e.note).join("\n")).not.toContain("repo/docs/guide");
  });
});
