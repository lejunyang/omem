import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { setDecisionFetchForTests, resetDecisionCooldownForTests } from "../src/core/decision.ts";
import { appendToSource, sourceText, upsertSource } from "../src/sources/store.ts";
import { upsertItem, getItem } from "../src/items/store.ts";
import { addMaterials } from "../src/items/materials.ts";
import { createThread, addMessage } from "../src/agents/threads.ts";
import { getRun, listRuns, __testHandlers } from "../src/agents/runs.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { loadRole } from "../src/agents/runner.ts";
import * as runner from "../src/agents/runner.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { startFlow, stopFlow, flowView, flowReminders, ownerAction } from "../src/flows/engine.ts";
import { followContexts, followLimit, finishFollow, noteItemChange, recentChanges, settleChange } from "../src/flows/follow.ts";
import { startServer } from "../src/server/http.ts";
import { getStage } from "../src/flows/store.ts";
import { testApp } from "./helpers.ts";

const apps: App[] = [];
const owner = { actor: "owner", userId: "owner" };
async function setup(stages: object[] = [{ id: "code", name: "编码", by: "wait" }, { id: "verify", name: "验证", by: "wait" }, { id: "end", name: "结束", by: "wait" }]) {
  const app = testApp(); apps.push(app); app.config.flows.autoAdvance = 20;
  const item = upsertItem(app, undefined, { title: "示例商城退款", detail: "退商品款", dueAt: "2026-12-01" }, "user");
  const src = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_example", title: "示例商城讨论", lines: ["原来的需求"], meta: { chatId: "oc_example" } });
  run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,content,create_ms) values('history','oc_example',?,1,'原来的需求',?)", src.id, Date.now() - 3600000);
  addMaterials(app, item.id, [{ kind: "source", ref: src.id }], "owner");
  saveFlow(app, YAML.stringify({ id: "demo", name: "示例交付", stages }), "owner");
  await startFlow(app, item.id, "demo", owner);
  let line = 1;
  const message = (kind = "user", ageMinutes = 0, content = "小王提出部分发货的运费也要退") => {
    line++;
    appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_example", title: "示例商城讨论", lines: [content] });
    run(app.db, "insert into lark_messages(message_id,chat_id,source_id,line,sender_kind,sender_name,content,create_ms) values(?,?,?,?,?,?,?,?)", `msg_${line}`, "oc_example", src.id, line, kind, kind === "owner" ? "本人" : "小王", content, Date.now() + 1 - ageMinutes * 60000);
    return `src:${src.id}#L${line}`;
  };
  const queued = () => listRuns(app, { kind: "item-follow" });
  const processing = async () => {
    app.config.flows.follow.maxMessages = 1;
    const ref = message();
    await followContexts(app);
    const r = queued()[0]; expect(r).toBeDefined();
    run(app.db, "update runs set status='running' where id=?", r.id);
    return { r: getRun(app, r.id), ref };
  };
  return { app, item, src, message, queued, processing };
}
afterEach(async () => {
  vi.restoreAllMocks(); setDecisionFetchForTests(null); resetDecisionCooldownForTests();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { force: true, recursive: true }); }
});

