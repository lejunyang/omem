import { afterEach, describe, expect, it } from "vitest";
import { handleCardAction } from "../src/channels/lark-actions.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { ownerJoinedMeeting, resetMeetingsForTests, setMeetingConsumerForTests, tickMeetings } from "../src/channels/lark-meetings.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { all, one } from "../src/core/db.ts";
import { listNotifications } from "../src/core/notify.ts";
import { evaluate, eventReader } from "../src/rules/conditions.ts";
import { listFirings, saveRule } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { testApp } from "./helpers.ts";

const apps: ReturnType<typeof testApp>[] = [];
afterEach(() => {
  setLarkClient(null);
  setLarkCliForTests(null);
  setMeetingConsumerForTests(null);
  resetMeetingsForTests();
  for (const app of apps.splice(0)) app.db.close();
});

const at = (min: number) => String(Date.parse("2026-10-28T02:00:00Z") + min * 60_000);
const joined = (id: string, people: [string, string][]) => ({ event_id: id, event_type: "participant_joined", event_time: at(0), payload: { participant_joined_items: people.map(([pid, name]) => ({ participant: { id: pid, name } })) } });

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
  });
});

describe("meetings the owner joins", () => {
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

    // The sentence is revised as it is recognised: the latest text replaces it, in place.
    resetMeetingsForTests();
    botEvents.push([{ event_id: "e3", activity_event_type: "transcript_received", event_time: at(1), transcript_received_items: [{ sentence_id: "s1", text: "我们下周上线", speaker: { id: "ou_a", name: "小王" } }] }]);
    await tickMeetings(app);
    expect(all(app.db, "select key from lark_meeting_lines where meeting_id = 'm1' and kind = 'transcript'")).toHaveLength(1);
    expect(one<{ text: string }>(app.db, "select text from lark_meeting_lines where meeting_id = 'm1' and key = 't:s1'")?.text).toBe("我们下周上线");

    // The owner leaves: the bot leaves too, the record is final, the agent writes a short summary for the owner.
    resetMeetingsForTests();
    botEvents.push([{ event_id: "e4", activity_event_type: "participant_left", event_time: at(5), participant_left_items: [{ participant: { id: "ou_owner", name: "我" } }] }]);
    await tickMeetings(app);
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/open-apis/vc/v1/bots/leave", data: { meeting_id: "m1" } });
    expect(one<{ status: string; error: string }>(app.db, "select status, error from lark_meetings where meeting_id = 'm1'")).toMatchObject({ status: "ended", error: "owner-left" });
    const last = JSON.parse(all<{ input: string }>(app.db, "select input from runs where lane = 'meeting:m1' order by rowid").at(-1)!.input);
    expect(last.meeting).toBeUndefined();
    expect(last.task).toContain("会后纪要");
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
});

describe("answering in the meeting", () => {
  it("a question naming the bot in the meeting chat goes to the agent at once; only that run may speak", async () => {
    const { app, calls, botEvents } = setup();
    saveRule(app, { name: "答疑", description: "会上有人问机器人就回答", enabled: true, trigger: { event: "meeting" }, conditions: null, judge: "code", actions: [{ type: "meeting-bot", bots: ["main"], confirm: false, record: true, spec: "assistant", answer: true }] });
    await ownerJoinedMeeting(app, { id: "m4", no: "444444444", topic: "周会" });
    setMeetingConsumerForTests(() => ({ stop() {} }));
    botEvents.push([{ event_id: "q1", activity_event_type: "chat_received", event_time: at(1), chat_received_items: [{ message_id: "c9", content: "@小助理 上次定的上线时间是哪天？", sender: { id: "ou_b", name: "小李" }, message_type: 1 }] }]);
    await tickMeetings(app);
    const runs = all<{ input: string }>(app.db, "select input from runs where lane = 'meeting:m4' order by rowid").map((r) => JSON.parse(r.input));
    const q = runs.find((r) => String(r.task).includes("会中有人问机器人"));
    expect(q?.meeting).toMatchObject({ id: "m4", bot: "main", answer: true });
    const { callTool } = await import("../src/agents/tools.ts");
    const { createRun } = await import("../src/agents/runs.ts");
    const asking = createRun(app, { kind: "agent", spaceId: "personal", title: "回答", input: { spec: "assistant", task: "x", meeting: { id: "m4", bot: "main", answer: true } } });
    const ctx = { app, runId: asking.id, spaceId: "personal", spaces: null, tools: null, actor: "agent" as const };
    expect(JSON.stringify(await callTool(ctx, "meeting_send", { text: "上次定的是 11 月 3 日" }))).toContain("已发到会中聊天");
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "/open-apis/vc/v1/bots/message", data: { meeting_id: "m4", content: "上次定的是 11 月 3 日", msg_type: "text" } });
    const other = createRun(app, { kind: "agent", spaceId: "personal", title: "别的", input: { spec: "assistant", task: "x" } });
    const refused = await callTool({ ...ctx, runId: other.id }, "meeting_send", { text: "hi" });
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain("不能在会中发言");
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
