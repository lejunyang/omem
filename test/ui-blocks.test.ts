import { describe, expect, it } from "vitest";
import { answerAsk, describeAnswer, getAsk, listAsks, showSuggestions } from "../src/agents/asks.ts";
import { normalizeAnswers, viewText, type UiField } from "../src/agents/ui-blocks.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createThread, threadMessages } from "../src/agents/threads.ts";
import { run } from "../src/core/db.ts";
import { askCard } from "../src/channels/lark-asks.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

/** A conversation on `channel` with an agent run working in it. */
function working(channel = "web") {
  const app = testApp();
  const t = createThread(app, { spaceId: "personal", channel, userId: "owner" });
  const runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", runId, "agent", "personal", "running", "t", JSON.stringify({ conversationId: t.id }), new Date().toISOString());
  const ctx = toolContextForToken(app, issueToolToken({ runId, spaceId: "personal", spaces: null, tools: null, actor: "agent" }))!;
  return { app, thread: t, runId, ctx };
}

const plan: UiField[] = [
  { id: "plan", label: "选哪个方案", type: "pick", required: true, items: [{ id: "a", title: "方案 A：先灰度", pros: ["风险小"], cons: [] }, { id: "b", title: "方案 B：一次上线", pros: [], cons: ["回滚难"] }] },
  { id: "when", label: "哪天开始", type: "date", required: true, show_if: { field: "plan", equals: "a" } },
  { id: "notify", label: "要不要通知客服", type: "toggle", required: false },
  { id: "rules", label: "逐条确认退款规则", type: "checklist", required: true, items: [{ id: "r1", title: "7 天无理由" }, { id: "r2", title: "运费原路退回" }], choices: ["通过", "不通过"], note: true },
];

