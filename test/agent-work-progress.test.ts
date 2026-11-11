import { afterEach, describe, expect, it, vi } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { createRun, getRun } from "../src/agents/runs.ts";
import { addMessage, createThread, updateThread } from "../src/agents/threads.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { onlyMovedOn, queueAgentRound, refreshWork, startAgentWork, type AgentWork } from "../src/agents/agent-work.ts";
import { createAsk } from "../src/agents/asks.ts";
import { showThinking, watchAgentBubbles } from "../src/channels/lark-agent-cot.ts";
import { startReplyProgress } from "../src/channels/lark-progress.ts";
import { finishCot, hasCot, setCotSdk } from "../src/channels/lark-cot.ts";
import { flushWorkProgress, workProgressView } from "../src/channels/lark-work-progress.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { run } from "../src/core/db.ts";
import { testApp } from "./helpers.ts";

const owner = (app: ReturnType<typeof testApp>, runId: string | null, tools: string[] | null = null): ToolContext =>
  ({ app, runId, spaceId: "personal", spaces: null, tools: tools ? new Set(tools) : null, actor: "agent", userId: "owner" });

/** A work with one round, as run_agent(own_topic) leaves it. */
function work(app: ReturnType<typeof testApp>, channel = "web", key?: string) {
  saveAgentSpec(app, { name: "sheet-x", description: "整理表格", prompt: "只整理", status: "active" }, "user");
  const root = createThread(app, { spaceId: "personal", channel, key, userId: "owner" });
  const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "长任务", input: { conversationId: root.id } });
  const w = startAgentWork(app, { askRunId: ask.id, rootConversationId: root.id, spaceId: "personal", title: "整理表格", agent: "sheet-x", task: "第一轮", startMessage: "第一轮" });
  return { root, ask, work: w.work, roundId: w.runId };
}

describe("which coordination turns only move the work on", () => {
  it("a turn that handed out the next round and asked nothing stays in the work conversation; a question, the owner's words or 'all' are posted", () => {
    const app = testApp();
    const { work: w0, ask } = work(app);
    const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "协调", input: { conversationId: w0.workConversationId, coordinate: { workId: ask.id } }, lane: w0.workConversationId });
    // Nothing handed out: the result, posted.
    expect(onlyMovedOn(app, turn.id, ask.id)).toBe(false);
    queueAgentRound(app, refreshWork(app, ask.id)!, { agent: "sheet-x", task: "第二轮", queuedBy: turn.id });
    expect(onlyMovedOn(app, turn.id, ask.id)).toBe(true);
    // A report answered in the turn is not the owner speaking.
    const report = addMessage(app, w0.workConversationId, "assistant", "报告", null, { agentReport: { agent: "sheet-x", round: 1 } });
    expect(onlyMovedOn(app, turn.id, ask.id, [report])).toBe(true);
    // The owner's words in the same turn: the reply answers them, posted.
    const said = addMessage(app, w0.workConversationId, "user", "顺便把 B 列也补上", null, {});
    expect(onlyMovedOn(app, turn.id, ask.id, [report, said])).toBe(false);
    // Every coordination reply goes out in the 'all' mode.
    app.config.agents.progress = { messages: "all", thinking: "own" };
    expect(onlyMovedOn(app, turn.id, ask.id)).toBe(false);
    app.config.agents.progress = { messages: "milestones", thinking: "own" };
    // A question to the owner in the turn (ask_user, an approval) is a milestone.
    createAsk(app, { runId: turn.id, question: "用哪个口径？", options: [{ label: "A" }] });
    expect(onlyMovedOn(app, turn.id, ask.id)).toBe(false);
    app.db.close();
  });

  it("the work waiting for the owner is never quiet", () => {
    const app = testApp();
    const { work: w0, ask } = work(app);
    const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "协调", input: { conversationId: w0.workConversationId, coordinate: { workId: ask.id } }, lane: w0.workConversationId });
    queueAgentRound(app, refreshWork(app, ask.id)!, { agent: "sheet-x", task: "第二轮", queuedBy: turn.id });
    const w = refreshWork(app, ask.id)!;
    run(app.db, "update runs set output = json_set(output, '$.agentWork.awaitingUser', json('true')) where id = ?", w.askRunId);
    expect(onlyMovedOn(app, turn.id, ask.id)).toBe(false);
    app.db.close();
  });
});

