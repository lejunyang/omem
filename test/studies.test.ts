import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createWriteStream, readdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { now } from "../src/core/util.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { createRun, getRun, trackAbort, __testHandlers } from "../src/agents/runs.ts";
import { artifactInbox } from "../src/agents/artifacts.ts";
import { readSkill, seedBuiltinSkills } from "../src/agents/specs.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { upsertItem } from "../src/items/store.ts";
import { writeWorkFile } from "../src/sources/work.ts";
import { parseFlow, describeStage, saveFlow, seedBuiltinFlows } from "../src/flows/definitions.ts";
import { advance, flowReminders, flowView, ownerAction, reopenStage, reportStage, startFlow, startRound, stopFlow, updateStageBudget } from "../src/flows/engine.ts";
import { getStage, itemFlow, stageLog } from "../src/flows/store.ts";
import { closeDirection, confirmDirection, direction, directions, findings, idleRounds, recordFinding, saveProposals, trial, trials, reconcile, type Trial } from "../src/studies/store.ts";
import { coverage, capabilitiesPath, planningMaterials } from "../src/studies/materials.ts";
import { proposeDirections, readLedger, reportTrial, studyView } from "../src/studies/service.ts";
import { startServer } from "../src/server/http.ts";
import { git } from "../src/core/git.ts";
import { cleanupFetched, mergeLibrary, snapshotStream, type Fetched } from "../src/core/pull.ts";
import { appendToSource } from "../src/sources/store.ts";
import * as runner from "../src/agents/runner.ts";
import { putScope, scopeView } from "../src/studies/scope.ts";

const apps: App[] = [], servers: FastifyInstance[] = [];
const owner = { actor: "owner", userId: "owner" };
function fixture() { const a = testApp(); a.config.flows.autoAdvance = 20; apps.push(a); return a; }
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});
const planned = (n = 3) => ({ goal: "逐项核验命令", approach: "用 demo-cli 逐个走入口", acceptance: `${n} 项跑完`, env: "local", estimate: "30 分钟", trials: Array.from({ length: n }, (_, i) => ({ object: `功能 ${i + 1}`, check: "执行帮助命令" })) });
function definition(extra: object = {}, every: unknown = "manual") {
  return JSON.stringify({ id: "demo-study", name: "示例课题", repeat: { from: "plan", every }, stages: [
    { id: "plan", name: "定方向", by: { run: {} }, tools: ["propose_directions"] },
    { id: "try", name: "试验", by: { object: "trials" }, budget: { trials: 8, minutes: 240 }, ...extra },
    { id: "summary", name: "小结", by: { run: {} }, tools: ["read_ledger", "record_finding", "close_direction"] },
  ] });
}
async function setup(extra: object = {}, every: unknown = "manual") {
  const app = fixture(), item = upsertItem(app, undefined, { spaceId: "personal", title: "示例商城课题", kind: "watch" }, "user");
  saveFlow(app, definition(extra, every), "user"); await startFlow(app, item.id, "demo-study", owner);
  const s = (id: string) => getStage(app, item.id, id);
  const by = () => ({ actor: "assistant", userId: "owner", runId: s("plan").control.runId });
  return { app, item, s, by };
}
async function select(f: Awaited<ReturnType<typeof setup>>, n = 3) {
  await proposeDirections(f.app, { item: f.item.id, directions: [planned(n)] }, f.by());
  await answerAsk(f.app, f.s("plan").askId!, { choice: 0, text: "仅用测试样本", by: "owner" });
}
async function terminal(f: Awaited<ReturnType<typeof setup>>, status = "done", error: string | null = null) {
  const r = f.s("try").control.runId!;
  run(f.app.db, "update runs set status=?,finished_at=?,error=? where id=?", status, now(), error, r);
  await advance(f.app, f.item.id);
}
async function result(f: Awaited<ReturnType<typeof setup>>, value: "passed" | "failed" | "blocked" | "unclear" = "passed", unsure = false) {
  const s = f.s("try");
  await reportTrial(f.app, { trial: s.control.trialId!, result: value, summary: "按步骤执行，关键输出可复现", unsure }, { actor: "assistant", runId: s.control.runId!, userId: "owner" });
  await terminal(f);
}
async function summary(f: Awaited<ReturnType<typeof setup>>) {
  const r = f.s("summary").control.runId!;
  await reportStage(f.app, f.item.id, "summary", { state: "done", note: "本轮核验结束，没有新发现", evidence: [r] }, { actor: "assistant", userId: "owner", runId: r });
}
const ctx = (f: Awaited<ReturnType<typeof setup>>, id?: string): ToolContext => ({ app: f.app, runId: id ?? null, spaceId: "personal", spaces: ["personal"], writable: ["personal"], tools: null, actor: "agent", userId: "owner", role: "assistant" });

