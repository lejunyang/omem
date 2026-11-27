import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import "../src/agents/jobs.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { viewText } from "../src/agents/ui-blocks.ts";
import { addRunEvent, createRun, startWorker, waitForRun } from "../src/agents/runs.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { agentProfileSchema, configPath, loadConfig, saveConfig } from "../src/core/config.ts";
import { one, run as sql } from "../src/core/db.ts";
import { createApiToken, createUser } from "../src/core/users.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const app = testApp();
const fake = (id: string, model?: string) => agentProfileSchema.parse({ id, model, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "aware" } });
app.config.agents.profiles = [fake("writer"), fake("first", "gemini-neon"), fake("second", "gemini-flash")];
app.config.agents.groups.find(g => g.id === "strong")!.items = [{ profile: "writer" }];
app.config.agents.groups.find(g => g.id === "cheap")!.items = [{ profile: "writer" }];
saveConfig(app.config, app.home);
const ctx: ToolContext = { app, userId: "owner", spaceId: "personal", spaces: null, runId: null, actor: "agent", tools: null, role: "assistant" };
const draft = { changes: [{ class: "routine", addDeny: ["model:gemini"], addUse: ["cheap"], order: "fixed", strict: true }], unmatched: ["按费用自动报销"] };
// The scripted ACP backend calls the writer's single MCP tool with the supplied structured draft.
const sentence = (words: string, proposed: unknown = draft) => words + "\n@call propose_ai_policy " + JSON.stringify({ draft: proposed });
const server = await startServer(app, { port: 0, quiet: true });
const post = (url: string, payload: Record<string, unknown>) => server.inject({ method: "POST", url, payload });
async function propose(text: string) {
  const res = await post("/api/ai/policy/propose", { text });
  expect(res.statusCode, res.body).toBe(200);
  return waitForRun(app, res.json().runId);
}
const askFor = async (text: string) => {
  const r = await propose(text);
  expect(r.status, r.error ?? "").toBe("done");
  return getAsk(app, String(r.output.askId));
};

beforeAll(() => {
  for (const [kind, profile] of [["ingest", "first"], ["archive", "second"], ["ask", "first"]] as const) {
    const r = createRun(app, { kind, title: "先前的选择" });
    sql(app.db, "update runs set status='done' where id=?", r.id);
    addRunEvent(app, r.id, "status", { choice: { picked: profile + " · gemini-neon" } });
  }
  startWorker(app);
});
afterAll(() => server.close());

it("设置接口通过强组和 MCP 起草，展开跨后端的排除并按类别统计，放弃不写配置", async () => {
  const before = readFileSync(configPath(app.home), "utf8");
  const ask = await askFor(sentence("日常整理只用省组，不用 Gemini，按费用自动报销"));
  const summary = viewText(ask.ui!.view!);
  expect(summary).toContain("first · gemini-neon");
  expect(summary).toContain("second · gemini-flash");
  expect(summary).toContain("近 7 天有 2 次");
  expect(summary).toContain("按费用自动报销");
  expect(readFileSync(configPath(app.home), "utf8")).toBe(before);
  await expect(answerAsk(app, ask.id, { by: "member", choice: 0 })).rejects.toThrow("只有本人");
  const refused = await post(`/api/asks/${ask.id}/answer`, { choice: 2 });
  expect(refused.statusCode, refused.body).toBe(200);
  expect(readFileSync(configPath(app.home), "utf8")).toBe(before);
}, 60000);

it("修改原话重新预览，仅确认新卡后写规则及原话，重复点击只写一次", async () => {
  const before = structuredClone(app.config.agents.policy);
  const ask = await askFor(sentence("日常整理不用 Gemini"));
  await answerAsk(app, ask.id, { by: "owner", choice: 1 });
  const edit = one<{ id: string }>(app.db, "select id from asks where json_extract(context,'$.handler')='ai-policy-revise' and status='pending'")!;
  const words = sentence("日常整理只用省组", { changes: [{ class: "routine", addUse: ["cheap"], strict: true }] });
  await answerAsk(app, edit.id, { by: "owner", value: { text: words } });
  const child = one<{ id: string }>(app.db, "select id from runs where parent_id=?", ask.runId)!;
  const updated = await waitForRun(app, child.id);
  expect(updated.status, updated.error ?? "").toBe("done");
  const id = String(updated.output.askId);
  expect(app.config.agents.policy).toEqual(before);
  const saved = await post(`/api/asks/${id}/answer`, { choice: 0 });
  expect(saved.statusCode, saved.body).toBe(200);
  expect((await post(`/api/asks/${id}/answer`, { choice: 0 })).statusCode).toBe(409);
  expect(loadConfig(app.home).agents.policy.classes.routine).toMatchObject({ use: ["cheap"], deny: [], strict: true, said: [{ text: words, at: expect.any(String) }] });
}, 90000);

