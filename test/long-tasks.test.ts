import { afterAll, describe, expect, it } from "vitest";
import { changeLongTask, confirmLongTaskBrief, getLongTask, longTaskInThread, saveLongTaskReport, startLongTask } from "../src/agents/long-tasks.ts";
import { reportSchema } from "../src/agents/supervisor-schema.ts";
import { createThread, getThread, resolveThread, setChatSettings, updateThread } from "../src/agents/threads.ts";
import type { App } from "../src/core/app.ts";
import { all, one, run } from "../src/core/db.ts";
import { mergeLibrary } from "../src/core/pull.ts";
import { createSpace } from "../src/core/spaces.ts";
import { addMember, createApiToken, createUser } from "../src/core/users.ts";
import { dueItems, itemExpiry } from "../src/items/expiry.ts";
import { getItem, itemEvents } from "../src/items/store.ts";
import { startServer } from "../src/server/http.ts";
import { testApp } from "./helpers.ts";

const opened: App[] = [];
function setup() {
  const app = testApp();
  opened.push(app);
  app.config.agents.profiles.push({ id: "demo", transport: "acp", command: process.execPath, args: [], env: {}, idleTimeoutMs: 60000 });
  app.config.agents.tiers.strong = { profile: "demo" };
  return app;
}
afterAll(() => { for (const app of opened.splice(0)) app.db.close(); });
const input = { spaceId: "personal", userId: "owner", goal: "  核对两处接口\n保留示例。  " };

