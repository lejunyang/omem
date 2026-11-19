import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { run } from "../src/core/db.ts";
import { upsertItem } from "../src/items/store.ts";
import { describeFlow, describeStage, parseFlow, saveFlow } from "../src/flows/definitions.ts";
import { advance, flowReminders, flowView, ownerAction, proposeFlow, reportStage, startFlow, startRound, stopFlow, updateStageBudget } from "../src/flows/engine.ts";
import { getStage, itemFlow, stageLog } from "../src/flows/store.ts";
import { __testHandlers, getRun, trackAbort } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { markOutOfQuota } from "../src/agents/capacity.ts";

const apps: App[] = [];
const owner = { actor: "owner", userId: "owner" };
const raw = (stages: object[], extra = {}) => YAML.stringify({ id: "rounds", name: "示例探索", ...extra, stages });
const stage = (id: string, extra = {}) => ({ id, name: id, by: "wait", ...extra });
const work = (extra = {}) => stage("work", { by: { run: {} }, ...extra });
async function setup(stages: object[], extra = {}, configure?: (app: App) => void) {
  const app = testApp(); apps.push(app); app.config.timezone = "UTC"; configure?.(app);
  const item = upsertItem(app, undefined, { title: "示例商城探索", spaceId: "personal" }, "user");
  saveFlow(app, raw(stages, extra), "user");
  await startFlow(app, item.id, "rounds", owner);
  return { app, id: item.id, s: (id = "work") => getStage(app, item.id, id) };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-15T12:00:00Z")); });
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  for (const a of apps.splice(0)) { a.db.close(); rmSync(a.home, { recursive: true, force: true }); }
});
const finish = (app: App, id: string, stage = "work") => ownerAction(app, id, stage, "done", "已经核验");

describe("流程轮次", () => {
  it("默认手动：三轮保留结果，只做一次的阶段不重做，不能重叠，停止后不开新轮", async () => {
    const { app, id, s } = await setup([stage("once"), stage("work")], { repeat: { from: "work" } });
    await expect(startRound(app, id, owner)).rejects.toThrow("还没做完");
    await finish(app, id, "once"); await finish(app, id);
    expect(flowView(app, id).flow).toMatchObject({ round: 1, endedAt: null, canStartRound: true, nextRoundAt: null, repeat: { every: "manual" } });
    await flowReminders(app, new Date("2026-11-20T00:00:00Z")); expect(itemFlow(app, id)!.round).toBe(1);
    for (let round = 2; round <= 3; round++) {
      await startRound(app, id, owner);
      expect(s("once")).toMatchObject({ state: "done", round: 1, attempt: 1 });
      expect(s()).toMatchObject({ state: "doing", round, attempt: 1 });
      await finish(app, id);
    }
    const view = flowView(app, id);
    expect(view.rounds.map((r) => r.round)).toEqual([3, 2, 1]);
    expect(view.rounds[2].stages[1]).toMatchObject({ state: "done", doneAt: expect.any(String), note: "已经核验", evidence: [] });
    expect(stageLog(app, id).some((l) => l.round === 2 && l.toState === "doing")).toBe(true);
    await stopFlow(app, id); await expect(startRound(app, id, owner)).rejects.toThrow("进行中");
  });
  it("只返回最近十轮，历史阶段的依据与备注不受新轮影响", async () => {
    const { app, id } = await setup([work()], { repeat: { from: "work" } });
    const first = getStage(app, id, "work").by!;
    await reportStage(app, id, "work", { state: "done", note: "查到原运行", evidence: [first] }, { actor: "assistant", runId: first });
    for (let i = 0; i < 10; i++) { await startRound(app, id, owner); await finish(app, id); }
    expect(flowView(app, id).rounds.map((r) => r.round)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  });
  it("done 自动转，自动开始达到上限后先问本人", async () => {
    const { app, id, s } = await setup([stage("work")], { repeat: { from: "work", every: "done" } }, (a) => { a.config.flows.autoAdvance = 1; });
    // An agent completion does not reset the unattended streak.
    await reportStage(app, id, "work", { state: "skip", note: "本轮不需要" }, { actor: "assistant" });
    expect(itemFlow(app, id)!.round).toBe(2); expect(s()).toMatchObject({ state: "gated", attempt: 0 });
    expect(s().askId).toBeTruthy();
    await flowReminders(app); expect(itemFlow(app, id)!.round).toBe(2);
  });
  it.each([{ every: "day" }, { every: ["tue", "fri"] }])("$every 到下一天才开，过期只开一轮，上一轮没完不开新轮", async ({ every }) => {
    const { app, id, s } = await setup([stage("work")], { repeat: { from: "work", every } });
    await flowReminders(app, new Date("2026-12-01T12:00:00Z")); expect(itemFlow(app, id)!.round).toBe(1);
    await finish(app, id);
    const expected = every === "day" ? "2026-11-16T00:00:00.000Z" : "2026-11-17T00:00:00.000Z";
    expect(itemFlow(app, id)!.nextRoundAt).toBe(expected);
    await flowReminders(app, new Date(Date.parse(expected) - 1)); expect(itemFlow(app, id)!.round).toBe(1);
    await flowReminders(app, new Date("2026-12-01T12:00:00Z"));
    expect(itemFlow(app, id)!.round).toBe(2); expect(s().state).toBe("doing");
    await flowReminders(app, new Date("2026-12-09T12:00:00Z")); expect(itemFlow(app, id)!.round).toBe(2);
  });
  it("flow_start 不传 flow 开下一轮，按事项主人和可写范围检查", async () => {
    const { app, id } = await setup([stage("work")], { repeat: { from: "work" } }); await finish(app, id);
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: ["personal"], writable: ["personal"], tools: new Set(["flow_start"]), actor: "agent", userId: "owner" };
    for (const denied of [{ ...ctx, userId: "another" }, { ...ctx, writable: [] }, { ...ctx, spaces: ["other"] }]) expect((await callTool(denied, "flow_start", { item: id })).isError).toBe(true);
    expect((await callTool(ctx, "flow_start", { item: id })).isError).toBe(false); expect(itemFlow(app, id)!.round).toBe(2);
  });
  it("错过星期日程后等下一个符合日，不在周三补跑周二", async () => {
    const { app, id } = await setup([stage("work")], { repeat: { from: "work", every: ["tue", "fri"] } });
    await finish(app, id);
    await flowReminders(app, new Date("2026-11-18T12:00Z"));
    expect(itemFlow(app, id)).toMatchObject({ round: 1, nextRoundAt: "2026-11-20T00:00:00.000Z" });
    await flowReminders(app, new Date("2026-11-20T08:00Z")); expect(itemFlow(app, id)!.round).toBe(2);
  });
});

