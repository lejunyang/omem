import { describe, expect, it, vi } from "vitest";
import { addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { createWorkerAsk } from "../src/agents/supervisor-code.ts";
import { addTask, taskForFinding, updateTask } from "../src/agents/code-tasks.ts";
import { setupLarkBot } from "../src/channels/lark-bot.ts";
import { onLarkSent, setLarkBotClient, setLarkClient, setMentionResolver } from "../src/channels/lark-send.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import Fastify from "fastify";
import { registerLongTaskRoutes } from "../src/server/long-tasks-http.ts";
import { reattachThread, setChatSettings, updateThread } from "../src/agents/threads.ts";
import { type LongTask, confirmLongTaskBrief, getLongTask, startLongTask } from "../src/agents/long-tasks.ts";
import { wakeSupervisor, checkSupervisorTimer, patchSupervisorState, runSupervisor } from "../src/agents/supervisor.ts";
import { flushSupervisorPush, submitSupervisorReport } from "../src/agents/supervisor-report.ts";
import { reportSchema } from "../src/agents/supervisor-schema.ts";
import { deliverToThread, receive } from "../src/agents/inbox.ts";
import { pendingWakes } from "../src/agents/wakes.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser, linkIdentity } from "../src/core/users.ts";
import { run, all, one } from "../src/core/db.ts";
import { zonedParts } from "../src/core/util.ts";
import { testApp } from "./helpers.ts";
import { policySchema } from "../src/core/ai-policy-schema.ts";
import * as dispatch from "../src/agents/dispatch.ts";
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

  it("创建和唤醒使用监工类别，指定后端忙时沿用长任务的等待期限", async () => {
    const app = testApp();
    app.baseUrl = "http://127.0.0.1:1";
    const profile = { transport: "acp" as const, command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 };
    app.config.agents.profiles.push({ ...profile, id: "primary" }, { ...profile, id: "alternate" });
    app.config.agents.policy = policySchema.parse({ classes: {
      agents: { deny: ["ai:primary"] }, supervise: { use: ["ai:alternate", "ai:primary"], strict: true },
    } });
    const backend = vi.spyOn(dispatch, "runBackend").mockRejectedValue(new Error("backend busy"));
    try {
      const task = startLongTask(app, { spaceId: "personal", userId: "owner", goal: "核对说明", ai: { profile: "primary" } });
      const ctx = turn(app, task);
      await expect(runSupervisor(ctx)).rejects.toMatchObject({ at: expect.any(String) });
      expect(backend.mock.calls.map(call => call[1].id)).toEqual(["primary"]);
      const output = getRun(app, ctx.run.id).output;
      expect(output.queueSince).toEqual(expect.any(Number));
      expect(output.aiPolicyWaitUntil).toBeUndefined();
      setRunOutput(app, ctx.run.id, { queueSince: Date.now() - (app.config.agents.queueTimeoutMinutes + 1) * 60_000 });
      await expect(runSupervisor(context(app, ctx.run.id))).rejects.toThrow(/本轮停止/);
      expect(all(app.db, "select text from messages where conversation_id=?", task.threadId))
        .toContainEqual({ text: expect.stringContaining("本轮停止") });
    } finally { backend.mockRestore(); app.db.close(); }
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

  it("群话题中不带 @ 的暂停和结束、HTTP 和卡片按钮各更新原卡一次", async () => {
    const app = testApp();
    app.config.lark.ownerOpenId = "ou_owner";
    createSpace(app, { id: "docs", name: "项目文档" });
    createUser(app, { id: "editor", name: "编辑" });
    linkIdentity(app, "editor", "lark", "ou_editor");
    addMember(app, "docs", "editor", "editor");
    setChatSettings(app, "lark", "oc_example", { spaceId: "docs", mode: "chat" });
    let replyCount = 0;
    const reply = vi.fn(async ({ data }: { data: { content: string } }) => ({
      code: 0, data: { message_id: data.content.includes("长任务进度") ? "om_progress" : "om_reply_" + ++replyCount, thread_id: "omt_work" },
    }));
    const patch = vi.fn(async (_request: { path: { message_id: string }; data: { content: string } }) => ({ code: 0 }));
    const client = (openId: string) => ({
      request: async () => ({ bot: { open_id: openId } }),
      im: { message: { reply, patch }, chat: { get: async () => ({ data: { name: "项目群" } }) } },
    });
    const bot = await setupLarkBot(app, "main", client("ou_bot"));
    app.config.lark.bots.push({ id: "other", appId: "cli_other", agent: "assistant", enabled: true, userId: "editor", ownerOpenId: "ou_editor_other" });
    const otherBot = await setupLarkBot(app, "other", client("ou_other"));
    const server = Fastify();
    registerLongTaskRoutes(server, app, () => "editor");
    let sequence = 0;
    const send = async (text: string, { sender = "ou_editor", chat = "oc_example", topic = "omt_work", mention = false, receiver = bot } = {}) => {
      const id = "om_command_" + ++sequence;
      await receiver.message({ sender: { sender_type: "user", sender_id: { open_id: sender } }, message: {
        message_id: id, chat_id: chat, chat_type: "group", message_type: "text", thread_id: topic, create_time: String(Date.now()),
        content: JSON.stringify({ text: mention ? "@_user_1 " + text : text }),
        mentions: mention ? [{ key: "@_user_1", id: { open_id: "ou_bot" } }] : [],
      } });
      await receiver.settled();
      return id;
    };
    try {
      const anchor = await send("/监工 codex 核对示例", { topic: "", mention: true });
      const task = getLongTask(app, one<{ id: string }>(app.db, "select id from long_tasks")!.id);
      expect(task).toMatchObject({ spaceId: "docs", userId: "editor" });
      expect(await deliverToThread(app, task.threadId, task.goal, { openTopicFrom: anchor })).toBe(true);
      confirmLongTaskBrief(app, task.id, { doneWhen: ["示例已校对"] });
      await submitSupervisorReport(app, turn(app, task).run.id, { ...draftReport, brief: undefined, stage: "校对" });
      const repliesBefore = reply.mock.calls.length;
      await send("/监工 暂停", { sender: "ou_owner" });
      await send("/监工 暂停", { topic: "omt_other" });
      await send("/监工 暂停", { chat: "oc_other" });
      await send("/监工 暂停", { receiver: otherBot, sender: "ou_editor_other" });
      expect(reply).toHaveBeenCalledTimes(repliesBefore);
      addMember(app, "docs", "editor", "reader");
      await send("/监工 暂停");
      expect(reply.mock.calls.at(-1)?.[0].data.content).toContain("没有权限");
      expect(getLongTask(app, task.id).status).toBe("active");
      expect(patch).not.toHaveBeenCalled();
      addMember(app, "docs", "editor", "editor");

      await send("/监工 暂停");
      expect(getLongTask(app, task.id).status).toBe("paused");
      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch.mock.calls[0][0].data.content).toContain("已暂停");
      expect(patch.mock.calls[0][0].data.content).toContain('"action":"继续"');

      const resumed = await server.inject({ method: "PATCH", url: "/api/long-tasks/" + task.id, payload: { action: "resume" } });
      expect(resumed.json().status).toBe("active");
      expect(patch).toHaveBeenCalledTimes(2);
      expect(patch.mock.calls[1][0].data.content).toContain('"action":"暂停"');
      await handleCardAction(app, { operator: { open_id: "ou_editor" }, context: { open_message_id: "om_progress" }, action: { value: { action: "暂停" } } });
      expect(patch).toHaveBeenCalledTimes(3);
      expect(patch.mock.calls[2][0].data.content).toContain('"action":"继续"');

      await send("/监工 结束");
      expect(patch).toHaveBeenCalledTimes(4);
      expect(getLongTask(app, task.id).status).toBe("ended");
      const final = patch.mock.calls[3][0].data.content;
      expect(final).toContain("已结束");
      expect(final).not.toContain('"tag":"button"');
      expect(patch.mock.calls.every(([request]) => request.path.message_id === "om_progress")).toBe(true);
      expect(reply.mock.calls.filter(([request]) => request.data.content.includes("长任务进度"))).toHaveLength(1);
    } finally {
      onLarkSent(null);
      setMentionResolver(null);
      setLarkBotClient("other", null);
      setLarkClient(null);
      await server.close();
    }
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

  it("定时检查只把最近有事实的在跑工作交给监工", async () => {
    const { app, task } = await setup();
    const ctx = turn(app, task);
    const child = createRun(app, { kind: "code", title: "编辑说明", parentId: ctx.run.id });
    patchSupervisorState(app, task.id, { lastWake: new Date(Date.now() - 45 * 60000).toISOString() });
    run(app.db, "update runs set status='done' where id=?", ctx.run.id);
    run(app.db, "delete from run_events where run_id=?", child.id);
    await checkSupervisorTimer(app, task.id, "check");
    expect(all(app.db, "select id from runs where kind='supervise' and status='queued'")).toHaveLength(0);
    addRunEvent(app, child.id, "check", { text: "类型检查通过" });
    await checkSupervisorTimer(app, task.id, "check");
    expect(all(app.db, "select id from runs where kind='supervise' and status='queued'")).toHaveLength(1);
  });

  it("工作者的问题先留给监工，必须由本人决定的合成一张卡，答复写回原问题", async () => {
    const { app, task } = await setup();
    run(app.db, "update long_tasks set status='active' where id=?", task.id);
    const ctx = turn(app, task);
    const worker = createRun(app, { kind: "code", title: "编码", parentId: ctx.run.id });
    const questions = ["是否扩大目录？", "是否改业务约束？"].map(question => {
      const ask = createWorkerAsk(app, { runId: worker.id, question });
      return { questionId: ask.id, question, options: ["维持", "变更"], prefer: "维持", why: "沿用任务书" };
    });
    expect(listAsks(app, { status: "pending" })).toHaveLength(0);
    run(app.db, "update runs set status='done' where id=?", worker.id);
    await expect(submitSupervisorReport(app, ctx.run.id, { ...draftReport, brief: undefined, status: "done" })).rejects.toThrow(/问题待处理/);
    run(app.db, "update runs set status='running' where id=?", worker.id);
    await submitSupervisorReport(app, ctx.run.id, { ...draftReport, brief: undefined, status: "needs-owner", askOwner: questions });
    const cards = listAsks(app, { conversationId: task.threadId, status: "pending" });
    expect(cards).toHaveLength(1);
    expect(cards[0].ui?.fields).toMatchObject([{ type: "choice", default: "维持" }, { type: "choice", default: "维持" }]);
    await answerAsk(app, cards[0].id, { by: "owner", value: { q0: "变更", q1: "维持" } });
    expect(questions.map(q => getAsk(app, q.questionId).answer)).toEqual(["变更", "维持"]);
    expect(getLongTask(app, task.id).supplements.at(-1)?.text).toContain("是否扩大目录？：变更");
  });

  it("免打扰结束后一条摘要带上各阶段的纠偏", async () => {
    const { app, task } = await setup();
    const hour = zonedParts(Date.now(), app.config.timezone).hour;
    app.config.notify.quietStart = hour;
    app.config.notify.quietEnd = (hour + 1) % 24;
    run(app.db, "update long_tasks set status='active' where id=?", task.id);
    for (const action of ["收回范围外的改动", "补齐目标对应关系"]) {
      const ctx = turn(app, task);
      await submitSupervisorReport(app, ctx.run.id, { ...draftReport, brief: undefined, status: "drifting", actions: [action] });
    }
    const notices = () => all<{ body: string }>(app.db, "select body from notifications where title='长任务进展'");
    expect(notices()).toHaveLength(0);
    app.config.notify.quietEnd = hour;
    flushSupervisorPush(app, task);
    flushSupervisorPush(app, task);
    expect(notices()).toHaveLength(1);
    expect(notices()[0].body).toContain("收回范围外的改动");
    expect(notices()[0].body).toContain("补齐目标对应关系");
  });

  it("立即上报缺少目标、跟进超过两层和耗时超出同一交办中位数的原项", async () => {
    const { app, task } = await setup();
    run(app.db, "update long_tasks set status='active' where id=?", task.id);
    const supervisor = turn(app, task);
    const worker = createRun(app, { kind: "code", title: "校对说明", parentId: supervisor.run.id });
    const newFinding = taskForFinding(app, worker.id, { id: 1, title: "额外修改", suggestion: "", file_path: null, check_name: "评审" }, "review-lead");
    let parent = newFinding;
    for (let i = 0; i < 3; i++) {
      const next = addTask(app, worker.id, { title: "继续修复", kind: "fix", origin: { goal: task.goal } }, "review-lead");
      parent = updateTask(app, worker.id, next.seq, { origin: { ...next.origin, follows: parent.seq } });
    }
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
    for (const duration of [2, 4, 6]) addTask(app, worker.id, { kind: "build", title: "已完成项", state: "done",
      origin: { startedAt: ago(30 + duration), finishedAt: ago(30) } }, "coder");
    const slow = addTask(app, worker.id, { title: "核验示例", kind: "build", state: "coding", origin: { startedAt: ago(13) } }, "coder");
    updateTask(app, worker.id, slow.seq, { state: "done" });
    const queued = all<{ input: string }>(app.db, "select input from runs where kind='supervise' and status='queued'");
    expect(queued).toHaveLength(1);
    const events = JSON.parse(queued[0].input).events;
    for (const note of ["来源不明", "跟进修复超过两层", "中位数的三倍"])
      expect(events).toContainEqual({ drift: true, note: expect.stringContaining(note) });
  });
});
