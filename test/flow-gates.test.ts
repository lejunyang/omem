import { rmSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { testApp } from "./helpers.ts";
import { all, run } from "../src/core/db.ts";
import { createUser, createApiToken } from "../src/core/users.ts";
import { answerAsk, getAsk, listAsks } from "../src/agents/asks.ts";
import { upsertItem, itemEvents } from "../src/items/store.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { ownerAction, startFlow } from "../src/flows/engine.ts";
import { gateGrants } from "../src/flows/gates.ts";
import { getStage } from "../src/flows/store.ts";
import { startServer } from "../src/server/http.ts";
import { getRun } from "../src/agents/runs.ts";

const apps: ReturnType<typeof testApp>[] = [], servers: FastifyInstance[] = [];
const definition = (stages = [{ id: "check", name: "核验", by: "wait", gate: "confirm" }]) => JSON.stringify({ id: "demo", name: "示例交付", stages });
function setup(raw = definition(), after = 2) {
  const app = testApp(); apps.push(app); app.config.flows.gateLadder.after = after;
  saveFlow(app, raw, "owner");
  const next = async (userId = "owner") => {
    const item = upsertItem(app, undefined, { title: "示例商城", spaceId: userId === "owner" ? "personal" : `personal-${userId}`, userId }, "user");
    await startFlow(app, item.id, "demo", { actor: "owner", userId });
    return item.id;
  };
  return { app, next };
}
const offers = (app: ReturnType<typeof testApp>) => listAsks(app).filter((a) => a.handler === "flow-gate-promote" && a.status === "pending");
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  for (const app of apps.splice(0)) { app.events.emit("close"); app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

it("连续 N 次直接开始才问；拒绝升级后要重新积累 N 次；非本人和伪造被问者不能授权", async () => {
  const { app, next } = setup();
  await ownerAction(app, await next(), "check", "confirm"); expect(offers(app)).toHaveLength(0);
  await ownerAction(app, await next(), "check", "confirm");
  const q = offers(app)[0]; expect(q.question).toBe("「示例交付」的「核验」你连着同意了 2 次，以后轮到它就直接开始吗？");
  await expect(answerAsk(app, q.id, { choice: 0, by: "another" })).rejects.toThrow("本人");
  run(app.db, "update asks set user_id='another' where id=?", q.id);
  await expect(answerAsk(app, q.id, { choice: 0, by: "another" })).rejects.toThrow("本人");
  run(app.db, "update asks set user_id='owner' where id=?", q.id);
  await answerAsk(app, q.id, { choice: 1, by: "owner" });
  await ownerAction(app, await next(), "check", "confirm"); expect(offers(app)).toHaveLength(0);
  await ownerAction(app, await next(), "check", "confirm"); expect(offers(app)).toHaveLength(1);
});

it("先别做、跳过都清零；带修改意见的开始不计；fixed 和关闭阶梯都不参与", async () => {
  const { app, next } = setup();
  await ownerAction(app, await next(), "check", "confirm");
  const held = await next(); await ownerAction(app, held, "check", "hold");
  await ownerAction(app, held, "check", "confirm"); expect(offers(app)).toHaveLength(0);
  await ownerAction(app, await next(), "check", "skip", "不需要");
  await ownerAction(app, await next(), "check", "confirm"); expect(offers(app)).toHaveLength(0);
  await ownerAction(app, await next(), "check", "confirm", "改一下要求"); expect(offers(app)).toHaveLength(0);
  const fixed = setup(JSON.stringify({ id: "demo", name: "上线", stages: [{ id: "check", name: "上线", by: "wait", gate: "confirm", fixed: true }] }), 1);
  await ownerAction(fixed.app, await fixed.next(), "check", "confirm"); expect(offers(fixed.app)).toHaveLength(0);
  app.config.flows.gateLadder.enabled = false;
  await ownerAction(app, await next(), "check", "confirm"); expect(offers(app)).toHaveLength(0);
});

it("同一关卡的次数按用户分开；跳过还在等原因时也已经清零", async () => {
  const { app, next } = setup();
  createUser(app, { id: "member-a", name: "成员甲" });
  await ownerAction(app, await next(), "check", "confirm");
  await ownerAction(app, await next("member-a"), "check", "confirm", "", "member-a");
  expect(offers(app)).toHaveLength(0);
  const skipped = await next();
  await answerAsk(app, getStage(app, skipped, "check").askId!, { choice: 2, by: "owner" });
  expect(getStage(app, skipped, "check").control.question).toBe("skip");
  await ownerAction(app, await next(), "check", "confirm"); expect(offers(app)).toHaveLength(0);
});

it("暂停授权自动开始的运行会取消旧运行，重新开始建立新运行", async () => {
  const { app, next } = setup(JSON.stringify({ id: "demo", name: "示例核验", stages: [{ id: "check", name: "核验", by: { run: {} }, gate: "confirm" }] }), 1);
  await ownerAction(app, await next(), "check", "confirm");
  await answerAsk(app, offers(app)[0].id, { choice: 0, by: "owner" });
  const id = await next(), runId = getStage(app, id, "check").control.runId!;
  await ownerAction(app, id, "check", "hold");
  expect(getRun(app, runId).status).toBe("cancelled");
  expect(getStage(app, id, "check").state).toBe("gated");
  await ownerAction(app, id, "check", "confirm");
  expect(getStage(app, id, "check").control.runId).not.toBe(runId);
});

it("授权后自动开始仍受连续上限限制；上限引起的确认不计入连续同意", async () => {
  const { app, next } = setup(JSON.stringify({ id: "demo", name: "示例交付", stages: [
    { id: "check", name: "核验", by: "wait", gate: "confirm" }, { id: "after", name: "后续", by: "wait", gate: "confirm" },
  ] }), 1);
  const first = await next();
  await answerAsk(app, getStage(app, first, "check").askId!, { choice: 0, by: "owner" });
  await answerAsk(app, offers(app)[0].id, { choice: 0, by: "owner" });
  app.config.flows.autoAdvance = 1;
  const second = await next(); expect(getStage(app, second, "check").state).toBe("doing");
  // Agent completion preserves the automatic streak; an owner action deliberately resets it.
  const { reportStage } = await import("../src/flows/engine.ts");
  const { createRun } = await import("../src/agents/runs.ts");
  const evidence = createRun(app, { kind: "agent", title: "依据", spaceId: "personal" }).id;
  await reportStage(app, second, "check", { state: "done", note: "核验完成", evidence: [evidence] }, { actor: "assistant" });
  expect(getStage(app, second, "after")).toMatchObject({ state: "gated", control: { gateLimit: true } });
  await ownerAction(app, second, "after", "confirm"); expect(offers(app)).toHaveLength(0);
});

it.each(["reopen", "hold"] as const)("授权自动开始后本人 %s 撤销授权、记时间线，下次重新问", async (action) => {
  const { app, next } = setup(undefined, 1);
  await ownerAction(app, await next(), "check", "confirm");
  await answerAsk(app, offers(app)[0].id, { choice: 0, by: "owner" });
  const id = await next(); expect(getStage(app, id, "check").control.grantedGate).toBe(true);
  await ownerAction(app, id, "check", action, "需要调整");
  expect(gateGrants(app, "demo", "owner")).toEqual([]);
  expect(itemEvents(app, id).some((e) => e.text.includes("撤销"))).toBe(true);
  expect(getStage(app, id, "check").state).toBe("gated");
  await ownerAction(app, id, "check", "confirm"); expect(offers(app)).toHaveLength(1);
});

it("列表只带当前用户的授权，HTTP 只撤自己的；删除或改名阶段使授权失效", async () => {
  const { app, next } = setup(undefined, 1);
  await ownerAction(app, await next(), "check", "confirm"); await answerAsk(app, offers(app)[0].id, { choice: 0, by: "owner" });
  const server = await startServer(app, { port: 0, quiet: true }); servers.push(server);
  expect((await server.inject("/api/flows")).json().flows[0].grants).toEqual([{ stage: "check", grantedAt: expect.any(String) }]);
  createUser(app, { id: "member-a", name: "成员甲" });
  const headers = { authorization: `Bearer ${createApiToken(app, "member-a", "test")}` };
  expect((await server.inject({ url: "/api/flows", headers })).json().flows[0].grants).toEqual([]);
  expect((await server.inject({ method: "DELETE", url: "/api/flows/demo/gates/check", headers })).statusCode).toBe(200);
  expect(gateGrants(app, "demo", "owner")).toHaveLength(1);
  await server.inject({ method: "DELETE", url: "/api/flows/demo/gates/check" }); expect(gateGrants(app, "demo", "owner")).toHaveLength(0);
  const id = await next(); expect(getStage(app, id, "check").state).toBe("gated");
  await ownerAction(app, id, "check", "confirm"); await answerAsk(app, offers(app)[0].id, { choice: 0, by: "owner" });
  saveFlow(app, definition([{ id: "renamed", name: "重新核验", by: "wait", gate: "confirm" }]), "owner");
  expect(gateGrants(app, "demo", "owner")).toEqual([]);
  expect(all(app.db, "select revoked_at from flow_gate_grants")).toEqual([{ revoked_at: expect.any(String) }]);
});
