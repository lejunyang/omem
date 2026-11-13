import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prepareRun } from "../src/agents/runner.ts";
import { createRun, getRun, waitForRun } from "../src/agents/runs.ts";
import { releaseAll } from "../src/agents/sessions.ts";
import { toolContextForToken } from "../src/agents/tools.ts";
import { setKey } from "../src/core/ai-keys.ts";
import { all, one, run } from "../src/core/db.ts";
import { setDecisionFetchForTests } from "../src/core/decision.ts";
import { notify } from "../src/core/notify.ts";
import { OWNER } from "../src/core/users.ts";
import { setLarkCliForTests } from "../src/channels/lark-cli.ts";
import { queueMention } from "../src/channels/lark-mentions.ts";
import { handedToMentions, MENTION_DENY, mentionTools, mentionUsage, replyToAsker, type MentionInfo } from "../src/mentions/mentions.ts";
import { persistChatMessages, type LarkMessage } from "../src/channels/lark-messages.ts";
import { decideMentionReply, draftMentionReply } from "../src/channels/mention-reply.ts";
import { setLarkClient } from "../src/channels/lark-send.ts";
import { moveOldSettings } from "../src/core/config.ts";
import { dispatchRuleEvent, forgetChatBots } from "../src/rules/engine.ts";
import { deleteRule, endJudging, ruleClaim, saveRule, startJudging } from "../src/rules/store.ts";
import type { RuleEvent } from "../src/rules/types.ts";
import { boot } from "../src/main.ts";

const fake = (id: string, env: Record<string, string>) => ({ id, transport: "acp", command: process.execPath, args: [resolve("test/fake-acp-agent.ts")], env });

