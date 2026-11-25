import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createUser } from "../src/core/users.ts";
import { cleanupFetched, mergeLibrary, snapshotStream, type Fetched } from "../src/core/pull.ts";
import { pullTables } from "../src/core/pull-data.ts";
import { getAsk, listAsks } from "../src/agents/asks.ts";
import { __testHandlers, getRun, listRuns } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import * as runner from "../src/agents/runner.ts";
import { loadRole } from "../src/agents/runner.ts";
import { appendToSource } from "../src/sources/store.ts";
import { addMaterials } from "../src/items/materials.ts";
import { itemEvents, upsertItem } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { advance, flowView, ownerAction, reopenStage, reportStage, startFlow, stopFlow } from "../src/flows/engine.ts";
import { followContexts } from "../src/flows/follow.ts";
import { coachIfDue, listReviews, reviewStages, storedReview, type ReviewLogRow } from "../src/flows/review.ts";
import { getStage, itemFlow } from "../src/flows/store.ts";

const apps: App[] = [];
const owner = { actor: "owner", userId: "owner" };
const appFor = () => { const app = testApp(); apps.push(app); app.config.flows.autoAdvance = 20; return app; };
const flow = (stages: object[], id = "demo") => YAML.stringify({ id, name: "示例交付", stages });
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});
async function item(app: App, title = "示例商城退款", userId = "owner", flowId = "demo") {
  const i = upsertItem(app, undefined, { title, spaceId: userId === "owner" ? "personal" : `personal-${userId}`, userId }, "user");
  await startFlow(app, i.id, flowId, { actor: "owner", userId });
  return i;
}
/** A finished stage reported by its own run, with that run as evidence. */
async function finish(app: App, itemId: string, stageId: string) {
  const s = getStage(app, itemId, stageId);
  return reportStage(app, itemId, stageId, { state: "done", note: "做完了", evidence: [s.control.runId!] }, { actor: "assistant", runId: s.control.runId! });
}

describe("回顾的计算（纯函数）", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 16, 0, m)).toISOString();
  const row = (stageId: string, m: number, fromState: ReviewLogRow["fromState"], toState: ReviewLogRow["toState"], rest: Partial<ReviewLogRow> = {}): ReviewLogRow => ({ stageId, at: t(m), fromState, toState, actor: "host", note: "", round: 1, waitingOn: null, event: null, ...rest });
  const stages = [{ id: "plan", name: "方案", gate: "confirm" }, { id: "code", name: "编码" }, { id: "push", name: "推送", by: "owner" }];
  const log: ReviewLogRow[] = [
    row("plan", 0, null, "pending"), row("code", 0, null, "pending"), row("push", 0, null, "pending"),
    row("plan", 0, "pending", "gated", { waitingOn: "owner", event: "gate-ask", note: "等本人确认开始" }),
    row("plan", 30, "gated", "pending", { actor: "owner", event: "gate-agree", note: "本人同意开始" }),
    row("plan", 30, "pending", "doing"),
    row("plan", 90, "doing", "doing", { actor: "assistant", waitingOn: "owner", note: "方案交了，等本人确认" }),
    row("plan", 100, "doing", "pending", { actor: "owner", event: "refuse", note: "本人要求重做：补上部分发货" }),
    row("plan", 100, "pending", "doing"),
    row("plan", 160, "doing", "done", { actor: "assistant" }),
    row("code", 160, "pending", "doing"),
    row("code", 170, "doing", "blocked", { waitingOn: "owner", note: "无法开始：缺仓库权限" }),
    row("code", 200, "blocked", "blocked", { waitingOn: "owner", note: "提醒过一次" }),
    row("code", 230, "blocked", "done", { actor: "owner" }),
    row("plan", 240, "done", "pending", { actor: "owner", event: "reopen", note: "范围变了" }),
    row("code", 240, "done", "stale", { actor: "owner", event: "stale" }),
    row("push", 250, "pending", "skipped", { actor: "owner", note: "这次不用推送" }),
  ];
  it("各状态的分钟、等本人的分钟、卡住的原因、返工、跳过和关卡", () => {
    const [plan, code, push] = reviewStages({ stages, log, until: t(300) });
    expect(plan).toMatchObject({ state: "pending", gatedMinutes: 30, doingMinutes: 130, ownerMinutes: 40, starts: 2, refused: 1, reopened: 1, reworks: 2, enteredAt: t(0), doneAt: null });
    expect(plan.gate).toMatchObject({ asked: 1, agreed: 1, direct: true });
    expect(code).toMatchObject({ state: "stale", doingMinutes: 10, blockedMinutes: 60, ownerMinutes: 60, staled: 1, reworks: 0 });
    expect(code.blocks).toEqual([{ at: t(170), minutes: 60, waitingOn: "owner", note: "无法开始：缺仓库权限" }]);
    expect(push).toMatchObject({ state: "skipped", skipped: true, skipNote: "这次不用推送", doneAt: t(250) });
  });
  it("from / until 只裁时长，不裁次数", () => {
    const [plan] = reviewStages({ stages, log, until: t(300), from: t(60) });
    expect(plan).toMatchObject({ gatedMinutes: 0, doingMinutes: 100, refused: 1, starts: 2 });
  });
  it("没有 event / waiting_on 的旧行按状态和宿主的固定说法推断", () => {
    const old = (r: ReviewLogRow) => ({ ...r, event: null, waitingOn: null });
    const [plan, code, push] = reviewStages({ stages, until: t(300), log: [
      ...log.filter((r) => r.toState !== "stale").map(old),
      old(row("push", 250, "skipped", "pending", { actor: "owner", note: "开始第 2 轮" })),
      old(row("push", 260, "pending", "doing", { round: 2 })),
    ] });
    expect(plan).toMatchObject({ refused: 1, reopened: 1, ownerMinutes: 30 });
    expect(plan.gate).toMatchObject({ asked: 1, agreed: 1, direct: true });
    expect(code).toMatchObject({ ownerMinutes: 60 });
    // A new round is not a reopen; the owner's own stage waits on the owner.
    expect(push).toMatchObject({ reopened: 0, ownerMinutes: 40, rounds: 2 });
  });
});

