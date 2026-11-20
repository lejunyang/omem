import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp } from "./helpers.ts";
import { run } from "../src/core/db.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { upsertItem } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { ownerAction, reportStage, startFlow, stopFlow } from "../src/flows/engine.ts";
import { flowBoard, itemFlowSummaries } from "../src/flows/http.ts";
import { startServer } from "../src/server/http.ts";

const apps: ReturnType<typeof testApp>[] = [], servers: FastifyInstance[] = [];
function setup(stages: object[]) {
  const app = testApp(); apps.push(app); app.config.flows.autoAdvance = 20;
  saveFlow(app, JSON.stringify({ id: "demo", name: "示例交付", stages }), "owner");
  const next = async (spaceId = "personal", userId = "owner") => {
    const item = upsertItem(app, undefined, { title: "示例商城", spaceId, userId, dueAt: "2026-12-01" }, "user");
    await startFlow(app, item.id, "demo", { actor: "owner", userId }); return item.id;
  };
  return { app, next };
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

it("看板与事项摘要共用阶段选择：等本人或卡住优先，之后进行中，再未到；带日期和停留超时", async () => {
  const { app, next } = setup([
    { id: "a", name: "待时间", by: "wait", at: "23:59" },
    { id: "b", name: "进行中", by: "wait", needs: [] },
    { id: "c", name: "关卡", by: "wait", needs: [], gate: "confirm" },
  ]);
  const id = await next();
  const check = (stage: string) => {
    expect(flowBoard(app, "owner")[0].stage.id).toBe(stage);
    expect(itemFlowSummaries(app, [id]).get(id)!.stage).toBe(stage);
  };
  // Pin the time-waiting stage independently of the wall-clock time at which this test runs.
  run(app.db, "update item_stages set state='pending',control=? where item_id=? and stage_id='a'", JSON.stringify({ waitUntil: "2099-01-01T00:00:00.000Z" }), id);
  check("c"); expect(flowBoard(app, "owner", "mine")).toHaveLength(1);
  await ownerAction(app, id, "c", "skip", "无需核验"); check("b");
  await reportStage(app, id, "b", { state: "blocked", note: "等外部服务", waitingOn: "服务恢复" }, { actor: "assistant" }); check("b");
  run(app.db, "update item_stages set since=? where item_id=? and stage_id='b'", new Date(Date.now() - 3 * 86400000).toISOString(), id);
  expect(flowBoard(app, "owner", "blocked")[0]).toMatchObject({ itemId: id, title: "示例商城", spaceId: "personal", flowId: "demo", flowName: "示例交付", round: 1, stage: { id: "b", name: "进行中", state: "blocked" }, waiting: "blocked", stale: true, dueAt: "2026-12-01" });
  expect(flowBoard(app, "owner", "mine")).toEqual([]);
  await ownerAction(app, id, "b", "done", "外部服务恢复"); check("a");
  await stopFlow(app, id); expect(flowBoard(app, "owner")).toEqual([]);
});

it("HTTP 两个筛选按读权限与事项本人，完成和停止的流程均不出现", async () => {
  const { app, next } = setup([{ id: "check", name: "核验", by: "owner" }]);
  createUser(app, { id: "reader", name: "成员甲" });
  createSpace(app, { id: "shared", name: "示例项目" }); addMember(app, "shared", "reader", "editor");
  const privateId = await next(), sharedId = await next("shared"), mine = await next("shared", "reader");
  const ended = await next("shared"); await ownerAction(app, ended, "check", "done", "已核验");
  const stopped = await next("shared"); await stopFlow(app, stopped);
  const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
  const headers = { authorization: `Bearer ${createApiToken(app, "reader", "test")}` };
  const get = async (only = "") => (await server.inject({ url: `/api/flows/board${only ? `?only=${only}` : ""}`, headers })).json();
  expect((await get()).map((r: { itemId: string }) => r.itemId).sort()).toEqual([mine]);
  expect((await get("mine")).map((r: { itemId: string }) => r.itemId)).toEqual([mine]);
  expect(await get("blocked")).toEqual([]);
  await reportStage(app, mine, "check", { state: "blocked", note: "等本人", waitingOn: "owner" }, { actor: "assistant" });
  expect((await get("blocked"))[0]).toMatchObject({ itemId: mine, waiting: "owner", stage: { state: "blocked" } });
  expect((await get("mine"))[0].itemId).toBe(mine);
  expect((await server.inject({ url: "/api/flows/board?only=bad", headers })).statusCode).toBe(400);
  expect((await get()).some((r: { itemId: string }) => [privateId, sharedId, ended, stopped].includes(r.itemId))).toBe(false);
});

it("几十件流程一次列全，事项摘要支持有界的 id 集合，空集合不返回别的事项", async () => {
  const { app, next } = setup([{ id: "check", name: "核验", by: "wait" }]);
  const ids: string[] = [];
  for (let i = 0; i < 48; i++) ids.push(await next());
  expect(flowBoard(app, "owner")).toHaveLength(48);
  expect([...itemFlowSummaries(app, ids.slice(0, 30)).keys()].sort()).toEqual(ids.slice(0, 30).sort());
  expect(itemFlowSummaries(app, []).size).toBe(0);
});
