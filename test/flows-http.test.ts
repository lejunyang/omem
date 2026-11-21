import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { cleanupFetched, mergeLibrary, snapshotStream, type Fetched } from "../src/core/pull.ts";
import { createSpace } from "../src/core/spaces.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { appendToSource } from "../src/sources/store.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { advance, ownerAction, reportStage, startFlow, startRound, studyOperation } from "../src/flows/engine.ts";
import { agentProfileSchema } from "../src/core/config.ts";
import { getStage, itemFlow, stageLog } from "../src/flows/store.ts";
import { callTool } from "../src/agents/tools.ts";
import { createRun, getRun, startWorker, stopWorker } from "../src/agents/runs.ts";
import { saveAgentSpec, saveSkill } from "../src/agents/specs.ts";
import * as runner from "../src/agents/runner.ts";
import { recordTests } from "../src/items/req-tests.ts";

const raw = "id: demo\nname: 示例流程\nstages:\n  - id: check\n    name: 核验\n    note: 核验材料后再交付。\n    by: wait\n    gate: confirm\n";
const apps: App[] = [];
const servers: FastifyInstance[] = [];
const fixture = () => { const app = testApp(); apps.push(app); return app; };
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await new Promise((resolve) => setImmediate(resolve));
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});
async function serverFor(app: App) { const s = await startServer(app, { port: 0, quiet: true }); servers.push(s); return s; }

