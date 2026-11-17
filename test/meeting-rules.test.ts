import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { botInvitedToMeeting, meetingEnded, ownerJoinedMeeting, resetMeetingsForTests, setMeetingConsumerForTests, tickMeetings } from "../src/channels/lark-meetings.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { resetMeetingAnswersForTests, settleMeetingAnswersForTests } from "../src/channels/meeting-answers.ts";
import { all, one, run } from "../src/core/db.ts";
import { addNotificationSink, listNotifications, notify, releaseLater } from "../src/core/notify.ts";
import { evaluate, eventReader } from "../src/rules/conditions.ts";
import { listFirings, saveRule, getRule } from "../src/rules/store.ts";
import { testRule } from "../src/rules/engine.ts";
import { meetingConfirmation } from "../src/rules/meeting.ts";
import type { Condition, RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";
import { createThread } from "../src/agents/threads.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  setLarkClient(null);
  setLarkCliForTests(null);
  setMeetingConsumerForTests(null);
  resetMeetingsForTests();
  resetMeetingAnswersForTests();
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});

const at = (min: number) => String(Date.parse("2026-10-28T02:00:00Z") + min * 60_000);
const joined = (id: string, people: [string, string][]) => ({ event_id: id, event_type: "participant_joined", event_time: at(0), payload: { participant_joined_items: people.map(([pid, name]) => ({ participant: { id: pid, name } })) } });
const confirmAt30: Condition = { field: "meeting.participantCount", op: "gte", value: "30" };

/** A fake Feishu: the main bot's API calls and cards, and the owner's lark-cli. */
function setup() {
  const app = testApp();
  apps.push(app);
  app.config.lark.appId = "cli_main";
  app.config.lark.ownerOpenId = "ou_owner";
  const calls: { method: string; url: string; data?: any; params?: any }[] = [];
  const cards: any[] = [];
  const botEvents: any[][] = [];
  setLarkClient(
    {
      request: async (o: any) => {
        calls.push(o);
        if (o.url.endsWith("/bots/events")) return { code: 0, data: { events: botEvents.shift() ?? [], page_token: `p${calls.length}`, has_more: false } };
        return { code: 0, data: {} };
      },
      im: { message: { create: async (p: any) => (cards.push(p), { code: 0, data: { message_id: `om_card${cards.length}` } }) } },
    },
    "ou_bot",
    "小助理",
  );
  // The owner's view of who is in the meeting (lark-cli, user identity).
  setLarkCliForTests(async (args) => {
    if (args[0] === "vc" && args[1] === "+meeting-events") return { ok: true, data: { events: [joined("e0", [["ou_owner", "我"], ["ou_a", "小王"], ["ou_b", "小李"]])], page_token: "u1" } };
    return { ok: true, data: {} };
  });
  return { app, calls, cards, botEvents };
}

