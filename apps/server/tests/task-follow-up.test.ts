import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { MemoryService } from "../src/memory/service.js";
import { AssistantRuntime, type AssistantModelPort } from "../src/assistant/runtime.js";
import { parseAssistantReply } from "../src/assistant/acp-model.js";

const followUp = { waiting_on: "张三", next_check_at: "2030-10-02T01:00:00.000Z", snoozed_until: null,
  time_expression: "2030年10月2日上午9点", timezone: "Asia/Shanghai" };

describe("daily message follow-up", () => {
  it("reminds with the persisted current check time after snoozing, without copying the old instruction", () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-reminder-content-")); let store = new Store(dir);
    try {
      const original = "跟进周末读书会报名确认，等待组织者回复；2030年10月2日上午9点提醒我检查。";
      const metadata = (applicationId: string) => ({ workspaceId: "personal", applicationId,
        proposalDigest: applicationId, generation: 1, title: "更新报名确认事项", details: "明确的个人委托",
        delivery: { channelBindingVersion: 1, channel: "in_app" as const, target: "notification-center" } });
      const created = store.applications.applyTask({ metadata: metadata("create"), task: {
        title: "周末读书会报名确认", detail: original, nextStep: original, status: "waiting", dueAt: null,
        followUp: { ...followUp, waiting_on: "组织者回复" },
      } });
      store.applications.applyTask({ metadata: metadata("snooze"), task: {
        id: created.entityId, expectedVersion: 1, title: "周末读书会报名确认", detail: original,
        nextStep: original, status: "waiting", dueAt: null,
        followUp: { waiting_on: "组织者回复", next_check_at: "2030-10-03T02:00:00.000Z",
          snoozed_until: "2030-10-03T02:00:00.000Z", time_expression: "2030年10月3日上午10点", timezone: "Asia/Shanghai" },
      } });
      store.close(); store = new Store(dir);
      expect(store.remind("2030-10-03T02:00:00.000Z")).toBe(1);
      const reminder = store.notifications().find(n => n.title.startsWith("事项待跟进"))!;
      expect(reminder.body).toContain("2030年10月3日");
      expect(reminder.body).toContain("10:00");
      expect(reminder.body).toContain("Asia/Shanghai");
      expect(reminder.body).toContain("等待：组织者回复");
      expect(reminder.body).toContain("检查「周末读书会报名确认」的进展");
      expect(reminder.body).not.toContain("10月2日");
      expect(store.tasks()[0]!.detail).toBe(original);
      expect(store.remind("2030-10-03T03:00:00.000Z")).toBe(0);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("tracks a waiting message, snoozes without changing its deadline, catches up once after reopening the store, then cancels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-follow-up-")); let store = new Store(dir);
    try {
      const model: AssistantModelPort = { generate: async input => {
        const task = input.tasks?.[0];
        if (!task) return parseAssistantReply(JSON.stringify({ answer: "模型不能自报已安排", citation_ids: [], create_task: {
          title: "评审回复", detail: "收到回复后整理评审结论", citation_ids: [], due_at: null, due_expression: null, follow_up: followUp } }));
        const action = input.userText.includes("取消") ? "cancel" : "snooze";
        return parseAssistantReply(JSON.stringify({ answer: "模型自报成功", citation_ids: [], update_task: { task_id: task.id,
          expected_version: task.version, action, follow_up: action === "cancel" ? null : { ...followUp, waiting_on: null,
            next_check_at: "2030-10-03T02:00:00.000Z", snoozed_until: "2030-10-03T02:00:00.000Z", time_expression: "2030年10月3日上午10点" } } }));
      } };
      const runtime = new AssistantRuntime(store, model, { memory: new MemoryService(store) });
      const conversation = runtime.conversations.open({ principalId: "owner", channel: "web", visibility: "private", chatId: "follow-up" });
      const create = await runtime.turn({ conversationId: conversation.id, userText: "帮我跟进张三的评审回复，2030年10月2日上午9点提醒我检查。" });
      expect(create.turn.result).toContain("等待：张三");
      expect(store.tasks()[0]).toMatchObject({ status: "waiting", dueAt: null, followUp });
      const taskId = store.tasks()[0]!.id;
      expect(store.remind("2030-10-02T00:00:00.000Z")).toBe(0);
      await runtime.turn({ conversationId: conversation.id, userText: "稍后，2030年10月3日上午10点再提醒我。" });
      expect(store.tasks()[0]).toMatchObject({ id: taskId, status: "waiting", version: 2, dueAt: null,
        followUp: { waiting_on: "张三", snoozed_until: "2030-10-03T02:00:00.000Z" } });
      expect(store.remind("2030-10-02T02:00:00.000Z")).toBe(0);
      runtime.shutdown(); store.close(); store = new Store(dir);
      expect(store.remind("2030-10-03T03:00:00.000Z")).toBe(1);
      expect(store.remind("2030-10-03T04:00:00.000Z")).toBe(0);
      const reminders = store.notifications().filter(n => n.title.startsWith("事项待跟进"));
      expect(reminders).toHaveLength(1); expect(reminders[0]!.body).toContain("尚未确认收到回复");
      const resumed = new AssistantRuntime(store, model, { memory: new MemoryService(store) });
      const cancel = await resumed.turn({ conversationId: conversation.id, userText: "取消刚才的评审回复事项，不用做了。" });
      expect(cancel.turn.result).toContain("已取消");
      expect(store.tasks()[0]).toMatchObject({ status: "cancelled", version: 3, followUp: null });
      expect(store.remind("2040-01-01T00:00:00.000Z")).toBe(0);
      expect(store.db.prepare("SELECT count(*) AS n FROM task_revisions WHERE task_id=?").get(String(taskId))).toEqual({ n: 3 });
      resumed.shutdown();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not convert a discussion about someone else's promise into a personal task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-discussion-")); const store = new Store(dir);
    try {
      const model: AssistantModelPort = { generate: async () => ({ answer: "张三承诺回复", citationIds: [], toolCalls: [
        { tool: "create_task", title: "张三的承诺", detail: "不能替用户接任务", followUp }] }) };
      const runtime = new AssistantRuntime(store, model, { memory: new MemoryService(store) });
      const c = runtime.conversations.open({ principalId: "owner", channel: "web", visibility: "private", chatId: "discussion" });
      await runtime.turn({ conversationId: c.id, userText: "群里张三说他周五会回复，这段讨论是什么意思？" });
      expect(store.tasks()).toHaveLength(0); runtime.shutdown();
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("combines simultaneous check-in and deadline alerts, while a later deadline still gets its own receipt", () => {
    const dir = mkdtempSync(join(tmpdir(), "omem-reminders-")); const store = new Store(dir);
    try {
      for (const [name, due] of [["同时", "2030-10-02T01:00:00.000Z"], ["稍晚", "2030-10-04T01:00:00.000Z"]]) {
        store.applications.applyTask({ metadata: { workspaceId: "personal", applicationId: name!, proposalDigest: name!, generation: 1,
          title: name!, details: "fixture", delivery: { channelBindingVersion: 1, channel: "in_app", target: "notification-center" } },
          task: { title: name!, detail: "", nextStep: "检查结果", status: "waiting", dueAt: due!, followUp } });
      }
      expect(store.remind("2030-10-02T02:00:00.000Z")).toBe(2);
      expect(store.remind("2030-10-02T03:00:00.000Z")).toBe(0);
      expect(store.remind("2030-10-04T02:00:00.000Z")).toBe(1);
      expect(store.remind("2030-10-04T03:00:00.000Z")).toBe(0);
      expect(store.db.prepare("SELECT count(*) AS n FROM task_reminder_receipts").get()).toEqual({ n: 4 });
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