describe("流程 HTTP", () => {
  it("列表返回各承担者、完成条件和时限的结构化摘要", async () => {
    const app=fixture(), server=await serverFor(app);
    saveFlow(app, JSON.stringify({id:"summary",name:"摘要",stages:[
      {id:"owner",name:"本人核对",by:"owner",done:{signal:"git.pushed",with:{}}},
      {id:"wait",name:"等进展",by:"wait",done:"confirm"},
      {id:"assistant",name:"整理",by:{run:{}},budget:{minutes:15},at:"08:00",window:"08:00-12:00"},
      {id:"profile",name:"复核",by:{run:{agent:"reviewer",skill:"inspect"}}},
      {id:"object",name:"方案",by:{object:"design"},done:{object:"design",status:"approved"}},
    ]}),"owner");
    const summary=(await server.inject("/api/flows")).json().flows[0].stageSummaries;
    expect(summary).toMatchObject([
      {id:"owner",name:"本人核对",carrier:{kind:"owner",name:"本人"},done:{kind:"signal",id:"git.pushed",name:"推到远端",params:{}}},
      {carrier:{kind:"wait"},done:{kind:"confirm"}},
      {carrier:{kind:"assistant",id:"assistant"},time:{at:"08:00",window:"08:00-12:00",minutes:15}},
      {carrier:{kind:"profile",id:"reviewer",name:"reviewer",skill:"inspect"}},
      {carrier:{kind:"object",id:"design"},done:{kind:"object",statuses:["approved"]}},
    ]);
  });

  it.each(["网页", "助手"])("%s 只允许成员开始可见且适用的流程", async entry => {
    const app = fixture(), server = await serverFor(app);
    const userId = "flow-member", spaceId = "project-a";
    createUser(app, { id: userId, name: "流程成员" });
    for (const id of [spaceId, "project-b"]) createSpace(app, { id, name: id });
    addMember(app, spaceId, userId, "editor");
    const item = upsertItem(app, undefined, { title: "核验", spaceId, userId });
    const headers = { authorization: `Bearer ${createApiToken(app, userId, "test")}` };
    const ctx = { app, userId, runId: null, spaceId, spaces: [spaceId], tools: null, actor: "agent" as const };
    const start = async (flow: string) => {
      if (entry === "助手") return (await callTool(ctx, "flow_start", { item: item.id, flow })).text;
      const response = await server.inject({ method: "POST", url: `/api/items/${item.id}/flow`, headers, payload: { flow } });
      return `${response.statusCode} ${response.body}`;
    };
    // Compare the same request before and after adding a definition outside the member's scope.
    const missing = await start("private-flow");
    expect(missing).toContain("没有流程");
    if (entry === "网页") expect(missing).toMatch(/^404 /);
    saveFlow(app, JSON.stringify({ id: "private-flow", name: "专用流程", for: { spaces: ["project-b"] }, stages: [{ id: "check", name: "专用核验", by: "wait" }] }), "owner");
    expect(await start("private-flow")).toBe(missing);
    expect(itemFlow(app, item.id)).toBeNull();
    addMember(app, "project-b", userId, "reader");
    if (entry === "助手") expect(await start("private-flow")).toBe(missing);
    else expect(await start("private-flow")).toContain("不适用于该事项");
    saveFlow(app, JSON.stringify({ id: "decision-only", name: "决定流程", for: { kinds: ["decision"] }, stages: [{ id: "check", name: "核验决定", by: "wait" }] }), "owner");
    expect(await start("decision-only")).toContain("不适用于该事项");
    expect(itemFlow(app, item.id)).toBeNull();
    saveFlow(app, raw, "owner");
    expect(await start("demo")).toContain("核验材料");
    expect(itemFlow(app, item.id)?.id).toBe("demo");
  });
  it("成员降为只读后回答旧关卡，提问和阶段保持原状", async () => {
    const app = fixture(), server = await serverFor(app);
    createUser(app, { id: "member", name: "成员" });
    createSpace(app, { id: "project", name: "项目" });
    addMember(app, "project", "member", "editor");
    saveFlow(app, raw, "owner");
    const item = upsertItem(app, undefined, { title: "核验", spaceId: "project", userId: "member" }, "user");
    await startFlow(app, item.id, "demo", { actor: "owner", userId: "member" });
    const stage = getStage(app, item.id, "check");
    const ask = getAsk(app, stage.askId!);
    expect(ask.status).toBe("pending");
    addMember(app, "project", "member", "reader");
    const headers = { authorization: `Bearer ${createApiToken(app, "member", "test")}` };
    const response = await server.inject({ method: "POST", url: `/api/asks/${ask.id}/answer`, headers, payload: { choice: 0 } });
    expect(response.statusCode).toBe(403);
    expect(getAsk(app, ask.id)).toEqual(ask);
    expect(getStage(app, item.id, "check")).toEqual(stage);

    addMember(app, "project", "member", "editor");
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = studyOperation(app, item.id, () => hold);
    await new Promise<void>(resolve => setImmediate(resolve));
    const queued = answerAsk(app, ask.id, { choice: 0, by: "member", deferEffects: true });
    addMember(app, "project", "member", "reader");
    release();
    await locked;
    await expect(queued).rejects.toMatchObject({ status: 403 });
    expect(getAsk(app, ask.id)).toEqual(ask);
    expect(getStage(app, item.id, "check")).toEqual(stage);
    addMember(app, "project", "member", "editor");
    expect((await answerAsk(app, ask.id, { choice: 0, by: "member" })).status).toBe("answered");
    expect(getStage(app, item.id, "check").state).toBe("doing");
  });
  it("逐条签字可撤销，限本人和当前阶段轮次；全对仍等确认，返工带不对的结果且新结果不继承签字", async () => {
    const app = fixture(), server = await serverFor(app);
    createSpace(app, { id: "project", name: "项目 A" });
    saveFlow(app, JSON.stringify({ id: "demo", name: "示例验证", repeat: { from: "verify" }, stages: [
      { id: "verify", name: "验证", by: { run: {} }, done: "confirm" }, { id: "after", name: "后续", by: "wait" },
    ] }), "owner");
    const item = upsertItem(app, undefined, { title: "示例商城", spaceId: "project" }, "user");
    await startFlow(app, item.id, "demo", { actor: "owner" });
    const runId = getStage(app, item.id, "verify").control.runId!;
    const [a, b] = recordTests(app, { runId, workId: null, spaceId: "project", round: 1, by: "assistant", tests: [{ name: "退款金额", status: "passed" }, { name: "运费", status: "passed" }] });
    const base = `/api/items/${item.id}/flow/stages`;
    const sign = (id: string, verdict: unknown, note?: string, stage = "verify", headers = {}) => server.inject({ method: "POST", url: `${base}/${stage}/tests/${id}`, payload: { verdict, note }, headers });
    createUser(app, { id: "reader", name: "成员甲" }); addMember(app, "project", "reader", "editor");
    expect((await sign(a.id, "ok", undefined, "verify", { authorization: `Bearer ${createApiToken(app, "reader", "test")}` })).statusCode).toBe(403);
    expect((await sign(a.id, "invalid")).statusCode).toBe(400);
    expect((await sign(a.id, "ok", undefined, "after")).statusCode).toBe(404);
    expect((await sign(a.id, "ok")).json().stages[0].tests.find((t: { id: string }) => t.id === a.id)).toMatchObject({ verdict: "ok", verdictAt: expect.any(String) });
    expect((await sign(a.id, null)).json().stages[0].tests.find((t: { id: string }) => t.id === a.id)).toMatchObject({ verdict: null, verdictNote: null, verdictAt: null });
    await sign(a.id, "ok"); await sign(b.id, "ok");
    await reportStage(app, item.id, "verify", { state: "done", note: "逐条测过" }, { actor: "assistant", runId });
    expect(getStage(app, item.id, "verify").state).toBe("doing");
    await sign(a.id, "wrong", "退款差一元");
    await server.inject({ method: "POST", url: `${base}/verify/reopen`, payload: { note: "请重测" } });
    const next = getStage(app, item.id, "verify").control.runId!;
    expect(getRun(app, next).input.task).toContain("本人标了不对的：\n- 退款金额：退款差一元");
    expect(String(getRun(app, next).input.task)).not.toContain("- 运费");
    const [fresh] = recordTests(app, { runId: next, workId: null, spaceId: "project", round: 1, by: "assistant", tests: [{ name: "退款金额", status: "passed" }] });
    run(app.db, "update req_tests set at=? where id=?", a.at, fresh.id);
    const v = (await server.inject(`/api/items/${item.id}/flow`)).json();
    expect(v.stages[0].tests.find((t: { name: string }) => t.name === "退款金额")).toMatchObject({ id: fresh.id, verdict: null });
    expect((await sign(a.id, "ok")).statusCode).toBe(404);
    await ownerAction(app, item.id, "verify", "done", "通过"); await ownerAction(app, item.id, "after", "done", "通过");
    await startRound(app, item.id, { actor: "owner", userId: "owner" });
    expect((await sign(fresh.id, "ok")).statusCode).toBe(404);
  });
  it("补录限本人，未到和等确认可记完成，撤回问题并推进，重开清掉标记", async () => {
    const app = fixture(), server = await serverFor(app);
    createSpace(app, { id: "project", name: "项目 A" });
    saveFlow(app, JSON.stringify({ id: "demo", name: "示例流程", stages: [
      { id: "a", name: "澄清", by: "wait", gate: "confirm" },
      { id: "b", name: "编码", by: "wait" },
      { id: "c", name: "验收", by: "wait" },
    ] }), "owner");
    const item = upsertItem(app, undefined, { title: "示例商城", spaceId: "project" }, "user");
    await startFlow(app, item.id, "demo", { actor: "owner" });
    const ask = getStage(app, item.id, "a").askId!;
    const url = `/api/items/${item.id}/flow/stages`;
    const record = (id: string, payload: object, headers = {}) => server.inject({ method: "POST", url: `${url}/${id}/record`, payload, headers });
    createUser(app, { id: "reader", name: "成员甲" }); addMember(app, "project", "reader", "editor");
    expect((await record("b", { note: "已编码" }, { authorization: `Bearer ${createApiToken(app, "reader", "test")}` })).statusCode).toBe(403);
    expect((await record("b", {})).statusCode).toBe(400);
    expect((await record("b", { note: "已编码", refs: ["run:missing"] })).statusCode).toBe(400);
    expect((await record("b", { note: "已经编码" })).json().stages[1]).toMatchObject({ state: "done", recorded: true, note: "补录：已经编码" });
    expect(getStage(app, item.id, "a").state).toBe("gated");
    expect(getStage(app, item.id, "c").state).toBe("doing");
    expect((await record("c", { note: "已验收" })).statusCode).toBe(409);
    expect((await record("a", { note: "已经澄清" })).json().stages[0]).toMatchObject({ state: "done", recorded: true });
    expect(one<{ status: string }>(app.db, "select status from asks where id=?", ask)!.status).toBe("cancelled");
    expect(stageLog(app, item.id).find((l) => l.note === "补录：已经澄清")!.actor).toBe("owner");
    const reopened = await server.inject({ method: "POST", url: `${url}/a/reopen`, payload: { note: "需求变化" } });
    expect(reopened.json().stages[0].recorded).toBe(false);
  });
  it("补录收有效依据，最后一段的说明在流程结束后仍保留", async () => {
    const app = fixture(), server = await serverFor(app);
    saveFlow(app, raw, "owner");
    const item = upsertItem(app, undefined, { title: "示例核验", spaceId: "personal" }, "user");
    await startFlow(app, item.id, "demo", { actor: "owner" });
    const evidence = createRun(app, { kind: "agent", spaceId: "personal", title: "已有核验记录" }).id;
    const url = `/api/items/${item.id}/flow/stages/check/record`;
    expect((await server.inject({ method: "POST", url, payload: { note: "已经核验", refs: [evidence] } })).statusCode).toBe(400);
    const result = (await server.inject({ method: "POST", url, payload: { note: "已经核验", refs: [`run:${evidence}`] } })).json();
    expect(result.flow.endedAt).toBeTruthy();
    expect(result.stages[0]).toMatchObject({ note: "补录：已经核验", recorded: true, evidence: [`run:${evidence}`] });
  });
  it("轮次与预算接口返回附加视图，限事项本人；校验含新字段的人话", async () => {
    const app = fixture(), server = await serverFor(app);
    createSpace(app, { id: "project", name: "项目 A" });
    const yaml = JSON.stringify({ id: "repeat", name: "示例核验", repeat: { from: "check" }, stages: [{ id: "check", name: "核验", by: { run: {} }, ai: "cheap", at: "00:00", budget: { minutes: 240, trials: 8 }, escalate: { to: "strong", max: 2 } }] });
    const checked = (await server.inject({ method: "POST", url: "/api/flows/validate", payload: { yaml } })).json();
    expect(checked.repeatDescription).toContain("你点了才开始下一轮");
    expect(checked.stages[0]).toMatchObject({ ai: "用省的模型；拿不准时最多请好的模型看 2 次", time: "这一轮 00:00 以后开始", budget: "最多跑 240 分钟" });
    saveFlow(app, yaml, "user");
    const item = upsertItem(app, undefined, { title: "示例核验", spaceId: "project" }, "user"), url = `/api/items/${item.id}/flow`;
    await server.inject({ method: "POST", url, payload: { flow: "repeat" } });
    expect((await server.inject({ method: "POST", url: `${url}/round`, payload: {} })).statusCode).toBe(409);
    const updated = await server.inject({ method: "POST", url: `${url}/stages/check/budget`, payload: { budget: { minutes: 60, trials: 4 }, escalate: { max: 1 } } });
    expect(updated.statusCode).toBe(200); expect(updated.json().stages[0]).toMatchObject({ budget: { minutes: 60, trials: 4 }, escalate: { to: "strong", max: 1 }, round: 1 });
    expect((await server.inject({ method: "POST", url: `${url}/stages/check/budget`, payload: { budget: { minutes: -1 } } })).statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: `${url}/stages/check/budget`, payload: { escalate: { max: -1 } } })).statusCode).toBe(400);
    createUser(app, { id: "reader-rounds", name: "成员乙" }); addMember(app, "project", "reader-rounds", "editor");
    const headers = { authorization: `Bearer ${createApiToken(app, "reader-rounds", "test")}` };
    for (const path of ["round", "stages/check/budget"]) expect((await server.inject({ method: "POST", url: `${url}/${path}`, payload: {}, headers })).statusCode).toBe(403);
    await ownerAction(app, item.id, "check", "done", "核验完成");
    const result = (await server.inject({ method: "POST", url: `${url}/round`, payload: {} })).json();
    expect(result.flow).toMatchObject({ round: 2, canStartRound: false }); expect(result.rounds[0]).toMatchObject({ round: 1 });
    expect(result.stages[0].budget).toEqual({ minutes: 60, trials: 4 });
    expect((await server.inject("/api/flows")).json().flows[0].definition.stages[0].budget.minutes).toBe(240);
  });
  it("校验只读，返回实际默认前提和文字解释，错误带原因，成员不可校验", async () => {
    const app = fixture(), server = await serverFor(app);
    const validate = (yaml: string) => server.inject({ method: "POST", url: "/api/flows/validate", payload: { yaml } });
    const result = (await validate(raw)).json();
    expect(result).toMatchObject({ ok: true, id: "demo", stages: [{ id: "check", name: "核验", carrier: "只等进展", gate: "开始前先问你", done: "交了结果就算做完", when: "", needs: [] }] });
    expect((await server.inject("/api/flows")).json().flows).toEqual([]);
    const bad = (await validate("id: bad\nname: 示例\nstages: []")).json();
    expect(bad.ok).toBe(false); expect(bad.problem).toContain("流程至少需要一个阶段");
    expect((await validate("stages: [")).json().problem).toContain("YAML");
    const detailed = (await validate("id: read\nname: 解释\nstages:\n  - {id: a, name: 整理, by: {run: {agent: assistant}}}\n  - {id: b, name: 本人核对, by: owner, done: confirm, when: 材料变化时}\n  - {id: c, name: 方案, by: {object: design}, done: {object: design, status: approved}}\n")).json();
    expect(detailed.stages[1]).toMatchObject({ carrier: "你来做", gate: "轮到就来找你", done: "做完要你点头", when: "只在需要时做：材料变化时", needs: ["a"] });
    expect(detailed.stages[2]).toMatchObject({ carrier: "跟着方案走", done: "方案到了 approved 算做完", needs: ["b"] });
    createUser(app, { id: "reader", name: "成员甲" });
    const headers = { authorization: `Bearer ${createApiToken(app, "reader", "test")}` };
    expect((await server.inject({ method: "POST", url: "/api/flows/validate", payload: { yaml: raw }, headers })).statusCode).toBe(403);
  });
  it("列表只返回可见事项的一个当前阶段，完成和停止后不再显示", async () => {
    const app = fixture(), server = await serverFor(app);
    saveFlow(app, raw, "user");
    const item = upsertItem(app, undefined, { title: "退款交付", spaceId: "personal" }, "user");
    await startFlow(app, item.id, "demo", { actor: "owner" });
    const listed = async () => (await server.inject("/api/items?status=all")).json().find((i: { id: string }) => i.id === item.id);
    expect((await listed()).flow).toEqual({ stage: "check", name: "核验", waiting: true });
    await ownerAction(app, item.id, "check", "confirm");
    expect((await listed()).flow).toEqual({ stage: "check", name: "核验", waiting: false });
    await ownerAction(app, item.id, "check", "done", "核验完成");
    expect((await listed()).flow).toBeNull();
    await ownerAction(app, item.id, "check", "reopen", "重看");
    await server.inject({ method: "DELETE", url: `/api/items/${item.id}/flow` });
    expect((await listed()).flow).toBeNull();
    createUser(app, { id: "reader", name: "成员甲" });
    const headers = { authorization: `Bearer ${createApiToken(app, "reader", "test")}` };
    expect((await server.inject({ url: "/api/items?status=all", headers })).json().some((i: { id: string }) => i.id === item.id)).toBe(false);
  });
  it("HTTP 只读 question 区分本人执行与助手报告后的完成确认", async () => {
    const app = fixture(), server = await serverFor(app);
    saveFlow(app, "id: owner-stage\nname: 本人确认\nstages:\n  - {id: push, name: 推送, by: owner}\n", "user");
    const item = upsertItem(app, undefined, { title: "核验推送", spaceId: "personal" }, "user");
    const url = `/api/items/${item.id}/flow`;
    expect((await server.inject({ method: "POST", url, payload: { flow: "owner-stage" } })).json().stages[0].question).toBe("owner");
    await reportStage(app, item.id, "push", { state: "done", note: "助手报告已推送", evidence: [] }, { actor: "assistant" });
    expect((await server.inject(url)).json().stages[0]).toMatchObject({ state: "doing", question: "done" });
    expect((await server.inject({ method: "POST", url: `${url}/stages/push/confirm`, payload: {} })).json().stages[0]).toMatchObject({ state: "done", question: null });
  });
  it("定义原文和错误、路径校验、所有事项动作与稳定响应字段", async () => {
    const app = fixture(), server = await serverFor(app);
    expect((await server.inject({ method: "PUT", url: "/api/flows/wrong", payload: { yaml: raw } })).statusCode).toBe(400);
    expect((await server.inject({ method: "PUT", url: "/api/flows/demo", payload: { yaml: raw } })).statusCode).toBe(200);
    const listed = (await server.inject("/api/flows")).json();
    expect(listed.flows[0]).toMatchObject({ id: "demo", raw, problem: null, definition: { name: "示例流程" } });
    const item = upsertItem(app, undefined, { title: "核对退款", spaceId: "personal" }, "user");
    const url = `/api/items/${item.id}/flow`;
    expect((await server.inject(url)).json()).toMatchObject({ flow: null, stages: [], log: [], suits: [{ id: "demo" }] });
    expect((await server.inject({ method: "POST", url, payload: { flow: "demo" } })).json()).toMatchObject({ flow: { id: "demo", endedAt: null }, stages: [{ id: "check", instruction: "核验材料后再交付。", state: "gated", attempt: 0, carrier: { kind: "wait", label: "只等进展" }, askId: expect.any(String) }] });
    expect((await server.inject({ method: "POST", url, payload: { flow: "demo" } })).statusCode).toBe(409);
    const act = (action: string, note?: string) => server.inject({ method: "POST", url: `${url}/stages/check/${action}`, payload: note ? { note } : {} });
    expect((await act("hold")).json().stages[0].state).toBe("gated");
    expect((await act("confirm")).json().stages[0].state).toBe("doing");
    expect((await act("done")).statusCode).toBe(400);
    expect((await act("done", "核验通过")).json().flow.endedAt).toBeTruthy();
    expect((await act("reopen", "重新核验")).json().stages[0].state).toBe("gated");
    expect((await act("skip")).statusCode).toBe(400);
    expect((await act("skip", "这次已有核验报告")).json().stages[0].state).toBe("skipped");
    await act("reopen", "再次核验");
    expect((await server.inject({ method: "DELETE", url })).json().flow.endedAt).toBeTruthy();
    expect((await server.inject({ method: "DELETE", url: "/api/flows/demo" })).statusCode).toBe(200);
    expect((await server.inject("/api/flows")).json().flows).toEqual([]);
  });
  it("定义修改限 omem 主人；读流程按空间，改流程还要是事项本人", async () => {
    const app = fixture(), server = await serverFor(app);
    createUser(app, { id: "member-a", name: "成员甲" });
    const token = createApiToken(app, "member-a", "test"), headers = { authorization: `Bearer ${token}` };
    saveFlow(app, raw, "user");
    const privateItem = upsertItem(app, undefined, { title: "个人事项", spaceId: "personal" }, "user");
    await startFlow(app, privateItem.id, "demo", { actor: "owner" });
    const hidden = await server.inject({ url: `/api/items/${privateItem.id}/flow`, headers });
    const missing = await server.inject({ url: "/api/items/missing-item/flow", headers });
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.json()).toEqual(missing.json());
    expect(() => addMember(app, "personal", "member-a", "editor")).toThrow(/个人空间/);
    expect((await server.inject({ url: `/api/items/${privateItem.id}/flow`, headers })).statusCode).toBe(404);
    expect((await server.inject({ method: "POST", url: `/api/items/${privateItem.id}/flow/stages/check/confirm`, payload: {}, headers })).statusCode).toBe(403);
    expect((await server.inject({ method: "DELETE", url: `/api/items/${privateItem.id}/flow`, headers })).statusCode).toBe(403);
    expect((await server.inject({ method: "PUT", url: "/api/flows/demo", payload: { yaml: raw }, headers })).statusCode).toBe(403);
    expect((await server.inject({ method: "DELETE", url: "/api/flows/demo", headers })).statusCode).toBe(403);
    const mine = upsertItem(app, undefined, { title: "成员自己的事项", spaceId: "personal-member-a", userId: "member-a" }, "user");
    const url = `/api/items/${mine.id}/flow`;
    expect((await server.inject({ method: "POST", url, payload: { flow: "demo" }, headers })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: `${url}/stages/check/confirm`, payload: {}, headers })).statusCode).toBe(200);
  });
});

