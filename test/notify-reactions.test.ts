import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { askModel } from "../src/agents/oneshot.ts";
import { approvalStreak, reportDone, rungOf, setRung } from "../src/agents/approval-ladder.ts";
import { onLarkReaction, recordLarkSent } from "../src/channels/lark-feedback.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { recordInteraction } from "../src/channels/lark-send.ts";
import { upsertItem } from "../src/items/store.ts";
import { one, run } from "../src/core/db.ts";
import { addNotificationSink, listNotifications, markPushed, notify, setNotificationCard } from "../src/core/notify.ts";
import { handleNegativeNotification } from "../src/core/notify-reactions.ts";
import { listIgnoreRules } from "../src/core/notify-lessons.ts";
import { testApp } from "./helpers.ts";

vi.mock("../src/agents/oneshot.ts", async (original) => ({ ...await original<typeof import("../src/agents/oneshot.ts")>(), askModel: vi.fn() }));

let app: ReturnType<typeof testApp>;
const rule = "项目 A 群里没有点名本人、也没有期限的日常进度播报不再提醒";
beforeEach(() => { app = testApp(); vi.mocked(askModel).mockReset().mockResolvedValue(JSON.stringify({ rule })); });
afterEach(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });
function card(urgency: "normal" | "urgent" = "normal", userId = "owner") {
  const n = notify(app, { title: "项目 A 的日常进展", body: "群里同步了今天的进度，没有要本人处理的事。", urgency, userId });
  setNotificationCard(app, n.id, n.id + "_card");
  recordLarkSent(app, { messageId: n.id + "_card", purpose: "notification", bot: "main" });
  return n;
}
function react(messageId: string, who: "owner" | "member" | "guest" = "owner", kind: "created" | "deleted" = "created", emoji = "THUMBSDOWN") {
  return onLarkReaction(app, "main", { message_id: messageId, reaction_type: { emoji_type: emoji }, operator_type: "user", user_id: { open_id: `ou_${who}` } }, kind, () => who);
}
const notice = (id: string) => listNotifications(app).find((n) => n.id === id)!;