it("确认旧卡时检测其他进程写入的配置，保留后来保存的规则", async () => {
  const ask = await askFor(sentence("日常整理再排除 Gemini"));
  const path = configPath(app.home);
  const disk = JSON.parse(readFileSync(path, "utf8"));
  disk.agents.policy.deny = ["backend:claude"];
  writeFileSync(path, JSON.stringify(disk));
  const stale = await post(`/api/asks/${ask.id}/answer`, { choice: 0 });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(loadConfig(app.home).agents.policy.deny).toEqual(["backend:claude"]);
}, 60000);

it("只有本人能经对话发起草稿，主助手不能直接递交模型改动", async () => {
  const member = createUser(app, { id: "member", name: "成员", role: "member" });
  const token = createApiToken(app, member.id, "测试");
  const denied = await server.inject({ method: "POST", url: "/api/ai/policy/propose", headers: { authorization: "Bearer " + token }, payload: { text: "改规则" } });
  expect(denied.statusCode).toBe(403);
  expect((await callTool({ ...ctx, userId: "member" }, "propose_ai_policy", { text: "日常整理不要用 Gemini" })).isError).toBe(true);
  expect((await callTool(ctx, "propose_ai_policy", { draft })).isError).toBe(true);
  const text = sentence("没有对应设置的要求", { changes: [], unmatched: ["没有对应设置的要求"] });
  const result = await callTool(ctx, "propose_ai_policy", { text });
  expect(result.isError, result.text).toBe(false);
  const row = one<{ id: string }>(app.db, "select id from runs where kind='ai-policy-draft' and json_extract(input,'$.text')=?", text)!;
  const done = await waitForRun(app, row.id);
  expect(done.status, done.error ?? "").toBe("done");
  expect(getAsk(app, String(done.output.askId)).options.map(o => o.label)).toEqual(["改一下", "不改"]);
}, 60000);

it("未知的组不会生成可保存的提案", async () => {
  const r = await propose(sentence("用一个没有配置的组", { changes: [{ class: "writing", addUse: ["unknown"] }] }));
  expect(r.status).toBe("failed");
  expect(r.output.askId).toBeUndefined();
}, 60000);

it("在原类别规则上增减选择，保留顺序、严格模式、其他类别和来源记录", async () => {
  const prior = { text: "写作使用标准组", at: "2026-11-20T00:00:00.000Z" };
  const original = { use: ["standard"], deny: ["backend:claude", "model:gemini"], order: "fixed", strict: true, said: [prior] };
  const { policy } = app.config.agents;
  const installed = await server.inject({ method: "PUT", url: "/api/ai/policy", payload: { ...policy, classes: { ...policy.classes, writing: original } } });
  expect(installed.statusCode, installed.body).toBe(200);
  const routine = structuredClone(app.config.agents.policy.classes.routine);
  const text = sentence("写作改用强组，可以用 Gemini", { changes: [{ class: "writing", removeUse: ["standard"], addUse: ["strong"], removeDeny: ["model:gemini"] }] });
  const ask = await askFor(text);
  expect(viewText(ask.ui!.view!)).toContain("取消排除：model:gemini");
  expect(app.config.agents.policy.classes.writing).toEqual(original);
  await answerAsk(app, ask.id, { by: "owner", choice: 0 });
  const saved = loadConfig(app.home).agents.policy;
  expect(saved.classes.writing).toEqual({ ...original, use: ["strong"], deny: ["backend:claude"], said: [prior, { text, at: expect.any(String) }] });
  expect(saved.classes.routine).toEqual(routine);
}, 60000);

it("保存总体偏好时提示把硬性要求转成规则", async () => {
  const submit = (guidance: string) => server.inject({ method: "PUT", url: "/api/settings",
    payload: { agents: { routing: { ...app.config.agents.routing, guidance } } } });
  const before = structuredClone(app.config.agents.policy);
  for (const text of ["禁止使用", "不要用", "别用", "只用", "必须用"]) {
    const res = await submit(text + "某个后端");
    expect(res.statusCode).toBe(200);
    expect(res.json().guidanceWarning).toContain("转成规则");
  }
  expect((await submit("优先考虑标准组")).json().guidanceWarning).toBeUndefined();
  expect(app.config.agents.policy).toEqual(before);
});