describe("流程上下文跟进", () => {
  it("每天达到上限保留游标和新内容，只记一次，次日恢复；零不限", async () => {
    const t = await setup();
    t.app.config.flows.follow.maxRunsPerDay = 1;
    const { r } = await t.processing();
    finishFollow(t.app, r); run(t.app.db, "update runs set status='done' where id=?", r.id);
    t.message();
    const cursor = one(t.app.db, "select * from item_follow_cursors where item_id=?", t.item.id);
    await followContexts(t.app); await followContexts(t.app);
    expect(t.queued()).toHaveLength(1);
    expect(one(t.app.db, "select * from item_follow_cursors where item_id=?", t.item.id)).toEqual(cursor);
    const signals = all<{ outcome: string }>(t.app.db, "select outcome from flow_signals where json_extract(keys,'$.capped')=1");
    expect(signals).toEqual([{ outcome: "今天已经看了 1 批，剩下的明天一起看" }]);
    expect(flowView(t.app, t.item.id).flow!.followCapped).toBe(true);
    expect(Array.isArray(flowView(t.app, t.item.id).follow)).toBe(true);
    await followContexts(t.app, new Date(Date.now() + 86400000)); expect(t.queued()).toHaveLength(2);
    run(t.app.db, "update runs set status='done' where kind='item-follow'");
    t.app.config.flows.follow.maxRunsPerDay = 0;
    await followContexts(t.app); expect(t.queued()).toHaveLength(3);
    expect(flowView(t.app, t.item.id).flow!.followCapped).toBe(false);
  });
  it("按配置时区数起过运行的批次，跨 UTC 日期仍属同一天；无关和上限提示不占额度", async () => {
    const t = await setup(); t.app.config.timezone = "America/Los_Angeles"; t.app.config.flows.follow.maxRunsPerDay = 2;
    for (const [at, keys] of [
      ["2026-11-30T23:00:00.000Z", { runId: "first" }], ["2026-12-01T00:00:00.000Z", { runId: "second" }],
      ["2026-12-01T00:10:00.000Z", {}], ["2026-12-01T00:20:00.000Z", { capped: true }],
    ] as const) run(t.app.db, "insert into flow_signals(at,type,keys,item_id,stage_id,outcome) values(?,'context.batch',?,?,'','示例')", at, JSON.stringify(keys), t.item.id);
    expect(followLimit(t.app, t.item.id, new Date("2026-12-01T01:00:00.000Z"))).toEqual({ capped: true, count: 2, noted: true });
    expect(followLimit(t.app, t.item.id, new Date("2026-12-01T09:00:00.000Z"))).toEqual({ capped: false, count: 0, noted: false });
  });
  it("关闭跟进不处理；开始后回溯追加的历史消息不当作新内容", async () => {
    const t = await setup();
    t.message("user", 60); await followContexts(t.app, new Date(Date.now() + 21 * 60000)); expect(t.queued()).toHaveLength(0);
    t.app.config.flows.follow.enabled = false; t.app.config.flows.follow.maxMessages = 1;
    t.message(); await followContexts(t.app); expect(t.queued()).toHaveLength(0);
    t.app.config.flows.follow.enabled = true; await followContexts(t.app); expect(t.queued()).toHaveLength(1);
  });
  it("处理器通过只读角色交结果；失败记结局并保留游标", async () => {
    const t = await setup(); const { r } = await t.processing();
    const invoke = () => __testHandlers.get("item-follow")!({ app: t.app, run: r, signal: new AbortController().signal, event: () => {}, output: () => {} });
    const agent = vi.spyOn(runner, "runRole").mockRejectedValueOnce(new Error("模型暂不可用"));
    await expect(invoke()).rejects.toThrow("暂不可用");
    expect(flowView(t.app, t.item.id).follow[0]).toMatchObject({ line: 1, pending: 1 });
    expect(one(t.app.db, "select outcome from flow_signals where json_extract(keys,'$.runId')=?", r.id)).toEqual({ outcome: "提炼未完成，保留游标待重试" });
    agent.mockResolvedValueOnce({ text: "已结束", ai: "example", sessionId: null } as unknown as Awaited<ReturnType<typeof runner.runRole>>);
    await invoke();
    expect(agent).toHaveBeenLastCalledWith(t.app, expect.objectContaining({ role: "item-follow", runId: r.id, userId: "owner", spaces: ["personal"] }));
    expect(flowView(t.app, t.item.id).follow[0]).toMatchObject({ line: 2, pending: 0 });
  });
  it("并进正在运行的阶段，新任务包含变化反馈和最近变化", async () => {
    const t = await setup([{ id: "code", name: "编码", by: { run: {} } }, { id: "end", name: "收尾", by: "wait" }]);
    const original = getStage(t.app, t.item.id, "code").control.runId;
    const { r, ref } = await t.processing();
    noteItemChange(t.app, r.id, { item: t.item.id, type: "scope", summary: "小王提出运费也要退", stages: ["code"], refs: [ref] });
    finishFollow(t.app, r); await answerAsk(t.app, listAsks(t.app, { runId: r.id })[0].id, { choice: 0, by: "owner" });
    const s = getStage(t.app, t.item.id, "code"); expect(s.control.runId).not.toBe(original);
    expect(getRun(t.app, s.control.runId!).input.task).toContain("本人说还不行，原因：小王提出运费也要退");
    expect(getRun(t.app, s.control.runId!).input.task).toContain("[scope/merged]");
  });
  it("本人自己说的范围变化直接并进，同一段几条合成一次重开；别人提的照样问", async () => {
    const t = await setup([{ id: "code", name: "编码", by: { run: {} } }, { id: "end", name: "收尾", by: "wait" }]);
    const original = getStage(t.app, t.item.id, "code").control.runId;
    t.app.config.flows.follow.maxMessages = 1;
    const said = t.message("owner", 0, "帮我把部分发货的运费也退了"), also = t.message("owner", 0, "退款单上也要显示运费");
    const proposed = t.message("user", 0, "小王提出优惠券也要退");
    await followContexts(t.app);
    const r = t.queued()[0]; run(t.app.db, "update runs set status='running' where id=?", r.id);
    noteItemChange(t.app, r.id, { item: t.item.id, type: "scope", summary: "本人要求运费也退", stages: ["code"], refs: [said], decided: true });
    noteItemChange(t.app, r.id, { item: t.item.id, type: "scope", summary: "本人要求退款单显示运费", stages: ["code"], refs: [also], decided: true });
    // Said to be settled, but only a colleague said it: still the owner's to decide.
    noteItemChange(t.app, r.id, { item: t.item.id, type: "scope", summary: "小王提出优惠券也要退", stages: ["code"], refs: [proposed], decided: true });
    await finishFollow(t.app, getRun(t.app, r.id));
    const asks = listAsks(t.app, { runId: r.id });
    expect(asks).toHaveLength(1); expect(asks[0].question).toContain("优惠券");
    expect(recentChanges(t.app, t.item.id).map((c) => [c.summary, c.status])).toEqual(expect.arrayContaining([["本人要求运费也退", "merged"], ["本人要求退款单显示运费", "merged"], ["小王提出优惠券也要退", "asked"]]));
    const s = getStage(t.app, t.item.id, "code"); expect(s.control.runId).not.toBe(original);
    const task = String(getRun(t.app, s.control.runId!).input.task);
    expect(task).toContain("本人要求运费也退"); expect(task).toContain("本人要求退款单显示运费");
    expect(all(t.app.db, "select 1 from item_stage_log where item_id=? and stage_id='code' and event='reopen'", t.item.id)).toHaveLength(1);
    expect(one(t.app.db, "select outcome from flow_signals where json_extract(keys,'$.runId')=?", r.id)).toEqual({ outcome: "记了 3 条变化，问了本人 1 条，按本人的话并进 2 条" });
  });
  it("从流程开始时的末尾订阅；不到安静时间继续攒，安静后由巡检起运行", async () => {
    const t = await setup();
    expect(flowView(t.app, t.item.id).follow[0]).toMatchObject({ sourceId: t.src.id, line: 1, pending: 0 });
    await followContexts(t.app); expect(t.queued()).toHaveLength(0);
    t.message(); await flowReminders(t.app); expect(t.queued()).toHaveLength(0);
    expect(flowView(t.app, t.item.id).follow[0].pending).toBe(1);
    await flowReminders(t.app, new Date(Date.now() + 21 * 60000));
    expect(t.queued()).toHaveLength(1); expect(String(t.queued()[0].input.task)).not.toContain("#L1]");
  });
  it("攒够三十条立即处理，多次并发巡检和运行期间都不会重排", async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) t.message();
    await Promise.all([followContexts(t.app), followContexts(t.app), flowReminders(t.app)]);
    expect(t.queued()).toHaveLength(1);
    run(t.app.db, "update runs set status='running' where id=?", t.queued()[0].id);
    t.message(); await followContexts(t.app); expect(t.queued()).toHaveLength(1);
  });
  it("助手、机器人与系统的行不计数，也不延后本人消息的安静时间", async () => {
    const t = await setup();
    for (let i = 0; i < 35; i++) t.message(i % 2 ? "app" : "assistant");
    t.message("system"); await followContexts(t.app); expect(t.queued()).toHaveLength(0);
    t.message("owner", 0, "本人同意退运费"); t.message("app", -20);
    await followContexts(t.app, new Date(Date.now() + 21 * 60000)); expect(t.queued()).toHaveLength(1);
    expect(String(t.queued()[0].input.task)).toContain("本人（owner）：本人同意退运费");
    expect(String(t.queued()[0].input.task)).not.toContain("（app）");
  });
  it.each([0.9, 0.55])("预筛无关概率 %s：只在达到门槛时跳过，记录 decisions", async (probability) => {
    const t = await setup(); t.app.config.flows.follow.maxMessages = 1;
    t.app.config.ai.providers = [{ id: "decision", name: "决策", kind: "openai", backends: [] }];
    t.app.config.ai.decision.provider = "decision"; t.app.config.ai.decision.model = "decision-model";
    setKey(t.app.home, "decision", "example-key");
    setDecisionFetchForTests(async () => new Response(JSON.stringify({ answers: [{ name: "q", type: "predicate", probability: 1 - probability }] })));
    t.message(); await followContexts(t.app);
    expect(t.queued()).toHaveLength(probability >= 0.6 ? 0 : 1);
    expect(one(t.app.db, "select scene,threshold,taken from decisions")).toMatchObject({ scene: "follow", threshold: 0.6, taken: probability >= 0.6 ? "no" : "yes" });
    if (probability >= 0.6) {
      expect(flowView(t.app, t.item.id).follow[0]).toMatchObject({ line: 2, pending: 0 });
      expect(one(t.app.db, "select outcome from flow_signals where type='context.batch'")).toEqual({ outcome: "看过，无关" });
    }
  });
  it("没配决策模型或模型失败都照常起运行", async () => {
    const t = await setup(); const { r } = await t.processing(); expect(r.kind).toBe("item-follow");
    expect(all(t.app.db, "select * from decisions")).toHaveLength(0);
    run(t.app.db, "update runs set status='done' where id=?", r.id); finishFollow(t.app, r);
    t.app.config.ai.providers = [{ id: "decision", name: "决策", kind: "openai", backends: [] }];
    t.app.config.ai.decision.provider = "decision"; t.app.config.ai.decision.model = "decision-model";
    setKey(t.app.home, "decision", "example-key"); setDecisionFetchForTests(async () => { throw new Error("暂不可用"); });
    t.message(); await followContexts(t.app); expect(t.queued()).toHaveLength(2);
  });
  it("工具只接受本次运行的事项、批次内的行和这件事的阶段，且只给 item-follow", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    const a = { item: t.item.id, type: "scope" as const, summary: "小王提出退运费", refs: [ref], stages: ["code"] };
    expect(() => noteItemChange(t.app, r.id, { ...a, item: "other" })).toThrow();
    expect(() => noteItemChange(t.app, r.id, { ...a, refs: [`src:${t.src.id}#L1`] })).toThrow("这一批");
    expect(() => noteItemChange(t.app, r.id, { ...a, stages: ["other"] })).toThrow("阶段");
    const other = upsertSource(t.app, { spaceId: "personal", kind: "doc", uri: "doc:other", title: "另一份", text: "内容" });
    expect(() => noteItemChange(t.app, r.id, { ...a, refs: [`src:${other.id}#L1`] })).toThrow("这一批");
    const ctx: ToolContext = { app: t.app, runId: r.id, spaceId: "personal", spaces: ["personal"], tools: null, actor: "agent", userId: "owner", role: "item-follow" };
    expect((await callTool({ ...ctx, role: "assistant" }, "note_item_change", a)).isError).toBe(true);
    expect((await callTool({ ...ctx, writable: [] }, "note_item_change", a)).isError).toBe(true);
    expect((await callTool(ctx, "note_item_change", a)).isError).toBe(false);
    expect(loadRole("item-follow", t.app)).toMatchObject({ writes: false, tools: ["read_item", "read_source", "req_read", "note_item_change", "stay_quiet"] });
    expect(loadRole("assistant", t.app).tools).not.toContain("note_item_change");
  });
  it("info 只记，不通知、不提问；读事项和流程视图都带变化及订阅", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    noteItemChange(t.app, r.id, { item: t.item.id, type: "info", summary: "小王同步了进度", refs: [ref] });
    const before = all(t.app.db, "select id from notifications").length;
    finishFollow(t.app, r); finishFollow(t.app, r);
    expect(listAsks(t.app, { runId: r.id })).toHaveLength(0);
    expect(all(t.app.db, "select id from notifications")).toHaveLength(before);
    const read = await callTool({ app: t.app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" }, "read_item", { item_id: t.item.id });
    expect(JSON.parse(read.text).flow.changes[0]).toMatchObject({ type: "info", status: "noted", refs: [ref] });
    expect(flowView(t.app, t.item.id).follow[0]).toMatchObject({ line: 2, pending: 0 });
    expect(one<{ outcome: string }>(t.app.db, "select outcome from flow_signals where type='context.batch'")!.outcome).toBe("记了 1 条变化，问了本人 0 条");
  });
  it("deadline 校验 due，更新截止时间、带引用记时间线，同一变化只通知一次", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    const a = { item: t.item.id, type: "deadline" as const, summary: "本人确认改到十二月二日", refs: [ref], decided: true };
    for (const due of [undefined, "明天", "2026-02-30", "2026-12-02T09:00:00"]) expect(() => noteItemChange(t.app, r.id, { ...a, due })).toThrow("due");
    noteItemChange(t.app, r.id, { ...a, due: "2026-12-02" }); noteItemChange(t.app, r.id, { ...a, due: "2026-12-02" });
    expect(getItem(t.app, t.item.id).dueAt).toBe("2026-12-02");
    expect(all(t.app.db, "select context from notifications where json_extract(context,'$.runId')=? and json_extract(context,'$.urgency')='later'", r.id)).toHaveLength(1);
    expect(one<{ source_refs: string }>(t.app.db, "select source_refs from item_events where run_id=? and source_refs!='[]'", r.id)!.source_refs).toContain(ref);
    expect(recentChanges(t.app, t.item.id)[0].status).toBe("merged");
    const first = recentChanges(t.app, t.item.id)[0].id;
    run(t.app.db, "update runs set status='failed' where id=?", r.id);
    await followContexts(t.app);
    const retry = t.queued().find((next) => next.id !== r.id)!;
    run(t.app.db, "update runs set status='running' where id=?", retry.id);
    expect(noteItemChange(t.app, retry.id, { ...a, due: "2026-12-02" }).id).toBe(first);
    finishFollow(t.app, getRun(t.app, retry.id));
    expect(recentChanges(t.app, t.item.id)).toHaveLength(1);
    expect(all(t.app.db, "select id from notifications where json_extract(context,'$.urgency')='later' and title like '%截止时间变了' ")).toHaveLength(1);
  });
  it.each([0, 1])("别人只是提议改期：截止时间不动，问本人改不改，选 %s 后才处理", async (choice) => {
    const t = await setup(); const { r, ref } = await t.processing();
    const before = all(t.app.db, "select id from notifications").length;
    const earlier = noteItemChange(t.app, r.id, { item: t.item.id, type: "deadline", summary: "小王提出改到十二月三日", refs: [ref], due: "2026-12-03" });
    const change = noteItemChange(t.app, r.id, { item: t.item.id, type: "deadline", summary: "小李提出延到十二月五日，本人还没表态", refs: [ref], due: "2026-12-05" });
    expect(change).toMatchObject({ status: "noted", due: "2026-12-05" });
    expect(getItem(t.app, t.item.id).dueAt).toBe("2026-12-01");
    expect(all(t.app.db, "select id from notifications")).toHaveLength(before);
    finishFollow(t.app, r); finishFollow(t.app, r);
    // One card, about the latest proposal of the batch; the earlier one stays on the list.
    const asks = listAsks(t.app, { runId: r.id }); expect(asks).toHaveLength(1);
    expect(asks[0].options.map((o) => o.label)).toEqual(["改成这个时间", "不改"]);
    expect(asks[0].question).toContain("提出改成：2026-12-05"); expect(asks[0].question).toContain("现在的截止时间：2026-12-01"); expect(asks[0].question).toContain(ref);
    // Whoever does a later stage reads it as a proposal, not as the new deadline.
    expect((await callTool({ app: t.app, runId: null, spaceId: "personal", spaces: null, tools: null, actor: "agent" }, "read_item", { item_id: t.item.id })).text).toContain("2026-12-01");
    expect(recentChanges(t.app, t.item.id).find((c) => c.id === change.id)).toMatchObject({ status: "asked", due: "2026-12-05", detail: null });
    expect(recentChanges(t.app, t.item.id).find((c) => c.id === earlier.id)!.status).toBe("noted");
    await expect(settleChange(t.app, t.item.id, change.id, "split", "owner")).rejects.toThrow("改或不改");
    await expect(answerAsk(t.app, asks[0].id, { choice, by: "other" })).rejects.toThrow("本人");
    if (choice === 0) await answerAsk(t.app, asks[0].id, { choice, by: "owner" });
    else await settleChange(t.app, t.item.id, change.id, "dismiss", "owner");
    expect(getAsk(t.app, asks[0].id)).toMatchObject({ status: "answered", choice });
    expect(recentChanges(t.app, t.item.id).find((c) => c.id === change.id)!.status).toBe(choice === 0 ? "merged" : "dismissed");
    expect(getItem(t.app, t.item.id).dueAt).toBe(choice === 0 ? "2026-12-05" : "2026-12-01");
    if (choice === 0) expect(one<{ source_refs: string }>(t.app.db, "select source_refs from item_events where item_id=? and text like '%小李提出延到十二月五日%'", t.item.id)!.source_refs).toContain(ref);
    // The owner chose: nothing more to be told about.
    expect(all(t.app.db, "select id from notifications where title like '%截止时间变了'")).toHaveLength(0);
  });
  it("提议还在等本人时，本人在群里定了时间：直接改，原来那张卡片收回", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    const proposal = noteItemChange(t.app, r.id, { item: t.item.id, type: "deadline", summary: "小李提出延到十二月五日", refs: [ref], due: "2026-12-05" });
    finishFollow(t.app, r); run(t.app.db, "update runs set status='done' where id=?", r.id);
    const ask = listAsks(t.app, { runId: r.id })[0];
    const said = t.message("owner", 0, "延到十二月八日");
    await followContexts(t.app);
    const next = t.queued().find((q) => q.id !== r.id)!;
    run(t.app.db, "update runs set status='running' where id=?", next.id);
    noteItemChange(t.app, next.id, { item: t.item.id, type: "deadline", summary: "本人定了延到十二月八日", refs: [said], due: "2026-12-08", decided: true });
    expect(getItem(t.app, t.item.id).dueAt).toBe("2026-12-08");
    expect(recentChanges(t.app, t.item.id).find((c) => c.id === proposal.id)!.status).toBe("dismissed");
    expect(getAsk(t.app, ask.id).status).toBe("cancelled");
    finishFollow(t.app, getRun(t.app, next.id));
    expect(listAsks(t.app, { runId: next.id })).toHaveLength(0);
    // The time the item already has is not asked about again.
    await expect(settleChange(t.app, t.item.id, proposal.id, "merge", "owner")).rejects.toThrow("处理过");
  });
  it.each([0, 1, 2])("已完成阶段的范围变化，等待本人选 %s 后才处理", async (choice) => {
    const t = await setup();
    await ownerAction(t.app, t.item.id, "code", "done", "编码已完"); await ownerAction(t.app, t.item.id, "verify", "done", "验证已完");
    const { r, ref } = await t.processing();
    const change = noteItemChange(t.app, r.id, { item: t.item.id, type: "scope", summary: "小王提出运费也要退", detail: "原来只退商品款；小王提出还退运费，尚未同意", stages: ["code", "verify"], refs: [ref] });
    expect(getStage(t.app, t.item.id, "code").state).toBe("done");
    finishFollow(t.app, r);
    const ask = listAsks(t.app, { runId: r.id })[0];
    expect(ask.question).toContain("编码（已完成）"); expect(ask.question).toContain(ref);
    await expect(answerAsk(t.app, ask.id, { choice, by: "other" })).rejects.toThrow("本人");
    expect(getAsk(t.app, ask.id).status).toBe("pending");
    await answerAsk(t.app, ask.id, { choice, by: "owner" });
    expect(recentChanges(t.app, t.item.id).find((c) => c.id === change.id)!.status).toBe(["merged", "split", "dismissed"][choice]);
    if (choice === 0) {
      expect(getStage(t.app, t.item.id, "code")).toMatchObject({ state: "doing", control: { feedback: expect.stringContaining("小王提出运费也要退") } });
      expect(getStage(t.app, t.item.id, "verify").state).toBe("stale");
    } else if (choice === 1) {
      const created = one<{ id: string; detail: string }>(t.app.db, "select id,detail from items where id!=?", t.item.id)!;
      expect(created.detail).toContain(ref);
      expect(one(t.app.db, "select ref from item_materials where item_id=? and kind='source'", created.id)).toEqual({ ref: t.src.id });
      expect(getStage(t.app, t.item.id, "code").state).toBe("done");
    } else expect(getStage(t.app, t.item.id, "code").state).toBe("done");
  });
  it("并进运行阶段时，新任务带返工反馈及最近变化；未开始阶段的变化不提问", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    noteItemChange(t.app, r.id, { item: t.item.id, type: "blocker", summary: "小王说测试账号还没到", stages: ["verify"], refs: [ref] });
    finishFollow(t.app, r); expect(listAsks(t.app, { runId: r.id })).toHaveLength(0);
    // Switch the next carrier to a run in the saved per-item definition, as if that flow began with it.
    const f = JSON.parse(one<{ definition: string }>(t.app.db, "select definition from item_flows where item_id=?", t.item.id)!.definition);
    f.stages[1].by = { run: {} };
    run(t.app.db, "update item_flows set definition=? where item_id=?", JSON.stringify(f), t.item.id);
    await ownerAction(t.app, t.item.id, "code", "done", "编码已完");
    const stageRun = getRun(t.app, getStage(t.app, t.item.id, "verify").control.runId!);
    expect(stageRun.input.task).toContain("## 最近的变化"); expect(stageRun.input.task).toContain("小王说测试账号还没到");
  });
  it("同一批最多三张卡片，第三张的多条变化逐条选择", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    for (let i = 0; i < 5; i++) noteItemChange(t.app, r.id, { item: t.item.id, type: "scope", summary: `小王提出第 ${i + 1} 项`, stages: ["code"], refs: [ref] });
    finishFollow(t.app, r); finishFollow(t.app, r);
    const asks = listAsks(t.app, { runId: r.id }); expect(asks).toHaveLength(3);
    const form = asks.find((a) => a.ui?.fields?.length)!; expect(form.ui!.fields).toHaveLength(3);
    const fields = form.ui!.fields!;
    await answerAsk(t.app, form.id, { by: "owner", value: Object.fromEntries(fields.map((f, i) => [f.id, i === 0 ? "另开一件事" : "不用管"])) });
    expect(recentChanges(t.app, t.item.id).filter((c) => c.status === "split")).toHaveLength(1);
    expect(recentChanges(t.app, t.item.id).filter((c) => c.status === "dismissed")).toHaveLength(2);
  });
  it("结束后不跟进，也拒绝尚未回答的变化卡片；重启从新末尾开始", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    noteItemChange(t.app, r.id, { item: t.item.id, type: "decision", summary: "本人确定补运费", stages: ["code"], refs: [ref] });
    finishFollow(t.app, r); const ask = listAsks(t.app, { runId: r.id })[0];
    run(t.app.db, "update runs set status='done' where id=?", r.id);
    await stopFlow(t.app, t.item.id); t.message(); await followContexts(t.app);
    expect(t.queued()).toHaveLength(1); expect(flowView(t.app, t.item.id).follow).toEqual([]);
    await expect(answerAsk(t.app, ask.id, { choice: 0, by: "owner" })).rejects.toThrow("流程");
    await startFlow(t.app, t.item.id, "demo", owner); await followContexts(t.app);
    expect(t.queued()).toHaveLength(1); expect(flowView(t.app, t.item.id).follow[0].pending).toBe(0);
  });
  it("文档与会议仅跟关联后的更新；飞书会话通过 external_id 落到聊天原件", async () => {
    const t = await setup();
    const doc = upsertSource(t.app, { spaceId: "personal", kind: "meeting", uri: "meeting:demo", title: "示例讨论", text: "原会议内容" });
    const thread = createThread(t.app, { spaceId: "personal", channel: "lark", key: "oc_example#omt_demo" });
    addMaterials(t.app, t.item.id, [{ kind: "source", ref: doc.id }, { kind: "conversation", ref: thread.id }], "owner");
    await followContexts(t.app); expect(flowView(t.app, t.item.id).follow).toHaveLength(2);
    const before = flowView(t.app, t.item.id).follow.find((s) => s.sourceId === doc.id)!;
    expect(before.pending).toBe(0);
    run(t.app.db, "update sources set text='本人确认退款方案',updated_at=? where id=?", new Date(Date.now() + 1000).toISOString(), doc.id);
    await followContexts(t.app); expect(t.queued()).toHaveLength(0);
    await followContexts(t.app, new Date(Date.now() + 21 * 60000)); expect(t.queued()).toHaveLength(1);
    const r = t.queued()[0]; run(t.app.db, "update runs set status='running' where id=?", r.id);
    noteItemChange(t.app, r.id, { item: t.item.id, type: "info", summary: "会议确认方案", refs: [`src:${doc.id}#L1`] });
    finishFollow(t.app, getRun(t.app, r.id)); expect(flowView(t.app, t.item.id).follow.find((s) => s.sourceId === doc.id)!.pending).toBe(0);
  });
  it("普通会话忽略助手；多行消息引用实际转录行号", async () => {
    const t = await setup(); const c = createThread(t.app, { spaceId: "personal", channel: "web" });
    addMessage(t.app, c.id, "user", "历史\n第二行"); addMessage(t.app, c.id, "assistant", "已知道");
    addMaterials(t.app, t.item.id, [{ kind: "conversation", ref: c.id }], "owner");
    await followContexts(t.app);
    const source = one<{ id: string }>(t.app.db, "select id from sources where uri=?", `conversation:${c.id}`)!;
    addMessage(t.app, c.id, "assistant", "助手的新进展"); await followContexts(t.app); expect(t.queued()).toHaveLength(0);
    t.app.config.flows.follow.maxMessages = 1;
    addMessage(t.app, c.id, "user", "本人决定\n再加运费");
    addMessage(t.app, c.id, "user", "提出另一个想法，尚未同意", null, { speaker: "小王" });
    await followContexts(t.app);
    const r = t.queued()[0], task = String(r.input.task);
    const citation = new RegExp(`src:${source.id}#L(\\d+)`).exec(task)!;
    const line = Number(citation[1]); expect(sourceText(t.app, source.id).split("\n")[line - 1]).toContain("本人");
    expect(task).toContain("再加运费"); expect(task).not.toContain("助手的新进展");
    expect(task).toContain("小王：提出另一个想法，尚未同意");
    expect(task).not.toContain("本人：提出另一个想法");
  });
  it("成功后到达的新消息保留到下一批；没变化也记一次批次结局", async () => {
    const t = await setup(); const { r } = await t.processing();
    t.message(); finishFollow(t.app, r); run(t.app.db, "update runs set status='done' where id=?", r.id);
    expect(flowView(t.app, t.item.id).follow[0].pending).toBe(1);
    await followContexts(t.app); expect(t.queued()).toHaveLength(2);
    expect(one<{ outcome: string }>(t.app.db, "select outcome from flow_signals where json_extract(keys,'$.runId')=?", r.id)!.outcome).toBe("看过，没有变化");
  });
});