describe("meeting rule conditions", () => {
  it("reads the meeting's title, number and participants; counts compare as numbers", async () => {
    const e: RuleEvent = { key: "meeting:m1", kind: "meeting", at: "", meeting: { id: "m1", no: "123456789", title: "方案评审", participants: ["我", "小王", "小李"] }, via: "test" };
    expect(await evaluate({ all: [{ field: "meeting.title", op: "contains", value: "评审" }, { field: "meeting.participantCount", op: "gte", value: "3" }] }, eventReader(e))).toBe(true);
    expect(await evaluate({ field: "meeting.participantCount", op: "lte", value: "2" }, eventReader(e))).toBe(false);
    expect(await evaluate({ field: "meeting.participants", op: "contains", value: "小王" }, eventReader(e))).toBe(true);
    expect(await evaluate({ not: { field: "meeting.participants", op: "in", value: ["小张"] } }, eventReader(e))).toBe(true);
    // A message has no meeting: meeting fields never match it.
    expect(await evaluate({ field: "meeting.participantCount", op: "gte", value: "0" }, eventReader({ key: "x", kind: "message", at: "", via: "test" }))).toBe(false);
  });

  it("checks what a meeting rule may use when it is saved", () => {
    const { app } = setup();
    const meeting = { event: "meeting" as const };
    expect(() => saveRule(app, { name: "a", description: "a", trigger: meeting, conditions: { field: "chat.name", op: "contains", value: "x" }, judge: "code", actions: [{ type: "notify" }] })).toThrow(/只能用会议的字段/);
    expect(() => saveRule(app, { name: "b", description: "b", conditions: { field: "chat.name", op: "contains", value: "x" }, judge: "code", actions: [{ type: "meeting-bot" }] })).toThrow(/只用于/);
    expect(() => saveRule(app, { name: "c", description: "c", trigger: meeting, conditions: null, judge: "code", actions: [{ type: "invite-bot" }] })).toThrow(/会议规则没有群和消息/);
    expect(() => saveRule(app, { name: "d", description: "d", trigger: meeting, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["nope"] }] })).toThrow(/没有这些飞书机器人/);
    // Every meeting, no conditions: allowed (the card asks first).
    expect(saveRule(app, { name: "e", description: "每场会议都问我", trigger: meeting, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"] }] }).actions[0]).toMatchObject({ type: "meeting-bot", confirm: true, record: true });
    for (const confirm of [{ field: "chat.name", op: "contains", value: "群" }, { all: [] }, { not: { any: [] } }]) {
      expect(() => saveRule(app, { name: "f", description: "错误确认条件", trigger: meeting, actions: [{ type: "meeting-bot", confirm: confirm as Condition }] })).toThrow(/确认条件/);
    }
  });
});

describe("meetings the owner joins", () => {
  it.each([29, 30, 31])("uses a single rule to ask at 30 participants or more (%i people), with the same preview", async (count) => {
    const { app, calls, cards } = setup();
    const rule = saveRule(app, { name: "按人数确认", description: "入会时 30 人及以上先问，否则直接拉机器人", enabled: true, trigger: { event: "meeting" }, actions: [{ type: "meeting-bot", confirm: confirmAt30, record: false }] });
    expect(getRule(app, rule.id).actions[0]).toMatchObject({ confirm: confirmAt30 });
    const people: [string, string][] = Array.from({ length: count }, (_, i) => [`ou_${i}`, `参会人${i + 1}`]);
    setLarkCliForTests(async () => ({ ok: true, data: { events: [joined("people", people)] } }));
    await ownerJoinedMeeting(app, { id: "sized", no: "123456789", topic: "方案评审" });
    const shouldAsk = count >= 30;
    expect(cards).toHaveLength(shouldAsk ? 1 : 0);
    expect(calls.filter(c => c.url.endsWith("/bots/join"))).toHaveLength(shouldAsk ? 0 : 1);
    const stored = one<{ plan: string }>(app.db, "select plan from lark_meetings where meeting_id = 'sized'")!;
    expect(JSON.parse(stored.plan)).toMatchObject({ confirm: shouldAsk, confirmationReason: expect.stringContaining(shouldAsk ? "先发卡片" : "直接拉") });
    expect(listFirings(app, rule.id)[0].results[0].detail).toContain(shouldAsk ? "满足确认条件" : "不满足确认条件");
    const preview = await testRule(app, rule);
    expect(preview.matches).toHaveLength(1);
    expect(preview.matches[0]).toMatchObject({ sender: `在会 ${count} 人`, action: expect.stringContaining(shouldAsk ? "先发卡片" : "直接拉") });
    // Trying the rule never sends a card or joins a meeting.
    expect(cards).toHaveLength(shouldAsk ? 1 : 0);
    if (shouldAsk) {
      // Editing the rule and updating people later do not change this card's stored decision.
      saveRule(app, { ...rule, temporary: undefined, actions: [{ type: "meeting-bot", confirm: false }] });
      run(app.db, "update lark_meetings set participants = '[]' where meeting_id = 'sized'");
      await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_card1" }, action: { value: { action: "approve" } } });
      expect(calls.filter(c => c.url.endsWith("/bots/join"))).toHaveLength(1);
      expect(JSON.parse(one<{ plan: string }>(app.db, "select plan from lark_meetings where meeting_id = 'sized'")!.plan).confirm).toBe(true);
    }
  });

  it.each(["failed", "empty"])("asks when participant data is %s, without treating it as zero", async (mode) => {
    const { app, calls, cards } = setup();
    const rule = saveRule(app, { name: "按人数确认", description: "30 人及以上先问", enabled: true, trigger: { event: "meeting" }, actions: [{ type: "meeting-bot", confirm: confirmAt30 }] });
    setLarkCliForTests(async () => {
      if (mode === "failed") throw new Error("无法读取参会人");
      return { ok: true, data: { events: [] } };
    });
    await ownerJoinedMeeting(app, { id: "unknown", no: "123456789", topic: "方案评审" });
    expect(calls).toEqual([]);
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain("在会人数未知");
    const preview = await testRule(app, rule);
    expect(preview.matches[0]).toMatchObject({ sender: "在会人数未知", action: expect.stringContaining("在会人数未知，先发卡片") });
    const e: RuleEvent = { key: "u", kind: "meeting", at: "", via: "test", meeting: { id: "unknown", title: "评审", participants: [], participantCount: null } };
    expect(await evaluate({ field: "meeting.participantCount", op: "lte", value: "29" }, eventReader(e))).toBe(false);
    expect((await meetingConfirmation({ bots: ["main"], confirm: { not: confirmAt30 } }, e)).confirm).toBe(true);
    expect((await meetingConfirmation({ bots: [], confirm: confirmAt30 }, e)).confirm).toBe(false);
    expect((await meetingConfirmation({ bots: ["main"], confirm: false }, e)).confirm).toBe(false);
    // An explicitly known zero remains different from an unknown count.
    expect((await meetingConfirmation({ bots: ["main"], confirm: confirmAt30 }, { ...e, meeting: { ...e.meeting!, participantCount: 0 } })).confirm).toBe(false);
  });

  it("uses nested meeting conditions for confirmation", async () => {
    const e: RuleEvent = { key: "c", kind: "meeting", at: "", via: "test", meeting: { id: "m", title: "方案评审", participants: ["小王"], participantCount: 29 } };
    const confirm: Condition = { any: [confirmAt30, { all: [{ field: "meeting.title", op: "contains", value: "评审" }, { not: { field: "meeting.participants", op: "contains", value: "小李" } }] }] };
    expect((await meetingConfirmation({ bots: ["main"], confirm }, e)).confirm).toBe(true);
    expect((await meetingConfirmation({ bots: ["main"], confirm }, { ...e, meeting: { ...e.meeting!, title: "周会" } })).confirm).toBe(false);
  });

  it("brings the bot in, keeps the record (latest transcript wins), listens, and leaves with the owner", async () => {
    const { app, calls, botEvents } = setup();
    const rule = saveRule(app, {
      name: "评审会",
      description: "我加入评审会时把机器人拉进去，记录并旁听",
      enabled: true,
      trigger: { event: "meeting" },
      conditions: { all: [{ field: "meeting.title", op: "contains", value: "评审" }, { field: "meeting.participantCount", op: "gte", value: "3" }] },
      judge: "code",
      actions: [{ type: "meeting-bot", bots: ["main"], confirm: false, record: true, spec: "assistant" }],
    });
    // A meeting that does not match is remembered, nothing else.
    await ownerJoinedMeeting(app, { id: "m0", no: "111111111", topic: "周会" });
    expect(calls).toEqual([]);

    await ownerJoinedMeeting(app, { id: "m1", no: "123456789", topic: "方案评审" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "/open-apis/vc/v1/bots/join", data: { join_type: 1, join_identify: { meeting_no: "123456789" } } });
    expect(one<{ status: string }>(app.db, "select status from lark_meetings where meeting_id = 'm1'")?.status).toBe("listening");
    expect(listFirings(app, rule.id)[0].results[0]).toMatchObject({ action: "meeting-bot", ok: true });
    // The same meeting again (polling and the event stream both saw it): once.
    await ownerJoinedMeeting(app, { id: "m1", no: "123456789", topic: "方案评审" });
    expect(calls.filter((c) => c.url.endsWith("/bots/join"))).toHaveLength(1);

    // Read as the bot that is in the meeting.
    setMeetingConsumerForTests(() => ({ stop() {} }));
    botEvents.push([
      { event_id: "e1", activity_event_type: "transcript_received", event_time: at(1), transcript_received_items: [{ sentence_id: "s1", text: "我们下周上", speaker: { id: "ou_a", name: "小王" }, start_time: at(1) }] },
      { event_id: "e2", activity_event_type: "chat_received", event_time: at(2), chat_received_items: [{ message_id: "c1", content: "接口文档我晚点发", sender: { id: "ou_b", name: "小李" }, message_type: 1 }] },
    ]);
    await tickMeetings(app);
    expect(calls.at(-1)).toMatchObject({ method: "GET", url: "/open-apis/vc/v1/bots/events", params: { meeting_id: "m1" } });
    const src = one<{ text: string; kind: string }>(app.db, "select text, kind from sources where uri = 'lark:meeting:m1'");
    expect(src?.kind).toBe("meeting");
    expect(src?.text).toContain("小王：我们下周上");
    expect(src?.text).toContain("小李（会中聊天）：接口文档我晚点发");
    const window = all<{ input: string }>(app.db, "select input from runs where lane = 'meeting:m1'");
    expect(window).toHaveLength(1);
    expect(JSON.parse(window[0].input)).toMatchObject({ spec: "assistant", meeting: { id: "m1" }, rule: { id: rule.id } });
    expect(JSON.parse(window[0].input).task).toContain("我们下周上");
    // Nothing reaches the owner during the meeting: no notify; what concerns them is the window's answer.
    expect(JSON.parse(window[0].input)).toMatchObject({ denyTools: ["notify"], meetingWindow: true });
    run(app.db, "update runs set status = 'done', output = json_set(coalesce(output, '{}'), '$.answer', ?) where lane = 'meeting:m1'", "小李说接口文档晚点发，本人等着联调：建议会后催一下小李。");
    // A window with nothing for the owner said so with stay_quiet: what it wrote stays out of the summary.
    run(app.db, "insert into runs(id,kind,space_id,status,title,input,output,lane,created_at) values('r_quiet_window','agent','personal','done','旁听',?,?,'meeting:m1',?)", JSON.stringify({ meetingWindow: true }), JSON.stringify({ answer: "这一段都在排期，和本人无关。", stayQuiet: "这一段没有和本人有关的事" }), new Date().toISOString());
    // The owner's private chat with the bot: the summary goes there, with buttons for next steps.
    run(app.db, "insert into kv(key, value) values('lark_owner_chat', 'oc_dm') on conflict(key) do update set value = excluded.value");
    const dm = createThread(app, { channel: "lark", spaceId: "personal", userId: "owner", key: "oc_dm" });

    // The sentence is revised as it is recognised: the latest text replaces it, in place.
    resetMeetingsForTests();
    botEvents.push([{ event_id: "e3", activity_event_type: "transcript_received", event_time: at(1), transcript_received_items: [{ sentence_id: "s1", text: "我们下周上线", speaker: { id: "ou_a", name: "小王" } }] }]);
    await tickMeetings(app);
    expect(all(app.db, "select key from lark_meeting_lines where meeting_id = 'm1' and kind = 'transcript'")).toHaveLength(1);
    expect(one<{ text: string }>(app.db, "select text from lark_meeting_lines where meeting_id = 'm1' and key = 't:s1'")?.text).toBe("我们下周上线");

    // The owner leaves: the bot leaves too, the record is final, the agent writes a short summary for the owner.
    resetMeetingsForTests();
    const held = notify(app, { title: "另一项工作已查完", urgency: "later" });
    botEvents.push([{ event_id: "e4", activity_event_type: "participant_left", event_time: at(5), participant_left_items: [{ participant: { id: "ou_owner", name: "我" } }] }]);
    await tickMeetings(app);
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/open-apis/vc/v1/bots/leave", data: { meeting_id: "m1" } });
    expect(one<{ status: string; error: string }>(app.db, "select status, error from lark_meetings where meeting_id = 'm1'")).toMatchObject({ status: "ended", error: "owner-left" });
    expect(listNotifications(app).find((n) => n.id === held.id)?.held).toBeUndefined();
    const last = JSON.parse(all<{ input: string }>(app.db, "select input from runs where lane = 'meeting:m1' order by rowid").at(-1)!.input);
    expect(last.meeting).toBeUndefined();
    expect(last.task).toContain("# 会议结束");
    // Nothing forced: no todo for the owner and nothing worth keeping ends the run quietly.
    expect(last.task).toContain("stay_quiet");
    expect(last.task).toContain("小李说接口文档晚点发");
    expect(last.task).not.toContain("这一段都在排期");
    expect(last.task).toContain("suggest_next");
    expect(last.threadId).toBe(dm.id);
  });

  it("counts who the calendar event invited (groups by members, no rooms or declines) and leaves bots out of who is there", async () => {
    const { app, calls, cards } = setup();
    const lark: string[][] = [];
    setLarkCliForTests(async (args) => {
      lark.push(args);
      if (args[1] === "+meeting-events") return { ok: true, data: { events: [joined("e0", [["ou_owner", "我"], ["ou_a", "小王"]]), { event_id: "e1", event_type: "participant_joined", event_time: at(1), payload: { participant_joined_items: [{ participant: { id: "ou_bot", user_name: "小助理", user_type: 10 } }] } }] } };
      if (args[1] === "+agenda") return { ok: true, data: [{ event_id: "ev_other", vchat: { meeting_url: "https://vc.example.com/j/1234567890" } }, { event_id: "ev1", vchat: { meeting_url: "https://vc.example.com/j/123456789" } }] };
      if (args[0] === "api" && args[2].endsWith("/calendars/primary")) return { code: 0, data: { calendars: [{ calendar: { calendar_id: "cal_me" } }] } };
      if (args[0] === "api" && args[2].endsWith("/chat_members")) return { code: 0, data: { items: [{ open_id: "ou_a" }, { open_id: "ou_c" }, { open_id: "ou_d", rsvp_status: "decline" }], has_more: false } };
      if (args[0] === "api" && args[2].endsWith("/attendees")) return { code: 0, data: { items: [{ type: "user", user_id: "ou_owner" }, { type: "user", user_id: "ou_a" }, { type: "user", user_id: "ou_b", rsvp_status: "decline" }, { type: "chat", attendee_id: "att_chat", chat_id: "oc_team" }, { type: "resource", attendee_id: "room1" }], has_more: false } };
      return { ok: true, data: {} };
    });
    saveRule(app, { name: "会邀多就问", description: "会邀 3 人及以上先问，否则直接拉", enabled: true, trigger: { event: "meeting" }, actions: [{ type: "meeting-bot", confirm: { field: "meeting.invitedCount", op: "gte", value: "3" }, record: false }] });
    await ownerJoinedMeeting(app, { id: "big", no: "123456789", topic: "方案评审" });
    const row = one<{ invited: number; participants: string }>(app.db, "select invited, participants from lark_meetings where meeting_id = 'big'")!;
    // 我、小王 and the group's 小丙 (小王 once, 小丁 declined); 小乙 declined, the room is not a person.
    expect(row.invited).toBe(3);
    expect(lark.find((a) => a[0] === "api" && a[2].endsWith("/attendees"))?.[2]).toBe("/open-apis/calendar/v4/calendars/cal_me/events/ev1/attendees");
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain("在会 2 · 会邀 3");
    expect(calls.filter((c) => c.url.endsWith("/bots/join"))).toHaveLength(0);
    // The captured calendar is used before asking Feishu for today's agenda.
    run(app.db, "insert into sources(id, space_id, kind, uri, title, text, hash, captured_at, updated_at) values('s_cal','personal','event','lark:calendar:ev2','日程','- 会议链接：https://vc.example.com/j/987654321','h','2026-10-28','2026-10-28')");
    lark.length = 0;
    await ownerJoinedMeeting(app, { id: "small", no: "987654321", topic: "周会" });
    expect(lark.some((a) => a[1] === "+agenda")).toBe(false);
    expect(lark.find((a) => a[0] === "api" && a[2].endsWith("/attendees"))?.[2]).toContain("/events/ev2/attendees");
    // A meeting with no calendar event: unknown, so the rule asks.
    setLarkCliForTests(async (args) => (args[1] === "+agenda" ? { ok: true, data: [] } : { ok: true, data: { events: [] } }));
    await ownerJoinedMeeting(app, { id: "adhoc", no: "555555555", topic: "临时会" });
    expect(one<{ invited: number | null }>(app.db, "select invited from lark_meetings where meeting_id = 'adhoc'")!.invited).toBeNull();
    expect(cards).toHaveLength(3);
    expect(JSON.stringify(cards[2])).toContain("会邀人数未知");
  });

  it("joins when the owner invites a bot from the meeting, and asks when someone else does", async () => {
    const { app, calls, cards } = setup();
    expect(await botInvitedToMeeting(app, "main", { meeting: { id: "m9", meeting_no: "999999999", topic: "临时讨论" }, inviter: { id: { open_id: "ou_owner", union_id: "on_owner", user_id: "u1" }, user_name: "我" } })).toContain("已把 小助理 拉进会议");
    expect(calls[0]).toMatchObject({ url: "/open-apis/vc/v1/bots/join", data: { join_identify: { meeting_no: "999999999" } } });
    const row = one<{ status: string; plan: string }>(app.db, "select status, plan from lark_meetings where meeting_id = 'm9'")!;
    expect(row.status).toBe("listening");
    expect(JSON.parse(row.plan)).toMatchObject({ bots: ["main"], record: true, answer: true, confirm: false });
    // Already in: a second invitation does nothing.
    expect(await botInvitedToMeeting(app, "main", { meeting: { id: "m9", meeting_no: "999999999" }, inviter: { id: "ou_owner" } })).toContain("已经在会里");
    // Someone else's invitation is the owner's call.
    expect(await botInvitedToMeeting(app, "main", { meeting: { id: "m10", meeting_no: "101010101", topic: "外部会" }, inviter: { id: "ou_x", user_name: "小王" } })).toContain("卡片");
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain("小王在会议里邀请了小助理");
    expect(calls.filter((c) => c.url.endsWith("/bots/join"))).toHaveLength(1);
    await handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_card1" }, action: { tag: "button", value: { action: "approve" } } });
    expect(calls.filter((c) => c.url.endsWith("/bots/join"))).toHaveLength(2);
  });

  it("asks the owner on a card first; joins only after a yes", async () => {
    const { app, calls, cards } = setup();
    saveRule(app, { name: "所有会", description: "每场会议问我要不要拉机器人", enabled: true, trigger: { event: "meeting" }, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"] }] });
    await ownerJoinedMeeting(app, { id: "m2", no: "222222222", topic: "需求对齐" });
    expect(calls).toEqual([]);
    expect(cards).toHaveLength(1);
    const card = JSON.stringify(cards[0]);
    expect(card).toContain("要把机器人拉进会议吗");
    expect(card).toContain("需求对齐");
    const click = (who: string, action: string) => handleCardAction(app, { operator: { open_id: who }, context: { open_message_id: "om_card1" }, action: { tag: "button", value: { action } } });
    expect((await click("ou_someone", "approve")).toast.type).toBe("error");
    const r = await click("ou_owner", "approve");
    expect(JSON.stringify(r.card)).toContain("已把 小助理 拉进会议");
    expect(calls[0]).toMatchObject({ url: "/open-apis/vc/v1/bots/join", data: { join_identify: { meeting_no: "222222222" } } });
  });

  it("tells the owner why a bot could not join", async () => {
    const { app } = setup();
    setLarkClient({ request: async () => ({ code: 121003, msg: "no permission" }) }, "ou_bot", "小助理");
    saveRule(app, { name: "直接拉", description: "直接拉", enabled: true, trigger: { event: "meeting" }, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"], confirm: false, record: false }] });
    await ownerJoinedMeeting(app, { id: "m3", no: "333333333", topic: "复盘" });
    const n = listNotifications(app)[0];
    expect(n?.title).toContain("没能入会");
    expect(n?.body).toContain("允许智能体加入");
  });

  it("writes no record and no summary for a meeting nothing was heard of", async () => {
    const { app } = setup();
    setLarkClient({ request: async () => ({ code: 121005, msg: "meeting not exist" }) }, "ou_bot", "小助理");
    saveRule(app, { name: "入会旁听", description: "入会旁听", enabled: true, trigger: { event: "meeting" }, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"], confirm: false, record: true, spec: "assistant" }] });
    await ownerJoinedMeeting(app, { id: "m4", no: "444444444", topic: "临时通话" });
    expect(listNotifications(app)[0]?.title).toContain("没能入会");
    const { meetingEnded } = await import("../src/channels/lark-meetings.ts");
    await meetingEnded(app, "m4", "ended");
    expect(one<{ status: string }>(app.db, "select status from lark_meetings where meeting_id = 'm4'")?.status).not.toBe("listening");
    expect(one(app.db, "select 1 from sources where uri = 'lark:meeting:m4'")).toBeUndefined();
    expect(all(app.db, "select id from runs where lane = 'meeting:m4'")).toHaveLength(0);
  });

  it("says plainly when AI Summary is off, and brings the bot in once the owner turns it on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { app } = setup();
      let summaryOn = false;
      const joins: unknown[] = [];
      setLarkClient({ request: async (r: { url: string }) => {
        if (!r.url.endsWith("/bots/join")) return { code: 0, data: {} };
        joins.push(r);
        return summaryOn ? { code: 0, data: {} } : { code: 10022, msg: 'This agent cannot join because "AI Summary" is turned off. Ask the meeting host to turn it on and try again.' };
      } }, "ou_bot", "小助理");
      saveRule(app, { name: "直接拉", description: "直接拉", enabled: true, trigger: { event: "meeting" }, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"], confirm: false, record: true }] });
      await ownerJoinedMeeting(app, { id: "m9", no: "999000111", topic: "评审" });
      const first = listNotifications(app)[0];
      expect(first?.body).toContain("没有打开 AI 纪要");
      expect(first?.body).toContain("自动再拉一次");
      // Still off a minute later: tried again, nothing new said.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(joins).toHaveLength(2);
      expect(listNotifications(app)).toHaveLength(1);
      summaryOn = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(joins).toHaveLength(3);
      expect(listNotifications(app)[0]?.title).toContain("已入会");
      // In now: no more tries.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(joins).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("held notifications after a meeting", () => {
  it.each(["会议结束", "owner-left"])("releases at %s before a set time, and keeps the next set time usable", async (why) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 15, 9, 15));
    const sent: string[] = [];
    const stop = addNotificationSink((n) => { sent.push(n.id); });
    try {
      const { app } = setup();
      app.config.notify.laterTimes = ["09:30", "13:30"];
      // No rule/plan was needed to know the owner was in this meeting.
      await ownerJoinedMeeting(app, { id: "release", topic: "项目 A 讨论" });
      const first = notify(app, { title: "资料已查完", urgency: "later" });
      expect(sent).toEqual([]);
      await meetingEnded(app, "release", why);
      expect(sent).toEqual([first.id]);
      expect(one(app.db, "select value from kv where key = 'notify_later_slot'")).toBeUndefined();
      const next = notify(app, { title: "另一份资料已查完", urgency: "later" });
      expect(releaseLater(app)).toBe(0);
      vi.setSystemTime(new Date(2026, 10, 15, 9, 30));
      expect(releaseLater(app)).toBe(1);
      expect(sent).toEqual([first.id, next.id]);
    } finally { stop(); vi.useRealTimers(); }
  });
});

describe("answering in the meeting", () => {
  // Guest runs a test left unanswered: end them, so nothing waits on a closed database.
  afterEach(async () => {
    for (const app of apps) for (const r of all<{ id: string }>(app.db, "select id from runs where kind = 'guest' and status in ('queued', 'running')")) {
      run(app.db, "update runs set status = 'cancelled' where id = ?", r.id);
      app.events.emit("event", { type: "run", runId: r.id });
    }
    await settleMeetingAnswersForTests();
  });
  const tick = async (app: ReturnType<typeof testApp>) => { resetMeetingsForTests(); await tickMeetings(app); };
  const chat = (id: string, min: number, from: [string, string], text: string) => ({ event_id: id, activity_event_type: "chat_received", event_time: at(min), chat_received_items: [{ message_id: `c_${id}`, content: text, sender: { id: from[0], name: from[1] }, message_type: 1 }] });
  const said = (id: string, min: number, from: [string, string], text: string) => ({ event_id: id, activity_event_type: "transcript_received", event_time: at(min), transcript_received_items: [{ sentence_id: `s_${id}`, text, speaker: { id: from[0], name: from[1] } }] });
  const answerRule = (app: ReturnType<typeof testApp>, extra: Record<string, unknown> = {}) =>
    saveRule(app, { name: "答疑", description: "会上有人问机器人就回答", enabled: true, trigger: { event: "meeting" }, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"], confirm: false, record: true, answer: true, ...extra }] });
  const guestRuns = (app: ReturnType<typeof testApp>) => all<{ id: string; input: string }>(app.db, "select id, input from runs where kind = 'guest' order by rowid").map((r) => ({ id: r.id, ...JSON.parse(r.input) }));
  async function finish(app: ReturnType<typeof testApp>, runId: string, output: Record<string, unknown>) {
    run(app.db, "update runs set status = 'done', output = ? where id = ?", JSON.stringify(output), runId);
    app.events.emit("event", { type: "run", runId });
    await settleMeetingAnswersForTests();
  }
  const texts = (calls: { url: string; data?: any }[]) => calls.filter((c) => c.url.endsWith("/bots/message") && c.data.msg_type === "text").map((c) => c.data.content);

  it("a question naming the bot goes to a guest run; the answer waits on the owner's card by default", async () => {
    const { app, calls, cards, botEvents } = setup();
    answerRule(app);
    await ownerJoinedMeeting(app, { id: "m4", no: "444444444", topic: "周会" });
    setMeetingConsumerForTests(() => ({ stop() {} }));
    botEvents.push([chat("q1", 1, ["ou_b", "小李"], "@小助理 上次定的上线时间是哪天？"), chat("q0", 1, ["ou_a", "小王"], "大家看下文档")]);
    await tick(app);
    const [g] = guestRuns(app);
    expect(guestRuns(app)).toHaveLength(1);
    expect(g).toMatchObject({ chatId: "meeting:m4", senderName: "小李", text: "@小助理 上次定的上线时间是哪天？" });
    expect(g.note).toContain("200 字以内");
    expect(g.spaces).not.toContain("personal");
    // No agent of the owner's speaks: nothing went to the meeting, not even the “稍等” reaction.
    expect(calls.some((c) => c.url.endsWith("/bots/message"))).toBe(false);
    const long = `上次定的是 11 月 3 日上线，依据《发布计划》。${"补充说明。".repeat(60)}`;
    await finish(app, g.id, { verdict: "answer", reason: "", answer: long });
    expect(calls.some((c) => c.url.endsWith("/bots/message"))).toBe(false);
    const card = JSON.stringify(cards.at(-1));
    expect(card).toContain("要发这个回答吗");
    expect(card).toContain("发到会里");
    const click = (action: string) => handleCardAction(app, { operator: { open_id: "ou_owner" }, context: { open_message_id: `om_card${cards.length}` }, action: { tag: "button", value: { action } } });
    const r = await click("send");
    expect(JSON.stringify(r.card)).toContain("已发到会里");
    const [sent] = texts(calls);
    expect(sent.length).toBeLessThanOrEqual(200);
    expect(sent.startsWith("上次定的是 11 月 3 日上线")).toBe(true);
    expect(one<{ n: number }>(app.db, "select count(*) n from audit_events where action = 'lark.meeting-answer' and target = 'm4'")!.n).toBe(1);
    // The same message seen again (batches overlap) is not asked twice.
    botEvents.push([chat("q1", 1, ["ou_b", "小李"], "@小助理 上次定的上线时间是哪天？")]);
    await tick(app);
    expect(guestRuns(app)).toHaveLength(1);
  });

  it("auto mode posts at once after a “稍等” reaction, keeps a minute between answers and stops at the limit", async () => {
    const { app, calls, botEvents } = setup();
    answerRule(app, { answerMode: "auto", answerMax: 2 });
    await ownerJoinedMeeting(app, { id: "m5", no: "555555555", topic: "评审" });
    setMeetingConsumerForTests(() => ({ stop() {} }));
    botEvents.push([chat("a1", 1, ["ou_b", "小李"], "小助理 接口文档在哪？")]);
    await tick(app);
    expect(calls.find((c) => c.url.endsWith("/bots/message"))?.data).toMatchObject({ msg_type: "reaction", content: "OneSecond" });
    await finish(app, guestRuns(app)[0].id, { verdict: "answer", reason: "", answer: "在《接口说明》第二节。" });
    expect(texts(calls)).toEqual(["在《接口说明》第二节。"]);
    // A second question right away waits for nobody: it is skipped, and said so in the summary.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 25_000);
      botEvents.push([chat("a2", 2, ["ou_a", "小王"], "小助理 那测试环境呢？")]);
      await tick(app);
      expect(guestRuns(app)).toHaveLength(1);
      vi.setSystemTime(Date.now() + 120_000);
      botEvents.push([chat("a3", 4, ["ou_a", "小王"], "小助理 测试环境地址是什么？")]);
      await tick(app);
      expect(guestRuns(app)).toHaveLength(2);
      // The gatekeeper said no: nothing is posted.
      await finish(app, guestRuns(app)[1].id, { verdict: "refuse", reason: "打听私人信息" });
      expect(texts(calls)).toHaveLength(1);
      vi.setSystemTime(Date.now() + 120_000);
      botEvents.push([chat("a4", 6, ["ou_a", "小王"], "小助理 发布时间？")]);
      await tick(app);
      await finish(app, guestRuns(app)[2].id, { verdict: "answer", reason: "", answer: "周四。" });
      vi.setSystemTime(Date.now() + 120_000);
      botEvents.push([chat("a5", 8, ["ou_a", "小王"], "小助理 还有吗？")]);
      await tick(app);
      expect(guestRuns(app)).toHaveLength(3);
    } finally { vi.useRealTimers(); }
    const { answersText } = await import("../src/channels/meeting-answers.ts");
    const summary = answersText(one<{ answers: string }>(app.db, "select answers from lark_meetings where meeting_id = 'm5'")!);
    expect(summary).toContain("离上次回答不到一分钟");
    expect(summary).toContain("门卫：拒绝");
    expect(summary).toContain("回答到上限（2 次）");
  });

  it("only the owner's questions when the rule says so; /ai 停 and /ai 继续 from the owner pause and resume", async () => {
    const { app, calls, botEvents } = setup();
    answerRule(app, { answerMode: "auto", answerFrom: "owner" });
    await ownerJoinedMeeting(app, { id: "m6", no: "666666666", topic: "站会" });
    setMeetingConsumerForTests(() => ({ stop() {} }));
    botEvents.push([chat("o1", 1, ["ou_b", "小李"], "小助理 上线时间？")]);
    await tick(app);
    expect(guestRuns(app)).toHaveLength(0);
    botEvents.push([chat("o2", 2, ["ou_b", "小李"], "/ai 停"), chat("o3", 2, ["ou_owner", "我"], "/ai 停")]);
    await tick(app);
    expect(calls.filter((c) => c.url.endsWith("/bots/message")).map((c) => c.data.content)).toEqual(["OK"]);
    botEvents.push([chat("o4", 3, ["ou_owner", "我"], "小助理 上线时间？")]);
    await tick(app);
    expect(guestRuns(app)).toHaveLength(0);
    botEvents.push([chat("o5", 4, ["ou_owner", "我"], "/ai 继续"), chat("o6", 4, ["ou_owner", "我"], "小助理 上线时间？")]);
    await tick(app);
    expect(guestRuns(app)).toHaveLength(1);
  });

  it("spoken questions count only when the rule says so, once the sentence settles", async () => {
    const { app, botEvents } = setup();
    answerRule(app, { answerSpoken: true });
    await ownerJoinedMeeting(app, { id: "m7", no: "777777777", topic: "周会" });
    setMeetingConsumerForTests(() => ({ stop() {} }));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      botEvents.push([said("t1", 1, ["ou_b", "小李"], "小助理帮我查")]);
      await tick(app);
      expect(guestRuns(app)).toHaveLength(0);
      vi.setSystemTime(Date.now() + 20_000);
      botEvents.push([said("t1", 1, ["ou_b", "小李"], "小助理帮我查一下发布计划")]);
      await tick(app);
      const runs = guestRuns(app);
      expect(runs).toHaveLength(1);
      expect(runs[0].text).toBe("小助理帮我查一下发布计划");
      expect(runs[0].note).toContain("语音转写");
    } finally { vi.useRealTimers(); }
  });
});

describe("permissions for meeting rules", () => {
  it("lists what lark-cli and each bot lack, with where to apply", async () => {
    const { app } = setup();
    setLarkCliForTests(async (args) => {
      if (args[0] === "auth" && args[1] === "status") return { appId: "cli_cli", brand: "feishu", identities: { user: { available: true, openId: "ou_cli", userName: "我" } } };
      if (args[0] === "auth" && args[1] === "scopes") return { appId: "cli_cli", userScopes: ["im:message:readonly"] };
      return { ok: true, data: {} };
    });
    const { rulePermissions, permissionText } = await import("../src/rules/permissions.ts");
    const rule = saveRule(app, { name: "p", description: "p", trigger: { event: "meeting" }, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"] }] });
    const p = await rulePermissions(app, rule);
    const cli = p.issues.find((i) => i.who.includes("cli_cli"));
    expect(cli?.scopes).toEqual(["vc:meeting.meetingevent:read"]);
    expect(cli?.link).toBe("https://open.feishu.cn/app/cli_cli/auth?q=vc:meeting.meetingevent:read&op_from=openapi&token_type=user");
    expect(p.issues.some((i) => i.who === "主机器人" && i.problem.includes("App Secret"))).toBe(true);
    expect(p.notes.join("")).toContain("数据范围");
    expect(permissionText(p)).toContain("去开发者后台开通");
    // Rules that are not about meetings need nothing checked.
    expect((await rulePermissions(app, { trigger: { event: "message", once: "event", waitMinutes: 0, unless: [] }, actions: [], enabled: true })).issues).toEqual([]);
  });
});