describe("流程结束时存回顾", () => {
  const stages = [{ id: "plan", name: "方案", by: "wait", gate: "confirm" }, { id: "code", name: "编码", by: { run: {} } }, { id: "push", name: "推送", by: "owner" }];
  it("走完：标明怎么结束的，各段的数字、关卡直接同意、返工；事项页能读到", async () => {
    const app = appFor(); saveFlow(app, flow(stages), "owner");
    const i = await item(app);
    await ownerAction(app, i.id, "plan", "confirm");
    await ownerAction(app, i.id, "plan", "done", "方案定了");
    await finish(app, i.id, "code");
    await reopenStage(app, i.id, "code", "评审之后又有提交", [], owner);
    await finish(app, i.id, "code");
    await ownerAction(app, i.id, "push", "skip", "这次不用推送");
    expect(itemFlow(app, i.id)!.endedAt).toBeTruthy();
    const r = storedReview(app, i.id, itemFlow(app, i.id)!.startedAt)!;
    expect(r).toMatchObject({ how: "completed", flowId: "demo", reworks: 1, rounds: 1 });
    const [plan, code, push] = r.stages;
    expect(plan.gate).toMatchObject({ asked: 1, agreed: 1, direct: true });
    expect(plan.streak).toBe(1);
    expect(code).toMatchObject({ starts: 2, reopened: 1, reworks: 1, state: "done" });
    expect(push).toMatchObject({ skipped: true, skipNote: "这次不用推送" });
    expect(flowView(app, i.id).review).toMatchObject({ how: "completed" });
    expect(all(app.db, "select event from item_stage_log where item_id=? and event is not null order by id", i.id).map((x) => (x as { event: string }).event)).toEqual(["gate-ask", "gate-agree", "reopen", "stale"]);
  });
  it("本人停止和事项关闭也存，关闭会结束任何流程", async () => {
    const app = appFor(); saveFlow(app, flow(stages), "owner");
    const stopped = await item(app, "停下的");
    await stopFlow(app, stopped.id);
    expect(storedReview(app, stopped.id, itemFlow(app, stopped.id)!.startedAt)).toMatchObject({ how: "stopped" });
    const closed = await item(app, "关掉的");
    await ownerAction(app, closed.id, "plan", "confirm");
    upsertItem(app, closed.id, { status: "done" }, "user");
    await advance(app, closed.id);
    expect(itemFlow(app, closed.id)!.endedAt).toBeTruthy();
    expect(storedReview(app, closed.id, itemFlow(app, closed.id)!.startedAt)).toMatchObject({ how: "closed" });
    // A flow ended again after a reopen is reviewed again under the same key, not twice.
    await ownerAction(app, stopped.id, "plan", "reopen", "再看一下");
    await stopFlow(app, stopped.id);
    expect(all(app.db, "select how from item_flow_reviews where item_id=?", stopped.id)).toEqual([{ how: "stopped" }]);
  });
  it("回顾随事项拉取", async () => {
    expect(pullTables.find((t) => t.name === "item_flow_reviews")).toMatchObject({ key: ["item_id", "started_at"], newer: "updated_at" });
    const local = testApp(), remote = testApp();
    saveFlow(remote, flow([{ id: "only", name: "唯一", by: "wait" }]), "owner");
    const i = await item(remote); await stopFlow(remote, i.id);
    const dir = mkdtempSync(join(tmpdir(), "omem-snap-test-")), archive = join(dir, "snapshot.tar");
    await pipeline(await snapshotStream(remote), createWriteStream(archive));
    execFileSync("tar", ["-xf", "snapshot.tar"], { cwd: dir }); rmSync(archive);
    const f: Fetched = { dbDir: dir, libraryDir: join(dir, "library"), filesDir: join(dir, "files"), fetchedFiles: readdirSync(join(dir, "files")) };
    try {
      mergeLibrary(local, f);
      expect(one(local.db, "select how,flow_id from item_flow_reviews where item_id=?", i.id)).toEqual({ how: "stopped", flow_id: "demo" });
    } finally {
      cleanupFetched(f); local.db.close(); remote.db.close();
      rmSync(local.home, { recursive: true, force: true }); rmSync(remote.home, { recursive: true, force: true });
    }
  });
});