describe("component blocks", () => {
  it("answers are checked against the fields: conditions, ranges, every checklist item", () => {
    expect(() => normalizeAnswers(plan, { plan: "c" })).toThrow(/没有这个方案/);
    // The date shows only for plan a, so it is required only then.
    expect(() => normalizeAnswers(plan, { plan: "a", rules: { r1: { choice: "通过" }, r2: { choice: "通过" } } })).toThrow(/还没填：哪天开始/);
    expect(() => normalizeAnswers(plan, { plan: "b", rules: { r1: { choice: "通过" } } })).toThrow(/还没填：逐条确认退款规则/);
    expect(() => normalizeAnswers(plan, { plan: "b", rules: { r1: { choice: "也许" } } })).toThrow(/不在选项里/);
    const v = normalizeAnswers(plan, { plan: "b", when: "2026-12-01", notify: "true", rules: { r1: { choice: "通过", note: "  " }, r2: { choice: "不通过", note: "运费不退" } } });
    expect(v).toEqual({ plan: "b", notify: true, rules: { r1: { choice: "通过" }, r2: { choice: "不通过", note: "运费不退" } } });
    expect(() => normalizeAnswers([{ id: "d", label: "日期", type: "date", required: false }], { d: "12/01" })).toThrow(/日期格式/);
  });

  it("ask_user with fields: the web sends values, the agent reads them as lines and as JSON", async () => {
    const { app, thread, ctx } = working();
    expect((await callTool(ctx, "ask_user", { question: "怎么上线？", options: ["A"], fields: plan, wait_seconds: 0 })).isError).toBe(true);
    expect((await callTool(ctx, "ask_user", { question: "怎么上线？", fields: [...plan, { id: "x", label: "x", type: "text", show_if: { field: "nope" } }], wait_seconds: 0 })).text).toMatch(/不存在的字段 nope/);
    const r = await callTool(ctx, "ask_user", { question: "怎么上线？", fields: plan, view: [{ type: "table", columns: ["规则", "现在"], rows: [["7 天无理由", "是"]] }], wait_seconds: 0 });
    expect(r.text).toMatch(/还没回答/);
    const ask = listAsks(app, { conversationId: thread.id })[0];
    expect(ask.ui?.fields).toHaveLength(4);
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const bad = await server.inject({ method: "POST", url: `/api/asks/${ask.id}/answer`, payload: { value: { plan: "a" } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error ?? bad.body).toMatch(/还没填/);
      expect(getAsk(app, ask.id).status).toBe("pending");
      const page = (await server.inject({ url: `/api/ui/${ask.id}` })).json();
      expect(page).toMatchObject({ type: "ask", ask: { id: ask.id, ui: { view: [{ type: "table" }] } } });
      const ok = await server.inject({ method: "POST", url: `/api/asks/${ask.id}/answer`, payload: { value: { plan: "a", when: "2026-12-01", rules: { r1: { choice: "通过" }, r2: { choice: "不通过", note: "运费不退" } } }, text: "周一先灰度 10%" } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await server.close();
    }
    const done = getAsk(app, ask.id);
    expect(done.value).toEqual({ plan: "a", when: "2026-12-01", rules: { r1: { choice: "通过" }, r2: { choice: "不通过", note: "运费不退" } } });
    const said = describeAnswer(done);
    expect(said).toContain("- 选哪个方案：方案 A：先灰度（a）");
    expect(said).toContain("  - 运费原路退回：不通过（运费不退）");
    expect(said).toContain("补充：周一先灰度 10%");
    expect(said).toContain('结构化的值：{"plan":"a"');
    // A form already answered takes no second answer, and a plain question takes no values.
    await expect(answerAsk(app, ask.id, { value: {}, by: "owner" })).rejects.toThrow(/已经回答过/);
    // Asking for a form again in the same run replaces the one not filled in yet.
    await callTool(ctx, "ask_user", { question: "怎么上线？（第一版）", fields: plan, wait_seconds: 0 });
    await callTool(ctx, "ask_user", { question: "怎么上线？（第二版）", fields: plan, wait_seconds: 0 });
    expect(listAsks(app, { conversationId: thread.id, status: "pending" }).map((a) => a.question)).toEqual(["怎么上线？（第二版）"]);
    await answerAsk(app, listAsks(app, { conversationId: thread.id, status: "pending" })[0].id, { text: "先放着", by: "owner" });
    await callTool(ctx, "ask_user", { question: "还有别的吗？", wait_seconds: 0 });
    const plain = listAsks(app, { conversationId: thread.id, status: "pending" })[0];
    await expect(answerAsk(app, plain.id, { value: { a: 1 }, by: "owner" })).rejects.toThrow(/没有要填的字段/);
  });

  it("a reply in the chat still answers a form, as text", async () => {
    const { app, thread, ctx } = working();
    await callTool(ctx, "ask_user", { question: "怎么上线？", fields: plan, wait_seconds: 0 });
    const ask = listAsks(app, { conversationId: thread.id })[0];
    const { answerFromMessage } = await import("../src/agents/asks.ts");
    run(app.db, "update asks set shown_at = ? where id = ?", new Date().toISOString(), ask.id);
    await answerFromMessage(app, thread.id, "先别上线，下周再说", "owner");
    expect(getAsk(app, ask.id)).toMatchObject({ status: "answered", answer: "先别上线，下周再说", value: null });
  });

  it("a Feishu card for a form lists what to fill in and links to its page", async () => {
    const { app, thread, ctx } = working("lark");
    app.config.webUrl = "https://omem.example.test/";
    await callTool(ctx, "ask_user", { question: "怎么上线？", fields: plan, view: [{ type: "metric", items: [{ label: "待退款", value: 12, unit: " 单" }] }], wait_seconds: 0 });
    const ask = listAsks(app, { conversationId: thread.id })[0];
    const card = JSON.stringify(askCard(app, ask));
    expect(card).toContain("待退款：12 单");
    expect(card).toContain("逐条确认退款规则（必填）");
    expect(card).toContain(`https://omem.example.test/#/ui/${ask.id}`);
    expect(card).not.toContain('"tag":"form"');
  });

  it("show puts components under the reply: the web lists them, Feishu gets text and a link once the reply is out", async () => {
    const web = working();
    expect((await callTool(web.ctx, "show", { components: [{ type: "chart", title: "退款", kind: "line", labels: ["周一", "周二"], series: [{ name: "单数", values: [1] }] }] })).text).toMatch(/要一样多/);
    expect((await callTool(web.ctx, "show", { title: "本周退款", components: [{ type: "chart", title: "退款", labels: ["周一", "周二"], series: [{ name: "单数", values: [3, 5] }] }] })).text).toMatch(/已放在这一轮回答的下面/);
    const server = await startServer(web.app, { port: 0, quiet: true });
    try {
      const listed = (await server.inject({ url: `/api/ui/views?conversation=${web.thread.id}` })).json();
      expect(listed).toMatchObject([{ runId: web.runId, title: "本周退款", components: [{ type: "chart", kind: "bar" }] }]);
      expect((await server.inject({ url: `/api/ui/${listed[0].id}` })).json()).toMatchObject({ type: "view", view: { title: "本周退款" } });
    } finally {
      await server.close();
    }
    await showSuggestions(web.app, web.runId);
    expect(threadMessages(web.app, web.thread.id)).toHaveLength(0);

    const lark = working("lark");
    lark.app.config.webUrl = "https://omem.example.test";
    await callTool(lark.ctx, "show", { title: "对比", components: [{ type: "table", columns: ["方案", "风险"], rows: [["A", "低"], ["B", "高|中"]] }] });
    await showSuggestions(lark.app, lark.runId);
    await showSuggestions(lark.app, lark.runId);
    const sent = threadMessages(lark.app, lark.thread.id);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("| B | 高\\|中 |");
    expect(sent[0].text).toMatch(/\[在网页上查看\]\(https:\/\/omem\.example\.test\/#\/ui\/uv/);
  });

  it("views read as text where they cannot be drawn", () => {
    const text = viewText([
      { type: "heading", text: "退款进度" },
      { type: "chart", title: "占比", kind: "pie", labels: ["已退", "未退"], series: [{ name: "单", values: [3, 1] }, { name: "忽略", values: [0, 0] }] },
      { type: "compare", items: [{ id: "a", title: "灰度", summary: "先 10%", pros: ["稳"], cons: [] }, { id: "b", title: "全量", pros: [], cons: ["回滚难"] }] },
      { type: "timeline", items: [{ time: "11-08", title: "上线" }] },
    ]);
    expect(text).toContain("**退款进度**");
    expect(text).toContain("- 已退：3");
    expect(text).not.toContain("忽略");
    expect(text).toContain("  - 代价：回滚难");
    expect(text).toContain("- 11-08 上线");
  });
});
