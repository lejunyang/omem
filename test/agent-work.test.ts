import { describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { __testHandlers as handlers, createRun, getRun, startWorker } from "../src/agents/runs.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { autoTurnsSinceOwner, MAX_AUTO_TURNS, workContext, workDeliveryTarget, workInConversation, type AgentWork } from "../src/agents/agent-work.ts";
import { deliverCoordination } from "../src/agents/jobs.ts";
import { replyFromSegments } from "../src/agents/types.ts";
import { localPathLinks } from "../src/channels/common.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { all, run } from "../src/core/db.ts";
import type { RunContext } from "../src/agents/runs.ts";
import { testApp } from "./helpers.ts";

/**
 * Stubs for the run kinds the work loop uses. The specialist answers with a report; the main
 * assistant's coordination turn (an ask with `coordinate`) is played by `coordinator`, which gets a
 * tool context of its own run (the real turn's tools see the same) and returns its reply.
 */
function stubHandlers(app: ReturnType<typeof testApp>, coordinator: (ctx: ToolContext, run: RunContext["run"]) => Promise<string>) {
  const origAgent = handlers.get("agent");
  const origAsk = handlers.get("ask");
  handlers.set("agent", async (ctx: RunContext) => ({ answer: `报告：${(ctx.run.input as { task: string }).task.slice(0, 20)}，${"结论A".repeat(200)}` }));
  handlers.set("ask", async (ctx: RunContext) => {
    const input = ctx.run.input as { conversationId: string; coordinate?: { workId: string; sourceRunIds?: string[] } };
    if (!input.coordinate) return { answer: "" };
    const tctx: ToolContext = { app, runId: ctx.run.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
    const answer = await coordinator(tctx, ctx.run);
    await deliverCoordination(ctx, input.coordinate, answer);
    return { answer };
  });
  return () => {
    if (origAgent) handlers.set("agent", origAgent);
    if (origAsk) handlers.set("ask", origAsk);
  };
}

async function settle(app: ReturnType<typeof testApp>, workId: string, ms = 15000) {
  const fresh = () => (getRun(app, workId).output as { agentWork: AgentWork }).agentWork;
  const busy = () => all(app.db, "select id from runs where (parent_id = ? or lane = ?) and status in ('queued','running')", workId, fresh().workConversationId).length > 0;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    if (!busy()) {
      await new Promise((r) => setTimeout(r, 300));
      if (!busy()) break;
    }
  }
  return fresh();
}

describe("multi-agent work", () => {
  // The run worker is process-wide, starts once and keeps polling: the cases share one app,
  // whose temporary database stays open until the test process ends.
  const app = testApp();
  startWorker(app);

  it("hands each report to the main assistant in the work conversation; its reply goes out once, with the report folded", async () => {
    const restore = stubHandlers(app, async () => "这一轮查清了 X：结论 A。不需要你决定。");
    try {
      saveAgentSpec(app, { name: "researcher-x", description: "调研", prompt: "只做调研", status: "active" }, "user");
      const root = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "长任务", input: { conversationId: root.id } });
      const ctx: ToolContext = { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
      const out = await callTool(ctx, "run_agent", { name: "researcher-x", own_topic: true, task: "去调研 X 的现状，给出建议" });
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/你会在那个工作会话里接手/);

      const w = await settle(app, ask.id);
      expect(w.rounds.map((r) => r.agent)).toEqual(["researcher-x"]);
      // The report sits in the work conversation as the agent's, and a coordination turn read it.
      const workMsgs = threadMessages(app, w.workConversationId, { limit: 50 });
      const report = workMsgs.find((m) => (m.meta.agentReport as { runId?: string } | undefined)?.runId === w.rounds[0].runId);
      expect(report?.text).toContain("结论A结论A");
      const coord = all<{ input: string }>(app.db, "select input from runs where lane = ? and kind = 'ask'", w.workConversationId);
      expect(coord.map((c) => JSON.parse(c.input).coordinate.sourceRunIds)).toEqual([[w.rounds[0].runId]]);
      // With no topic (web) the reply goes to the conversation the work was asked from, once, report folded.
      const replies = threadMessages(app, root.id, { limit: 50 }).filter((m) => m.text.includes("这一轮查清了 X"));
      expect(replies.length).toBe(1);
      expect(String(replies[0].meta.details)).toContain("结论A结论A");
      expect(threadMessages(app, root.id, { limit: 50 }).some((m) => m.text.includes("结论A".repeat(50)))).toBe(false);
    } finally {
      restore();
    }
  }, 60000);

  it("keeps the loop going on its own and stops at the cap until the owner speaks", async () => {
    const results: string[] = [];
    const restore = stubHandlers(app, async (tctx) => {
      const r = await callTool(tctx, "continue_agent_work", { task: "继续往下查" });
      results.push(r.isError ? `ERR ${r.text}` : "ok");
      return r.isError ? "已自动推进到上限，汇报进展：……要继续吗？" : "让 researcher-z 继续查下一步。";
    });
    try {
      saveAgentSpec(app, { name: "researcher-z", description: "调研", prompt: "只做调研", status: "active" }, "user");
      const root = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "长任务", input: { conversationId: root.id } });
      const ctx: ToolContext = { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
      await callTool(ctx, "run_agent", { name: "researcher-z", own_topic: true, task: "第一轮" });
      const w = await settle(app, ask.id, 40000);
      expect(results.slice(0, MAX_AUTO_TURNS)).toEqual(Array(MAX_AUTO_TURNS).fill("ok"));
      expect(results[MAX_AUTO_TURNS]).toMatch(/^ERR .*已经自动推进了/);
      expect(w.rounds.length).toBe(MAX_AUTO_TURNS + 1);
      // The owner speaking in the work resets the count.
      expect(autoTurnsSinceOwner(app, w)).toBe(MAX_AUTO_TURNS + 1);
      addMessage(app, w.workConversationId, "user", "继续，范围扩大到全部", null, {});
      expect(autoTurnsSinceOwner(app, w)).toBe(0);
      // A later round is told what happened in the work so far.
      const context = workContext(app, w, "none");
      expect(context).toContain("继续，范围扩大到全部");
      expect(context).toContain("researcher-z（第 1 轮报告）");
    } finally {
      restore();
    }
  }, 90000);

  it("in a topic: the reply goes to the topic only, and run_agent inside it continues the same work", async () => {
    const restore = stubHandlers(app, async () => "话题里的协调回复");
    try {
      saveAgentSpec(app, { name: "researcher-y", description: "调研", prompt: "只做调研", status: "active" }, "user");
      const root = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_chat", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "长任务", input: { conversationId: root.id } });
      const ctx: ToolContext = { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
      expect((await callTool(ctx, "run_agent", { name: "researcher-y", own_topic: true, task: "第一轮" })).isError).toBe(false);
      const first = (getRun(app, ask.id).output as { agentWork: AgentWork }).agentWork;
      // The topic was opened in Feishu: the work conversation now has the topic key, as Feishu names it.
      run(app.db, "update conversations set external_id = ? where id = ?", "oc_chat#omt_abc", first.workConversationId);
      expect(workInConversation(app, first.workConversationId)?.askRunId).toBe(ask.id);
      expect(workDeliveryTarget(app, first)).toBe(first.workConversationId);
      const w1 = await settle(app, ask.id);
      expect(threadMessages(app, w1.workConversationId, { limit: 50 }).filter((m) => m.text === "话题里的协调回复").length).toBe(1);
      expect(threadMessages(app, root.id, { limit: 50 }).some((m) => m.text.includes("话题里的协调回复"))).toBe(false);

      // The owner replies in the topic; the main assistant there delegates again → same work, same topic.
      const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "话题里追问", input: { conversationId: w1.workConversationId } });
      const again = await callTool({ ...ctx, runId: turn.id }, "run_agent", { name: "researcher-y", own_topic: true, task: "第二轮：补充数据" });
      expect(again.isError).toBe(false);
      expect(again.text).toMatch(/话题里安排/);
      const w2 = await settle(app, ask.id);
      expect(w2.workConversationId).toBe(w1.workConversationId);
      expect(w2.rounds.filter((r) => r.agent === "researcher-y").length).toBe(2);
      expect((getRun(app, turn.id).output as { agentWork?: AgentWork }).agentWork).toBeUndefined();
    } finally {
      restore();
    }
  }, 60000);

  it("continues an old work from a new topic there: rounds fork into the new conversation, queued old-lane rounds are cancelled", async () => {
    // The owner first starts a work in the old topic and lets its auto loop settle.
    let ask0: string;
    let stale: AgentWork;
    const quiet0 = stubHandlers(app, async () => "旧话题协调回复");
    try {
      saveAgentSpec(app, { name: "researcher-fork", description: "调研", prompt: "只做调研", status: "active" }, "user");
      const oldRoot = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_c#omt_old2", userId: "owner" });
      const a0 = createRun(app, { kind: "ask", spaceId: "personal", title: "旧任务", input: { conversationId: oldRoot.id } });
      ask0 = a0.id;
      await callTool({ app, runId: a0.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" }, "run_agent", { name: "researcher-fork", own_topic: true, task: "第一轮" });
      stale = await settle(app, a0.id, 40000);
    } finally {
      quiet0();
    }
    // Now the owner opens a new topic; its assistant turn continues the old work by ask id.
    const quiet1 = stubHandlers(app, async () => "不应由协调回合触发");
    try {
      const newRoot = createThread(app, { spaceId: "personal", channel: "lark", key: "oc_c#omt_new2", userId: "owner" });
      const ask1 = createRun(app, { kind: "ask", spaceId: "personal", title: "新话题", input: { conversationId: newRoot.id } });
      const out = await callTool({ app, runId: ask1.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" }, "continue_agent_work", { work_id: ask0, task: "新话题里的新要求" });
      expect(String(out.text)).toContain("转到当前话题");
      const w = (getRun(app, ask0).output as { agentWork: AgentWork }).agentWork;
      expect(w.workConversationId).not.toBe(stale.workConversationId);
      expect(w.rootConversationId).toBe(newRoot.id);
      await settle(app, ask0, 30000);
      const newMsgs = threadMessages(app, w.workConversationId, { limit: 50 });
      expect(newMsgs.some((m) => m.text.includes("结论A"))).toBe(true);
      const oldAfter = threadMessages(app, stale.workConversationId, { limit: 50 }).filter((m) => m.createdAt > ask1.createdAt);
      expect(oldAfter.some((m) => m.text === "已转到新话题")).toBe(false);
    } finally {
      quiet1();
    }
  }, 90000);
});

describe("replies", () => {
  it("keeps the text after the last tool call as the reply", () => {
    expect(replyFromSegments(["只有一段"])).toBeUndefined();
    const answer = `结论：${"这里是完整的回答，包含需要的数据和依据。".repeat(5)}`;
    expect(replyFromSegments(["我先核对一下。", "查到 3 条。", answer])).toBe(answer);
    // A short closing line after a final tool call (a write) keeps the answer before it.
    expect(replyFromSegments(["我先查。", "答案是 42，依据是原件第 3 行。", "已记下。"])).toBe("答案是 42，依据是原件第 3 行。\n\n已记下。");
  });

  it("turns links to files on this machine into readable references", () => {
    const app = testApp();
    try {
      const root = mkdtempSync(join(tmpdir(), "omem-repo-"));
      run(app.db, "insert into spaces(id,name,kind,description,root_path,settings,created_at,updated_at) values('project-a','项目 A','repo','',?,'{}',?,?)", root, new Date().toISOString(), new Date().toISOString());
      const md = `[模板合并代码](${root}/src/download/index.ts#L120-L140) 和 [导出](/tmp/out/result.xlsx)，另见 [文档](https://example.com/a)`;
      const out = localPathLinks(app, md);
      expect(out).toContain("模板合并代码（项目 A · `src/download/index.ts:120-140`）");
      expect(out).toContain("导出（`result.xlsx`）");
      expect(out).toContain("[文档](https://example.com/a)");
      expect(out).not.toContain(`](${root}`);
      expect(out).not.toContain("](/tmp");
    } finally {
      app.db.close();
    }
  });
});

describe("agent learning separation", () => {
  it("keeps agent specs short: long procedural prompts are redirected to skills/memories", async () => {
    const app = testApp();
    saveAgentSpec(app, { name: "reviewer-z", description: "评审", prompt: "短身份：只做评审。", status: "active" }, "user");
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner", spec: "reviewer-z" };
    const r = await callTool(ctx, "save_agent", { name: "reviewer-z", prompt: "x".repeat(4001) });
    expect(r.isError).toBe(true);
    expect(String(r.text)).toMatch(/save_skill/);
    // The owner editing in the web UI is not limited.
    expect(() => saveAgentSpec(app, { name: "reviewer-z", prompt: "y".repeat(4001) }, "user")).not.toThrow();
    app.db.close();
  });
});