describe("课题定义与内置材料", () => {
  it("阶段只授 study 工具，trials 支持档位、时间、预算和人话", () => {
    const raw = definition({ ai: "cheap", at: "10:00", window: "23:00-06:00", escalate: { to: "strong", max: 2 }, tools: ["trial_report"] });
    const d = parseFlow(raw).stages[1];
    expect(d.by).toEqual({ object: "trials" });
    expect(describeStage(d)).toMatchObject({ carrier: "按确认的方向逐个去试", budget: "最多 8 个试验、最多跑 240 分钟" });
    expect(() => parseFlow(definition({ tools: ["write_page"] }))).toThrow("study");
    expect(() => parseFlow(definition({ tools: ["delegate_code"] }))).toThrow("study");
    expect(parseFlow(definition({ by: { object: "trials", agent: "assistant", skill: "study-trial" } })).stages[1].by).toMatchObject({ skill: "study-trial" });
  });
  it("内置流程能解析，四个技能补缺播种，用户改动保留", () => {
    const app = fixture(), root = resolve(".");
    expect(seedBuiltinFlows(app, root)).toContain("study");
    const f = parseFlow(readFileSync(join(root, "flows/library/study.yaml"), "utf8"));
    expect(f.repeat).toEqual({ from: "plan", every: "manual" }); expect(f.stages.map((s) => s.id)).toEqual(["map", "plan", "try", "summary", "fix"]);
    const added = seedBuiltinSkills(app, root);
    for (const n of ["study-map", "study-plan", "study-trial", "study-summary"]) { expect(added).toContain(n); expect(readSkill(app, n).body).toContain("# "); }
    const path = join(app.libraryDir, "_skills/study-map/SKILL.md"); writeFileSync(path, "---\nname: study-map\ndescription: 自定\n---\n自定内容\n");
    expect(seedBuiltinSkills(app, root)).toEqual([]); expect(readSkill(app, "study-map").body).toContain("自定内容");
  });
  it("梳理任务指定 write_file 工作文件，定方向只带覆盖次数日期和提交标题", async () => {
    const app = fixture(); seedBuiltinFlows(app, resolve("."));
    const item = upsertItem(app, undefined, { spaceId: "personal", title: "demo-cli 课题", kind: "watch" }, "user");
    await startFlow(app, item.id, "study", owner);
    const task = String(getRun(app, getStage(app, item.id, "map").by!).input.task);
    expect(task).toContain("write_file"); expect(task).toContain(capabilitiesPath(item.id)); expect(task).toContain("不要写 Wiki");
    const file = writeWorkFile(app, { spaceId: "personal", path: capabilitiesPath(item.id), text: "# 功能\n## 安装工具\n示例\n## 执行任务\n示例\n## 没弄清的\n无" });
    const [d] = saveProposals(app, { item: item.id, directions: [planned(1)] }, 1); confirmDirection(app, d.id, "");
    run(app.db, "update study_trials set object='安装工具：示例',state='reported',result='passed',summary='绝不能带进任务的旧结论' where direction_id=?", d.id);
    const c = coverage(app, item); expect(c.ref).toBe(`src:${file.id}`); expect(c.features[0]).toMatchObject({ title: "安装工具", trials: 1 }); expect(c.features[1].trials).toBe(0);
    const m = await planningMaterials(app, item); expect(m).toContain("粗略"); expect(m).toContain("试过 1 次"); expect(m).not.toContain("旧结论"); expect(m).not.toContain("passed");
    const repo = join(app.home, "demo-cli"); mkdirSync(repo); git(repo, ["init", "-q"]); git(repo, ["config", "user.name", "test"]); git(repo, ["config", "user.email", "test@example.com"]); git(repo, ["commit", "--allow-empty", "-qm", "增加任务入口"]);
    createSpace(app, { id: "demo-cli", name: "示例命令行", rootPath: repo, parentId: "personal" });
    expect(await planningMaterials(app, item)).toContain("增加任务入口");
  });
});

describe("提案对账与本人选择", () => {
  it("重复去掉并记以前的结果，同对象不同检查带 prior，不因通过删方向", async () => {
    const f = await setup();
    const [old] = saveProposals(f.app, { item: f.item.id, directions: [planned(1)] }, 1); confirmDirection(f.app, old.id, "");
    run(f.app.db, "update study_trials set state='reported',result='passed',summary=? where direction_id=?", "没有问题\n第二行不能进简短对账", old.id);
    await closeDirection(f.app, old.id, "done", "试完了");
    const proposal = planned(1); proposal.trials = [{ object: "  功能 1  ", check: "执行帮助命令 " }, { object: "功能 1", check: "检查异常参数" }];
    await proposeDirections(f.app, { item: f.item.id, directions: [proposal] }, f.by());
    const d = directions(f.app, f.item.id).find((d) => d.state === "proposed")!;
    expect(JSON.parse(d.removed)).toMatchObject([{ prior: "以前试过：passed、没有问题" }]);
    expect(JSON.parse(d.plan)).toMatchObject([{ check: "检查异常参数", prior: expect.stringContaining("passed") }]);
    expect(getAsk(f.app, f.s("plan").askId!).question).toContain("1 个以前做过并被去掉");
    expect(trials(f.app, f.item.id)).toHaveLength(1);
    await answerAsk(f.app, f.s("plan").askId!, { choice: 0, text: "只跑无网络用例", by: "owner" });
    expect(direction(f.app, d.id).note).toBe("只跑无网络用例");
    const t = trials(f.app, f.item.id).find((t) => t.direction_id === d.id)!;
    expect(t.prior).toContain("没有问题"); expect(getRun(f.app, t.run_id!).input.task).toContain("只跑无网络用例");
  });
  it("英文大小写、首尾与连续空白被规范化，但没有结果的旧试验不去掉", async () => {
    const f = await setup(); const p = planned(1); p.trials = [{ object: "Demo   CLI", check: " RUN Help " }];
    const [d] = saveProposals(f.app, { item: f.item.id, directions: [p] }, 1); confirmDirection(f.app, d.id, "");
    const next = planned(1); next.trials = [{ object: "demo cli", check: "run help" }];
    expect(JSON.parse(saveProposals(f.app, { item: f.item.id, directions: [next] }, 2)[0].plan)).toHaveLength(1);
    run(f.app.db, "update study_trials set result='passed',state='reported' where direction_id=?", d.id);
    expect(JSON.parse(saveProposals(f.app, { item: f.item.id, directions: [next] }, 2)[0].removed)).toHaveLength(1);
  });
  it("空提案也问本人，非本人回答在写答案前被拒；知道后跳过余下阶段", async () => {
    const f = await setup(); await proposeDirections(f.app, { item: f.item.id, directions: [], note: "暂时没有值得试的方向" }, f.by());
    const ask = getAsk(f.app, f.s("plan").askId!); expect(ask.question).toContain("这一轮没有提出方向"); expect(ask.options.map((x) => x.label)).toEqual(["知道了"]);
    await expect(answerAsk(f.app, ask.id, { choice: 0, by: "another" })).rejects.toThrow("本人"); expect(getAsk(f.app, ask.id).status).toBe("pending");
    await answerAsk(f.app, ask.id, { choice: 0, by: "owner" }); expect(f.s("try").state).toBe("skipped"); expect(f.s("summary").state).toBe("skipped"); expect(itemFlow(f.app, f.item.id)!.roundClosedAt).toBeTruthy();
  });
  it("选这一轮不跑不建立试验队列；自由文本不会代替选择", async () => {
    const f = await setup(); await proposeDirections(f.app, { item: f.item.id, directions: [planned()] }, f.by());
    await answerAsk(f.app, f.s("plan").askId!, { text: "再想一想", by: "owner" }); expect(f.s("plan").state).toBe("doing"); expect(trials(f.app, f.item.id)).toEqual([]);
    await answerAsk(f.app, f.s("plan").askId!, { choice: 1, by: "owner" }); expect(trials(f.app, f.item.id)).toEqual([]); expect(f.s("try").note).toContain("这一轮不跑");
  });
  it("不能靠 stage_report 绕过方向选择，不能从别的运行交提案", async () => {
    const f = await setup(); await expect(proposeDirections(f.app, { item: f.item.id, directions: [] }, { actor: "assistant", userId: "owner" })).rejects.toThrow("运行");
    await expect(reportStage(f.app, f.item.id, "plan", { state: "done", note: "直接开始", evidence: [f.by().runId!] }, f.by())).rejects.toThrow("不能用 stage_report");
  });
});

