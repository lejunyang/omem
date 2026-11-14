import { afterEach, beforeEach, expect, it } from "vitest";
import { all, one, run } from "../src/core/db.ts";
import { labelOutcomes, outcomeBreakdown, outcomeLine, outcomeStats } from "../src/core/notify-outcome.ts";
import { upsertSource } from "../src/sources/store.ts";
import { upsertItem } from "../src/items/store.ts";
import { triageMaterial } from "../src/mentions/triage.ts";
import type { MentionChannel } from "../src/mentions/channel.ts";
import { testApp } from "./helpers.ts";

let app: ReturnType<typeof testApp>;
const old = () => new Date(Date.now() - 72 * 3600_000).toISOString();
const after = (at: string, hours = 1) => new Date(Date.parse(at) + hours * 3600_000).toISOString();
beforeEach(() => { app = testApp(); });
afterEach(() => app.db.close());
function n(id: string, context = {}, read = false, at = old(), user = "owner") {
  run(app.db, "insert into notifications(id, at, title, body, user_id, context, read_at) values(?,?,?,'',?,?,?)", id, at, id, user, JSON.stringify(context), read ? after(at) : null);
  return at;
}
function feedback(message: string, polarity: string, at: string, extra: { actor?: string; removed?: string } = {}) {
  run(app.db, "insert into feedback(id,message_id,actor_id,actor_kind,emoji,polarity,at,removed_at) values(?,?,?,?,?,?,?,?)", `${message}-${polarity}-${extra.actor ?? 'owner'}`, message, "ou_test", extra.actor ?? "owner", "emoji", polarity, at, extra.removed ?? null);
}
const outcome = (id: string) => one<{ outcome: string | null }>(app.db, "select outcome from notifications where id = ?", id)?.outcome;

it("negative wins over acted, known and read; removed and other people's reactions do not count", () => {
  const at = n("negative", { larkMessageId: "m1", quiet: "你已经在飞书上看过或处理了，没有再推" }, true);
  feedback("m1", "negative", after(at, 30));
  feedback("m1", "ack", after(at));
  n("removed", { larkMessageId: "m2" });
  feedback("m2", "negative", after(at), { removed: after(at, 2) });
  feedback("m2", "positive", after(at), { actor: "guest" });
  labelOutcomes(app);
  expect(outcome("negative")).toBe("negative");
  expect(outcome("removed")).toBe("unread");
});

it.each(["positive", "ack"])("%s within 24 hours is acted and beats known/read", (polarity) => {
  const at = n("yes", { pushed: { channel: "lark", messageId: "m" }, quiet: "你已经在飞书上看过或处理了，没有再推" }, true);
  feedback("m", polarity, after(at, 24));
  labelOutcomes(app);
  expect(outcome("yes")).toBe("acted");
});

it("owner card actions count, including SQLite datetime; other actors and late actions do not", () => {
  const at = n("clicked", { larkMessageId: "m" });
  n("late", { larkMessageId: "late" }); n("other", { larkMessageId: "other" });
  for (const [id, when, by] of [["m", after(at), "owner"], ["late", after(at, 25), "owner"], ["other", after(at), "ou_other"]])
    run(app.db, "insert into card_interactions(id,message_id,purpose,created_at,handled_at,handled_by) values(?,?,'agent',?,?,?)", id, id, at, when.replace("T", " ").slice(0, 19), by);
  labelOutcomes(app);
  expect(outcome("clicked")).toBe("acted"); expect(outcome("late")).toBe("unread"); expect(outcome("other")).toBe("unread");
});

it("user item events and the owner's source-chat messages within 24 hours count", () => {
  const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "核对退款" }, "agent");
  const at = n("item", { entityId: item.id });
  run(app.db, "insert into item_events(item_id,at,kind,text,actor) values(?,?,'note','已核对','user')", item.id, after(at));
  const source = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_team", title: "项目 A", text: "排期" });
  n("chat", { sourceRefs: [`src:${source.id}#L1-L1`] });
  run(app.db, "insert into lark_messages(message_id,chat_id,sender_kind,content,create_ms) values('own','oc_team','owner','已核对',?)", Date.parse(after(at)));
  labelOutcomes(app);
  expect(outcome("item")).toBe("acted"); expect(outcome("chat")).toBe("acted");
});

it("signed automatic replies, late reactions, and agent item changes are not owner actions", () => {
  app.config.lark.commands.signature = "由助理代回";
  const source = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_signed", title: "项目 B", text: "排期" });
  const item = upsertItem(app, undefined, { spaceId: "personal", kind: "todo", title: "核对排期" }, "agent");
  const at = n("automatic", { sourceRefs: [`src:${source.id}#L1`], larkMessageId: "late-ack", entityId: item.id });
  run(app.db, "insert into lark_messages(message_id,chat_id,sender_kind,content,create_ms) values('signed','oc_signed','owner','已收到，由助理代回',?)", Date.parse(after(at)));
  feedback("late-ack", "ack", after(at, 25));
  run(app.db, "insert into item_events(item_id,at,kind,text,actor) values(?,?,'note','已查清','agent')", item.id, after(at));
  labelOutcomes(app); expect(outcome("automatic")).toBe("unread");
});

it("known beats read; ignore-rule quiet is not known; read and unread are separate", () => {
  n("known", { quiet: "你已经在飞书上看过或处理了，没有再推" }, true);
  n("ignore", { quiet: "按你的免提醒规则没有推到飞书" });
  n("read", {}, true); n("unread"); labelOutcomes(app);
  expect(["known", "ignore", "read", "unread"].map(outcome)).toEqual(["known", "unread", "read", "unread"]);
});

