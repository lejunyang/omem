import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src/server/http.ts";
import { callTool } from "../src/agents/tools.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createUser, createApiToken, addMember } from "../src/core/users.ts";
import { rmSync } from "node:fs";
import { testApp } from "./helpers.ts";
import { run } from "../src/core/db.ts";
import { addMaterials } from "../src/items/materials.ts";
import { upsertItem } from "../src/items/store.ts";
import { itemProgress, runProgress, states } from "../src/agents/progress.ts";
import { addTask, updateTask } from "../src/agents/code-tasks.ts";
import { recordReview, findingSchema } from "../src/agents/review.ts";
import { readBoard } from "../src/agents/work-board.ts";
import { saveProposals, confirmDirection } from "../src/studies/store.ts";

const owner = { user: "owner" };
const at = "2026-01-01T09:00:00.000Z";
const apps: ReturnType<typeof testApp>[] = [];
function fixture() {
  const app = testApp();
  apps.push(app);
  const item = upsertItem(app, undefined, { title: "项目 A", spaceId: "personal" });
  function add(id: string, kind: string, parent: string | null, input = {}, output = {}, scope = ["personal"]) {
    run(app.db, `insert into runs(id,kind,space_id,status,title,input,output,scope,parent_id,created_at) values(?,?,'personal','done',?,?,?,?,?,?)`,
      id, kind, id, JSON.stringify(input), JSON.stringify(output), JSON.stringify(scope), parent, at);
  }
  return { app, item, add };
}
afterEach(() => {
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});