describe("流程随事项拉取", () => {
  it("三个表一起合并，整数日志重编号不丢记录，依据映射到本机原件，后续状态按更新时间覆盖", async () => {
    const local = fixture(), remote = fixture();
    const a = appendToSource(local, { spaceId: "personal", kind: "chat", uri: "chat:flow", title: "示例讨论", lines: ["共同消息", "本机消息"] });
    const b = appendToSource(remote, { spaceId: "personal", kind: "chat", uri: "chat:flow", title: "示例讨论", lines: ["共同消息", "远端消息"] });
    const own = upsertItem(local, undefined, { title: "本机事项", spaceId: "personal" }, "user");
    const item = upsertItem(remote, undefined, { title: "远端事项", spaceId: "personal" }, "user");
    for (const app of [local, remote]) saveFlow(app, raw.replace("stages:", "repeat: { from: check }\nstages:"), "user");
    await startFlow(local, own.id, "demo", { actor: "owner" });
    await startFlow(remote, item.id, "demo", { actor: "owner" });
    run(remote.db, "insert into flow_gate_grants(flow_id,stage_id,user_id,granted_at,updated_at) values('demo','check','owner','2026-01-01','2026-01-01')");
    await ownerAction(remote, item.id, "check", "confirm");
    await reportStage(remote, item.id, "check", { state: "done", note: "远端已核验", evidence: [`src:${b.id}#L2`] }, { actor: "assistant" });
    const snapshot = async (): Promise<Fetched> => {
      const dir = join(local.home, `snapshot-${Date.now()}`); mkdirSync(dir);
      await pipeline(await snapshotStream(remote), createWriteStream(join(dir, "snapshot.tar")));
      execFileSync("tar", ["-xf", "snapshot.tar"], { cwd: dir });
      rmSync(join(dir, "snapshot.tar"));
      return { dbDir: dir, libraryDir: join(dir, "library"), filesDir: join(dir, "files"), fetchedFiles: readdirSync(join(dir, "files")) };
    };
    let f = await snapshot();
    try { mergeLibrary(local, f); } finally { cleanupFetched(f); }
    expect(itemFlow(local, item.id)!.roundClosedAt).toBeTruthy();
    expect(one(local.db, "select granted_at,revoked_at from flow_gate_grants where flow_id='demo'")).toEqual({ granted_at: "2026-01-01", revoked_at: null });
    expect(getStage(local, item.id, "check")).toMatchObject({ state: "done", evidence: [`src:${a.id}#L3`] });
    expect(stageLog(local, item.id).some((l) => l.refs.includes(`src:${a.id}#L3`))).toBe(true);
    const { flowView } = await import("../src/flows/engine.ts");
    expect(flowView(local, item.id).rounds[0].stages[0]).toMatchObject({ state: "done", evidence: [`src:${a.id}#L3`] });
    const n = all(local.db, "select * from item_stage_log").length;
    f = await snapshot(); try { mergeLibrary(local, f); } finally { cleanupFetched(f); }
    expect(all(local.db, "select * from item_stage_log")).toHaveLength(n);
    run(remote.db, "update flow_gate_grants set revoked_at='2026-01-02',updated_at='2026-01-02' where flow_id='demo'");
    await startRound(remote, item.id, { actor: "owner", userId: "owner" });
    f = await snapshot(); try { mergeLibrary(local, f); } finally { cleanupFetched(f); }
    expect(itemFlow(local, item.id)!.endedAt).toBeNull();
    expect(itemFlow(local, item.id)!.round).toBe(2);
    expect(one(local.db, "select revoked_at from flow_gate_grants where flow_id='demo'")).toEqual({ revoked_at: "2026-01-02" });
    expect(getStage(local, item.id, "check").state).toBe("gated");
    expect(one(local.db, "select id from items where id=?", own.id)).toBeTruthy();
    await advance(remote, item.id);
  }, 60000);
});

