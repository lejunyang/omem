import { threadTurn } from "../src/agents/sessions.ts";
import { addMessage, createThread, threadMessages } from "../src/agents/threads.ts";
import { fakeCloudReceipt } from "./fake-cloud-probe.ts";
import "../src/agents/jobs.ts";
import { __testHandlers, createRun } from "../src/agents/runs.ts";
import { upsertItem } from "../src/items/store.ts";
import { remember } from "../src/memory/store.ts";
import { one } from "../src/core/db.ts";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { confirmProbe, probeCloud } from "../src/agents/cloud-probe.ts";
import { runRole } from "../src/agents/runner.ts";
import { agentRunError, type AgentEvent } from "../src/agents/types.ts";
import { testApp } from "./helpers.ts";

it("moves a role run to the next backend when the first fails before doing anything", async () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  // A backend that cannot get going: its process says why and exits, as a CLI whose local environment failed would.
  app.config.agents.profiles.push({ id: "broken", name: "broken", transport: "acp", command: process.execPath, args: ["-e", "console.error('Local execution environment preparation failed: ENVIRONMENT_ERROR.'); process.exit(1)"], env: {}, idleTimeoutMs: 20000 });
  app.config.agents.profiles.push({ id: "spare", name: "spare", transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "thread" }, idleTimeoutMs: 60000 });
  app.config.agents.default = "broken";
  app.config.agents.fallback = [{ profile: "spare" }];
  const events: AgentEvent[] = [];
  const r = await runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "总结一下", onEvent: (e) => events.push(e) });
  expect(r.profileId).toBe("spare");
  expect(events.some((e) => e.type === "status" && /没有开始工作就失败了/.test(e.text) && /spare/.test(e.text))).toBe(true);
  // With nothing to fall back to, the first failure is what the run reports.
  app.config.agents.fallback = [];
  await expect(runRole(app, { role: "summarizer", spaceId: "personal", runId: null, task: "再总结" })).rejects.toThrow();
}, 60_000);

it.each([true, false])("skips text-only profiles for item upkeep (cloud primary = %s)", async cloudFirst => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  const local = { id: "local", transport: "acp" as const, command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: { FAKE_MODE: "echo" }, idleTimeoutMs: 20_000 };
  app.config.agents.profiles = [local, { ...local, id: "cloud", transport: "doubao" }];
  app.config.agents.default = cloudFirst ? "cloud" : "local";
  app.config.agents.fallback = [{ profile: cloudFirst ? "local" : "cloud" }];
  app.config.webUrl = "https://8.8.8.8";
  Object.assign(app.config.agents.cloudTools, { enabled: true, credentialIn: "message", backends: ["cloud"] });
  const probe = await probeCloud(app, "cloud", async (_app, _p, req) => {
    const nonce = req.prompt.match(/challenge\/([\w-]+)/)![1];
    return { text: fakeCloudReceipt(app, nonce, "header"), agent: "test", stopReason: "end_turn" };
  });
  confirmProbe(app, "cloud", probe.id);
  const runId = createRun(app, { kind: "ask", title: "复核事项" }).id;
  const events: AgentEvent[] = [];
  const r = await runRole(app, { role: "item-keeper", spaceId: "personal", runId, task: "复核事项", onEvent: e => events.push(e) });
  expect(r.profileId).toBe("local");
  expect(events).toContainEqual(expect.objectContaining({ type: "status", text: expect.stringMatching(/跳过后端 cloud.*settle_items/) }));
  app.db.close();
});

it("keeps the item cursor and memory verdict pending when no backend can deliver", async () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.default = "doubao";
  const item = upsertItem(app, undefined, { title: "确认项目 A 排期" });
  const memory = remember(app, { spaceId: "personal", kind: "fact", content: "项目 A 周五验收。", createdBy: "agent" });
  for (const kind of ["item-settle", "memory-review"] as const) {
    const run = createRun(app, { kind, spaceId: "personal", title: "复核", input: { task: "查看进展", checks: [{ id: item.id, latestMs: 42 }] } });
    const events: unknown[] = [];
    await expect(__testHandlers.get(kind)!({ app, run, signal: new AbortController().signal, event: (_, e) => events.push(e), output() {} })).rejects.toThrow(/需要 (settle_items|review_memories)/);
    expect(events).toContainEqual(expect.objectContaining({ text: expect.stringMatching(/跳过后端 doubao/) }));
  }
  expect(one(app.db, "select * from item_checks where item_id = ?", item.id)).toBeUndefined();
  expect(one(app.db, "select review_verdict, reviewed_at from memories where id = ?", memory.id)).toEqual({ review_verdict: null, reviewed_at: null });
  app.db.close();
});

it("checks explicit hand-in tools against the final role permissions", async () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  app.config.agents.profiles = [{ id: "local", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 1000 }];
  await expect(runRole(app, { role: "item-keeper", profileId: "local", requiredTools: ["settle_items"], denyTools: ["settle_items"], runId: null, spaceId: "personal", task: "复核" })).rejects.toThrow("缺少必需工具：settle_items");
  app.db.close();
});


it("continues a cloud HTTP conversation on the configured fallback after a queue timeout", async () => {
  const app = testApp();
  app.baseUrl = "http://127.0.0.1:1";
  app.config.webUrl = "https://8.8.8.8";
  const cloud = { id: "cloud", transport: "doubao" as const, command: "unused", args: [], env: {}, idleTimeoutMs: 1000 };
  app.config.agents.profiles = [cloud, { ...cloud, id: "spare" }];
  app.config.agents.default = cloud.id;
  app.config.agents.fallback = [{ profile: "spare" }];
  Object.assign(app.config.agents.cloudTools, { enabled: true, credentialIn: "message", backends: ["cloud"] });
  const probe = await probeCloud(app, "cloud", async (_app, _profile, req) => ({
    text: fakeCloudReceipt(app, req.prompt.match(/challenge\/([\w-]+)/)![1], "header"), agent: "test", stopReason: "end_turn",
  }));
  confirmProbe(app, "cloud", probe.id);
  const doubao = await import("../src/agents/doubao.ts");
  vi.spyOn(doubao, "doubaoApps").mockResolvedValue([{ appId: "fake", secret: "unused" }]);
  vi.spyOn(doubao, "doubaoTokenExists").mockReturnValue(true);
  const calls: string[] = [];
  const fake = vi.spyOn(doubao, "runDoubao").mockImplementation(async (profile, req) => {
    calls.push(profile.id);
    if (profile.id === "cloud") {
      const secret = req.prompt.match(/oct_[\w-]+/)![0];
      throw agentRunError("1 秒内没有开始回答，已停止 " + secret, "queue", true);
    }
    return { agent: profile.id, text: "已完成", stopReason: "end_turn" };
  });
  try {
    const thread = createThread(app, { channel: "web", spaceId: "personal", settings: { profile: "cloud" } });
    addMessage(app, thread.id, "user", "查看材料");
    const run = createRun(app, { kind: "ask", title: "查看材料", input: { conversationId: thread.id } });
    const events: unknown[] = [];
    const result = await threadTurn({ app, run, signal: new AbortController().signal, event: (_, e) => events.push(e), output() {} },
      thread.id, threadMessages(app, thread.id));
    expect(result).toMatchObject({ profileId: "spare", text: "已完成" });
    expect(calls).toEqual(["cloud", "spare"]);
    expect(JSON.stringify(events)).toContain("[云端凭据]");
    expect(JSON.stringify(events)).not.toContain("oct_");
    expect(fake.mock.calls[1][1].prompt).not.toContain("oct_");
  } finally { vi.restoreAllMocks(); app.db.close(); }
});
