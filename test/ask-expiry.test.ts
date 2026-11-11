import { describe, expect, it } from "vitest";
import { addAskSink, createAsk, getAsk, listAsks, type Ask } from "../src/agents/asks.ts";
import { lapseWorkAsks, sweepStaleAsks } from "../src/agents/ask-expiry.ts";
import { receive } from "../src/agents/inbox.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { setRunOutput } from "../src/agents/runs.ts";
import { askCard } from "../src/channels/lark-asks.ts";
import { run } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";
import { notify } from "../src/core/notify.ts";
import { testApp } from "./helpers.ts";

type App = ReturnType<typeof testApp>;
const newRun = (app: App, status: string, input: Record<string, unknown>, kind = "agent") => {
  const id = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", id, kind, "personal", status, "t", JSON.stringify(input), new Date().toISOString());
  return id;
};
const ctxOf = (app: App, runId: string) => toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
/** Sending and updating cards runs after the call returns: let it finish before the database closes. */
const close = async (app: App) => { await new Promise((r) => setTimeout(r, 300)); app.db.close(); };
/** Cards closed in a channel (what the Feishu sink would update). */
const closedCards: Ask[] = [];
addAskSink({ show: async () => false, closed: async (_app, a) => void closedCards.push(a) });

describe("open asks lapse when nobody waits for them any more", () => {
  it("the owner writing something else lapses the older questions of ended runs; held ones and host cards stay; the card says why and has no buttons", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const ended = newRun(app, "done", { conversationId: t.id });
      const working = newRun(app, "running", { conversationId: t.id });
      const old = createAsk(app, { runId: ended, question: "旧问题：周报发群里还是私聊？", options: [{ label: "群里" }, { label: "私聊" }] });
      const host = createAsk(app, { runId: ended, question: "评审计划要确认吗？", options: [{ label: "确认" }], context: { handler: "review-plan" } });
      const held = createAsk(app, { runId: working, question: "还在做的那一轮问的", options: [{ label: "好" }] });
      // The newest question takes the message as its answer; the older one of an ended run lapses.
      await receive(app, { conversationId: t.id, text: "先不管周报了，帮我查一下退款单 A-1 的状态" });
      expect(getAsk(app, held.id).status).toBe("answered");
      const lapsed = getAsk(app, old.id);
      expect(lapsed).toMatchObject({ status: "cancelled", lapsed: expect.stringContaining("接着说了别的") });
      expect(getAsk(app, host.id).status).toBe("pending");
      expect(closedCards.some((a) => a.id === old.id && a.status === "cancelled")).toBe(true);
      const card = JSON.stringify(askCard(app, lapsed));
      expect(card).toContain("已失效");
      expect(card).not.toContain("\"tag\":\"button\"");
      // The web's “等你回答” is only what still waits.
      expect(listAsks(app, { status: "pending" }).filter((a) => a.kind !== "suggestion").map((a) => a.id)).toEqual([host.id]);
    } finally { await close(app); }
  });

  it("a question an agent still waits for stays open; that agent can withdraw it itself", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const runId = newRun(app, "running", { conversationId: t.id });
      const ctx = ctxOf(app, runId);
      const first = await callTool(ctx, "ask_user", { question: "按 A 还是 B 改？", options: ["A", "B"], wait_seconds: 0 });
      const id = /ask[\w-]+/.exec(first.text)![0];
      expect(getAsk(app, id).status).toBe("pending");
      // Not answered by a message here: it is withdrawn because the owner changed course.
      const r = await callTool(ctx, "withdraw_ask", { ask_id: id, reason: "本人改成先查退款单" });
      expect(r.isError).toBe(false);
      expect(getAsk(app, id)).toMatchObject({ status: "cancelled", lapsed: "本人改成先查退款单" });
      expect((await callTool(ctx, "wait_answer", { ask_id: id, wait_seconds: 1 })).text).toContain("已失效：本人改成先查退款单");
      // Host decision cards cannot be withdrawn; nor can someone else's conversation's questions.
      const host = createAsk(app, { runId, question: "确认计划？", options: [{ label: "确认" }], context: { handler: "review-plan" } });
      expect((await callTool(ctx, "withdraw_ask", { ask_id: host.id })).isError).toBe(true);
      const other = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const foreign = createAsk(app, { runId: newRun(app, "done", { conversationId: other.id }), question: "别处的问题" });
      expect((await callTool(ctx, "withdraw_ask", { ask_id: foreign.id })).isError).toBe(true);
    } finally { await close(app); }
  });

  it("a delegation that ended takes its open questions and host cards with it", async () => {
    const app = testApp();
    try {
      const root = newRun(app, "done", { task: "改退款" }, "code");
      const round = newRun(app, "done", { task: "改退款", continueFrom: root }, "code");
      const q = createAsk(app, { runId: round, conversationId: null, question: "旧订单按哪个口径？", options: [{ label: "旧" }] });
      const deliver = createAsk(app, { runId: round, conversationId: null, question: "先推上去试？", options: [{ label: "推" }], context: { handler: "work-deliver", rootId: root } });
      const task = createAsk(app, { runId: round, conversationId: null, question: "T1 怎么定？", options: [{ label: "做" }], context: { handler: "code-task", workId: root, seq: 1 } });
      // Still going on: nothing lapses, even the host's cards.
      expect(sweepStaleAsks(app).work).toBe(0);
      setRunOutput(app, root, { discardedAt: new Date().toISOString() });
      expect(lapseWorkAsks(app, round)).toBe(2);
      expect(getAsk(app, q.id)).toMatchObject({ status: "cancelled", lapsed: "发起它的交办已经结束" });
      expect(getAsk(app, deliver.id).status).toBe("cancelled");
      // A delegation's task cards are set aside by the delegation itself (code-loop.ts reconcileWaiting).
      expect(getAsk(app, task.id).status).toBe("pending");
    } finally { await close(app); }
  });

  it("closing the item a run worked for lapses its questions and reads the item's notifications", async () => {
    const app = testApp();
    try {
      const item = upsertItem(app, undefined, { spaceId: "personal", title: "退款单 A-1 跟进", kind: "todo" }, "user");
      const runId = newRun(app, "done", { itemId: item.id });
      const q = createAsk(app, { runId, conversationId: null, question: "要不要通知客服？", options: [{ label: "要" }] });
      const n = notify(app, { title: "退款单 A-1 有新进展", entityId: item.id, sourceRefs: [] });
      upsertItem(app, item.id, { status: "done" }, "user");
      expect(getAsk(app, q.id)).toMatchObject({ status: "cancelled", lapsed: "它所属的事项已经关闭" });
      expect(app.db.prepare("select read_at from notifications where id = ?").get(n.id)).toMatchObject({ read_at: expect.any(String) });
    } finally { await close(app); }
  });

  it("the sweep clears what piled up: the owner went on, left too long; the day limit can be turned off", async () => {
    const app = testApp();
    try {
      const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
      const ended = newRun(app, "done", { conversationId: t.id });
      const passed = createAsk(app, { runId: ended, question: "发群里吗？", options: [{ label: "发" }] });
      const relayed = createAsk(app, { runId: ended, question: "另一个问题", options: [{ label: "好" }] });
      // Only the owner's own later words count: an answer relayed as a message does not.
      const later = new Date(Date.now() + 1000).toISOString();
      addMessage(app, t.id, "user", "[回答] 本人回答了别的", null, { fromAsk: true });
      run(app.db, "update messages set created_at = ?", later);
      expect(sweepStaleAsks(app).message).toBe(0);
      addMessage(app, t.id, "user", "换个事：查一下 A-1", null, {});
      run(app.db, "update messages set created_at = ? where json_extract(meta, '$.fromAsk') is null", later);
      // Both were shown before that message.
      expect(sweepStaleAsks(app).message).toBe(2);
      expect(getAsk(app, passed.id).status).toBe("cancelled");
      expect(getAsk(app, relayed.id).status).toBe("cancelled");

      const quiet = createAsk(app, { runId: null, conversationId: null, question: "很久以前的批准", kind: "approval", tool: "lark_doc_update", args: {} });
      const host = createAsk(app, { runId: null, conversationId: null, question: "规则要启用吗？", options: [{ label: "启用" }], context: { handler: "rule-enable" } });
      const old = new Date(Date.now() - 8 * 86400_000).toISOString();
      run(app.db, "update asks set created_at = ? where id in (?, ?)", old, quiet.id, host.id);
      app.config.asks.staleDays = 0;
      expect(sweepStaleAsks(app).stale).toBe(0);
      app.config.asks.staleDays = 7;
      expect(sweepStaleAsks(app).stale).toBe(1);
      expect(getAsk(app, quiet.id)).toMatchObject({ status: "cancelled", lapsed: "7 天没有人回答" });
      // A host card of work still going on stays; it would only be asked again.
      expect(getAsk(app, host.id).status).toBe("pending");
    } finally { await close(app); }
  });
});