describe("阶段运行接入", () => {
  it("worker 调用指定档案、只给这一轮技能，假 Agent 通过工具交结果后推进", async () => {
    const app = fixture();
    app.config.agents.profiles.push(agentProfileSchema.parse({ id: "flow-ai", command: "node", transport: "acp", model: "test-model" }));
    app.config.agents.tiers.cheap = { profile: "flow-ai", model: "test-model", effort: "low" };
    saveAgentSpec(app, { name: "demo-worker", description: "核对示例材料", prompt: "读材料后交结果" }, "user");
    saveSkill(app, { name: "demo-skill", description: "核对退款", body: "逐行核验已发货金额。" }, "user");
    saveFlow(app, "id: runtime\nname: 运行接入\nstages:\n  - id: check\n    name: 核验\n    ai: cheap\n    note: 读材料后核验。\n    by: {run: {agent: demo-worker, skill: demo-skill}}\n  - id: finish\n    name: 收尾\n    by: wait\n", "user");
    const item = upsertItem(app, undefined, { title: "示例退款", spaceId: "personal" }, "user");
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (a, input) => {
      const r = getRun(a, input.runId!);
      expect(input.spec?.name).toBe("demo-worker");
      expect(input.execution).toMatchObject({ profile: "flow-ai", model: "test-model", effort: "low", source: "flow", reason: "流程「运行接入」的「核验」阶段指定" });
      expect(input.task).toContain("逐行核验已发货金额");
      expect(input.addTools).toContain("stage_report");
      expect(input.spaces).toEqual(["personal"]);
      const { callTool } = await import("../src/agents/tools.ts");
      const result = await callTool({ app: a, runId: r.id, spaceId: "personal", spaces: ["personal"], writable: ["personal"], tools: new Set(["stage_report"]), userId: "owner", actor: "agent", spec: "demo-worker" }, "stage_report", { item: item.id, stage: "check", state: "done", note: "已按技能核验", evidence: [r.id] });
      expect(result.isError).toBe(false);
      return { text: "已核验", profileId: "fake", ai: { profile: "fake" } } as Awaited<ReturnType<typeof runner.runRole>>;
    });
    try {
      startWorker(app);
      await startFlow(app, item.id, "runtime", { actor: "owner" });
      await vi.waitFor(() => expect(getStage(app, item.id, "check").state).toBe("done"), { timeout: 5000 });
      expect(fake).toHaveBeenCalledTimes(1);
      expect(getStage(app, item.id, "finish").state).toBe("doing");
      expect(stageLog(app, item.id).some((l) => l.actor === "demo-worker" && !!l.runId)).toBe(true);
    } finally { fake.mockRestore(); stopWorker(); }
  });
});
