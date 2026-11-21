import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, run } from "../src/core/db.ts";
import { now } from "../src/core/util.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { advance, flowReminders, ownerAction, reopenStage, reportStage, stopFlow } from "../src/flows/engine.ts";
import { itemFlow } from "../src/flows/store.ts";
import { describeStage, parseFlow } from "../src/flows/definitions.ts";
import { createRun, getRun, __testHandlers } from "../src/agents/runs.ts";
import * as runner from "../src/agents/runner.ts";
import { itemProgress } from "../src/agents/progress.ts";
import { eligibleFixes, fixModelStage } from "../src/studies/fixes.ts";
import { findings, trials, recordFinding } from "../src/studies/store.ts";
import { studyView, readLedger, reportTrial } from "../src/studies/service.ts";
import { putScope } from "../src/studies/scope.ts";
import { fixFinding } from "../src/studies/fix.ts";
import { setRunOutput } from "../src/agents/runs.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { studyFixture, git } from "./study-fixture.ts";

const fixtures: Awaited<ReturnType<typeof studyFixture>>[] = [];
async function setup(...args: Parameters<typeof studyFixture>) { const f = await studyFixture(...args); fixtures.push(f); return f; }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) { f.app.events.emit("close"); if (!itemFlow(f.app, f.item.id)?.endedAt) await stopFlow(f.app, f.item.id); await new Promise((r) => setImmediate(r)); f.app.db.close(); rmSync(f.app.home, { recursive: true, force: true }); }
});
describe("课题逐条改缺陷", () => {
  it("fixes 接受 AI、默认两条、最多二十条，并给出人话", () => {
    const raw = (fixes?: number) => JSON.stringify({ id: "test", name: "课题", stages: [{ id: "fix", name: "改", by: { object: "fixes", agent: "assistant" }, ai: "cheap", budget: { fixes, minutes: 240 } }] });
    expect(describeStage(parseFlow(raw()).stages[0]).budget).toContain("2 条");
    expect(() => parseFlow(raw(21))).toThrow(); expect(() => parseFlow(raw(-1))).toThrow();
    expect(parseFlow(raw(20)).stages[0].by).toMatchObject({ object: "fixes" });
  });
  it("按类型、状态、流程起点、轮次、许可、交办和上限挑选，按建立顺序", async () => {
    const f = await setup(); await f.finishTrial(); const id = f.finding();
    const flow = itemFlow(f.app, f.item.id)!, d = flow.definition.stages.at(-1)!;
    const pick = () => eligibleFixes(f.app, flow, d).map((v) => v.id);
    expect(pick()).toEqual([id]);
    for (const [column, value] of [["kind", "gap"], ["kind", "idea"], ["state", "later"], ["state", "rejected"], ["state", "duplicate"], ["round", 0], ["flow_started_at", "old"], ["work_id", "missing"]] as const) {
      const old = findings(f.app, f.item.id)[0][column]; run(f.app.db, `update study_findings set ${column}=? where id=?`, value, id); expect(pick()).toEqual([]); run(f.app.db, `update study_findings set ${column}=? where id=?`, old, id);
    }
    run(f.app.db, "update study_findings set state='confirmed' where id=?", id); expect(pick()).toEqual([id]);
    run(f.app.db, "update study_directions set allow_code=0"); expect(pick()).toEqual([]); run(f.app.db, "update study_directions set allow_code=1");
    run(f.app.db, "update study_trials set result='passed'"); expect(pick()).toEqual([]); run(f.app.db, "update study_trials set result='failed'");
    for (let i = 1; i < 4; i++) run(f.app.db, "insert into study_findings(id,item_id,kind,title,repro,trials,state,state_reason,same_as,created_at,updated_at,round,flow_started_at,work_id) select ?,item_id,kind,?,repro,trials,state,state_reason,same_as,?,updated_at,round,flow_started_at,work_id from study_findings where id=?", `sf-copy-${i}`, `发现 ${i}`, `2099-01-0${i}`, id);
    expect(pick()).toHaveLength(2); expect(pick()[0]).toBe(id); expect(eligibleFixes(f.app, flow, { ...d, budget: { fixes: 1 } })).toHaveLength(1);
    putScope(f.app, f.item.id, { allowCode: false }, "owner"); expect(pick()).toEqual([]);
    await f.beginFix(); expect(f.stage()).toMatchObject({ state: "skipped" }); expect(f.stage().note).toContain("这一轮没有要改的");
  });
  it("没有可改的发现就跳过；stage_report 不能完成 fixes", async () => {
    const f = await setup(); await f.finishTrial("passed");
    await expect(reportStage(f.app, f.item.id, "fix", { state: "done", note: "跳过队列" }, { actor: "assistant" })).rejects.toThrow("专门");
    await f.beginFix(); expect(f.stage().state).toBe("skipped");
  });
  it.each(["passed", "failed"] as const)("评审通过后在交办工作区重跑，%s 留在同一条发现上且不再交办", async (result) => {
    const f = await setup(); await f.finishTrial(); const id = f.finding(); await f.beginFix();
    const { work, cwd } = await f.approve(), t = trials(f.app, f.item.id).find((t) => t.fix_of)!;
    expect(t).toMatchObject({ fix_of: id, work_id: work.id, round: 1, state: "running" });
    const r = getRun(f.app, t.run_id!); expect(r.input.cwd).toBe(cwd); expect(cwd).not.toBe(f.root);
    const original = trials(f.app, f.item.id).find((t) => !t.fix_of)!;
    expect(cwd).not.toBe(getRun(f.app, original.run_id!).input.cwd);
    expect(t.object).toBe(original.object); expect(t.check).toBe(original.check);
    expect(JSON.parse(t.commits).repo).toBe(await git(cwd, "rev-parse", "HEAD"));
    expect(r.input.task).toContain("这是改动之后的重跑，只照复现办法验证，不要再改代码");
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, options) => {
      expect(options.cwd).toBe(cwd); expect(options.addTools).toContain("trial_report"); expect(options.denyTools).toContain("delegate_code");
      return { text: "假后端验证", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    await __testHandlers.get("study-trial")!({ app: f.app, run: r, signal: new AbortController().signal, event() {}, output() {} }); expect(fake).toHaveBeenCalledOnce();
    await f.finishTrial(result, "fix"); expect(f.stage().state).toBe("done");
    expect(studyView(f.app, f.item.id).findings[0].fix).toMatchObject({ workId: work.id, verified: result, reruns: [t.id] });
    expect(readLedger(f.app, { item: f.item.id }, null)).toContain(`重跑：${result}`);
    await reopenStage(f.app, f.item.id, "fix", "重新看结果", [], { actor: "owner", userId: "owner" });
    expect(all(f.app.db, "select id from runs where kind='code'")).toHaveLength(1); expect(trials(f.app, f.item.id).filter((t) => t.fix_of)).toHaveLength(1);
  });
  it("跨轮重跑在折叠历史时保留发现，展开后指向原试验", async () => {
    const f = await setup();
    await f.finishTrial();
    const original = trials(f.app, f.item.id)[0];
    const finding = f.finding();
    await f.beginFix();
    // The fix is approved in the following round; the fixes stage creates the rerun.
    run(f.app.db, "update item_flows set round=2 where item_id=?", f.item.id);
    run(f.app.db, "update item_stages set round=2 where item_id=?", f.item.id);
    await f.approve();
    const rerun = trials(f.app, f.item.id).find(t => t.fix_of === finding)!;
    expect([original.round, rerun.round]).toEqual([1, 2]);
    for (const history of [false, true]) {
      const study = itemProgress(f.app, f.item.id, { user: "owner" }, history).find(v => v.kind === "study")!;
      expect(study.tasks.some(t => t.id === original.id)).toBe(history);
      const row = study.tasks.find(t => t.id === rerun.id)!;
      expect(row.outputs).toContainEqual({ kind: "finding", ref: finding, label: "退出码错误 0" });
      expect(row.needs).toEqual(history ? [original.id] : undefined);
    }
  });
  it.each(["failed", "cancelled", "changes-requested"])("交办 %s 时不重跑、不反复改", async (status) => {
    const f = await setup(); await f.finishTrial(); f.finding(); await f.beginFix(); const work = f.stage().control.fixWorkId!;
    run(f.app.db, "update runs set status=?,output=?,finished_at=? where id=?", status === "changes-requested" ? "done" : status, JSON.stringify({ verdict: status }), now(), work);
    await advance(f.app, f.item.id); expect(f.stage().state).toBe("done"); expect(f.stage().note).toContain("评审没过，等你看");
    expect(trials(f.app, f.item.id).filter((t) => t.fix_of)).toEqual([]);
    expect(all(f.app.db, "select id from runs where kind='code'")).toHaveLength(1);
  });
  it.each(["passed", "blocked", "unclear"] as const)("两条失败依据全部重跑；最终 %s，不重试、不升档", async (result) => {
    const f = await setup(undefined, 2); await f.finishTrial(); await f.finishTrial(); const id = f.finding();
    run(f.app.db, "update study_findings set trials=? where id=?", JSON.stringify(trials(f.app, f.item.id).map((t) => t.id)), id);
    await f.beginFix(); await f.approve();
    expect(studyView(f.app, f.item.id).findings[0].fix?.reruns).toHaveLength(2);
    expect(studyView(f.app, f.item.id).findings[0].fix?.verified).toBeNull();
    await f.finishTrial("passed", "fix"); expect(studyView(f.app, f.item.id).findings[0].fix?.verified).toBeNull();
    const s = f.stage(); await reportTrial(f.app, { trial: s.control.trialId!, result, summary: "照复现步骤验证", unsure: true }, { actor: "assistant", userId: "owner", runId: s.control.runId });
    run(f.app.db, "update runs set status='done',finished_at=? where id=?", now(), s.control.runId!); await advance(f.app, f.item.id);
    expect(f.stage().state).toBe("done"); expect(studyView(f.app, f.item.id).findings[0].fix?.verified).toBe(result);
    expect(trials(f.app, f.item.id).filter((t) => t.fix_of).map((t) => [t.attempts, t.escalated])).toEqual([[1, 0], [1, 0]]);
  });
  it.each([true, false])("有试验定义 %s：重跑取试验 AI，否则取改阶段 AI，worker 保持同一档", async (hasTrialStage) => {
    const f = await setup(); await f.finishTrial(); f.finding();
    f.app.config.agents.profiles.push(agentProfileSchema.parse({ id: "trial-ai", transport: "acp", command: "node", model: "small" }), agentProfileSchema.parse({ id: "fix-ai", transport: "acp", command: "node", model: "medium" }));
    f.app.config.agents.tiers.cheap = { profile: "trial-ai", model: "small" }; f.app.config.agents.tiers.standard = { profile: "fix-ai", model: "medium" };
    const before = itemFlow(f.app, f.item.id)!;
    const override = fixModelStage(before, { ...before.definition.stages.at(-1)!, by: { object: "fixes", skill: "verify-change" } });
    expect(override.by).toMatchObject({ object: "fixes", skill: "verify-change" }); expect(override.ai).toBe("cheap");
    if (!hasTrialStage) {
      const flow = itemFlow(f.app, f.item.id)!; flow.definition.stages = flow.definition.stages.filter((d) => d.id !== "try");
      run(f.app.db, "update item_flows set definition=? where item_id=?", JSON.stringify(flow.definition), f.item.id);
    }
    f.app.config.flows.autoAdvance = 1; await f.beginFix(); expect(f.stage().state).toBe("doing");
    await f.approve(); const r = getRun(f.app, f.stage().control.runId!);
    const expected = hasTrialStage ? "trial-ai" : "fix-ai"; expect(r.input.execution).toMatchObject({ profile: expected });
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, options) => {
      expect(options.execution?.profile).toBe(expected);
      return { text: "假后端", profileId: expected, ai: { profile: expected } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    await __testHandlers.get("study-trial")!({ app: f.app, run: r, signal: new AbortController().signal, event() {}, output() {} }); expect(fake).toHaveBeenCalledOnce();
  });
  it("重跑后端失败只记 blocked，不再排第二次运行", async () => {
    const f = await setup(); await f.finishTrial(); f.finding(); await f.beginFix(); await f.approve(); const id = f.stage().control.runId!;
    run(f.app.db, "update runs set status='failed',error='fake backend failed',finished_at=? where id=?", now(), id); await advance(f.app, f.item.id);
    expect(studyView(f.app, f.item.id).findings[0].fix?.verified).toBe("blocked");
    expect(trials(f.app, f.item.id).filter((t) => t.fix_of)).toHaveLength(1); expect(f.stage().state).toBe("done");
  });
  it("分钟用满就结束，排队时间不算，不取消交办", async () => {
    const f = await setup({ fixes: 2, minutes: 1 }); await f.finishTrial(); f.finding(); await f.beginFix(); const work = f.stage().control.fixWorkId!;
    await flowReminders(f.app, new Date(Date.now() + 120000)); expect(f.stage().state).toBe("doing");
    run(f.app.db, "update runs set status='running',started_at=? where id=?", now(), work);
    const review = createRun(f.app, { kind: "review", parentId: work, spaceId: "project", title: "假评审" });
    run(f.app.db, "update runs set status='running',started_at=? where id=?", now(), review.id);
    await flowReminders(f.app, new Date(Date.now() + 45000)); expect(f.stage().state).toBe("doing");
    await flowReminders(f.app, new Date(Date.now() + 120000)); expect(f.stage().state).toBe("done"); expect(f.stage().note).toContain("还在改"); expect(getRun(f.app, work).status).toBe("running");
  });
  it("一次只改一条，前一条重跑结束才发起第二条", async () => {
    const f = await setup(undefined, 2); await f.finishTrial(); await f.finishTrial(); const first = f.finding();
    recordFinding(f.app, { item: f.item.id, kind: "defect", title: "帮助输出缺少用法", repro: "运行 help 缺少用法行", trials: [trials(f.app, f.item.id)[1].id], distinct_from: [first] });
    await f.beginFix(); const work = f.stage().control.fixWorkId!; expect(all(f.app.db, "select id from runs where kind='code'")).toHaveLength(1);
    await f.approve(); expect(all(f.app.db, "select id from runs where kind='code'")).toHaveLength(1);
    await f.finishTrial("passed", "fix"); const secondWork = f.stage().control.fixWorkId!;
    expect(secondWork).not.toBe(work); expect(all(f.app.db, "select id from runs where kind='code'")).toHaveLength(2);
    run(f.app.db, "update runs set status='failed',finished_at=? where id=?", now(), secondWork); await advance(f.app, f.item.id);
    expect(f.stage().state).toBe("done"); expect(f.stage().note).toContain("改了 2 条"); expect(f.stage().note).toContain("改后通过"); expect(f.stage().note).toContain("评审没过");
  });
  it("流程停止时正在改的交办继续独立运行", async () => {
    const f = await setup(); await f.finishTrial(); f.finding(); await f.beginFix(); const id = f.stage().control.fixWorkId!;
    run(f.app.db, "update runs set status='running',started_at=? where id=?", now(), id);
    await stopFlow(f.app, f.item.id); expect(getRun(f.app, id).status).toBe("running");
  });
  it.each(["stop", "skip", "reopen"])("%s 只取消重跑，交办保持原状", async (action) => {
    const f = await setup(); await f.finishTrial(); f.finding(); await f.beginFix(); const { work } = await f.approve();
    const rerun = f.stage().control.runId!;
    if (action === "stop") await stopFlow(f.app, f.item.id);
    else if (action === "skip") await ownerAction(f.app, f.item.id, "fix", "skip", "本轮先停", "owner");
    else await reopenStage(f.app, f.item.id, "fix", "重新检查", [], { actor: "owner", userId: "owner" });
    expect(getRun(f.app, rerun).status).toBe("cancelled"); expect(getRun(f.app, work.id).status).toBe("done");
    expect(trials(f.app, f.item.id).find((t) => t.run_id === rerun)).toMatchObject({ state: "skipped", result: null });
  });
});

describe("本人手动发起的改动也会被重跑验证", () => {
  it("评审通过、还没重跑过的手动交办，由下一次“改”这一段在交办的工作区里重跑", async () => {
    const f = await setup(); await f.finishTrial(); const id = f.finding();
    await fixFinding(f.app, f.item.id, id, undefined, "owner");
    const work = getRun(f.app, findings(f.app, f.item.id)[0].work_id!);
    const cwd = join(f.app.runsDir, work.id, "work", "repo"); mkdirSync(join(f.app.runsDir, work.id, "work"), { recursive: true });
    await git(f.root, "worktree", "add", "-qb", `fix-${work.id}`, cwd);
    writeFileSync(join(cwd, "entry.txt"), "after"); await git(cwd, "add", "."); await git(cwd, "commit", "-qm", "fix");
    setRunOutput(f.app, work.id, { worktrees: [{ space: "repo", path: cwd, branch: `fix-${work.id}`, base: await git(f.root, "rev-parse", "HEAD") }], verdict: "approved" });
    run(f.app.db, "update runs set status='done',started_at=?,finished_at=? where id=?", now(), now(), work.id);
    await f.beginFix();
    // The finding already has a delegation, so nothing new is started: its failed trial is run again on that change.
    expect(all(f.app.db, "select id from runs where kind='code'")).toHaveLength(1);
    const rerun = trials(f.app, f.item.id).find((t) => t.fix_of)!;
    expect(rerun).toMatchObject({ fix_of: id, work_id: work.id, state: "running" });
    expect(getRun(f.app, rerun.run_id!).input.cwd).toBe(cwd);
  });
});
