import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { checkLessons, lessonHits, lessonsText, listLessons, previousLessonMaterial, proposeLesson, removeLesson, saveLesson, titleCloseness } from "../src/agents/code-lessons.ts";
import { reviewContext, leadTask } from "../src/agents/review-chain.ts";
import { recordReview, roundFindings } from "../src/agents/review.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { __testHandlers, addRunEvent, createRun, getRun, setRunOutput } from "../src/agents/runs.ts";
import { releaseBackgroundSessions } from "../src/agents/background-sessions.ts";
import { peerWorkspace } from "../src/agents/peer-code.ts";
import { peerReviewTask } from "../src/agents/review-chain.ts";
import { taskReview } from "../src/agents/code-loop.ts";
import { listTasks, taskText } from "../src/agents/code-tasks.ts";
import { codeChainFor } from "../src/agents/code-chain.ts";
import { createThread } from "../src/agents/threads.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
const appFor = () => { const app = testApp(); apps.push(app); createSpace(app, { id: "demo", name: "示例商城", kind: "repo" }); createSpace(app, { id: "other", name: "示例仓库乙", kind: "repo" }); return app; };
afterEach(async () => {
  await releaseBackgroundSessions();
  for (const app of apps.splice(0)) {
    const home = resolve(app.home);
    if (!home.startsWith(resolve(tmpdir()) + sep) || !home.split(sep).at(-1)?.startsWith("omem-test-")) throw new Error("unexpected test home");
    const slot = join(home, "workspaces", "demo", "1");
    if (existsSync(slot)) execFileSync("git", ["-C", join(home, "repo"), "worktree", "remove", "--force", slot], { windowsHide: true });
    app.db.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
const convention = "查询原件时必须同时限定仓库空间";
const code = (app: ReturnType<typeof testApp>, space = "demo", extra = {}) => createRun(app, { kind: "code", spaceId: space, title: "示例退款改造", input: { task: "修复退款", repos: [space], ...extra } });
function finding(app: ReturnType<typeof testApp>, id: string, title = "查询原件时没有限定空间", state = "accepted", file = "src/store.ts") {
  recordReview(app, { codeRunId: id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "发现问题", findings: [{ severity: "major", title, file, detail: "需要限定空间", suggestion: "加空间条件", evidence: [], confidence: "high" }] });
  const f = roundFindings(app, id, 1)[0];
  run(app.db, "update review_findings set state=? where id=?", state, f.id);
  return f.id;
}
function repo(app: ReturnType<typeof testApp>) {
  const dir = join(app.home, "repo"); mkdirSync(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "refund.ts"), "const unsafe = 0;\n");
  git("add", "."); git("commit", "-qm", "initial");
  return { dir, git, base: git("rev-parse", "HEAD") };
}

describe("repository lessons", () => {
  it("validates text, Unicode regexp source, plain relative globs and repository spaces", () => {
    const app = appFor();
    for (const text of ["太短", "字".repeat(201)]) expect(() => saveLesson(app, "demo", { text })).toThrow();
    for (const pattern of ["[", "a".repeat(201), "(?i)query", "\\u{110000}"]) expect(() => saveLesson(app, "demo", { text: convention, pattern })).toThrow();
    for (const paths of ["../secret", "/root/*", "src/**,{x,y}", "src/**;exit", "src/**,,test/**"]) expect(() => saveLesson(app, "demo", { text: convention, paths })).toThrow();
    expect(() => saveLesson(app, "personal", { text: convention })).toThrow("仓库空间");
    const l = saveLesson(app, "demo", { text: convention, pattern: "unsafe", paths: "src/**/*.ts, test/?.ts" });
    expect(l.state).toBe("on");
    removeLesson(app, "demo", l.id); expect(listLessons(app, "demo")).toEqual([]);
  });
  it("merges normalized text and pattern, deduplicates by delegation, and announces only once", () => {
    const app = appFor(), first = code(app), second = code(app);
    const a = proposeLesson(app, "review-lead", { space: "demo", text: convention, pattern: "unsafe", runId: first.id });
    expect(a).toMatchObject({ state: "proposed", reason: expect.stringContaining("只有一次交办") });
    const round2 = code(app, "demo", { continueFrom: first.id });
    expect(proposeLesson(app, "review-lead", { space: "demo", text: convention + "。", runId: round2.id }).evidence).toHaveLength(1);
    const b = proposeLesson(app, "coach", { space: "demo", text: "所有查询都需要在原件上限定空间", pattern: "unsafe", runId: second.id });
    expect(b).toMatchObject({ id: a.id, state: "on", announced: 1 });
    expect(b.evidence).toHaveLength(2);
    proposeLesson(app, "coach", { space: "demo", text: convention, runId: second.id });
    const notes = all<{ urgency: string; body: string }>(app.db, "select json_extract(context, '$.urgency') as urgency,body from notifications where title='仓库学到一条约定'");
    expect(notes).toHaveLength(1); expect(notes[0]).toMatchObject({ urgency: "later", body: expect.stringContaining("两次交办") });
  });
  it("respects auto:false, owner-off, and manual owner-on", () => {
    const app = appFor(), a = code(app), b = code(app);
    app.config.review.lessons = { auto: false, max: 30 };
    const l = proposeLesson(app, "coach", { space: "demo", text: convention, runId: a.id });
    expect(proposeLesson(app, "coach", { space: "demo", text: convention, runId: b.id }).state).toBe("proposed");
    expect(all(app.db, "select id from notifications")).toHaveLength(0);
    saveLesson(app, "demo", { ...l, state: "off" }); app.config.review.lessons.auto = true;
    expect(proposeLesson(app, "coach", { space: "demo", text: convention, runId: b.id }).state).toBe("off");
    saveLesson(app, "demo", { ...l, state: "on" });
    app.config.review.lessons.auto = false;
    expect(proposeLesson(app, "coach", { space: "demo", text: convention, runId: a.id }).state).toBe("on");
  });
  it("resolves finding evidence to roots and refuses foreign-space findings and write scopes", async () => {
    const app = appFor(), a = code(app), b = code(app, "other"), f = finding(app, a.id), foreign = finding(app, b.id);
    const review = createRun(app, { kind: "review", spaceId: "demo", title: "评审", input: { codeRunId: a.id }, parentId: a.id });
    expect(proposeLesson(app, "review-lead", { space: "demo", text: convention, findings: [f], runId: review.id }).evidence).toEqual([{ run: a.id, finding: f }]);
    expect(() => proposeLesson(app, "coach", { space: "demo", text: convention, findings: [foreign] })).toThrow("不属于");
    const multi = code(app, "demo", { repos: ["demo", "other"] });
    const qualified = finding(app, multi.id, "查询没有空间", "accepted", "other/src/store.ts");
    expect(() => proposeLesson(app, "coach", { space: "demo", text: convention, findings: [qualified] })).toThrow("不属于");

    const ctx: ToolContext = { app, runId: review.id, spaceId: "demo", spaces: ["demo", "other"], writable: ["other"], tools: new Set(["propose_repo_lesson"]), actor: "agent", role: "review-lead" };
    expect((await callTool(ctx, "propose_repo_lesson", { space: "demo", text: convention })).isError).toBe(true);
    ctx.writable = ["demo"];
    expect((await callTool(ctx, "propose_repo_lesson", { space: "demo", text: convention, findings: [f] })).isError).toBe(false);
    expect((await callTool(ctx, "propose_repo_lesson", { space: "other", text: convention })).isError).toBe(true);
  });
  it("supplies similar accepted history across delegations only, with existing lessons and bounded lines", () => {
    const app = appFor(), old = code(app), current = code(app), other = code(app, "other");
    const accepted = finding(app, old.id), nowId = finding(app, current.id);
    const foreign = finding(app, other.id);
    const rejectedRun = code(app), rejected = finding(app, rejectedRun.id, "查询原件时没有限定空间", "rejected");
    const currentFinding = roundFindings(app, current.id, 1);
    const material = previousLessonMaterial(app, "demo", current.id, currentFinding);
    expect(material).toContain(`#${accepted}：`); expect(material).not.toContain(`#${nowId}：`); expect(material).not.toContain(`#${foreign}：`); expect(material).not.toContain(`#${rejected}：`);
    expect(titleCloseness("查询原件时没有限定空间", "查询原件时没有限定空间")).toBe(1);
    expect(titleCloseness("查询缺少空间范围", "查询缺少空间条件", "src/a.ts", "src/b.ts")).toBeGreaterThan(titleCloseness("查询缺少空间范围", "查询缺少空间条件"));
    expect(titleCloseness("输入校验", "消息路由", "src/a.ts", "src/b.ts")).toBeLessThan(.45);
    expect(previousLessonMaterial(app, "other", other.id, currentFinding)).toBe("");
    run(app.db, "update review_findings set decision='fix' where id=?", rejected);
    expect(previousLessonMaterial(app, "demo", current.id, currentFinding)).toContain(`#${rejected}：`);
    run(app.db, "update reviews set created_at='2000-01-01' where id = (select review_id from review_findings where id=?)", accepted);
    expect(previousLessonMaterial(app, "demo", current.id, currentFinding)).not.toContain(`#${accepted}：`);
    const l = saveLesson(app, "demo", { text: convention, state: "proposed" });
    expect(previousLessonMaterial(app, "demo", current.id, Array(100).fill(currentFinding[0])).split("\n").length).toBeLessThan(40);
    expect(previousLessonMaterial(app, "demo", current.id, [])).toContain(`lesson:${l.id}`);
    const plan = { tier: "light", tierName: "轻", checks: ["reviewer"], maxRounds: 2 } as Parameters<typeof leadTask>[2];
    setRunOutput(app, current.id, { worktrees: [{ space: "demo", path: app.home, base: "", branch: "main" }] });
    expect(leadTask(app, getRun(app, current.id), plan, "材料", [])).toContain("这个仓库以往采纳过的同类问题");
  });
  it("checks only added lines, honors globs, and increments hits", async () => {
    const app = appFor(), r = repo(app);
    const l = saveLesson(app, "demo", { text: convention, pattern: "unsafe", paths: "src/**/*.ts" });
    writeFileSync(join(r.dir, "refund.ts"), "const unsafe = 0;\nconst safe = 1;\n");
    mkdirSync(join(r.dir, "src", "nested"));
    writeFileSync(join(r.dir, "src", "nested", "new.ts"), "unsafe();\n+++unsafe();\n");
    r.git("add", "."); r.git("commit", "-qm", "change");
    const hits = await lessonHits(app, "demo", r.dir, r.base, "HEAD");
    expect(hits.map(h => [h.file, h.line])).toEqual([["src/nested/new.ts", 1], ["src/nested/new.ts", 2]]);
    expect(listLessons(app, "demo")[0]).toMatchObject({ hits: 2, last_hit_at: expect.any(String) });
    saveLesson(app, "demo", { ...l, paths: null });
    expect((await lessonHits(app, "demo", r.dir, r.base, "HEAD")).some(h => h.file === "refund.ts")).toBe(false);
  });
  it("caps added lines, line length and hits, skips large and binary files", async () => {
    const app = appFor(), r = repo(app);
    saveLesson(app, "demo", { text: convention, pattern: "unsafe" });
    writeFileSync(join(r.dir, "a.ts"), "unsafe();\n".repeat(5010));
    writeFileSync(join(r.dir, "large.ts"), "unsafe".repeat(70000));
    writeFileSync(join(r.dir, "binary.ts"), Buffer.from("unsafe\0unsafe"));
    r.git("add", "."); r.git("commit", "-qm", "large additions");
    expect(await lessonHits(app, "demo", r.dir, r.base, "HEAD")).toHaveLength(20);
    const base = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "a.ts"), "safe();\n");
    writeFileSync(join(r.dir, "large.ts"), "unsafe".repeat(80000));
    writeFileSync(join(r.dir, "binary.ts"), Buffer.from("unsafe\0changed"));
    writeFileSync(join(r.dir, "length.ts"), "x".repeat(500) + "unsafe\n");
    r.git("add", "."); r.git("commit", "-qm", "line cap");
    expect(await lessonHits(app, "demo", r.dir, base, "HEAD")).toEqual([]);
    const base2 = r.git("rev-parse", "HEAD");
    writeFileSync(join(r.dir, "a.ts"), "safe();\n".repeat(5001));
    writeFileSync(join(r.dir, "z.ts"), "unsafe();\n");
    r.git("add", "."); r.git("commit", "-qm", "round cap");
    expect(await lessonHits(app, "demo", r.dir, base2, "HEAD")).toEqual([]);
  });
  it("merges lesson failures into the existing check, even without a command", async () => {
    const app = appFor(), r = repo(app); saveLesson(app, "demo", { text: convention, pattern: "unsafe" });
    writeFileSync(join(r.dir, "new.ts"), "unsafe();\n"); r.git("add", "."); r.git("commit", "-qm", "change");
    const c = await checkLessons(app, "demo", r.dir, r.base, "HEAD", { command: "npm test", code: 0, output: "Tests passed", ms: 1 });
    expect(c).toMatchObject({ command: "npm test", code: 1, output: expect.stringContaining("Tests passed") }); expect(c!.output).toContain("学到的约定（宿主按新增的行检查）");
    expect(await checkLessons(app, "demo", r.dir, r.base, "HEAD", null)).toMatchObject({ command: "学到的约定", code: 1 });
    expect(await checkLessons(app, "other", r.dir, r.base, "HEAD", null)).toBeNull();
  });
  it("bounds expensive model regexps without blocking the host", async () => {
    const app = appFor(), r = repo(app);
    saveLesson(app, "demo", { text: convention, pattern: "(a+)+$" });
    writeFileSync(join(r.dir, "new.ts"), "a".repeat(499) + "!\n"); r.git("add", "."); r.git("commit", "-qm", "change");
    const result = await checkLessons(app, "demo", r.dir, r.base, "HEAD", null);
    // The host could not finish its own check: said in the output, but not a failure the coder is sent back for.
    expect(result).toMatchObject({ code: 0, output: expect.stringContaining("模式检查超时") });
    expect(result!.output).toContain("不算检查失败");
    // With a check that passed, it stays passed.
    const passed = await checkLessons(app, "demo", r.dir, r.base, "HEAD", { command: "npm test", code: 0, output: "ok", ms: 1 });
    expect(passed).toMatchObject({ command: "npm test", code: 0 });
  });
  it("hands on conventions to reviewers, orders by hits, respects max, and counts only own lesson refs", async () => {
    const app = appFor(), r = repo(app), root = code(app);
    const a = saveLesson(app, "demo", { text: convention }), b = saveLesson(app, "demo", { text: "写入原件后必须更新对应的搜索索引" }), foreign = saveLesson(app, "other", { text: convention });
    recordReview(app, { codeRunId: root.id, round: 1, check: "reviewer", verdict: "changes_requested", summary: "缺少约定", findings: [{ severity: "major", title: "没有限定空间", detail: `违反 lesson:${a.id} 和 lesson:${foreign.id}`, evidence: [`lesson:${a.id}`], suggestion: "修复", confidence: "high" }] });
    expect(listLessons(app, "demo").find(l => l.id === a.id)?.hits).toBe(1); expect(listLessons(app, "other")[0].hits).toBe(0);
    app.config.review.lessons = { auto: true, max: 1 };
    expect(lessonsText(app, ["demo"])).toContain(a.id); expect(lessonsText(app, ["demo"])).not.toContain(b.id);
    const wt = { space: "demo", path: r.dir, base: r.base, branch: "main", commits: true };
    setRunOutput(app, root.id, { worktrees: [wt], repos: [{ space: "demo", diffStat: "", diffBytes: 0, check: null }] });
    expect((await reviewContext(app, root.id)).reviewTask).toContain(`lesson:${a.id}`);
  });
  it("carries a lesson failure through taskReview to the next coder task", async () => {
    const app = appFor(), r = repo(app), root = code(app, "demo", { taskMode: true, maxRounds: 1 });
    const l = saveLesson(app, "demo", { text: convention, pattern: "unsafe" });
    writeFileSync(join(r.dir, "new.ts"), "unsafe();\n"); r.git("add", "."); r.git("commit", "-qm", "change");
    const check = await checkLessons(app, "demo", r.dir, r.base, "HEAD", null);
    setRunOutput(app, root.id, { repos: [{ space: "demo", check, diffStat: "", diffBytes: 0 }], worktrees: [{ space: "demo", path: r.dir, branch: "main", base: r.base }] });
    await taskReview(app, root.id, { runId: root.id, signal: new AbortController().signal, event: () => {} });
    const failure = listTasks(app, root.id).find(t => t.title === "检查没通过")!;
    expect(failure).toBeTruthy(); expect(taskText(app, failure)).toContain(`lesson:${l.id}`);
    expect(taskText(app, failure)).toContain("new.ts:1");
    expect((await reviewContext(app, root.id)).reviewTask).toContain(check!.output);
  });
  it("curates lessons through the owner's API with validation", async () => {
    const app = appFor(), server = await startServer(app, { port: 0, quiet: true });
    try {
      const created = await server.inject({ method: "POST", url: "/api/spaces/demo/lessons", payload: { text: convention, pattern: "unsafe", paths: "src/**/*.ts" } });
      expect(created.statusCode).toBe(200); const l = created.json(); expect(l.state).toBe("on");
      const url = `/api/spaces/demo/lessons/${l.id}`;
      expect((await server.inject({ method: "PUT", url, payload: { ...l, state: "off" } })).statusCode).toBe(200);
      expect((await server.inject({ method: "GET", url: "/api/spaces/demo/lessons" })).json()[0].state).toBe("off");
      expect((await server.inject({ method: "POST", url: "/api/spaces/personal/lessons", payload: { text: convention } })).statusCode).toBe(400);
      expect((await server.inject({ method: "DELETE", url })).statusCode).toBe(200);
      expect((await server.inject({ method: "GET", url: "/api/spaces/demo/lessons" })).json()).toEqual([]);
    } finally { await server.close(); }
  });
  it("hands an outside coder the conventions and checks its committed hand-in through the code handler", async () => {
    const app = appFor(), r = repo(app), root = code(app, "demo", { peerCoder: { caller: "paired-demo" } });
    run(app.db, "update spaces set root_path=? where id='demo'", r.dir);
    const l = saveLesson(app, "demo", { text: convention, pattern: "unsafe" });
    const wt = { space: "demo", path: r.dir, branch: "main", base: r.base, start: r.base, commits: true };
    setRunOutput(app, root.id, { worktrees: [wt], verdict: "awaiting-peer-code", lessonBases: { demo: r.base } });
    run(app.db, "update runs set status='done' where id=?", root.id);
    expect(await peerWorkspace(app, root.id, "paired-demo", { action: "brief" })).toContain(`lesson:${l.id}`);
    await peerWorkspace(app, root.id, "paired-demo", { action: "write", path: "new.ts", content: "unsafe();\n" });
    // An outside coder may commit before handing in: the saved round base must survive that.
    r.git("add", "."); r.git("commit", "-qm", "change");
    const finished = await peerWorkspace(app, root.id, "paired-demo", { action: "finish", summary: "完成退款修改", review: "peer" });
    const id = /轮 (\S+)：/.exec(finished)![1];
    run(app.db, "update runs set status='running' where id=?", id);
    await __testHandlers.get("code")!({ app, run: getRun(app,id), signal: new AbortController().signal, event: (type,data) => addRunEvent(app,id,type,data), output: data => setRunOutput(app,id,data) });
    const check = (getRun(app,id).output.repos as { check: { code: number; output: string } }[])[0].check;
    expect(check.code).toBe(1); expect(check.output).toContain("new.ts:1");
    run(app.db, "update runs set status='done' where id=?", id);
    const material = await peerReviewTask(app, id, "paired-demo");
    expect(material).toContain(`lesson:${l.id}`); expect(material).toContain(check.output);
  });
  // Windows retains ACP child working directories after close; the host integration above runs everywhere.
  it.skipIf(process.platform === "win32")("drives a real fake-ACP coding round: coder conventions, host failed Check and reviewer material", async () => {
    const app = appFor(), r = repo(app), log = join(app.home, "coder.jsonl");
    run(app.db, "update spaces set root_path=? where id='demo'", r.dir);
    saveLesson(app, "demo", { text: "编码结束后不得新增名为 round 的导出变量", pattern: "export const round" });
    app.config.agents.profiles.push({ id: "fake", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "review", FAKE_CODER_LOG: log }, idleTimeoutMs: 60000 });
    app.config.agents.default = "fake";
    app.config.agents.design.mode = "never";
    app.config.review.tiers = [{ id: "one", name: "轻", guide: "", when: null, checks: ["reviewer"], maxRounds: 1, lead: false, confirmPlan: false }];
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const t = createThread(app, { channel: "web", spaceId: "demo", userId: "owner" });
      const ask = createRun(app, { kind: "ask", spaceId: "demo", title: "交办", input: { conversationId: t.id } });
      const root = createRun(app, { kind: "code", spaceId: "demo", title: "示例退款", input: { task: "修复退款", repos: ["demo"] }, parentId: ask.id });
      codeChainFor(app, root);
      run(app.db, "update runs set status='running' where id=?", root.id);
      await __testHandlers.get("code")!({ app, run: getRun(app, root.id), signal: new AbortController().signal, event: (type,data) => addRunEvent(app, root.id, type, data), output: data => setRunOutput(app, root.id, data) });
      expect(readFileSync(log, "utf8")).toContain("这个仓库学到的约定");
      const check = (getRun(app, root.id).output.repos as { check: { code: number; output: string } }[])[0].check;
      expect(check.code).toBe(1); expect(check.output).toContain("学到的约定（宿主按新增的行检查）");
      expect((await reviewContext(app, root.id)).reviewTask).toContain(check.output);
      expect(one(app.db, "select 1 from run_events where run_id=? and type='check'", root.id)).toBeTruthy();
    } finally { await server.close(); }
  }, 180000);
});
