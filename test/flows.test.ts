import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { saveRole } from "../src/auth/permissions.ts";
import { decide, decisionReady } from "../src/core/decision.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createUser } from "../src/core/users.ts";
import { ensureLibraryRepo } from "../src/core/git.ts";
import { answerAsk, createAsk, getAsk } from "../src/agents/asks.ts";
import { createRun, getRun, setRunOutput, __testHandlers } from "../src/agents/runs.ts";
import * as runner from "../src/agents/runner.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { addLocalMaterials } from "../src/items/materials.ts";
import { itemEvents, upsertItem } from "../src/items/store.ts";
import { createDesign, decideDesign, setDesignStatus } from "../src/designs/store.ts";
import { flowSchema, flowsFor, listFlows, parseFlow, readFlow, removeFlow, saveFlow, seedBuiltinFlows } from "../src/flows/definitions.ts";
import { advance, flowReminders, flowStageCards, flowView, ownerAction, proposeFlow, reopenStage, reportStage, startFlow, stopFlow } from "../src/flows/engine.ts";
import { changeStage, getStage, itemFlow, stageLog } from "../src/flows/store.ts";
import { artifactInbox, collectInbox } from "../src/agents/artifacts.ts";
import { recordTests } from "../src/items/req-tests.ts";
import { findObject } from "../src/flows/objects.ts";
import { addTask, updateTask } from "../src/agents/code-tasks.ts";
import { addCodeNote, markNotesDelivered } from "../src/agents/code-steer.ts";

