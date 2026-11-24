import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { setFirstLookBudgetForTests } from "../src/rules/first-look.ts";
import { saveProbe } from "../src/rules/probes.ts";
import { receive } from "../src/agents/inbox.ts";
import { createRun, listRuns, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { answerAsk } from "../src/agents/asks.ts";
import { callTool } from "../src/agents/tools.ts";
import { findRule, saveRule } from "../src/rules/store.ts";
import { dispatchRuleEvent } from "../src/rules/engine.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { addItemEvent, getItem, upsertItem } from "../src/items/store.ts";
import { addLocalMaterials } from "../src/items/materials.ts";
import { addChange } from "../src/items/changes.ts";
import { pendingActions } from "../src/items/pending.ts";
import { buildToday } from "../src/items/today.ts";
import { tickSituations } from "../src/situations/awareness.ts";
import { closeDueSituations, finishSituation, listSituations, MAX_ACTIVE, MAX_PER_DAY, requireInstance, startSituation, updateSituation } from "../src/situations/instances.ts";
import { deleteSituation, requireSituation, saveSituation, situationRuleId } from "../src/situations/settings.ts";
import { queueSituationTeaching, proposeSituation, teachingSteps } from "../src/situations/teaching.ts";

const app = testApp();
const home = app.home;
const prompts = join(home, "prompts.jsonl");
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  app.config.agents.default = "fake";
  app.config.agents.profiles = [agentProfileSchema.parse({ id: "fake", transport: "acp", command: process.execPath,
    args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "situation", FAKE_PROMPT_LOG: prompts } })];
  server = await startServer(app, { port: 0, quiet: true });
  startWorker(app);
}, 60_000);
afterAll(async () => { stopWorker(); releaseAll(); await server?.close(); });
afterEach(() => { setDecisionFetchForTests(null); app.config.ai.decision.provider = ""; });
const make = (name: string) => saveSituation(app, "owner", { name, note: "核对范围，异常时私下通知", recognize: "群里说了演练开始", knobs: { batchMinutes: 0 } });
function signal(id: string, text = "演练开始 项目 A"): RuleEvent {
  return { key: `lark:${id}`, kind: "message", at: new Date().toISOString(), via: "test",
    chat: { id: "oc_demo", name: "项目 A 群", kind: "group" }, sender: { kind: "bot", name: "演练机器人" },
    message: { id, text, type: "text", mentionsOwner: false, mentionsBot: false } };
}
function fakeDecision(answer: (b: any) => unknown) {
  app.config.ai.providers = [{ id: "d", kind: "openai", name: "测试决策", backends: [] }];
  app.config.ai.decision = { provider: "d", model: "", fallback: "none", gatekeeper: true };
  setKey(home, "d", "test-key");
  setDecisionFetchForTests((async (_url: string, init: RequestInit) => new Response(JSON.stringify({ answers: [answer(JSON.parse(String(init.body)))] }))) as typeof fetch);
}
function toolContext(runId: string) {
  return { app, userId: "owner", actor: "agent" as const, role: "assistant" as const, runId, spaceId: "personal", spaces: null, tools: null };
}
const asOwner = async () => {
  const t = createThread(app, { spaceId: "personal", channel: "web" });
  const messageId = addMessage(app, t.id, "user", "请保存这个情境");
  const r = createRun(app, { kind: "ask", lane: t.id, spaceId: "personal", input: { conversationId: t.id, messageIds: [messageId] }, title: "本人测试", notBefore: new Date(Date.now() + 600_000).toISOString() });
  return toolContext(r.id);
};

