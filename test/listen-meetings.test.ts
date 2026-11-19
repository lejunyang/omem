import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { threadMessages, updateThread } from "../src/agents/threads.ts";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { groupMeetingStarted, meetingEnded, ownerJoinedMeeting, resetMeetingsForTests, setMeetingConsumerForTests, tickMeetings } from "../src/channels/lark-meetings.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { casesText, nearCases, playbookPath } from "../src/channels/listen-cases.ts";
import { ownerMeetingsWanted } from "../src/channels/listen-meetings.ts";
import { DEFAULT_CONTEXT_ID, getContext, saveContext } from "../src/channels/listen.ts";
import { correctionsSinceBrief } from "../src/channels/watch-trial.ts";
import { resetMeetingAnswersForTests } from "../src/channels/meeting-answers.ts";
import { all, one, run } from "../src/core/db.ts";
import { saveRule } from "../src/rules/store.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  setLarkClient(null);
  setLarkCliForTests(null);
  setMeetingConsumerForTests(null);
  resetMeetingsForTests();
  resetMeetingAnswersForTests();
  for (const app of apps.splice(0)) {
    app.db.close();
    rmSync(app.home, { recursive: true, force: true });
  }
});

const at = (min: number) => String(Date.parse("2026-10-28T02:00:00Z") + min * 60_000);
/** The group's `video_chat` message, as the bot receives it. */
const started = (no: string, topic: string) => JSON.stringify({ topic, meet_number: no, start_time: String(Date.now() - 30_000), end_time: null });
const group = (no: string, topic = "小王的视频会议") => ({ chatId: "oc_team", chatName: "项目 A 群", raw: started(no, topic), senderName: "小王", byOwner: false });
const BRIEF = { handle: ["线上报错和回滚"], skip: ["闲聊"], valid: "有日志依据", at: new Date().toISOString(), confirmedAt: new Date().toISOString() };

/** A fake Feishu: the main bot (cards, cards only the owner sees, joins, the meeting's events) and the owner's lark-cli. */
function setup() {
  const app = testApp();
  apps.push(app);
  app.config.lark.enabled = true;
  app.config.lark.appId = "cli_main";
  app.config.lark.ownerOpenId = "ou_owner";
  const calls: { method: string; url: string; data?: any; params?: any }[] = [];
  const cards: any[] = [];
  const botEvents: any[][] = [];
  setLarkClient(
    {
      request: async (o: any) => {
        calls.push(o);
        if (o.url === "/open-apis/ephemeral/v1/send") return { code: 0, data: { message_id: `om_eph${calls.length}` } };
        if (o.url.endsWith("/meetings/list_by_no")) return { code: 0, data: { meeting_briefs: [{ id: `m-${o.params.meeting_no}`, meeting_no: o.params.meeting_no }] } };
        if (o.url.endsWith("/bots/events")) return { code: 0, data: { events: botEvents.shift() ?? [], page_token: `p${calls.length}`, has_more: false } };
        return { code: 0, data: {} };
      },
      im: {
        message: { create: async (p: any) => (cards.push(p), { code: 0, data: { message_id: `om_card${cards.length}` } }) },
        // The owner is in the group the meetings start in.
        chatMembers: { get: async (p: any) => ({ code: 0, data: { items: p.path.chat_id === "oc_team" ? [{ member_id: "ou_owner" }] : [], has_more: false } }) },
      },
    },
    "ou_bot",
    "小助理",
  );
  setLarkCliForTests(async () => ({ ok: true, data: {} }));
  const ephemeral = () => calls.filter((c) => c.url === "/open-apis/ephemeral/v1/send");
  const joins = () => calls.filter((c) => c.url.endsWith("/bots/join"));
  const asked = () => all<{ message_id: string; payload: string }>(app.db, "select message_id, payload from card_interactions where purpose = 'listen-meeting' order by rowid");
  const click = (messageId: string, action: string) => handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: messageId }, action: { tag: "button", value: { action } } });
  const cases = (contextId: string) => all<{ decision: string; reason: string | null; ask: string; source: string; chat_kind: string }>(app.db, "select decision, reason, ask, source, chat_kind from reply_samples where context_id = ? order by rowid", contextId);
  return { app, calls, cards, botEvents, ephemeral, joins, asked, click, cases };
}