describe("coach 复盘流程定义", () => {
  const stages = [{ id: "only", name: "唯一", by: "wait" }];
  const reviews = (app: App) => listRuns(app, { kind: "flow-review" });
  async function ended(app: App, title: string, userId = "owner") { const i = await item(app, title, userId); await stopFlow(app, i.id, userId); return i; }
  it("同一份定义又结束满 3 件才起一次；排着的不重复起；失败的下次结束再试；别人的事项不算", async () => {
    const app = appFor(); saveFlow(app, flow(stages), "owner");
    createUser(app, { id: "member", name: "成员甲" });
    await ended(app, "一"); await ended(app, "二");
    await ended(app, "成员的", "member");
    expect(reviews(app)).toHaveLength(0);
    await ended(app, "三");
    expect(reviews(app)).toHaveLength(1);
    const first = reviews(app)[0];
    expect(first).toMatchObject({ kind: "flow-review", input: { flowId: "demo" } });
    expect((first.input.reviews as unknown[]).length).toBe(3);
    await ended(app, "四");
    expect(reviews(app)).toHaveLength(1);
    expect(coachIfDue(app, "demo", "owner")).toBeNull();
    run(app.db, "update runs set status='failed' where id=?", first.id);
    await ended(app, "五");
    const runs = reviews(app);
    expect(runs).toHaveLength(2);
    // The failed run's three, plus the two that ended meanwhile.
    expect((runs.find((r) => r.id !== first.id)!.input.reviews as unknown[]).length).toBe(5);
    expect(all(app.db, "select coach_run from item_flow_reviews where user_id='member'")).toEqual([{ coach_run: null }]);
  });
  it("任务写清是哪份定义、哪几件事和各自的回顾；只能 save_flow 起草或 stay_quiet", async () => {
    const app = appFor(); saveFlow(app, flow(stages), "owner");
    for (const t of ["一", "二", "三"]) await ended(app, `示例商城${t}`);
    const r = reviews(app)[0];
    const role = vi.spyOn(runner, "runRole").mockResolvedValue({ text: "没有反复出现的问题", ai: "example", sessionId: null, profileId: "fake" } as unknown as Awaited<ReturnType<typeof runner.runRole>>);
    run(app.db, "update runs set status='running' where id=?", r.id);
    await __testHandlers.get("flow-review")!({ app, run: getRun(app, r.id), signal: new AbortController().signal, event: () => {}, output: () => {} });
    const input = role.mock.calls[0][1];
    expect(input).toMatchObject({ role: "coach", userId: "owner" });
    expect(input.task).toContain("复盘一份流程定义");
    expect(input.task).toContain("id: demo");
    for (const t of ["一", "二", "三"]) expect(input.task).toContain(`示例商城${t}`);
    expect(input.task).toContain("本人停止");
    expect(input.denyTools).toEqual(expect.arrayContaining(["remember", "propose_profile_change", "propose_repo_lesson"]));
    const coach = loadRole("coach", app);
    expect(coach.tools).toEqual(expect.arrayContaining(["read_flow_reviews", "save_flow", "stay_quiet"]));
    const tools = new Set(coach.tools.filter(t => !input.denyTools!.includes(t)));
    const guide = runner.toolSections(coach.body, tools, true, ["background", r.kind]);
    expect(guide).toContain("## 读流程回顾");
    expect(guide).not.toContain("## 复盘步骤");
  });
  it("coach 的 save_flow 只出等本人启用的草稿；read_flow_reviews 只读自己的", async () => {
    const app = appFor(); saveFlow(app, flow(stages), "owner");
    createUser(app, { id: "member", name: "成员甲" });
    await ended(app, "一"); await ended(app, "成员的", "member");
    const ctx: ToolContext = { app, runId: null, spaceId: "personal", spaces: null, tools: new Set(["save_flow", "read_flow_reviews"]), actor: "agent", role: "coach", userId: "owner" };
    const before = readFileSync(join(app.libraryDir, "_flows", "demo.yaml"), "utf8");
    const draft = await callTool(ctx, "save_flow", { yaml: flow([{ id: "only", name: "唯一", by: "wait", note: "写清要求" }]) });
    expect(draft.isError).toBe(false); expect(draft.text).toContain("等本人确认");
    expect(readFileSync(join(app.libraryDir, "_flows", "demo.yaml"), "utf8")).toBe(before);
    expect(listAsks(app).filter((a) => a.handler === "flow-save" && a.status === "pending")).toHaveLength(1);
    const read = JSON.parse((await callTool(ctx, "read_flow_reviews", { flow: "demo" })).text);
    expect(read.reviews.map((r: { title: string }) => r.title)).toEqual(["一"]);
    expect(listReviews(app, { userId: "member" }).map((r) => r.title)).toEqual(["成员的"]);
    expect(existsSync(join(app.libraryDir, "_flows", "demo.yaml"))).toBe(true);
  });
});

