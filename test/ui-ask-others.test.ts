import { describe, expect, it } from "vitest";
import { answerAsk, createAsk, describeAnswer, getAsk, listAsks } from "../src/agents/asks.ts";
import { normalizeAnswers, summarizeAnswers, type UiField } from "../src/agents/ui-blocks.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { createThread, threadMessages } from "../src/agents/threads.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { askCard, cardFields } from "../src/channels/lark-asks.ts";
import { viewCardBlocks } from "../src/channels/lark-ui.ts";
import { testApp } from "./helpers.ts";

/** A conversation of `userId` in `space` with a turn (`kind`) of its assistant working in it. */
function turn(app: ReturnType<typeof testApp>, userId: string, space: string, kind = "ask") {
  const t = createThread(app, { spaceId: space, channel: "web", userId });
  const runId = `r_${Math.random().toString(36).slice(2, 10)}`;
  run(app.db, "insert into runs(id,kind,space_id,status,title,input,created_at) values(?,?,?,?,?,?,?)", runId, kind, space, "running", "t", JSON.stringify({ conversationId: t.id }), new Date().toISOString());
  const ctx = toolContextForToken(app, issueToolToken({ runId, spaceId: space, spaces: null, tools: null, actor: "agent", userId }))!;
  return { thread: t, runId, ctx };
}
const done = (app: ReturnType<typeof testApp>, runId: string) => run(app.db, "update runs set status = 'done' where id = ?", runId);

describe("ordering, editable tables", () => {
  const fields: UiField[] = [
    { id: "order", label: "先做哪个", type: "rank", required: true, items: [{ id: "a", title: "退款回放" }, { id: "b", title: "评审" }, { id: "c", title: "周报" }] },
    { id: "budget", label: "预算", type: "table", required: false, max_rows: 3, rows: [], columns: [{ id: "item", label: "项目", type: "text" }, { id: "cost", label: "金额", type: "number" }, { id: "who", label: "谁付", type: "choice", options: ["公司", "AA"] }] },
  ];
  it("an order has every entry once; a table checks each cell and drops empty rows", () => {
    expect(() => normalizeAnswers(fields, { order: ["a", "b"] })).toThrow(/每一条都排进去/);
    expect(() => normalizeAnswers(fields, { order: ["a", "a", "b"] })).toThrow(/每一条都排进去/);
    expect(() => normalizeAnswers(fields, { order: ["c", "a", "b"], budget: [{ item: "聚餐", cost: "很多" }] })).toThrow(/第 1 行的“金额”要填数字/);
    expect(() => normalizeAnswers(fields, { order: ["c", "a", "b"], budget: [{ item: "聚餐", who: "老板" }] })).toThrow(/不在选项里/);
    expect(() => normalizeAnswers(fields, { order: ["c", "a", "b"], budget: [{ item: "1" }, { item: "2" }, { item: "3" }, { item: "4" }] })).toThrow(/最多 3 行/);
    const v = normalizeAnswers(fields, { order: ["c", "a", "b"], budget: [{ item: "聚餐", cost: "1200", who: "公司" }, { item: "", cost: "" }] });
    expect(v).toEqual({ order: ["c", "a", "b"], budget: [{ item: "聚餐", cost: 1200, who: "公司" }] });
    expect(summarizeAnswers(fields, v)).toBe("- 先做哪个：\n  1. 周报\n  2. 退款回放\n  3. 评审\n- 预算：\n  - 第 1 行：项目 聚餐，金额 1200，谁付 公司");
  });
  it("a card cannot reorder or edit rows: such a form goes to the web page", () => {
    expect(cardFields(fields)).toBeNull();
    expect(cardFields([{ id: "x", label: "x", type: "text", required: false }])).toHaveLength(1);
  });
  it("a card cannot run a page: with a link it is left to the button, without one it is named", () => {
    const app = testApp();
    const view = [{ type: "page" as const, id: "pg1", title: "原型" }];
    expect(JSON.stringify(viewCardBlocks(app, view))).toContain("交互页“原型”：在网页上打开才能操作");
    expect(viewCardBlocks(app, view, { linked: true })).toEqual([]);
  });
  it("a form too much for a card is only a link when there is a web address", () => {
    const app = testApp();
    app.config.webUrl = "https://omem.example.test";
    const ask = createAsk(app, { runId: null, conversationId: null, question: "排个序", ui: { fields } });
    const card = JSON.stringify(askCard(app, ask));
    expect(card).toContain("打开填写");
    expect(card).not.toContain("要填的");
    app.config.webUrl = "";
    expect(JSON.stringify(askCard(app, ask))).toContain("要填的");
  });
});

describe("asking someone else", () => {
  function setup() {
    const app = testApp();
    createSpace(app, { id: "refund", name: "退款改造", kind: "project" });
    const wang = createUser(app, { id: "wang", name: "小王" });
    const li = createUser(app, { id: "li", name: "小李" });
    const zhao = createUser(app, { id: "zhao", name: "小赵" });
    addMember(app, "refund", wang.id, "editor");
    addMember(app, "refund", li.id);
    return { app, wang, li, zhao };
  }

  it("in a member's own conversation the question is theirs; asking someone else goes only to that person", async () => {
    const { app, wang } = setup();
    const mine = turn(app, wang.id, "refund");
    await callTool(mine.ctx, "ask_user", { question: "退款口径按哪版？", options: ["新口径", "旧口径"], wait_seconds: 0 });
    expect(listAsks(app, { conversationId: mine.thread.id })[0]).toMatchObject({ userId: "wang", askedBy: null });
    await expect(answerAsk(app, listAsks(app, { conversationId: mine.thread.id })[0].id, { choice: 0, by: "wang" })).resolves.toMatchObject({ status: "answered" });

    const r = await callTool(mine.ctx, "ask_user", { to: "小李", question: "周四能评审退款改造吗？", options: ["能", "不能"] });
    expect(r.text).toContain("已去问 小李");
    const ask = listAsks(app, { userId: "li", status: "pending" })[0];
    expect(ask).toMatchObject({ userId: "li", askedBy: "wang", toName: "小李", conversationId: mine.thread.id });
    expect(listAsks(app, { userId: "wang", status: "pending" })).toHaveLength(0);
    expect(JSON.stringify(askCard(app, ask))).toContain("小王 的助手替 ta 问你");
    done(app, mine.runId);
    await answerAsk(app, ask.id, { choice: 0, text: "下午三点后", by: "li" });
    expect(describeAnswer(getAsk(app, ask.id))).toBe("小李回答了「周四能评审退款改造吗？」：能：下午三点后");
    const back = threadMessages(app, mine.thread.id).at(-1)!;
    expect(back).toMatchObject({ role: "user" });
    expect(back.text).toContain("[回答] 小李回答了");
  });

  it("refuses someone who cannot see the space, oneself, strangers, and turns that are not the person's own", async () => {
    const { app, wang, zhao } = setup();
    const mine = turn(app, wang.id, "refund");
    expect((await callTool(mine.ctx, "ask_user", { to: zhao.id, question: "x" })).text).toMatch(/看不到这个会话所在的空间/);
    expect((await callTool(mine.ctx, "ask_user", { to: "wang", question: "x" })).text).toMatch(/本人自己/);
    expect((await callTool(mine.ctx, "ask_user", { to: "nobody", question: "x" })).text).toMatch(/没有这个人/);
    const background = turn(app, wang.id, "refund", "agent");
    expect((await callTool(background.ctx, "ask_user", { to: "li", question: "x" })).text).toMatch(/只有在本人自己的对话里/);
  });
});
