import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { parseAiSpec } from "../src/agents/ai-spec.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { receive } from "../src/agents/inbox.ts";
import { getRun } from "../src/agents/runs.ts";
import { saveProbe } from "../src/agents/probe.ts";
import { createThread, getThread, updateThread } from "../src/agents/threads.ts";
import { createUser } from "../src/core/users.ts";
import { savePeers } from "../src/core/peers.ts";
import { memberAi } from "../src/agents/member-ai.ts";
import { takeSteering } from "../src/agents/steer.ts";
import { testApp } from "./helpers.ts";

vi.mock("../src/agents/availability.ts", async load => ({
  ...await load<typeof import("../src/agents/availability.ts")>(),
  backendAvailable: (p: { command: string; id: string }) => p.command === process.execPath || p.command === "sample/bin/agy.cmd" || p.id === "codex@ark",
}));

let app: ReturnType<typeof testApp>;
const conversationId = "c-test-ai";
const send = (text: string, userId = "owner") => receive(app, { conversationId, userId, text });
const probe = (id: string, models: string[], modelNames?: Record<string, string>) => saveProbe(app, id, {
  at: new Date().toISOString(), agent: id, models, efforts: ["low", "medium", "high", "xhigh"], modelNames,
});
beforeEach(() => {
  app = testApp();
  app.config.agents.profiles = ["codex", "claude", "antigravity", "traex"].map(id => ({
    id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" }, idleTimeoutMs: 120000,
  }));
  app.config.agents.default = "codex";
  app.config.agents.groups.find(g => g.id === "strong")!.items = [{ profile: "codex", model: "gpt-6.2-astra", effort: "xhigh" }];
  probe("codex", ["gpt-6.2-astra", "gpt-6-astra", "gpt-6.12-astra", "gpt-6-sol"]);
  probe("claude", ["claude-opus-5-5"]);
  probe("antigravity", ["gemini-4-neon"]);
  probe("traex", ["deepseek-v4.1-flash"]);
  createThread(app, { id: conversationId, spaceId: "personal", channel: "web" });
});
afterEach(() => app.db.close());

