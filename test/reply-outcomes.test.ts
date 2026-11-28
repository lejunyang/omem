import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/core/app.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { one, run } from "../src/core/db.ts";
import { resetDecisionCooldownForTests, setDecisionFetchForTests } from "../src/core/decision.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";
import { createUser } from "../src/core/users.ts";
import { createRun } from "../src/agents/runs.ts";
import { addMessage, createThread } from "../src/agents/threads.ts";
import { recordLarkSent } from "../src/channels/lark-feedback.ts";
import { askerOf, backfillReplies, labelReplies, noteReply, replyLine, replyOutcome, replyOutcomeText, reviseReply } from "../src/agents/reply-outcomes.ts";
import { signalOf } from "../src/agents/replay.ts";
import { clearInsightsCache, insights } from "../src/insights/insights.ts";

const apps: App[] = [];
const HOUR = 3600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
afterEach(() => {
  setDecisionFetchForTests(null); resetDecisionCooldownForTests();
  for (const app of apps.splice(0)) { app.db.close(); rmSync(app.home, { recursive: true, force: true }); }
});
function setup(decision = true) {
  const home = mkdtempSync(join(tmpdir(), "omem-reply-outcomes-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(decision ? { ai: { decision: { provider: "d" } } } : {}));
  const app = App.open(home); apps.push(app); ensurePersonalSpace(app);
  if (decision) { app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai", backends: [] }]; setKey(home, "d", "test-key"); }
  return app;
}
/** The decision model answers `choice` with this much probability; every request body is kept. */
function fake(choice: string, probability = 0.9) {
  const asked: string[] = [];
  setDecisionFetchForTests(async (_url, init) => {
    asked.push(String((init as RequestInit).body));
    return new Response(JSON.stringify({ answers: [{ type: "choice", name: "q", choice, probabilities: [{ value: choice, probability }, { value: "unrelated", probability: 1 - probability }] }] }));
  });
  return asked;
}
/** A question in a conversation and the run that answered it `hours` ago. */
function answered(app: App, hours = 8, kind: "ask" | "guest" | "heartbeat" = "ask", input: Record<string, unknown> = {}) {
  const conversationId = createThread(app, { spaceId: "personal", channel: "web", title: "虚构会话" }).id;
  const question = addMessage(app, conversationId, "user", "退款改造什么时候上线？");
  const r = createRun(app, { kind, title: "虚构问答", input: { conversationId, ...input } });
  const answer = addMessage(app, conversationId, "assistant", "周四上线，依据是排期表。", r.id);
  run(app.db, "update messages set created_at = ? where id = ?", ago(hours + 0.1), question);
  run(app.db, "update messages set created_at = ? where id = ?", ago(hours), answer);
  run(app.db, "update reply_outcomes set at = ?, due_at = ? where run_id = ?", ago(hours), ago(hours - 6), r.id);
  return { runId: r.id, conversationId };
}
function says(app: App, conversationId: string, text: string, hoursAgo: number, speaker?: string) {
  const id = addMessage(app, conversationId, "user", text, null, speaker ? { speaker } : {});
  run(app.db, "update messages set created_at = ? where id = ?", ago(hoursAgo), id);
}
const raw = (app: App, runId: string) => one<{ label: string | null; by: string | null; due_at: string; at: string }>(app.db, "select label, \"by\", due_at, at from reply_outcomes where run_id = ?", runId);

describe("回复发出后有没有用", () => {
  it("只登记回答别人的运行；协调、唤醒和巡检发的不算；关掉以后不登记", () => {
    const app = setup();
    expect(raw(app, answered(app).runId)).toBeTruthy();
    expect(raw(app, answered(app, 8, "guest").runId)).toBeTruthy();
    expect(raw(app, answered(app, 8, "heartbeat").runId)).toBeUndefined();
    expect(raw(app, answered(app, 8, "ask", { coordinate: true }).runId)).toBeUndefined();
    expect(raw(app, answered(app, 8, "ask", { wake: { id: "w" } }).runId)).toBeUndefined();
    app.config.replies.outcome.enabled = false;
    expect(raw(app, answered(app).runId)).toBeUndefined();
  });

  it("没到时间不判；没人接话不问模型；只有表情就按表情", async () => {
    const app = setup();
    const asked = fake("resolved");
    const early = answered(app, 1);
    const quiet = answered(app);
    const liked = answered(app), disliked = answered(app);
    for (const [runId, emoji, polarity] of [[liked.runId, "THUMBSUP", "positive"], [disliked.runId, "ThumbsDown", "negative"]])
      run(app.db, "insert into feedback(id, message_id, run_id, actor_id, actor_kind, emoji, polarity, at) values(?,?,?,?,?,?,?,?)", `f-${runId}`, `om-${runId}`, runId, "ou_x", "guest", emoji, polarity, ago(2));
    expect(await labelReplies(app)).toBe(3);
    expect(asked).toEqual([]);
    expect(raw(app, early.runId)!.label).toBeNull();
    expect(replyOutcome(app, quiet.runId)).toMatchObject({ label: "silent", text: "没人接话", first: { by: "宿主" }, evidence: [] });
    expect(replyOutcome(app, liked.runId)).toMatchObject({ label: "resolved", first: { by: "表情" } });
    expect(replyOutcome(app, disliked.runId)).toMatchObject({ label: "corrected", first: { by: "表情" } });
    // Labelled once: a second pass leaves them alone.
    expect(await labelReplies(app)).toBe(0);
  });

  it("有后续就问决策模型：材料里有问题、回答和之后说的话；把握不够按看不出算", async () => {
    const app = setup();
    const sure = answered(app), unsure = answered(app);
    says(app, sure.conversationId, "不对，排期表上写的是下周二", 7);
    says(app, sure.conversationId, "/status", 6.5);
    says(app, unsure.conversationId, "我再看看", 7, "小王");
    const asked = fake("corrected", 0.92);
    expect(await labelReplies(app, { limit: 1 })).toBe(1);
    fake("corrected", 0.41);
    expect(await labelReplies(app)).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("退款改造什么时候上线");
    expect(asked[0]).toContain("周四上线");
    expect(asked[0]).toContain("本人：不对，排期表上写的是下周二");
    const a = replyOutcome(app, sure.runId)!;
    expect(a).toMatchObject({ label: "corrected", text: "被纠正", first: { label: "corrected", confidence: 0.92 }, revised: null });
    expect(a.evidence.map((l) => l.text)).toContain("不对，排期表上写的是下周二");
    const b = replyOutcome(app, unsure.runId)!;
    expect(b).toMatchObject({ label: "unrelated", first: { label: "corrected", confidence: 0.41 } });
    expect(b.evidence[0]).toMatchObject({ who: "小王" });
    expect(replyOutcomeText(b)).toContain("把握不够");
  });

  it("群里的回答：只看它的话题或引用它的；没有就看两小时内的；机器人和系统消息不算", async () => {
    const app = setup();
    const chat = (app2: App, hours: number) => {
      const r = createRun(app2, { kind: "guest", title: "群里的提问", input: {} });
      recordLarkSent(app2, { messageId: `om_${r.id}`, chatId: "oc_demo", runId: r.id, purpose: "answer", bot: "main" });
      run(app2.db, "update reply_outcomes set at = ?, due_at = ? where run_id = ?", ago(hours), ago(hours - 6), r.id);
      return r.id;
    };
    const line = (id: string, hoursAgo: number, text: string, extra: { parent?: string; kind?: string; name?: string } = {}) =>
      run(app.db, "insert into lark_messages(message_id, chat_id, parent_id, sender_name, sender_kind, content, create_ms) values(?,?,?,?,?,?,?)", id, "oc_demo", extra.parent ?? null, extra.name ?? "小李", extra.kind ?? "user", text, Date.now() - hoursAgo * HOUR);
    const quoted = chat(app, 20);
    line("m1", 19.5, "和这个回答没关系的闲聊");
    line("m2", 12, "谢谢，按这个办好了", { parent: `om_${quoted}` });
    const asked = fake("resolved");
    expect(await labelReplies(app)).toBe(1);
    expect(replyOutcome(app, quoted)!.evidence.map((l) => l.text)).toEqual(["谢谢，按这个办好了"]);
    expect(asked[0]).toContain("小李：谢谢，按这个办好了");

    const loose = chat(app, 9);
    line("m3", 8.5, "我自己查到了，是配置没开", { kind: "owner", name: "本人的名字" });
    line("m4", 8.4, "自动通知：构建完成", { kind: "app", name: "某机器人" });
    line("m5", 6.5, "下午开会吗");
    expect(await labelReplies(app)).toBe(1);
    expect(replyOutcome(app, loose)!.evidence).toEqual([expect.objectContaining({ who: "本人", text: "我自己查到了，是配置没开" })]);
    expect(replyLine(app, "oc_demo")).toBe("2 条里，解决了 2，其余看不出");
  });

  it("成员自己和机器人的会话：他说的话记在他名下，不算本人；飞书里带 @ 的同一句只算一次", async () => {
    const app = setup();
    createUser(app, { id: "xiaowang", name: "小王" });
    const { runId, conversationId } = answered(app);
    run(app.db, "update messages set meta = json_object('userId', 'xiaowang') where conversation_id = ? and role = 'user'", conversationId);
    run(app.db, "update reply_outcomes set chat_id = 'oc_team' where run_id = ?", runId);
    const id = addMessage(app, conversationId, "user", "换成日均的 UV", null, { userId: "xiaowang" });
    run(app.db, "update messages set created_at = ? where id = ?", ago(7), id);
    run(app.db, "insert into lark_messages(message_id, chat_id, sender_name, sender_kind, content, create_ms) values(?,?,?,?,?,?)", "om_dup", "oc_team", "小王", "user", "@某某的助理 换成日均的 UV", Date.now() - 7 * HOUR);
    const asked = fake("followup");
    expect(await labelReplies(app)).toBe(1);
    expect(replyOutcome(app, runId)!.evidence).toEqual([expect.objectContaining({ who: "小王", text: "换成日均的 UV" })]);
    expect(asked[0]).toContain("小王：换成日均的 UV");
    expect(asked[0]).not.toContain("本人：");
  });

  it("提问的人：本人、成员（邮箱认得出的飞书用户也算）、没登记的同事、别的机器人、关注里没人认得的署名算系统消息", () => {
    const app = setup();
    createUser(app, { id: "xiaowang", name: "小王", email: "wang@example.com" });
    run(app.db, "insert into lark_people(email, name, bot_open_id, updated_at) values('wang@example.com', '小王', 'ou_wang', ?), ('li@example.com', '小李', 'ou_li', ?), (null, '小赵', 'ou_zhao', ?)", ago(1), ago(1), ago(1));
    expect(askerOf(app, "user:owner")).toMatchObject({ kind: "owner" });
    expect(askerOf(app, "user:xiaowang")).toMatchObject({ name: "小王", kind: "member" });
    expect(askerOf(app, "lark:ou_wang")).toMatchObject({ key: "user:xiaowang", kind: "member" });
    expect(askerOf(app, "lark:ou_li")).toMatchObject({ key: "email:li@example.com", name: "小李", kind: "colleague" });
    expect(askerOf(app, "lark:ou_zhao")).toMatchObject({ key: "lark:ou_zhao", name: "小赵", kind: "colleague" });
    expect(askerOf(app, "name:小李")).toMatchObject({ key: "email:li@example.com", kind: "colleague" });
    expect(askerOf(app, "name:持续跟进")).toMatchObject({ name: "持续跟进", kind: "system" });
    expect(askerOf(app, "name:小王")).toMatchObject({ kind: "member" });
    expect(askerOf(app, "bot:ou_bot1234")).toMatchObject({ name: "机器人 …1234", kind: "bot" });
  });

  it("没配决策模型：有后续的先等着，过一周记成没判", async () => {
    const app = setup(false);
    const recent = answered(app), old = answered(app, 8 * 24);
    says(app, recent.conversationId, "收到", 7);
    says(app, old.conversationId, "收到", 8 * 24 - 1);
    expect(await labelReplies(app)).toBe(1);
    expect(raw(app, recent.runId)!.label).toBeNull();
    expect(Date.parse(raw(app, recent.runId)!.due_at)).toBeGreaterThan(Date.now());
    expect(replyOutcome(app, old.runId)).toMatchObject({ label: "unjudged", text: "没判" });
  });

  it("改判：原标注留着，之后以改判为准；没判过的不能改，标注名要对", async () => {
    const app = setup();
    const a = answered(app), pending = answered(app, 1);
    says(app, a.conversationId, "好的谢谢", 7);
    fake("resolved");
    await labelReplies(app);
    expect(() => reviseReply(app, a.runId, "wrong", "coach", "x")).toThrow(/只能是/);
    expect(() => reviseReply(app, "r-none", "corrected", "coach", "x")).toThrow(/没有记录/);
    expect(() => reviseReply(app, pending.runId, "corrected", "coach", "x")).toThrow(/还没到/);
    const o = reviseReply(app, a.runId, "corrected", "复盘评判（虚构模型）", "对方后来说“谢谢，不过日期不对”");
    expect(o).toMatchObject({ label: "corrected", first: { label: "resolved" }, revised: { label: "corrected", by: "复盘评判（虚构模型）" } });
    expect(replyOutcomeText(o)).toContain("改判");
    expect(replyOutcomeText(o)).toContain("原先标的是 解决了");
    // The same label again changes nothing.
    expect(reviseReply(app, a.runId, "corrected", "别人", "再说一遍").revised!.by).toBe("复盘评判（虚构模型）");
    // What the night replay picks its questions by.
    const run_ = one<Record<string, unknown>>(app.db, "select * from runs where id = ?", a.runId)!;
    expect(signalOf(app, { run: { ...run_, status: "done" }, reaction: { emoji: [] }, answer: "周四上线" } as never, null)).toBe("correction");
  });

  it("数据页：按回答的是谁分行，有用的占比不算看不出的，改判过的单列", async () => {
    const app = setup();
    const good = answered(app), bad = answered(app), quiet = answered(app), guest = answered(app, 8, "guest");
    says(app, good.conversationId, "好的谢谢", 7);
    says(app, bad.conversationId, "不对", 7);
    says(app, guest.conversationId, "谢谢", 7, "小王");
    for (const id of [good.runId, bad.runId, quiet.runId, guest.runId]) run(app.db, "update runs set status = 'done', created_at = ?, finished_at = ? where id = ?", ago(8), ago(8), id);
    fake("resolved");
    await labelReplies(app);
    reviseReply(app, bad.runId, "corrected", "本人", "他说不对");
    clearInsightsCache(app);
    const quality = insights(app, "owner", {}).sections.find((s) => s.id === "quality")!;
    const value = (key: string) => quality.metrics.find((m) => m.key === key)?.value;
    expect(value("quality:reply:对话里的回答:resolved")).toBe(1);
    expect(value("quality:reply:对话里的回答:corrected")).toBe(1);
    expect(value("quality:reply:对话里的回答:unclear")).toBe(1);
    expect(value("quality:reply:别人问机器人的:resolved")).toBe(1);
    expect(value("quality:reply:rate")).toBe(66.7);
    expect(value("quality:reply:revised")).toBe(1);
    expect(quality.metrics.find((m) => m.key === "quality:reply:对话里的回答:resolved")!.cell).toEqual({ table: "回复发出后的结果", row: "对话里的回答", col: "解决了" });
  });

  it("第一次启用时把最近一周的回答补登记一次，更早的和没做完的不补", () => {
    const app = setup();
    const recent = answered(app, 3 * 24), old = answered(app, 10 * 24), unfinished = answered(app, 2 * 24);
    for (const [id, hours] of [[recent.runId, 3 * 24], [old.runId, 10 * 24]] as const) run(app.db, "update runs set status = 'done', created_at = ?, finished_at = ? where id = ?", ago(hours + 0.05), ago(hours), id);
    run(app.db, "delete from reply_outcomes");
    expect(backfillReplies(app)).toBe(1);
    const row = raw(app, recent.runId)!;
    expect(Math.abs(Date.parse(row.at) - Date.parse(ago(3 * 24)))).toBeLessThan(60_000);
    expect(Date.parse(row.due_at)).toBeLessThan(Date.now());
    expect(raw(app, old.runId)).toBeUndefined();
    expect(raw(app, unfinished.runId)).toBeUndefined();
    run(app.db, "delete from reply_outcomes");
    expect(backfillReplies(app)).toBe(0);
  });

  it("同一次运行发了几条，以最后一条的时间为准；已经判过的不再重开", () => {
    const app = setup();
    const { runId, conversationId } = answered(app);
    const before = raw(app, runId)!;
    noteReply(app, { runId, channel: "lark", chatId: "oc_demo", messageId: "om_1", conversationId });
    const after = one<{ at: string; channel: string; chat_id: string }>(app.db, "select at, channel, chat_id from reply_outcomes where run_id = ?", runId)!;
    expect(Date.parse(after.at)).toBeGreaterThan(Date.parse(before.at));
    expect(after).toMatchObject({ channel: "lark", chat_id: "oc_demo" });
    run(app.db, "update reply_outcomes set label = 'silent', labelled_at = ? where run_id = ?", ago(0), runId);
    noteReply(app, { runId, channel: "lark", messageId: "om_2", at: new Date(Date.now() + HOUR).toISOString() });
    expect(raw(app, runId)!.at).toBe(after.at);
  });
});
