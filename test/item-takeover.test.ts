import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { commandGate } from "../src/agents/command-gate.ts";
import { retryRun } from "../src/agents/retry.ts";
import { recordRunStart } from "../src/agents/run-scope.ts";
import { createRun, getRun, listRuns, setRunOutput, startWorker, stopWorker, waitForRun, type Run } from "../src/agents/runs.ts";
import { conversationMessages } from "../src/agents/threads.ts";
import { callTool } from "../src/agents/tools.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { setItemListening } from "../src/channels/listen-items.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { itemContext } from "../src/channels/listen.ts";
import type { App } from "../src/core/app.ts";
import { commandRuleSchema } from "../src/core/config.ts";
import { one, run } from "../src/core/db.ts";
import { finishFollow, followAnchor, noteItemChange } from "../src/flows/follow.ts";
import { checkDueChangeSteps, queueChangeSteps, runApprovedItemStep, runTakeover, TAKEOVERS_PER_DAY } from "../src/flows/takeover.ts";
import { lineTimeline } from "../src/items/changes.ts";
import type { StepInput } from "../src/items/change-step-store.ts";
import { stepViews } from "../src/items/change-step-store.ts";
import { addMaterials } from "../src/items/materials.ts";
import { pendingActions } from "../src/items/pending.ts";
import { buildToday } from "../src/items/today.ts";
import { upsertItem } from "../src/items/store.ts";
import { appendToSource } from "../src/sources/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000 });
const apps: App[] = [];
afterEach(async () => {
  releaseAll();
  setLarkClient(null);
  await new Promise(r => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});
const read = { who: "me-read", step: "核对修复是否部署", done_when: "找到部署记录" } as const;
const write = { who: "me-write", step: "向项目群告知部署结果", done_when: "在原群发出核对结论" } as const;
const owner = { who: "owner", step: "决定是否保留旧入口", done_when: "本人选定处理方式" } as const;
const operation = { tool: "lark_send", args: { chat_id: "oc_shop", text: "已核对，退款修复已部署。" } };
const operationNote = { action: "把示例单转为待复测", target: "项目 A 测试队列的单 A-17", expected: "查回 A-17 状态为待复测" };
const explain = { operation_note: operationNote, result: "确认修复已部署到测试环境，A-17 仍是待修复" };
const commandRule = (args: string, action: "allow" | "deny" | "approve") => commandRuleSchema.parse({ command: "samplectl", args, action });

async function setup(assist?: "off" | "suggest" | "act") {
  const app = testApp(); apps.push(app);
  const item = upsertItem(app, undefined, { title: "项目 A · 退款" }, "user");
  const source = appendToSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_shop", title: "项目 A", lines: ["测试在问修复是否已部署"], meta: { chatId: "oc_shop" } });
  const ref = `src:${source.id}#L1`;
  await addMaterials(app, item.id, [{ kind: "source", ref: source.id }], "owner");
  setItemListening(app, item.id, true, assist ? { assist } : undefined);
  const mark = (id: string, status: string) => { run(app.db, "update runs set status=? where id=?", status, id); if (status === "running") recordRunStart(app, id); return getRun(app, id); };
  const batch = () => mark(createRun(app, { kind: "item-follow", spaceId: item.spaceId, title: "跟进项目 A", input: { itemId: item.id, spaces: [item.spaceId], batch: { startedAt: followAnchor(app, item.id)!.startedAt,
    parts: [{ source: source.id, from: 1, to: 1, updatedAt: new Date().toISOString(), lines: [{ line: 1, text: "测试在问修复是否已部署" }] }] } } }).id, "running");
  const note = (r: Run, steps: StepInput[], summary = "测试待核对部署状态", type: "info" | "result" | "scope" = "info") => noteItemChange(app, r.id, { item: item.id, type, summary, steps, refs: [ref] });
  const finish = async (r: Run) => { await finishFollow(app, r); mark(r.id, "done"); };
  const takeovers = () => listRuns(app, { kind: "item-takeover", includeQuiet: true }).filter(r => r.input.itemTakeover);
  const report = (r: Run, id: string, extra: Record<string, unknown> = {}) => callTool({ app, runId: r.id, role: "assistant", actor: "agent", spaceId: item.spaceId, spaces: [item.spaceId], tools: new Set(["submit_item_step"]) }, "submit_item_step", { step_id: id, result: "部署记录已核对", refs: [ref], ...extra });
  const work = (r: Run) => runTakeover({ app, run: r, signal: new AbortController().signal, event: () => {}, output: () => {} });
  return { app, item, ref, mark, batch, note, finish, takeovers, report, work };
}

it("一批立即接手一次，只读结果写回；本人步骤只进待处理和今天，其他人步骤只回查一次", async () => {
  const t = await setup();
  const r = t.batch();
  const c = t.note(r, [read, owner]);
  const due = new Date(Date.now() + 60_000);
  const other = t.note(r, [{ who: "other" , step: "补测试报告", done_when: "报告在测试记录中可见", waiting_for: "小王", check_at: due.toISOString() }], "还缺一份测试报告");
  const more = t.note(r, [read], "看部署时间", "result");
  await t.finish(r);
  expect(t.takeovers()).toHaveLength(1);
  const inspection = t.mark(t.takeovers()[0].id, "running");
  expect(inspection.input.itemTakeover).toMatchObject({ steps: [c.steps[0].id, more.steps[0].id].sort() });
  const ask = listAsks(t.app, { runId: r.id })[0];
  expect(ask.shownAt).toBeNull();
  expect(await pendingActions(t.app, "owner")).toEqual(expect.arrayContaining([expect.objectContaining({ title: owner.step, askId: ask.id })]));
  expect((await buildToday(t.app))?.question).toContain(owner.step);
  expect((await t.report(inspection, c.steps[0].id, { done: true })).isError).toBe(false);
  expect(stepViews(t.app, c.id)[0]).toMatchObject({ status: "done", refs: [t.ref] });
  expect(lineTimeline(t.app, t.item.id).find(x => x.id === c.id)?.detail).toContain("部署记录已核对");
  expect(listAsks(t.app, { runId: inspection.id })).toHaveLength(0);
  expect((await t.report(inspection, more.steps[0].id, { done: true, decision: { title: "要不要保留旧入口？", options: ["保留", "移除"] } })).isError).toBe(false);
  expect((await t.report(inspection, more.steps[0].id, { done: true })).isError).toBe(true);
  expect(listAsks(t.app, { runId: inspection.id })).toHaveLength(1);
  t.mark(inspection.id, "done");
  checkDueChangeSteps(t.app, new Date(+due + 1));
  expect(t.takeovers()).toHaveLength(2);
  const recheck = t.mark(t.takeovers().find(x => x.id !== inspection.id)!.id, "running");
  expect((await t.report(recheck, other.steps[0].id, { operation, done: false })).isError).toBe(false);
  expect(stepViews(t.app, other.id)[0]).toMatchObject({ status: "checked", checkAt: due.toISOString() });
  t.mark(recheck.id, "done");
  checkDueChangeSteps(t.app, new Date(+due + 60000));
  expect(t.takeovers()).toHaveLength(2);
});

it("off 不接手、suggest 只存写入建议，未定范围不推进", async () => {
  for (const mode of ["off", "suggest"] as const) {
    const t = await setup(mode), r = t.batch();
    const c = t.note(r, [read, write]);
    const cli = t.note(r, [write], "测试单待更新", "result");
    t.note(r, [write], "小王提议多做一项", "scope");
    await t.finish(r);
    expect(t.takeovers()).toHaveLength(mode === "off" ? 0 : 1);
    if (mode === "off") continue;
    const next = t.mark(t.takeovers()[0].id, "running");
    expect(next.input.itemTakeover).toMatchObject({ steps: [...c.steps, ...cli.steps].map(s => s.id).sort() });
    expect((await t.report(next, c.steps[1].id, { operation })).text).toContain("前置核对");
    expect((await t.report(next, c.steps[0].id, { done: true })).isError).toBe(false);
    expect((await t.report(next, c.steps[1].id, { operation })).isError).toBe(false);
    expect(stepViews(t.app, c.id)[1].status).toBe("suggested");
    expect((await t.report(next, cli.steps[0].id, explain)).isError).toBe(false);
    expect(stepViews(t.app, cli.id)[0]).toMatchObject({ status: "suggested", result: expect.stringContaining(operationNote.target) });
    expect(listAsks(t.app, { runId: next.id })).toHaveLength(0);
  }
});

it("只重放同意的原参数，执行仍需要工具审批；拒绝不启动", async () => {
  const t = await setup("act"); setItemListening(t.app, t.item.id, true, { reply: "auto" });
  const send = vi.fn(async () => ({ code: 0, data: { message_id: "om_demo" } }));
  setLarkClient({ im: { message: { create: send } } });
  t.app.config.approvals.tools = ["lark_send"];
  t.app.config.approvals.waitSeconds = 0;
  const r = t.batch();
  const allow = t.note(r, [write]);
  const decline = t.note(r, [write], "不要回复过期进展", "result");
  await t.finish(r);
  const inspection = t.mark(t.takeovers()[0].id, "running");
  for (const c of [allow, decline]) expect((await t.report(inspection, c.steps[0].id, { operation })).isError).toBe(false);
  const find = (c: typeof allow) => listAsks(t.app, { runId: inspection.id }).find(a => a.id === one<{ ask_id: string }>(t.app.db, "select ask_id from item_change_steps where id=?", c.steps[0].id)?.ask_id)!;
  const proposal = find(allow);
  expect(proposal.question).toContain(operation.args.text);
  expect(proposal.options.map(o => o.label)).toEqual(["执行", "不执行"]);
  expect(send).not.toHaveBeenCalled();
  await answerAsk(t.app, find(decline).id, { choice: 1, by: "owner" });
  expect(t.takeovers()).toHaveLength(1);
  await expect(answerAsk(t.app, proposal.id, { choice: 0, by: "member" })).rejects.toThrow("只有事项本人");
  await answerAsk(t.app, proposal.id, { choice: 0, by: "owner" });
  const execution = t.mark(t.takeovers().find(x => x.id !== inspection.id)!.id, "running");
  expect(execution.lane).toBe(inspection.lane);
  expect(execution.input.threadId).toBe(inspection.input.threadId);
  expect((await t.work(execution)).text).toContain("需要");
  expect(send).not.toHaveBeenCalled();
  t.mark(execution.id, "done");
  const approval = listAsks(t.app, { runId: execution.id })[0];
  expect(approval).toMatchObject({ kind: "approval", status: "pending" });
  await answerAsk(t.app, approval.id, { approved: true, by: "owner" });
  await t.work(t.mark(execution.id, "running"));
  expect(send).toHaveBeenCalledTimes(1);
  expect(listAsks(t.app, { runId: execution.id })).toHaveLength(1);
  expect(JSON.stringify(send.mock.calls)).toContain(operation.args.text);
  expect(stepViews(t.app, allow.id)[0].result).toContain("已发送");
});

it("按事项限额、去重，范围内有人正在做时不排，事项关闭或关注暂停后不排", async () => {
  const t = await setup(); const r = t.batch(); const c = t.note(r, [read]);
  expect(t.note(r, [read]).id).toBe(c.id);
  const busy = t.mark(createRun(t.app, { kind: "agent", spaceId: "personal", title: "正在核对部署", input: { itemId: t.item.id } }).id, "running");
  await t.finish(r);
  expect(t.takeovers()).toHaveLength(0);
  t.mark(busy.id, "done");
  for (let i = 0; i < TAKEOVERS_PER_DAY; i++) t.mark(createRun(t.app, { kind: "item-takeover", spaceId: "personal", lane: `item-takeover:${t.item.id}`, title: "当天已接手", input: { itemTakeover: { phase: "inspect" } } }).id, "done");
  expect(queueChangeSteps(t.app, r.id)).toBeUndefined();
  const tomorrow = new Date(Date.now() + 86400_000);
  setItemListening(t.app, t.item.id, false);
  expect(queueChangeSteps(t.app, r.id, tomorrow)).toBeUndefined();
  setItemListening(t.app, t.item.id, true);
  expect(queueChangeSteps(t.app, r.id, tomorrow)).toBeDefined();
  const second = t.batch(); t.note(second, [read], "又一项修复", "result");
  upsertItem(t.app, t.item.id, { status: "done" }, "user");
  await t.finish(second);
  expect(queueChangeSteps(t.app, second.id, tomorrow)).toBeUndefined();
});

it("复核先看到本人在群里的新话，当前调用不发卡", async () => {
  const t = await setup(); const r = t.batch(); const c = t.note(r, [read]); await t.finish(r);
  const next = t.mark(t.takeovers()[0].id, "running");
  run(t.app.db, "insert into lark_messages(message_id,chat_id,sender_kind,content,create_ms) values('om_owner','oc_shop','owner','我已经处理了',?)", Date.now() + 1);
  const report = await t.report(next, c.steps[0].id, { done: true, decision: { title: "还需要继续吗？", options: ["继续", "停止"] } });
  expect(report.text).toContain("我已经处理了");
  expect(listAsks(t.app, { runId: next.id })).toHaveLength(0);
});

it("假 ACP 只读核对可按既有命令规则查询，写命令仍可拦截", async () => {
  const t = await setup(); const r = t.batch(); const c = t.note(r, [read]); await t.finish(r);
  t.app.config.agents.default = "fake";
  const log = join(t.app.home, "tool-calls.jsonl");
  t.app.config.security.commandRules = [commandRule("^status", "allow"), commandRule("^advance", "deny")];
  t.app.config.agents.profiles.push({ id: "fake", name: "假助手", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], idleTimeoutMs: 10000,
    env: { FAKE_MODE: "aware", FAKE_TOOL_LOG: log, FAKE_ITEM_COMMANDS: JSON.stringify([["samplectl", "status"], ["samplectl", "advance"]]),
      FAKE_ITEM_STEP: JSON.stringify({ step_id: c.steps[0].id, done: true, result: "假 ACP 核对通过", refs: [t.ref] }) } });
  const server = await startServer(t.app, { port: 0, quiet: true });
  try {
    const next = t.mark(t.takeovers()[0].id, "running");
    await t.work(next);
    expect(stepViews(t.app, c.id)[0]).toMatchObject({ status: "done", result: "假 ACP 核对通过" });
    expect(readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)).slice(0, 2)).toEqual([
      { command: ["samplectl", "status"], outcome: { outcome: "selected", optionId: "yes" } },
      { command: ["samplectl", "advance"], outcome: { outcome: "selected", optionId: "no" } },
    ]);
    expect(itemContext(t.app, t.item.id)?.knobs.assist).toBe("act");
  } finally { await server.close(); }
});