vi.mock("../src/core/decision.ts", async (original) => ({ ...await original<typeof import("../src/core/decision.ts")>(), decisionReady: vi.fn(() => false), decide: vi.fn() }));
const apps: App[] = [];
const owner = { actor: "owner", userId: "owner" };
const appFor = () => { const app = testApp(); apps.push(app); return app; };
const yaml = (stages: object[], rest = {}) => YAML.stringify({ id: "demo", name: "示例交付", ...rest, stages });
const stage = (id: string, extra = {}) => ({ id, name: id, by: { run: {} }, ...extra });
async function setup(stages: object[], opts: { autoAdvance?: number } = {}) {
  const app = appFor();
  if (opts.autoAdvance) app.config.flows.autoAdvance = opts.autoAdvance;
  const item = upsertItem(app, undefined, { title: "示例商城退款", detail: "按行退款", dueAt: "2026-12-01", spaceId: "personal" }, "user");
  saveFlow(app, yaml(stages), "user");
  await startFlow(app, item.id, "demo", owner);
  return { app, item, s: (id: string) => getStage(app, item.id, id) };
}
async function done(app: App, itemId: string, id: string) {
  const s = getStage(app, itemId, id);
  const r = (s.by === s.control.runId && !!s.by) ? s.by : createRun(app, { kind: "agent", spaceId: "personal", title: "验证依据" }).id;
  return reportStage(app, itemId, id, { state: "done", note: "已验证", evidence: [r] }, { actor: "assistant", ...((s.by === s.control.runId && !!s.by) ? { runId: r } : {}) });
}
function oldOwnerAsk(app: App, itemId: string, stageId: string) {
  const ask = createAsk(app, { runId: null, userId: "owner", question: "轮到你了。做完点‘做完了’。", options: [{ label: "做完了" }, { label: "这一段跳过" }],
    context: { handler: "flow-stage", itemId, stageId, startedAt: itemFlow(app, itemId)!.startedAt, kind: "owner" } });
  const s = getStage(app, itemId, stageId);
  changeStage(app, itemId, stageId, s.state, { askId: ask.id, control: { ...s.control, question: "owner" } }, { actor: "host" }, s.note);
  return ask;
}
beforeEach(() => { vi.mocked(decisionReady).mockReturnValue(false); vi.mocked(decide).mockReset(); });
afterEach(async () => {
  vi.restoreAllMocks();
  // Drain asynchronous ask display/event callbacks before removing their temporary libraries.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

describe("流程定义", () => {
  it("填默认前提，允许显式并行，拒绝向后或循环前提及重复 id", () => {
    const f = parseFlow(yaml([stage("a"), stage("b"), stage("c", { needs: [] })]));
    expect(f.stages.map((s) => s.needs)).toEqual([[], ["a"], []]);
    expect(f.stages[0]).toMatchObject({ gate: "auto", fixed: false });
    expect(() => parseFlow(yaml([stage("a", { needs: ["b"] }), stage("b")]))).toThrow("更早");
    expect(() => parseFlow(yaml([stage("a"), stage("a")]))).toThrow("不能重复");
    expect(() => parseFlow(yaml([]))).toThrow("至少");
    expect(() => parseFlow(yaml(Array.from({ length: 21 }, (_, i) => stage(`s${i}`))))).toThrow("最多");
  });
  it("拒绝未知承担者、person、run 信号与插件对象，并给出原因", () => {
    for (const by of [{ person: "某人" }, { object: "pipeline" }, "unknown"]) expect(() => parseFlow(yaml([stage("a", { by })]))).toThrow("后续阶段");
    expect(() => parseFlow(yaml([stage("a", { done: { signal: "git.pushed" } })]))).toThrow("owner 或 wait");
    expect(() => parseFlow(yaml([stage("a", { done: { object: "deployment", status: "succeeded" } })]))).toThrow("后续阶段");
    expect(() => parseFlow(yaml([stage("a")], { for: { kinds: ["task"] } }))).toThrow("todo");
    expect(() => parseFlow(yaml([stage("a", { note: "长".repeat(1001) })]))).toThrow("1000");
  });
  it("按类型与空间选流程，保留无效文件的问题和原文", () => {
    const app = appFor();
    saveFlow(app, yaml([stage("a")], { for: { kinds: ["todo"], spaces: ["personal"] } }), "user");
    expect(flowsFor(app, { kind: "todo", spaceId: "personal" })).toHaveLength(1);
    expect(flowsFor(app, { kind: "waiting", spaceId: "personal" })).toEqual([]);
    expect(flowsFor(app, { kind: "todo", spaceId: "other" })).toEqual([]);
    writeFileSync(join(app.libraryDir, "_flows", "broken.yaml"), "stages: [");
    expect(listFlows(app).find((f) => f.id === "broken")).toMatchObject({ raw: "stages: [", definition: null, problem: expect.stringContaining("YAML") });
    expect(() => readFlow(app, "../demo")).toThrow("不合法");
    removeFlow(app, "demo");
    expect(() => readFlow(app, "demo")).toThrow("没有流程");
  });
  it("内置文件只补缺，缺目录与空目录均可启动", () => {
    const app = appFor(), root = join(app.home, "package"), dir = join(root, "flows", "library");
    expect(seedBuiltinFlows(app, root)).toEqual([]);
    mkdirSync(dir, { recursive: true });
    expect(seedBuiltinFlows(app, root)).toEqual([]);
    writeFileSync(join(dir, "demo.yaml"), yaml([stage("a")]));
    expect(seedBuiltinFlows(app, root)).toEqual(["demo"]);
    const own = yaml([stage("owner", { by: "owner" })]);
    saveFlow(app, own, "user");
    expect(seedBuiltinFlows(app, root)).toEqual([]);
    expect(readFileSync(join(app.libraryDir, "_flows", "demo.yaml"), "utf8")).toBe(own);
  });
  it("旧配置得到独立默认值", () => {
    const a = appFor(), b = appFor();
    a.config.flows.autoAdvance = 9;
    expect(b.config.flows).toEqual({ commits: { enabled: true, quietMinutes: 30 }, autoAdvance: 3, staleDays: 2, idleRounds: 3, gateLadder: { enabled: true, after: 5 }, follow: { enabled: true, quietMinutes: 20, maxMessages: 30, maxRunsPerDay: 12 } });
    expect(flowSchema.safeParse({ id: "demo", name: "示例", stages: [stage("a")] }).success).toBe(true);
  });
});

describe("阶段推进", () => {
  it("阶段的任务只带事项的摘要：说明过长截断、材料只列最近的十几份，其余提示用 read_item 看", async () => {
    const app = appFor();
    const item = upsertItem(app, undefined, { title: "示例商城退款", detail: `最新：按行退款已提测。${"很早以前的过程记录。".repeat(600)}`, spaceId: "personal" }, "user");
    const runs = Array.from({ length: 20 }, (_, i) => createRun(app, { kind: "agent", spaceId: "personal", title: `第 ${i + 1} 次交办` }).id);
    addLocalMaterials(app, item.id, runs.map((ref) => ({ kind: "run" as const, ref })), item.userId);
    saveFlow(app, yaml([stage("a")]), "user");
    await startFlow(app, item.id, "demo", owner);
    const task = getRun(app, getStage(app, item.id, "a").by!).input.task as string;
    expect(task).toContain("最新：按行退款已提测");
    expect(task).toContain("完整的用 read_item 看");
    expect(task).toContain("第 20 次交办");
    expect(task).not.toContain("第 1 次交办");
    expect(task).toContain("另有 8 份较早的材料");
    expect(task.length).toBeLessThan(4000);
  });
  it("顺序推进，定义复制，任务复用事项材料并注明技能、完成工具与触发方式", async () => {
    const { app, item, s } = await setup([stage("a", { note: "调查需求。保留依据", by: { run: { skill: "demo-skill" } } }), stage("b"), stage("c", { by: "owner" })]);
    expect(s("a")).toMatchObject({ state: "doing", attempt: 1 });
    expect(s("b").state).toBe("pending");
    const r = getRun(app, s("a").by!);
    expect(r).toMatchObject({ kind: "flow-stage", trigger: { via: "flow", source: { kind: "flow", id: "demo" } }, input: { skill: "demo-skill", itemId: item.id } });
    expect(r.input.task).toContain("所属事项"); expect(r.input.task).toContain("stage_report"); expect(r.input.task).toContain("2026-12-01");
    saveFlow(app, yaml([stage("new")]), "user");
    expect(itemFlow(app, item.id)!.definition.stages[0].id).toBe("a");
    await expect(startFlow(app, item.id, "demo", owner)).rejects.toThrow("已经");
    await done(app, item.id, "a"); expect(s("b").state).toBe("doing");
    await done(app, item.id, "b"); expect(s("c")).toMatchObject({ state: "doing", by: "owner" });
    expect(s("c").askId).toBeNull();
    await ownerAction(app, item.id, "c", "done");
    expect(itemFlow(app, item.id)!.endedAt).toBeTruthy();
    expect(one(app.db, "select status from items where id=?", item.id)).toMatchObject({ status: "open" });
    const n = all(app.db, "select * from notifications where title=?", item.title).length;
    await advance(app, item.id); expect(all(app.db, "select * from notifications where title=?", item.title)).toHaveLength(n);
    expect(itemEvents(app, item.id).filter((e) => e.kind === "stage").length).toBe(stageLog(app, item.id).length);
  });
  it("同一前提的两个阶段都开始，跳过满足后继", async () => {
    const { app, item, s } = await setup([stage("a"), stage("b", { needs: ["a"] }), stage("c", { needs: ["a"] })]);
    await reportStage(app, item.id, "a", { state: "skip", note: "这次已有需求" }, { actor: "assistant" });
    expect(s("a").state).toBe("skipped"); expect(s("b").state).toBe("doing"); expect(s("c").state).toBe("doing");
  });
  it("条件由决策模型判否时跳过，并记概率", async () => {
    vi.mocked(decisionReady).mockReturnValue(true);
    vi.mocked(decide).mockResolvedValue({ choice: "no", probabilities: { no: 0.95, yes: 0.05 }, confidence: null, by: "测试模型" });
    const { app, item, s } = await setup([stage("a", { when: "这次跨模块吗" }), stage("b")]);
    expect(s("a").state).toBe("skipped"); expect(s("b").state).toBe("doing");
    expect(stageLog(app, item.id).some((l) => l.note.includes("0.95"))).toBe(true);
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it("未配模型或模型失败都问本人，yes 重开后不重复判断", async () => {
    const { app, item, s } = await setup([stage("a", { when: "需要方案吗", by: "wait" })]);
    expect(s("a").state).toBe("gated"); expect(getAsk(app, s("a").askId!).question).toContain("这一段要做吗");
    await answerAsk(app, s("a").askId!, { choice: 0, by: "owner" }); expect(s("a").state).toBe("doing");
    await reopenStage(app, item.id, "a", "范围变化", [], owner); expect(s("a").state).toBe("doing"); expect(s("a").askId).toBeNull();
    vi.mocked(decisionReady).mockReturnValue(true); vi.mocked(decide).mockRejectedValue(new Error("不可用"));
    const second = await setup([stage("a", { when: "需要方案吗" })]);
    expect(second.s("a").state).toBe("gated");
  });
  it("关卡上只写一句话不点按钮：按这句话开始这一段", async () => {
    const { app, item, s } = await setup([stage("a", { gate: "confirm" })]);
    expect(s("a").state).toBe("gated");
    await answerAsk(app, s("a").askId!, { text: "先只看退款列表页，别动结算", by: "owner" });
    expect(s("a").state).toBe("doing");
    expect(stageLog(app, item.id).some((l) => l.note.includes("先只看退款列表页"))).toBe(true);
  });
  it("confirm 关卡只认提问对象和实际回答人都是本人", async () => {
    const { app, item, s } = await setup([stage("a", { gate: "confirm" })]);
    expect(s("a")).toMatchObject({ state: "gated", attempt: 0 });
    await expect(answerAsk(app, s("a").askId!, { choice: 0, by: "another" })).rejects.toThrow("本人"); expect(s("a").state).toBe("gated");
    // A forged question addressed to another person cannot consent for the item owner either.
    run(app.db, "update asks set status='pending',user_id='another' where id=?", s("a").askId!);
    await expect(answerAsk(app, s("a").askId!, { choice: 0, by: "owner" })).rejects.toThrow("本人"); expect(s("a").state).toBe("gated");
    await ownerAction(app, item.id, "a", "confirm"); expect(s("a")).toMatchObject({ state: "doing", attempt: 1 });
  });
  it("连续自动开始到上限后等本人，确认重置计数；并发推进不重复起运行", async () => {
    const { app, item, s } = await setup([stage("a"), stage("b"), stage("c")], { autoAdvance: 2 });
    await Promise.all([advance(app, item.id), advance(app, item.id)]);
    expect(s("a").attempt).toBe(1);
    await done(app, item.id, "a"); await done(app, item.id, "b");
    expect(s("c").state).toBe("gated"); expect(itemFlow(app, item.id)!.autoStreak).toBe(2);
    await answerAsk(app, s("c").askId!, { choice: 0, by: "owner" });
    expect(s("c").state).toBe("doing"); expect(itemFlow(app, item.id)!.autoStreak).toBe(0);
  });
  it.each(["auto", "confirm"])("带依据重开已批准的阶段（关卡=%s），只有新阶段受自动上限约束", async gate => {
    const { app, item, s } = await setup([stage("prep"), stage("fix", { gate }), stage("verify"), stage("last")], { autoAdvance: 1 });
    await done(app, item.id, "prep");
    expect(s("fix").state).toBe("gated");
    await answerAsk(app, s("fix").askId!, { choice: 0, by: "owner" });
    const evidence = [s("fix").control.runId!];
    await done(app, item.id, "fix");
    const verify = s("verify").control.runId!;
    const result = await callTool({ app, userId: "owner", actor: "agent", role: "assistant", runId: null, spaceId: "personal", spaces: ["personal"], tools: null },
      "stage_reopen", { item: item.id, stage: "fix", reason: "验证没有通过", refs: evidence });
    expect(result.isError).not.toBe(true);
    expect(s("verify")).toMatchObject({ state: "stale", askId: null });
    expect(getRun(app, verify).status).toBe("cancelled");
    if (gate === "confirm") { expect(s("fix").state).toBe("gated"); return; }
    expect(s("fix")).toMatchObject({ state: "doing", askId: null, attempt: 2 });
    expect(itemFlow(app, item.id)?.autoStreak).toBe(1);
    await done(app, item.id, "fix");
    expect(s("verify")).toMatchObject({ state: "doing", askId: null, attempt: 2 });
    await done(app, item.id, "verify");
    expect(s("last")).toMatchObject({ state: "gated", control: { gateLimit: true } });
  });
  it("完成要依据；done: confirm 被拒时带意见重跑，第三次拒绝后卡住", async () => {
    const plain = await setup([stage("a")]);
    await expect(reportStage(plain.app, plain.item.id, "a", { state: "done", note: "好了" }, { actor: "assistant" })).rejects.toThrow("依据");
    const { app, item, s } = await setup([stage("a", { done: "confirm" })]);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(s("a").attempt).toBe(attempt);
      await reportStage(app, item.id, "a", { state: "done", note: "已交材料" }, { actor: "assistant", runId: s("a").by! });
      expect(s("a").state).toBe("doing");
      await answerAsk(app, s("a").askId!, { choice: 1, text: "补上边界情况", by: "owner" });
      if (attempt < 3) expect(getRun(app, s("a").by!).input.task).toContain("补上边界情况");
    }
    expect(s("a").state).toBe("blocked"); expect(s("a").note).toContain("三次");
    await ownerAction(app, item.id, "a", "done", "本人已经核验"); expect(s("a").state).toBe("done");
  });
  it("跳过和拒绝必须补理由，单点按钮不会静默跳过", async () => {
    const { app, s } = await setup([stage("a", { gate: "confirm" })]);
    await answerAsk(app, s("a").askId!, { choice: 2, by: "owner" });
    expect(s("a").state).toBe("gated"); expect(getAsk(app, s("a").askId!).options).toEqual([]);
    await answerAsk(app, s("a").askId!, { text: "这次不涉及", by: "owner" }); expect(s("a").state).toBe("skipped");
  });
  it.each(["done", "failed", "cancelled"])("运行 %s 未交结果会卡住，不自动重试", async (status) => {
    const { app, item, s } = await setup([stage("a")]); const runId = s("a").by!;
    run(app.db, "update runs set status=?,error='示例错误' where id=?", status, runId);
    app.emit({ type: "run", runId, status }); await advance(app, item.id);
    expect(s("a")).toMatchObject({ state: "blocked", attempt: 1 }); expect(s("a").note).toContain("没有交代结果：示例错误");
    await advance(app, item.id); expect(s("a").attempt).toBe(1);
  });
  it("重开沿传递依赖把 done 标待复核，跳过保持；对象直接复核，运行重跑", async () => {
    const { app, item, s } = await setup([stage("a"), stage("b"), stage("c"), stage("d", { by: "wait" })], { autoAdvance: 20 });
    await done(app, item.id, "a"); await done(app, item.id, "b");
    await reportStage(app, item.id, "c", { state: "skip", note: "不涉及" }, { actor: "assistant" });
    await reopenStage(app, item.id, "a", "前提改了", [], owner);
    expect(s("b").state).toBe("stale"); expect(s("c").state).toBe("skipped");
    await done(app, item.id, "a"); expect(s("b")).toMatchObject({ state: "doing", attempt: 2 });
    await done(app, item.id, "b"); await ownerAction(app, item.id, "d", "done", "已核验");
    await ownerAction(app, item.id, "a", "reopen", "本人重开已结束流程"); expect(itemFlow(app, item.id)!.endedAt).toBeNull();
  });
  it("停止撤回提问且结束后不再推进；本人自己暂停、停止不发进度卡", async () => {
    const { app, item, s } = await setup([stage("a", { gate: "confirm" })]);
    const ask = s("a").askId!;
    await ownerAction(app, item.id, "a", "hold");
    expect(getAsk(app, ask).status).toBe("cancelled");
    await stopFlow(app, item.id); expect(itemFlow(app, item.id)!.endedAt).toBeTruthy();
    await advance(app, item.id); expect(s("a").state).toBe("gated");
    expect(itemFlow(app, item.id)!.card).toBeFalsy();
  });
  it("提醒间隔从 2 天到 4 天，先别做重新计时", async () => {
    const { app, item, s } = await setup([stage("a", { gate: "confirm" })]);
    const since = Date.parse(s("a").since);
    const count = () => all(app.db, "select * from notifications where link like '%/flow?stage=a' and json_extract(context,'$.urgency')='later'").length;
    await flowReminders(app, new Date(since + 2 * 86400_000 - 1)); expect(count()).toBe(0);
    await flowReminders(app, new Date(since + 2 * 86400_000)); expect(count()).toBe(1);
    await flowReminders(app, new Date(since + 4 * 86400_000)); expect(count()).toBe(1);
    await flowReminders(app, new Date(since + 6 * 86400_000)); expect(count()).toBe(2);
    await ownerAction(app, item.id, "a", "hold"); expect(s("a").control.reminders).toBe(0);
    const heldAt = Date.parse(s("a").control.reminderAt!);
    await flowReminders(app, new Date(heldAt + 86400_000)); expect(count()).toBe(2);
    expect(s("a").state).toBe("gated");
  });
});

describe("只有本人能定的事", () => {
  it("已到自动上限时，普通本人阶段只给一条进展、不建 ask；手动做完和显式关卡照常可用", async () => {
    const { app, item, s } = await setup([
      stage("prep", { by: "wait" }),
      stage("manual", { by: "owner", note: "抽查退款记录。做完点做完了。" }),
      stage("explicit", { by: "owner", gate: "confirm" }),
      stage("conditional", { by: "owner", when: "需要补发通知吗" }),
    ], { autoAdvance: 1 });
    await done(app, item.id, "prep");
    expect(s("manual")).toMatchObject({ state: "doing", waitingOn: "owner", note: "等你：抽查退款记录", control: { question: "owner" } });
    expect(all(app.db, "select id from asks")).toEqual([]);
    const notices = all<{ body: string; urgency: string }>(app.db, "select body,json_extract(context,'$.urgency') urgency from notifications where json_extract(context,'$.entityId')=?", item.id);
    expect(notices).toEqual([{ body: expect.stringContaining("做完不用回来点"), urgency: "later" }]);
    expect(notices[0].body).not.toContain("做完点做完了");
    expect(flowStageCards(app, item.id, "owner").get("manual")).toMatchObject({ askId: null, title: "「manual」到你了" });
    await ownerAction(app, item.id, "manual", "done", "抽查通过");
    expect(s("manual").state).toBe("done");
    expect(s("explicit")).toMatchObject({ state: "gated", control: { gateLimit: false } });
    const gate = getAsk(app, s("explicit").askId!);
    expect(gate.question).toContain("轮到这一段了，开始吗？");
    await answerAsk(app, gate.id, { by: "owner", choice: 0 });
    expect(s("explicit")).toMatchObject({ state: "doing", waitingOn: "owner" });
    await ownerAction(app, item.id, "explicit", "done");
    expect(getAsk(app, s("conditional").askId!).question).toContain("这一段要做吗？");
  });
  it("以前发出的本人阶段“开始吗”卡片被收回，直接轮到本人", async () => {
    const { app, item, s } = await setup([stage("prep", { by: "wait" }), stage("owner", { by: "owner" })]);
    const ask = createAsk(app, { runId: null, question: "轮到这一段了，开始吗？", options: [{ label: "开始" }], context: { handler: "flow-stage", itemId: item.id, stageId: "owner", startedAt: itemFlow(app, item.id)!.startedAt, kind: "gate" } });
    run(app.db, "update item_stages set state='gated', ask_id=?, waiting_on='owner', control=? where item_id=? and stage_id='owner'", ask.id, JSON.stringify({ question: "gate", gateLimit: true }), item.id);
    await done(app, item.id, "prep");
    expect(getAsk(app, ask.id).status).toBe("cancelled");
    expect(s("owner")).toMatchObject({ state: "doing", waitingOn: "owner", control: { question: "owner" } });
    expect(s("owner").askId).toBeNull();
  });
  it("已发出的旧做完卡仍能回答，显式完成确认仍发卡", async () => {
    const { app, item, s } = await setup([stage("manual", { by: "owner" }), stage("confirm", { by: "owner", done: "confirm" })]);
    const ask = oldOwnerAsk(app, item.id, "manual");
    await advance(app, item.id);
    expect(getAsk(app, ask.id).status).toBe("pending");
    await answerAsk(app, ask.id, { by: "owner", choice: 0, text: "已查验" });
    expect(s("manual")).toMatchObject({ state: "done", note: "已查验" });
    expect(getAsk(app, s("confirm").askId!).status).toBe("pending");
  });
  it("上游重开收回下游的开始卡，等上游完成后再按原关卡重发", async () => {
    const { app, item, s } = await setup([stage("coding", { name: "编码", by: "wait" }), stage("verify", { gate: "confirm" })]);
    await done(app, item.id, "coding");
    const before = s("verify").askId!;
    expect(s("verify").state).toBe("gated");
    await reopenStage(app, item.id, "coding", "按新稿改", [], owner);
    expect(s("verify")).toMatchObject({ state: "pending", askId: null, note: "上游「编码」重开，收回了开始确认" });
    expect(getAsk(app, before).status).not.toBe("pending");
    const old = createAsk(app, { runId: null, question: "旧的开始确认", options: [{ label: "开始" }] });
    run(app.db, "update item_stages set state='gated',ask_id=?,control=json_set(control,'$.question','gate') where item_id=? and stage_id='verify'", old.id, item.id);
    await advance(app, item.id);
    expect(getAsk(app, old.id).status).not.toBe("pending");
    await done(app, item.id, "coding");
    expect(s("verify").state).toBe("gated");
    expect(s("verify").askId).not.toBe(before);
    expect(getAsk(app, s("verify").askId!).status).toBe("pending");
  });
  it("开始和本人操作不发进度卡，卡住等本人只发阶段操作卡，状态变化后撤回", async () => {
    const { app, item, s } = await setup([stage("a", { gate: "confirm" }), stage("b"), stage("c"), stage("d")]);
    const cards = () => all<{ id: string; body: string }>(app.db, "select id, body from notifications where json_extract(context, '$.entityId') = ?", item.id);
    expect(cards()).toHaveLength(0);
    await ownerAction(app, item.id, "a", "confirm");
    expect(cards()).toHaveLength(0);
    const agent = { actor: "assistant", userId: "owner" };
    await ownerAction(app, item.id, "a", "done", "本人自己做完了");
    expect(cards()).toHaveLength(0);
    await reportStage(app, item.id, "b", { state: "blocked", note: "部署失败（ask0mabcdefgh1234567）", waitingOn: "等本人给环境" }, agent);
    const first = getAsk(app, s("b").askId!);
    expect(first.question).toContain("**「b」卡住了**");
    expect(first.question).toContain("**现在**\n部署失败");
    expect(first.question).toContain("**卡点**\n等本人给环境");
    expect(first.question).not.toContain("ask0");
    expect(cards()).toHaveLength(0);
    await reportStage(app, item.id, "b", { state: "skip", note: "这次不用" }, agent);
    expect(getAsk(app, first.id).status).toBe("cancelled");
  });
  it("流程的提问卡片自己说得清：哪件事哪一段、要定什么、结果和之后接着什么，不带内部编号", async () => {
    const { app, item, s } = await setup([stage("a", { done: "confirm", note: "核对需求点。拿不准的问本人" }), stage("b", { gate: "confirm", note: "在测试环境逐条验收。截图留证" })]);
    app.config.webUrl = "https://omem.example.test/";
    const carrier = s("a").by!;
    const r = createRun(app, { kind: "agent", spaceId: "personal", title: "依据" }).id;
    await reportStage(app, item.id, "a", { state: "done", note: "需求点核对完了，改名入口另排（ask0mabcdefgh1234567）", evidence: [r] }, { actor: "assistant", runId: s("a").by!, userId: "owner" });
    const done = getAsk(app, s("a").askId!).question;
    expect(done.split("\n\n")[0]).toBe("**「a」等你确认做完**"); expect(done).toContain("事项：示例商城退款");
    expect(done.split("\n\n")[1]).toContain(`[事项流程页](https://omem.example.test/#/items/${item.id}/flow?stage=a)`);
    expect(done).toContain(`[承担者运行](https://omem.example.test/#/runs/${carrier})`);
    expect(done).toContain("**现在**\n需求点核对完了，改名入口另排");
    expect(done).not.toContain("ask0");
    expect(done).toContain("确认后接着：b");
    expect(done).toContain(`[看运行](https://omem.example.test/#/runs/${r})`);
    await ownerAction(app, item.id, "a", "confirm");
    const gate = getAsk(app, s("b").askId!).question;
    expect(gate.split("\n\n")[0]).toBe("**「b」等你确认开始**");
    expect(gate).toContain("**建议的做法**\n在测试环境逐条验收。截图留证");
    expect(gate).toMatch(/\*\*现在\*\*\na：已完成，需求点核对完了，改名入口另排/);
  });
  it("运行交了截图再报做完：卡片带上截图、保留分段的结论，事项页这一段列出截图", async () => {
    const { app, item, s } = await setup([stage("a"), stage("b")]);
    const runId = s("a").by!;
    const inbox = artifactInbox(app, runId);
    writeFileSync(join(inbox, "repro-01-下载后仍是全量.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await collectInbox(app, runId, { source: "agent", by: "assistant" });
    const note = "已复现：只留 1 列，导出仍是 7 列。\n\n步骤：测试环境 → 数据明细 → 自定义列只留访问人数 → 下载。\n\n原因：导出接口只收日期区间，没有列参数。";
    await reportStage(app, item.id, "a", { state: "blocked", note: "要本人给测试账号", waitingOn: "本人" }, { actor: "assistant", runId, userId: "owner" });
    const first = s("a").askId!;
    expect(getAsk(app, first).status).toBe("pending");
    await reportStage(app, item.id, "a", { state: "done", note, evidence: [`run:${runId}`] }, { actor: "assistant", runId, userId: "owner" });
    expect(getAsk(app, first).status).toBe("cancelled");
    expect(one<{ summary: string; detail: string }>(app.db, "select summary, detail from item_changes where item_id = ? and origin = 'flow' and summary like '%做完'", item.id)).toMatchObject({ summary: "「a」做完", detail: expect.stringContaining("已复现") });
    const n = one<{ body: string; context: string }>(app.db, "select body, context from notifications where id = ?", itemFlow(app, item.id)!.card!)!;
    expect(n.body).toContain("已复现：只留 1 列，导出仍是 7 列。\n\n步骤：");
    const images = JSON.parse(n.context).images as string[];
    expect(images).toHaveLength(1);
    const { itemNotificationCard } = await import("../src/channels/item-notification.ts");
    const card = JSON.stringify(itemNotificationCard(app, { ...JSON.parse(n.context), id: "n", at: "", title: item.title, body: n.body, link: null, readAt: null, userId: "owner" }, [{ key: "img_test", alt: "下载后仍是全量" }]));
    expect(card).toContain("img_test");
    const view = flowView(app, item.id);
    expect(view.stages.find((x) => x.id === "a")!.shots.map((a) => a.id)).toEqual(images);
    expect(view.stages.find((x) => x.id === "b")!.shots).toEqual([]);
    // The same picture handed in again under another name shows once.
    writeFileSync(join(artifactInbox(app, runId), "repro-01-copy.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    await collectInbox(app, runId, { source: "agent", by: "assistant" });
    expect(flowView(app, item.id).stages.find((x) => x.id === "a")!.shots.map((a) => a.id)).toEqual(images);
  });
  it("together: push：同一次推送的几件事项合用一个回归验证运行，结果按事项分开", async () => {
    const app = appFor();
    const pushed = (head: string) => [{ space: "personal", branch: "feat/refund", head }];
    const make = (title: string, head: string) => {
      const item = upsertItem(app, undefined, { title, spaceId: "personal" }, "user");
      const r = createRun(app, { kind: "code", spaceId: "personal", title: `修 ${title}`, input: { itemId: item.id, repos: ["personal"] }, userId: "owner" });
      setRunOutput(app, r.id, { pushed: pushed(head) });
      addLocalMaterials(app, item.id, [{ kind: "run", ref: r.id }], "owner");
      return item;
    };
    const a = make("退款金额不对", "a".repeat(40)), b = make("退款单号截断", "a".repeat(40)), c = make("别的分支", "c".repeat(40));
    saveFlow(app, yaml([stage("verify", { together: "push" })]), "user");
    for (const x of [a, b, c]) await startFlow(app, x.id, "demo", owner);
    const runOf = (id: string) => getStage(app, id, "verify").control.runId!;
    expect(runOf(a.id)).toBe(runOf(b.id));
    expect(runOf(c.id)).not.toBe(runOf(a.id));
    const shared = getRun(app, runOf(a.id));
    expect(shared.title).toBe("2 件事项 · verify");
    expect((shared.input.items as { itemId: string }[]).map((x) => x.itemId)).toEqual([a.id, b.id]);
    expect(one<{ n: string | null }>(app.db, "select not_before n from runs where id=?", shared.id)?.n).toBeTruthy();
    // Stopping one item's flow lets that item go; the run stays for the other.
    const d = make("不修了", "a".repeat(40));
    await startFlow(app, d.id, "demo", owner);
    expect(runOf(d.id)).toBe(shared.id);
    await stopFlow(app, d.id);
    expect(getRun(app, shared.id).status).toBe("queued");
    expect((getRun(app, shared.id).input.items as { itemId: string }[]).map((x) => x.itemId)).toEqual([a.id, b.id]);
    expect(() => parseFlow(yaml([stage("x", { by: "owner", together: "push" })]))).toThrow("together");

    const ctx: ToolContext = { app, runId: shared.id, spaceId: "personal", spaces: ["personal"], writable: ["personal"], tools: null, actor: "agent", userId: "owner" };
    const test = (name: string, status = "passed") => [{ name, status, mode: "浏览器" }];
    expect((await callTool(ctx, "report_tests", { tests: test("金额") })).text).toContain("带 item");
    expect((await callTool(ctx, "report_tests", { tests: test("金额"), item: c.id })).isError).toBe(true);
    expect((await callTool(ctx, "report_tests", { tests: test("金额"), item: a.id })).isError).toBe(false);
    expect((await callTool(ctx, "report_tests", { tests: test("单号", "failed"), item: b.id })).isError).toBe(false);
    const tests = (id: string) => flowView(app, id).stages[0].tests.map((t) => `${t.name}:${t.status}`);
    expect(tests(a.id)).toEqual(["金额:passed"]);
    expect(tests(b.id)).toEqual(["单号:failed"]);

    await reportStage(app, a.id, "verify", { state: "done", note: "金额对了", evidence: [`run:${shared.id}`] }, { actor: "assistant", runId: shared.id, userId: "owner" });
    expect(getStage(app, a.id, "verify").state).toBe("done");
    expect(getStage(app, b.id, "verify").state).toBe("doing");
    await reportStage(app, b.id, "verify", { state: "blocked", note: "单号仍截断", waitingOn: "重新修复" }, { actor: "assistant", runId: shared.id, userId: "owner" });
    expect(getStage(app, b.id, "verify").state).toBe("blocked");
  });
  it("阶段自己的运行已经问了本人，再报卡住等本人时不另发进度卡", async () => {
    const { app, item, s } = await setup([stage("a")]);
    const runId = s("a").by!;
    createAsk(app, { runId, userId: "owner", question: "核对稿填好了，改完确认", options: [{ label: "确认" }], allowText: true });
    await reportStage(app, item.id, "a", { state: "blocked", note: "等本人确认核对稿", waitingOn: "本人" }, { actor: "assistant", runId, userId: "owner" });
    expect(s("a").state).toBe("blocked");
    expect(all(app.db, "select id from notifications where json_extract(context, '$.entityId') = ?", item.id)).toHaveLength(0);
  });
  it("卡住等本人确认一份表格时带上链接：事项页这一段、进度视图和给本人的卡片都能直接点开", async () => {
    const { app, item, s } = await setup([stage("a"), stage("b")]);
    const runId = s("a").by!;
    const agent = { actor: "assistant", runId, userId: "owner" } as const;
    await expect(reportStage(app, item.id, "a", { state: "blocked", note: "核对稿填好了", waitingOn: "本人", links: [{ label: "核对表", url: "javascript:alert(1)" }] }, agent)).rejects.toThrow("http");
    const links = [{ label: "埋点核对表", url: "https://tenant.larkoffice.com/sheets/example" }];
    await reportStage(app, item.id, "a", { state: "blocked", note: "核对稿填好了，等本人改完确认", waitingOn: "本人", links }, agent);
    expect(flowView(app, item.id).stages.find((x) => x.id === "a")!.links).toEqual(links);
    const card = getAsk(app, getStage(app, item.id, "a").askId!);
    expect(card.question).toContain("[埋点核对表](https://tenant.larkoffice.com/sheets/example)");
    const { itemProgress } = await import("../src/agents/progress.ts");
    const task = itemProgress(app, item.id, { user: "owner" }).find((v) => v.kind === "flow")!.tasks.find((t) => t.id === "a")!;
    expect(task.outputs?.[0]).toEqual({ kind: "link", ref: links[0].url, label: "埋点核对表" });
    // A later report without links keeps them; an empty list clears them.
    await reportStage(app, item.id, "a", { state: "blocked", note: "还在等本人", waitingOn: "本人" }, agent);
    expect(flowView(app, item.id).stages.find((x) => x.id === "a")!.links).toEqual(links);
    await reportStage(app, item.id, "a", { state: "blocked", note: "表格作废了", waitingOn: "本人", links: [] }, agent);
    expect(flowView(app, item.id).stages.find((x) => x.id === "a")!.links).toEqual([]);
  });
  it("本人承担的阶段，助手说做完了只会变成问本人的确认；本人确认才完成", async () => {
    const { app, item, s } = await setup([{ id: "push", name: "推送", by: "owner" }, stage("deploy")]);
    expect(s("push")).toMatchObject({ state: "doing", by: "owner" });
    await reportStage(app, item.id, "push", { state: "done", note: "本人在对话里说推送了" }, { actor: "assistant", userId: "owner" });
    // Not done, and the stage after it has not started.
    expect(s("push")).toMatchObject({ state: "doing", waitingOn: "owner" });
    expect(s("deploy").state).toBe("pending");
    const ask = getAsk(app, s("push").askId!);
    expect(ask.question).toContain("助手说已经做完了");
    await expect(answerAsk(app, ask.id, { choice: 0, by: "another" })).rejects.toThrow();
    expect(s("push").state).toBe("doing");
    await answerAsk(app, ask.id, { choice: 0, by: "owner" });
    expect(s("push").state).toBe("done");
    expect(s("deploy").state).toBe("doing");
  });
  it("要本人确认或由本人承担的阶段，助手不能跳过；本人可以，自动的阶段助手可以", async () => {
    const { app, item, s } = await setup([stage("clarify", { done: "confirm" }), stage("auto"), { id: "release", name: "上线", gate: "confirm", by: { run: {} } }, { id: "check", name: "核对", by: "owner" }]);
    const agent = { actor: "assistant", userId: "owner" };
    for (const id of ["clarify", "release", "check"]) await expect(reportStage(app, item.id, id, { state: "skip", note: "看起来不需要" }, agent)).rejects.toThrow("不能由你跳过");
    expect(s("clarify").state).toBe("doing");
    await ownerAction(app, item.id, "clarify", "skip", "这次需求很清楚");
    expect(s("clarify").state).toBe("skipped");
    expect(s("auto").state).toBe("doing");
    await reportStage(app, item.id, "auto", { state: "skip", note: "这次没有可做的" }, agent);
    expect(s("auto").state).toBe("skipped");
  });
});

describe("跳过阶段仍等上游", () => {
  const chain = [stage("push", { name: "推送", by: "wait" }), stage("verify", { by: "wait" }), stage("accept", { by: "wait" }), stage("release", { name: "上线", by: "owner" })];
  async function skippedChain() {
    const result = await setup(chain);
    for (const middle of ["verify", "accept"]) await ownerAction(result.app, result.item.id, middle, "skip", "这次不做");
    return result;
  }
  it("跳过两段以后，下游仍等未完成的推送；手动跳过仍可用", async () => {
    const { app, item, s } = await skippedChain();
    expect(s("release")).toMatchObject({ state: "pending", attempt: 0 });
    await done(app, item.id, "push");
    expect(s("release")).toMatchObject({ state: "doing", waitingOn: "owner", askId: null });
    await ownerAction(app, item.id, "release", "skip", "这次不发布");
    expect(s("release").state).toBe("skipped");
  });
  it.each(["未动", "本人写过说明", "承担者写过说明", "承担运行只排队", "承担运行已开始"])("旧流程提前上线：%s", async (activity) => {
    const { app, item, s } = await skippedChain();
    const enteredAt = new Date().toISOString();
    const carrier = activity.startsWith("承担运行") ? createRun(app, { kind: "agent", title: "检查上线", spaceId: "personal" }).id : undefined;
    if (activity === "承担运行已开始") run(app.db, "update runs set status='running',started_at=? where id=?", enteredAt, carrier!);
    changeStage(app, item.id, "release", "doing", { by: "owner", enteredAt, waitingOn: "owner", attempt: 1, control: { runId: carrier } }, { actor: "host" }, "等你上线");
    const ask = oldOwnerAsk(app, item.id, "release");
    if (activity.endsWith("写过说明")) changeStage(app, item.id, "release", "doing", {}, { actor: activity.startsWith("本人") ? "owner" : "agent" }, "已开始准备");
    await advance(app, item.id);
    if (activity !== "未动" && activity !== "承担运行只排队") {
      expect(s("release").state).toBe("doing");
      expect(getAsk(app, ask.id).status).toBe("pending");
      return;
    }
    expect(s("release")).toMatchObject({ state: "pending", enteredAt: null, askId: null });
    expect(getAsk(app, ask.id).status).toBe("cancelled");
    if (carrier) expect(getRun(app, carrier).status).toBe("cancelled");
    expect(one<{ body: string }>(app.db, "select body from notifications where json_extract(context,'$.entityId')=? order by rowid desc limit 1", item.id)?.body).toContain("『上线』开早了：上游『推送』还没完成，已收回");
    await done(app, item.id, "push");
    expect(s("release")).toMatchObject({ state: "doing", attempt: 2, askId: null });
  });
});

describe("对象与工具", () => {
  it("运行交 done 不越过对象状态规则；对象完成需要本人确认时另问本人", async () => {
    const { app, item, s } = await setup([stage("a", { done: { object: "code-work", status: "done" } }), stage("b", { by: { object: "code-work" }, done: "confirm" })]);
    const carrier = s("a").by!;
    const code = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { itemId: item.id } });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: code.id }], "owner");
    await reportStage(app, item.id, "a", { state: "done", note: "材料已交", evidence: [carrier] }, { actor: "assistant", runId: carrier });
    expect(s("a").state).toBe("doing");
    setRunOutput(app, code.id, { verdict: "approved" }); run(app.db, "update runs set status='done' where id=?", code.id);
    await advance(app, item.id); expect(s("a").state).toBe("done");
    expect(s("b")).toMatchObject({ state: "doing", waitingOn: "owner" });
    const confirmation = s("b").askId!;
    expect(getAsk(app, confirmation).question).toContain(`[交办运行](#/runs/${code.id})`);
    await reportStage(app, item.id, "b", { state: "done", note: "退款修改已核对", evidence: [carrier] }, { actor: "assistant" });
    expect(s("b")).toMatchObject({ askId: confirmation, evidence: [`code-work:${code.id}`, carrier] });
    expect(getAsk(app, confirmation).question).toContain("退款修改已核对");
    expect(all(app.db, "select id from asks where json_extract(context,'$.stageId')='b'")).toEqual([{ id: confirmation }]);
    await answerAsk(app, s("b").askId!, { choice: 1, text: "还需要补充测试", by: "owner" });
    expect(s("b")).toMatchObject({ state: "doing", attempt: 2 }); expect(s("b").by).not.toBe(`code-work:${code.id}`);
    expect(getRun(app, s("b").by!).input.task).toContain("还需要补充测试");
  });
  it("承担者先报完成、随后交办完成时，原确认卡补上交办依据", async () => {
    const { app, item, s } = await setup([stage("fix", { by: { object: "code-work" }, done: "confirm" })]);
    const code = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { itemId: item.id } });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: code.id }], "owner");
    const carrier = s("fix").control.runId!;
    await reportStage(app, item.id, "fix", { state: "done", note: "已核对退款改动", evidence: [carrier] }, { actor: "assistant", runId: carrier });
    const confirmation = s("fix").askId!;
    setRunOutput(app, code.id, { verdict: "approved" });
    run(app.db, "update runs set status='done' where id=?", code.id);
    await advance(app, item.id);
    expect(s("fix")).toMatchObject({ askId: confirmation, evidence: [carrier, `code-work:${code.id}`] });
    expect(getAsk(app, confirmation).question).toContain("已核对退款改动");
    expect(getAsk(app, confirmation).stageCard?.sections.find(section => section.label === "依据")?.text).toContain(code.id);
  });
  it("编码对象从 run 材料找交办，评审 approved 后完成（无需应用）；事件能找到关联事项", async () => {
    const { app, item, s } = await setup([stage("a", { by: { object: "code-work" } }), stage("b", { by: "wait" })]);
    const r = createRun(app, { kind: "code", spaceId: "personal", title: "实现退款", input: { itemId: item.id, repos: ["personal"] }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: r.id }], "owner");
    await advance(app, item.id); expect(s("a").by).toBe(`code-work:${r.id}`);
    setRunOutput(app, r.id, { verdict: "approved" }); run(app.db, "update runs set status='done' where id=?", r.id);
    app.emit({ type: "changed", entity: "code-task", id: r.id }); await advance(app, item.id);
    expect(s("a").state).toBe("done"); expect(s("b").state).toBe("doing");
    await reopenStage(app, item.id, "b", "重新核验", [], owner);
    await reopenStage(app, item.id, "a", "回看", [], owner);
    expect(s("a").state).toBe("doing");
    expect(s("a").by).not.toBe(`code-work:${r.id}`);
    setRunOutput(app, r.id, { discardedAt: "2026-11-15" }); expect(findObject(app, item, "code-work")).toBeNull();
  });
  it("跟着交办的段被自己的运行报成等交办，交办评审通过后照样完成；等本人的不跟", async () => {
    const { app, item, s } = await setup([stage("a", { by: { object: "code-work" } }), stage("b", { by: "wait" })]);
    const r = createRun(app, { kind: "code", spaceId: "personal", title: "同一分支上别的事项的交办", input: { itemId: item.id, repos: ["personal"] }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: r.id }], "owner");
    run(app.db, "update item_stages set state='blocked', waiting_on='同分支的交办编码与评审' where item_id=? and stage_id='a'", item.id);
    setRunOutput(app, r.id, { verdict: "approved" }); run(app.db, "update runs set status='done' where id=?", r.id);
    await advance(app, item.id);
    expect(s("a").state).toBe("done"); expect(s("b").state).toBe("doing");
    const other = await setup([stage("a", { by: { object: "code-work" } })]);
    const r2 = createRun(other.app, { kind: "code", spaceId: "personal", title: "交办", input: { itemId: other.item.id, repos: ["personal"] }, userId: "owner" });
    addLocalMaterials(other.app, other.item.id, [{ kind: "run", ref: r2.id }], "owner");
    run(other.app.db, "update item_stages set state='blocked', waiting_on='owner' where item_id=? and stage_id='a'", other.item.id);
    await advance(other.app, other.item.id);
    expect(other.s("a").state).toBe("blocked");
  });
  it("跟着交办的段按本人意见重做：运行发起交办后结束，段跟着新交办走，不报卡住", async () => {
    const { app, item, s } = await setup([stage("a", { by: { object: "code-work" } }), stage("b", { by: "wait" })]);
    const old = createRun(app, { kind: "code", spaceId: "personal", title: "第一次交办", input: { itemId: item.id, repos: ["personal"] }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: old.id }], "owner");
    setRunOutput(app, old.id, { verdict: "approved" }); run(app.db, "update runs set status='done', created_at='2026-01-01T00:00:00.000Z' where id=?", old.id);
    await advance(app, item.id); expect(s("a").state).toBe("done");
    await reopenStage(app, item.id, "a", "设计稿换了图标，按新稿改", [], owner, { feedback: true });
    const stageRun = s("a").by!;
    expect(getRun(app, stageRun).kind).toBe("flow-stage");
    const next = createRun(app, { kind: "code", spaceId: "personal", title: "换图标", input: { itemId: item.id, repos: ["personal"] }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: next.id }], "owner");
    setRunOutput(app, stageRun, { text: "已交办换图标" }); run(app.db, "update runs set status='done' where id=?", stageRun);
    await advance(app, item.id);
    expect(s("a")).toMatchObject({ state: "doing", by: `code-work:${next.id}` });
    expect(s("a").control.feedback).toBeUndefined();
    setRunOutput(app, next.id, { verdict: "approved" }); run(app.db, "update runs set status='done' where id=?", next.id);
    await advance(app, item.id); expect(s("a").state).toBe("done");
  });
  it("重开前的交办不算返工结果；重开后继续交办才推进", async () => {
    const { app, item, s } = await setup([stage("a", { by: { object: "code-work" } }), stage("b", { by: "wait" })]);
    const old = createRun(app, { kind: "code", spaceId: "personal", title: "第一次交办", input: { itemId: item.id, repos: ["personal"] }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: old.id }], "owner");
    setRunOutput(app, old.id, { verdict: "approved" }); run(app.db, "update runs set status='done', created_at='2026-01-01T00:00:00.000Z' where id=?", old.id);
    await advance(app, item.id); expect(s("a").state).toBe("done");
    const direct = createRun(app, { kind: "code", spaceId: "personal", title: "退款单加运费说明", input: { itemId: item.id, repos: ["personal"] }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: direct.id }], "owner");
    setRunOutput(app, direct.id, { verdict: "approved" }); run(app.db, "update runs set status='done',created_at=? where id=?", new Date(Date.now() - 1000).toISOString(), direct.id);
    await advance(app, item.id); expect(s("a").state).toBe("done");
    await reopenStage(app, item.id, "a", "本人要求退款单加运费说明", [], owner, { feedback: true });
    const stageRun = s("a").by!;
    setRunOutput(app, stageRun, { text: "运费说明已在现有交办里" }); run(app.db, "update runs set status='done' where id=?", stageRun);
    await advance(app, item.id);
    expect(s("a")).toMatchObject({ state: "blocked", note: expect.stringContaining("旧交办不能作为这一次的结果") });
    const next = createRun(app, { kind: "code", spaceId: "personal", title: "继续改退款单", input: { itemId: item.id, repos: ["personal"], continueFrom: direct.id }, userId: "owner" });
    setRunOutput(app, next.id, { verdict: "approved" }); run(app.db, "update runs set status='done' where id=?", next.id);
    await advance(app, item.id);
    expect(s("a")).toMatchObject({ state: "done", by: `code-work:${direct.id}` });
  });
  it.each(["done", "wontdo", "unfinished", "review-failed", "handoff"])("返工跟随已在运行的第九轮，按新修改项和评审结果推进：%s", async (outcome) => {
    const { app, item, s } = await setup([stage("code", { by: { object: "code-work" } }), stage("later", { by: "wait" })]);
    const work = createRun(app, { kind: "code", spaceId: "personal", title: "改退款单", input: { itemId: item.id, repos: ["personal"], round: 9 }, userId: "owner" });
    run(app.db, "update runs set status='running',created_at=? where id=?", new Date(Date.now() - 60000).toISOString(), work.id);
    addLocalMaterials(app, item.id, [{ kind: "run", ref: work.id }], "owner");
    await advance(app, item.id);
    await reopenStage(app, item.id, "code", "补充退款原因", [], owner, { feedback: true });
    const stageRun = s("code").control.runId!;
    expect(getRun(app, stageRun).input.task).toContain("不报 blocked，也不要再起一轮");
    const after = s("code").control.objectAfter!;
    if (outcome === "handoff") {
      const { note } = addCodeNote(app, work.id, "补充退款原因", "owner");
      markNotesDelivered(app, work.id, [note]);
    } else {
      const task = addTask(app, work.id, { title: "补充退款原因", kind: "owner" }, "owner");
      run(app.db, "update code_tasks set created_at=? where id=?", new Date(Date.parse(after) + 1).toISOString(), task.id);
      updateTask(app, work.id, task.seq, { coderRun: work.id, state: outcome === "unfinished" ? "owner" : outcome === "wontdo" ? "wontdo" : "done", ...(outcome === "wontdo" ? { answer: "字段已经由通用表单提供" } : {}) });
    }
    run(app.db, "insert into item_stage_log (item_id, stage_id, at, from_state, to_state, actor, note) values (?,?,?,?,?,?,?)", item.id, "code", new Date().toISOString(), "doing", "blocked", "assistant", "原交办第 9 轮结束后才能启动新一轮");
    await reportStage(app, item.id, "code", { state: "blocked", waitingOn: "下一轮", note: "等下一轮" }, { actor: "assistant", runId: stageRun });
    expect(s("code")).toMatchObject({ state: "doing", by: `code-work:${work.id}`, note: expect.stringContaining("第 9 轮") });
    run(app.db, "update runs set status='done' where id=?", stageRun);
    setRunOutput(app, work.id, { verdict: outcome === "review-failed" ? "changes" : "approved" });
    run(app.db, "update runs set status='done',finished_at=? where id=?", new Date(Date.parse(after) + 5000).toISOString(), work.id);
    await advance(app, item.id);
    const blocked = outcome === "unfinished" ? "补充退款原因" : outcome === "review-failed" ? "评审没有通过" : null;
    expect(s("code").state).toBe(blocked ? "blocked" : "done");
    if (blocked) expect(s("code").note).toContain(blocked);
    // What the stage run wrote while the round was still going is not shown over the host's newer reason.
    if (blocked) expect(flowView(app, item.id).stages.find((x) => x.id === "code")).toMatchObject({ note: expect.stringContaining(blocked), result: "" });
    expect(one<{ n: number }>(app.db, "select count(*) n from runs where kind='code'")?.n).toBe(1);
  });
  it("跟着分支评审的段按本人意见重做：任务是带 rereview_of 复审，不发起编码交办", async () => {
    const { app, item, s } = await setup([stage("a", { by: { object: "code-work" }, done: { object: "code-work", status: ["findings", "review-ok"] } })]);
    const review = createRun(app, { kind: "code", spaceId: "personal", title: "同事分支的评审", input: { itemId: item.id, repos: ["personal"], branches: { personal: "feature/refund" } }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: review.id }], "owner");
    await advance(app, item.id); expect(s("a").by).toBe(`code-work:${review.id}`);
    await reopenStage(app, item.id, "a", "群里说图标要换成耳麦", [], owner, { feedback: true });
    const task = String(getRun(app, s("a").by!).input.task);
    expect(task).toContain(`rereview_of=${review.id}`);
    expect(task).toContain("不要发起 delegate_code");
    expect(task).not.toContain("按这件事的需求点发起交办");
  });
  it("评审段重开后卡住：只跟新复审的结论，本人自己的卡住不动", async () => {
    const { app, item, s } = await setup([stage("a", { by: { object: "code-work" }, done: { object: "code-work", status: ["findings", "review-ok"] } }), stage("b", { by: "wait" })]);
    const review = createRun(app, { kind: "code", spaceId: "personal", title: "同事分支的评审", input: { itemId: item.id, repos: ["personal"], branches: { personal: "feature/refund" } }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: review.id }], "owner");
    await advance(app, item.id);
    await reopenStage(app, item.id, "a", "群里说图标要换成耳麦", [], owner, { feedback: true });
    const stageRun = s("a").by!;
    run(app.db, "update runs set status='done' where id=?", stageRun);
    await advance(app, item.id); expect(s("a").state).toBe("blocked");
    const later = new Date(Date.now() + 60_000).toISOString();
    setRunOutput(app, review.id, { verdict: "changes-requested" }); run(app.db, "update runs set status='done', finished_at=? where id=?", later, review.id);
    await advance(app, item.id);
    expect(s("a").state).toBe("blocked");
    const fresh = createRun(app, { kind: "code", spaceId: "personal", title: "重新评审同事分支", input: { itemId: item.id, repos: ["personal"], branches: { personal: "feature/refund" }, rereviewOf: review.id }, userId: "owner" });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: fresh.id }], "owner");
    setRunOutput(app, fresh.id, { verdict: "changes-requested" }); run(app.db, "update runs set status='done', finished_at=? where id=?", later, fresh.id);
    await advance(app, item.id);
    expect(s("a")).toMatchObject({ state: "done", by: `code-work:${fresh.id}` });
    expect(s("a").note).toContain("有了结果");
    expect(s("b").state).toBe("doing");
    const other = await setup([stage("a", { by: { object: "code-work" }, done: { object: "code-work", status: ["findings", "review-ok"] } })]);
    const r2 = createRun(other.app, { kind: "code", spaceId: "personal", title: "评审", input: { itemId: other.item.id, repos: ["personal"], branches: { personal: "feature/x" } }, userId: "owner" });
    addLocalMaterials(other.app, other.item.id, [{ kind: "run", ref: r2.id }], "owner");
    run(other.app.db, "update item_stages set state='blocked', waiting_on='owner', since='2026-01-01T00:00:00.000Z' where item_id=? and stage_id='a'", other.item.id);
    run(other.app.db, "insert into item_stage_log(item_id,stage_id,at,from_state,to_state,actor,run_id,refs,note,round) values(?,?,?,?,?,?,?,?,?,?)", other.item.id, "a", "2026-01-01T00:00:00.000Z", "doing", "blocked", "owner", null, "[]", "三次仍未确认", 1);
    setRunOutput(other.app, r2.id, { verdict: "changes-requested" }); run(other.app.db, "update runs set status='done', finished_at=? where id=?", later, r2.id);
    await advance(other.app, other.item.id);
    expect(other.s("a").state).toBe("blocked");
  });
  it("本人完成上一段时写的话已经定了下一段：下一段任务带上原话；拿不准就等新依据", async () => {
    const flow = [stage("a", { by: "wait" }), stage("pick", { by: "owner", note: "在评审概览里定每个问题", done: "定好了要发的问题" }), stage("send", { note: "把定为改的问题发到合并请求" })];
    const { app, item, s } = await setup(flow, { autoAdvance: 20 });
    vi.mocked(decisionReady).mockReturnValue(true);
    vi.mocked(decide).mockResolvedValue({ choice: "yes", probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9, by: "test" });
    await ownerAction(app, item.id, "a", "done", "问题都认可，发到 MR 吧");
    expect(vi.mocked(decide).mock.calls[0][2]).toMatchObject({ type: "yesno" });
    expect(JSON.stringify(vi.mocked(decide).mock.calls[0][1])).toContain("问题都认可，发到 MR 吧");
    expect(s("pick")).toMatchObject({ state: "done", askId: null });
    expect(s("pick").note).toContain("你在「a」时已经说了：问题都认可，发到 MR 吧");
    expect(s("send").state).toBe("doing");
    expect(String(getRun(app, s("send").by!).input.task)).toContain("「a」：问题都认可，发到 MR 吧");

    const unsure = await setup(flow, { autoAdvance: 20 });
    vi.mocked(decide).mockResolvedValue({ choice: "yes", probabilities: { yes: 0.55, no: 0.45 }, confidence: 0.55, by: "test" });
    await ownerAction(unsure.app, unsure.item.id, "a", "done", "先看看");
    expect(unsure.s("pick")).toMatchObject({ state: "doing", by: "owner", waitingOn: "owner" });
    expect(unsure.s("pick").note).toBe("等你：在评审概览里定每个问题");
    expect(unsure.s("pick").askId).toBeNull();
    // The owner's own step is done without having to write why.
    await ownerAction(unsure.app, unsure.item.id, "pick", "done", "");
    expect(unsure.s("pick")).toMatchObject({ state: "done", note: "本人做完了" });
  });
  it("运行没交结果：卡片分段写，内部编号连同代码引号一起去掉", async () => {
    const { app, item, s } = await setup([stage("a")]);
    const stageRun = s("a").by!;
    setRunOutput(app, stageRun, { text: "查过了。\n\n已交办：`r0mabcdefghijk12`" }); run(app.db, "update runs set status='done' where id=?", stageRun);
    await advance(app, item.id);
    expect(s("a").state).toBe("blocked");
    const ask = getAsk(app, s("a").askId!);
    const card = ask.question;
    expect(card).toContain("**「a」卡住了**");
    expect(card).toContain("这一段的运行结束了，没有交代结果。\n\n**运行最后说的**\n查过了。");
    expect(card).not.toContain("``");
    expect(ask.stageCard?.textAction).toBe("按这句话处理");
  });
  it("方案对象只接受本人的本版确认；助手确认不算", async () => {
    const app = appFor(); const item = upsertItem(app, undefined, { title: "方案事项", spaceId: "personal" }, "user");
    const d = createDesign(app, { title: "退款方案", spaceId: "personal", itemId: item.id, origin: "own", userId: "owner" });
    saveFlow(app, yaml([stage("a", { by: { object: "design" } })]), "user");
    await startFlow(app, item.id, "demo", owner);
    setDesignStatus(app, d.id, "review"); decideDesign(app, d.id, { action: "approve", by: "assistant" });
    await advance(app, item.id); expect(getStage(app, item.id, "a").state).toBe("doing");
    setDesignStatus(app, d.id, "review"); decideDesign(app, d.id, { action: "approve", by: "owner" });
    await advance(app, item.id); expect(getStage(app, item.id, "a").state).toBe("done");
  });
  it("对象下游待复核时直接重读对象，仍完成就恢复 done", async () => {
    const { app, item, s } = await setup([stage("a", { by: "wait" }), stage("b", { by: { object: "code-work" } }), stage("c", { by: "wait" })], { autoAdvance: 20 });
    const r = createRun(app, { kind: "code", spaceId: "personal", title: "退款", input: { itemId: item.id } });
    addLocalMaterials(app, item.id, [{ kind: "run", ref: r.id }], "owner");
    setRunOutput(app, r.id, { verdict: "approved" }); run(app.db, "update runs set status='done' where id=?", r.id);
    await ownerAction(app, item.id, "a", "done", "需求已确认"); expect(s("b").state).toBe("done");
    await reopenStage(app, item.id, "a", "补充需求", [], owner); expect(s("b").state).toBe("stale");
    await ownerAction(app, item.id, "a", "done", "仍成立"); expect(s("b")).toMatchObject({ state: "done", attempt: 1 });
  });
  it("工具同时限制事项主人、用户空间和运行可写空间；read_item 带流程", async () => {
    const { app, item } = await setup([stage("a", { by: "wait" })]);
    createUser(app, { id: "member-a", name: "成员甲" }); createSpace(app, { id: "other", name: "项目 A" });
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent", userId: "owner" };
    for (const denied of [{ ...ctx, userId: "member-a" }, { ...ctx, spaces: ["other"] }, { ...ctx, spaces: ["personal"], writable: [] }]) {
      const r = await callTool(denied, "stage_report", { item: item.id, stage: "a", state: "blocked", note: "待权限" }); expect(r.isError).toBe(true);
    }
    expect((await callTool(ctx, "stage_report", { item: item.id, stage: "a", state: "blocked", note: "待权限", waiting_on: "owner" })).isError).toBe(false);
    const read = await callTool(ctx, "read_item", { item_id: item.id }); expect(JSON.parse(read.text).flow.stages[0]).toMatchObject({ state: "blocked", waitingOn: "owner" });
    expect((await callTool(ctx, "list_flows", { item: item.id })).isError).toBe(false);
  });
  it("阶段可访问材料挂的仓库及业务空间，不能访问本人无权读取的仓库", async () => {
    const app = appFor();
    const role = saveRole(app, { id: "delegator", name: "编码交办", scope: "global", permissions: ["code.delegate"] });
    const userId = createUser(app, { id: "member-a", name: "小王", role: role.id }).id;
    createSpace(app, { id: "business", name: "项目 A" });
    for (const id of ["repo-b", "repo-private"]) {
      const rootPath = join(app.home, id);
      mkdirSync(rootPath);
      ensureLibraryRepo(rootPath);
      createSpace(app, { id, name: id, rootPath, ...(id === "repo-b" ? { parentId: "business" } : {}) });
    }
    addMember(app, "business", userId, "editor");
    const item = upsertItem(app, undefined, { title: "核对退款", userId, spaceId: "personal-member-a" }, "user");
    addLocalMaterials(app, item.id, [{ kind: "repo", ref: "repo-b", branch: "main" }, { kind: "repo", ref: "repo-private", branch: "main" }], "owner");
    await startFlow(app, item.id, { stages: [{ id: "work", name: "修改", by: { run: {} }, fixed: false }] }, { actor: "owner", userId });
    await ownerAction(app, item.id, "work", "confirm", "", userId);
    const stageRun = getStage(app, item.id, "work").control.runId!;
    vi.spyOn(runner, "runRole").mockImplementationOnce(async (_app, request) => {
      expect(request.spaces).toEqual([item.spaceId, "repo-b", "business"]);
      const ctx: ToolContext = { app, userId, actor: "agent", role: "assistant", runId: stageRun, spaceId: item.spaceId, spaces: request.spaces!, writable: request.spaces!, tools: null };
      const delegate = (repo: string) => callTool(ctx, "delegate_code", { repo_spaces: [repo], space: "repo-b", item_id: item.id, task: "修复退款说明" });
      const denied = await delegate("repo-private");
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain("空间 repo-private");
      const work = await delegate("repo-b");
      expect(work.isError, work.text).not.toBe(true);
      const code = one<{ id: string }>(app.db, "select id from runs where kind='code' and parent_id=?", stageRun)!;
      expect(getRun(app, code.id).input.repos).toEqual(["repo-b"]);
      expect((await callTool(ctx, "read_run", { run_id: code.id })).isError).not.toBe(true);
      return { text: "已交办", agent: "fake", stopReason: "end_turn", profileId: "fake", ai: { profile: "fake" } };
    });
    await __testHandlers.get("flow-stage")!({ app, run: getRun(app, stageRun), signal: new AbortController().signal, event: () => {}, output: () => {} });
    expect(runner.runRole).toHaveBeenCalledOnce();
  });
  it("save_flow 是待确认草稿，非本人的回答不落盘，启用才保存", async () => {
    const app = appFor(), raw = yaml([stage("a", { by: "owner" })]);
    const a = proposeFlow(app, raw, { actor: "assistant", userId: "owner" });
    expect(a.question).toContain("你来做"); expect(existsSync(join(app.libraryDir, "_flows", "demo.yaml"))).toBe(false);
    await expect(answerAsk(app, a.id, { choice: 0, by: "another" })).rejects.toThrow("主人"); expect(listFlows(app)).toEqual([]);
    const b = proposeFlow(app, raw, { actor: "assistant", userId: "owner" });
    await answerAsk(app, b.id, { choice: 0, by: "owner" }); expect(readFlow(app, "demo").name).toBe("示例交付");
  });
  it("验证阶段：这一段的运行交的用例带着截图进流程视图，同一条只留最新的，没通过和没做的排前面", async () => {
    const { app, item, s } = await setup([stage("verify", { name: "验证", done: "confirm" }), stage("after", { by: "owner" })]);
    const runId = s("verify").control.runId!;
    const inbox = artifactInbox(app, runId);
    mkdirSync(inbox, { recursive: true });
    // A 1×1 PNG stands in for a screenshot.
    writeFileSync(join(inbox, "refund-step.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    const shots = (await collectInbox(app, runId, { source: "agent", by: "assistant" })).made;
    expect(shots).toHaveLength(1);
    recordTests(app, { runId, workId: null, spaceId: "personal", round: 1, by: "assistant", tests: [
      { name: "整单退款到账", status: "failed", mode: "预发 · 测试账号", note: "金额对不上" },
      { name: "部分退款不退运费", status: "passed", mode: "预发 · 测试账号", note: "下单、申请部分退款、看到运费没退", artifacts: shots },
    ] });
    await new Promise((r) => setTimeout(r, 5));
    recordTests(app, { runId, workId: null, spaceId: "personal", round: 1, by: "assistant", tests: [{ name: "整单退款到账", status: "passed", mode: "预发 · 测试账号", note: "重做后金额一致" }, { name: "退款后再下单", status: "skipped", note: "没有可用的账号" }] });
    const view = flowView(app, item.id).stages;
    const tests = view.find((x) => x.id === "verify")!.tests;
    expect(tests.map((t) => [t.name, t.status])).toEqual([["退款后再下单", "skipped"], ["整单退款到账", "passed"], ["部分退款不退运费", "passed"]]);
    expect(tests.find((t) => t.name === "部分退款不退运费")!.artifacts).toEqual([expect.objectContaining({ kind: "image", name: "refund-step.png" })]);
    expect(tests.find((t) => t.name === "整单退款到账")).toMatchObject({ note: "重做后金额一致", mode: "预发 · 测试账号", req: null, runId });
    expect(view.find((x) => x.id === "after")!.tests).toEqual([]);
  });
});
