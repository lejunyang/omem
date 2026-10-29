import { captureSpace } from "../core/capture-space.ts";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, now } from "../core/util.ts";
import { runActions } from "./actions.ts";
import { aiJudge, eventSummary } from "./compile.ts";
import { describe, evaluate, eventReader, type ChatBot } from "./conditions.ts";
import { meetingConfirmation } from "./meeting.ts";
import { createRun } from "../agents/runs.ts";
import { discussion, discussionText, engagement, followedTopic, unfollowTopic, type Followed } from "./context.ts";
import { addressed, claimEvent, deleteRule, listRules, recordFiring } from "./store.ts";
import { ruleInputSchema, type Rule, type RuleEvent, type RuleInput } from "./types.ts";

/**
 * Hand one event to every enabled rule that listens for it. Sources call this and forget it:
 * nothing here throws back at the capture or the bot.
 */
export async function dispatchRuleEvent(app: App, e: RuleEvent) {
  let rules: Rule[];
  try {
    rules = listRules(app, { enabledOnly: true }).filter((r) => r.trigger.event === e.kind && (!r.spaceId || !e.chat || r.spaceId === captureSpace(app, e.chat.id)));
  } catch {
    return;
  }
  for (const rule of rules) {
    try {
      await consider(app, rule, e);
    } catch (err) {
      console.warn(`[omem] 规则「${rule.name}」处理失败：${(err as Error).message}`);
    }
  }
}

/** Several events (a capture batch) in order. */
export async function dispatchRuleEvents(app: App, events: RuleEvent[]) {
  if (!events.length || !listRules(app, { enabledOnly: true }).length) return;
  for (const e of events) await dispatchRuleEvent(app, e);
}

/** A schedule rule's tick (scheduler kind "rule"). */
export async function fireScheduledRule(app: App, ruleId: string) {
  const rule = listRules(app, { enabledOnly: true }).find((r) => r.id === ruleId);
  if (!rule || rule.trigger.event !== "schedule") return;
  const at = new Date().toISOString();
  await consider(app, rule, { key: `schedule:${at.slice(0, 16)}`, kind: "schedule", at, via: "schedule" }).catch((err) => console.warn(`[omem] 规则「${rule.name}」处理失败：${(err as Error).message}`));
}

function keyFor(rule: Rule, e: RuleEvent) {
  return rule.trigger.once === "chat" && e.chat ? `chat:${e.chat.id}` : e.key;
}

async function consider(app: App, rule: Rule, e: RuleEvent) {
  if (rule.temporary && rule.temporary.expiresAt < e.at) return;
  // Someone asked the bot directly: it answers, the rules stay out of it.
  if (e.kind === "message" && addressed(app, e.key)) return;
  // A topic this rule's silent agent spoke in: new messages there go back to it.
  const followed = e.kind === "message" && e.chat ? followedTopic(app, e.chat.id, e.message?.topicId) : null;
  if (followed?.ruleId === rule.id) return continueFollowed(app, rule, followed, e);
  const key = keyFor(rule, e);
  if (one(app.db, "select 1 from rule_handled where rule_id = ? and key = ?", rule.id, key)) return;
  const waits = rule.trigger.waitMinutes > 0 || rule.trigger.unless.length > 0;
  // Without a wait or an engagement check the model judges right away, as before; with them the
  // conditions narrow it down now and the model looks at the discussion when it is time to act.
  const d = await judge(app, rule, e, { ai: waits ? false : undefined });
  if (!d.match) return;
  // Both the bot and the capture may bring the same message: whoever claims it first fires.
  if (!claimEvent(app, rule.id, key)) return;
  if (rule.trigger.waitMinutes > 0) {
    createRun(app, {
      kind: "rule-fire",
      spaceId: rule.spaceId ?? (e.chat ? captureSpace(app, e.chat.id) : "personal"),
      title: `规则「${rule.name}」：${rule.trigger.waitMinutes} 分钟后看有没有人回应`,
      input: { ruleId: rule.id, key, event: e },
      notBefore: new Date(Date.now() + rule.trigger.waitMinutes * 60_000).toISOString(),
    });
    return;
  }
  if (waits) {
    await act(app, rule, e, key);
    return;
  }
  const results = await runActions(app, rule, e, d.reason);
  recordFiring(app, { ruleId: rule.id, eventKey: key, summary: eventSummary(e), judgedBy: d.by, reason: d.reason, results });
  // A one-shot wake-up is done once it has woken someone.
  if (rule.temporary?.once) deleteRule(app, rule.id);
}