it("waits 48 hours, skips silent/replaced/bundle lists and non-owner; bounded and idempotent", () => {
  n("fresh", {}, false, new Date().toISOString()); n("silent", { urgency: "silent" }); n("replaced", { replacedBy: "next" });
  n("list", { bundle: ["a"] }); n("member", {}, false, old(), "other");
  n("bundled", { pushed: { channel: "bundle" } }); n("remaining");
  expect(labelOutcomes(app, { limit: 1 })).toBe(1);
  expect(labelOutcomes(app)).toBe(1); expect(labelOutcomes(app)).toBe(0);
  expect(outcome("bundled")).toBe("bundled");
  expect(["fresh", "silent", "replaced", "list", "member"].map(outcome)).toEqual([null, null, null, null, null]);
});

it("stats filter by run kind and cited chat; breakdown includes titles and only top 20 chats", () => {
  const at = old();
  run(app.db, "insert into runs(id,kind,status,title,created_at) values('r','heartbeat','done','巡检',?)", at);
  const s = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_team", title: "项目 A", text: "排期" });
  n("h", { runId: "r", sourceRefs: [`src:${s.id}#L1`, `src:${s.id}#L2`] }, true);
  n("host"); labelOutcomes(app);
  expect(outcomeStats(app, { sender: "heartbeat" })).toMatchObject({ sent: 1, read: 1, unread: 0 });
  expect(outcomeStats(app, { sourceId: s.id })).toMatchObject({ sent: 1, read: 1 });
  expect(outcomeStats(app, { sender: "host" })).toMatchObject({ sent: 1, unread: 1 });
  expect(outcomeStats(app, { days: 1 }).sent).toBe(0);
  expect(outcomeBreakdown(app).sources[0]).toMatchObject({ title: "项目 A", sourceId: s.id, sent: 1 });
  for (let i = 0; i < 22; i++) {
    const source = upsertSource(app, { spaceId: "personal", kind: "chat", uri: `lark:oc_${i}`, title: `会话 ${i}`, text: "材料" });
    n(`n${i}`, { sourceRefs: [`src:${source.id}#L1`] });
  }
  labelOutcomes(app); expect(outcomeBreakdown(app).sources).toHaveLength(20);
});

it("outcomeLine stays empty below five; otherwise gives the six counts", () => {
  const stats = { sent: 4, acted: 1, known: 1, read: 1, unread: 1, negative: 1 };
  expect(outcomeLine(stats)).toBe("");
  expect(outcomeLine({ ...stats, sent: 5 })).toBe("近 30 天发了 5 条：本人处理了 1 条，本人先一步已经知道 1 条，只看了 1 条，没看 1 条，表示过反感 1 条");
});

it("large-table evidence lookups use indexes", () => {
  for (const [sql, params] of [
    ["select id, title, uri, meta from sources where id = ? and kind = 'chat'", ["s"]],
    ["select 1 from lark_messages where chat_id = ? and create_ms >= ? and create_ms <= ? and sender_kind = 'owner' and msg_type in ('text','post') and trim(content) != '' and (? = '' or instr(content, ?) = 0) limit 1", ["oc_team", 0, Date.now(), "签名", "签名"]],
    ["select 1 from item_events where item_id = ? and actor = 'user' and at >= ? and at <= ? limit 1", ["i", "", "z"]],
    ["select id, at, read_at, context from notifications indexed by notifications_outcome_pending where outcome is null and at < ? and user_id = 'owner' and coalesce(json_extract(context, '$.urgency'), '') != 'silent' and json_extract(context, '$.replacedBy') is null and json_extract(context, '$.bundle') is null order by at limit ?", [old(), 300]],
  ] as const) {
    const plan = all<{ detail: string }>(app.db, `explain query plan ${sql}`, ...params).map((r) => r.detail).join("\n");
    expect(plan).toMatch(/SEARCH .*USING .*INDEX/); expect(plan).not.toMatch(/SCAN (sources|lark_messages|item_events|notifications)\b/);
  }
});

it("mention triage receives this chat's reaction sentence only from five labelled notifications", async () => {
  const channel: MentionChannel = { id: "test", label: "测试渠道", messages: () => [], spaceOf: () => "personal", ownerSeen: async () => false, takenElsewhere: () => false, ruleKey: (id) => id, talkAround: () => "", senderLine: (_app, m) => m.sender, handedLines: () => [], ownerConversation: () => null, readHint: "" };
  const source = upsertSource(app, { spaceId: "personal", kind: "chat", uri: "lark:oc_triage", title: "项目 A", text: "退款核对" });
  const input = { chatId: "oc_triage", chatName: "项目 A", chatKind: "group" as const, topicId: null, spaceId: "personal", messages: [{ id: "m", sender: "小王", senderId: null, atMs: Date.now(), text: "退款核对", topicId: null, quoted: null, sourceId: source.id, ref: `src:${source.id}#L1` }] };
  for (let i = 0; i < 4; i++) n(`triage${i}`, { sourceRefs: [`src:${source.id}#L1`] });
  labelOutcomes(app);
  expect((await triageMaterial(app, channel, input))["本人对这个会话里以往提醒的反应"]).toBeUndefined();
  n("triage4", { sourceRefs: [`src:${source.id}#L1`] }); labelOutcomes(app);
  expect((await triageMaterial(app, channel, input))["本人对这个会话里以往提醒的反应"]).toContain("近 30 天发了 5 条");
});