describe("重开上游时正在做的下游", () => {
  const stages = [{ id: "plan", name: "方案", by: "wait" }, { id: "code", name: "编码", by: { run: {} } }, { id: "test", name: "测试", by: "wait" }];
  async function setup() {
    const app = appFor(); saveFlow(app, flow(stages), "owner");
    const i = await item(app);
    await ownerAction(app, i.id, "plan", "done", "方案定了");
    const runId = getStage(app, i.id, "code").control.runId!;
    await reopenStage(app, i.id, "plan", "范围变了：部分发货也退运费", [], owner);
    const s = () => getStage(app, i.id, "code");
    return { app, i, runId, s };
  }
  it("直接取消运行、标待复核、记录缘由，不问本人；上游做完后重新开始", async () => {
    const t = await setup();
    expect(t.s()).toMatchObject({ state: "stale", askId: null });
    expect(listAsks(t.app).filter(ask => ask.status === "pending")).toEqual([]);
    expect(t.s().note).toContain("因为「方案」重开，停下了「编码」，「方案」做完后会重新开始");
    expect(getRun(t.app, t.runId).status).toBe("cancelled");
    expect(getStage(t.app, t.i.id, "test").state).toBe("pending");
    await ownerAction(t.app, t.i.id, "plan", "done", "新方案定了");
    expect(t.s()).toMatchObject({ state: "doing", attempt: 2 });
    expect(getRun(t.app, t.s().control.runId!).input.task).toContain("上游「方案」重开了：范围变了");
  });
  it("本人做的下游只标待复核，不发停下卡片", async () => {
    const app = appFor(); saveFlow(app, flow([stages[0], { id: "publish", name: "发布", by: "owner" }]), "owner");
    const i = await item(app);
    await ownerAction(app, i.id, "plan", "done", "方案定了");
    const askId = getStage(app, i.id, "publish").askId!;
    expect(getStage(app, i.id, "publish")).toMatchObject({ state: "doing", waitingOn: "owner" });
    await reopenStage(app, i.id, "plan", "范围变了", [], owner);
    expect(getStage(app, i.id, "publish")).toMatchObject({ state: "stale", by: "owner", askId: null, attempt: 1 });
    expect(getAsk(app, askId).status).toBe("cancelled");
    expect(listAsks(app).filter(ask => ask.status === "pending")).toEqual([]);
  });
});

