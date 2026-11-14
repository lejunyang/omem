import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../src/agents/runs.ts";
import { one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addQuestions, getQuestion, lapseQuestions, listQuestions, nightlyQuestionCandidates, questionCounts, reopenQuestion, updateQuestion } from "../src/wiki/questions.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
const fresh = () => { const app = testApp(); apps.push(app); return app; };
afterEach(() => { for (const app of apps.splice(0)) app.db.close(); });
const question = (app: ReturnType<typeof testApp>, page: string, space = "personal") => addQuestions(app, space, page, [{ question: `${page} 的口径是什么？` }], { source: "writer" })[0];
const reads = (app: ReturnType<typeof testApp>, page: string, n: number, day = new Date().toISOString().slice(0, 10)) => run(app.db, "insert into page_reads(space_id,slug,day,n) values('personal',?,?,?)", page, day, n);

describe("Wiki question backlog selection and lapse", () => {
  it("uses page reads over 30 days first, then importance and age, leaving unread pages for spare budget", () => {
    const app = fresh();
    const unseen = question(app, "unseen"), readLow = question(app, "read-low"), readOld = question(app, "read-old"), readRecent = question(app, "read-recent");
    updateQuestion(app, unseen, { importance: 3 });
    updateQuestion(app, readLow, { importance: 1 });
    for (const p of ["read-low", "read-old", "read-recent"]) reads(app, p, 5);
    reads(app, "unseen", 500, "2000-01-01");
    run(app.db, "update wiki_questions set created_at = '2020-01-01' where id = ?", readOld);
    expect(nightlyQuestionCandidates(app).map((q) => q.id)).toEqual([readOld, readRecent, readLow, unseen]);
    expect(getQuestion(app, readOld)?.reads30).toBe(5);
    expect(listQuestions(app, { spaceId: "personal" }).find((q) => q.id === unseen)?.reads30).toBe(0);
    app.config.wiki.questions.nightly = 3;
    expect(nightlyQuestionCandidates(app).map((q) => q.id)).toEqual([readOld, readRecent, readLow]);
  });

  it("shares a single nightly cap across spaces, skipping busy and already visited spaces", () => {
    const app = fresh();
    for (const id of ["a", "b", "c"]) createSpace(app, { id, name: `项目 ${id}` });
    for (const id of ["personal", "a", "b", "c"]) for (let i = 0; i < 3; i++) question(app, `${id}/${i}`, id);
    app.config.wiki.questions.nightly = 4;
    expect(nightlyQuestionCandidates(app)).toHaveLength(4);
    createRun(app, { kind: "wiki-resolve", spaceId: "a", title: "排队" });
    const busy = createRun(app, { kind: "wiki-resolve", spaceId: "b", title: "进行中" });
    run(app.db, "update runs set status = 'running' where id = ?", busy.id);
    const today = createRun(app, { kind: "wiki-resolve", spaceId: "c", title: "今夜已查过", input: { nightly: new Date().toISOString().slice(0, 10) } });
    run(app.db, "update runs set status = 'done' where id = ?", today.id);
    expect(nightlyQuestionCandidates(app).map((q) => q.spaceId)).toEqual(["personal", "personal", "personal"]);
    app.config.wiki.questions.nightly = 0;
    expect(nightlyQuestionCandidates(app)).toEqual([]);
  });

  it("lapses only old open questions with no reads in the expiry window; hides them until filtered and reopens them", () => {
    const app = fresh();
    const idle = question(app, "idle"), recentRead = question(app, "active"), newQuestion = question(app, "new"), owner = question(app, "owner");
    run(app.db, "update wiki_questions set created_at = '2000-01-01' where id != ?", newQuestion);
    updateQuestion(app, owner, { status: "needs-owner" });
    reads(app, "active", 1);
    reads(app, "idle", 5, "2000-01-01");
    expect(lapseQuestions(app)).toBe(1);
    expect(getQuestion(app, idle)).toMatchObject({ status: "lapsed", note: "这页 45 天没有被读到，问题不再追" });
    expect(lapseQuestions(app)).toBe(0);
    expect(listQuestions(app, { spaceId: "personal" }).map((q) => q.id)).toEqual(expect.arrayContaining([recentRead, newQuestion, owner]));
    expect(listQuestions(app, { spaceId: "personal", status: ["lapsed"] }).map((q) => q.id)).toEqual([idle]);
    expect(questionCounts(app, "personal").idle).toBeUndefined();
    expect(reopenQuestion(app, idle)?.status).toBe("open");
    expect(questionCounts(app, "personal").idle).toBe(1);
    expect(reopenQuestion(app, idle)).toBeNull();
    expect(reopenQuestion(app, "missing")).toBeNull();
  });
  it("each night lapses first, then queues one investigation a space for the pick, once a night", async () => {
    const app = fresh();
    createSpace(app, { id: "a", name: "项目 a" });
    const p1 = question(app, "p1"), p2 = question(app, "p2"), a1 = question(app, "a/1", "a"), idle = question(app, "idle");
    run(app.db, "update wiki_questions set created_at = '2000-01-01' where id = ?", idle);
    run(app.db, "update wiki_questions set created_at = ? where id = ?", new Date(Date.now() - 10 * 86400_000).toISOString(), p2);
    run(app.db, "update wiki_questions set created_at = ? where id = ?", new Date(Date.now() - 5 * 86400_000).toISOString(), a1);
    reads(app, "p1", 3);
    app.config.wiki.questions.nightly = 2;
    const { resolveNightly } = await import("../src/wiki/verify.ts");
    const first = resolveNightly(app);
    expect(first).toMatchObject({ lapsed: 1, questions: 2 });
    expect(first.runs).toHaveLength(1);
    const made = one<{ space_id: string; input: string }>(app.db, "select space_id, input from runs where id = ?", first.runs[0])!;
    expect(made.space_id).toBe("personal");
    const input = JSON.parse(made.input) as { questionIds: string[]; nightly: string };
    expect([...input.questionIds].sort()).toEqual([p1, p2].sort());
    expect(input.nightly).toBe(new Date().toISOString().slice(0, 10));
    // The space visited tonight waits for tomorrow, under way or done; the budget goes to the next space.
    run(app.db, "update runs set status = 'done' where id = ?", first.runs[0]);
    const second = resolveNightly(app);
    expect(second).toMatchObject({ lapsed: 0, questions: 1 });
    expect(JSON.parse(one<{ input: string }>(app.db, "select input from runs where id = ?", second.runs[0])!.input).questionIds).toEqual([a1]);
    expect(resolveNightly(app)).toMatchObject({ questions: 0, runs: [] });
    expect(getQuestion(app, idle)?.status).toBe("lapsed");
  });
});