describe("长任务存储和授权", () => {
  it("保留原话，创建关联事项和独立会话，立即叫醒一次", () => {
    const app = setup();
    const parent = createThread(app, { spaceId: "personal", channel: "web" });
    const task = startLongTask(app, { ...input, threadId: parent.id });
    expect(task).toMatchObject({ status: "draft", goal: input.goal, ai: { profile: "demo" }, budget: { dailyWakes: 40 } });
    expect(getItem(app, task.itemId)).toMatchObject({ kind: "watch", detail: input.goal });
    expect(getThread(app, task.threadId)).toMatchObject({ parentId: parent.id, settings: { itemId: task.itemId } });
    expect(longTaskInThread(app, parent.id)).toBeNull();
    expect(longTaskInThread(app, task.threadId)?.id).toBe(task.id);
    expect(one(app.db, "select state from long_tasks where id=?", task.id)).toEqual({ state: "{}" });
    expect(all(app.db, "select status from runs where lane=?", "supervisor:" + task.id)).toEqual([{ status: "queued" }]);
    expect(() => startLongTask(app, { ...input, ai: { profile: "unknown" } })).toThrow();
    expect(all(app.db, "select id from items")).toHaveLength(1);
  });

  it("飞书子会话等话题创建期间，主群消息仍进入发起会话", () => {
    const app = setup();
    const parent = createThread(app, { spaceId: "personal", channel: "lark", key: "group", settings: { lastMessageId: "om_request" } });
    setChatSettings(app, "lark", "group", { mode: "chat" });
    const task = startLongTask(app, { ...input, threadId: parent.id });
    updateThread(app, parent.id, { settings: { lastMessageId: "om_next" } });
    expect(getThread(app, task.threadId).settings.lastMessageId).toBe("om_request");
    expect(resolveThread(app, { channel: "lark", chatId: "group" }).thread.id).toBe(parent.id);
    run(app.db, "update conversations set external_id='group#topic' where id=?", task.threadId);
    expect(resolveThread(app, { channel: "lark", chatId: "group", topicId: "topic" }).thread.id).toBe(task.threadId);
  });

  it("草案暂停再继续仍需确认，补充按原话追加，修改预算保留其余上限", async () => {
    const app = setup(), task = startLongTask(app, input);
    const change = (c: Parameters<typeof changeLongTask>[2]) => changeLongTask(app, task.id, c);
    expect((await change({ action: "pause" })).status).toBe("paused");
    expect(itemExpiry(app, getItem(app, task.itemId))).toBeNull();
    expect(dueItems(app, { withinDays: 30 }).map(entry => entry.item.id)).not.toContain(task.itemId);
    expect((await change({ action: "resume" })).status).toBe("draft");
    expect(() => confirmLongTaskBrief(app, task.id, { constraints: ["只改说明"] })).toThrow(/完成条件/);
    confirmLongTaskBrief(app, task.id, { doneWhen: ["两个入口通过"], constraints: ["只改说明"] });
    const text = "  范围增加一页\n注意换行  ";
    await change({ action: "supplement", text });
    await change({ action: "supplement", text: "按原范围收尾" });
    expect(await change({ action: "budget", budget: { hours: 2.5 } })).toMatchObject({ status: "active", goal: input.goal,
      budget: { ...task.budget, hours: 2.5 }, supplements: [{ text, at: expect.any(String) }, { text: "按原范围收尾", at: expect.any(String) }] });
    await expect(change({ action: "budget", budget: { codeRounds: 0 } })).rejects.toThrow();
    expect((await change({ action: "end" })).status).toBe("ended");
    expect(getItem(app, task.itemId).status).toBe("cancelled");
    await expect(change({ action: "resume" })).rejects.toThrow();
  });

  it("每轮报告写入同一次运行和事项时间线，完成跟随事项一起关闭", () => {
    const app = setup(), task = startLongTask(app, input);
    const round = one<{ id: string }>(app.db, "select id from runs where lane=?", "supervisor:" + task.id)!;
    confirmLongTaskBrief(app, task.id, { doneWhen: ["验收通过"] });
    const report = reportSchema.parse({ stage: "验收", status: "done", goalCheck: ["通过"], decisions: [{ what: "收尾", why: "已验收" }],
      actions: [], askOwner: [], progress: { done: ["验收"], doing: [], next: [] } });
    saveLongTaskReport(app, task.id, round.id, report, "两处入口已通过验收");
    expect(getLongTask(app, task.id)).toMatchObject({ status: "done", notes: [{ runId: round.id, decisions: report.decisions }] });
    expect(getItem(app, task.itemId).status).toBe("done");
    expect(itemEvents(app, task.itemId)).toContainEqual(expect.objectContaining({ kind: "supervise", text: "两处入口已通过验收" }));
    expect(one(app.db, "select json_extract(output,'$.supervisorReport.stage') stage from runs where id=?", round.id)).toEqual({ stage: "验收" });
  });

  it("拉取保留任务书、补充与会话联系，远端运行和待确认卡留在原设备", async () => {
    const local = setup(), remote = setup();
    const task = startLongTask(remote, input);
    confirmLongTaskBrief(remote, task.id, { doneWhen: ["有测试报告"] });
    await changeLongTask(remote, task.id, { action: "supplement", text: "优先核对异常路径" });
    run(remote.db, "update long_tasks set state=? where id=?", JSON.stringify({ briefAsk: "remote-card" }), task.id);
    mergeLibrary(local, remote.home);
    expect(longTaskInThread(local, task.threadId)).toMatchObject({ id: task.id, itemId: task.itemId, status: "paused",
      brief: { doneWhen: ["有测试报告"] }, supplements: [{ text: "优先核对异常路径" }] });
    expect(one(local.db, "select state from long_tasks where id=?", task.id)).toEqual({ state: "{}" });
    expect(one(local.db, "select status from runs where kind='supervise'")).toEqual({ status: "cancelled" });
    expect(getItem(local, task.itemId).status).toBe("snoozed");
    expect(getLongTask(remote, task.id).status).toBe("active");
  });

  it("HTTP 逐项检查空间权限和发起人，拒绝伪造归属及借用他人会话", async () => {
    const app = setup();
    createSpace(app, { id: "team", name: "项目" });
    for (const user of ["editor", "reader", "outside"]) createUser(app, { id: user, name: user });
    addMember(app, "team", "editor", "editor");
    addMember(app, "team", "reader", "reader");
    const parent = createThread(app, { spaceId: "team", userId: "owner", channel: "web" });
    const tokens = new Map(["editor", "reader", "outside"].map(id => [id, createApiToken(app, id, "test")]));
    const server = await startServer(app, { port: 0, quiet: true });
    const call = (user: string, method: "GET" | "PATCH" | "POST", tail = "", payload?: Record<string, unknown>) =>
      server.inject({ method, url: "/api/long-tasks" + tail, headers: { authorization: "Bearer " + tokens.get(user) }, payload });
    try {
      const create = { space: "team", goal: "检查清单" };
      expect((await call("reader", "POST", "", create)).statusCode).toBe(403);
      expect((await call("editor", "POST", "", { ...create, userId: "owner" })).statusCode).toBe(400);
      expect((await call("editor", "POST", "", { ...create, threadId: parent.id })).statusCode).toBe(403);
      const created = await call("editor", "POST", "", create);
      expect(created.statusCode).toBe(200);
      const task = created.json();
      const id = "/" + task.id;
      expect(task.userId).toBe("editor");
      expect((await call("editor", "GET", "?space=team")).json().tasks).toHaveLength(1);
      expect((await call("editor", "GET", id)).json()).toMatchObject({ id: task.id, progress: { rounds: 0 }, notes: [], timeline: expect.any(Array) });
      expect((await call("outside", "GET", "?space=team")).json().tasks).toEqual([]);
      expect((await call("outside", "GET", id)).statusCode).toBe(404);
      expect((await call("reader", "PATCH", id, { action: "pause" })).statusCode).toBe(403);
      expect((await call("editor", "PATCH", id, { action: "pause", goal: "换目标" })).statusCode).toBe(400);
      expect((await call("editor", "PATCH", id, { action: "pause" })).json().status).toBe("paused");
      addMember(app, "team", "editor", "reader");
      expect((await call("editor", "PATCH", id, { action: "resume" })).statusCode).toBe(403);
    } finally { await server.close(); }
  });
});