async function proposeNote(t: Awaited<ReturnType<typeof setup>>) {
  const r = t.batch();
  const change = t.note(r, [{ who: "me-write", step: operationNote.action, done_when: operationNote.expected }]);
  await t.finish(r);
  const inspect = t.mark(t.takeovers()[0].id, "running");
  expect((await t.report(inspect, change.steps[0].id, explain)).isError).toBe(false);
  const [card] = listAsks(t.app, { runId: inspect.id });
  t.mark(inspect.id, "done");
  return { inspect, change, card };
}

it("拒绝操作说明不起执行轮；已中断的执行不重新发给助手，下次接手先只读核对", async () => {
  const declined = await setup();
  const d = await proposeNote(declined);
  await answerAsk(declined.app, d.card.id, { choice: 1, by: "owner" });
  expect(listRuns(declined.app, { kind: "ask" })).toHaveLength(0);
  expect(stepViews(declined.app, d.change.id)[0].status).toBe("declined");

  const t = await setup();
  const { change, card } = await proposeNote(t);
  await answerAsk(t.app, card.id, { choice: 0, by: "owner" });
  const exec = t.mark(stepViews(t.app, change.id)[0].runId!, "running");
  setRunOutput(t.app, exec.id, { itemStepPromptedAt: new Date().toISOString() });
  const wouldRun = vi.fn(async () => ({}));
  await runApprovedItemStep({ app: t.app, run: exec, signal: new AbortController().signal, event: () => {}, output: () => {} }, wouldRun);
  expect(wouldRun).not.toHaveBeenCalled();
  expect(stepViews(t.app, change.id)[0]).toMatchObject({ status: "uncertain", statusLabel: "不确定，需要核对" });
  t.mark(exec.id, "done");
  await expect(retryRun(t.app, exec.id)).rejects.toThrow("不能重试");
  t.app.config.security.operationRules = [{ id: "later", revision: 1, enabled: true, action: "approve", approval: { waitSeconds: 1 }, match: { kind: "command", executable: "samplectl" } }];
  const held = await commandGate(t.app, { app: t.app, runId: exec.id, userId: "owner", actor: "agent", spaceId: t.item.spaceId, spaces: [t.item.spaceId], tools: new Set() },
    { command: "samplectl", args: ["advance"], cwd: t.app.home });
  expect(held.decision).toBe("pending");
  await answerAsk(t.app, held.askId!, { approved: true, choice: 0, by: "owner" });
  expect(listRuns(t.app, { kind: "ask" })).toHaveLength(1);

  const r = t.batch(); const nextChange = t.note(r, [read], "测试已补结果", "result"); await t.finish(r);
  const inspection = t.mark(stepViews(t.app, nextChange.id)[0].runId!, "running");
  const prompts = join(t.app.home, "prompts.jsonl");
  t.app.config.agents.default = "fake";
  t.app.config.agents.profiles.push({ id: "fake", name: "假助手", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], idleTimeoutMs: 10000,
    env: { FAKE_MODE: "aware", FAKE_PROMPT_FILE: prompts, FAKE_ITEM_STEP: JSON.stringify({ step_id: change.steps[0].id, done: true, result: "只读确认 A-17 已转为待复测", refs: [t.ref] }) } });
  const server = await startServer(t.app, { port: 0, quiet: true });
  try {
    await t.work(inspection);
    const prompt: string = JSON.parse(readFileSync(prompts, "utf8").trim());
    expect(prompt).toContain(`对象：${operationNote.target}`);
    expect(prompt).toContain("先只读核对以下曾执行但结果不确定的步骤");
    expect(stepViews(t.app, change.id)[0]).toMatchObject({ status: "executed", result: "只读确认 A-17 已转为待复测" });
    expect(listAsks(t.app, { runId: inspection.id })).toHaveLength(0);
    expect(listRuns(t.app, { kind: "ask" })).toHaveLength(1);
  } finally { await server.close(); }
});

