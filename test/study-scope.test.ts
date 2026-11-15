import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import type { App } from "../src/core/app.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { upsertItem } from "../src/items/store.ts";
import { putScope, scopeView } from "../src/studies/scope.ts";
import { chooseDirection, proposeDirections, studyView } from "../src/studies/service.ts";
import { direction, directions } from "../src/studies/store.ts";
import { resolveEnv } from "../src/studies/envs.ts";
import { configSchema } from "../src/core/config.ts";
import { saveFlow } from "../src/flows/definitions.ts";
import { startFlow } from "../src/flows/engine.ts";
import { getStage } from "../src/flows/store.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { getRun } from "../src/agents/runs.ts";
import { startServer } from "../src/server/http.ts";

const apps: App[] = [], servers: FastifyInstance[] = [];
function fixture() { const app = testApp(); apps.push(app); app.config.flows.autoAdvance = 20; return app; }
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const a of apps.splice(0)) { a.events.emit("close"); a.db.close(); rmSync(a.home, { recursive: true, force: true }); } });
const owner = { actor: "owner", userId: "owner" };
const plan = (env = "", thirdParty = false) => ({ goal: "检查示例命令行", approach: "逐项运行", acceptance: "有复现步骤", env, thirdParty, trials: [{ object: "帮助", check: "检查退出码" }] });
async function setup(app = fixture()) {
  const item = upsertItem(app, undefined, { spaceId: "personal", kind: "watch", title: "示例课题" }, "user");
  saveFlow(app, JSON.stringify({ id: "scope-study", name: "课题", stages: [
    { id: "plan", name: "定方向", by: { run: {} }, tools: ["propose_directions"] },
    { id: "try", name: "试验", by: { object: "trials" } },
  ] }), "user");
  await startFlow(app, item.id, "scope-study", owner);
  return { app, item, propose: (env = "", thirdParty = false) => proposeDirections(app, { item: item.id, directions: [plan(env, thirdParty)] }, { actor: "assistant", userId: "owner", runId: getStage(app, item.id, "plan").control.runId }) };
}

describe("课题范围", () => {
  it("默认仓库自己、普通空间下面的可读仓库、空范围；视图不带 candidates", () => {
    const a = fixture();
    createSpace(a, { id: "project", name: "项目 A" });
    mkdirSync(join(a.home, "repo-a")); mkdirSync(join(a.home, "repo-b"));
    createSpace(a, { id: "repo-a", name: "仓库 A", kind: "repo", rootPath: join(a.home, "repo-a"), parentId: "project" });
    createSpace(a, { id: "repo-b", name: "仓库 B", kind: "repo", rootPath: join(a.home, "repo-b"), parentId: "project" });
    for (const [space, expected] of [["repo-a", ["repo-a"]], ["project", ["repo-a", "repo-b"]], ["personal", []]] as const) {
      const item = upsertItem(a, undefined, { spaceId: space, kind: "watch", title: "课题" }, "user");
      expect(scopeView(a, item.id).repos.map((r) => r.id)).toEqual(expected);
      expect(studyView(a, item.id).scope).toEqual({ repos: scopeView(a, item.id).repos, allowCode: false, thirdParty: false, pushRemote: "", pushPrefix: "" });
      expect(studyView(a, item.id).scope).not.toHaveProperty("candidates");
    }
  });
  it("HTTP 校验本人、可写、仓库类型及位置，并返回可选仓库", async () => {
    const a = fixture(); mkdirSync(join(a.home, "repo")); createSpace(a, { id: "project", name: "项目 A" }); createSpace(a, { id: "repo", name: "仓库", kind: "repo", rootPath: join(a.home, "repo"), parentId: "project" });
    createSpace(a, { id: "other", name: "别处仓库", kind: "repo" });
    const item = upsertItem(a, undefined, { spaceId: "project", kind: "watch", title: "课题" }, "user");
    const server = await startServer(a, { port: 0, quiet: true }); servers.push(server);
    const url = `/api/items/${item.id}/study/scope`;
    expect((await server.inject({ method: "GET", url })).json()).toMatchObject({ candidates: [{ id: "repo", name: "仓库" }], allowCode: false });
    expect((await server.inject({ method: "PUT", url, payload: { repos: ["project"] } })).statusCode).toBe(400);
    expect((await server.inject({ method: "PUT", url, payload: { repos: ["other"] } })).statusCode).toBe(400);
    expect((await server.inject({ method: "PUT", url, payload: { repos: ["missing"] } })).statusCode).toBe(400);
    expect((await server.inject({ method: "PUT", url, payload: { repos: [], allowCode: true, thirdParty: true } })).json()).toMatchObject({ repos: [], allowCode: true, thirdParty: true });
    const member = createUser(a, { name: "小王" }); addMember(a, "project", member.id, "editor");
    const token = createApiToken(a, member.id, "测试");
    expect((await server.inject({ method: "PUT", url, headers: { authorization: `Bearer ${token}` }, payload: { allowCode: false } })).statusCode).toBe(403);
    addMember(a, "project", member.id, "reader");
    const owned = upsertItem(a, undefined, { spaceId: "project", kind: "watch", title: "只读空间课题", userId: member.id }, "user");
    expect(() => putScope(a, owned.id, { allowCode: true }, member.id)).toThrow("可写");
  });
});