describe("lending tools with a hand-off", () => {
  it("lends only what the lender has, never writing Feishu as the owner, and records them on the round", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "sheet-y", description: "整理表格", prompt: "只整理", status: "active" }, "user");
    const root = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
    const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "长任务", input: { conversationId: root.id } });
    const mine = ["run_agent", "continue_agent_work", "lark_read", "lark_write", "search"];
    // Not its own: refused.
    const notMine = await callTool(owner(app, ask.id, mine), "run_agent", { name: "sheet-y", own_topic: true, task: "整理", extra_tools: ["generate_image"] });
    expect(notMine.isError).toBe(true);
    expect(notMine.text).toContain("自己没有 generate_image");
    // Writing Feishu as the owner: never lent.
    const owners = await callTool(owner(app, ask.id, mine), "run_agent", { name: "sheet-y", own_topic: true, task: "整理", extra_tools: ["lark_write"] });
    expect(owners.isError).toBe(true);
    expect(owners.text).toContain("不能借给别的 Agent");
    // Handing on again: never lent.
    expect((await callTool(owner(app, ask.id, mine), "run_agent", { name: "sheet-y", own_topic: true, task: "整理", extra_tools: ["run_agent"] })).isError).toBe(true);
    expect((await callTool(owner(app, ask.id, mine), "run_agent", { name: "sheet-y", own_topic: true, task: "整理", extra_tools: ["no_such_tool"] })).isError).toBe(true);
    // Its own read tool: lent for this round.
    const ok = await callTool(owner(app, ask.id, mine), "run_agent", { name: "sheet-y", own_topic: true, task: "整理", extra_tools: ["lark_read"] });
    expect(ok.isError).toBe(false);
    expect(ok.text).toContain("借给它 lark_read");
    const w = (getRun(app, ask.id).output as { agentWork: AgentWork }).agentWork;
    expect(getRun(app, w.rounds[0].runId).input).toMatchObject({ extraTools: ["lark_read"], queuedBy: ask.id });
    // The next round lends again only when asked; continue_agent_work checks the same way.
    const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "协调", input: { conversationId: w.workConversationId, coordinate: { workId: ask.id } }, lane: w.workConversationId });
    expect((await callTool(owner(app, turn.id, mine), "continue_agent_work", { task: "下一步", extra_tools: ["lark_write"] })).isError).toBe(true);
    const next = await callTool(owner(app, turn.id, mine), "continue_agent_work", { task: "下一步", extra_tools: ["search"] });
    expect(next.isError).toBe(false);
    const w2 = refreshWork(app, ask.id)!;
    expect(getRun(app, w2.rounds.at(-1)!.runId).input).toMatchObject({ extraTools: ["search"], queuedBy: turn.id });
    app.db.close();
  });
});

