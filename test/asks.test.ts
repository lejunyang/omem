import { describe, expect, it } from "vitest";
import { answerAsk, createAsk, getAsk, listAsks, registerAskHandler, settleAsks, showSuggestions } from "../src/agents/asks.ts";
import { receive } from "../src/agents/inbox.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createThread, threadMessages } from "../src/agents/threads.ts";
import { all, one, run } from "../src/core/db.ts";
import { ANSWER_WAIT_MS, handleAskAction, askCard } from "../src/channels/lark-asks.ts";
import { testApp } from "./helpers.ts";
import { addTask, ownerQuestionText } from "../src/agents/code-tasks.ts";

/** A conversation with an agent run working in it (no real agent: the row is enough for asks). */
function working(status = "running") {
  const app = testApp();
  const t = createThread(app, { spaceId: "personal", channel: "web", userId: "owner" });
  const runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", runId, "agent", "personal", status, "t", JSON.stringify({ conversationId: t.id }), new Date().toISOString());
  const ctx = toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
  return { app, thread: t, runId, ctx };
}
const turns = (app: ReturnType<typeof testApp>, conv: string) => all<{ input: string }>(app.db, "select input from runs where kind = 'ask'").filter((r) => JSON.parse(r.input).conversationId === conv);

describe("asking the owner", () => {
  it("shows the coding decision and buttons before folded technical history in Feishu", () => {
    const { app, thread, runId } = working("done");
    try {
      const task = addTask(app, runId, { title: "旧订单的退款口径", kind: "fix", state: "owner", question: "旧订单沿用旧口径，还是也按新口径？", doneWhen: "按选择覆盖旧订单。" }, "review-lead");
      const history = "具体技术调查与多次修复记录。".repeat(900);
      const ask = createAsk(app, { runId, conversationId: thread.id, userId: "owner", question: ownerQuestionText(app, task) + "\n" + history, options: [{ label: "旧口径" }, { label: "新口径" }], context: { handler: "code-task", workId: runId, seq: task.seq } });
      const card = askCard(app, ask);
      const elements = (card.body as { elements: any[] }).elements;
      const visible = elements.filter((e) => e.tag === "markdown").map((e) => e.content).join("\n");
      expect(visible).toContain(task.question);
      expect(visible.length).toBeLessThan(1600);
      expect(visible).not.toContain(history);
      const fold = elements.find((e) => e.tag === "collapsible_panel");
      expect(fold.expanded).toBe(false);
      expect(fold.elements[0].content).toContain(history);
      expect(JSON.stringify(elements.find((e) => e.tag === "form"))).toContain("opt_1");
    } finally { app.db.close(); }
  });
  it("an agent waiting gets a plain reply in the chat as the answer, and that reply starts no turn", async () => {
    const { app, thread, ctx } = working();
    const call = callTool(ctx, "ask_owner", { question: "发布改到周四还是周五？", options: ["周四", "周五"], wait_seconds: 5 });
    await new Promise((r) => setTimeout(r, 100));
    const ask = listAsks(app, { conversationId: thread.id })[0];
    expect(ask).toMatchObject({ kind: "question", status: "pending", options: [{ label: "周四" }, { label: "周五" }] });
    const r = await receive(app, { conversationId: thread.id, text: "周五吧，周四有评审" });
    expect(r.runId).toBeNull();
    expect((await call).text).toContain("周五吧，周四有评审");
    expect(getAsk(app, ask.id)).toMatchObject({ status: "answered", consumed: true });
    expect(turns(app, thread.id)).toHaveLength(0);
    expect(threadMessages(app, thread.id).at(-1)).toMatchObject({ role: "user", text: "周五吧，周四有评审" });
  });

  it("a number picks an option; an answer nobody waited for arrives as a message once the run has ended", async () => {
    const { app, thread, ctx, runId } = working();
    const first = await callTool(ctx, "ask_owner", { question: "选哪个方案？", options: ["A", "B"], wait_seconds: 0 });
    expect(first.text).toMatch(/wait_answer/);
    const ask = listAsks(app, { conversationId: thread.id })[0];
    // While the run still works, the answer waits for it (wait_answer would get it).
    await answerAsk(app, ask.id, { choice: 1, by: "owner" });
    expect(turns(app, thread.id)).toHaveLength(0);
    expect((await callTool(ctx, "wait_answer", { ask_id: ask.id, wait_seconds: 1 })).text).toContain("B");
    // Not consumed this time: settled when the run ends, it comes to the conversation.
    const again = createAsk(app, { runId, question: "要通知发布群吗？", options: [{ label: "要" }, { label: "不要" }] });
    run(app.db, "update runs set status = 'done' where id = ?", runId);
    expect((await receive(app, { conversationId: thread.id, text: "2" })).runId).toBeNull();
    expect(getAsk(app, again.id)).toMatchObject({ status: "answered", answer: "不要" });
    expect(turns(app, thread.id).map((r) => JSON.parse(r.input).messageIds?.length ?? 1)).toHaveLength(1);
    expect(threadMessages(app, thread.id).some((m) => m.text.startsWith("[回答]") && m.text.includes("不要"))).toBe(true);
    await settleAsks(app, runId);
  });

  it("a question the host acts on is not answered by whatever the owner says next in the chat", async () => {
    const { app, thread, runId } = working("done");
    const { registerAskHandler } = await import("../src/agents/asks.ts");
    const handled: string[] = [];
    registerAskHandler("test-hosted", async (_app, a) => void handled.push(a.answer ?? ""));
    const ask = createAsk(app, { runId, conversationId: thread.id, question: "评审结束，怎么办？", options: [{ label: "按评审修改" }, { label: "先不改" }], context: { handler: "test-hosted" } });
    // Meant for the assistant: a turn of its own, the card stays open.
    expect((await receive(app, { conversationId: thread.id, text: "现在有权限了吗，刚刚绑定了机器人" })).runId).toBeTruthy();
    expect(getAsk(app, ask.id).status).toBe("pending");
    expect(handled).toEqual([]);
    // Starting with an option (and what to add) is the answer.
    expect((await receive(app, { conversationId: thread.id, text: "按评审修改，另外把空态也改了" })).runId).toBeNull();
    expect(getAsk(app, ask.id)).toMatchObject({ status: "answered", choice: 0 });
    expect(handled).toEqual(["按评审修改：另外把空态也改了"]);
  });

  it("suggested next steps show under the reply; a click says its message, a new message lets them lapse", async () => {
    const { app, thread, ctx, runId } = working();
    const r = await callTool(ctx, "suggest_next", { options: [{ label: "按 A 改", message: "按方案 A 改，改完跑测试" }, "先不改"] });
    expect(r.isError).toBeFalsy();
    const [s] = listAsks(app, { conversationId: thread.id });
    expect(s).toMatchObject({ kind: "suggestion", shownAt: null, allowText: false });
    run(app.db, "update runs set status = 'done' where id = ?", runId);
    await showSuggestions(app, runId);
    expect(getAsk(app, s.id).shownAt).not.toBeNull();
    await answerAsk(app, s.id, { choice: 0, by: "owner" });
    expect(threadMessages(app, thread.id).at(-1)).toMatchObject({ role: "user", text: "按方案 A 改，改完跑测试" });
    expect(turns(app, thread.id)).toHaveLength(1);
    // Newer suggestions replace older ones; typing something else lets them lapse.
    const next = createAsk(app, { runId, kind: "suggestion", question: "", options: [{ label: "继续" }] });
    await showSuggestions(app, runId);
    await receive(app, { conversationId: thread.id, text: "换个话题：周报写了吗" });
    expect(getAsk(app, next.id).status).toBe("cancelled");
  });

  it("holds a listed tool for approval; approved it runs in the original context, refused the reason goes back", async () => {
    const { app, ctx } = working();
    app.config.approvals = { tools: ["upsert_item"], waitSeconds: 0 };
    const held = await callTool(ctx, "upsert_item", { title: "交报销单", kind: "todo" });
    expect(held.text).toMatch(/需要本人批准/);
    expect(one<{ n: number }>(app.db, "select count(*) n from items")?.n).toBe(0);
    const ask = listAsks(app, { status: "pending" })[0];
    expect(ask).toMatchObject({ kind: "approval", tool: "upsert_item" });
    const done = await answerAsk(app, ask.id, { approved: true, text: "可以", by: "owner" });
    expect(done.result).toMatch(/交报销单|已/);
    expect(one<{ n: number }>(app.db, "select count(*) n from items")?.n).toBe(1);
    await callTool(ctx, "upsert_item", { title: "删掉旧事项", kind: "todo" });
    const second = listAsks(app, { status: "pending" })[0];
    await answerAsk(app, second.id, { approved: false, text: "先别动，等我看过", by: "owner" });
    expect((await callTool(ctx, "wait_answer", { ask_id: second.id, wait_seconds: 1 })).text).toMatch(/拒绝.*先别动，等我看过/);
    // The owner's own calls are never held.
    const owner = toolContextForToken(app, issueToolToken({ runId: null, spaceId: "personal", spaces: null, tools: null, actor: "user" }))!;
    expect((await callTool(owner, "upsert_item", { title: "本人自己建的", kind: "todo" })).text).not.toMatch(/批准/);
  });

  it("answers from a Feishu card: option buttons, a typed answer, approve or refuse with a reason", async () => {
    const { app, runId } = working();
    const q = createAsk(app, { runId, question: "哪天发布？", options: [{ label: "周四" }, { label: "周五" }] });
    const card = JSON.stringify(askCard(app, q));
    expect(card).toContain("opt_0");
    expect(card).toContain("用文字回答");
    expect((await handleAskAction(app, "ci", q.id, { name: "opt_1", formValue: { text: "下午" } }, "owner")).toast).toBe("已回答");
    expect(getAsk(app, q.id).answer).toBe("周五：下午");
    expect((await handleAskAction(app, "ci", q.id, { name: "opt_0" }, "owner")).toast).toBe("已经处理过了");
    const a = createAsk(app, { runId, kind: "approval", question: "要执行 forget", tool: "forget", args: {} });
    expect((await handleAskAction(app, "ci", a.id, { name: "submit" }, "owner")).toast).toBe("请点批准或拒绝");
    await handleAskAction(app, "ci", a.id, { name: "reject", formValue: { text: "这条还有用" } }, "owner");
    expect(getAsk(app, a.id)).toMatchObject({ approved: false, answer: "这条还有用" });
    expect(JSON.stringify(askCard(app, getAsk(app, a.id)))).toContain("已拒绝");
  });

  it("gives every long option its own wrapping row and keeps text submission after the input", async () => {
    const { app, runId } = working();
    const options = Array.from({ length: 6 }, (_, i) => ({ label: `方案${i + 1}：先核对旧订单退款口径，再分批处理历史数据并补充验收记录` }));
    try {
      for (const allowText of [true, false]) {
        const ask = createAsk(app, { runId, question: "这次按哪个方案处理？", options, allowText });
        const elements = (askCard(app, ask).body as { elements: any[] }).elements;
        const body = allowText ? elements.find((e) => e.tag === "form").elements : elements;
        const rows = body.filter((e: any) => e.tag === "column_set" && e.columns[0].width === "weighted");
        expect(rows).toHaveLength(6);
        rows.forEach((row: any, i: number) => {
          expect(row.columns).toHaveLength(2);
          expect(row.columns[0].elements[0]).toEqual({ tag: "markdown", content: `${i + 1}. ${options[i].label}` });
          expect(row.columns[1].elements[0]).toMatchObject({ name: `opt_${i}`, text: { content: "选择" } });
        });
        if (allowText) {
          expect(body[6]).toMatchObject({ tag: "input", name: "text" });
          expect(body[7].columns).toHaveLength(1);
          expect(body[7].columns[0].elements[0]).toMatchObject({ name: "answer", text: { content: "用文字回答" }, form_action_type: "submit" });
        }
        const action = allowText ? { name: "opt_5", formValue: { text: "先试一小批" } } : { value: { action: "ask:5" } };
        await handleAskAction(app, "ci", ask.id, action, "owner");
        expect(getAsk(app, ask.id)).toMatchObject({ choice: 5, answer: options[5].label + (allowText ? "：先试一小批" : "") });
      }
      const typed = createAsk(app, { runId, question: "还有其他方案吗？" });
      const form = (askCard(app, typed).body as { elements: any[] }).elements.find((e) => e.tag === "form");
      expect(form.elements[0]).toMatchObject({ tag: "input" });
      expect(form.elements[1].columns[0].elements[0]).toMatchObject({ name: "answer", text: { content: "回答" } });
      await handleAskAction(app, "ci", typed.id, { name: "answer", formValue: { text: "先做只读核对" } }, "owner");
      expect(getAsk(app, typed.id).answer).toBe("先做只读核对");
    } finally { app.db.close(); }
  });

  it("keeps two short options together and packs larger or mixed lists without changing their order", () => {
    const { app, runId } = working();
    const layout = (labels: string[]) => {
      const ask = createAsk(app, { runId, question: "选哪个？", options: labels.map((label) => ({ label })) });
      return (askCard(app, ask).body as { elements: any[] }).elements.find((e) => e.tag === "form").elements.filter((e: any) => e.tag === "column_set" && !e.columns.some((c: any) => c.elements[0].name === "answer"));
    };
    try {
      expect(layout(["周四", "周五"]).map((r: any) => r.columns.map((c: any) => c.elements[0].text.content))).toEqual([["周四", "周五"]]);
      const many = layout(["方案一", "方案二", "方案三", "方案四", "方案五"]);
      expect(many.map((r: any) => r.columns.length)).toEqual([2, 2, 1]);
      const mixed = layout(["先不改", "先核对旧订单的退款口径，再分批处理历史数据", "下周再看", "现在处理"]);
      expect(mixed.map((r: any) => r.columns.at(-1).elements[0].name)).toEqual(["opt_0", "opt_1", "opt_3"]);
      expect(mixed[1].columns[0].elements[0].content).toContain("先核对旧订单的退款口径，再分批处理历史数据");
      const escaped = layout(["保留 <at id=all> 和 [原样] & 内容"])[0].columns[0].elements[0].content;
      expect(escaped).toContain("&lt;at id=all\\>");
      expect(escaped).toContain("\\[原样\\]");
      expect(escaped).toContain("&amp;");
    } finally { app.db.close(); }
  });

  it("acknowledges before a synchronous host action starts", async () => {
    const { app, runId } = working();
    let started = false;
    registerAskHandler("blocking-test", async () => {
      started = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    });
    const q = createAsk(app, { runId, question: "执行？", options: [{ label: "执行" }], context: { handler: "blocking-test" } });
    await handleAskAction(app, "ci", q.id, { name: "opt_0" }, "owner");
    expect(started).toBe(false);
    expect(getAsk(app, q.id).status).toBe("answered");
    await expect.poll(() => started).toBe(true);
  });

  it("acknowledges a card click within Feishu's limit when acting on the answer takes longer, and finishes it after", async () => {
    const { app, runId } = working();
    let finished = false;
    registerAskHandler("slow-test", async () => {
      await new Promise((ok) => setTimeout(ok, ANSWER_WAIT_MS + 800));
      finished = true;
    });
    const q = createAsk(app, { runId, question: "确认并推送？", options: [{ label: "确认并推送" }], context: { handler: "slow-test" } });
    const started = Date.now();
    const r = await handleAskAction(app, "ci", q.id, { name: "opt_0" }, "owner");
    expect(Date.now() - started).toBeLessThan(ANSWER_WAIT_MS + 500);
    expect(r.toast).toContain("正在处理");
    expect(finished).toBe(false);
    await expect.poll(() => finished, { timeout: 5000 }).toBe(true);
    expect(getAsk(app, q.id).status).toBe("answered");
  });
});
