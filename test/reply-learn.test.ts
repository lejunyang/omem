import { describe, expect, it } from "vitest";
import "../src/channels/lark-mentions.ts";
import { run } from "../src/core/db.ts";
import { mentionChannel, type MentionMessage } from "../src/mentions/channel.ts";
import { habitLine, noteAsk, noteDecision, noteDraft, noteHandling, replyHabits, replyStats, settleSamples, typicalReplyLength } from "../src/mentions/reply-learn.ts";
import { testApp } from "./helpers.ts";

const HOUR = 3600_000;
const msg = (id: string, sender: string, senderId: string, text: string, atMs: number): MentionMessage => ({ id, sender, senderId, atMs, text, topicId: null, quoted: null, sourceId: null, ref: null });
const chat = (id: string, name: string, kind: "p2p" | "group") => ({ chatId: id, chatName: name, chatKind: kind, topicId: null });
/** The owner's own message in a chat, as capture stores it. */
function ownerSays(app: ReturnType<typeof testApp>, chatId: string, id: string, text: string, atMs: number, parent: string | null = null) {
  run(app.db, "insert into lark_messages(message_id, chat_id, parent_id, sender_id, sender_name, sender_kind, msg_type, content, create_ms) values(?,?,?,?,?,?,?,?,?)", id, chatId, parent, "ou_me", "本人", "owner", "text", text, atMs);
}

describe("learning how the owner answers people who look for them", () => {
  it("keeps what became of each draft and what the owner wrote themselves, and shows the nearest to the handler", () => {
    const app = testApp();
    const lark = mentionChannel("lark");
    const t0 = Date.now() - 30 * HOUR;

    // 小王, private chat: a draft the owner refused as too wordy, then answered in a few words.
    noteAsk(app, "m1", lark, chat("oc_wang", "小王", "p2p"), [msg("om_1", "小王", "ou_wang", "退款口径是按发货行算还是整单？", t0)]);
    noteHandling(app, "m1", "h1", "问退款口径");
    noteDraft(app, "h1", "你好小王，关于你问的退款口径问题，我查了一下相关文档和历史记录，目前的规则是按已发货行计算，未发货的部分直接取消。如果还有其他问题可以随时找我。");
    noteDecision(app, "h1", "dropped", null, "verbose");
    ownerSays(app, "oc_wang", "om_r1", "按发货行", t0 + 600_000);

    // 小李 in a group: nothing drafted, the owner never answered.
    noteAsk(app, "m2", lark, chat("oc_group", "项目 A 群", "group"), [msg("om_2", "小李", "ou_li", "@本人 周会改到周四了", t0)]);
    // 小王 again: a draft sent after the owner shortened it.
    noteAsk(app, "m3", lark, chat("oc_wang", "小王", "p2p"), [msg("om_3", "小王", "ou_wang", "灰度什么时候开始？", t0 + HOUR)]);
    noteHandling(app, "m3", "h3", "问灰度时间");
    noteDraft(app, "h3", "灰度计划在 12 月 8 日开始，先放 5% 流量观察三天。");
    noteDecision(app, "h3", "edited", "12-08 开始，先 5%", null);

    settleSamples(app);
    const stats = replyStats(app);
    expect(stats).toMatchObject({ samples: 3, drafts: 2, edited: 1, dropped: 1, ownReplies: 1, noReply: 1, reasons: { verbose: 1 } });

    // For the triage: this person, this group.
    expect(habitLine(app, { askerId: "ou_wang", askerName: "小王", chatId: "oc_wang", chatKind: "p2p" })).toMatch(/小王 近 60 天找过本人 2 次：本人自己回了 1 次.*发了 1 次、没发 1 次/);
    expect(habitLine(app, { askerId: "ou_li", askerName: "小李", chatId: "oc_group", chatKind: "group" })).toMatch(/这个群里近 60 天找过本人 1 次：本人自己回了 0 次，没回 1 次/);

    // For the handler: the same person's cases first, with what the owner said instead.
    const habits = replyHabits(app, { askerId: "ou_wang", chatId: "oc_wang" });
    expect(habits).toContain("照发 0、改后发 1、没发 1（太啰嗦 1）");
    expect(habits).toMatch(/本人没发（太啰嗦），本人自己回：「按发货行」/);
    expect(habits).toMatch(/本人改成「12-08 开始，先 5%」才发/);
    expect(habits).toMatch(/小李（项目 A 群）.*本人没回/);
    // Too few of the owner's own replies to say how long they usually are.
    expect(typicalReplyLength(app)).toBe(0);
  });

  it("does not take what omem sent for the owner as the owner's own words, and waits a day before saying they did not reply", () => {
    const app = testApp();
    const lark = mentionChannel("lark");
    const now = Date.now();
    noteAsk(app, "m1", lark, chat("oc_wang", "小王", "p2p"), [msg("om_1", "小王", "ou_wang", "在吗", now - HOUR)]);
    noteHandling(app, "m1", "h1", "");
    noteDraft(app, "h1", "在，什么事？");
    noteDecision(app, "h1", "sent", "在，什么事？", null);
    // The sent draft shows up in the chat as the owner's message, with the signature.
    ownerSays(app, "oc_wang", "om_s", `在，什么事？\n\n${app.config.lark.commands.signature}`, now - HOUR + 60_000);
    noteAsk(app, "m2", lark, chat("oc_zhang", "小张", "p2p"), [msg("om_2", "小张", "ou_zhang", "收到请回复", now - HOUR)]);
    settleSamples(app);
    expect(replyStats(app)).toMatchObject({ samples: 2, sent: 1, ownReplies: 0, noReply: 0 });
    // Still inside the day: not yet “did not reply”.
    expect(replyHabits(app, { askerId: "ou_zhang", chatId: "oc_zhang" })).not.toContain("本人没回");
  });
});