describe("情境", () => {
  it("固化并维护同一条规则；命中后经 fake ACP 处理；无模型并入最近一回，模型可拒绝和另开", async () => {
    const { context: c } = await make("例行演练");
    const id = situationRuleId(c.id);
    expect(findRule(app, id)).toMatchObject({ enabled: true, origin: { kind: "situation", contextId: c.id, name: c.name }, actions: [{ type: "context", context: c.id }] });
    await dispatchRuleEvent(app, signal("om_test_a"));
    const [first] = listSituations(app, "owner", { contextId: c.id });
    expect(getItem(app, first.itemId).sourceRefs).toEqual(["lark:om_test_a"]);
    const r = one<{ id: string }>(app.db, "select id from runs where lane=? and kind='ask'", first.conversationId)!;
    expect((await waitForRun(app, r.id)).status).toBe("done");
    expect(readFileSync(prompts, "utf8")).toContain("窗口内按说明盯着");
    await dispatchRuleEvent(app, signal("om_test_b"));
    expect(listSituations(app, "owner", { contextId: c.id })).toHaveLength(1);
    fakeDecision(() => ({ type: "choice", choice: "unrelated" }));
    await dispatchRuleEvent(app, signal("om_test_c"));
    expect(threadMessages(app, first.conversationId, { limit: 30 }).filter(m => m.role === "user")).toHaveLength(2);
    fakeDecision(() => ({ type: "choice", choice: "new" }));
    await dispatchRuleEvent(app, signal("om_test_d"));
    expect(listSituations(app, "owner", { contextId: c.id })).toHaveLength(2);
    await saveSituation(app, "owner", { id: c.id, name: "项目演练", status: "paused" });
    expect(findRule(app, id)).toMatchObject({ enabled: false, origin: { name: "项目演练" } });
    expect(() => saveRule(app, { ...findRule(app, id)!, temporary: undefined, enabled: true })).toThrow(/情境生成/);
    await deleteSituation(app, "owner", c.id);
    expect(findRule(app, id)).toBeNull();
    expect(listSituations(app, "owner", { contextId: c.id, status: "active" })).toHaveLength(0);
  }, 90_000);

  describe("情境的快速通道", () => {
    const sent: { op: string; args: any }[] = [];
    const lookOf = (lane: string) => listRuns(app, { kind: "first-look" }).filter(r => r.lane === lane);
    const promptsOf = () => readFileSync(prompts, "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
    beforeAll(() => {
      app.config.lark.ownerOpenId = "ou_owner";
      app.config.agents.profiles.push(agentProfileSchema.parse({ id: "fake-look", transport: "acp", command: process.execPath,
        args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "first-look", FAKE_PROMPT_LOG: prompts } }));
      app.config.agents.roles["first-look"] = "fake-look";
      const send = (op: string) => async (args: any) => {
        sent.push({ op, args });
        return { code: 0, data: { message_id: `om_first_${sent.length}` } };
      };
      setLarkClient({ im: { message: { create: send("create"), reply: send("reply") } } } as never);
      saveProbe(app, { name: "situation-status", description: "查演练状态", runtime: "node",
        code: "const e = JSON.parse(process.env.OMEM_EVENT); console.log('PROBE-OUT:' + (e.message?.id ?? e.kind));" }, "owner");
    });
    afterEach(() => { setFirstLookBudgetForTests(null); sent.length = 0; });
    afterAll(() => {
      delete app.config.agents.roles["first-look"];
      app.config.agents.profiles = app.config.agents.profiles.filter(p => p.id !== "fake-look");
      setLarkClient(null);
    });

    it("首个规则信号先查再看；答完照常处理，后续信号只跑预查", async () => {
      const { context: c } = await saveSituation(app, "owner", { name: "项目 B 演练", note: "核对项目 B 的演练范围", recognize: "群里说了演练开始",
        knobs: { batchMinutes: 0, firstLook: true, probes: ["situation-status"], firstTo: "chat", reply: "auto" } });
      try {
        await dispatchRuleEvent(app, signal("om_situation_first", "演练开始 项目 B [answered]"));
        const [i] = listSituations(app, "owner", { contextId: c.id });
        const [look] = lookOf(i.conversationId);
        const first = one<{ id: string }>(app.db, "select id from runs where lane=? and kind='ask'", i.conversationId)!;
        expect((await waitForRun(app, look.id)).output).toMatchObject({ outcome: "answered", delivered: { to: "chat" } });
        expect((await waitForRun(app, first.id)).status).toBe("done");
        const lookPrompt = promptsOf().find(p => p.includes("# 先看一眼：情境「项目 B 演练」"))!;
        for (const piece of [c.note!, c.recognize!, "演练开始 项目 B", "PROBE-OUT:om_situation_first"]) expect(lookPrompt).toContain(piece);
        const handler = promptsOf().find(p => p.includes(`# 情境：${i.title}`))!;
        for (const piece of ["PROBE-OUT:om_situation_first", "快速结论 answered", "窗口内别的运行"]) expect(handler).toContain(piece);
        expect(sent.find(x => x.op === "reply")?.args.path.message_id).toBe("om_situation_first");

        await dispatchRuleEvent(app, signal("om_situation_next", "演练开始 项目 B，后续进展"));
        const next = one<{ id: string }>(app.db, "select id from runs where lane=? and kind='ask' order by rowid desc", i.conversationId)!;
        expect(next.id).not.toBe(first.id);
        expect((await waitForRun(app, next.id)).status).toBe("done");
        expect(lookOf(i.conversationId)).toHaveLength(1);
        expect(promptsOf().find(p => p.includes("PROBE-OUT:om_situation_next"))).toContain(`事项 ${i.itemId}`);
        expect(sent.filter(x => x.op === "reply")).toHaveLength(1);
      } finally { await deleteSituation(app, "owner", c.id); }
    }, 90_000);

    it("手工开始超时照常处理，非群事件降为私聊；当天先看上限不挡新开", async () => {
      setFirstLookBudgetForTests(2000);
      const { context: c } = await saveSituation(app, "owner", { name: "手工演练", note: "核对范围", recognize: "群里说了演练开始",
        knobs: { batchMinutes: 0, perDay: 1, firstLook: true, probes: ["situation-status"], firstTo: "ephemeral" } });
      try {
        const { instance: i, runId } = await startSituation(app, "owner", c.id, "练习超时 [slow]");
        const [look] = lookOf(i.conversationId);
        expect((await waitForRun(app, look.id)).output).toMatchObject({ outcome: "escalate", stages: { look: { by: "host", reason: expect.stringContaining("秒内没看完") } }, delivered: { to: "dm" } });
        expect((await waitForRun(app, runId!)).status).toBe("done");
        const handler = promptsOf().find(p => p.includes(`# 情境：${i.title}`))!;
        expect(handler).toContain("PROBE-OUT:situation-start");
        expect(handler).toContain("先看一眼没有结论");
        expect(sent.find(x => x.op === "create")?.args.data.receive_id).toBe("ou_owner");
        expect(JSON.stringify(sent)).not.toContain("不用查了");
        const second = await startSituation(app, "owner", c.id, "当天另一回");
        expect(lookOf(second.instance.conversationId)).toHaveLength(0);
        expect((await waitForRun(app, second.runId!)).status).toBe("done");
      } finally { await deleteSituation(app, "owner", c.id); }
    }, 90_000);
  });

  it("给其他运行带现状；收事项事件、变化和本人在别处的话，不回自己的记录或重复信息", async () => {
    const { context: c } = await make("项目 A 值守");
    const { instance: i, runId } = await startSituation(app, "owner", c.id, "版本 A");
    await waitForRun(app, runId!);
    updateSituation(app, i, { current: "刚验证项目 A 的入口" }, runId!);
    const other = await receive(app, { channel: "web", text: "请核对项目 A 的表现" });
    expect((await waitForRun(app, other.runId!)).status).toBe("done");
    expect(readFileSync(prompts, "utf8")).toContain("正在进行的情境");
    expect(readFileSync(prompts, "utf8")).toContain("刚验证项目 A 的入口");
    addItemEvent(app, i.itemId, "note", "看完自己的记录", "agent", [], runId!);
    addItemEvent(app, i.itemId, "note", "发现入口出错", "agent", [], other.runId!);
    addChange(app, { itemId: i.itemId, type: "info", summary: "核对了入口变化", origin: "owner", runId: other.runId! });
    const t = createThread(app, { spaceId: "personal", channel: "web", title: "另一个会话" });
    addMessage(app, t.id, "user", "项目 A 改回旧版本");
    addMessage(app, t.id, "user", "中午吃什么");
    fakeDecision(b => ({ type: "predicate", probability: JSON.stringify(b.input).includes("项目 A 改回旧版本") ? 0.95 : 0.05 }));
    await tickSituations(app);
    await tickSituations(app);
    const texts = threadMessages(app, i.conversationId, { limit: 60 }).filter(m => m.role === "user").map(m => m.text).join("\n");
    expect(texts).toContain(`运行 ${other.runId}`);
    expect(texts).toContain("核对了入口变化");
    expect(texts).not.toContain("看完自己的记录");
    expect(texts).not.toContain("中午吃什么");
    expect(texts.match(/项目 A 改回旧版本/g)).toHaveLength(1);
    const at = Date.now();
    run(app.db, "update situation_instances set window_until=? where id=?", new Date(at - 1000).toISOString(), i.id);
    await closeDueSituations(app, at);
    const closing = requireInstance(app, "owner", i.id).closingRun;
    expect(closing).toBeTruthy();
    await waitForRun(app, closing!);
    expect(requireInstance(app, "owner", i.id)).toMatchObject({ status: "ended", summary: "刚验证项目 A 的入口" });
    expect(getItem(app, i.itemId).status).toBe("done");
    const b = await startSituation(app, "owner", c.id, "版本 B");
    await waitForRun(app, b.runId!);
    run(app.db, "update situation_instances set window_until=? where id=?", new Date(at - 1000).toISOString(), b.instance.id);
    await closeDueSituations(app);
    const wrap = requireInstance(app, "owner", b.instance.id).closingRun;
    expect((await waitForRun(app, wrap!)).status).toBe("done");
    expect(requireInstance(app, "owner", b.instance.id).summary).toBe("已核对版本 B 的恢复。");
    await deleteSituation(app, "owner", c.id);
  }, 90_000);

  it("仅本人对话可设，提议等确认，改说明返回前后对照", async () => {
    const ctx = await asOwner();
    const draft = await callTool(ctx, "save_situation", { name: "项目 A 提测", note: "先看提测范围", recognize: "群里说演练开始" });
    expect(draft.text).toContain("等待本人启用");
    const ask = one<{ id: string; contextId: string }>(app.db, "select id,json_extract(context,'$.contextId') contextId from asks where run_id=?", ctx.runId)!;
    expect(requireSituation(app, "owner", ask.contextId).status).toBe("paused");
    await answerAsk(app, ask.id, { choice: 0, by: "owner" });
    expect(findRule(app, situationRuleId(ask.contextId))?.enabled).toBe(true);
    const edit = await callTool(ctx, "save_situation", { id: ask.contextId, note: "提测还要看已知限制", owner_requested: true });
    expect(edit.text).toContain("原说明：先看提测范围");
    expect(edit.text).toContain("新说明：提测还要看已知限制");
    expect((await callTool({ ...ctx, runId: null }, "save_situation", { name: "不能建" })).isError).toBe(true);
    await deleteSituation(app, "owner", ask.contextId);
  }, 90_000);

  it("三轮才可提议，在待处理和今天可答，不用后不再提同类", async () => {
    const i = upsertItem(app, undefined, { title: "与项目 A 一起演练" }, "user");
    const t = createThread(app, { spaceId: "personal", channel: "web", settings: { itemId: i.id } });
    addLocalMaterials(app, i.id, [{ kind: "conversation", ref: t.id }], "owner");
    for (const text of ["先核对范围", "再查测试记录", "最后收集结论"]) {
      const r = await receive(app, { conversationId: t.id, text });
      await waitForRun(app, r.runId!);
      if (text === "再查测试记录") expect(teachingSteps(app, getItem(app, i.id))).toHaveLength(2);
    }
    const done = upsertItem(app, i.id, { status: "done" }, "user");
    expect(teachingSteps(app, done)).toHaveLength(3);
    const teaching = queueSituationTeaching(app, done) ?? one<{ id: string }>(app.db, "select id from runs where lane=?", `situation-teaching:${i.id}`)!;
    const args = { name: "项目 A 演练", recognize: "有人发出开始信号", note: "先读范围，再查记录", steps: ["核对范围", "查测试记录", "收集结论"], until: "收集结论" };
    expect(await proposeSituation(app, i.id, teaching.id, args)).toContain("待处理");
    const p = (await pendingActions(app, "owner")).find(x => x.label === "情境" && x.itemId === i.id)!;
    expect(p.askId).toBeTruthy();
    expect((await buildToday(app))?.fields.find(f => f.id === `sit_${p.askId}`)).toMatchObject({ options: ["可以", "改一改", "不用"] });
    await answerAsk(app, p.askId!, { choice: 2, by: "owner" });
    expect(await proposeSituation(app, i.id, teaching.id, args)).toContain("说过不用");
    fakeDecision(() => ({ type: "predicate", probability: 0.99 }));
    expect(await proposeSituation(app, i.id, teaching.id, { ...args, name: "项目 A 例行练习" })).toContain("同类情境不用再提");
  }, 90_000);

  it("复用关注 HTTP 接口并可手工开始、结束或读实例", async () => {
    const created = await server.inject({ method: "POST", url: "/api/listen", payload: { kind: "situation", name: "接口演练", note: "核对演练结果", recognize: "发出开始信号", knobs: { batchMinutes: 0 } } });
    expect(created.statusCode, created.body).toBe(200);
    const c = created.json();
    expect(c).toMatchObject({ userId: "owner", kind: "situation", recognize: "发出开始信号" });
    const started = await server.inject({ method: "POST", url: `/api/listen/${c.id}/start`, payload: { about: "手工开一回" } });
    expect(started.statusCode, started.body).toBe(200);
    const { instance } = started.json();
    expect((await server.inject({ url: `/api/situation-instances?contextId=${c.id}&status=active` })).json()).toMatchObject([{ id: instance.id, status: "active" }]);
    expect((await server.inject({ url: `/api/situation-instances/${instance.id}` })).json()).toMatchObject({ item: { id: instance.itemId } });
    expect((await server.inject({ method: "POST", url: `/api/situation-instances/${instance.id}/end`, payload: { summary: "人工确认结束" } })).json()).toMatchObject({ status: "ended", summary: "人工确认结束" });
    expect((await server.inject({ method: "DELETE", url: `/api/listen/${c.id}` })).json()).toEqual({ ok: true });
  }, 90_000);

  it("限制每类同时进行和每天新开次数", async () => {
    const { context: c } = await make("重复演练");
    for (let n = 0; n < MAX_PER_DAY; n++) {
      if (n === MAX_ACTIVE) await expect(startSituation(app, "owner", c.id, "超上限")).rejects.toThrow(/同时/);
      if (n >= MAX_ACTIVE) {
        const i = listSituations(app, "owner", { contextId: c.id, status: "active" }).at(-1)!;
        finishSituation(app, "owner", i.id);
      }
      await startSituation(app, "owner", c.id, `第 ${n + 1} 次`);
    }
    for (const i of listSituations(app, "owner", { contextId: c.id, status: "active" })) finishSituation(app, "owner", i.id);
    await expect(startSituation(app, "owner", c.id, "超上限")).rejects.toThrow(/今天/);
    expect(all(app.db, "select id from situation_instances where context_id=?", c.id)).toHaveLength(MAX_PER_DAY);
    expect(listSituations(app, "member", { contextId: c.id })).toEqual([]);
  }, 90_000);
});
