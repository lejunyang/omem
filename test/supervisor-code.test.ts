import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { all, run } from "../src/core/db.ts";
import { git } from "../src/core/git.ts";
import { answerAsk, createAsk, describeAnswer, getAsk, listAsks, waitForAnswer } from "../src/agents/asks.ts";
import { codeChainFor, queueNextCodeRound, trySettleCodeChain } from "../src/agents/code-chain.ts";
import { queueCodeWork } from "../src/agents/code-delegate.ts";
import { addTask, getTask, recordCheckpoint, toDecide, updateTask } from "../src/agents/code-tasks.ts";
import { changeLongTask, confirmLongTaskBrief, getLongTask, startLongTask } from "../src/agents/long-tasks.ts";
import { queueSupervisedAgent, onWorkRunSettled } from "../src/agents/agent-work.ts";
import { checkTaskDuration } from "../src/agents/drift.ts";
import { createRun, getRun, queuedInLane, setRunOutput, __testHandlers, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { answerWorkerQuestion, checkSupervisorBasis, createWorkerAsk, longTaskForRun } from "../src/agents/supervisor-code.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { supervisorBranches } from "../src/agents/supervisor-branches.ts";
import { testApp } from "./helpers.ts";
import { submitSupervisorReport } from "../src/agents/supervisor-report.ts";

async function setup(rounds = 5) {
  const app = testApp();
  app.config.agents.profiles.push({ id: "stub", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
  const task = await startLongTask(app, { spaceId: "personal", userId: "owner", goal: "校对说明", ai: { profile: "stub" } });
  run(app.db, "update long_tasks set status='active', budget=json_set(budget,'$.codeRounds',?), brief=json_set(brief,'$.scope',json(?)) where id=?", rounds, '["docs"]', task.id);
  const lead = createRun(app, { kind: "supervise", title: "助手", lane: `supervisor:${task.id}`, input: { longTaskId: task.id, conversationId: task.threadId } });
  const delegate = () => queueCodeWork(app, { parentId: lead.id, userId: "owner", spaceId: "personal", title: "校对", input: { task: "核对说明", taskMode: true, goal: "校对说明" } });
  return { app, task: getLongTask(app, task.id), lead, delegate };
}

describe("助手的编码交办", () => {
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

  it("跟进助手凭依据停下自己的交办，在原工作区接着纠偏", async () => {
    const { app, task, lead, delegate } = await setup();
    const root = delegate();
    codeChainFor(app, root);
    addTask(app, root.id, { kind: "build", title: "核对说明" }, "coder");
    const ctx: ToolContext = { app, actor: "agent", role: "supervisor", userId: "owner", spaceId: "personal",
      spaces: ["personal"], tools: null, runId: lead.id };
    const call = (tool: string, args: object) => callTool(ctx, tool, { run_id: root.id, ...args });
    const other = createRun(app, { kind: "code", title: "其他交办", spaceId: "personal" });
    expect((await call("stop_code_run", { run_id: other.id, basis: task.goal })).isError).toBe(true);
    expect((await call("stop_code_run", {})).text).toContain("basis");
    expect(getRun(app, root.id).status).toBe("queued");
    const previous = __testHandlers.get("code");
    const received: string[] = [];
    const secondRuns: string[] = [];
    const correction = "只校对说明";
    __testHandlers.set("code", async worker => {
      if (worker.run.id === root.id) {
        await new Promise<void>(resolve => worker.signal.addEventListener("abort", () => resolve(), { once: true }));
      } else {
        secondRuns.push(worker.run.id);
        expect(worker.run.input.continueFrom).toBe(root.id);
        received.push(...(String(worker.run.input.roundNotes).match(/只校对说明/g) ?? []));
      }
    });
    // Only the two coding rounds run. The caller and the unrelated delegation stay parked.
    run(app.db, "update runs set not_before='2099-01-01' where id!=?", root.id);
    try {
      startWorker(app);
      await vi.waitFor(() => expect(getRun(app, root.id).status).toBe("running"));
      expect((await call("stop_code_run", { basis: task.goal, reason: "先核对改动" })).isError).toBe(false);
      expect(getRun(app, root.id)).toMatchObject({ status: "cancelled", output: { stoppedBySupervisor: expect.stringContaining(task.goal) } });
      expect((await call("continue_code_run", { task: correction, basis: task.goal, apply_first: true })).isError).toBe(true);
      const resumed = await call("continue_code_run", { when: "now", task: correction, basis: task.goal });
      expect(resumed.isError, resumed.text).toBe(false);
      const rounds = all<{ id: string }>(app.db, "select id from runs where json_extract(input,'$.continueFrom')=?", root.id);
      expect(rounds).toHaveLength(1);
      expect((await waitForRun(app, rounds[0].id)).status).toBe("done");
      expect(secondRuns).toEqual([rounds[0].id]);
      expect(received).toEqual([correction]);
      setRunOutput(app, lead.id, { supervisorReport: {} });
      expect((await call("stop_code_run", { basis: task.goal })).text).toContain("已交本轮报告");
      expect(getRun(app, other.id).status).toBe("queued");
    } finally {
      stopWorker();
      if (previous) __testHandlers.set("code", previous);
      else __testHandlers.delete("code");
    }
  });

  it("工作分支汇总限制提交、文件和篇幅，只读相关交办的提交", async () => {
    const { app, task, delegate } = await setup();
    const root = delegate();
    const dir = mkdtempSync(join(tmpdir(), "supervisor-branch-"));
    git(dir, ["init", "-b", "work"]);
    git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-m", "初始提交"]);
    const base = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 3; j++) writeFileSync(join(dir, `file-${i}-${j}.md`), "正文不会进入汇总");
      git(dir, ["add", "."]);
      git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "change-" + i]);
    }
    run(app.db, "update spaces set root_path=? where id='personal'", dir);
    setRunOutput(app, root.id, { worktrees: [{ space: "personal", branch: "work", path: dir, base, commits: true }] });
    const first = await supervisorBranches(app, task);
    const adopted = await supervisorBranches(app, { ...task, id: "adopted", sourceKind: "code", sourceId: root.id });
    for (const { text } of [first, adopted]) {
      expect(text).toContain("change-6");
      expect(text).not.toContain("change-1");
      expect(text).toContain("【范围外】（根目录） +21 -0");
      expect(text).not.toContain("正文不会进入汇总");
    }
    for (const name of ["docs", "examples"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "guide.md"), "增加一行\n");
    }
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "说明和样例"]);
    const second = await supervisorBranches(app, task, first.heads);
    expect(second.text).toContain("说明和样例");
    expect(second.text).not.toContain("change-6");
    expect(second.text).toContain("【范围外】examples/ +1 -0");
    expect(second.text).toMatch(/^docs\/ \+1 -0$/m);
    expect((await supervisorBranches(app, task, second.heads)).text).toContain("没有新提交");
    for (let i = 0; i < 35; i++) {
      const folder = join(dir, "outside-" + i);
      mkdirSync(folder);
      writeFileSync(join(folder, "a"), "one\n");
    }
    git(dir, ["rm", "examples/guide.md"]);
    git(dir, ["add", "."]);
    git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-m", "多个目录"]);
    const third = await supervisorBranches(app, task, second.heads);
    expect(third.text.split("\n")).toHaveLength(30);
    expect(third.text).toContain("【范围外】examples/ +0 -1");
    expect(third.text).toContain("行已省略");
    expect((await supervisorBranches(app, { ...task, id: "other" })).text).toBe("");

  });

  it("工作 Agent 和编码共用预算，工作结束仍由助手接手", async () => {
    const { app, lead, delegate, task } = await setup(1);
    const scope = { spaces: ["personal"], denyTools: [], userId: "owner", lark: { chats: [] } };
    const id = queueSupervisedAgent(app, lead.id, { agent: "assistant", task: "核对说明", assistantScope: scope });
    expect(() => delegate()).toThrow(/工作轮次/);
    run(app.db, "update runs set status='done' where id=?", id);
    const next = onWorkRunSettled(app, getRun(app, id))!;
    expect(getRun(app, next.coordinateRunId!)).toMatchObject({ kind: "supervise", input: { longTaskId: task.id } });
    expect(all(app.db, "select id from runs where kind='ask'")).toHaveLength(0);
  });

  it.each([1, 2])("工作者结束后收到答复，按总预算 %i 决定续轮或唤醒助手跟进", async rounds => {
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

  it("工作者在暂停期间提问并结束，继续后的第一轮跟进答复原问题", async () => {
    const { app, lead, task } = await setup();
    confirmLongTaskBrief(app, task.id, { doneWhen: ["说明已校对"] });
    const lane = `supervisor:${task.id}`;
    const scope = { spaces: ["personal"], denyTools: [], userId: "owner", lark: { chats: [] } };
    const worker = queueSupervisedAgent(app, lead.id, { agent: "assistant", task: "核对说明", assistantScope: scope });
    run(app.db, "update runs set status='done' where lane=?", lane);
    run(app.db, "update runs set status='running' where id=?", worker);
    await changeLongTask(app, task.id, { action: "pause" });
    const ask = createWorkerAsk(app, { runId: worker, question: "是否保留原示例？" });
    run(app.db, "update runs set status='done' where id=?", worker);
    onWorkRunSettled(app, getRun(app, worker));
    expect(queuedInLane(app, lane, "supervise")).toBeNull();

    await changeLongTask(app, task.id, { action: "resume" });
    const resumed = queuedInLane(app, lane, "supervise")!;
    const events = resumed.input.events as { note: string }[];
    expect(events.filter(e => e.note.includes(ask.id)).map(e => e.note)).toEqual([
      `运行 ${worker} 的问题 ${ask.id}\n${ask.question}`,
    ]);
    expect(events.some(e => e.note.includes(`工作运行 ${worker} 已完成`))).toBe(true);
    run(app.db, "update runs set status='running' where id=?", resumed.id);
    await submitSupervisorReport(app, resumed.id, {
      stage: "校对", status: "on-track", goalCheck: [], progress: { done: [], doing: [], next: [] },
      decisions: [], actions: [], askOwner: [], answers: [{ questionId: ask.id, answer: "保留", basis: task.goal }],
    });
    expect(getAsk(app, ask.id)).toMatchObject({ status: "answered", answer: "保留", answeredBy: "supervisor" });
    await changeLongTask(app, task.id, { action: "pause" });
    await changeLongTask(app, task.id, { action: "resume" });
    expect(JSON.stringify(queuedInLane(app, lane, "supervise")!.input.events)).not.toContain(ask.id);
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

  it("只处理本长任务的普通问题，助手答复返回工作者", async () => {
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
    expect(describeAnswer(await waiting)).toContain("助手回答");
    expect(getAsk(app, approval.id).status).toBe("pending");
  });

  it("修改项的新问题取代旧问题，完成结果只唤醒助手跟进", async () => {
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

  it.each([1, 2])("助手已重做两次，本人回答汇总卡后按总预算 %i 续轮", async rounds => {
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

  it("跟进处理过的修改项不能再交本人回答；卡发出后修改项变了，本人的选择仍作为补充交给跟进", async () => {
    const { app, task, lead, delegate } = await setup();
    confirmLongTaskBrief(app, task.id, { doneWhen: ["说明已校对"] });
    const worker = delegate();
    codeChainFor(app, worker);
    const item = addTask(app, worker.id, { kind: "build", title: "核对示例" }, "coder");
    const question = { question: "示例怎么处理？", options: ["保留", "替换"], why: "需要确定示例" };
    const settled = `task:${item.id}:${toDecide(app, worker.id, item.seq, question).origin.questionId}`;
    await answerWorkerQuestion(app, task.id, settled, "保留");
    run(app.db, "update runs set status='running' where id=?", lead.id);
    const report = { stage: "校对", status: "needs-owner" as const, goalCheck: [], progress: { done: [], doing: [], next: [] }, decisions: [], actions: [] };
    await expect(submitSupervisorReport(app, lead.id, { ...report, askOwner: [{ ...question, questionId: settled, prefer: "保留" }] })).rejects.toThrow(/已经处理过/);

    const waiting = `task:${item.id}:${toDecide(app, worker.id, item.seq, question).origin.questionId}`;
    await submitSupervisorReport(app, lead.id, { ...report, askOwner: [{ ...question, questionId: waiting, prefer: "保留" }] });
    updateTask(app, worker.id, item.seq, { state: "todo" });
    const [card] = listAsks(app, { conversationId: task.threadId, status: "pending" });
    await answerAsk(app, card.id, { by: task.userId, value: { q0: "替换" } });
    expect(getLongTask(app, task.id).supplements.at(-1)?.text).toBe("示例怎么处理？：替换（回答时这一项已经处理过，请按这个选择接着做）");
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