describe("原件查找、文档的新行和在事项页逐条处理", () => {
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
  it("只关联了飞书会话时，跟的是那个群的聊天原件", async () => {
    const t = await setup();
    run(t.app.db, "delete from item_materials where item_id=? and kind='source'", t.item.id);
    const thread = createThread(t.app, { spaceId: "personal", channel: "lark", key: "oc_example#omt_demo" });
    addMaterials(t.app, t.item.id, [{ kind: "conversation", ref: thread.id }], "owner");
    await followContexts(t.app);
    expect(flowView(t.app, t.item.id).follow.map((f) => f.sourceId)).toEqual([t.src.id]);
    t.app.config.flows.follow.enabled = false;
    expect(flowView(t.app, t.item.id).follow).toEqual([]);
  });
  it("文档更新后只交以前没有的行；只删行不起运行", async () => {
    const t = await setup();
    const doc = upsertSource(t.app, { spaceId: "personal", kind: "doc", uri: "doc:plan", title: "退款方案", text: "退商品款\n七天内原路退回" });
    addMaterials(t.app, t.item.id, [{ kind: "source", ref: doc.id }], "owner");
    await followContexts(t.app);
    run(t.app.db, "update sources set text=?,updated_at=? where id=?", "退商品款\n七天内原路退回\n部分发货的运费也退", later(1000), doc.id);
    await followContexts(t.app, new Date(Date.now() + 21 * 60000));
    const r = t.queued()[0], task = String(r.input.task);
    expect(task).toContain(`[src:${doc.id}#L3] 部分发货的运费也退`);
    expect(task).not.toContain(`[src:${doc.id}#L1]`);
    run(t.app.db, "update runs set status='running' where id=?", r.id);
    expect(() => noteItemChange(t.app, r.id, { item: t.item.id, type: "info", summary: "旧的一行", refs: [`src:${doc.id}#L1`] })).toThrow("这一批");
    noteItemChange(t.app, r.id, { item: t.item.id, type: "info", summary: "文档写明运费也退", refs: [`src:${doc.id}#L3`] });
    finishFollow(t.app, getRun(t.app, r.id)); run(t.app.db, "update runs set status='done' where id=?", r.id);
    run(t.app.db, "update sources set text=?,updated_at=? where id=?", "退商品款\n部分发货的运费也退", later(2000), doc.id);
    await followContexts(t.app, new Date(Date.now() + 42 * 60000));
    expect(t.queued()).toHaveLength(1);
    expect(flowView(t.app, t.item.id).follow.find((f) => f.sourceId === doc.id)!.pending).toBe(0);
  });
  it("在事项页逐条处理：单条的卡片随之回答，多条的卡片处理完才撤回，只限本人", async () => {
    const t = await setup(); const { r, ref } = await t.processing();
    for (let i = 0; i < 5; i++) noteItemChange(t.app, r.id, { item: t.item.id, type: "scope", summary: `小王提出第 ${i + 1} 项`, stages: ["code"], refs: [ref] });
    for (let i = 0; i < 8; i++) noteItemChange(t.app, r.id, { item: t.item.id, type: "info", summary: `同步第 ${i + 1} 条进度`, refs: [ref] });
    finishFollow(t.app, r);
    const asks = listAsks(t.app, { runId: r.id }), form = asks.find((a) => a.ui?.fields?.length)!, single = asks.find((a) => !a.ui?.fields?.length)!;
    // The page lists every change that waits for the owner, however many newer ones there are.
    const shown = flowView(t.app, t.item.id).changes;
    expect(shown.filter((c) => c.status === "asked")).toHaveLength(5);
    const alone = shown.find((c) => c.askId === single.id)!, grouped = shown.filter((c) => c.askId === form.id);
    await expect(settleChange(t.app, t.item.id, alone.id, "dismiss", "other")).rejects.toThrow("本人");
    await settleChange(t.app, t.item.id, alone.id, "dismiss", "owner");
    expect(getAsk(t.app, single.id)).toMatchObject({ status: "answered", choice: 2 });
    await expect(settleChange(t.app, t.item.id, alone.id, "merge", "owner")).rejects.toThrow("处理过");
    await settleChange(t.app, t.item.id, grouped[0].id, "split", "owner");
    expect(getAsk(t.app, form.id).status).toBe("pending");
    await settleChange(t.app, t.item.id, grouped[1].id, "dismiss", "owner");
    await settleChange(t.app, t.item.id, grouped[2].id, "merge", "owner");
    expect(getAsk(t.app, form.id).status).toBe("cancelled");
    expect(getStage(t.app, t.item.id, "code").control.feedback).toContain("小王提出第");
    const last = flowView(t.app, t.item.id).changes.filter((c) => c.status === "asked");
    expect(last).toHaveLength(1);
    const server = await startServer(t.app, { port: 0, quiet: true });
    try {
      const url = `/api/items/${t.item.id}/flow/changes/${last[0].id}`;
      expect((await server.inject({ method: "POST", url, payload: { choice: "later" } })).statusCode).toBe(400);
      const res = await server.inject({ method: "POST", url, payload: { choice: "dismiss" } });
      expect(res.statusCode).toBe(200);
      expect((res.json().changes as { id: string; status: string }[]).find((c) => c.id === last[0].id)!.status).toBe("dismissed");
    } finally { await server.close(); }
  });
});