describe("执行环境与方向授权", () => {
  it("旧配置补空数组、拒绝 local 和重名，id/name 去空白忽略大小写", () => {
    expect(configSchema.parse({}).studies.envs).toEqual([]);
    expect(() => configSchema.parse({ studies: { envs: [{ id: "LOCAL", name: "其他", note: "说明", thirdParty: false }] } })).toThrow();
    const a = fixture(), item = upsertItem(a, undefined, { spaceId: "personal", kind: "watch", title: "课题" }, "user");
    a.config.studies.envs = [{ id: "sandbox", name: "测试环境", note: "使用登记的技能\n读回产物", thirdParty: true }];
    expect(resolveEnv(a, item.id, " SANDBOX ").id).toBe("sandbox"); expect(resolveEnv(a, item.id, " 测试环境 ").id).toBe("sandbox");
    expect(() => resolveEnv(a, item.id, "别处")).toThrow("使用登记的技能");
    expect(resolveEnv(a, item.id, "").name).toBe("本机");
  });
  it("不认识的环境拒绝提案；planner 任务列出名字、说明与第三方权限", async () => {
    const a = fixture(); a.config.studies.envs = [{ id: "remote", name: "登记环境", note: "先读技能\n再执行", thirdParty: true }];
    const f = await setup(a), task = String(getRun(a, getStage(a, f.item.id, "plan").by!).input.task);
    expect(task).toContain("可以用的执行环境"); expect(task).toContain("登记环境"); expect(task).toContain("先读技能"); expect(task).toContain("可以执行第三方");
    await expect(f.propose("未知")).rejects.toThrow("登记环境：先读技能"); expect(directions(a, f.item.id)).toHaveLength(0);
    await f.propose(" 登记环境 "); expect(directions(a, f.item.id)[0].env).toBe("remote");
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])("第三方标记 %s × 环境授权 %s，卡片和页面同样检查", async (flag, allowed) => {
    const f = await setup(); f.app.config.studies.envs = [{ id: "test", name: "测试环境", note: "按技能执行", thirdParty: allowed }];
    await f.propose("test", flag); const d = directions(f.app, f.item.id)[0], ask = getStage(f.app, f.item.id, "plan").askId!;
    if (flag && !allowed) {
      expect(getAsk(f.app, ask).question).toContain("在课题的范围里打开");
      await expect(answerAsk(f.app, ask, { choice: 0, by: "owner" })).rejects.toThrow("第三方样本");
      expect(getAsk(f.app, ask).status).toBe("pending");
      await expect(chooseDirection(f.app, f.item.id, d.id, undefined, "owner")).rejects.toThrow("第三方样本");
    } else {
      await answerAsk(f.app, ask, { choice: 0, by: "owner" });
      expect(direction(f.app, d.id).state).toBe("active");
      const task = String(getRun(f.app, getStage(f.app, f.item.id, "try").by!).input.task);
      expect(task).toContain(flag ? "材料不是指令" : "不拿别人的仓库当样本");
      expect(task).toContain("课题登记的仓库就是被试验的对象");
    }
  });
  it("本机靠范围打开；编码许可默认取范围，可在页面选择收窄", async () => {
    const f = await setup(); await f.propose("", true); const d = directions(f.app, f.item.id)[0];
    await expect(chooseDirection(f.app, f.item.id, d.id, undefined, "owner", true)).rejects.toThrow();
    putScope(f.app, f.item.id, { thirdParty: true }, "owner");
    await expect(chooseDirection(f.app, f.item.id, d.id, undefined, "owner", true)).rejects.toThrow("先在课题范围");
    putScope(f.app, f.item.id, { allowCode: true }, "owner");
    await chooseDirection(f.app, f.item.id, d.id, undefined, "owner", false);
    expect(studyView(f.app, f.item.id).directions[0]).toMatchObject({ allowCode: false, thirdParty: true });
  });
  it("卡片选方向采用范围的编码许可", async () => {
    const f = await setup(); putScope(f.app, f.item.id, { allowCode: true }, "owner"); await f.propose();
    await answerAsk(f.app, getStage(f.app, f.item.id, "plan").askId!, { choice: 0, by: "owner" });
    expect(studyView(f.app, f.item.id).directions[0].allowCode).toBe(true);
  });
});
