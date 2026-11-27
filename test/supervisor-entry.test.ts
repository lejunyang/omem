import { resolve } from "node:path";
import { expect, it } from "vitest";
import { testApp } from "./helpers.ts";
import { receive } from "../src/agents/inbox.ts";
import { runCommand } from "../src/agents/commands.ts";
import { callTool, type ToolContext } from "../src/agents/tools.ts";
import { addMessage, createThread, getThread } from "../src/agents/threads.ts";
import { createSpace } from "../src/core/spaces.ts";
import { createRun } from "../src/agents/runs.ts";
import { one } from "../src/core/db.ts";
import { expandTools } from "../src/agents/tool-help.ts";
import { peerToolNames } from "../src/agents/peer-agent.ts";
import { getLongTask } from "../src/agents/long-tasks.ts";
import { setKey } from "../src/core/ai-keys.ts";

function entries() {
  const app = testApp();
  const thread = createThread(app, { channel: "web", spaceId: "personal" });
  const ctx: ToolContext = { app, actor: "agent", spaceId: "personal", userId: "owner", spaces: ["personal"], runId: null, tools: null };
  const created = () => getLongTask(app, one<{ id: string }>(app.db, "select id from long_tasks")!.id);
  return { app, thread, ctx, created };
}

function commandEntries() {
  const result = entries();
  const { app } = result;
  app.config.agents.profiles = [
    { id: "codex", model: "astra" },
    { id: "claude", model: "opus", aliases: ["校对"] },
  ].map(p => ({ ...p, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env: {}, idleTimeoutMs: 60000 }));
  return result;
}

it("creates a task from a multiline command and applies the topic controls to that task", async () => {
  const { app, thread, created } = commandEntries();
  for (const help of ["/help", "/help all"]) {
    const text = await runCommand(app, thread, help, { text: help });
    expect(text).toContain("/跟进 [AI] 任务");
    expect(text).not.toContain("/监工");
  }
  expect(await runCommand(app, thread, "/监工 启动", { text: "" })).toBeNull();
  const goal = "核对  迁移\n完成前不发布";
  const started = await receive(app, { conversationId: thread.id, text: "/跟进 codex astra xhigh " + goal });
  const task = created();
  expect(started.reply).toContain(task.threadId);
  expect(started.reply).toContain("由 codex · astra · xhigh 跟进");
  expect(started.runId).toBeNull();
  expect(task).toMatchObject({ goal, status: "draft", ai: { profile: "codex", model: "astra", effort: "xhigh" } });
  const work = getThread(app, task.threadId);
  expect(work.parentId).toBe(thread.id);
  const send = (text: string) => runCommand(app, work, text, { text });
  expect(await send("/跟进")).toContain(task.id);
  expect(await send("/跟进 暂停")).toContain("已暂停");
  expect(await send("/跟进 继续")).toContain("等确认任务书");
  expect(await send("/跟进 加 0 小时")).toContain("用法");
  await send("/跟进 加 3 小时");
  expect(created().budget.hours).toBe(task.budget.hours + 3);
  await send("/跟进 换 校对 opus effort=high");
  expect(created().ai).toMatchObject({ profile: "claude", model: "opus", effort: "high" });
  expect(await send("/跟进 结束")).toContain("已结束");
  expect(await runCommand(app, thread, "/跟进 暂停", { text: "" })).toContain("长任务话题");
  expect(await runCommand(app, thread, "/跟进 启动", { text: "", asker: "访客" })).toContain("自己的会话");
  expect(app.db.prepare("select count(*) as n from long_tasks").get()).toEqual({ n: 1 });
});

it("starts with a concrete group pick and keeps an English goal on the following line", async () => {
  const { app, thread, created } = commandEntries();
  app.config.agents.groups.find(g => g.id === "strong")!.items = [{ profile: "claude", model: "opus", effort: "max" }];
  const send = (text: string) => receive(app, { conversationId: thread.id, text });
  expect((await send("/跟进 codex fix the bug")).reply).toContain("找不到模型 fix the bug");
  expect(one(app.db, "select id from long_tasks")).toBeUndefined();
  await send("/跟进 /强\nfix the bug");
  const task = created();
  expect(task).toMatchObject({ goal: "fix the bug", ai: { profile: "claude", model: "opus", effort: "max" } });
  const work = getThread(app, task.threadId);
  await runCommand(app, work, "/跟进 换 codex astra xhigh", { text: "" });
  expect(created().ai).toEqual({ profile: "codex", model: "astra", effort: "xhigh" });
  await runCommand(app, work, "/跟进 换 /强", { text: "" });
  expect(created().ai).toEqual(task.ai);
});