it("immediately demotes a disliked report, resets approvals, and tells the owner once even across repeated events", async () => {
  app.config.notify.learnFromReactions = false; // The safety fallback is independent of lesson learning.
  setRung(app, "lark_write", "report");
  run(app.db, "insert into asks(id,kind,question,status,tool,user_id,approved,created_at,answered_at) values('a','approval','写一行','answered','lark_write','owner',1,?,?)", new Date(Date.now() - 120_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
  expect(approvalStreak(app, "lark_write")).toBe(1);
  reportDone(app, { who: "助理" }, "lark_write", {}, { text: "写入一行", isError: false });
  const n = listNotifications(app)[0];
  setNotificationCard(app, n.id, "report-card");
  react("report-card");
  expect(rungOf(app, "lark_write")).toBe("ask");
  expect(approvalStreak(app, "lark_write")).toBe(0);
  expect(listNotifications(app).find((r) => r.id !== n.id)).toMatchObject({ urgency: "later", body: "你对「lark_write」做完后的汇报表示了不满意，这个工具改回每次先问你。在 设置 → 安全 可以改回去。" });
  await handleNegativeNotification(app, n.id);
  // After completed processing (and after the owner explicitly changes it back), a redelivery is inert.
  setRung(app, "lark_write", "report");
  react("report-card");
  await handleNegativeNotification(app, n.id);
  expect(rungOf(app, "lark_write")).toBe("report");
  expect(listNotifications(app)).toHaveLength(2);
  expect(askModel).not.toHaveBeenCalled();
  expect(listIgnoreRules(app)).toEqual([]);
});

it("uses the existing model path once for concurrent reactions, saves the rule, and tells the owner once", async () => {
  let finish!: (text: string) => void;
  vi.mocked(askModel).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const n = card();
  const heard: string[] = [];
  const stop = addNotificationSink((r) => { heard.push(r.id); });
  try {
    react(n.id + "_card");
    await vi.waitFor(() => expect(askModel).toHaveBeenCalledOnce());
    react(n.id + "_card");
    const done = handleNegativeNotification(app, n.id);
    finish(JSON.stringify({ rule }));
    await done;
    expect(askModel).toHaveBeenCalledOnce();
    expect(vi.mocked(askModel).mock.calls[0][1]).toContain(n.body);
    expect(listIgnoreRules(app)).toHaveLength(1);
    expect(notice(n.id)).toMatchObject({ negativeHandledAt: expect.any(String), ignoreRule: { id: listIgnoreRules(app)[0].id, rule } });
    expect(listNotifications(app).find((r) => r.id !== n.id)).toMatchObject({ urgency: "later", held: 1, body: `你对「${n.title}」这条提醒表示了不满意，以后这类不再提醒：${rule}。不对的话在通知页的忽略规则里删掉。` });
    expect(heard).toEqual([]); // The acknowledgement waits with other later notifications.
    react(n.id + "_card");
    await handleNegativeNotification(app, n.id);
    expect(askModel).toHaveBeenCalledOnce();
    expect(listNotifications(app)).toHaveLength(2);
  } finally { stop(); }
});

it("also finds a notification recorded only by pushed.messageId", async () => {
  const n = notify(app, { title: "项目 A 的进展" });
  markPushed(app, n.id, "lark", "pushed-card");
  react("pushed-card");
  await vi.waitFor(() => expect(notice(n.id).ignoreRule?.rule).toBe(rule));
  expect(askModel).toHaveBeenCalledOnce();
});

it("records a one-off without a rule or an acknowledgement and never asks the model twice", async () => {
  vi.mocked(askModel).mockResolvedValue('{"rule":""}');
  const n = card();
  react(n.id + "_card");
  await vi.waitFor(() => expect(notice(n.id).negativeHandledAt).toBeTruthy());
  react(n.id + "_card");
  await handleNegativeNotification(app, n.id);
  expect(notice(n.id).ignoreRule).toBeNull();
  expect(askModel).toHaveBeenCalledOnce();
  expect(listIgnoreRules(app)).toEqual([]);
  expect(listNotifications(app)).toHaveLength(1);
});

it.each(["urgent", "off", "member", "guest", "positive", "deleted", "other-user"])("leaves %s notifications/reactions alone", async (reason) => {
  if (reason === "off") app.config.notify.learnFromReactions = false;
  const n = card(reason === "urgent" ? "urgent" : "normal", reason === "other-user" ? "member" : "owner");
  react(n.id + "_card", reason === "member" || reason === "guest" ? reason : "owner", reason === "deleted" ? "deleted" : "created", reason === "positive" ? "THUMBSUP" : "THUMBSDOWN");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(askModel).not.toHaveBeenCalled();
  expect(listIgnoreRules(app)).toEqual([]);
  expect(one<{ context: string }>(app.db, "select context from notifications where id = ?", n.id)?.context).not.toContain("negativeHandledAt");
  expect(one<{ n: number }>(app.db, "select count(*) n from notifications")?.n).toBe(1);
});

it("an explicit ignore and a later negative reaction share the same per-notification lesson", async () => {
  app.config.lark.ownerOpenId = "ou_owner";
  const item = upsertItem(app, undefined, { spaceId: "personal", kind: "watch", title: "项目 A 进展" }, "agent");
  const n = notify(app, { title: "项目 A 今天的进展", entityId: item.id });
  const newer = notify(app, { title: "项目 A 明天的安排", entityId: item.id });
  run(app.db, "update notifications set at = ? where id = ?", new Date(Date.now() + 1000).toISOString(), newer.id);
  setNotificationCard(app, n.id, n.id + "_card");
  recordInteraction(app, { messageId: n.id + "_card", chatId: "oc_owner", conversationId: null, runId: null, purpose: "agent", allowed: ["ou_owner"], payload: { itemId: item.id, notificationId: n.id } });
  const clicked = await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: n.id + "_card" }, action: { value: { action: `item:cancel:${item.id}` } } });
  expect(clicked.toast.type).toBe("success");
  await vi.waitFor(() => expect(notice(n.id).ignoreRule?.rule).toBe(rule));
  expect(notice(newer.id).ignoreRule).toBeUndefined();
  react(n.id + "_card");
  await handleNegativeNotification(app, n.id);
  expect(askModel).toHaveBeenCalledOnce();
  expect(listIgnoreRules(app)).toHaveLength(1);
  expect(listNotifications(app)).toHaveLength(2);
});
