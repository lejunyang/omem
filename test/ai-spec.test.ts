import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { parseAiSpec } from "../src/agents/ai-spec.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { receive } from "../src/agents/inbox.ts";
import { getRun, runEvents, startWorker, stopWorker, waitForRun } from "../src/agents/runs.ts";
import { saveProbe } from "../src/agents/probe.ts";
import { createThread, getThread, updateThread } from "../src/agents/threads.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import "../src/agents/jobs.ts";
import { createUser } from "../src/core/users.ts";
import { memberAi } from "../src/agents/member-ai.ts";
import { takeSteering } from "../src/agents/steer.ts";
import { testApp } from "./helpers.ts";

vi.mock("../src/agents/availability.ts", async load => ({
  ...await load<typeof import("../src/agents/availability.ts")>(),
  backendAvailable: (p: { command: string; id: string }) => p.command === process.execPath || p.id === "codex@ark",
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

it("假 ACP 按单轮点名运行，写明越过的规则，下一轮回到原会话 AI", async () => {
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.policy.deny = ["backend:claude"];
  app.config.agents.routing.choose.conversation = "off";
  await send("/codex");
  startWorker(app);
  try {
    const turn = await waitForRun(app, (await send("/claude 帮我整理")).runId!);
    expect(turn.error).toBeNull();
    expect(turn.ai?.profile).toBe("claude");
    expect(runEvents(app, turn.id)).toContainEqual(expect.objectContaining({ type: "status", data: { text: "本人点名，越过了「全局规则 不用 backend:claude」" } }));
    const next = await waitForRun(app, (await send("接着整理")).runId!);
    expect(next.error).toBeNull();
    expect(next.ai?.profile).toBe("codex");
  } finally {
    stopWorker();
    releaseAll();
  }
}, 30000);
