import { afterEach, expect, it, vi } from "vitest";
import { autoFollowFor, ensureAutoFollow } from "../src/agents/auto-follow.ts";
import { receive } from "../src/agents/inbox.ts";
import { changeLongTask, getLongTask } from "../src/agents/long-tasks.ts";
import { editAutoBrief, submitSupervisorReport } from "../src/agents/supervisor-report.ts";
import { answerAsk, listAsks } from "../src/agents/asks.ts";
import { settingsPatch } from "../src/auth/settings-sections.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { conversationMessages, createThread } from "../src/agents/threads.ts";
import { setupLarkBot } from "../src/channels/lark-bot.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { onLarkSent, setLarkClient, setMentionResolver } from "../src/channels/lark-send.ts";
import { setChatSettings } from "../src/agents/threads.ts";
import { testApp } from "./helpers.ts";

const opened: App[] = [];
function setup() {
  const app = testApp();
  opened.push(app);
  app.config.agents.profiles.push({ id: "demo", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
  app.config.longTasks.supervisor = { profile: "demo" };
  const thread = createThread(app, { spaceId: "personal", channel: "web" });
  const source = { kind: "code" as const, sourceId: "work", userId: "owner", spaceId: "personal", threadId: thread.id, goal: "  检查入口\n保留目标原话。 " };
  return { app, thread, source };
}
afterEach(() => { for (const app of opened.splice(0)) app.db.close(); });

it("自动挂接只通知一次；首版报告生效，发起人可在进度卡修改必问清单", async () => {
  const { app, source, thread } = setup();
  const task = ensureAutoFollow(app, source)!;
  expect(ensureAutoFollow(app, source)?.id).toBe(task.id);
  expect(task).toMatchObject({ goal: source.goal, sourceKind: "code", sourceId: "work", status: "active" });
  const messages = conversationMessages(app, thread.id);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: expect.stringContaining("由 demo 跟进"), meta: { autoFollowId: task.id } });
  const round = one<{ id: string }>(app.db, "select id from runs where lane=?", "supervisor:" + task.id)!;
  run(app.db, "update runs set status='running' where id=?", round.id);
  const brief = { doneWhen: ["能从原会话退出"], scope: ["src"], constraints: ["使用假数据"], outOfScope: [] };
  const report = await submitSupervisorReport(app, round.id, { stage: "核对", status: "on-track", brief,
    goalCheck: [], decisions: [], actions: [], askOwner: [], progress: { done: [], doing: [], next: [] } });
  const active = getLongTask(app, task.id);
  expect(active).toMatchObject({ brief, confirmedAt: expect.any(String) });
  expect(report).toContain("必须问本人的事");
  expect(listAsks(app, { conversationId: task.threadId })).toEqual([]);
  editAutoBrief(app, active);
  const [ask] = listAsks(app, { conversationId: task.threadId });
  await answerAsk(app, ask.id, { by: task.userId, value: { doneWhen: "原会话退出", outOfScope: "", scope: "src", constraints: "保持数据", mustAsk: "修改测试预算" } });
  expect(getLongTask(app, task.id).brief.mustAsk).toEqual(["修改测试预算"]);
});

it("原会话退出后保留历史，重启时相同来源也不会再接管", async () => {
  const { app, thread, source } = setup();
  const task = ensureAutoFollow(app, source)!;
  const result = await receive(app, { conversationId: thread.id, text: "别跟了！" });
  expect(result).toMatchObject({ runId: null, reply: expect.stringContaining("退出") });
  expect(autoFollowFor(app, source.kind, source.sourceId)).toBeNull();
  expect(ensureAutoFollow(app, source)).toBeNull();
  expect(getLongTask(app, task.id)).toMatchObject({ status: "ended", goal: source.goal });
  expect(conversationMessages(app, thread.id)[0].meta).not.toHaveProperty("autoFollowId");
  expect((await changeLongTask(app, task.id, { action: "detach" })).status).toBe("ended");
});

it("同一原会话内有多个自动跟进时按按钮对应的任务退出", async () => {
  const { app, thread, source } = setup();
  const a = ensureAutoFollow(app, source)!;
  const b = ensureAutoFollow(app, { ...source, sourceId: "second" })!;
  expect((await receive(app, { conversationId: thread.id, text: "不用跟进" })).runId).toBeTruthy();
  await changeLongTask(app, a.id, { action: "detach" });
  expect(getLongTask(app, b.id).status).toBe("active");
});

it("各类开关独立，保存单项设置保留其余门槛和跟进 AI", () => {
  const { app, source } = setup();
  expect(app.config.longTasks.auto).toEqual({ code: true, studies: true, agentWork: true, minTasks: 6, minRounds: 3 });
  for (const kind of ["study", "code", "agentWork"] as const) {
    const key = kind === "study" ? "studies" : kind;
    app.config.longTasks.auto[key] = false;
    expect(ensureAutoFollow(app, { ...source, kind })).toBeNull();
    app.config.longTasks.auto[key] = true;
  }
  expect(all(app.db, "select id from long_tasks")).toEqual([]);
  expect(settingsPatch(app.config, { longTasks: { auto: { studies: false } } }).longTasks).toMatchObject({
    supervisor: { profile: "demo" }, auto: { studies: false, code: true, agentWork: true, minTasks: 6, minRounds: 3 },
  });
});

it("飞书原群的退出按钮核对发起人，也接受本人不带 @ 的明确退出词", async () => {
  const { app, source } = setup();
  app.config.lark.ownerOpenId = "ou_owner";
  const chatId = "oc_project";
  const thread = createThread(app, { spaceId: source.spaceId, channel: "lark", key: chatId });
  setChatSettings(app, "lark", chatId, { mode: "chat", spaceId: source.spaceId });
  const post = vi.fn(async () => ({ code: 0, data: { message_id: "om_notice" } }));
  const reply = vi.fn(async () => ({ code: 0, data: { message_id: "om_reply" } }));
  const bot = await setupLarkBot(app, "main", {
    request: async () => ({ bot: { open_id: "ou_bot" } }),
    im: { message: { create: post, reply }, chat: { get: async () => ({ data: { name: "项目群" } }) } },
  });
  try {
    const first = ensureAutoFollow(app, { ...source, threadId: thread.id })!;
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ content: expect.stringContaining('"action":"detach"') }),
    })));
    const click = (user: string) => handleCardAction(app, { operator: { open_id: user },
      context: { open_message_id: "om_notice" }, action: { value: { action: "detach" } } });
    await click("ou_visitor");
    expect(getLongTask(app, first.id).status).toBe("active");
    await click("ou_owner");
    expect(getLongTask(app, first.id).status).toBe("ended");
    const second = ensureAutoFollow(app, { ...source, sourceId: "second", threadId: thread.id })!;
    await bot.message({ sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } }, message: {
      message_id: "om_opt_out", chat_id: chatId, chat_type: "group", create_time: String(Date.now()),
      message_type: "text", content: JSON.stringify({ text: "不用跟进" }), mentions: [],
    } });
    await bot.settled();
    expect(getLongTask(app, second.id).status).toBe("ended");
    expect(all(app.db, "select id from runs where kind='ask'")).toEqual([]);
  } finally {
    onLarkSent(null);
    setMentionResolver(null);
    setLarkClient(null);
  }
});