const ai = (app: App) => {
  app.config.agents.profiles.push(agentProfileSchema.parse({ id: "test-model", transport: "acp", command: "node", model: "small" }));
  app.config.agents.tiers = { cheap: { profile: "test-model", model: "small", effort: "low" }, strong: { profile: "test-model", model: "large", effort: "high" } };
};
describe("档位、预算与升档", () => {
  it("档位转成带流程来源和原因的 execution，未配置一轮只记一次，可重开", async () => {
    const a = await setup([work({ ai: "cheap" })], {}, ai);
    expect(getRun(a.app, a.s().by!).input.execution).toEqual({ profile: "test-model", model: "small", effort: "low", source: "flow", reason: "流程「示例探索」的「work」阶段指定" });
    const b = await setup([work({ ai: "strong" })]);
    expect(getRun(b.app, b.s().by!).input).toMatchObject({ ownAI: true });
    await advance(b.app, b.id); await ownerAction(b.app, b.id, "work", "reopen", "再核验"); await advance(b.app, b.id);
    expect(stageLog(b.app, b.id).filter((l) => l.note === "档位 strong 没有配置，用了默认的 AI")).toHaveLength(1);
  });
  it("流程指定的 AI 失败时不尝试更贵的 fallback", async () => {
    const { app } = await setup([work({ ai: "cheap" })], {}, ai);
    app.baseUrl = "http://127.0.0.1:1";
    app.config.agents.fallback = [{ profile: "test-model", model: "large" }];
    const dispatch = await import("../src/agents/dispatch.ts"), { runRole } = await import("../src/agents/runner.ts");
    const backend = vi.spyOn(dispatch, "runBackend").mockRejectedValue(new Error("usage limit reached"));
    await expect(runRole(app, { role: "assistant", spaceId: "personal", spaces: ["personal"], task: "只核验示例材料", runId: null, execution: { profile: "test-model", model: "small", source: "flow", reason: "流程阶段指定" } })).rejects.toThrow("usage limit");
    expect(backend).toHaveBeenCalledTimes(1); expect(backend.mock.calls[0][1].model).toBe("small");
  });
  it("指定后端不可用时卡住；每日额度与账号额度用完留 pending，到重置再开", async () => {
    const a = await setup([work({ ai: { profile: "missing" } })]); expect(a.s()).toMatchObject({ state: "blocked", waitingOn: "owner" }); expect(a.s().note).toContain("不可用");
    const b = await setup([work({ ai: "cheap" })], {}, (app) => { ai(app); app.config.agents.capacity.limits = [{ profile: "test-model", model: "small", max: 3, perDay: 0 }]; });
    expect(b.s()).toMatchObject({ state: "pending", attempt: 0, waitingOn: "time", control: { waitUntil: "2026-11-16T00:00:00.000Z" } });
    expect(b.s().note).toContain("模型额度用完");
    b.app.config.agents.capacity.limits[0].perDay = 1;
    await flowReminders(b.app, new Date("2026-11-16T00:00:00Z")); expect(b.s().state).toBe("doing");
    const c = await setup([work({ ai: "cheap" })], {}, (app) => { ai(app); markOutOfQuota(app, app.config.agents.profiles[0], "usage limit; try again tomorrow"); });
    expect(c.s().state).toBe("pending");
    const reset = c.s().control.waitUntil!;
    await flowReminders(c.app, new Date(Date.parse(reset) + 1)); expect(c.s().state).toBe("doing");
  });
  it.each(["window", "quota"])("排队期间 %s 变化时，worker 放回未开始，下一次巡检再看", async (mode) => {
    const { app, id, s } = await setup([work({ ai: "cheap", window: "11:00-13:00" })], {}, ai);
    const old = getRun(app, s().by!);
    if (mode === "window") vi.setSystemTime(new Date("2026-11-15T14:00Z"));
    else app.config.agents.capacity.limits = [{ profile: "test-model", model: "small", max: 3, perDay: 0 }];
    await __testHandlers.get("flow-stage")!({ app, run: old, signal: new AbortController().signal, event() {}, output() {} });
    expect(s()).toMatchObject({ state: "pending", attempt: 0 }); expect(s().control.runId).toBeUndefined();
    const retry = s().control.waitUntil!;
    app.config.agents.capacity.limits = [];
    vi.setSystemTime(new Date(mode === "window" ? retry : "2026-11-16T11:00Z"));
    await flowReminders(app);
    expect(s()).toMatchObject({ state: "doing", attempt: 1 }); expect(s().by).not.toBe(old.id);
  });
  it("运行返回额度用尽时也等待原模型，不把额度错误当成升档理由", async () => {
    const { app, id, s } = await setup([work({ ai: "cheap", escalate: { to: "strong", max: 2 } })], {}, ai);
    const old = s().by!;
    markOutOfQuota(app, app.config.agents.profiles[0], "usage limit; try again tomorrow");
    run(app.db, "update runs set status='failed',error='usage limit reached',finished_at=? where id=?", new Date().toISOString(), old);
    await advance(app, id);
    expect(s()).toMatchObject({ state: "pending", waitingOn: "time" }); expect(s().control.escalations ?? 0).toBe(0);
    await flowReminders(app, new Date(Date.parse(s().control.waitUntil!) + 1));
    expect(s().state).toBe("doing"); expect(getRun(app, s().by!).input.execution).toMatchObject({ model: "small" });
  });
  it("预算由巡检取消运行并卡住，不因 window 结束而停止；副本可改，不动模板", async () => {
    const { app, id, s } = await setup([work({ budget: { minutes: 240, trials: 8 }, ai: "cheap", escalate: { to: "strong", max: 2 }, window: "11:00-13:00" })], {}, ai);
    const r = s().by!, controller = new AbortController(); const untrack = trackAbort(r, controller);
    run(app.db, "update runs set status='running' where id=?", r);
    await flowReminders(app, new Date("2026-11-15T15:00:00Z")); expect(controller.signal.aborted).toBe(false);
    await flowReminders(app, new Date("2026-11-15T16:00:00Z")); expect(controller.signal.aborted).toBe(true);
    expect(s()).toMatchObject({ state: "blocked", waitingOn: "owner", note: "到了这一段的时间预算（240 分钟）" }); untrack();
    await expect(reportStage(app, id, "work", { state: "done", note: "迟到的结果", evidence: [r] }, { actor: "assistant", runId: r })).rejects.toThrow("时间预算");
    await expect(updateStageBudget(app, id, "work", { budget: { minutes: 10 } }, "another")).rejects.toThrow("本人");
    await updateStageBudget(app, id, "work", { budget: { minutes: 300, trials: 4 }, escalate: { max: 1 } }, "owner");
    expect(flowView(app, id).stages[0]).toMatchObject({ budget: { minutes: 300, trials: 4 }, escalate: { max: 1 }, usedMinutes: 240 });
  });
  it.each(["terminal", "unsure"])("%s 升档带反馈重做，用完卡住，下一轮重新计数", async (mode) => {
    const { app, id, s } = await setup([work({ ai: "cheap", escalate: { to: "strong", max: 1 } })], { repeat: { from: "work" } }, ai);
    const old = s().by!;
    if (mode === "terminal") { run(app.db, "update runs set status='done',finished_at=?,output=? where id=?", new Date().toISOString(), JSON.stringify({ text: "材料不足以定论" }), old); await advance(app, id); }
    else await reportStage(app, id, "work", { state: "blocked", unsure: true, note: "要不要继续定不下来" }, { actor: "assistant", runId: old });
    expect(s()).toMatchObject({ state: "doing", attempt: 2, control: { escalations: 1 } });
    expect(getRun(app, s().by!).input.execution).toMatchObject({ model: "large", effort: "high" });
    expect(getRun(app, s().by!).input.task).toContain(mode === "terminal" ? "没有交代结果" : "要不要继续定不下来");
    if (mode === "terminal") expect(getRun(app, s().by!).input.task).toContain("材料不足以定论");
    await expect(reportStage(app, id, "work", { state: "done", note: "旧结果", evidence: [old] }, { actor: "assistant", runId: old })).rejects.toThrow("当前阶段");
    await reportStage(app, id, "work", { state: "blocked", unsure: true, note: "仍拿不准" }, { actor: "assistant", runId: s().by! }); expect(s().state).toBe("blocked");
    await ownerAction(app, id, "work", "reopen", "再核对一次");
    expect(s().control.escalations).toBe(1); expect(getRun(app, s().by!).input.execution).toMatchObject({ model: "small" });
    await reportStage(app, id, "work", { state: "blocked", unsure: true, note: "仍然不确定" }, { actor: "assistant", runId: s().by! }); expect(s().state).toBe("blocked");
    await finish(app, id); await startRound(app, id, owner); expect(s()).toMatchObject({ state: "doing", attempt: 1 }); expect(s().control.escalations ?? 0).toBe(0);
    expect(getRun(app, s().by!).input.execution).toMatchObject({ model: "small" });
  });
  it("字段校验给中文原因，预览和确认卡片带轮次、模型、时间、预算", () => {
    for (const [stages, extra, message] of [
      [[stage("work", { ai: "strong" })], {}, "指定 AI 只适用于"],
      [[stage("work")], { repeat: { from: "missing" } }, "清单里的阶段"],
      [[work({ window: "25:00-06:00" })], {}, "时间段必须"],
      [[work({ at: "24:00" })], {}, "时刻必须"],
      [[work({ escalate: { to: "strong", max: 1 } })], {}, "写了 ai"],
      [[stage("work", { budget: { minutes: 5 } })], {}, "时间预算只适用于"],
    ] as const) expect(() => parseFlow(raw([...stages], extra))).toThrow(message);
    const yaml = raw([work({ ai: "cheap", escalate: { to: "strong", max: 2 }, at: "10:00", window: "23:00-05:00", budget: { minutes: 240, trials: 8 } })], { repeat: { from: "work", every: ["tue", "fri"] } });
    const f = parseFlow(yaml); expect(describeFlow(f)).toContain("每周二、周五");
    expect(describeStage(f.stages[0])).toMatchObject({ ai: "用省的模型；拿不准时最多请好的模型看 2 次", time: "这一轮 10:00 以后开始；只在 23:00–05:00 之间开始", budget: "最多跑 240 分钟" });
    const app = testApp(); apps.push(app); const card = proposeFlow(app, yaml, owner).question;
    for (const text of ["每周二、周五", "用省的模型", "最多跑 240 分钟", "10:00 以后开始"]) expect(card).toContain(text);
  });
});
