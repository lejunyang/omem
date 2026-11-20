import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import "../src/channels/lark-mentions.ts";
import { answerAsk, getAsk } from "../src/agents/asks.ts";
import { askModel } from "../src/agents/oneshot.ts";
import { createRun, setRunOutput } from "../src/agents/runs.ts";
import { onLarkReaction, recordLarkSent } from "../src/channels/lark-feedback.ts";
import { loadConfig } from "../src/core/config.ts";
import { all, one, run } from "../src/core/db.ts";
import { listNotifications, notify, setNotificationCard } from "../src/core/notify.ts";
import { handleNegativeNotification } from "../src/core/notify-reactions.ts";
import { listIgnoreRules } from "../src/core/notify-lessons.ts";
import { mentionChannel, type MentionMessage } from "../src/mentions/channel.ts";
import { noteAsk, noteDecision, noteDraft, noteHandling } from "../src/mentions/reply-learn.ts";
import { draftStreak, suggestReplyPromotion } from "../src/mentions/reply-ladder.ts";
import { testApp } from "./helpers.ts";

vi.mock("../src/agents/oneshot.ts", async (original) => ({ ...await original<typeof import("../src/agents/oneshot.ts")>(), askModel: vi.fn() }));

let app: ReturnType<typeof testApp>;
beforeEach(() => { app = testApp(); vi.mocked(askModel).mockReset().mockResolvedValue(JSON.stringify({ rule: "项目 A 群的日常播报不再提醒" })); });
afterEach(() => { app.db.close(); rmSync(app.home, { recursive: true, force: true }); });

const msg = (id: string, text: string): MentionMessage => ({ id, sender: "小王", senderId: "ou_wang", atMs: Date.now(), text, topicId: null, quoted: null, sourceId: null, ref: null });
let seq = 0;
/** One draft for this kind of chat and what the owner did with it, `minutesAgo` ago. */
function drafted(kind: "p2p" | "group", decision: "sent" | "edited" | "dropped", minutesAgo: number) {
  const n = ++seq;
  const chat = kind === "p2p" ? { chatId: "oc_wang", chatName: "小王", chatKind: kind, topicId: null } : { chatId: "oc_a", chatName: "项目 A 群", chatKind: kind, topicId: null };
  noteAsk(app, `m${n}`, mentionChannel("lark"), chat, [msg(`om_${n}`, "灰度什么时候开始？")]);
  noteHandling(app, `m${n}`, `h${n}`, "问灰度时间");
  noteDraft(app, `h${n}`, "12-08 开始，先 5%");
  noteDecision(app, `h${n}`, decision, decision === "dropped" ? null : decision === "sent" ? "12-08 开始，先 5%" : "下周一", decision === "dropped" ? "no-need" : null);
  run(app.db, "update reply_samples set decided_at = ? where handle_run = ?", new Date(Date.now() - minutesAgo * 60_000).toISOString(), `h${n}`);
}
const mode = (kind: "p2p" | "group") => app.config.mentions.reply.lark[kind];

it("counts the drafts sent as they were, per kind of chat, back to the first one changed or not sent", () => {
  drafted("p2p", "sent", 50);
  drafted("p2p", "edited", 40);
  drafted("p2p", "sent", 30);
  drafted("group", "dropped", 25);
  drafted("p2p", "sent", 20);
  drafted("group", "sent", 10);
  expect(draftStreak(app, "lark", "p2p")).toBe(2);
  expect(draftStreak(app, "lark", "group")).toBe(1);
});

it("asks once, after enough drafts in a row sent unchanged, whether such replies may go out by themselves; only the owner's yes changes the setting", async () => {
  app.config.mentions.reply.lark.p2p = "draft";
  app.config.mentions.reply.promoteAfter = 3;
  drafted("p2p", "sent", 30);
  drafted("p2p", "sent", 20);
  expect(suggestReplyPromotion(app, "lark", "p2p")).toBeNull();
  drafted("p2p", "sent", 10);
  // Group chats have their own count and their own setting.
  expect(suggestReplyPromotion(app, "lark", "group")).toBeNull();
  const q = suggestReplyPromotion(app, "lark", "p2p")!;
  // The question reaches the owner as a notification (no chat to put it in) a moment later.
  await vi.waitFor(() => expect(listNotifications(app).map((n) => n.title)).toContain("有问题等你回答"));
  expect(q.question).toContain("最近 3 次给私聊里找你的人拟的回复，你都原样发了");
  expect(q.options.map((o) => o.label)).toEqual(["直接发，发完告诉我", "继续先给我看"]);
  // Not asked again within the month.
  expect(suggestReplyPromotion(app, "lark", "p2p")).toBeNull();
  await answerAsk(app, q.id, { choice: 0, by: "owner" });
  expect(mode("p2p")).toBe("auto");
  expect(mode("group")).toBe("off");
  // Saved, not only in memory; and on record.
  expect(loadConfig(app.home).mentions.reply.lark.p2p).toBe("auto");
  expect(getAsk(app, q.id).result).toContain("设置 → 代你回复 → 有人找你");
  expect(one<{ n: number }>(app.db, "select count(*) n from audit_events where action = 'mention-reply.promote'")?.n).toBe(1);
});