/** A waiting rule's time is up (run kind rule-fire). */
export async function fireAfterWait(app: App, ruleId: string, key: string, e: RuleEvent) {
  const rule = listRules(app, { enabledOnly: true }).find((r) => r.id === ruleId);
  if (!rule) return { summary: "规则已停用或删除，没有执行" };
  return { summary: await act(app, rule, e, key) };
}

/**
 * Time to act on a matched event: skip when the owner is already in the discussion or someone
 * answered (as the rule asks), let the model judge with the discussion in view, then run the actions
 * with the discussion attached. Returns what happened, for the run log.
 */
async function act(app: App, rule: Rule, e: RuleEvent, key: string) {
  const said = e.message ? await discussion(app, e) : [];
  const talk = discussionText(e, said);
  const skip = (why: string) => {
    recordFiring(app, { ruleId: rule.id, eventKey: key, summary: eventSummary(e), judgedBy: "code", reason: why, results: [{ action: "skip", ok: true, detail: why }] }, { skipped: true });
    return `跳过：${why}`;
  };
  const g = engagement(e, said);
  if (rule.trigger.unless.includes("owner-engaged") && g.ownerEngaged) return skip("本人已经在这段讨论里");
  if (rule.trigger.unless.includes("answered") && g.answered) return skip("已经有人回复");
  let by: Decision["by"] = "code";
  let reason = rule.conditions ? describe(rule.conditions) : "";
  if (rule.judge !== "code") {
    if (!takeAiBudget(rule.id)) return skip(`这一小时已请模型判断 ${AI_PER_HOUR} 次`);
    const v = await aiJudge(app, rule, e, talk);
    // Not a match is the usual answer for a model-judged rule: not logged, like before.
    if (!v?.match) return `模型判断不处理：${v?.reason ?? "没有给出判断"}`;
    by = rule.judge;
    reason = v.reason;
  }
  const results = await runActions(app, rule, e, reason, { discussion: talk });
  recordFiring(app, { ruleId: rule.id, eventKey: key, summary: eventSummary(e), judgedBy: by, reason, results });
  return results.map((r) => `${r.action}：${r.detail}`).join("；");
}

/**
 * A new message in a topic this rule's silent agent spoke in (a question it asked, an answer it
 * gave): the agent picks the topic up again, in its own session, a minute later so a burst of
 * replies arrives together. Once the owner speaks there it is the owner's, and the agent lets go.
 */
async function continueFollowed(app: App, rule: Rule, f: Followed, e: RuleEvent) {
  const key = `follow:${e.key}`;
  if (!claimEvent(app, rule.id, key)) return;
  if (e.sender?.kind === "owner") {
    unfollowTopic(app, f.chatId, f.topicId);
    const why = "本人接手了这个话题，Agent 不再跟进";
    recordFiring(app, { ruleId: rule.id, eventKey: key, summary: eventSummary(e), judgedBy: "code", reason: why, results: [{ action: "skip", ok: true, detail: why }] }, { skipped: true });
    return;
  }
  const lane = `follow:${f.chatId}#${f.topicId}`;
  // One pickup at a time: a queued one reads this message too.
  if (one(app.db, "select 1 from runs where lane = ? and status = 'queued'", lane)) return;
  const said = await discussion(app, e);
  const { followUp } = await import("./actions.ts");
  const r = await followUp(app, rule, f, e, discussionText(e, said), lane);
  recordFiring(app, { ruleId: rule.id, eventKey: key, summary: eventSummary(e), judgedBy: "code", reason: "Agent 跟进的话题有新消息", results: [r] });
}

type Decision = { match: boolean; by: "code" | "ai" | "code+ai" | "limit"; reason: string };

/** Model calls a rule may make in an hour when it judges by the model alone (or after conditions). */
const AI_PER_HOUR = 60;
const aiBudget = new Map<string, { hour: number; used: number }>();
function takeAiBudget(ruleId: string) {
  const hour = Math.floor(Date.now() / 3600_000);
  const b = aiBudget.get(ruleId);
  if (!b || b.hour !== hour) return aiBudget.set(ruleId, { hour, used: 1 }), true;
  if (b.used >= AI_PER_HOUR) return false;
  b.used++;
  return true;
}