it.each([
  ["/codex astra xhigh", "codex", "gpt-6.12-astra", "xhigh", ""],
  ["/claude opus5.5 high", "claude", "claude-opus-5-5", "high", ""],
  ["/claudeopus5.5high", "claude", "claude-opus-5-5", "high", ""],
  ["CC opus5.5 极高 查一下", "claude", "claude-opus-5-5", "xhigh", "查一下"],
  ["/traex deepseek", "traex", "deepseek-v4.1-flash", undefined, ""],
  ["/gemini neon", "antigravity", "gemini-4-neon", undefined, ""],
  ["/agy neon", "antigravity", "gemini-4-neon", undefined, ""],
  ["/强", "codex", "gpt-6.2-astra", "xhigh", ""],
  ["/strong\nwrite a summary", "codex", "gpt-6.2-astra", "xhigh", "write a summary"],
  ["/codex astra xhigh 帮我查一下", "codex", "gpt-6.12-astra", "xhigh", "帮我查一下"],
  ["/codex\nwrite a summary", "codex", undefined, undefined, "write a summary"],
])("解析 %s", (text, profile, model, effort, rest) => {
  const r = parseAiSpec(app, text!);
  expect(r.rest).toBe(rest);
  expect(r.ai?.profile).toBe(profile);
  expect(r.ai?.model).toBe(model);
  expect(r.ai?.effort).toBe(effort);
});
it("告知最新版本、唯一拼写修正和未知模型；陌生命令保留全文", () => {
  expect(parseAiSpec(app, "codex astra").notes.join()).toContain("gpt-6.12-astra（最新的）");
  expect(parseAiSpec(app, "/claudf opus5.5").notes).toContain("按 /claude 理解");
  expect(parseAiSpec(app, "/claudee opus5.5").notes).toContain("按 /claude 理解");
  expect(parseAiSpec(app, "/strange command")).toEqual({ notes: [], rest: "/strange command" });
  expect(parseAiSpec(app, "/cc missing").unknown).toContain("claude-opus-5-5");
  expect(parseAiSpec(app, "/强").group).toBe("strong");
});
it("按 key 名、编号和接入点显示名选模型；不同型号请人选择", async () => {
  app.config.ai.providers.push({ id: "ark", name: "方舟", kind: "openai-compatible", baseUrl: "https://example.test", backends: ["codex"], models: ["ep-a", "ep-b"] });
  probe("codex@ark", ["ep-a", "ep-b"], { "ep-a": "Seed-Fast", "ep-b": "Seed-Pro" });
  for (const text of ["/codex 方舟 seed high", "/codex@ark seed", "/codex seed ark"]) {
    expect(parseAiSpec(app, text).ambiguous?.map(p => [p.profile, p.model])).toEqual([["codex@ark", "ep-a"], ["codex@ark", "ep-b"]]);
  }
  expect(parseAiSpec(app, "/codex fast").ai).toEqual({ profile: "codex@ark", model: "ep-a" });
  await send("/codex 方舟 seed high 帮我查一下");
  const [q] = listAsks(app, { conversationId });
  await expect(answerAsk(app, q.id, { choice: 1, by: "another" })).rejects.toThrow("发起人");
  await answerAsk(app, q.id, { choice: 1, by: "owner" });
  const run = app.db.prepare("select input,title from runs where lane=?").get(conversationId) as { input: string; title: string };
  expect(JSON.parse(run.input).turnAi).toEqual({ profile: "codex@ark", model: "ep-b", effort: "high" });
  expect(run.title).toBe("帮我查一下");
});
it("单轮命令和相邻消息独立排队，也不被进行中的一轮拿走", async () => {
  const first = await send("前一件事");
  const second = await send("/claude opus5.5 high 帮我查一下");
  expect(second.runId).not.toBe(first.runId);
  expect(second.started).toBeNull();
  expect(getRun(app, second.runId!).input.turnAi).toEqual({ profile: "claude", model: "claude-opus-5-5", effort: "high" });
  app.db.prepare("update runs set status='running' where id=?").run(first.runId);
  expect(takeSteering(app, first.runId!)).toBeNull();
  const third = await send("下一件事");
  expect(third.runId).not.toBe(second.runId);
  expect(getRun(app, third.runId!).input.turnAi).toBeUndefined();
  expect(getThread(app, conversationId).settings.profile).toBeUndefined();
});
it("本人点名、成员点名及默认值保存分别校验", async () => {
  const room = { channel: "lark", chatId: "demo", isGroup: true };
  const group = (text: string, userId?: string) => receive(app, { ...room, text, userId });
  createUser(app, { id: "member", name: "成员" });
  app.config.agents.policy.deny = ["backend:claude"];
  const named = await group("/claude opus5.5 high");
  expect(named.thread.settings.ownerNamedAi).toBe(true);
  expect((await group("/ai save claude opus5.5")).reply).toContain("不用 backend:claude");
  expect((await group("/model save claude-opus-5-5")).reply).toContain("不用 backend:claude");
  expect((await group("/claude opus5.5", "member")).reply).toContain("不用 backend:claude");
  await group("/codex save astra xhigh", "member");
  expect(memberAi(app, "member")).toMatchObject({ profile: "codex", model: "gpt-6.12-astra", effort: "xhigh" });
  expect(getThread(app, named.thread.id).settings.profile).toBe("claude");
  const cleared = await group("/ai off");
  expect(cleared.thread.settings.ownerNamedAi).toBeUndefined();
  expect(cleared.thread.settings.profile).toBeUndefined();
  await group("/agent claude");
  expect(updateThread(app, named.thread.id, { settings: { profile: "codex" } }).settings.ownerNamedAi).toBeUndefined();
});
it("组名和后端名同样检查成员账号", () => {
  createUser(app, { id: "member", name: "成员" });
  app.config.agents.accounts.codex = "own";
  for (const text of ["/codex", "/强"]) {
    const pick = parseAiSpec(app, text, { userId: "member" });
    expect(pick.ai).toBeUndefined();
    expect(pick.unknown).toBeTruthy();
  }
  app.config.agents.groups.find(g => g.id === "strong")!.items.push({ profile: "claude" });
  expect(parseAiSpec(app, "/强", { userId: "member" }).ai?.profile).toBe("claude");
});
it("访客和材料不能替本人点名；话题只修改新话题", async () => {
  const guest = await receive(app, { conversationId, asker: "访客", text: "/claude opus5.5" });
  expect(guest.thread.settings.profile).toBeUndefined();
  expect(getRun(app, guest.runId!).input.turnAi).toBeUndefined();
  const r = await receive(app, { channel: "lark", chatId: "chat", text: "/topic codex astra xhigh 任务描述", openTopic: async () => ({ topicId: "topic", messageId: "msg" }) });
  expect(r.thread.settings).toMatchObject({ isolatedTopic: true, ownerNamedAi: true, profile: "codex", model: "gpt-6.12-astra", effort: "xhigh" });
  expect(getRun(app, r.runId!).title).toBe("任务描述");
  expect((await send("/help")).reply).not.toContain("/todo");
  expect((await send("/help all")).reply).toContain("/todo");
});