it("leaves the setting alone on a no, when asking is turned off, and when replies are not on drafts", async () => {
  app.config.mentions.reply.lark.group = "draft";
  app.config.mentions.reply.promoteAfter = 2;
  drafted("group", "sent", 20);
  drafted("group", "sent", 10);
  app.config.mentions.reply.promoteAfter = 0;
  expect(suggestReplyPromotion(app, "lark", "group")).toBeNull();
  app.config.mentions.reply.promoteAfter = 2;
  app.config.mentions.reply.lark.group = "off";
  expect(suggestReplyPromotion(app, "lark", "group")).toBeNull();
  app.config.mentions.reply.lark.group = "draft";
  const q = suggestReplyPromotion(app, "lark", "group")!;
  // The question reaches the owner as a notification (no chat to put it in) a moment later.
  await vi.waitFor(() => expect(listNotifications(app).map((n) => n.title)).toContain("有问题等你回答"));
  await answerAsk(app, q.id, { choice: 1, by: "owner" });
  expect(mode("group")).toBe("draft");
});

/** A handling that answered its asker (by itself or from the owner's click), and the reminder that told the owner. */
function reminded(by: "auto" | "owner") {
  const r = createRun(app, { kind: "agent", title: "小王在私聊里找你", input: { mention: { channel: "lark", from: "m0", chatId: "oc_wang", chatName: "小王", chatKind: "p2p", topicId: null, messageIds: ["om_1"], lastMessageId: "om_1", senderId: "ou_wang", senderName: "小王", refs: [], reply: by === "auto" ? "auto" : "draft", what: "问灰度时间", urgency: "normal" } } });
  setRunOutput(app, r.id, { mentionReply: { via: "group", by, at: new Date().toISOString(), messageId: "om_reply", chatId: "oc_three", where: "你、小王和机器人的群" } });
  const n = notify(app, { title: "小王问灰度时间", body: "12-08 开始。\n（已替你回复对方：你、小王和机器人的群）", runId: r.id });
  setNotificationCard(app, n.id, `${n.id}_card`);
  recordLarkSent(app, { messageId: `${n.id}_card`, purpose: "notification", bot: "main" });
  return n;
}
const dislike = (n: { id: string }) => onLarkReaction(app, "main", { message_id: `${n.id}_card`, reaction_type: { emoji_type: "THUMBSDOWN" }, operator_type: "user", user_id: { open_id: "ou_owner" } }, "created", () => "owner");

it("goes back to drafts at once when the owner dislikes a reminder of a reply sent by itself, without drawing an ignore rule from it", async () => {
  app.config.mentions.reply.lark.p2p = "auto";
  app.config.mentions.reply.promoteAfter = 2;
  drafted("p2p", "sent", 30);
  drafted("p2p", "sent", 20);
  const n = reminded("auto");
  dislike(n);
  await handleNegativeNotification(app, n.id);
  expect(mode("p2p")).toBe("draft");
  expect(loadConfig(app.home).mentions.reply.lark.p2p).toBe("draft");
  const told = listNotifications(app).filter((x) => x.id !== n.id);
  expect(told).toHaveLength(1);
  expect(told[0]).toMatchObject({ title: "替你回复改回先给你看草稿", urgency: "later" });
  expect(told[0].body).toContain("你对替你回复 小王 的那条表示了不满意");
  expect(vi.mocked(askModel)).not.toHaveBeenCalled();
  expect(listIgnoreRules(app)).toHaveLength(0);
  expect(all(app.db, "select 1 from audit_events where action = 'mention-reply.demote'")).toHaveLength(1);
  // The count starts again: the earlier unchanged drafts no longer lead to the question.
  expect(draftStreak(app, "lark", "p2p")).toBe(0);
  expect(suggestReplyPromotion(app, "lark", "p2p")).toBeNull();
  // The same reaction delivered again changes nothing more.
  app.config.mentions.reply.lark.p2p = "auto";
  dislike(n);
  await handleNegativeNotification(app, n.id);
  expect(mode("p2p")).toBe("auto");
});

it("treats a disliked reminder as before when the reply was the owner's own click", async () => {
  app.config.mentions.reply.lark.p2p = "auto";
  const n = reminded("owner");
  dislike(n);
  await handleNegativeNotification(app, n.id);
  expect(mode("p2p")).toBe("auto");
  expect(listIgnoreRules(app)).toHaveLength(1);
});
