import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { all, one } from "../src/core/db.ts";
import { cleanupFetched, mergeLibrary, snapshotStream, type Fetched } from "../src/core/pull.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { appendToSource } from "../src/sources/store.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { advance, ownerAction, reportStage, startFlow } from "../src/flows/engine.ts";
import { getStage, itemFlow, stageLog } from "../src/flows/store.ts";
import { getRun, startWorker, stopWorker } from "../src/agents/runs.ts";
import { saveAgentSpec, saveSkill } from "../src/agents/specs.ts";
import * as runner from "../src/agents/runner.ts";

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
    expect((await server.inject({ url: `/api/items/${privateItem.id}/flow`, headers })).statusCode).toBe(404);
    addMember(app, "personal", "member-a", "editor");
    expect((await server.inject({ url: `/api/items/${privateItem.id}/flow`, headers })).statusCode).toBe(200);
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
    for (const app of [local, remote]) saveFlow(app, raw, "user");
    await startFlow(local, own.id, "demo", { actor: "owner" });
    await startFlow(remote, item.id, "demo", { actor: "owner" });
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
    expect(itemFlow(local, item.id)!.endedAt).toBeTruthy();
    expect(getStage(local, item.id, "check")).toMatchObject({ state: "done", evidence: [`src:${a.id}#L3`] });
    expect(stageLog(local, item.id).some((l) => l.refs.includes(`src:${a.id}#L3`))).toBe(true);
    const n = all(local.db, "select * from item_stage_log").length;
    f = await snapshot(); try { mergeLibrary(local, f); } finally { cleanupFetched(f); }
    expect(all(local.db, "select * from item_stage_log")).toHaveLength(n);
    await ownerAction(remote, item.id, "check", "reopen", "重新核验");
    f = await snapshot(); try { mergeLibrary(local, f); } finally { cleanupFetched(f); }
    expect(itemFlow(local, item.id)!.endedAt).toBeNull();
    expect(getStage(local, item.id, "check").state).toBe("gated");
    expect(one(local.db, "select id from items where id=?", own.id)).toBeTruthy();
    await advance(remote, item.id);
  }, 60000);
});

describe("阶段运行接入", () => {
  it("worker 调用指定档案、只给这一轮技能，假 Agent 通过工具交结果后推进", async () => {
    const app = fixture();
    saveAgentSpec(app, { name: "demo-worker", description: "核对示例材料", prompt: "读材料后交结果" }, "user");
    saveSkill(app, { name: "demo-skill", description: "核对退款", body: "逐行核验已发货金额。" }, "user");
    saveFlow(app, "id: runtime\nname: 运行接入\nstages:\n  - id: check\n    name: 核验\n    note: 读材料后核验。\n    by: {run: {agent: demo-worker, skill: demo-skill}}\n  - id: finish\n    name: 收尾\n    by: wait\n", "user");
    const item = upsertItem(app, undefined, { title: "示例退款", spaceId: "personal" }, "user");
    const fake = vi.spyOn(runner, "runRole").mockImplementation(async (a, input) => {
      const r = getRun(a, input.runId!);
      expect(input.spec?.name).toBe("demo-worker");
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