describe("上下文跟进：同一个群在两个空间各有一份", () => {
  it("只跟主的那份（事项所在空间的），读那一份自己的行号，只起一批", async () => {
    const app = appFor(); app.config.flows.follow.maxMessages = 1;
    createSpace(app, { id: "proj", name: "项目 A" });
    const i = upsertItem(app, undefined, { title: "示例商城退款", spaceId: "personal" }, "user");
    const mine = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_demo", title: "示例群", lines: ["原来的需求"], meta: { chatId: "oc_demo" } });
    const other = appendToSource(app, { spaceId: "proj", kind: "chat", uri: "lark:oc_demo", title: "示例群", lines: ["别的", "原来的需求"], meta: { chatId: "oc_demo" } });
    run(app.db, "update sources set captured_at='2020-01-01T00:00:00.000Z' where id=?", other.id);
    await addMaterials(app, i.id, [{ kind: "source", ref: other.id }, { kind: "source", ref: mine.id }], "owner");
    saveFlow(app, flow([{ id: "code", name: "编码", by: "wait" }]), "owner");
    await startFlow(app, i.id, "demo", owner);
    expect(flowView(app, i.id).follow.map((p) => p.sourceId)).toEqual([mine.id]);
    // The newest write went to the other copy (lark_messages.source_id); this copy has the message at its own line.
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_demo", title: "示例群", lines: ["小王：部分发货也退运费"] });
    run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_kind,sender_name,content,create_ms) values('m2','oc_demo',?,3,'user','小王','部分发货也退运费',?)", other.id, Date.now() + 1);
    run(app.db, "insert into lark_message_lines(source_id,message_id,line) values(?,?,2),(?,?,3)", mine.id, "m2", other.id, "m2");
    await followContexts(app);
    const batches = listRuns(app, { kind: "item-follow" });
    expect(batches).toHaveLength(1);
    expect((batches[0].input.batch as { parts: { source: string; from: number }[] }).parts).toEqual([expect.objectContaining({ source: mine.id, from: 2 })]);
    expect(all(app.db, "select source_id from item_follow_cursors where item_id=?", i.id)).toEqual([{ source_id: mine.id }]);
  });
  it("事项所在空间没有时，选本人可写、最早建立的那份", async () => {
    const app = appFor();
    createSpace(app, { id: "proj", name: "项目 A" }); createSpace(app, { id: "proj-b", name: "项目 B" });
    const i = upsertItem(app, undefined, { title: "示例商城退款", spaceId: "personal" }, "user");
    const a = appendToSource(app, { spaceId: "proj", kind: "doc", uri: "lark:doc:demo", title: "需求文档", lines: ["第一版"] });
    const b = appendToSource(app, { spaceId: "proj-b", kind: "doc", uri: "lark:doc:demo", title: "需求文档", lines: ["第一版"] });
    run(app.db, "update sources set captured_at='2020-01-01T00:00:00.000Z' where id=?", b.id);
    await addMaterials(app, i.id, [{ kind: "source", ref: a.id }, { kind: "source", ref: b.id }], "owner");
    saveFlow(app, flow([{ id: "code", name: "编码", by: "wait" }]), "owner");
    await startFlow(app, i.id, "demo", owner);
    expect(flowView(app, i.id).follow.map((p) => p.sourceId)).toEqual([b.id]);
  });
});
