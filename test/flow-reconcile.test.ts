import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { one, run } from "../src/core/db.ts";
import { getRun, listRuns, __testHandlers } from "../src/agents/runs.ts";
import { answerAsk, createAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { getItem, upsertItem } from "../src/items/store.ts";
import { addMaterials } from "../src/items/materials.ts";
import { addChange } from "../src/items/changes.ts";
import { pendingActions } from "../src/items/pending.ts";
import { appendToSource, upsertSource } from "../src/sources/store.ts";
import { listFlows, saveFlow } from "../src/flows/definitions.ts";
import { flowView, reportStage, startFlow, ownerAction } from "../src/flows/engine.ts";
import { getStage, itemFlow, stageLog } from "../src/flows/store.ts";
import { itemFollowLane, queueReconcile, reconcileReminder } from "../src/flows/reconcile.ts";
import * as runner from "../src/agents/runner.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { startServer } from "../src/server/http.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { setItemListening } from "../src/channels/listen-items.ts";
import { attachObject } from "../src/flows/plugin-objects.ts";
import { forgetPlugin, loadPlugins, trustPlugin } from "../src/plugins/registry.ts";
import { pluginStore } from "../src/plugins/store.ts";
import { testApp } from "./helpers.ts";
import type { InlineStart } from "../src/flows/inline.ts";

const apps: App[] = [], owner = { actor: "owner", userId: "owner" };
const HOUR = 3600_000;
const wait = (id = "verify", extra = {}): InlineStart["stages"][number] => ({ id, name: id, by: "wait", fixed: false, ...extra });
async function setup(stages = [wait()]) {
  const app = testApp(); apps.push(app);
  const item = upsertItem(app, undefined, { title: "项目 A 缺陷" }, "user");
  await startFlow(app, item.id, { stages }, owner);
  const s = (id = "verify") => getStage(app, item.id, id);
  return { app, item, s, clock: (hours: number) => new Date(Date.now() + hours * HOUR) };
}
function signal(app: App) { return one<{ outcome: string }>(app.db, "select outcome from flow_signals where type='reconcile' order by id desc limit 1")?.outcome; }
async function execute(app: App, r: NonNullable<ReturnType<typeof queueReconcile>>, actions: (ctx: ToolContext, task: string) => Promise<void>) {
  vi.spyOn(runner, "runRole").mockImplementationOnce(async (_app, req) => {
    expect(req.role).toBe("flow-reconcile");
    await actions({ app, spaceId: "personal", tools: null, actor: "agent", role: "flow-reconcile", runId: r.id, spaces: ["personal"], userId: "owner" }, req.task);
    return { text: "已核对", agent: "fake", stopReason: "end_turn", profileId: "fake", ai: { profile: "fake" } };
  });
  run(app.db, "update runs set status='running' where id=?", r.id);
  const handler = __testHandlers.get("flow-reconcile")!;
  await handler({ app, run: getRun(app, r.id), signal: new AbortController().signal, event: () => {}, output: () => {} });
  run(app.db, "update runs set status='done' where id=?", r.id);
}
const call = (ctx: ToolContext, name: string, args: object) => callTool(ctx, name, args);
afterEach(async () => {
  setLarkClient(null);
  vi.restoreAllMocks();
  await new Promise(setImmediate); await new Promise(setImmediate);
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

it("安静的不排，材料变化和关联群新消息会排，同事项每六小时最多一次", async () => {
  const { app, item, clock } = await setup();
  expect(queueReconcile(app, item.id, clock(1))).toBeUndefined();
  const src = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_example", title: "项目 A", lines: ["[小王] 看过了"] });
  await addMaterials(app, item.id, [{ kind: "source", ref: src.id }], "owner");
  // When the clock and the DB land within one millisecond, the new link still belongs to a later patrol.
  run(app.db, "update item_materials set created_at=? where item_id=?", clock(0.01).toISOString(), item.id);
  const first = queueReconcile(app, item.id, clock(1))!;
  expect(first.lane).toBe(itemFollowLane(item.id));
  await execute(app, first, async (ctx) => { expect((await call(ctx, "submit_flow_reconcile", { item: item.id, summary: "读了材料，没有变化" })).isError).not.toBe(true); });
  expect(signal(app)).toBe("读了材料，没有变化");
  run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_name,content,create_ms) values('om_new','oc_example',?,1,'小王','回归通过',?)", src.id, clock(2).getTime());
  expect(queueReconcile(app, item.id, clock(5))).toBeUndefined();
  run(app.db, "update item_stages set since=? where item_id=?", clock(7).toISOString(), item.id);
  const next = queueReconcile(app, item.id, clock(8))!;
  app.config.flows.follow.maxRunsPerDay = 1;
  await execute(app, next, async (ctx, task) => {
    expect(task).toContain(`src:${src.id}#L1`);
    await call(ctx, "submit_flow_reconcile", { item: item.id, summary: "已核对群消息" });
  });
  expect(listRuns(app, { kind: "flow-reconcile" })).toHaveLength(2);
});

it("新事项变化不需要等阶段超时", async () => {
  const { app, item, clock } = await setup();
  expect(queueReconcile(app, item.id, clock(1))).toBeUndefined();
  const c = addChange(app, { itemId: item.id, type: "result", origin: "owner", summary: "项目 A 已复测" });
  run(app.db, "update item_changes set updated_at=? where id=?", clock(0.5).toISOString(), c!);
  expect(queueReconcile(app, item.id, clock(1))?.kind).toBe("flow-reconcile");
});

it("仅阶段停满六小时也排队；和上下文跟进共用当日上限", async () => {
  const { app, item, clock } = await setup();
  app.config.timezone = "UTC";
  app.config.flows.follow.maxRunsPerDay = 1;
  const at = clock(7);
  run(app.db, "insert into flow_signals(at,type,keys,item_id,stage_id,outcome) values(?,'context.batch',?,?,'','已提炼')", at.toISOString(), JSON.stringify({ runId: "fake" }), item.id);
  expect(queueReconcile(app, item.id, at)).toBeUndefined();
  expect(queueReconcile(app, item.id, new Date(at.getTime() + 26 * HOUR))?.kind).toBe("flow-reconcile");
});

it("核对回归后推进普通阶段，完成确认卡补证据仍等本人，开始关卡也不由对账通过", async () => {
  const { app, item, s, clock } = await setup([wait(), wait("accept", { done: "confirm", needs: [] }), wait("publish", { effect: "external", needs: ["verify"] })]);
  const src = upsertSource(app, { spaceId: "personal", kind: "note", uri: "demo:result", title: "验证记录", text: "小王复测通过" });
  const evidence = [`src:${src.id}#L1`];
  const rid = queueReconcile(app, item.id, clock(7))!;
  await execute(app, rid, async (ctx) => {
    const report = (stage: string, state: string, refs = evidence) => call(ctx, "stage_report", { item: item.id, stage, state, note: "小王复测通过", evidence: refs });
    expect((await report("verify", "done", [])).isError).toBe(true);
    expect((await report("accept", "done")).isError).not.toBe(true);
    expect((await report("verify", "done")).isError).not.toBe(true);
    // The newly gated downstream wasn't in that state at the start of this check.
    expect((await report("publish", "done")).isError).toBe(true);
    expect((await call(ctx, "submit_flow_reconcile", { item: item.id, summary: "验证已通过，验收与发布等本人" })).isError).not.toBe(true);
  });
  expect(s().state).toBe("done");
  expect(s("accept").state).toBe("doing");
  expect(getAsk(app, s("accept").askId!).question).toContain("小王复测通过");
  expect(s("publish").state).toBe("gated");
  const gateAsk = s("publish").askId!;
  await execute(app, queueReconcile(app, item.id, clock(14))!, async (ctx) => {
    expect((await call(ctx, "stage_report", { item: item.id, stage: "publish", state: "skip", note: "已经发布", evidence })).isError).toBe(true);
    expect((await call(ctx, "stage_report", { item: item.id, stage: "publish", state: "done", note: "发现试发记录，需本人确认", evidence })).isError).not.toBe(true);
    await call(ctx, "submit_flow_reconcile", { item: item.id, summary: "补了试发记录" });
  });
  expect(s("publish")).toMatchObject({ state: "gated", askId: gateAsk });
  const gateCard = getAsk(app, gateAsk);
  expect(gateCard.question).toContain("对账查到的依据");
  const confirmed = gateCard.options.findIndex(o => o.label === "确认已做完");
  expect(confirmed).toBeGreaterThan(0);
  await expect(answerAsk(app, gateAsk, { by: "other", choice: confirmed })).rejects.toThrow();
  await answerAsk(app, gateAsk, { by: "owner", choice: confirmed });
  expect(s("publish").state).toBe("done");
  expect(s("publish").enteredAt).toBeNull();
  expect(getAsk(app, s("accept").askId!).status).toBe("pending");
  await answerAsk(app, s("accept").askId!, { by: "owner", choice: 0 });
  expect(s("accept").state).toBe("done");
  expect(stageLog(app, item.id).some(l => l.runId === rid.id && l.toState === "done")).toBe(true);
});

it("卡住先留可处理的草稿；提醒带最近结论，流程进展后撤回旧卡片", async () => {
  const { app, item, s, clock } = await setup();
  await reportStage(app, item.id, "verify", { state: "blocked", waitingOn: "小王", note: "缺少复测结果" }, owner);
  const rid = queueReconcile(app, item.id, clock(7))!;
  await execute(app, rid, async (ctx) => {
    expect((await call(ctx, "submit_flow_reconcile", { item: item.id, summary: "未找到复测记录", steps: [{ stage: "verify", action: "请贴复测记录的链接", person: "小王", draft: "小王，能发一下项目 A 的复测记录吗？" }] })).isError).not.toBe(true);
  });
  expect(s().state).toBe("blocked");
  const card = (await pendingActions(app, "owner")).find(a => a.via === "ask" && a.title.includes("请贴复测记录"))!;
  expect(getAsk(app, card.askId!).question).toContain("小王，能发一下");
  expect(reconcileReminder(app, itemFlow(app, item.id)!, s())).toContain("最小一步：请贴复测记录的链接");
  await ownerAction(app, item.id, "verify", "done", "已经复测", "owner");
  expect(getAsk(app, card.askId!).status).toBe("cancelled");
});

it.each([true, false])("有证据则直接停止循环第 2 轮（关闭事项=%s），撤回卡片和取消排队阶段", async closeItem => {
  const app = testApp(); apps.push(app);
  app.config.flows.autoAdvance = 20;
  const item = upsertItem(app, undefined, { title: "项目 A 评审" }, "user");
  const source = upsertSource(app, { spaceId: "personal", kind: "note", uri: "fixture:release", title: "发布记录", text: "两组合并请求已合并并上线" });
  saveFlow(app, YAML.stringify({ id: "loop", name: "评审", repeat: { from: "start", every: "done" }, stages: [
    { id: "start", name: "发起评审", by: "wait", gate: "confirm" },
    { id: "work", name: "核对分支", by: { run: {} }, needs: [] },
    { id: "last", name: "等作者", by: "wait", needs: [] },
  ] }), "owner");
  await startFlow(app, item.id, "loop", owner);
  for (const id of ["start", "work", "last"]) await ownerAction(app, item.id, id, "done", "第一轮已做完");
  expect(itemFlow(app, item.id)?.round).toBe(2);
  const gate = getStage(app, item.id, "start").askId!;
  const work = getStage(app, item.id, "work").control.runId!;
  const runAsk = createAsk(app, { runId: work, userId: "owner", question: "继续核对这条分支？", options: [{ label: "继续" }] });
  await reportStage(app, item.id, "last", { state: "blocked", note: "等作者更新" }, owner);
  const first = queueReconcile(app, item.id, new Date(Date.now() + 8 * HOUR))!;
  await execute(app, first, async ctx => {
    expect((await call(ctx, "submit_flow_reconcile", { item: item.id, summary: "缺记录", steps: [{ stage: "last", action: "补查发布记录" }] })).isError).not.toBe(true);
  });
  const nextAsk = listAsks(app).find(ask => ask.handler === "flow-reconcile-step")!;
  const finishRun = queueReconcile(app, item.id, new Date(Date.now() + 16 * HOUR))!;
  await execute(app, finishRun, async ctx => {
    const submit = (evidence: string[]) => call(ctx, "submit_flow_reconcile", { item: item.id, summary: "评审目的已达到", finish: { reason: "两组改动均已合并并上线", evidence, close_item: closeItem } });
    for (const evidence of [[], [`src:${source.id}#L99`], ["object:fo_unread"]]) expect((await submit(evidence)).isError).toBe(true);
    expect(itemFlow(app, item.id)?.endedAt).toBeNull();
    expect((await submit([`src:${source.id}#L1`])).isError).not.toBe(true);
  });
  expect(itemFlow(app, item.id)).toMatchObject({ round: 2, endedAt: expect.any(String), nextRoundAt: null });
  expect(getItem(app, item.id).status).toBe(closeItem ? "done" : "open");
  expect(getRun(app, work).status).toBe("cancelled");
  for (const id of [gate, nextAsk.id, runAsk.id]) expect(getAsk(app, id).status).toBe("cancelled");
  expect(listAsks(app).filter(ask => ask.status === "pending")).toEqual([]);
  expect(getStage(app, item.id, "start")).toMatchObject({ askId: null, waitingOn: null });
  const notice = one<{ body: string; urgency: string }>(app.db, "select body,json_extract(context,'$.urgency') urgency from notifications where title like '已收口：%'");
  expect(notice).toMatchObject({ urgency: "later", body: expect.stringContaining(`[看原文](src:${source.id}#L1)`) });
  expect(notice?.body).toContain(closeItem ? "事项已标为完成" : "事项仍保留，未关闭");
  expect(signal(app)).toContain("评审目的已达到");
});

it.each([[true, "none"], [false, "none"], [true, "auto"]] as const)("关联群草稿：机器人在群=%s，关注档=%s", async (member, reply) => {
  const { app, item, clock } = await setup();
  const chat = "oc_example_group";
  const source = appendToSource(app, { spaceId: "personal", kind: "chat", uri: `lark:${chat}`, title: "示例群", lines: ["[小王] 待补复测"] });
  await addMaterials(app, item.id, [{ kind: "source", ref: source.id }], "owner");
  setItemListening(app, item.id, true, { reply });
  const sent = vi.fn(async (_request: { data: { receive_id: string; content: string } }) => ({ code: 0, data: { message_id: "om_example" } }));
  const membership = vi.fn(async () => ({ code: 0, data: { is_in_chat: member } }));
  setLarkClient({ im: { message: { create: sent }, chatMembers: { isInChat: membership } } });
  await reportStage(app, item.id, "verify", { state: "blocked", waitingOn: "小王", note: "没有复测结果" }, owner);
  const draft = "小王，能发一下复测记录吗？";
  await execute(app, queueReconcile(app, item.id, clock(8))!, async ctx => {
    expect((await call(ctx, "submit_flow_reconcile", { item: item.id, summary: "需要补充复测记录", steps: [{ stage: "verify", action: "请发复测记录", person: "小王", draft, chat }] })).isError).not.toBe(true);
  });
  const card = listAsks(app).find(ask => ask.handler === "flow-reconcile-step");
  const deliveries = () => sent.mock.calls.map(([request]) => request).filter(request => request.data.receive_id === chat);
  if (reply === "auto") { expect(card).toBeUndefined(); expect(deliveries()).toHaveLength(1); return; }
  expect(deliveries()).toHaveLength(0);
  expect(card?.options.map(option => option.label)).toEqual([...(member ? ["把草稿发到群里"] : []), "我已处理", "先不处理"]);
  if (member) {
    await answerAsk(app, card!.id, { by: "owner", choice: 0 });
    expect(deliveries()).toHaveLength(1);
    expect(deliveries()[0].data.content).toContain(draft);
  } else {
    expect(card?.question).toContain("机器人不在这个群，发不了");
    await answerAsk(app, card!.id, { by: "owner", choice: 0 });
    expect(deliveries()).toHaveLength(0);
  }
});

it("内联清单复用前提校验与推进，强制外部动作确认，走完才建议存成模板", async () => {
  const app = testApp(); apps.push(app);
  const item = upsertItem(app, undefined, { title: "处理项目 A 单据" }, "user");
  const ctx: ToolContext = { app, spaceId: "personal", tools: null, runId: null, actor: "agent", role: "assistant", spaces: ["personal"], userId: "owner" };
  const start = (stages: object[]) => call(ctx, "flow_start", { item: item.id, stages });
  expect((await start([wait("x", { needs: ["y"] }), wait("y")])).isError).toBe(true);
  expect((await start([wait("x"), wait("x")])).isError).toBe(true);
  expect(itemFlow(app, item.id)).toBeNull();
  expect((await start([wait("x", { effect: "read" }), wait("y", { effect: "external", gate: "auto" })])).isError).not.toBe(true);
  expect(listFlows(app)).toHaveLength(0);
  expect(itemFlow(app, item.id)?.definition.stages.map(s => [s.needs, s.gate])).toEqual([[[], "auto"], [["x"], "confirm"]]);
  await ownerAction(app, item.id, "x", "done", "已读", "owner");
  const s = getStage(app, item.id, "y");
  expect(s.state).toBe("gated");
  await answerAsk(app, s.askId!, { by: "owner", choice: 0 });
  await ownerAction(app, item.id, "y", "done", "已流转", "owner");
  expect(flowView(app, item.id).review?.templateSuggestion).toContain("存成模板");
  expect(listFlows(app)).toHaveLength(0);
  const proposal = one<{ id: string }>(app.db, "select id from asks where json_extract(context,'$.handler')='flow-save'")!;
  await answerAsk(app, proposal.id, { by: "owner", choice: 0 });
  expect(listFlows(app)).toHaveLength(1);
});


it("经假 ACP 和 MCP 重读已挂对象并交回阶段及对账结论", async () => {
  const { app, item, s, clock } = await setup();
  const profile = agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath,
    args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "aware" } });
  app.config.agents.profiles = [profile]; app.config.agents.default = profile.id;
  const plugin = "reconcileprobe", dir = join(app.home, "plugins", plugin);
  const link = "https://example.test/issue/1";
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.yaml"), `id: ${plugin}\nname: 示例对象\n`);
  writeFileSync(join(dir, "server.mjs"), `export default api => api.object({ kind: "issue", label: "缺陷",
    match: u => u === ${JSON.stringify(link)} ? "1" : null, statuses: { open: "未验证", verified: "已验证" }, final: ["verified"],
    async read(ctx) {
      const n = await ctx.store.get("fixture", "reads") ?? 0;
      await ctx.store.put("fixture", "reads", n + 1);
      return { title: "项目 A 缺陷", status: await ctx.store.get("fixture", "status") ?? "open", link: ${JSON.stringify(link)} };
    }
  });`);
  await loadPlugins(app, [{ dir: join(app.home, "plugins"), source: "data" }]);
  await trustPlugin(app, plugin, "inprocess");
  const fixture = pluginStore(app, plugin, "owner", "personal");
  const server = await startServer(app, { host: "127.0.0.1", port: 0, quiet: true });
  try {
    const object = await attachObject(app, item.id, link, "owner");
    fixture.put("fixture", "status", "verified");
    const args = { item: item.id, object: `object:${object.id}` };
    upsertItem(app, item.id, { detail: [
      "假模型测试脚本：",
      `@call read_flow_object ${JSON.stringify(args)}`,
      `@call stage_report ${JSON.stringify({ item: item.id, stage: "verify", state: "done", note: "平台读到已验证", evidence: [args.object] })}`,
      `@call submit_flow_reconcile ${JSON.stringify({ item: item.id, summary: "平台已验证" })}`,
    ].join("\n") }, "user");
    const queued = queueReconcile(app, item.id, clock(7))!;
    run(app.db, "update runs set status='running' where id=?", queued.id);
    const output = await __testHandlers.get("flow-reconcile")!({ app, run: getRun(app, queued.id), signal: new AbortController().signal, event: () => {}, output: () => {} });
    expect(output).toMatchObject({ quiet: true, summary: "平台已验证" });
    expect(fixture.get("fixture", "reads")).toBe(2);
    expect(s().state).toBe("done");
    expect(stageLog(app, item.id).find(l => l.runId === queued.id)?.refs).toEqual([args.object]);
  } finally { forgetPlugin(plugin); await server.close(); }
}, 30000);