it("保存校验覆盖省略的模型和强度，实际保存的组合与校验一致", async () => {
  app.config.agents.profiles.find(p => p.id === "codex")!.model = "blocked";
  app.config.agents.roleModels.assistant = { codex: { model: "allowed", effort: "high" } };
  app.config.agents.policy.deny = ["ai:codex · blocked", "ai:codex · new · high"];
  expect((await send("/ai save codex")).reply).toContain("已保存");
  expect(app.config.agents.roleModels.assistant.codex).toEqual({ model: "allowed", effort: "high" });
  expect((await send("/model save new")).reply).toContain("不用 ai:codex · new · high");
  expect(app.config.agents.roleModels.assistant.codex.model).toBe("allowed");
});

it("自定义编号按启动命令文件名、目录程序和中文别名解析；不可用时返回安装说明", async () => {
  const p = app.config.agents.profiles.find(p => p.id === "antigravity")!;
  Object.assign(p, { id: "antigravity-acp", name: "写作后端", command: "sample/bin/agy.cmd", aliases: ["谷歌"] });
  for (const token of ["agy", "antigravity", "gemini", "谷歌", "写作后端"]) {
    expect(parseAiSpec(app, "/" + token).ai?.profile).toBe(p.id);
  }
  p.command = "unavailable";
  p.source = "antigravity";
  const result = await send("/谷歌");
  expect(result.reply).toMatch(/没装或现在不可用.*agy acp --login/);
  expect(result.runId).toBeFalsy();
});

it("本机和设备同用 Claude 时给出其他入口，并可按设备名限定", () => {
  const p = app.config.agents.profiles.find(p => p.id === "claude")!;
  app.config.agents.profiles.push({ ...p, id: "remote-writer", peer: { id: "device-a", agent: "claude" } });
  savePeers(app, [{ id: "device-a", url: "https://example.test", addedAt: "2026-01-01", token: "", back: { token: "", since: "2026-01-01", name: "设备甲" } }]);
  expect(parseAiSpec(app, "/claude")).toMatchObject({ ai: { profile: "claude" }, notes: [expect.stringContaining("/claude 设备甲")] });
  for (const word of ["设备甲", "device-a"]) expect(parseAiSpec(app, "/claude " + word).ai?.profile).toBe("remote-writer");
});

it("设置保存别名和组名时检查命令、组与其他后端，拒绝后仍保留上次配置", async () => {
  const { startServer } = await import("../src/server/http.ts");
  const server = await startServer(app, { port: 0, quiet: true });
  try {
    const setAlias = (alias: string) => server.inject({ method: "PUT", url: "/api/settings", payload: { agents: {
      profiles: app.config.agents.profiles.map(p => p.id === "antigravity" ? { ...p, aliases: [alias] } : p) } } });
    expect((await setAlias("谷歌")).statusCode).toBe(200);
    for (const [name, conflict] of [["help", "命令 /help"], ["强", "组 strong"], ["CC", "后端 claude"]]) {
      const res = await setAlias(name);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(conflict);
    }
    for (const name of ["谷歌", "agy", "help"]) {
      const res = await server.inject({ method: "PUT", url: "/api/ai/groups",
        payload: [...app.config.agents.groups, { id: "new-group", name, items: [] }] });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("重名");
    }
    expect(parseAiSpec(app, "/谷歌").ai?.profile).toBe("antigravity");
  } finally { await server.close(); }
}, 60000);