describe("meetings in 「关注」", () => {
  it("asks on a card only the owner sees; 进会旁听 joins and listens with the 关注's brief, and its notes stay with the 关注", async () => {
    const t = setup();
    const c = saveContext(t.app, { kind: "place", name: "值班群", chats: ["oc_team"], note: "线上问题帮我盯着", brief: BRIEF, knobs: { reply: "none" } });
    // What the 关注 has learned and what its groups are talking about go to the listening agent too.
    run(t.app.db, "insert into sources(id, space_id, kind, uri, title, text, hash, captured_at, updated_at) values('s_pb','personal','note',?,'经验','## 回滚 回滚前先确认值班人','h','2026-11-19','2026-11-19')", `work/${playbookPath(c)}`);
    updateThread(t.app, c.conversationId!, { summary: "在聊的话题：支付超时排查" });

    expect(await groupMeetingStarted(t.app, "main", group("481516234"))).toBe("交给关注判断");
    expect(t.joins()).toHaveLength(0);
    // Ephemeral in the group (the owner is in it), nothing in the private chat.
    expect(t.ephemeral()).toHaveLength(1);
    expect(t.ephemeral()[0].data).toMatchObject({ chat_id: "oc_team", open_id: "ou_owner" });
    const card = JSON.stringify(t.ephemeral()[0].data.card);
    expect(card).toContain("「项目 A 群」在开会，要我进去听吗");
    expect(card).toContain("进会旁听");
    expect(card).toContain("这个会以后不用问");
    expect(t.cards).toHaveLength(0);
    expect(JSON.parse(t.asked()[0].payload)).toEqual({ meetingId: "m-481516234", contextId: c.id });

    const r = await t.click(t.asked()[0].message_id, "join");
    expect(JSON.stringify(r.card)).toContain("已把 小助理 拉进会议");
    expect(t.joins()[0]).toMatchObject({ data: { join_identify: { meeting_no: "481516234" } } });
    const row = one<{ status: string; plan: string; context_id: string }>(t.app.db, "select status, plan, context_id from lark_meetings where meeting_id = 'm-481516234'")!;
    expect(row).toMatchObject({ status: "listening", context_id: c.id });
    expect(JSON.parse(row.plan)).toMatchObject({ contextId: c.id, ruleName: "关注「值班群」", bots: ["main"], record: true, spec: "assistant" });
    expect(t.cases(c.id)).toEqual([expect.objectContaining({ decision: "sent", source: "meeting", chat_kind: "meeting", ask: "会议「小王的视频会议」，在群「项目 A 群」" })]);
    expect(threadMessages(t.app, c.conversationId!).some((m) => m.text.includes("本人让我进会旁听会议「小王的视频会议」"))).toBe(true);

    // The listening agent's window: the 关注's name, note, brief, lessons and conversation; its notes go back to the 关注.
    t.botEvents.push([{ event_id: "e1", activity_event_type: "transcript_received", event_time: at(1), transcript_received_items: [{ sentence_id: "s1", text: "今晚八点回滚支付服务", speaker: { id: "ou_a", name: "小李" }, start_time: at(1) }] }]);
    await tickMeetings(t.app);
    const window = all<{ input: string }>(t.app.db, "select input from runs where lane = 'meeting:m-481516234' order by rowid");
    expect(window).toHaveLength(1);
    const input = JSON.parse(window[0].input);
    expect(input).toMatchObject({ meetingWindow: true, listenMeeting: { contextId: c.id, meetingId: "m-481516234", topic: "小王的视频会议" } });
    for (const part of ["旁听会议（关注「值班群」）", "你在替本人关注「值班群」", "本人要这个关注做的：线上问题帮我盯着", "线上报错和回滚", "回滚前先确认值班人", "支付超时排查", "今晚八点回滚支付服务", "本人不在会上"]) expect(input.task).toContain(part);

    // Once over: the summary is for the owner, who was not there, and goes to the 关注 as well.
    await meetingEnded(t.app, "m-481516234", "会议结束");
    const final = JSON.parse(all<{ input: string }>(t.app.db, "select input from runs where lane = 'meeting:m-481516234' order by rowid").at(-1)!.input);
    expect(final.listenMeeting).toEqual({ contextId: c.id, meetingId: "m-481516234", topic: "小王的视频会议", final: true });
    expect(final.task).toContain("本人不在这场会上");
  });

  it("“这个会以后不用问” keeps that topic out of later asks; “这次不用” only this once; neither counts against replies", async () => {
    const t = setup();
    const c = saveContext(t.app, { kind: "place", name: "值班群", chats: ["oc_team"], brief: BRIEF, knobs: { reply: "draft" } });
    await groupMeetingStarted(t.app, "main", group("111111111", "周会"));
    expect(JSON.stringify((await t.click(t.asked()[0].message_id, "never")).card)).toContain("这个会以后不用问");
    expect(getContext(t.app, c.id)!.knobs.meetingSkip).toEqual(["周会"]);
    // The same topic again (another number): not asked. Another topic is.
    expect(await groupMeetingStarted(t.app, "main", group("222222222", "周会"))).toBe("交给关注判断");
    expect(t.asked()).toHaveLength(1);
    await groupMeetingStarted(t.app, "main", group("333333333", "复盘会"));
    expect(t.asked()).toHaveLength(2);
    await t.click(t.asked()[1].message_id, "skip");
    expect(t.joins()).toHaveLength(0);
    expect(t.cases(c.id).map((x) => [x.decision, x.reason])).toEqual([["dropped", "never"], ["dropped", "not-this-time"]]);
    // Meeting decisions are cases of the 关注, but not draft corrections, and not near cases for a message.
    expect(correctionsSinceBrief(t.app, getContext(t.app, c.id)!)).toBe(0);
    expect(nearCases(t.app, { contextId: c.id, text: "复盘会" })).toHaveLength(0);
    const rows = all<any>(t.app.db, "select * from reply_samples where context_id = ? order by rowid", c.id);
    expect(casesText(rows)).toContain("会议「周会」，在群「项目 A 群」（小王 发起）：本人说这个会以后不用问");
    expect(casesText(rows)).toContain("本人说这次不用旁听");
  });

  it("leaves a meeting a rule took alone, and asks about one meeting once whichever 关注 care", async () => {
    const t = setup();
    const place = saveContext(t.app, { kind: "place", name: "值班群", chats: ["oc_team"] });
    const item = saveContext(t.app, { kind: "item", name: "支付改造", itemId: "i_pay", chats: ["oc_team"] });
    // A rule that brings the bot into the group's meetings: it acts, no 关注 asks.
    const rule = saveRule(t.app, { name: "群里开会", description: "群里开会就拉机器人", enabled: true, trigger: { event: "meeting", meetingFrom: "group" }, conditions: { field: "meeting.title", op: "contains", value: "评审" }, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"], confirm: false, record: false }] });
    expect(await groupMeetingStarted(t.app, "main", group("444444444", "方案评审"))).toBe("交给规则判断");
    expect(t.joins()).toHaveLength(1);
    expect(t.asked()).toHaveLength(0);
    expect(one<{ context_id: string | null }>(t.app.db, "select context_id from lark_meetings where meeting_id = 'm-444444444'")!.context_id).toBeNull();
    // A rule that asks on its own card took it too.
    saveRule(t.app, { ...rule, temporary: undefined, conditions: { field: "meeting.title", op: "contains", value: "需求" }, actions: [{ type: "meeting-bot", bots: ["main"], confirm: true }] });
    await groupMeetingStarted(t.app, "main", group("555555555", "需求评审"));
    expect(one<{ purpose: string }>(t.app.db, "select purpose from card_interactions order by rowid desc limit 1")!.purpose).toBe("meeting-join");
    expect(t.asked()).toHaveLength(0);

    // No rule: the item (the most specific) asks, once.
    await groupMeetingStarted(t.app, "main", group("666666666", "临时同步"));
    expect(t.asked().map((a) => JSON.parse(a.payload).contextId)).toEqual([item.id]);
    expect(JSON.stringify(t.ephemeral().at(-1)!.data.card)).toContain("支付改造");
    // The owner joins it: the default 关注 cares too, but the meeting was asked about already.
    await ownerJoinedMeeting(t.app, { id: "m-666666666", no: "666666666", topic: "临时同步" });
    expect(t.asked()).toHaveLength(1);
    expect(t.cases(place.id)).toHaveLength(0);
  });

  it("goes straight in with meetings: listen, and does nothing with meetings: off", async () => {
    const t = setup();
    const c = saveContext(t.app, { kind: "place", name: "值班群", chats: ["oc_team"], knobs: { meetings: "off" } });
    expect(await groupMeetingStarted(t.app, "main", group("777777777"))).toBe("没有看群里会议的规则");
    expect(all(t.app.db, "select 1 from lark_meetings")).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
    saveContext(t.app, { id: c.id, kind: "place", knobs: { meetings: "listen" } });
    await groupMeetingStarted(t.app, "main", group("888888888"));
    expect(t.asked()).toHaveLength(0);
    expect(t.joins()).toHaveLength(1);
    expect(one<{ status: string }>(t.app.db, "select status from lark_meetings where meeting_id = 'm-888888888'")!.status).toBe("listening");
    expect(t.cases(c.id).map((x) => x.decision)).toEqual(["auto"]);
  });

  it("asks about a meeting the owner joins through the default 关注, in their private chat", async () => {
    const t = setup();
    expect(ownerMeetingsWanted(t.app)).toBe(true);
    // Without a meeting rule the owner's meeting events are listened to for it.
    let consumers = 0;
    setMeetingConsumerForTests(() => (consumers++, { stop() {} }));
    await tickMeetings(t.app);
    expect(consumers).toBeGreaterThan(0);

    await ownerJoinedMeeting(t.app, { id: "m-own", no: "123123123", topic: "需求对齐" });
    expect(t.ephemeral()).toHaveLength(0);
    expect(t.cards).toHaveLength(1);
    expect(t.cards[0].data.receive_id).toBe("ou_owner");
    expect(t.cards[0].data.content).toContain("会议「需求对齐」，要我进去旁听吗");
    expect(JSON.parse(t.asked()[0].payload)).toEqual({ meetingId: "m-own", contextId: DEFAULT_CONTEXT_ID });
    // Polled again while in it: still one card.
    await ownerJoinedMeeting(t.app, { id: "m-own", no: "123123123", topic: "需求对齐" });
    expect(t.cards).toHaveLength(1);
    await t.click(t.asked()[0].message_id, "join");
    expect(t.joins()).toHaveLength(1);
    expect(t.cases(DEFAULT_CONTEXT_ID)).toEqual([expect.objectContaining({ decision: "sent", ask: "会议「需求对齐」，本人加入的" })]);

    // The default 关注's meetings off: nothing for the owner's next meeting.
    saveContext(t.app, { id: DEFAULT_CONTEXT_ID, kind: "default", knobs: { meetings: "off" } });
    expect(ownerMeetingsWanted(t.app)).toBe(false);
    await ownerJoinedMeeting(t.app, { id: "m-own2", no: "321321321", topic: "周会" });
    expect(t.cards).toHaveLength(1);
  });
});