export async function judge(app: App, rule: Pick<Rule, "id" | "description" | "conditions" | "judge">, e: RuleEvent, opts: { ai?: boolean } = {}): Promise<Decision> {
  // A schedule tick has nothing to look at: it fires (the agent it starts does the looking).
  if (e.kind === "schedule") return { match: true, by: "code", reason: "定时" };
  const read = eventReader(e, { chatBots: (id) => chatBots(app, id), ownAppId: app.config.lark.appId || undefined });
  if (rule.judge !== "ai") {
    // A meeting rule without conditions is about every meeting the owner joins.
    if (!rule.conditions && e.kind === "meeting") {
      if (rule.judge === "code") return { match: true, by: "code", reason: "每场会议" };
    } else {
      if (!rule.conditions || !(await evaluate(rule.conditions, read))) return { match: false, by: "code", reason: "" };
      if (rule.judge === "code") return { match: true, by: "code", reason: describe(rule.conditions) };
    }
  }
  if (opts.ai === false) return { match: true, by: rule.judge, reason: "（试运行没有请模型判断）" };
  if (!takeAiBudget(rule.id)) return { match: false, by: "limit", reason: `这一小时已请模型判断 ${AI_PER_HOUR} 次` };
  const v = await aiJudge(app, rule as Rule, e);
  return v ? { match: v.match, by: rule.judge, reason: v.reason } : { match: false, by: rule.judge, reason: "模型没有给出判断" };
}

// ---- chat facts read on demand -----------------------------------------------------------

const botsCache = new Map<string, { at: number; bots: ChatBot[] | null }>();
/**
 * The bots in a chat (app id and name), read with the owner's lark-cli once a day per chat.
 * Inviting omem's bot forgets the chat's entry so the next check sees it.
 */
export async function chatBots(app: App, chatId: string): Promise<ChatBot[] | null> {
  const c = botsCache.get(chatId);
  if (c && Date.now() - c.at < 24 * 3600_000) return c.bots;
  let out: ChatBot[] | null = null;
  try {
    const { larkCli } = await import("../channels/lark-cli.ts");
    const v = await larkCli(["im", "+chat-members-list", "--chat-id", chatId, "--member-types", "bot", "--page-all", "--as", "user", "--format", "json"], 60_000);
    const bots: { app_id?: string; name?: string; bot_name?: string }[] = v?.data?.bots ?? v?.bots ?? [];
    out = bots.map((b) => ({ appId: b.app_id ? String(b.app_id) : undefined, name: String(b.name ?? b.bot_name ?? "") })).filter((b) => b.name || b.appId);
  } catch {
    out = null;
  }
  botsCache.set(chatId, { at: Date.now(), bots: out });
  return out;
}
export function forgetChatBots(chatId: string) {
  botsCache.delete(chatId);
}

// ---- trying a rule on what was captured -------------------------------------------------------

type MessageRow = { message_id: string; chat_id: string; thread_id: string | null; sender_id: string | null; sender_name: string; sender_kind: string; msg_type: string; content: string; create_ms: number; mentions: string };

/** An event from a stored message (the capture keeps lark-cli's ids; `owner` is the owner's there). */
export function eventFromRow(app: App, r: MessageRow, owner?: string | null): RuleEvent {
  const chat = one<{ name: string; chat_mode: string }>(app.db, "select name, chat_mode from lark_cursors where chat_id = ?", r.chat_id);
  const email = r.sender_id ? one<{ email: string | null }>(app.db, "select email from lark_people where cli_open_id = ?", r.sender_id)?.email ?? null : null;
  const mentions = json<{ id: string }[]>(r.mentions, []).map((m) => m.id);
  return {
    key: `lark:${r.message_id}`,
    kind: "message",
    at: new Date(r.create_ms).toISOString(),
    chat: { id: r.chat_id, name: chat?.name ?? r.chat_id, kind: chat?.chat_mode === "p2p" ? "p2p" : "group" },
    sender: { id: r.sender_id ?? undefined, name: r.sender_name, email, kind: r.sender_kind === "owner" ? "owner" : r.sender_kind === "app" ? "bot" : "user" },
    message: {
      id: r.message_id,
      text: r.content,
      type: r.msg_type,
      mentionsOwner: !!owner && mentions.includes(owner),
      mentionsBot: false,
      topicId: r.thread_id,
      cardTitle: /<card title="([^"]*)"/.exec(r.content)?.[1] ?? null,
    },
    via: "test",
  };
}

