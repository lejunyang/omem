import { describe, expect, it } from "vitest";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { __testHandlers as handlers, createRun, getRun, startWorker, waitForRun } from "../src/agents/runs.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { saveAgentSpec } from "../src/agents/specs.ts";
import { deliverToThread } from "../src/agents/inbox.ts";
import type { RunContext } from "../src/agents/runs.ts";
import { testApp } from "./helpers.ts";

/** A stub that behaves like the real agent/agent-followup handlers: deliver to the right threads. */
function stubHandlers(app: ReturnType<typeof testApp>) {
  const origAgent = handlers.get("agent");
  const origFollowup = handlers.get("agent-followup");
  handlers.set("agent", async (ctx: RunContext) => {
    const input = ctx.run.input as { task: string; threadId?: string; agentWorkId?: string; spec?: string };
    const answer = "结论A".repeat(200);
    if (input.threadId) {
      addMessage(app, input.threadId, "assistant", `**${input.spec} 产出（完整记录）**\n\n${answer}`, ctx.run.id, { agent: input.spec, agentWorkRound: ctx.run.id });
      if (app.events) void deliverToThread(app, input.threadId, `**${input.spec} 产出（完整记录）**\n\n${answer}`, { runId: ctx.run.id });
    }
    return { answer };
  });
  handlers.set("agent-followup", async (ctx: RunContext) => {
    const input = ctx.run.input as { agentWorkId?: string; threadId?: string };
    const answer = `消化后的结论（${input.agentWorkId ? "work" : "no-work"}）：做了 1 件事，无需本人介入。`;
    const work = input.agentWorkId ? (getRun(app, input.agentWorkId).output as { agentWork?: { workConversationId: string; rootConversationId: string } }).agentWork : null;
    if (work) {
      addMessage(app, work.workConversationId, "assistant", answer, ctx.run.id, { agent: "digester" });
      addMessage(app, work.rootConversationId, "assistant", answer, ctx.run.id, { agent: "digester", agentWorkResult: input.agentWorkId });
    } else if (input.threadId) addMessage(app, input.threadId, "assistant", answer, ctx.run.id, {});
    return { answer };
  });
  return () => {
    if (origAgent) handlers.set("agent", origAgent);
    if (origFollowup) handlers.set("agent-followup", origFollowup);
  };
}

describe("multi-agent work", () => {
  it("starts a specialist in a child work conversation and brings only a digest back", async () => {
    const app = testApp();
    startWorker(app);
    const restore = stubHandlers(app);
    try {
      saveAgentSpec(app, { name: "researcher-x", description: "调研", prompt: "只做调研", status: "active" }, "user");
      const root = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "personal", title: "长任务", input: { conversationId: root.id } });

      const ctx: ToolContext = { app, runId: ask.id, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
      const out = await callTool(ctx, "run_agent", { name: "researcher-x", own_topic: true, task: "去调研 X 的现状，给出建议" });
      expect(out.isError).toBe(false);
      expect(out.text).toMatch(/独立工作会话/);

      const firstId = () => (getRun(app, ask.id).output as { agentWork: { rounds: { runId: string }[] } }).agentWork.rounds[0].runId;
      expect((await waitForRun(app, firstId())).status).toBe("done");

      const workId = (getRun(app, ask.id).output as { agentWork: { askRunId: string } }).agentWork.askRunId;
      const fresh = () => getRun(app, workId).output as { agentWork: { askRunId: string; workConversationId: string; rounds: { runId: string }[] } };
      let w = fresh();
      for (let i = 0; i < 50 && w.agentWork.rounds.length < 2; i++) await new Promise((r) => setTimeout(r, 100)), (w = fresh());
      expect(w.agentWork.rounds.length).toBeGreaterThanOrEqual(2);
      expect((await waitForRun(app, w.agentWork.rounds[1].runId)).status).toBe("done");

      // Work conversation gets the request and the raw report; the root gets only the digest.
      const workMsgs = threadMessages(app, w.agentWork.workConversationId, { limit: 50 });
      expect(workMsgs.some((m) => m.text.includes("结论A结论A"))).toBe(true);
      const rootMsgs = threadMessages(app, root.id, { limit: 50 });
      expect(rootMsgs.some((m) => m.text.includes("消化后的结论（work）"))).toBe(true);
      expect(rootMsgs.some((m) => m.text.includes("结论A".repeat(50)))).toBe(false);
    } finally {
      restore();
      app.db.close();
    }
  }, 60000);
});
