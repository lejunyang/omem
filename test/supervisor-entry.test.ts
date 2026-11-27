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
import { supervisorArgs } from "../src/agents/supervisor-command.ts";

function entries() {
  const app = testApp();
  const thread = createThread(app, { channel: "web", spaceId: "personal" });
  const ctx: ToolContext = { app, actor: "agent", spaceId: "personal", userId: "owner", spaces: ["personal"], runId: null, tools: null };
  const created = () => getLongTask(app, one<{ id: string }>(app.db, "select id from long_tasks")!.id);
  return { app, thread, ctx, created };
}

it("creates a task from a multiline command and applies the topic controls to that task", async () => {
  const { app, thread, created } = entries();
  const goal = "核对  迁移\n完成前不发布";
  const started = await receive(app, { conversationId: thread.id, text: "/监工 codex astra xhigh " + goal });
  const task = created();
  expect(started.reply).toContain(task.threadId);
  expect(started.runId).toBeNull();
  expect(task).toMatchObject({ goal, status: "draft", ai: { profile: "codex", model: "astra", effort: "xhigh" } });
  const work = getThread(app, task.threadId);
  expect(work.parentId).toBe(thread.id);
  const send = (text: string) => runCommand(app, work, text, { text });
  expect(await send("/监工")).toContain(task.id);
  expect(await send("/监工 暂停")).toContain("已暂停");
  expect(await send("/监工 继续")).toContain("等确认任务书");
  expect(await send("/监工 加 0 小时")).toContain("用法");
  await send("/监工 加 3 小时");
  expect(created().budget.hours).toBe(task.budget.hours + 3);
  await send("/监工 换 claude opus high");
  expect(created().ai).toMatchObject({ profile: "claude", model: "opus", effort: "high" });
  expect(await send("/监工 结束")).toContain("已结束");
  expect(await runCommand(app, thread, "/监工 暂停", { text: "" })).toContain("长任务话题");
  expect(await runCommand(app, thread, "/监工 启动", { text: "", asker: "访客" })).toContain("自己的会话");
  expect(app.db.prepare("select count(*) as n from long_tasks").get()).toEqual({ n: 1 });
});

it("preserves the goal and returns the shared AI parser shape for named and shorthand effort", () => {
  const { app } = entries();
  expect(supervisorArgs(app, "audit all changes", "owner")).toEqual({ rest: "audit all changes", notes: [] });
  expect(supervisorArgs(app, "codex high\naudit all changes", "owner")).toEqual({ rest: "audit all changes", ai: { profile: "codex", effort: "high" }, notes: [] });
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    const expected = { rest: "检查  文档\n保留换行", ai: { profile: "codex", model: "sample", effort: level }, notes: [] };
    expect(supervisorArgs(app, `codex sample effort=${level} 检查  文档\n保留换行`, "owner")).toEqual(expected);
    expect(supervisorArgs(app, `codex sample ${level} 检查  文档\n保留换行`, "owner")).toEqual(expected);
  }
});

it("creates through the tool, forwards verbatim from another conversation and checks the task owner and space", async () => {
  const { app, ctx, created, thread } = entries();
  const ai = { profile: "codex", model: "sample", effort: "high" };
  const initial = addMessage(app, thread.id, "user", "让监工盯着原目标");
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