/**
 * Run a rule (saved or not) over recent captured messages without firing anything: which would
 * match and why. Rules that need the model are tried on a few of the condition matches only.
 */
export async function testRule(app: App, input: RuleInput, opts: { chatId?: string; days?: number; limit?: number; ai?: boolean } = {}) {
  const rule = ruleInputSchema.parse({ ...input, enabled: false });
  if (rule.trigger.event === "meeting") return testMeetingRule(app, rule);
  if (rule.trigger.event !== "message") return { checked: 0, matches: [], note: "只有“新消息”规则能拿最近的消息试" };
  const since = Date.now() - (opts.days ?? 3) * 86400_000;
  const rows = all<MessageRow>(
    app.db,
    `select message_id, chat_id, thread_id, sender_id, sender_name, sender_kind, msg_type, content, create_ms, mentions from lark_messages
     where create_ms > ? and sender_kind != 'system' ${opts.chatId ? "and chat_id = ?" : ""} order by create_ms desc limit ?`,
    since,
    ...(opts.chatId ? [opts.chatId] : []),
    Math.min(opts.limit ?? 500, 2000),
  );
  const { ownerOpenId } = await import("../channels/lark-personal.ts");
  const owner = rows.length ? await ownerOpenId().catch(() => undefined) : undefined;
  const matches: { messageId: string; chat: string; sender: string; text: string; at: string; reason: string; by: string }[] = [];
  let aiTried = 0;
  for (const r of rows) {
    const e = eventFromRow(app, r, owner);
    const wantsAi = rule.judge !== "code";
    const allowAi = !!opts.ai && wantsAi && aiTried < 5;
    if (rule.judge === "ai" && !allowAi) continue;
    const d = await judge(app, { ...rule, id: `test:${now()}` }, e, { ai: allowAi });
    if (allowAi && d.by !== "code") aiTried++;
    if (d.match) matches.push({ messageId: r.message_id, chat: e.chat!.name, sender: e.sender!.name, text: e.message!.text.slice(0, 200), at: e.at, reason: d.reason, by: d.by });
    if (matches.length >= 50) break;
  }
  return {
    checked: rows.length,
    matches,
    note: rule.judge === "ai" && !opts.ai ? "这条规则只交给模型判断：勾选“请模型判断”抽样试几条" : rule.judge === "code+ai" && !opts.ai ? "列出的是条件命中的消息，还要模型确认" : "",
  };
}

/** A meeting rule tried on the meetings omem saw the owner join recently (no model, nothing fired). */
async function testMeetingRule(app: App, rule: Rule | ReturnType<typeof ruleInputSchema.parse>) {
  const { recentMeetingEvents } = await import("../channels/lark-meetings.ts");
  const events = recentMeetingEvents(app, 30);
  const matches: { messageId: string; chat: string; sender: string; text: string; at: string; reason: string; by: string; action?: string }[] = [];
  const action = rule.actions.find((a) => a.type === "meeting-bot");
  for (const e of events) {
    const d = await judge(app, { ...rule, id: `test:${now()}` }, e, { ai: false });
    if (d.match) matches.push({ messageId: e.meeting!.id, chat: e.meeting!.title || "（无标题会议）", sender: e.meeting!.participantCount === null ? "人数未知" : `${e.meeting!.participantCount ?? e.meeting!.participants.length} 人`, text: e.meeting!.participants.join("、"), at: e.at, reason: d.reason, by: d.by, ...(action ? { action: (await meetingConfirmation(action, e)).reason } : {}) });
  }
  return { checked: events.length, matches, note: events.length ? (rule.judge !== "code" ? "列出的是条件命中的会议，还要模型确认" : "") : "还没有记录到你加入过的会议（启用会议规则后，omem 才开始留意你入会）" };
}