describe("试验运行与预算", () => {
  it("一次只跑一个；自己的运行交结果，不带其他试验结果", async () => {
    const f = await setup(); await select(f);
    expect(trials(f.app, f.item.id).map((t) => t.state)).toEqual(["running", "queued", "queued"]);
    const first = f.s("try").control.runId!;
    await Promise.all([advance(f.app, f.item.id), advance(f.app, f.item.id)]);
    expect(all(f.app.db, "select id from runs where kind='study-trial'")).toHaveLength(1);
    const denied = await callTool(ctx(f, f.by().runId), "trial_report", { trial: f.s("try").control.trialId, result: "passed", summary: "伪造" }); expect(denied.isError).toBe(true);
    await result(f); expect(trials(f.app, f.item.id).map((t) => t.state)).toEqual(["reported", "running", "queued"]);
    expect(getRun(f.app, f.s("try").control.runId!).input.task).not.toContain("关键输出可复现"); expect(f.s("try").control.runId).not.toBe(first);
    await result(f, "failed"); await result(f, "blocked"); expect(f.s("try").state).toBe("done"); expect(f.s("try").note).toContain("通过 1 个"); expect(directions(f.app, f.item.id)[0].state).toBe("active");
  });
  it("没有方向时直接完成，无模型运行", async () => {
    const app = fixture(), item = upsertItem(app, undefined, { title: "无方向", spaceId: "personal" }, "user");
    saveFlow(app, JSON.stringify({ id: "empty", name: "无试验", stages: [{ id: "try", name: "试验", by: { object: "trials" } }] }), "user"); await startFlow(app, item.id, "empty", owner);
    expect(getStage(app, item.id, "try").state).toBe("done"); expect(stageLog(app, item.id).some((l) => l.note === "没有要做的试验")).toBe(true); expect(all(app.db, "select id from runs")).toEqual([]);
  });
  it("没交结果记 unclear，正常完成不升档也不卡住", async () => {
    const f = await setup(); await select(f, 1); await terminal(f);
    expect(trials(f.app, f.item.id)[0]).toMatchObject({ state: "reported", result: "unclear", summary: "运行结束了，没有交结果" }); expect(f.s("try").state).toBe("done");
  });
  it("没交结果升档同一试验一次，每轮升档上限有效", async () => {
    const f = await setup({ ai: "cheap", escalate: { to: "strong", max: 1 } }); await select(f, 2);
    const id = f.s("try").control.trialId; await terminal(f);
    expect(f.s("try").control).toMatchObject({ trialId: id, trialEscalated: true, escalations: 1 }); expect(trial(f.app, id!).attempts).toBe(2);
    expect(getRun(f.app, f.s("try").by!).input.task).toContain("上一次的摘要或错误");
    await terminal(f); expect(trial(f.app, id!).result).toBe("unclear"); await terminal(f);
    expect(all(f.app.db, "select id from runs where kind='study-trial'")).toHaveLength(3); expect(f.s("try").state).toBe("done");
  });
  it("unclear + unsure 重做一次，已提交结果不被宿主误判未交", async () => {
    const f = await setup({ ai: "cheap", escalate: { to: "strong", max: 5 } }); await select(f, 1);
    const id = f.s("try").control.trialId!; await result(f, "unclear", true); expect(trial(f.app, id).attempts).toBe(2);
    await result(f, "unclear", true); expect(trial(f.app, id).attempts).toBe(2); expect(f.s("try").state).toBe("done"); expect(f.s("try").control.escalations).toBe(1);
  });
  it("后端失败只重试一次，再失败记 blocked", async () => {
    const f = await setup({ ai: "cheap", escalate: { to: "strong", max: 5 } }); await select(f, 1);
    const id = f.s("try").control.trialId!; await terminal(f, "failed", "后端断开"); expect(trial(f.app, id).attempts).toBe(2);
    await terminal(f, "failed", "后端仍不可用"); expect(trial(f.app, id)).toMatchObject({ result: "blocked", summary: "后端仍不可用", attempts: 2 }); expect(f.s("try").state).toBe("done");
  });
  it("试验数到上限完成本轮，下一轮跳过定方向并继续队列", async () => {
    const f = await setup({ budget: { trials: 1 } }); await select(f, 3); await result(f);
    expect(f.s("try")).toMatchObject({ state: "done", note: expect.stringContaining("到了这一轮的预算，还剩 2 个留到下一轮") }); await summary(f);
    const before = all(f.app.db, "select id from runs where kind='flow-stage'").length;
    await startRound(f.app, f.item.id, owner); expect(f.s("plan")).toMatchObject({ state: "skipped", note: "继续「逐项核验命令」：还剩 2 个试验" }); expect(trials(f.app, f.item.id).filter((t) => t.state === "running")).toHaveLength(1);
    expect(all(f.app.db, "select id from runs where kind='flow-stage'")).toHaveLength(before);
  });
  it("分钟累计用满完成，不把剩下的标成 skipped", async () => {
    const f = await setup({ budget: { minutes: 1 } }); await select(f, 3);
    const id = f.s("try").control.runId!;
    const controller = new AbortController(), untrack = trackAbort(id, controller);
    run(f.app.db, "update runs set status='running',started_at=? where id=?", new Date(Date.now() - 120000).toISOString(), id);
    await flowReminders(f.app); expect(f.s("try").state).toBe("done"); expect(f.s("try").control.usedMinutes).toBeGreaterThanOrEqual(1); expect(trials(f.app, f.item.id).filter((t) => t.state === "queued")).toHaveLength(2); expect(controller.signal.aborted).toBe(true); untrack();
  });
  it("分钟按多次运行累计，排队不计；重试也受分钟预算约束", async () => {
    const f = await setup({ budget: { minutes: 1 }, ai: "cheap", escalate: { to: "strong", max: 2 } }); await select(f, 2);
    const r = f.s("try").control.runId!; run(f.app.db, "update runs set started_at=?,finished_at=?,status='done' where id=?", new Date(Date.now() - 61000).toISOString(), now(), r);
    await advance(f.app, f.item.id); expect(f.s("try").state).toBe("done"); expect(trials(f.app, f.item.id).filter((t) => t.state === "queued")).toHaveLength(1); expect(trials(f.app, f.item.id)[0].result).toBe("unclear");
  });
  it("窗口外不开下一个，正在运行的让它做完", async () => {
    const f = await setup(); await select(f, 2);
    const raw = itemFlow(f.app, f.item.id)!; raw.definition.stages[1].window = "01:00-02:00"; run(f.app.db, "update item_flows set definition=? where item_id=?", JSON.stringify(raw.definition), f.item.id);
    const at = new Date("2026-12-01T03:00:00Z"); f.app.config.timezone = "UTC";
    await flowReminders(f.app, at); expect(getRun(f.app, f.s("try").by!).status).toBe("queued");
    const id = f.s("try").by!; run(f.app.db, "update runs set status='done',finished_at=? where id=?", now(), id);
    await flowReminders(f.app, at); expect(trials(f.app, f.item.id).filter((t) => t.state === "queued")).toHaveLength(1); expect(f.s("try").waitingOn).toBe("time");
    await flowReminders(f.app, new Date("2026-12-02T01:30:00Z")); expect(trials(f.app, f.item.id).filter((t) => t.state === "running")).toHaveLength(1);
  });
  it("停止流程取消当前试验，队列保留且旧运行不能再交", async () => {
    const f = await setup(); await select(f, 2); const id = f.s("try").by!, t = f.s("try").control.trialId!;
    await stopFlow(f.app, f.item.id); expect(getRun(f.app, id).status).toBe("cancelled"); expect(trials(f.app, f.item.id).map((t) => t.state)).toEqual(["queued", "queued"]);
    await expect(reportTrial(f.app, { trial: t, result: "passed", summary: "迟到的结果" }, { actor: "assistant", runId: id, userId: "owner" })).rejects.toThrow();
  });
  it("运行结束事件接着排下一个，不另起轮询器", async () => {
    const f = await setup(); await select(f, 2); const id = f.s("try").by!;
    run(f.app.db, "update runs set status='done',finished_at=? where id=?", now(), id);
    f.app.emit({ type: "run", runId: id, status: "done" });
    await vi.waitFor(() => expect(f.s("try").by).not.toBe(id));
    expect(trials(f.app, f.item.id).map((t) => t.state)).toEqual(["reported", "running"]);
  });
  it("重开试验阶段或本人手动跳过时，取消旧运行并把未做的保留在队列", async () => {
    const f = await setup(); await select(f, 2); const old = f.s("try").by!;
    await reopenStage(f.app, f.item.id, "try", "换一个测试环境", [], owner);
    expect(getRun(f.app, old).status).toBe("cancelled"); expect(trials(f.app, f.item.id).map((t) => t.state)).toEqual(["running", "queued"]); expect(f.s("try").by).not.toBe(old);
    const current = f.s("try").by!; await ownerAction(f.app, f.item.id, "try", "skip", "本轮先停下");
    expect(getRun(f.app, current).status).toBe("cancelled"); expect(trials(f.app, f.item.id).every((t) => t.state === "queued")).toBe(true);
  });
  it("零个试验预算直接完成并保留队列", async () => {
    const f = await setup({ budget: { trials: 0 } }); await select(f, 2);
    expect(f.s("try").state).toBe("done"); expect(f.s("try").note).toBe("做了 0 个；到了这一轮的预算，还剩 2 个留到下一轮"); expect(trials(f.app, f.item.id).every((t) => t.state === "queued")).toBe(true);
  });
  it("额度等待不换后端，恢复后继续同一试验", async () => {
    const f = await setup({ ai: { profile: "study-ai", model: "sample" } });
    const profile = agentProfileSchema.parse({ id: "study-ai", transport: "acp", command: "node", model: "sample" });
    f.app.config.agents.profiles.push(profile);
    await select(f, 1); const id = f.s("try").by!;
    const { markOutOfQuota } = await import("../src/agents/capacity.ts");
    markOutOfQuota(f.app, profile, "usage limit; try again tomorrow");
    await terminal(f, "failed", "额度用完"); expect(f.s("try").waitingOn).toBe("time"); expect(trials(f.app, f.item.id)[0].state).toBe("queued");
    expect(all(f.app.db, "select id from runs where kind='study-trial'")).toHaveLength(1); expect(getRun(f.app, id).input.execution).toMatchObject({ profile: "study-ai" });
    await flowReminders(f.app, new Date(Date.parse(f.s("try").control.waitUntil!) + 1));
    expect(f.s("try").by).not.toBe(id); expect(getRun(f.app, f.s("try").by!).input.execution).toMatchObject({ profile: "study-ai", model: "sample" });
  });
  it("worker 真正执行前重查窗口；带阶段 AI、技能、试验交结果工具和产物目录", async () => {
    const f = await setup({ by: { object: "trials", agent: "assistant", skill: "study-trial" }, ai: "cheap" });
    seedBuiltinSkills(f.app, resolve("."));
    f.app.config.agents.profiles.push(agentProfileSchema.parse({ id: "trial-ai", command: "node", transport: "acp", model: "small" }));
    f.app.config.agents.tiers.cheap = { profile: "trial-ai", model: "small", effort: "low" };
    await select(f, 1); const old = getRun(f.app, f.s("try").by!);
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (app, input) => {
      expect(input.execution).toMatchObject({ profile: "trial-ai", model: "small", source: "flow" });
      expect(input.addTools).toEqual(["trial_report", "attach_artifact"]); expect(input.artifacts).toBe(true);
      expect(input.task).toContain("# 做一个试验"); expect(input.task).toContain("仅用测试样本");
      const report = await callTool(ctx(f, input.runId!), "trial_report", { trial: f.s("try").control.trialId, result: "passed", summary: "假运行已按步骤检查" });
      expect(report.isError).toBe(false);
      return { text: "已交", profileId: "trial-ai", ai: { profile: "trial-ai" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    await __testHandlers.get("study-trial")!({ app: f.app, run: old, signal: new AbortController().signal, event() {}, output() {} });
    expect(fake).toHaveBeenCalledOnce(); expect(trials(f.app, f.item.id)[0].result).toBe("passed"); await terminal(f); expect(f.s("try").state).toBe("done");
  });
  it("分钟用满的同时遇到额度错误仍完成本轮，不停在等待额度", async () => {
    const f = await setup({ ai: { profile: "study-ai", model: "sample" }, budget: { minutes: 1 } });
    const profile = agentProfileSchema.parse({ id: "study-ai", transport: "acp", command: "node", model: "sample" }); f.app.config.agents.profiles.push(profile);
    await select(f, 2); const id = f.s("try").by!;
    run(f.app.db, "update runs set started_at=? where id=?", new Date(Date.now() - 120000).toISOString(), id);
    (await import("../src/agents/capacity.ts")).markOutOfQuota(f.app, profile, "usage limit; try again tomorrow");
    await terminal(f, "failed", "usage limit reached");
    expect(f.s("try").state).toBe("done"); expect(trials(f.app, f.item.id).map((t) => t.state)).toEqual(["reported", "queued"]);
  });
  it("worker 排队后窗口关闭或额度变化时放回队列，不调用模型", async () => {
    const f = await setup(); await select(f, 1); const old = getRun(f.app, f.s("try").by!);
    const flow = itemFlow(f.app, f.item.id)!, hour = new Date().getUTCHours(); f.app.config.timezone = "UTC";
    const begin = (hour + 2) % 24, end = (hour + 3) % 24;
    flow.definition.stages[1].window = `${String(begin).padStart(2, "0")}:00-${String(end).padStart(2, "0")}:00`;
    run(f.app.db, "update item_flows set definition=? where item_id=?", JSON.stringify(flow.definition), f.item.id);
    const fake = vi.spyOn(runner, "runRole");
    await __testHandlers.get("study-trial")!({ app: f.app, run: old, signal: new AbortController().signal, event() {}, output() {} });
    expect(fake).not.toHaveBeenCalled(); expect(trials(f.app, f.item.id)[0]).toMatchObject({ state: "queued", attempts: 0 }); expect(f.s("try").control.runId).toBeUndefined();
  });
  it("定方向 worker 移除台账与历史运行工具；附加工具只从阶段副本读取", async () => {
    const f = await setup(), old = getRun(f.app, f.s("plan").by!);
    const flow = itemFlow(f.app, f.item.id)!; flow.definition.stages[0].tools!.push("read_ledger"); run(f.app.db, "update item_flows set definition=? where item_id=?", JSON.stringify(flow.definition), f.item.id);
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (_app, input) => {
      expect(input.addTools).toContain("propose_directions"); expect(input.addTools).not.toContain("read_ledger");
      expect(input.denyTools).toContain("read_ledger"); expect(input.denyTools).toContain("read_item"); expect(input.task).toContain("覆盖情况");
      return { text: "没有方向", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    await __testHandlers.get("flow-stage")!({ app: f.app, run: old, signal: new AbortController().signal, event() {}, output() {} }); expect(fake).toHaveBeenCalledOnce();
  });
});

describe("台账、发现、证据和权限", () => {
  it("coach 不属于流程阶段，可读本次可读空间的台账，不能越过空间范围", async () => {
    const f = await setup(); await select(f, 1); await result(f, "unclear");
    const finding = recordFinding(f.app, { item: f.item.id, kind: "defect", title: "退款出口未检查", repro: "虚构样本中的复现步骤", trials: [trials(f.app, f.item.id)[0].id] });
    run(f.app.db, "update study_findings set state='rejected',state_reason='测试夹具缺少前置条件' where id=?", finding);
    const coach = createRun(f.app, { kind: "profile-review", title: "复盘课题技能", spaceId: "personal", input: { target: "assistant" } });
    const tools = runner.loadRole("coach", f.app).tools;
    expect(tools).toContain("read_ledger");
    const context: ToolContext = { ...ctx(f, coach.id), role: "coach", tools: new Set(tools) };
    const ledger = await callTool(context, "read_ledger", { item: f.item.id });
    expect(ledger.text).toContain("unclear"); expect(ledger.text).toContain("rejected"); expect(ledger.text).toContain("测试夹具缺少前置条件");
    expect(one<{ state: string }>(f.app.db, "select state from study_findings where id=?", finding)?.state).toBe("rejected");
    const other = createSpace(f.app, { name: "另一个课题空间" });
    const hidden = upsertItem(f.app, undefined, { spaceId: other.id, title: "不可读课题", kind: "watch" }, "user");
    const denied = await callTool(context, "read_ledger", { item: hidden.id });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("不能访问");
    const member = createUser(f.app, { name: "示例成员" }); addMember(f.app, other.id, member.id);
    expect((await callTool({ ...context, userId: member.id, spaces: null }, "read_ledger", { item: f.item.id })).isError).toBe(true);
  });
  it("定方向即使误授 read_ledger 也拒绝；小结可读", async () => {
    const f = await setup(); const r = f.s("plan").by!;
    expect((await callTool(ctx(f, r), "read_ledger", { item: f.item.id })).isError).toBe(true);
    expect(() => readLedger(f.app, { item: f.item.id }, r)).toThrow("定方向");
    await select(f, 1); await result(f); expect((await callTool(ctx(f, f.s("summary").by!), "read_ledger", { item: f.item.id, round: 1 })).text).toContain("passed");
  });
  it("产物入库，候选发现不自动成为正式发现，视图带试验依据", async () => {
    const f = await setup(); await select(f, 1); const r = f.s("try").by!, t = f.s("try").control.trialId!;
    const path = join(artifactInbox(f.app, r), "failure.log"); writeFileSync(path, "demo-cli --bad\nexpected: exit 1\nactual: exit 0");
    await reportTrial(f.app, { trial: t, result: "failed", summary: "异常参数返回成功", evidence: [path], findings: [{ kind: "defect", title: "异常参数返回成功", repro: "执行 demo-cli --bad，预期 1，实际 0" }] }, { actor: "assistant", runId: r, userId: "owner" });
    expect(findings(f.app, f.item.id)).toEqual([]); expect(JSON.parse(trial(f.app, t).evidence)[0]).toMatch(/^af/); await terminal(f);
    const id = recordFinding(f.app, { item: f.item.id, kind: "defect", title: "异常参数返回成功", repro: "执行 demo-cli --bad，预期 1，实际 0", trials: [t] });
    const v = studyView(f.app, f.item.id); expect(v.trials[0].artifacts).toHaveLength(1); expect(v.findings[0]).toMatchObject({ id, trials: [{ id: t, result: "failed", artifacts: [{ kind: "text" }] }] });
  });
  it("发现相近需明确区分，same_as 只合并依据；不能拿无结果或其他课题作依据", async () => {
    const f = await setup(); await select(f, 3); await result(f, "failed"); const t = trials(f.app, f.item.id);
    const input = { item: f.item.id, kind: "defect" as const, title: "帮助命令输出错误", repro: "运行 demo-cli help，预期显示帮助，实际为空", trials: [t[0].id] };
    const id = recordFinding(f.app, input); expect(() => recordFinding(f.app, { ...input, title: "帮助命令输出错误内容" })).toThrow(id);
    expect(() => recordFinding(f.app, { ...input, trials: [t[1].id] })).toThrow("有结果");
    await result(f, "failed"); expect(recordFinding(f.app, { ...input, trials: [t[1].id], same_as: id })).toBe(id); expect(JSON.parse(findings(f.app, f.item.id)[0].trials)).toEqual([t[0].id, t[1].id]);
    const second = recordFinding(f.app, { ...input, title: "帮助命令输出错误内容", distinct_from: [id] }); expect(second).not.toBe(id);
    const other = upsertItem(f.app, undefined, { title: "另一个课题", spaceId: "personal" }, "user"); expect(() => recordFinding(f.app, { ...input, item: other.id })).toThrow("本课题");
  });
  it("结束或放弃必须写结论，未做的跳过", async () => {
    const f = await setup({ budget: { trials: 1 } }); await select(f, 3); await result(f);
    const d = directions(f.app, f.item.id)[0]; await expect(closeDirection(f.app, d.id, "done", "")).rejects.toThrow("结论");
    await closeDirection(f.app, d.id, "dropped", "范围已足够，不再做剩下的"); expect(trials(f.app, f.item.id).map((t) => t.state)).toEqual(["reported", "skipped", "skipped"]); expect(direction(f.app, d.id).conclusion).toContain("范围");
  });
  it("本人关闭进行中的方向取消运行并跳过余下试验", async () => {
    const f = await setup(); await select(f, 2); const r = f.s("try").by!, d = directions(f.app, f.item.id)[0];
    const reply = await callTool(ctx(f, f.s("summary").by ?? undefined), "close_direction", { direction: d.id, state: "dropped", conclusion: "不再继续" });
    expect(reply.isError).toBe(false); expect(getRun(f.app, r).status).toBe("cancelled"); expect(trials(f.app, f.item.id).every((t) => t.state === "skipped")).toBe(true); expect(f.s("try").state).toBe("done");
  });
  it("写工具校验主人、空间和只读边界", async () => {
    const f = await setup(); await select(f, 1);
    const d = directions(f.app, f.item.id)[0].id;
    for (const patch of [{ userId: "another" }, { spaces: [] }, { writable: [] }]) {
      expect((await callTool({ ...ctx(f), ...patch }, "close_direction", { direction: d, state: "done", conclusion: "完成" })).isError).toBe(true);
    }
  });
  it("HTTP 按空间可读，写限本人，发现否决仅改这一条", async () => {
    const f = await setup({ budget: { trials: 1 } }); await select(f, 2); await result(f, "failed");
    const t = trials(f.app, f.item.id)[0], d = direction(f.app, t.direction_id);
    const finding = recordFinding(f.app, { item: f.item.id, kind: "defect", title: "错误参数仍成功", repro: "demo-cli --bad 退出 0", trials: [t.id] });
    const server = await startServer(f.app, { port: 0, quiet: true }); servers.push(server); const url = `/api/items/${f.item.id}/study`;
    createUser(f.app, { id: "reader-study", name: "成员甲" }); const headers = { authorization: `Bearer ${createApiToken(f.app, "reader-study")}` };
    expect((await server.inject({ url, headers })).statusCode).toBe(404); addMember(f.app, "personal", "reader-study", "editor"); expect((await server.inject({ url, headers })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: `${url}/findings/${finding}`, headers, payload: { state: "rejected" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: `${url}/findings/${finding}`, payload: { state: "rejected", reason: "这是预期行为" } })).json().findings[0]).toMatchObject({ state: "rejected", stateReason: "这是预期行为" });
    expect((await server.inject({ method: "POST", url: `${url}/directions/${d.id}/close`, payload: { state: "done", conclusion: "验收完成" } })).json().directions[0].state).toBe("done");
  });
});

describe("没有新发现的轮次", () => {
  it("新建发现打断计数，same_as 合并依据不会冒充这一轮的新发现", async () => {
    const f = await setup({ budget: { trials: 1 } }); await select(f, 3); await result(f, "failed");
    const first = trials(f.app, f.item.id)[0];
    const input = { item: f.item.id, kind: "defect" as const, title: "异常参数返回成功", repro: "执行 demo-cli --bad，期望 1 实际 0", trials: [first.id] };
    const id = recordFinding(f.app, input); await summary(f); expect(idleRounds(f.app, f.item.id)).toBe(0);
    await startRound(f.app, f.item.id, owner); await result(f, "failed");
    const second = trials(f.app, f.item.id)[1]; recordFinding(f.app, { ...input, trials: [second.id], same_as: id }); await summary(f); expect(idleRounds(f.app, f.item.id)).toBe(1);
    await startRound(f.app, f.item.id, owner); await result(f, "failed");
    recordFinding(f.app, { ...input, title: "配置文件编码损坏", repro: "读取示例配置，实际乱码", trials: [trials(f.app, f.item.id)[2].id] }); await summary(f); expect(idleRounds(f.app, f.item.id)).toBe(0);
  });
  it("manual 只显示计数不通知，正式新发现打断连续计数", async () => {
    const f = await setup();
    for (let n = 0; n < 3; n++) {
      if (n) await startRound(f.app, f.item.id, owner);
      await proposeDirections(f.app, { item: f.item.id, directions: [] }, f.by()); await answerAsk(f.app, f.s("plan").askId!, { choice: 0, by: "owner" });
      expect(flowView(f.app, f.item.id).flow!.idleRounds).toBe(n + 1);
    }
    expect(all(f.app.db, "select id from notifications where title like '连着 %'")).toEqual([]);
    expect(idleRounds(f.app, f.item.id)).toBe(3);
  });
  it("非 manual 三轮无发现停止自动开轮，只通知一次", async () => {
    const f = await setup({}, "done");
    for (let n = 0; n < 3; n++) { await proposeDirections(f.app, { item: f.item.id, directions: [], note: "没有合适方向" }, f.by()); await answerAsk(f.app, f.s("plan").askId!, { choice: 0, by: "owner" }); }
    expect(itemFlow(f.app, f.item.id)).toMatchObject({ round: 3, nextRoundAt: null }); expect(flowView(f.app, f.item.id).flow!.idleRounds).toBe(3);
    await flowReminders(f.app); await flowReminders(f.app); expect(all(f.app.db, "select json_extract(context,'$.urgency') urgency from notifications where title='连着 3 轮没有新发现'")).toEqual([{ urgency: "later" }]);
  });
});

describe("台账随事项拉取", () => {
  it("三表合并并更新，check 与 JSON 里的原件引用映射到本机", async () => {
    const local = fixture(), remote = fixture();
    const a = appendToSource(local, { spaceId: "personal", kind: "chat", uri: "chat:study", title: "示例讨论", lines: ["共同消息", "本机消息"] });
    const b = appendToSource(remote, { spaceId: "personal", kind: "chat", uri: "chat:study", title: "示例讨论", lines: ["共同消息", "远端消息"] });
    const item = upsertItem(remote, undefined, { title: "台账拉取", spaceId: "personal" }, "user");
    const p = planned(1); p.trials[0].check = `读 src:${b.id}#L2`;
    const [d] = saveProposals(remote, { item: item.id, directions: [p] }, 1); confirmDirection(remote, d.id, "只读材料");
    putScope(remote, item.id, { repos: [], allowCode: true, thirdParty: true }, "owner");
    run(remote.db, "update study_directions set workspace_run_id='remote-holder',third_party=1,allow_code=1 where id=?", d.id);
    const t = trials(remote, item.id)[0]; run(remote.db, "update study_trials set result='failed',state='reported',evidence=? where id=?", JSON.stringify([`src:${b.id}#L2`]), t.id);
    const finding = recordFinding(remote, { item: item.id, kind: "defect", title: "内容遗漏", repro: `核对 src:${b.id}#L2`, trials: [t.id] });
    run(remote.db, "update study_scopes set push_remote='origin',push_prefix='study/' where item_id=?", item.id);
    run(remote.db, `insert into study_trials(id,item_id,direction_id,round,seq,object,"check",env,state,result,fix_of,work_id,created_at,updated_at)
      values('st-rerun',?,?,1,2,'复现对象','复现检查','local','reported','passed',?,'run-fix',?,?)`, item.id, d.id, finding, now(), now());
    run(remote.db, `insert into study_pushes(id,item_id,trial_id,repo,remote,branch,"commit",note,run_id,round,flow_started_at,at)
      values('sp-test',?,'st-rerun','repo-example','origin','study/demo/check','abcdef','验证推送','run-fix',1,'demo',?)`, item.id, now());
    async function pull() {
      const dir = join(local.home, `snapshot-${Math.random().toString(36).slice(2)}`); mkdirSync(dir);
      const archive = join(dir, "snapshot.tar"); await pipeline(await snapshotStream(remote), createWriteStream(archive)); execFileSync("tar", ["-xf", "snapshot.tar"], { cwd: dir });
      const f: Fetched = { dbDir: dir, libraryDir: join(dir, "library"), filesDir: join(dir, "files"), fetchedFiles: readdirSync(join(dir, "files")) };
      try { mergeLibrary(local, f); } finally { cleanupFetched(f); }
    }
    await pull(); expect(trial(local, t.id).check).toBe(`读 src:${a.id}#L3`); expect(JSON.parse(trial(local, t.id).evidence)).toEqual([`src:${a.id}#L3`]); expect(direction(local, d.id).note).toBe("只读材料"); expect(findings(local, item.id)[0].id).toBe(finding);
    expect(scopeView(local, item.id)).toMatchObject({ repos: [], allowCode: true, thirdParty: true });
    expect(scopeView(local, item.id)).toMatchObject({ pushRemote: "origin", pushPrefix: "study/" });
    expect(trial(local, "st-rerun")).toMatchObject({ fix_of: finding, work_id: "run-fix", result: "passed" });
    expect(studyView(local, item.id).pushes).toMatchObject([{ id: "sp-test", trialId: "st-rerun", remote: "origin", commit: "abcdef" }]);
    expect(direction(local, d.id)).toMatchObject({ third_party: 1, allow_code: 1, workspace_run_id: null });
    run(remote.db, "update study_findings set state='confirmed',updated_at='2099-01-01' where id=?", finding); await pull(); expect(findings(local, item.id)[0].state).toBe("confirmed");
  });
});

describe("真实跑过一轮以后改的", () => {
  it("选了新方向以后，试验都跑完却没写结论的旧方向就此结束", async () => {
    const f = await setup(); await select(f, 1); await result(f, "passed"); await summary(f);
    const first = directions(f.app, f.item.id).find((d) => ["confirmed", "active"].includes(d.state))!;
    await startRound(f.app, f.item.id, owner);
    // Nothing is queued any more, so the planning stage proposes again and the owner picks a new direction.
    await proposeDirections(f.app, { item: f.item.id, directions: [{ ...planned(1), goal: "换一个功能区再看" }] }, f.by());
    await answerAsk(f.app, f.s("plan").askId!, { choice: 0, by: "owner" });
    const all = directions(f.app, f.item.id);
    expect(all.find((d) => d.id === first.id)).toMatchObject({ state: "done", conclusion: expect.stringContaining("本人选了新的方向") });
    expect(all.filter((d) => ["confirmed", "active"].includes(d.state)).map((d) => d.goal)).toEqual(["换一个功能区再看"]);
  });
  it("跑不了的试验不算试过：下一次提案里照样排上，并带上上次为什么没跑成", () => {
    const tried = (result: Trial["result"]) => [{ object: "CSV 导出", check: "逗号和引号的转义", result, summary: "工作区里没有可用的解析器" } as Trial];
    const plan = [{ object: "CSV 导出", check: "逗号和引号的转义" }];
    const blocked = reconcile(plan, tried("blocked"));
    expect(blocked.removed).toEqual([]);
    expect(blocked.kept[0].prior).toContain("工作区里没有可用的解析器");
    expect(reconcile(plan, tried("failed")).removed).toHaveLength(1);
    expect(reconcile(plan, tried("passed")).removed).toHaveLength(1);
  });
});