describe("进度投影", () => {
  it("任务板、修改项和评审共存；重做、子运行和共用运行按 ID 汇总", () => {
    const { app, item, add } = fixture();
    add("root", "ask", null, { itemId: item.id }, { agentWork: { askRunId: "root", title: "任务板", workConversationId: "work", rootConversationId: "origin" } });
    add("first", "agent", "root"); add("retry", "agent", "root"); add("child", "agent", "retry");
    add("hidden", "agent", "root", {}, {}, ["other"]);
    const history = ["first", "retry"].map(runId => ({ runId, queuedAt: at, startedAt: at, finishedAt: at, status: "done", device: "本机" }));
    for (const [seq, id, attempts] of [[1, "retry", history], [2, "hidden", [{ ...history[0], runId: "hidden" }]]] as const)
      run(app.db, `insert into agent_work_tasks(id,work_id,seq,title,goal,accept,status,scope,attempts,run_id,deadline_minutes,deadline_at,created_at,updated_at)
        values(?,'root',?,?,'核对','交付','accepted','{}',?,?,10,?,?,?)`, id, seq, id, JSON.stringify(attempts), id, at, at, at);
    run(app.db, "insert into run_events values('first',1,?,'usage',?),('retry',1,?,'usage',?),('retry',2,?,'usage',?)", at, '{"input":10,"output":4,"cached":3}', at, '{"used":250,"size":1000}', at, '{"used":500,"size":1000}');
    add("code", "code", "root", { itemId: item.id }, { reviewPlan: { checks: ["style"] }, reviewStage: "done" });
    add("helper", "agent", "code", { helperOf: "code", tasks: [1, 2] });
    for (const title of ["改一处", "改另一处"]) {
      const t = addTask(app, "code", { title, kind: "build", doneWhen: "可验证" }, "coder");
      updateTask(app, "code", t.seq, { state: "verify", coderRun: "helper" });
    }
    run(app.db, "insert into reviews(id,code_run_id,check_name,profile_id,model,verdict,summary,created_at) values('review','code','style','worker','model-a','changes_requested','需要调整',?)", at);
    run(app.db, "insert into review_findings(review_id,severity,title,decision,decision_note) values('review','minor','格式','fix','同意')");
    const views = runProgress(app, "child", { user: "owner", spaces: ["personal"] });
    expect(views.map(v => v.kind).sort()).toEqual(["board", "code", "review"]);
    const board = views.find(v => v.kind === "board")!;
    expect(board.tasks.map(t => t.id)).toEqual(["retry"]);
    expect(board.tasks[0].attempts.map(a => a.runId)).toEqual(["first", "retry"]);
    expect(board.usage).toEqual({ input: 10, output: 4, cached: 3, runs: 3, missing: 2 });
    expect(readBoard(app, "root")).toMatchObject({ workId: "root", askRunId: "root", status: "summarized", tasks: [{ status: "accepted", attempts: [{}, { used: 500 }] }, {}] });
    const code = views.find(v => v.kind === "code")!;
    expect(code.tasks.map(t => t.state)).toEqual(["submitted", "submitted"]);
    expect(code.usage.runs).toBe(1);
    expect(views.find(v => v.kind === "review")?.tasks[0]).toMatchObject({ who: { model: "model-a" }, decision: { result: "fix" }, outputs: [{ label: expect.stringContaining("1 个问题") }, { label: "格式" }] });
    expect(itemProgress(app, item.id, owner).map(v => v.kind).sort()).toEqual(["board", "code", "review"]);
  });

  it("续轮评审合入一个块，保留每轮结论、问题、取舍和用量", () => {
    const { app, add } = fixture();
    const plan = { reviewPlan: { checks: ["style"] }, reviewStage: "done" };
    add("code1", "code", null, {}, plan);
    add("code2", "code", null, { continueFrom: "code1" }, plan);
    for (const round of [1, 2]) {
      const codeRunId = "code" + round;
      const runId = "review" + round;
      add(runId, "review", codeRunId);
      const review = recordReview(app, { codeRunId, round, check: "style", verdict: round === 1 ? "changes_requested" : "approved",
        summary: "结论" + round, findings: [findingSchema.parse({ severity: "minor", title: "问题" + round })] });
      run(app.db, "update review_findings set decision='fix' where review_id=?", review);
      run(app.db, "insert into run_events values(?,1,?,'usage',?)", runId, at, JSON.stringify({ input: round, output: round }));
    }
    const blocks = runProgress(app, "code2", owner).filter(v => v.kind === "review");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: "code1", usage: { input: 3, output: 3, runs: 2, missing: 0 },
      tasks: [{ state: "accepted", attempts: [{ runId: "review1" }, { runId: "review2" }],
        outputs: [{ label: "changes_requested · 1 个问题 · 结论1" }, { label: "问题1" }, { label: "approved · 1 个问题 · 结论2" }, { label: "问题2" }],
        decisions: [{ result: "fix" }, { result: "fix" }] }] });
  });

  it("内嵌续轮评审进行中保留旧报告，提交新报告后才转为通过", () => {
    const { app, add } = fixture();
    const reviewPlan = { checks: ["style"] };
    add("code1", "code", null, {}, { reviewPlan, reviewStage: "done" });
    recordReview(app, { codeRunId: "code1", round: 1, check: "style", verdict: "changes_requested", summary: "请修改", findings: [] });
    add("code2", "code", null, { continueFrom: "code1" }, { reviewPlan, reviewStage: "checks" });
    run(app.db, "update runs set status='running' where id='code2'");
    run(app.db, "insert into run_events values('code2',1,?,'usage',?)", at, '{"input":3,"output":1}');
    const review = () => runProgress(app, "code1", owner).find(v => v.kind === "review");
    expect(review()).toMatchObject({ state: "running", tasks: [{ state: "running", attempts: [{ runId: "code1" }, { runId: "code2" }],
      outputs: [{ label: expect.stringContaining("请修改") }], usage: { runs: 2, input: 3, output: 1 } }] });
    recordReview(app, { codeRunId: "code2", round: 2, check: "style", verdict: "approved", summary: "通过", findings: [] });
    run(app.db, "update runs set status='done',output=json_set(output,'$.reviewStage','done') where id='code2'");
    expect(review()).toMatchObject({ state: "done", tasks: [{ state: "accepted", outputs: [{}, { label: expect.stringContaining("通过") }] }] });
  });

  it("单项重评保留内嵌首试，整轮独立评审只记实际评审运行", () => {
    const { app, add } = fixture();
    add("code", "code", null, {}, { reviewPlan: { checks: ["style", "logic"] } });
    for (const [seq, check] of ["style", "logic"].entries()) {
      run(app.db, "insert into run_events values('code',?,?,'status',?)", seq + 1, at, JSON.stringify({ phase: "reviewer", check }));
      recordReview(app, { codeRunId: "code", round: 1, check, verdict: check === "style" ? "failed" : "approved", summary: check, findings: [] });
    }
    add("retry", "review", "code", { only: ["style"] });
    run(app.db, "insert into run_events values('retry',1,?,'status',?)", at, JSON.stringify({ phase: "reviewer", check: "style" }));
    for (const id of ["code", "retry"]) run(app.db, "insert into run_events values(?,3,?,'usage',?)", id, at, '{"input":5,"output":3}');
    recordReview(app, { codeRunId: "code", round: 1, check: "style", verdict: "approved", summary: "重评通过", findings: [] });
    const view = () => runProgress(app, "code", owner).find(b => b.kind === "review")!;
    const single = { runs: 1, missing: 0, input: 5, output: 3 };
    const both = { runs: 2, missing: 0, input: 10, output: 6 };
    expect(view()).toMatchObject({ usage: both, tasks: [
      { id: "style", attempts: [{ runId: "code", usage: single }, { runId: "retry", usage: single }], usage: both },
      { id: "logic", attempts: [{ runId: "code", usage: single }], usage: single },
    ] });
    // Even without an explicit selection, the host events identify the check that ran.
    run(app.db, "update runs set input='{}' where id='retry'");
    expect(view().tasks.map(t => t.attempts.map(a => a.runId))).toEqual([["code", "retry"], ["code"]]);
  });

  it("流程保留关卡和依赖，课题默认只展开当前轮，重跑仍归原试验", () => {
    const { app, item, add } = fixture();
    const definition = { id: "flow", name: "核验", stages: [{ id: "plan", name: "方向", by: "owner", tools: ["propose_directions"], needs: [] }, { id: "try", name: "试验", by: "wait", needs: ["plan"] }] };
    run(app.db, "insert into item_flows(item_id,flow_id,definition,started_at,started_by,updated_at,round) values(?,'flow',?,?,'owner',?,2)", item.id, JSON.stringify(definition), at, at);
    run(app.db, "insert into item_stages(item_id,stage_id,state,since,updated_at,round) values(?,'plan','gated',?,?,2)", item.id, at, at);
    const proposal = { item: item.id, directions: [{ goal: "核验", approach: "对照", acceptance: "一致", trials: [{ object: "表格", check: "行数" }] }] };
    saveProposals(app, proposal, 1);
    const d = saveProposals(app, proposal, 2)[0];
    confirmDirection(app, d.id, "开始");
    const trial = app.db.prepare("select id from study_trials where direction_id=?").get(d.id)!.id as string;
    for (const id of ["a", "b"]) add(id, "study-trial", null, { itemId: item.id, stageId: "try", flowStartedAt: at, round: 2, trialId: trial });
    const [flow, study] = itemProgress(app, item.id, owner);
    expect(flow).toMatchObject({ kind: "flow", state: "waiting", waitingOn: "等本人确认", tasks: [{ state: "blocked" }, { needs: ["plan"] }] });
    expect(study.tasks.map(t => t.round)).toEqual([2, 2]);
    expect(study.tasks[1]).toMatchObject({ parentId: d.id, attempts: [{ runId: "a" }, { runId: "b" }], usage: { runs: 2, missing: 2 } });
    expect(study.previousRounds).toMatchObject([{ round: 1, directions: 1, trials: 0 }]);
    expect(itemProgress(app, item.id, owner, true).find(v => v.kind === "study")?.tasks.some(t => t.round === 1)).toBe(true);
    expect(runProgress(app, "a", owner).map(v => v.kind)).toEqual(["flow", "study"]);
    run(app.db, "update study_trials set result='failed',state='reported' where id=?", trial);
    run(app.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,created_at,updated_at) values('finding',?,'defect','缺行','核对',?,'confirmed',?,?)",
      item.id, JSON.stringify([trial]), at, at);
    run(app.db, `insert into study_trials(id,item_id,direction_id,round,seq,object,"check",state,fix_of,created_at,updated_at)
      values('rerun',?,?,2,2,'表格','行数','queued','finding',?,?)`, item.id, d.id, at, at);
    const rerun = () => itemProgress(app, item.id, { ...owner, spaces: ["personal"] })
      .find(v => v.kind === "study")!.tasks.find(t => t.id === "rerun");
    expect(rerun()?.needs).toEqual([trial]);
    add("private", "study-trial", null, {}, {}, ["other"]);
    run(app.db, "update study_trials set run_id='private' where id=?", trial);
    expect(rerun()?.needs).toBeUndefined();
  });
  it("事项只挂续轮时归入可见根交办，隐藏续轮不能引出根运行", async () => {
    const { app, item, add } = fixture();
    add("code", "code", null);
    add("later", "code", null, { continueFrom: "code" });
    addTask(app, "code", { title: "首轮修改项", kind: "build" }, "coder");
    await addMaterials(app, item.id, [{ kind: "run", ref: "later" }], "owner");
    const reader = { user: "owner", spaces: ["personal"] };
    expect(itemProgress(app, item.id, reader)).toMatchObject([{ id: "code", tasks: [{ title: "首轮修改项" }],
      rounds: [{ runId: "code" }, { runId: "later" }] }]);
    run(app.db, "update runs set scope=? where id='later'", JSON.stringify(["other"]));
    expect(itemProgress(app, item.id, reader)).toEqual([]);
  });

  it("从事项找关联运行时按索引查子运行、续轮和用量", () => {
    const { app, item, add } = fixture();
    add("code", "code", null, { itemId: item.id }, { reviewPlan: { checks: ["style"] } });
    const prepare = vi.spyOn(app.db, "prepare");
    const code = itemProgress(app, item.id, owner).find(v => v.kind === "code")!;
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    expect(code.rounds).toMatchObject([{ runId: "code" }]);
    const plans = queries.filter(q => q.includes("with recursive tree") || q.includes("progress_board_item") || q.includes("progress_tokens") || q.includes("progress_review_checks"))
      .flatMap(q => app.db.prepare("explain query plan " + q).all(...Array((q.match(/\?/g) ?? []).length).fill("[]")))
      .map(row => row.detail as string);
    expect(plans.filter(s => /^SCAN (r|runs|e|run_events)\b/.test(s))).toEqual([]);
    for (const index of ["runs_parent", "runs_continue_from", "progress_tokens", "progress_review_checks", "progress_board_item"])
      expect(plans.some(s => s.startsWith("SEARCH") && s.includes(index))).toBe(true);
  });
  it("运行与事项沿用详情权限，助手同时受本轮空间限制", async () => {
    const { app, item, add } = fixture();
    add("code", "code", null, { itemId: item.id });
    addTask(app, "code", { title: "核对说明", kind: "build" }, "coder");
    createUser(app, { id: "reader", name: "读者" });
    const headers = { authorization: "Bearer " + createApiToken(app, "reader", "test") };
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      for (const url of ["/api/items/" + item.id, "/api/runs/code"]) {
        const detail = await server.inject({ url, headers });
        const denied = await server.inject({ url: url + "/progress", headers });
        expect(denied.statusCode).toBe(detail.statusCode);
        expect([403, 404]).toContain(denied.statusCode);
        const response = await server.inject({ url: url + "/progress" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject([{ kind: "code", tasks: [{ title: "核对说明" }] }]);
      }
      createSpace(app, { id: "shared", name: "共享项目" });
      addMember(app, "shared", "reader", "editor");
      add("board", "ask", null, {}, { agentWork: { askRunId: "board", title: "核验" } }, ["shared"]);
      add("visible", "agent", "board", {}, {}, ["shared"]);
      add("private-child", "agent", "board");
      run(app.db, "update runs set space_id='shared' where id in ('board','visible')");
      for (const [i, id] of ["visible", "private-child"].entries()) {
        const attempts = [{ runId: id, status: "done", queuedAt: at, startedAt: at, finishedAt: at }];
        run(app.db, `insert into agent_work_tasks(id,work_id,seq,title,goal,accept,scope,status,attempts,run_id,deadline_minutes,deadline_at,created_at,updated_at)
          values(?,'board',?,?,'核对','提交','{}','accepted',?,?,1,?,?,?)`, id, i + 1, id, JSON.stringify(attempts), id, at, at, at);
      }
      for (const url of ["/api/runs/board/progress", "/api/agent-work/board/board"]) {
        const visible = await server.inject({ url, headers });
        expect(visible.statusCode).toBe(200);
        expect(visible.body).toContain("visible");
        expect(visible.body).not.toContain("private-child");
      }
      expect((await server.inject({ url: "/api/items/" + item.id + "/progress?limit=101" })).statusCode).toBe(400);
      const ctx = { app, runId: null, spaceId: "personal", userId: "owner", actor: "agent", spaces: ["personal"], tools: null } as const;
      for (const args of [{ item_id: item.id }, { run_id: "code" }]) {
        const reply = await callTool({ ...ctx, spaces: ["personal"] }, "work_status", args);
        expect(reply.isError, reply.text).toBe(false);
        expect(reply.text).toContain("核对说明");
        expect((await callTool({ ...ctx, spaces: [] }, "work_status", args)).isError).toBe(true);
      }
    } finally { await server.close(); }
  });
  it("共享事项按流程和编码的分区权限裁剪进度", async () => {
    const { app, add } = fixture();
    createSpace(app, { id: "shared", name: "项目 A" });
    createUser(app, { id: "reader", name: "读者", role: "observer" });
    addMember(app, "shared", "reader", "editor");
    const item = upsertItem(app, undefined, { title: "共享事项", spaceId: "shared" });
    const definition = { id: "study", name: "课题", stages: [{ id: "plan", name: "方向", by: "owner", tools: ["propose_directions"] }] };
    run(app.db, "insert into item_flows(item_id,flow_id,definition,started_at,started_by,updated_at) values(?,'study',?,?,'owner',?)", item.id, JSON.stringify(definition), at, at);
    add("code", "code", null, { itemId: item.id, flowStartedAt: at }, { reviewPlan: { checks: ["style"] } }, ["shared"]);
    run(app.db, "update runs set space_id='shared' where id='code'");
    addTask(app, "code", { title: "修改项", kind: "build" }, "coder");
    const reader = { user: "reader" };
    const kinds = () => [itemProgress(app, item.id, reader), runProgress(app, "code", reader)].map(v => v.map(b => b.kind).sort());
    expect(kinds()).toEqual(Array(2).fill(["code", "flow", "review", "study"]));
    const server = await startServer(app, { port: 0, quiet: true });
    try {
      const headers = { authorization: "Bearer " + createApiToken(app, "reader", "test") };
      for (const [capability, expected] of [
        ["flows.view", ["code", "review", "study"]], ["code.work.view", ["flow", "review", "study"]],
      ] as const) {
        const result = await server.inject({ url: "/api/members/reader/capabilities", method: "PUT", payload: {
          preset: "member", overrides: ["items.view", "runs.view", "code.review.view", "flows.view", "code.work.view"].map(key => ({
            capability: key, scope_kind: "space", scope_id: "shared", effect: key === capability ? "deny" : "allow",
          })),
        } });
        expect(result.statusCode).toBe(200);
        for (const url of ["/api/items/" + item.id + "/progress", "/api/runs/code/progress"]) {
          const response = await server.inject({ url, headers });
          expect(response.statusCode).toBe(200);
          expect(response.json().map((v: { kind: string }) => v.kind).sort()).toEqual(expected);
        }
        for (const args of [{ item_id: item.id }, { run_id: "code" }]) {
          const reply = await callTool({ app, runId: null, spaceId: "shared", userId: "reader", actor: "agent", spaces: ["shared"], tools: null }, "work_status", args);
          expect(reply.isError, reply.text).toBe(false);
          expect(Array.from(reply.text.matchAll(/（(code|flow|review|study) · /g), m => m[1]).sort()).toEqual(expected);
        }
      }
    } finally { await server.close(); }
  });

  it("固定来源状态映射", () => {
    expect(states).toMatchInlineSnapshot(`
      {
        "board": {
          "accepted": "accepted",
          "blocked": "blocked",
          "cancelled": "cancelled",
          "done": "submitted",
          "failed": "failed",
          "pending": "queued",
          "rejected": "redo",
          "running": "running",
        },
        "code": {
          "assistant": "blocked",
          "coding": "running",
          "disputed": "blocked",
          "done": "accepted",
          "owner": "blocked",
          "reverted": "redo",
          "todo": "pending",
          "verify": "submitted",
          "wontdo": "cancelled",
        },
        "direction": {
          "active": "running",
          "confirmed": "queued",
          "done": "accepted",
          "dropped": "cancelled",
          "proposed": "submitted",
        },
        "flow": {
          "blocked": "blocked",
          "doing": "running",
          "done": "accepted",
          "gated": "blocked",
          "pending": "pending",
          "skipped": "cancelled",
          "stale": "redo",
        },
        "review": {
          "approved": "accepted",
          "changes_requested": "submitted",
          "failed": "failed",
        },
        "trial": {
          "queued": "queued",
          "reported": "submitted",
          "running": "running",
          "skipped": "cancelled",
        },
      }
    `);
  });
});
