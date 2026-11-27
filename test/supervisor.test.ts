import { describe, expect, it, vi } from "vitest";
import { getRun, setRunOutput } from "../src/agents/runs.ts";
import { listAsks } from "../src/agents/asks.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { reattachThread, updateThread } from "../src/agents/threads.ts";
import { type LongTask, getLongTask, startLongTask } from "../src/agents/long-tasks.ts";
import { wakeSupervisor, checkSupervisorTimer, patchSupervisorState, runSupervisor } from "../src/agents/supervisor.ts";
import { submitSupervisorReport } from "../src/agents/supervisor-report.ts";
import { reportSchema } from "../src/agents/supervisor-schema.ts";
import { receive } from "../src/agents/inbox.ts";
import { pendingWakes } from "../src/agents/wakes.ts";
import { run, all } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";
import * as runner from "../src/agents/runner.ts";
import type { App } from "../src/core/app.ts";

const draftReport = reportSchema.parse({
  stage: "任务书", status: "on-track", goalCheck: ["改说明"], progress: { done: [], doing: [], next: ["核对说明"] },
  decisions: [{ what: "先核对入口", why: "目标要求逐项检查" }], actions: [], askOwner: [],
  brief: { scope: ["docs"], doneWhen: ["说明与入口一致"], outOfScope: ["发布"] },
});
async function setup() {
  const app = testApp();
  app.config.agents.profiles.push({ id: "stub", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
  const task = await startLongTask(app, { spaceId: "personal", userId: "owner", goal: "逐项核对说明。", ai: { profile: "stub" } });
  return { app, task };
}

function context(app: App, id: string) {
  run(app.db, "update runs set status='running' where id=?", id);
  return { app, run: getRun(app, id), signal: new AbortController().signal, event: () => {}, output: (data: Record<string,unknown>) => setRunOutput(app, id, data) };
}
function turn(app: App, task: LongTask) {
  return context(app, wakeSupervisor(app, task.id, "新证据", { immediate: true })!);
}

describe("长任务监工", () => {
  it("按话题接收本人原话，和待处理事件合在一轮", async () => {
    const { app, task } = await setup();
    const queued = wakeSupervisor(app, task.id, "修改项完成");
    await receive(app, { conversationId: task.threadId, text: "  保留这个换行\n和原有空格  ", userId: "owner" });
    const current = getLongTask(app, task.id);
    expect(JSON.stringify(current.supplements)).toContain(JSON.stringify("  保留这个换行\n和原有空格  ").slice(1,-1));
    expect(getRun(app, queued!).input.events).toEqual(expect.arrayContaining([expect.objectContaining({ note: "修改项完成" })]));
    expect(all(app.db, "select id from runs where kind='supervise'")).toHaveLength(1);
    expect(all(app.db, "select id from runs where kind='ask'")).toHaveLength(0);
  });

  it("指定后端暂时不可用时原轮排队，超时在话题留记录", async () => {
    const { app, task } = await setup();
    app.config.agents.profiles = [];
    const ctx = turn(app, task);
    const call = vi.spyOn(runner, "runRole");
    try {
      await expect(runSupervisor(ctx)).rejects.toMatchObject({ name: "Error", at: expect.any(String) });
      setRunOutput(app, ctx.run.id, { queueSince: Date.now() - 241 * 60_000 });
      await expect(runSupervisor(context(app, ctx.run.id))).rejects.toThrow(/本轮停止/);
      expect(call).not.toHaveBeenCalled();
      expect(all(app.db, "select text from messages where conversation_id=? and role='assistant'", task.threadId)).toContainEqual({ text: expect.stringContaining("stub") });
    } finally { call.mockRestore(); }
  });

  it("报告保存决定和进度，任务书由本人确认后生效", async () => {
    const { app, task } = await setup();
    const ctx = turn(app, task);
    const view = await submitSupervisorReport(app, ctx.run.id, draftReport);
    expect(view).toContain("修改项 0/0");
    expect(getRun(app, ctx.run.id).output.progressText).toBe(view);
    const latest = getLongTask(app,task.id);
    expect(JSON.stringify(latest.notes)).toContain("目标要求逐项检查");
    const card = listAsks(app, { conversationId: task.threadId, status: "pending" })[0];
    expect(card).toBeDefined();
    expect(latest.status).toBe("draft");
    expect(card.ui?.fields?.some(f => f.type === "textarea")).toBe(true);
  });

  it("任务书只发一张确认卡，后续汇报直接更新话题内已有的进度卡", async () => {
    const { app, task } = await setup();
    const ctx = turn(app, task);
    reattachThread(app, task.threadId, "lark", "oc_example#topic");
    updateThread(app, task.threadId, { settings: { lastMessageId: "om_anchor" } });
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: "om_progress" } }));
    const patch = vi.fn(async () => ({ code: 0, data: {} }));
    setLarkClient({ im: { message: { reply, patch } } });
    try {
      const redundant = { question: "是否确认草案？", options: ["确认","调整"], prefer: "确认", why: "已覆盖目标" };
      await expect(submitSupervisorReport(app, ctx.run.id, { ...draftReport, askOwner: [redundant] })).rejects.toThrow(/确认卡/);
      await submitSupervisorReport(app, ctx.run.id, draftReport);
      expect(reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: "om_anchor" }, data: expect.objectContaining({ reply_in_thread: true }) }));
      expect(listAsks(app, { conversationId: task.threadId, status: "pending" })).toHaveLength(1);
      run(app.db, "update long_tasks set status='active' where id=?", task.id);
      const next = turn(app, task);
      const text = await submitSupervisorReport(app, next.run.id, { ...draftReport, brief: undefined, stage: "验收" });
      expect(patch).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: "om_progress" }, data: { content: expect.stringContaining("验收") } }));
      expect(reply).toHaveBeenCalledTimes(1);
      expect(getRun(app, next.run.id).output.progressText).toBe(text);
    } finally { setLarkClient(null); }
  });

  it("同阶段续用会话，阶段变化或上下文到限时从任务书接手，信号原文置顶", async () => {
    const { app, task } = await setup();
    run(app.db, "update long_tasks set status='active' where id=?", task.id);
    app.config.sessions.background.maxContextTokens = 4000;
    const stages = ["实现", "实现", "验收", "验收", "验收"];
    const sizes = [100, 200, 250, 5000, 80];
    let index = 0;
    const stub = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      const n = index++;
      patchSupervisorState(app, task.id, { stage: stages[n] });
      setRunOutput(app, input.runId!, { supervisorReport: { stage: stages[n] } });
      expect(input.task.startsWith("路径越界")).toBe(true);
      expect(input.task).toContain(task.goal);
      return { profileId: "stub", ai: task.ai, agent: "stub", text: "", stopReason: "end_turn", sessionId: "session-" + n,
        contextUsage: { used: sizes[n], size: 100000 } };
    });
    try {
      for (const _stage of stages) {
        const id = wakeSupervisor(app, task.id, "路径越界", { drift: true })!;
        await runSupervisor(context(app, id));
        run(app.db, "update runs set status='done' where id=?", id);
      }
      expect(stub.mock.calls.map(([, input]) => input.resumeSessionId)).toEqual([undefined, "session-0", "session-1", undefined, undefined]);
    } finally { stub.mockRestore(); }
  });

  it("达到当天上限排到次日，定时检查没有新事实不排监工", async () => {
    const { app, task } = await setup();
    const ctx = turn(app, task);
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: app.config.timezone }).format(new Date());
    patchSupervisorState(app, task.id, { day, wakes: task.budget.dailyWakes });
    const call = vi.spyOn(runner, "runRole");
    try { await expect(runSupervisor(ctx)).rejects.toMatchObject({ at: expect.any(String) }); expect(call).not.toHaveBeenCalled(); }
    finally { call.mockRestore(); }
    await checkSupervisorTimer(app, task.id, "check");
    expect(all(app.db, "select id from runs where kind='supervise'")).toHaveLength(1);
    expect(pendingWakes(app)).toEqual([]);
  });
});
