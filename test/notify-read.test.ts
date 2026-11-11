import { describe, expect, it } from "vitest";
import { countsAsUnread, listNotifications, markPushed, markQuiet, notify, setNotificationCard } from "../src/core/notify.ts";
import { backfillPushed, markCardRead, syncNotificationReads } from "../src/channels/notify-read.ts";
import { recordInteraction } from "../src/channels/lark-send.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { run } from "../src/core/db.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { testApp } from "./helpers.ts";

const unreadOf = (app: ReturnType<typeof testApp>) => listNotifications(app, 50).filter((n) => n.unread).map((n) => n.title).sort();
const readAt = (app: ReturnType<typeof testApp>, id: string) => (app.db.prepare("select read_at from notifications where id = ?").get(id) as { read_at: string | null }).read_at;

describe("web notifications follow Feishu", () => {
  it("counts as unread only what reached the person nowhere else", () => {
    expect(countsAsUnread({ readAt: null })).toBe(true);
    expect(countsAsUnread({ readAt: "2026-11-11T00:00:00Z" })).toBe(false);
    expect(countsAsUnread({ readAt: null, pushed: { channel: "lark", at: "x" } })).toBe(false);
    expect(countsAsUnread({ readAt: null, larkMessageId: "om_1" })).toBe(false);
    expect(countsAsUnread({ readAt: null, quiet: "免提醒规则" })).toBe(false);
    expect(countsAsUnread({ readAt: null, urgency: "silent" })).toBe(false);
  });

  it("pushed, kept quiet and in-app-only ones leave the bell; the list still has them all", () => {
    const app = testApp();
    try {
      const pushed = notify(app, { title: "已推送" });
      const card = notify(app, { title: "发了卡片" });
      const quiet = notify(app, { title: "没推" });
      notify(app, { title: "只在应用内", urgency: "silent" });
      notify(app, { title: "没能推到" });
      markPushed(app, pushed.id, "lark", "om_a");
      setNotificationCard(app, card.id, "om_b", "main");
      markQuiet(app, quiet.id, "按免提醒规则没有推");
      expect(unreadOf(app)).toEqual(["没能推到"]);
      const list = listNotifications(app, 50);
      expect(list).toHaveLength(5);
      expect(list.find((n) => n.id === card.id)?.pushed).toMatchObject({ channel: "lark", messageId: "om_b" });
    } finally { app.db.close(); }
  });

  it("read in Feishu: a reply quoting the card, a reaction on it, a click on its buttons", async () => {
    const app = testApp();
    try {
      const replied = notify(app, { title: "回复过" });
      const reacted = notify(app, { title: "点过表情" });
      const clicked = notify(app, { title: "点了按钮" });
      const untouched = notify(app, { title: "没动" });
      markPushed(app, replied.id, "lark", "om_r");
      markPushed(app, reacted.id, "lark", "om_e");
      markPushed(app, clicked.id, "lark", "om_c");
      markPushed(app, untouched.id, "lark", "om_u");
      const t = createThread(app, { spaceId: "personal", channel: "lark", userId: "owner" });
      addMessage(app, t.id, "user", "这个我看过了", null, { quote: { messageId: "om_r" } });
      run(app.db, "insert into feedback(id,message_id,actor_id,actor_kind,emoji,polarity,at) values('f1','om_e','ou_owner','owner','DONE','ack',?)", new Date().toISOString());
      // lark is off in tests: read state is not asked for, nothing is guessed.
      expect(await syncNotificationReads(app)).toBe(2);
      expect(readAt(app, replied.id)).toBeTruthy();
      expect(readAt(app, reacted.id)).toBeTruthy();
      expect(markCardRead(app, "om_c")).toBe(1);
      expect(readAt(app, clicked.id)).toBeTruthy();
      expect(readAt(app, untouched.id)).toBeNull();
    } finally { app.db.close(); }
  });

  it("read state of the cards comes in one batch, not a request per notification", async () => {
    const app = testApp();
    const calls: string[][] = [];
    try {
      app.config.lark.enabled = true;
      setLarkCliForTests(async (args: string[]) => {
        calls.push(args);
        return { data: { items: [{ message_id: "om_1", is_read: true }, { message_id: "om_2", is_read: false }] } };
      });
      const a = notify(app, { title: "读过" });
      const b = notify(app, { title: "没读" });
      const c = notify(app, { title: "也没读" });
      markPushed(app, a.id, "lark", "om_1");
      markPushed(app, b.id, "lark", "om_2");
      markPushed(app, c.id, "lark", "om_3");
      expect(await syncNotificationReads(app)).toBe(1);
      expect(readAt(app, a.id)).toBeTruthy();
      expect(readAt(app, b.id)).toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0].join(" ")).toContain("+messages-read-status");
    } finally {
      setLarkCliForTests(null);
      app.db.close();
    }
  });

  it("once after the upgrade, notifications pushed before this was recorded count as pushed", () => {
    const app = testApp();
    try {
      const withCard = notify(app, { title: "有卡片 id 的" });
      const itemCard = notify(app, { title: "事项卡片" });
      notify(app, { title: "从没推过" });
      run(app.db, "update notifications set context = json_set(context, '$.larkMessageId', 'om_old') where id = ?", withCard.id);
      recordInteraction(app, { messageId: "om_item", chatId: null, conversationId: null, runId: null, purpose: "agent", allowed: [], payload: { itemId: "i1", notificationId: itemCard.id, userId: "owner" } });
      expect(backfillPushed(app)).toBe(2);
      expect(unreadOf(app)).toEqual(["从没推过"]);
      // Only once.
      run(app.db, "update notifications set context = json_remove(context, '$.pushed') where id = ?", itemCard.id);
      expect(backfillPushed(app)).toBe(0);
    } finally { app.db.close(); }
  });
});
