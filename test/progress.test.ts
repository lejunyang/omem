import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { testApp } from "./helpers.ts";
import { run } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";
import { itemProgress, runProgress, states } from "../src/agents/progress.ts";
import { addTask, updateTask } from "../src/agents/code-tasks.ts";
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
