import { describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { __testHandlers as handlers, createRun, getRun, startWorker, waitForRun } from "../src/agents/runs.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { workDeliveryTarget, workInConversation, type AgentWork } from "../src/agents/agent-work.ts";
import { replyFromSegments } from "../src/agents/types.ts";
import { localPathLinks } from "../src/channels/common.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/core/db.ts";
import type { RunContext } from "../src/agents/runs.ts";
import { testApp } from "./helpers.ts";

/** Stubs that behave like the real agent/agent-followup handlers: the report is kept, one digest is delivered. */
function stubHandlers(app: ReturnType<typeof testApp>) {
  const origAgent = handlers.get("agent");
  const origFollowup = handlers.get("agent-followup");
  handlers.set("agent", async (ctx: RunContext) => {
    const input = ctx.run.input as { task: string; threadId?: string; agentWorkId?: string; spec?: string };
    const answer = "结论A".repeat(200);
    if (input.threadId) addMessage(app, input.threadId, "assistant", `**${input.spec} 产出（完整记录）**\n\n${answer}`, ctx.run.id, { agent: input.spec, agentWorkRound: ctx.run.id, record: true });
    return { answer };
  });
  handlers.set("agent-followup", async (ctx: RunContext) => {
    const input = ctx.run.input as { agentWorkId?: string; threadId?: string; sourceRunId?: string };
    const answer = `消化后的结论（来源 ${input.sourceRunId}）：做了 1 件事。`;
    const work = input.agentWorkId ? (getRun(app, input.agentWorkId).output as { agentWork?: AgentWork }).agentWork : null;
    if (work) addMessage(app, workDeliveryTarget(app, work), "assistant", answer, ctx.run.id, { agent: "digester", agentWorkResult: input.agentWorkId });
    return { answer };
  });
  return () => {
    if (origAgent) handlers.set("agent", origAgent);
    if (origFollowup) handlers.set("agent-followup", origFollowup);
  };
}

async function waitRounds(app: ReturnType<typeof testApp>, workId: string, n: number) {
  const fresh = () => (getRun(app, workId).output as { agentWork: AgentWork }).agentWork;
  let w = fresh();
  for (let i = 0; i < 80 && (w.rounds.length < n || w.rounds.some((r) => r.status === "queued")); i++) await new Promise((r) => setTimeout(r, 100)), (w = fresh());
  for (const r of w.rounds) await waitForRun(app, r.runId);
  return fresh();
}

describe("multi-agent work", () => {
  // The run worker is process-wide, starts once and keeps polling: both cases share one app,
  // whose temporary database stays open until the test process ends.
  const app = testApp();
  startWorker(app);

  it("starts a specialist in a work conversation; the digest of the round is delivered once", async () => {
    const restore = stubHandlers(app);
    try {
      saveAgentSpec(app, { name: "researcher-x", description: "调研", prompt: "只做调研", status: "active" }, "user");
      const root = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "长任务", input: { conversationId: root.id } });

      const ctx: ToolContext = { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
      const out = await callTool(ctx, "run_agent", { name: "researcher-x", own_topic: true, task: "去调研 X 的现状，给出建议" });
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/独立工作会话/);

      const w = await waitRounds(app, ask.id, 2);
      expect(w.rounds.map((r) => r.agent)).toEqual(["researcher-x", "digester"]);
      // The digest knows which round it digests (its report goes along, folded, in Feishu).
      expect((getRun(app, w.rounds[1].runId).input as { sourceRunId?: string }).sourceRunId).toBe(w.rounds[0].runId);

      // Work conversation keeps the full report; with no topic (web) the digest goes to the root, once.
      const workMsgs = threadMessages(app, w.workConversationId, { limit: 50 });
      expect(workMsgs.some((m) => m.text.includes("结论A结论A"))).toBe(true);
      const rootMsgs = threadMessages(app, root.id, { limit: 50 });
      expect(rootMsgs.filter((m) => m.text.includes("消化后的结论")).length).toBe(1);
      expect(rootMsgs.some((m) => m.text.includes("结论A".repeat(50)))).toBe(false);
    } finally {
      restore();
    }
  }, 60000);

  it("in a topic: the digest goes to the topic only, and run_agent inside it continues the same work", async () => {
    const restore = stubHandlers(app);
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
      const w1 = await waitRounds(app, ask.id, 2);
      expect(threadMessages(app, w1.workConversationId, { limit: 50 }).filter((m) => m.text.includes("消化后的结论")).length).toBe(1);
      expect(threadMessages(app, root.id, { limit: 50 }).some((m) => m.text.includes("消化后的结论"))).toBe(false);

      // The owner replies in the topic; the main assistant there delegates again → same work, same topic.
      const turn = createRun(app, { kind: "ask", spaceId: "personal", title: "话题里追问", input: { conversationId: w1.workConversationId } });
      const inTopic: ToolContext = { ...ctx, runId: turn.id };
      const again = await callTool(inTopic, "run_agent", { name: "researcher-y", own_topic: true, task: "第二轮：补充数据" });
      expect(again.isError).toBe(false);
      expect(again.text).toMatch(/话题里安排/);
      const w2 = await waitRounds(app, ask.id, 4);
      expect(w2.workConversationId).toBe(w1.workConversationId);
      expect(w2.rounds.filter((r) => r.agent === "researcher-y").length).toBe(2);
      // No second work conversation was opened from the topic.
      expect((getRun(app, turn.id).output as { agentWork?: AgentWork }).agentWork).toBeUndefined();
    } finally {
      restore();
    }
  }, 60000);
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