describe("thinking bubbles", () => {
  afterEach(() => { setCotSdk(null); setLarkClient(null); vi.useRealTimers(); });

  it("three settings: all, only the owner's own message, off", () => {
    const app = testApp();
    expect(app.config.agents.progress.thinking).toBe("own");
    expect(showThinking(app, true)).toBe(true);
    expect(showThinking(app, false)).toBe(false);
    app.config.agents.progress = { ...app.config.agents.progress, thinking: "all" };
    expect(showThinking(app, false)).toBe(true);
    app.config.agents.progress = { ...app.config.agents.progress, thinking: "off" };
    expect(showThinking(app, true)).toBe(false);
    app.db.close();
  });

  it("background runs (a delegated round, a coordination turn) get a bubble only with 'all'; a turn answering the owner's words with 'own'", async () => {
    for (const [mode, kind, expected] of [["own", "agent", 0], ["all", "agent", 1], ["own", "owner-turn", 1], ["own", "coordinate", 0], ["off", "owner-turn", 0]] as const) {
      const app = testApp();
      app.config.agents.progress = { messages: "milestones", thinking: mode };
      setCotSdk({ request: async () => ({ code: 0, data: { cot_id: "c", message_id: "om_native" } }) });
      const t = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_chat#omt_1", userId: "owner" });
      updateThread(app, t.id, { settings: { lastMessageId: "om_topic" } });
      const said = addMessage(app, t.id, "user", "帮我看看", null, {});
      const report = addMessage(app, t.id, "assistant", "报告", null, { agentReport: { agent: "x", round: 1 } });
      const r = kind === "agent"
        ? createRun(app, { kind: "agent", title: "一轮", input: { spec: "x", task: "整理", threadId: t.id } })
        : createRun(app, { kind: "ask", title: "一轮", input: { conversationId: t.id, messageIds: kind === "owner-turn" ? [said] : [report], coordinate: { workId: "w" } } });
      watchAgentBubbles(app);
      app.emit({ type: "run", runId: r.id, status: "running" });
      expect([mode, kind, hasCot(r.id) ? 1 : 0]).toEqual([mode, kind, expected]);
      finishCot(app, r.id, true, true);
      app.db.close();
    }
  });

  it("a reply without a bubble only reacts: no bubble, no fallback card", async () => {
    vi.useFakeTimers();
    const app = testApp();
    const replies: unknown[] = [];
    let cots = 0;
    setCotSdk({ request: async () => { cots++; return { code: 0, data: { cot_id: "c", message_id: "om_native" } }; } });
    setLarkClient({ im: {
      message: { reply: async (a: unknown) => { replies.push(a); return { code: 0, data: { message_id: "om_x" } }; }, patch: async () => ({ code: 0 }) },
      messageReaction: { create: async () => ({ code: 0, data: { reaction_id: "r" } }), delete: async () => ({ code: 0 }) },
    } });
    const r = createRun(app, { kind: "ask", title: "问题", input: {} });
    run(app.db, "update runs set status='running' where id=?", r.id);
    const p = startReplyProgress(app, { chatId: "oc_x", messageId: "om_q", inThread: false }, r.id, { bubble: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p.close()).toBeNull();
    expect(cots).toBe(0);
    expect(replies).toHaveLength(0);
    app.db.close();
  });
});

describe("the work's progress card", () => {
  afterEach(() => setLarkClient(null));

  it("is one card in the topic, updated in place, saying who works on what", async () => {
    const app = testApp();
    const replies: any[] = [];
    const patches: any[] = [];
    setLarkClient({ im: { message: {
      reply: async (a: any) => { replies.push(a); return { code: 0, data: { message_id: "om_card", thread_id: "omt_1" } }; },
      patch: async (a: any) => { patches.push(a); return { code: 0 }; },
    } } });
    const { work: w0, ask, roundId } = work(app, "lark", "oc_chat");
    // Before the topic exists: nothing.
    await flushWorkProgress(app, ask.id);
    expect(replies).toHaveLength(0);
    run(app.db, "update conversations set external_id = ? where id = ?", "oc_chat#omt_1", w0.workConversationId);
    updateThread(app, w0.workConversationId, { settings: { lastMessageId: "om_topic" } });
    run(app.db, "update runs set status = 'running' where id = ?", roundId);
    run(app.db, "insert into run_events(run_id, seq, at, type, data) values(?, 1, ?, 'tool', ?)", roundId, new Date().toISOString(), JSON.stringify({ title: "读表格第 2 页" }));
    const v = workProgressView(app, refreshWork(app, ask.id)!);
    expect(v.live).toBe(true);
    expect(v.lines.join("\n")).toContain("sheet-x 在做：第一轮");
    expect(v.lines.join("\n")).toContain("最近：读表格第 2 页");
    expect(v.link).toContain(roundId);
    await flushWorkProgress(app, ask.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ path: { message_id: "om_topic" }, data: { reply_in_thread: true } });
    // Same state: nothing sent again.
    await flushWorkProgress(app, ask.id);
    expect(replies).toHaveLength(1);
    expect(patches).toHaveLength(0);
    // The round ends: the same card is updated.
    run(app.db, "update runs set status = 'done' where id = ?", roundId);
    run(app.db, "update runs set output = json_set(output, '$.agentWork.rounds[0].status', 'done') where id = ?", ask.id);
    await flushWorkProgress(app, ask.id);
    expect(replies).toHaveLength(1);
    expect(patches).toHaveLength(1);
    expect(patches[0].path.message_id).toBe("om_card");
    expect(String(patches[0].data.content)).toContain("回复这个话题可以接着做");
    // In the 'all' mode there is no card.
    app.config.agents.progress = { messages: "all", thinking: "own" };
    run(app.db, "update runs set status = 'running' where id = ?", roundId);
    await flushWorkProgress(app, ask.id);
    expect(patches).toHaveLength(1);
    app.db.close();
  });
});
