import { describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { createRun, getRun, listRuns } from "../src/agents/runs.ts";
import { callTool, issueToolToken, toolContextForToken } from "../src/agents/tools.ts";
import { git } from "../src/core/git.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { upsertSource } from "../src/sources/store.ts";
import { HEADING, migratePage, migrateState, migrateUnresolved, queueMigration, splitUnresolved } from "../src/wiki/migrate.ts";
import { addQuestions, ASK_LIMIT, listQuestions, questionCounts } from "../src/wiki/questions.ts";
import { pageContext, readPage, writePage } from "../src/wiki/store.ts";
import { getGeneration, recheckPages, recordCheck, settleWikiRun, startGeneration } from "../src/wiki/verify.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
createSpace(app, { id: "biz", name: "业务 A", kind: "project" });
const src = upsertSource(app, { spaceId: "biz", kind: "doc", uri: "docs/退款.md", title: "退款", text: "一\n二\n三\n四" }).id;
const write = (slug: string, body: string) => writePage(app, "biz", slug, { meta: { title: slug, kind: "guide" }, body }, { commit: true });
const agent = (runId: string | null) => toolContextForToken(app, issueToolToken({ runId, spaceId: "biz", spaces: null, tools: null, actor: "agent" }))!;

describe("the old template's unsettled section", () => {
  const page = `退款三天到账。[依据](src:${src}#L1-L2)

## 怎么查

先查售后单。[依据](src:${src}#L3-L3)

## 还没查清

- 两例重试后自行恢复，原因不明。[聊天](src:${src}#L4-L4)
- 上限是 3000 还是 5000 元
  （两份材料说法不同）

另外一段：夜间提交是否次日处理。
`;

  it("is found by its heading alone, split into items, and cut out up to the next heading of its level", () => {
    expect(HEADING.test("## 还没查清")).toBe(true);
    expect(HEADING.test("### 待确认：")).toBe(true);
    expect(HEADING.test("## 还没查清的原因分析")).toBe(false);
    const s = splitUnresolved(page + "\n## 交给谁\n\n交易值班。\n")!;
    expect(s.heading).toBe("还没查清");
    expect(s.items).toEqual([`两例重试后自行恢复，原因不明。[聊天](src:${src}#L4-L4)`, "上限是 3000 还是 5000 元 （两份材料说法不同）", "另外一段：夜间提交是否次日处理。"]);
    expect(s.body).toContain("## 怎么查");
    expect(s.body).toContain("## 交给谁\n\n交易值班。");
    expect(s.body).not.toContain("还没查清");
    // Inside a code block it is text, not a heading; a page without it is left alone.
    expect(splitUnresolved("```\n## 还没查清\n- x\n```\n")).toBeNull();
    expect(splitUnresolved("## 怎么查\n\n先查。")).toBeNull();
  });

  it("moves to the page's open questions with its citations; the rest of the page, its citation state and history stay", () => {
    write("flows/refund", page);
    // An original changed after writing: the page says so before and after the move.
    upsertSource(app, { spaceId: "biz", kind: "doc", uri: "docs/退款.md", title: "退款", text: "一\n二\n三改了\n四" });
    expect(pageContext(app, "biz", "flows/refund").sources[0].stale).toBe(true);
    const r = migratePage(app, "biz", "flows/refund")!;
    expect(r.questions).toBe(3);
    const body = readPage(app, "biz", "flows/refund").body;
    expect(body).not.toContain("还没查清");
    expect(body).toContain(`先查售后单。[依据](src:${src}#L3-L3)`);
    expect(pageContext(app, "biz", "flows/refund").sources[0].stale).toBe(true);
    const qs = listQuestions(app, { spaceId: "biz", page: "flows/refund" });
    expect(qs).toHaveLength(3);
    expect(qs.every((q) => q.source === "migration" && q.status === "open")).toBe(true);
    expect(qs.find((q) => q.question.startsWith("两例"))!.refs).toEqual([`src:${src}#L4-L4`]);
    // The old version is one commit back in the library's history.
    const log = git(app.libraryDir, ["log", "--format=%s", "-2", "--", "biz/wiki/flows/refund.md"]).stdout;
    expect(log).toContain("open questions");
    // Again: nothing left to move, nothing added twice.
    expect(migratePage(app, "biz", "flows/refund")).toBeNull();
    expect(listQuestions(app, { spaceId: "biz", page: "flows/refund" })).toHaveLength(3);
  });

  it("goes through every page in batches, picks up where it stopped, and is queued once", () => {
    write("cases/a", "结论。\n\n## 待确认\n\n- 甲\n");
    write("cases/b", "结论。\n\n### 还没查清\n\n- 乙\n- 丙\n");
    write("cases/c", "没有这一节。\n");
    run(app.db, "delete from kv where key = 'wiki-migrate-unresolved'");
    const first = migrateUnresolved(app, { limit: 2 });
    expect(first.done).toBe(false);
    const rest = migrateUnresolved(app, { limit: 50 });
    expect(rest.done).toBe(true);
    expect(migrateState(app)).toMatchObject({ pages: 2, questions: 3, done: true });
    expect(readPage(app, "biz", "cases/b").body).toBe("结论。\n");
    // Done: not queued again at the next start.
    expect(queueMigration(app)).toBeNull();
    run(app.db, "delete from kv where key = 'wiki-migrate-unresolved'");
    const queued = queueMigration(app)!;
    expect(queued.kind).toBe("wiki-migrate");
    expect(queueMigration(app)).toBeNull();
    run(app.db, "update runs set status = 'cancelled' where id = ?", queued.id);
  });
});

describe("open questions", () => {
  it("are recorded by write_page outside the page, and an agent can settle them", async () => {
    const r = createRun(app, { kind: "ask", spaceId: "biz", title: "写一页" });
    run(app.db, "update runs set status = 'done' where id = ?", r.id);
    const w = await callTool(agent(r.id), "write_page", { page: "guides/limit", title: "退款上限", summary: "s", body: "上限按业务定。", questions: [{ question: "A 业务的上限是多少？", why: "两份材料不同", refs: [`src:${src}#L2-L2`] }, "B 业务呢？"] });
    expect(w.text).toContain("2 个未决问题");
    expect(readPage(app, "biz", "guides/limit").body).not.toContain("上限是多少");
    const [a] = listQuestions(app, { spaceId: "biz", page: "guides/limit" });
    expect(a).toMatchObject({ question: "A 业务的上限是多少？", why: "两份材料不同", source: "writer", status: "open", refs: [`src:${src}#L2-L2`] });
    expect(questionCounts(app, "biz")["guides/limit"]).toBe(2);
    expect((await callTool(agent(null), "settle_wiki_question", { id: a.id, outcome: "needs-owner", importance: 3, note: "只有本人知道" })).isError).toBe(false);
    expect(listQuestions(app, { spaceId: "biz", page: "guides/limit", status: ["needs-owner"] })[0]).toMatchObject({ importance: 3, note: "只有本人知道" });
  });

  it("put only the most important few to the owner when a generation ends; the rest wait in the list", () => {
    write("guides/many", "很多问题的一页。");
    const w = createRun(app, { kind: "wiki-write", spaceId: "biz", title: "写作：多", input: { brief: { slug: "guides/many", title: "多", kind: "guide", question: "?", outline: "", entry_points: [] } } });
    run(app.db, "update runs set status = 'done' where id = ?", w.id);
    const ids = addQuestions(app, "biz", "guides/many", Array.from({ length: 8 }, (_, i) => ({ question: `问题 ${i + 1}` })), { source: "writer", runId: w.id });
    for (const [i, id] of ids.entries()) run(app.db, "update wiki_questions set status = 'needs-owner', importance = ? where id = ?", i === 7 ? 3 : 2, id);
    startGeneration(app, { id: "gq", spaceId: "biz", writes: [{ slug: "guides/many", title: "多", runId: w.id }] });
    const report = settleWikiRun(app, getRun(app, w.id))!;
    expect(report.questions).toHaveLength(ASK_LIMIT);
    expect(report.questions[0].question).toBe("问题 8");
    expect(report.moreInList).toBe(8 - ASK_LIMIT);
    expect(getGeneration(app, "gq")!.report!.askId).toBeTruthy();
    expect(listQuestions(app, { spaceId: "biz", page: "guides/many", status: ["asked"] })).toHaveLength(ASK_LIMIT);
    expect(listQuestions(app, { spaceId: "biz", page: "guides/many", status: ["needs-owner"] })).toHaveLength(8 - ASK_LIMIT);
    const n = one<{ title: string; body: string }>(app.db, "select title, body from notifications order by at desc limit 1")!;
    expect(n.title).toContain(`${ASK_LIMIT} 个问题要你定`);
    expect(n.body).toContain(`另有 ${8 - ASK_LIMIT} 个未决问题留在`);
  });

  it("are shown to those who may write the Wiki, not in what readers get", async () => {
    const { startServer } = await import("../src/server/http.ts");
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const pageRes = (await server.inject({ method: "GET", url: "/api/wiki/biz/page/guides/limit" })).json();
      expect(pageRes.body).not.toContain("上限是多少");
      expect(pageRes.questions.length).toBe(2);
      const list = (await server.inject({ method: "GET", url: "/api/wiki/biz/questions" })).json();
      expect(list.counts["guides/limit"]).toBe(2);
      expect(list.questions.some((q: { pageTitle: string }) => q.pageTitle === "退款上限")).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("rechecking existing pages", () => {
  it("puts pages never checked through writing and checking, a bounded batch at a time, oldest first", async () => {
    const before = listRuns(app, { kind: "wiki-write", limit: 500 }).length;
    recordCheck(app, "biz", "cases/a", { runId: "r_x", at: new Date().toISOString(), status: "passed", rounds: 1, fixed: 0, rejected: 0, restored: 0, open: [], notes: [], history: [] });
    const r = await recheckPages(app, "biz", { limit: 2 });
    expect(r.pages).toHaveLength(2);
    expect(r.pages).not.toContain("cases/a");
    expect(r.remaining).toBeGreaterThan(0);
    const runs = listRuns(app, { kind: "wiki-write", limit: 500 });
    expect(runs.length).toBe(before + 2);
    expect(String((runs[0].input as { instructions?: string }).instructions)).toContain("重新核对这一页");
    for (const x of runs.slice(0, 2)) run(app.db, "update runs set status = 'cancelled' where id = ?", x.id);
    // At most RECHECK_MAX however much is asked.
    expect((await recheckPages(app, "biz", { limit: 999 })).pages.length).toBeLessThanOrEqual(50);
    for (const x of all<{ id: string }>(app.db, "select id from runs where kind = 'wiki-write' and status = 'queued'")) run(app.db, "update runs set status = 'cancelled' where id = ?", x.id);
  });
});