it("批准操作说明后在事项会话开普通助手轮，命令另行批准，结果写回步骤", async () => {
  const t = await setup();
  const { inspect, change, card } = await proposeNote(t);
  for (const text of [...Object.values(operationNote), explain.result, t.ref]) expect(card.question).toContain(text);
  expect(card.options.map(o => o.label)).toEqual(["执行", "不执行"]);
  expect(listRuns(t.app, { kind: "ask" })).toHaveLength(0);
  await expect(answerAsk(t.app, card.id, { choice: 0, by: "member" })).rejects.toThrow("只有事项本人");
  await answerAsk(t.app, card.id, { choice: 0, by: "owner" });
  await expect(answerAsk(t.app, card.id, { choice: 0, by: "owner" })).rejects.toThrow("已经回答过");
  const [exec] = listRuns(t.app, { kind: "ask" });
  expect(exec).toMatchObject({ lane: inspect.lane, parentId: inspect.id, input: { conversationId: inspect.input.threadId, itemStepApproval: change.steps[0].id } });
  expect(stepViews(t.app, change.id)[0]).toMatchObject({ status: "approved", runId: exec.id });

  const prompts = join(t.app.home, "prompts.jsonl");
  t.app.config.agents.default = "fake";
  t.app.config.security.commandRules = [commandRule("^advance", "approve")];
  t.app.config.agents.profiles.push({ id: "fake", name: "假助手", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], idleTimeoutMs: 10000,
    env: { FAKE_MODE: "aware", FAKE_PROMPT_FILE: prompts, FAKE_ITEM_EXECUTE: "1", FAKE_ITEM_COMMANDS: JSON.stringify([["samplectl", "advance"]]), FAKE_ANSWER: "A-17 已转为待复测。" } });
  const server = await startServer(t.app, { port: 0, quiet: true });
  try {
    startWorker(t.app);
    const waiting = () => listAsks(t.app, { runId: exec.id, status: "pending" }).find(a => a.handler === "command-gate");
    await vi.waitFor(() => expect(waiting()).toBeDefined(), { timeout: 10000 });
    expect(stepViews(t.app, change.id)[0].status).toBe("approved");
    await answerAsk(t.app, waiting()!.id, { approved: true, choice: 0, by: "owner" });
    const finished = await waitForRun(t.app, exec.id);
    expect(finished, finished.error ?? undefined).toMatchObject({ status: "done", output: { answer: "A-17 已转为待复测。" } });
    const prompt: string = JSON.parse(readFileSync(prompts, "utf8").trim());
    for (const part of [...Object.values(operationNote), explain.result, t.ref, "本人已在卡片上同意执行这一步，只限这一步", "不要顺带做别的写操作"])
      expect(prompt).toContain(part);
    expect(conversationMessages(t.app, String(exec.input.conversationId)).at(-1)).toMatchObject({ role: "assistant", runId: exec.id, text: finished.output.answer });
    expect(stepViews(t.app, change.id)[0]).toMatchObject({ status: "executed", result: "已核对：示例单 A-17 已转为待复测", refs: [t.ref] });
  } finally { stopWorker(); await server.close(); }
});