it("lists exact choices for ambiguous key models before creating or changing a task", async () => {
  const { app, thread, created } = commandEntries();
  app.config.ai.providers.push({ id: "demo", name: "示例", kind: "openai-compatible", baseUrl: "https://example.test", backends: ["codex"], models: ["sample-fast", "sample-pro"] });
  setKey(app.home, "demo", "test");
  const send = (text: string, conversationId = thread.id) => receive(app, { conversationId, text });
  expect((await send("/跟进 codex 示例 sample 检查文档")).reply).toContain("sample-fast、sample-pro");
  expect(one(app.db, "select id from long_tasks")).toBeUndefined();
  await send("/跟进 codex 示例 sample-pro medium\naudit the docs");
  const task = created();
  expect(task).toMatchObject({ goal: "audit the docs", ai: { profile: "codex@demo", model: "sample-pro", effort: "medium" } });
  expect((await send("/跟进 换 codex 示例 sample", task.threadId)).reply).toContain("sample-fast、sample-pro");
  expect((await send("/跟进 换 codex 示例 missing", task.threadId)).reply).toContain("找不到模型 missing");
  expect(created().ai).toEqual(task.ai);
});

it("creates through the tool, forwards verbatim from another conversation and checks the task owner and space", async () => {
  const { app, ctx, created, thread } = entries();
  const ai = { profile: "codex", model: "sample", effort: "high" };
  const initial = addMessage(app, thread.id, "user", "让助手盯着原目标");
  const ask = createRun(app, { kind: "ask", title: "开始长任务", input: { conversationId: thread.id, messageIds: [initial] } });
  const result = await callTool({ ...ctx, runId: ask.id }, "start_long_task", { goal: "原目标", ai, budget: { hours: 5 } });
  expect(result.isError, result.text).toBe(false);
  const task = created();
  expect(result.text).toContain(task.id);
  expect(getThread(app, task.threadId).parentId).toBe(thread.id);
  expect(task).toMatchObject({ goal: "原目标", ai, budget: { hours: 5 } });
  const text = "  第一行\n  第二行";
  const args = { task_id: task.id, text };
  const message = addMessage(app, thread.id, "user", text);
  const outside = createRun(app, { kind: "ask", title: "转达本人的要求", input: { conversationId: thread.id, messageIds: [message] } });
  const sent = await callTool({ ...ctx, runId: outside.id }, "message_supervisor", args);
  expect(sent.isError, sent.text).toBe(false);
  expect((await callTool({ ...ctx, writable: [] }, "message_supervisor", args)).isError).toBe(true);
  createSpace(app, { id: "other", name: "项目 B" });
  expect((await callTool({ ...ctx, spaceId: "other", spaces: ["other"] }, "long_task_status", { task_id: task.id })).isError).toBe(true);
  const runId = createRun(app, { kind: "ask", title: "看进展", input: { conversationId: task.threadId } });
  expect((await callTool({ ...ctx, runId: runId.id }, "long_task_status", {})).text).toContain(task.id);
  const foreign = { ...ctx, userId: "another" };
  expect((await callTool(foreign, "long_task_status", { task_id: task.id })).isError).toBe(true);
  expect((await callTool(foreign, "message_supervisor", args)).isError).toBe(true);
  expect(created().supplements.map(s => s.text)).toEqual([text]);
});

it("keeps supervisor reports role-only and prevents remote agents from starting or steering work", () => {
  expect(expandTools(["group:supervise"])).toEqual(["start_long_task", "message_supervisor", "long_task_status"]);
  for (const name of ["start_long_task", "message_supervisor"]) expect(peerToolNames().has(name)).toBe(false);
});