describe("someone looking for the owner: free checks, a small triage, then maybe a handling", async () => {
  const home = mkdtempSync(join(tmpdir(), "omem-mention-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      lark: { ownerOpenId: "ou_owner", appId: "cli_bot", mentions: { delayMinutes: 0 } },
      agents: {
        default: "handle",
        profiles: [
          fake("handle", { FAKE_MODE: "mention" }),
          fake("handle-quiet", { FAKE_MODE: "mention", FAKE_MENTION: "quiet" }),
          fake("handle-silent", { FAKE_MODE: "mention", FAKE_MENTION: "silent" }),
          fake("handle-reply", { FAKE_MODE: "mention", FAKE_REPLY: "按未发货的行算，已发货的不退。" }),
          fake("handle-reply-quiet", { FAKE_MODE: "mention", FAKE_MENTION: "quiet", FAKE_REPLY: "按未发货的行算。" }),
          fake("handle-dies", { FAKE_DIE: "1" }),
          fake("handle-hangs", { FAKE_STALL: "before" }),
          fake("triage-notify", { FAKE_MODE: "mention", FAKE_TRIAGE: '{"action":"notify","what":"约周五评审","handler":"assistant","urgency":"normal","canProgress":false,"reason":"只是约时间"}' }),
        ],
      },
      sessions: { mergeMs: 0 },
    }),
  );
  const { app, server } = await boot(home, { port: 0, quiet: true, background: false });
  afterAll(() => {
    setLarkCliForTests(null);
    setLarkClient(null);
    setDecisionFetchForTests(null);
    releaseAll();
    server.close();
  });

  // The decision model: answers per question, counted.
  const decision = { action: "handle", progress: 0.9, calls: 0 };
  const useDecision = (on: boolean) => {
    if (!on) {
      app.config.ai.decision = { provider: "", model: "", fallback: "general", gatekeeper: true };
      setDecisionFetchForTests(null);
      return;
    }
    app.config.ai.providers = [{ id: "d", name: "决策", kind: "openai", backends: [] } as never];
    app.config.ai.decision = { provider: "d", model: "", fallback: "general", gatekeeper: true };
    setKey(home, "d", "key-1");
    setDecisionFetchForTests((async (_url: string, init: RequestInit) => {
      decision.calls++;
      const q = JSON.parse(String(init.body)).questions[0];
      if (q.type === "predicate") return new Response(JSON.stringify({ answers: [{ type: "predicate", name: "q", probability: decision.progress }] }));
      const values = (q.choices as { value: string }[]).map((c) => c.value);
      const choice = values.includes("ignore") ? decision.action : "assistant";
      return new Response(JSON.stringify({ answers: [{ type: "choice", name: "q", choice, probabilities: values.map((v) => ({ value: v, probability: v === choice ? 0.8 : 0.1 })) }] }));
    }) as unknown as typeof fetch);
  };

  const read = new Set<string>();
  const cli: string[][] = [];
  let botIn = false;
  const sent: { to: string; content: string; inThread?: boolean }[] = [];
  beforeEach(() => {
    cli.length = 0;
    sent.length = 0;
    setLarkCliForTests(async (args) => {
      cli.push(args);
      if (args.includes("+messages-read-status")) {
        const ids = args[args.indexOf("--message-ids") + 1].split(",");
        return { data: { items: ids.map((id) => ({ message_id: id, is_read: read.has(id) })) } };
      }
      if (args[0] === "auth") return { data: { identities: { user: { openId: "ou_owner" } } } };
      if (args.includes("+chat-members-list")) return { data: { bots: botIn ? [{ app_id: "cli_bot", name: "omem" }] : [] } };
      if (args.includes("chat.members")) { botIn = true; return { data: {} }; }
      if (args.includes("+chat-create")) return { data: { chat_id: `oc_made${cli.length}` } };
      if (args.includes("+messages-send")) return { data: { message_id: "om_signed" } };
      return { data: { messages: [] } };
    });
    setLarkClient({ im: { message: {
      create: async ({ data }: any) => { sent.push({ to: data.receive_id, content: data.content }); return { code: 0, data: { message_id: `om_bot${sent.length}`, chat_id: data.receive_id } }; },
      reply: async ({ path, data }: any) => { sent.push({ to: `reply:${path.message_id}`, content: data.content, inThread: data.reply_in_thread }); return { code: 0, data: { message_id: `om_bot${sent.length}`, thread_id: "omt_new" } }; },
    } } } as never);
  });

  let seq = 0;
  const msg = (text: string, over: Partial<LarkMessage> = {}): LarkMessage => ({
    message_id: `om_m${++seq}`,
    chat_id: "oc_team",
    msg_type: "text",
    content: text,
    create_time: String(Date.now()),
    sender: { id: "ou_wang", name: "小王", sender_type: "user" },
    mentions: [{ id: "ou_owner" }],
    ...over,
  });
  const store = (messages: LarkMessage[], chatId = "oc_team") => persistChatMessages(app, { chatId, spaceId: "personal", name: chatId === "oc_team" ? "项目 A 讨论群" : "小王", messages, owner: "ou_owner" });
  const group = { id: "oc_team", name: "项目 A 讨论群", kind: "group" as const };
  const handlingOf = (mentionRun: string) => getRun(app, String(getRun(app, mentionRun).output.handleRun));
  const notifiedBy = (runId: string) => one<{ title: string; body: string; context: string }>(app.db, "select title, body, context from notifications where json_extract(context, '$.runId') = ?", runId);
  /** A handling that never starts, to try replies on. */
  const handling = (over: Partial<MentionInfo> = {}) => {
    const m = msg("@勒 这周能上线吗？", over.chatKind === "p2p" ? { chat_id: over.chatId, mentions: [] } : {});
    store([m], over.chatId ?? "oc_team");
    const mention: MentionInfo = { from: "r_x", chatId: "oc_team", chatName: "项目 A 讨论群", chatKind: "group", topicId: null, messageIds: [m.message_id], lastMessageId: m.message_id, senderId: "ou_wang", senderName: "小王", refs: [], reply: "auto", urgency: "normal", what: "问上线时间", ...over };
    return createRun(app, { kind: "agent", title: "试回复", notBefore: new Date(Date.now() + 10 * 86400_000).toISOString(), input: { spec: "assistant", task: "", mention } }).id;
  };

  it("picks people @-ing the owner (or writing one-to-one), once each, one waiting run per topic", async () => {
    app.config.mentions.delayMinutes = 30;
    const at = msg("@勒 退款按什么口径算？");
    const notMe = msg("大家看下这个", { mentions: [{ id: "ou_li" }] });
    const bot = msg("值班提醒 @勒", { sender: { id: "cli_other", name: "值班机器人", sender_type: "app" } });
    const own = msg("我看看", { sender: { id: "ou_owner", name: "我", sender_type: "user" } });
    const old = msg("上周的事 @勒", { create_time: String(Date.now() - 2 * 86400_000) });
    const inTopic = msg("@勒 话题里另一件事", { thread_id: "omt_1" });
    store([at, notMe, bot, own, old, inTopic]);
    const r = queueMention(app, group, [at, notMe, bot, own, old, inTopic], "ou_owner")!;
    const runs = all<{ id: string; input: string; lane: string }>(app.db, "select id, input, lane from runs where kind = 'mention' and status = 'queued'");
    expect(runs).toHaveLength(2);
    expect(runs.map((x) => JSON.parse(x.input).messageIds).flat().sort()).toEqual([at.message_id, inTopic.message_id].sort());
    expect(queueMention(app, group, [at], "ou_owner")).toBeNull();
    const more = msg("@勒 还有运费怎么退？");
    store([more]);
    const merged = queueMention(app, group, [more], "ou_owner")!;
    expect(getRun(app, merged.id).input.messageIds).toEqual([at.message_id, more.message_id]);
    expect(r.kind).toBe("mention");
    const sourceId = one<{ source_id: string }>(app.db, "select source_id from lark_messages where message_id = ?", at.message_id)!.source_id;
    expect(handedToMentions(app, [sourceId]).length).toBeGreaterThanOrEqual(2);
    const p2p = msg("在吗，问个事", { chat_id: "oc_p2p", mentions: [] });
    store([p2p], "oc_p2p");
    expect(queueMention(app, { id: "oc_p2p", name: "小王", kind: "p2p" }, [p2p], "ou_owner")).not.toBeNull();
    app.config.mentions.p2p = false;
    expect(queueMention(app, { id: "oc_p2p", name: "小王", kind: "p2p" }, [msg("在吗", { chat_id: "oc_p2p", mentions: [] })], "ou_owner")).toBeNull();
    app.config.mentions.p2p = true;
    app.config.mentions.enabled = false;
    expect(queueMention(app, group, [msg("@勒 再问一次")], "ou_owner")).toBeNull();
    app.config.mentions.enabled = true;
    run(app.db, "update runs set status = 'cancelled' where kind = 'mention' and status = 'queued'");
    app.config.mentions.delayMinutes = 0;
  });

  it("a message the owner already read costs no model call", async () => {
    useDecision(true);
    const calls = decision.calls;
    const m = msg("@勒 这个接口谁负责？", { thread_id: "omt_read" });
    store([m]);
    read.add(m.message_id);
    const done = await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id);
    expect(done.quiet).toBe(true);
    expect(decision.calls).toBe(calls);
  }, 30000);

  it("the decision model triages: ignore, a short reminder, or a handling by the assistant; the triage is on the run", async () => {
    useDecision(true);
    decision.action = "ignore";
    const a = msg("@所有人 周五团建", { thread_id: "omt_a" });
    store([a]);
    const ignored = await waitForRun(app, queueMention(app, group, [a], "ou_owner")!.id);
    expect(ignored.quiet).toBe(true);
    expect(ignored.output.triage).toMatchObject({ action: "ignore", by: "决策模型" });
    expect(notifiedBy(ignored.id)).toBeUndefined();
    const event = one<{ data: string }>(app.db, "select data from run_events where run_id = ? and json_extract(data, '$.triage') is not null", ignored.id);
    expect(JSON.parse(event!.data).text).toContain("分诊：不用管");
    // What the decision model read: the message, who sent it, who could take it.
    const material = ignored.output.material as Record<string, string>;
    expect(Object.keys(material)).toEqual(expect.arrayContaining(["会话", "发送人", "可以交给", "现在"]));

    decision.action = "notify";
    const b = msg("@勒 周五下午评审，记得来", { thread_id: "omt_b" });
    store([b]);
    const told = await waitForRun(app, queueMention(app, group, [b], "ou_owner")!.id);
    expect(notifiedBy(told.id)!.title).toBe("小王 在「项目 A 讨论群」找你");
    expect(told.output.handleRun).toBeUndefined();

    decision.action = "handle";
    const c = msg("@勒 退款按什么口径算？", { thread_id: "omt_c" });
    store([c]);
    const triaged = await waitForRun(app, queueMention(app, group, [c], "ou_owner")!.id);
    const h = handlingOf(triaged.id);
    expect(h.kind).toBe("agent");
    expect(h.input.spec).toBe("assistant");
    // The assistant as the owner, every space the owner can read, no coding or rules, nothing to post.
    expect(h.input.assistantScope).toMatchObject({ spaces: null, userId: OWNER, lark: { chats: [] } });
    expect((h.input.assistantScope as { denyTools: string[] }).denyTools).toEqual(expect.arrayContaining(["delegate_code", "save_rule", "run_agent"]));
    const done = await waitForRun(app, h.id);
    expect(done.status).toBe("done");
    const n = notifiedBy(h.id)!;
    expect(n.title).toBe("小王问退款口径：按未发货行算，可以直接回");
    expect(n.body).toContain("（读了原件）");
  }, 90000);

  it("a handling's tools: what the assistant reads with, without coding, rules or posting", () => {
    const prep = prepareRun(app, { actor: { role: "assistant" }, spaceId: "personal", spaces: null, denyTools: MENTION_DENY, addTools: mentionTools({ reply: "draft" } as MentionInfo), userId: OWNER, runId: null, lark: { chats: [] } });
    const tools = [...(toolContextForToken(app, prep.token)!.tools ?? [])];
    expect(tools).toEqual(expect.arrayContaining(["search", "read_source", "list_items", "upsert_item", "notify", "stay_quiet", "reply_to_asker"]));
    for (const t of ["delegate_code", "save_rule", "set_chat_watch", "run_agent", "lark_write"]) expect(tools).not.toContain(t);
    expect(mentionTools({ reply: "off" } as MentionInfo)).not.toContain("reply_to_asker");
  });

  it("without a decision model: the general model triages, or the setting's fixed answer", async () => {
    useDecision(false);
    app.config.agents.default = "triage-notify";
    const m = msg("@勒 周五评审行吗", { thread_id: "omt_g" });
    store([m]);
    const r = await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id);
    expect(r.output.triage).toMatchObject({ action: "notify", what: "约周五评审", by: "通用模型" });
    expect(notifiedBy(r.id)!.title).toBe("小王 在「项目 A 讨论群」找你：约周五评审");
    app.config.agents.default = "handle";
    app.config.mentions.noDecision = "notify";
    const m2 = msg("@勒 看下这个", { thread_id: "omt_g2" });
    store([m2]);
    const r2 = await waitForRun(app, queueMention(app, group, [m2], "ou_owner")!.id);
    expect(r2.output.triage).toMatchObject({ action: "notify", by: "设置" });
    app.config.mentions.noDecision = "general";
  }, 60000);

  it("the short reminder goes out when the handling says nothing, fails or runs too long; not when it stays quiet", async () => {
    useDecision(true);
    decision.action = "handle";
    const go = async (profile: string, text: string, topic: string) => {
      app.config.agents.default = profile;
      const m = msg(text, { thread_id: topic });
      store([m]);
      const t = await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id);
      return waitForRun(app, String(t.output.handleRun));
    };
    const quiet = await go("handle-quiet", "@勒 群公告：周五发版", "omt_q");
    expect(quiet.quiet).toBe(true);
    expect(notifiedBy(quiet.id)).toBeUndefined();
    const silent = await go("handle-silent", "@勒 线上报错了，帮忙看下", "omt_s");
    expect(notifiedBy(silent.id)!.body).toContain("线上报错了");
    const died = await go("handle-dies", "@勒 发布单要你审批", "omt_d");
    expect(died.status).toBe("failed");
    expect(died.error).toContain("已发出简短提醒");
    expect(notifiedBy(died.id)!.body).toContain("发布单要你审批");
    app.config.mentions.timeoutMinutes = 0.05;
    const late = await go("handle-hangs", "@勒 能帮忙看下这个权限吗", "omt_h");
    expect(late.status).toBe("failed");
    expect(late.error).toContain("超过");
    expect(notifiedBy(late.id)!.body).toContain("权限");
    app.config.mentions.timeoutMinutes = 10;
    app.config.agents.default = "handle";
  }, 120000);

  it("the same person in the same topic: no second triage, the handling carries on", async () => {
    useDecision(true);
    decision.action = "handle";
    const m = msg("@勒 退款单 123 怎么算？", { thread_id: "omt_f" });
    store([m]);
    const first = handlingOf((await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id)).id);
    await waitForRun(app, first.id);
    const calls = decision.calls;
    const m2 = msg("@勒 补充：是部分发货的", { thread_id: "omt_f" });
    store([m2]);
    const again = await waitForRun(app, queueMention(app, group, [m2], "ou_owner")!.id);
    expect(decision.calls).toBe(calls);
    const next = getRun(app, String(again.output.handleRun));
    expect(next.input.resumeFromRun).toBe(first.id);
    await waitForRun(app, next.id);
  }, 90000);

  it("daily limits: past them, the short reminder", async () => {
    useDecision(true);
    const calls = decision.calls;
    app.config.mentions.perDay.triage = mentionUsage(app).triage;
    const m = msg("@勒 有空吗", { thread_id: "omt_cap" });
    store([m]);
    const r = await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id);
    expect(decision.calls).toBe(calls);
    expect(notifiedBy(r.id)!.body).toContain("分诊次数用完了");
    app.config.mentions.perDay.triage = 80;
  }, 30000);

  it("the settings moved from lark.mentions to mentions (the old file is carried over)", () => {
    // This test's config.json still has them under lark.mentions.
    expect(app.config.mentions.enabled).toBe(true);
    expect((app.config.lark as Record<string, unknown>).mentions).toBeUndefined();
    const raw = { lark: { appId: "cli_x", mentions: { enabled: false, guidance: "小王找我的都提醒", reply: { group: "draft", p2p: "off", p2pVia: "signed" } } } };
    expect(moveOldSettings(raw)).toEqual({ lark: { appId: "cli_x" }, mentions: { enabled: false, guidance: "小王找我的都提醒", reply: { lark: { group: "draft", p2p: "off", p2pVia: "signed" } } } });
    // Already in the new place: the new one stands, the old one goes.
    expect(moveOldSettings({ lark: { mentions: { enabled: false } }, mentions: { enabled: true } })).toEqual({ lark: {}, mentions: { enabled: true } });
  });

  const ruleEvent = (m: LarkMessage): RuleEvent => ({
    key: `lark:${m.message_id}`,
    kind: "message",
    at: new Date().toISOString(),
    chat: group,
    sender: { id: m.sender!.id, name: m.sender!.name!, kind: "user" },
    message: { id: m.message_id, text: String(m.content), type: "text", mentionsOwner: true, mentionsBot: false, topicId: m.thread_id ?? null, cardTitle: null },
    via: "test",
  });

  it("rules come first: a rule that fired on the message, whatever its actions, or waits on it, and this steps aside", async () => {
    useDecision(true);
    decision.action = "handle";
    const calls = decision.calls;
    // Only a notification, no agent: still the rule's.
    const told = saveRule(app, { name: "被 @ 就通知", description: "有人 @ 我就通知我", enabled: true, conditions: { field: "message.mentionsOwner", op: "is", value: true }, judge: "code", actions: [{ type: "notify" }] });
    const a = msg("@勒 周会改到三点", { thread_id: "omt_rule1" });
    store([a]);
    await dispatchRuleEvent(app, ruleEvent(a));
    const first = await waitForRun(app, queueMention(app, group, [a], "ou_owner")!.id);
    expect(first.quiet).toBe(true);
    expect(first.output.summary).toContain("规则「被 @ 就通知」处理了");
    expect(decision.calls).toBe(calls);
    deleteRule(app, told.id);

    // A rule waiting for someone to answer (longer than this waits): this steps aside meanwhile.
    const waits = saveRule(app, { name: "十分钟没人回", description: "有人 @ 我，10 分钟没人回就交给助手", enabled: true, trigger: { event: "message", once: "event", waitMinutes: 10, unless: ["answered"] }, conditions: { field: "message.mentionsOwner", op: "is", value: true }, judge: "code", actions: [{ type: "agent", spec: "assistant", task: "先查", ownTopic: false, reply: "none" }] });
    const b = msg("@勒 退款口径？", { thread_id: "omt_rule2" });
    store([b]);
    await dispatchRuleEvent(app, ruleEvent(b));
    const second = await waitForRun(app, queueMention(app, group, [b], "ou_owner")!.id);
    expect(second.output.summary).toContain("规则「十分钟没人回」在等着处理");
    expect(decision.calls).toBe(calls);
    // Its wait ending with nothing done (the model said no): no longer the rule's.
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(ruleClaim(app, `lark:${b.message_id}`, "chat:oc_team", since)).toMatchObject({ waiting: true });
    run(app.db, "update runs set status = 'done' where kind = 'rule-fire' and json_extract(input, '$.ruleId') = ?", waits.id);
    expect(ruleClaim(app, `lark:${b.message_id}`, "chat:oc_team", since)).toBeNull();
    deleteRule(app, waits.id);

    // A rule not matching the message is not a claim.
    const other = saveRule(app, { name: "报警卡片", description: "报警卡片通知我", enabled: true, conditions: { field: "message.type", op: "equals", value: "interactive" }, judge: "code", actions: [{ type: "notify" }] });
    const c = msg("@勒 有空吗", { thread_id: "omt_rule3" });
    store([c]);
    await dispatchRuleEvent(app, ruleEvent(c));
    expect(ruleClaim(app, `lark:${c.message_id}`, "chat:oc_team", since)).toBeNull();
    deleteRule(app, other.id);
  }, 60000);

  it("while the rules are still judging the message, it waits for them", async () => {
    const m = msg("@勒 看下这个", { thread_id: "omt_judging" });
    store([m]);
    startJudging(`lark:${m.message_id}`);
    try {
      const r = await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id);
      expect(r.output.summary).toContain("规则还在判断");
      const again = one<{ id: string; input: string }>(app.db, "select id, input from runs where kind = 'mention' and status = 'queued' and json_extract(input, '$.topicId') = 'omt_judging'")!;
      expect(JSON.parse(again.input).waited).toBe(1);
      run(app.db, "update runs set status = 'cancelled' where id = ?", again.id);
    } finally {
      endJudging(`lark:${m.message_id}`);
    }
  });

  it("answering the asker: off refuses; in a group the bot replies in the topic, brought in when missing; audited", async () => {
    app.config.lark.enabled = true;
    await expect(replyToAsker(app, handling({ reply: "off" }), "好的")).rejects.toThrow(/没有打开/);
    botIn = false;
    forgetChatBots("oc_team");
    const id = handling({ reply: "auto" });
    expect(await replyToAsker(app, id, "周四可以上线。")).toContain("已回复对方");
    expect(cli.some((a) => a.includes("chat.members"))).toBe(true);
    expect(sent[0]).toMatchObject({ to: `reply:${(getRun(app, id).input.mention as MentionInfo).lastMessageId}`, inThread: true });
    expect(sent[0].content).toContain("周四可以上线");
    expect(getRun(app, id).output.mentionReply).toMatchObject({ via: "group", by: "auto" });
    expect(one(app.db, "select 1 from audit_events where action = 'lark.mention-reply' and json_extract(detail, '$.runId') = ?", id)).toBeTruthy();
    await expect(replyToAsker(app, id, "再说一次")).rejects.toThrow(/已经回复过/);
    // The bot is there now: no invitation.
    cli.length = 0;
    await replyToAsker(app, handling({ reply: "auto" }), "好的");
    expect(cli.some((a) => a.includes("chat.members"))).toBe(false);
  });

  it("a private chat: a group of the owner, them and the bot (made once), or the owner's own signed reply", async () => {
    app.config.lark.enabled = true;
    const p2p = { chatId: "oc_p2p2", chatKind: "p2p" as const, chatName: "小王", reply: "auto" as const };
    app.config.mentions.reply.lark.p2pVia = "group";
    await replyToAsker(app, handling(p2p), "我看一下");
    await replyToAsker(app, handling(p2p), "看完了");
    expect(cli.filter((a) => a.includes("+chat-create"))).toHaveLength(1);
    expect(sent.every((s) => s.to.startsWith("oc_made"))).toBe(true);
    app.config.mentions.reply.lark.p2pVia = "signed";
    const id = handling(p2p);
    await replyToAsker(app, id, "下午给你结论");
    const send = cli.find((a) => a.includes("+messages-send"))!;
    expect(send).toEqual(expect.arrayContaining(["--as", "user", "--chat-id", "oc_p2p2"]));
    expect(send[send.indexOf("--markdown") + 1]).toContain(app.config.lark.commands.signature);
    expect(getRun(app, id).output.mentionReply).toMatchObject({ via: "signed" });
    app.config.mentions.reply.lark.p2pVia = "group";
  });

  it("draft: held until the handling ends, then one card with the reminder; sent edited, or dropped", async () => {
    app.config.lark.enabled = true;
    run(app.db, "insert into kv(key,value) values('lark_owner_chat','oc_owner') on conflict(key) do update set value = excluded.value");
    botIn = true;
    forgetChatBots("oc_team");
    const id = handling({ reply: "draft" });
    // Nothing goes out while the handling runs: no draft card ahead of the reminder.
    expect(await replyToAsker(app, id, "周四可以上线。")).toContain("附在给本人的提醒下面");
    expect(sent).toHaveLength(0);
    expect(getRun(app, id).output.mentionReply).toEqual({ pending: "周四可以上线。" });
    // Drafted again: the later one stands.
    await replyToAsker(app, id, "周四下午可以上线。");
    expect(getRun(app, id).output.mentionReply).toEqual({ pending: "周四下午可以上线。" });
    // The reminder's card carries it (the Feishu sink): one card, reminder on top, the draft under it.
    const m = getRun(app, id).input.mention as MentionInfo;
    const r = await draftMentionReply(app, id, m, "周四下午可以上线。", { title: "小王问上线时间：周四可以", markdown: "查了排期，周四下午能上。" }, { chatId: "oc_owner" });
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain("小王问上线时间：周四可以");
    expect(sent[0].content).toContain("拟好的回复");
    const inter = one<{ id: string; payload: string }>(app.db, "select id, payload from card_interactions where id = ?", r.id)!;
    const decided = await decideMentionReply(app, JSON.parse(inter.payload), true, "周四下午三点可以上线。", "本人");
    expect(sent[1].content).toContain("周四下午三点可以上线");
    // The decided card keeps what the reminder said.
    expect(JSON.stringify(decided)).toContain("查了排期，周四下午能上。");
    expect(one(app.db, "select 1 from audit_events where action = 'lark.mention-reply' and actor = 'owner' and json_extract(detail, '$.runId') = ?", id)).toBeTruthy();
    // On its own card (the handling told the owner itself): dropped.
    const dropped = handling({ reply: "draft" });
    const d = await draftMentionReply(app, dropped, getRun(app, dropped).input.mention as MentionInfo, "算了");
    const i2 = one<{ payload: string }>(app.db, "select payload from card_interactions where id = ?", d.id)!;
    const card = await decideMentionReply(app, JSON.parse(i2.payload), false, null, "本人");
    expect(JSON.stringify(card)).toContain("决定不发");
    expect(sent).toHaveLength(3);
  });

  it("a drafted reply rides on the reminder; staying quiet drops it", async () => {
    app.config.lark.enabled = true;
    botIn = true;
    forgetChatBots("oc_team");
    useDecision(true);
    decision.action = "handle";
    decision.progress = 0.1;
    app.config.mentions.reply.lark.group = "draft";
    app.config.agents.default = "handle-reply";
    const m = msg("@勒 退款口径定了吗？", { thread_id: "omt_d1" });
    store([m]);
    const h = handlingOf((await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id)).id);
    await waitForRun(app, h.id);
    expect(getRun(app, h.id).output.mentionReply).toEqual({ pending: "按未发货的行算，已发货的不退。" });
    expect(JSON.parse(notifiedBy(h.id)!.context).replyDraft).toBe("按未发货的行算，已发货的不退。");
    // No card of the handling's own: the reminder (the channel's sink) is the one message.
    expect(one(app.db, "select 1 from card_interactions where purpose = 'mention-reply' and run_id = ?", h.id)).toBeUndefined();
    app.config.agents.default = "handle-reply-quiet";
    const m2 = msg("@勒 退款口径？", { thread_id: "omt_d2" });
    store([m2]);
    const h2 = handlingOf((await waitForRun(app, queueMention(app, group, [m2], "ou_owner")!.id)).id);
    await waitForRun(app, h2.id);
    expect(getRun(app, h2.id).output.mentionReply).toEqual({ dropped: "按未发货的行算。" });
    expect(notifiedBy(h2.id)).toBeUndefined();
    expect(one(app.db, "select 1 from card_interactions where purpose = 'mention-reply' and run_id = ?", h2.id)).toBeUndefined();
    app.config.mentions.reply.lark.group = "off";
    app.config.agents.default = "handle";
  }, 90000);

  it("a handling replies through the tool; auto without the triage's go-ahead becomes a draft", async () => {
    app.config.lark.enabled = true;
    botIn = true;
    forgetChatBots("oc_team");
    useDecision(true);
    decision.action = "handle";
    app.config.mentions.reply.lark.group = "auto";
    app.config.agents.default = "handle-reply";
    decision.progress = 0.9;
    const m = msg("@勒 退款按什么口径？", { thread_id: "omt_r" });
    store([m]);
    const h = handlingOf((await waitForRun(app, queueMention(app, group, [m], "ou_owner")!.id)).id);
    expect((h.input.mention as MentionInfo).reply).toBe("auto");
    await waitForRun(app, h.id);
    expect(getRun(app, h.id).output.mentionReply).toMatchObject({ via: "group", by: "auto" });
    expect(notifiedBy(h.id)!.body).toContain("已替你回复对方");
    decision.progress = 0.1;
    const m2 = msg("@勒 能给我开权限吗？", { thread_id: "omt_r2" });
    store([m2]);
    const h2 = handlingOf((await waitForRun(app, queueMention(app, group, [m2], "ou_owner")!.id)).id);
    expect((h2.input.mention as MentionInfo).reply).toBe("draft");
    await waitForRun(app, h2.id);
    app.config.mentions.reply.lark.group = "off";
    app.config.agents.default = "handle";
  }, 90000);

  it("the same chat messages are not notified about twice; a new state replaces the old one", () => {
    const m = msg("@勒 这周能上线吗？");
    const s = store([m]);
    const line = one<{ line: number }>(app.db, "select line from lark_message_lines where message_id = ?", m.message_id)!.line;
    const ref = `src:${s.id}#L${line}`;
    const first = notify(app, { title: "小王问上线时间", body: "…", sourceRefs: [ref] });
    expect(() => notify(app, { title: "小王追问上线", body: "…", sourceRefs: [ref] })).toThrow(/已经提醒过本人/);
    expect(notify(app, { title: "小王问上线时间：周四可上", body: "…", sourceRefs: [ref], replaces: first.id }).replaces).toBe(first.id);
    notify(app, { title: "同步完成", body: "…" });
    notify(app, { title: "同步完成", body: "…" });
  });
});
