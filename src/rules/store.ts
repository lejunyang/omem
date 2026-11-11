import type { App } from "../core/app.ts";
import { getSpace } from "../core/spaces.ts";
import { getThread } from "../agents/threads.ts";
import { all, one, run } from "../core/db.ts";
import { deleteSchedule, upsertSchedule } from "../core/scheduler.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import { readAgentSpec } from "../agents/specs.ts";
import { validateExecution } from "../agents/execution.ts";
import { fieldsOf } from "./conditions.ts";
import { checkWaitRule } from "./fast.ts";
import { ruleInputSchema, type Rule, type RuleAction, type RuleInput, type Temporary } from "./types.ts";
import { OWNER } from "../core/users.ts";
import { moveRuleWorkFiles } from "../sources/work.ts";

type Row = {
  space_id: string | null;
  conversation_id: string | null;
  id: string;
  name: string;
  description: string;
  enabled: number;
  trigger: string;
  conditions: string | null;
  judge: string;
  judge_with: string | null;
  actions: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  hits: number;
  last_fired_at: string | null;
  temporary: string | null;
};

const toRule = (r: Row): Rule => ({
  id: r.id,
  spaceId: r.space_id ?? undefined,
  conversationId: r.conversation_id ?? undefined,
  name: r.name,
  description: r.description,
  enabled: !!r.enabled,
  trigger: { waitMinutes: 0, unless: [], ...json(r.trigger, { event: "message" as const, once: "event" as const }) },
  conditions: r.conditions ? json(r.conditions, null) : null,
  judge: r.judge as Rule["judge"],
  judgeWith: r.judge_with === "general" ? "general" : "decision",
  actions: json(r.actions, []),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  hits: r.hits,
  lastFiredAt: r.last_fired_at,
  temporary: r.temporary ? json(r.temporary, null) : null,
});

/** A document change has no chat or message: its fields, and actions that need no chat. */
function checkDocRule(r: ReturnType<typeof ruleInputSchema.parse>) {
  const doc = r.trigger.event === "doc";
  if (!doc && (r.trigger.docs?.length || r.trigger.pollMinutes)) throw new HttpError(400, "只有“文档变化”规则能列出要盯的文档");
  const fields = r.conditions ? fieldsOf(r.conditions) : [];
  if (!doc) {
    const docFields = fields.filter((f) => /^(doc|change)\./.test(f));
    if (docFields.length) throw new HttpError(400, `${[...new Set(docFields)].join("、")} 只用于“文档变化”规则`);
    return;
  }
  const bad = fields.filter((f) => !/^(doc|change)\./.test(f));
  if (bad.length) throw new HttpError(400, `文档变化规则只能用文档和变化的字段，不能用 ${[...new Set(bad)].join("、")}`);
  if (r.trigger.waitMinutes || r.trigger.unless.length) throw new HttpError(400, "文档变化规则没有群里的讨论：不能等待回应或按讨论跳过；要晚点再做用“延时”");
  const allowed = new Set(["notify", "delay", "check", "script"]);
  // Like a schedule: the agent may post only into the conversation the rule names (发到).
  if (r.actions.some((a) => !allowed.has(a.type) && !(a.type === "agent" && !a.ownTopic && a.reply !== "silent")))
    throw new HttpError(400, "文档变化规则没有群：只能交给 Agent（不开话题、不静默排查）、通知本人、延时、模型判断或执行脚本");
  if (!r.conversationId && r.actions.some((a) => a.type === "agent" && (a.reply !== "none" || a.failureTo === "chat")))
    throw new HttpError(400, "文档变化规则要回复时，先选发到哪个会话；不回复就选“只告诉我”");
}

/** A meeting has no chat or message; the meeting action needs a meeting. */
function checkMeetingRule(app: App, r: ReturnType<typeof ruleInputSchema.parse>) {
  const meeting = r.trigger.event === "meeting";
  if (!meeting && r.actions.some((a) => a.type === "meeting-bot")) throw new HttpError(400, "“拉机器人入会”只用于“我加入会议时”触发的规则");
  if (!meeting) return;
  if (r.actions.some((a) => a.type !== "meeting-bot" && a.type !== "notify" && !(a.type === "agent" && !a.ownTopic && a.reply === "none")))
    throw new HttpError(400, "会议规则没有群和消息：只能拉机器人入会、通知本人，或交给 Agent（只告诉我）");
  if (r.trigger.waitMinutes || r.trigger.unless.length) throw new HttpError(400, "会议规则不能等待回应或按讨论跳过");
  const bad = r.conditions ? fieldsOf(r.conditions).filter((f) => !f.startsWith("meeting.")) : [];
  if (bad.length) throw new HttpError(400, `会议规则只能用会议的字段，不能用 ${[...new Set(bad)].join("、")}`);
  for (const a of r.actions) {
    if (a.type !== "meeting-bot") continue;
    const known = new Set(["main", ...app.config.lark.bots.map((b) => b.id)]);
    const unknown = a.bots.filter((b) => !known.has(b));
    if (unknown.length) throw new HttpError(400, `没有这些飞书机器人：${unknown.join("、")}（main 是主机器人，其余写 lark.bots 的 id）`);
    if (a.answer && !a.bots.length) throw new HttpError(400, "在会中回答问题需要至少拉一个机器人进会");
    if (a.spec && a.spec !== "assistant") readAgentSpec(app, a.spec);
    if (a.space) getSpace(app, a.space);
  }
}

export function listRules(app: App, opts: { enabledOnly?: boolean } = {}): Rule[] {
  return all<Row>(app.db, `select * from rules ${opts.enabledOnly ? "where enabled = 1" : ""} order by created_at`).map(toRule);
}

export function getRule(app: App, id: string): Rule {
  const r = one<Row>(app.db, "select * from rules where id = ?", id);
  if (!r) throw new HttpError(404, "规则不存在");
  return toRule(r);
}

/** Create or replace a rule; checks it can work (conditions for code judging, a cron for schedules). */
/** `actor`: who saves it through the web or API; a script runs on this machine, so only the owner may write one. */
/**
 * `ownerAsked`: an agent saving the rule in a turn answering the owner's own message (save_rule), which
 * may set where it forwards to, as set_chat_watch may add the bot in such a turn.
 */
export function saveRule(app: App, input: RuleInput & { id?: string; temporary?: Temporary }, by: "user" | "agent" = "user", actor?: string, opts: { ownerAsked?: boolean } = {}): Rule {
  const r = ruleInputSchema.parse(input);
  if (r.actions.some((a) => a.type === "script") && (by !== "user" || actor !== OWNER || input.temporary))
    throw new HttpError(403, "带脚本的规则只能由本人在规则页保存：脚本在这台机器上执行");
  // 完全访问 is the owner's decision on the rules page; an agent saving the rule keeps what was there.
  if (by !== "user" || actor !== OWNER || input.temporary) {
    const before = input.id ? one<{ actions: string }>(app.db, "select actions from rules where id = ?", input.id) : undefined;
    const had = (before ? JSON.parse(before.actions) as RuleAction[] : []).filter((a) => a.type === "agent" && a.fullAccess).map((a) => (a as { spec: string }).spec);
    for (const a of r.actions) {
      if (a.type !== "agent") continue;
      if (a.fullAccess && !had.includes(a.spec)) throw new HttpError(403, "完全访问只能由本人在规则页打开：打开后这条规则的命令不进沙箱、不经审批");
      // Left out by an agent's edit: the owner's choice stays.
      if (a.fullAccess === undefined && had.includes(a.spec)) a.fullAccess = true;
    }
    // Where a rule forwards to (and may add the bot or make a group as the owner) is the owner's pick too.
    const target = (a: Extract<RuleAction, { type: "forward" }>) => (a.to.kind === "origin" ? "origin" : a.to.chatId);
    const targets = (before ? JSON.parse(before.actions) as RuleAction[] : []).flatMap((a) => (a.type === "forward" ? [target(a)] : []));
    for (const a of r.actions) if (a.type === "forward" && !targets.includes(target(a)) && !(opts.ownerAsked && !input.temporary)) throw new HttpError(403, "转发的目标要本人亲自指定（规则页，或本人在对话里要求的这一轮）：可能要以本人身份拉机器人进群或建群");
  }
  if (r.actions.some((a) => a.type === "forward") && r.trigger.event !== "message") throw new HttpError(400, "转发只用于“新消息”触发：要有一条消息可转发");
  for (const a of r.actions) if (a.type === "forward" && a.to.kind !== "origin" && !a.to.chatId) throw new HttpError(400, "转发要选一个目标会话");
  checkWaitRule(r);
  if (r.trigger.fast && r.trigger.event !== "message") throw new HttpError(400, "快速检查只用于新消息规则");
  if (r.actions.at(-1)?.type === "delay") throw new HttpError(400, "延时后面要有动作");
  if (r.actions.at(-1)?.type === "check") throw new HttpError(400, "模型判断后面要有动作：它决定后面的动作做不做");
  if (r.spaceId) getSpace(app, r.spaceId);
  if (r.conversationId && getThread(app, r.conversationId).userId !== "owner") throw new HttpError(403, "只能投递到本人的会话");
  for (const a of r.actions) {
    if (a.type === "agent" || a.type === "watch") {
      if (a.type === "agent" && a.space) getSpace(app, a.space);
      // The backend must exist and offer the model and effort (checked against its last detection).
      if (a.type === "agent" && a.ai) validateExecution(app, { ...a.ai, source: "user", reason: `规则「${r.name}」指定` });
    }
  }
  const prevTemp = input.id ? one<{ temporary: string | null }>(app.db, "select temporary from rules where id = ?", input.id)?.temporary : null;
  if (r.actions.some((a) => a.type === "wake") && !input.temporary && !prevTemp) throw new HttpError(400, "“唤醒”只用于 Agent 设的临时规则（wake_on_message）");
  // Every meeting the owner joins is a reasonable rule (the card asks first), so is every change of the
  // documents a rule lists; every message is not.
  const everyListedDoc = r.trigger.event === "doc" && !!r.trigger.docs?.length;
  if (r.judge !== "ai" && !r.conditions && r.trigger.event !== "schedule" && r.trigger.event !== "meeting" && !everyListedDoc)
    throw new HttpError(400, r.trigger.event === "doc" ? "文档变化规则要么列出盯哪些文档，要么写条件（或交给 AI 判断）" : "按条件判断需要条件；没有条件就选“交给 AI 判断”，或先从规则原话生成条件");
  if (r.trigger.event === "schedule" && !r.trigger.cron) throw new HttpError(400, "定时规则需要 cron，例如 0 9 * * 1-5");
  if (r.trigger.event === "schedule" && r.actions.some((a) => a.type === "invite-bot" || a.type === "capture" || a.type === "watch" || (a.type === "agent" && a.ownTopic)))
    throw new HttpError(400, "定时规则没有具体的群或消息：只能交给 Agent（不开话题）或通知本人");
  if (r.trigger.event === "schedule" && (r.trigger.waitMinutes || r.trigger.unless.length || r.actions.some((a) => a.type === "agent" && a.reply === "silent")))
    throw new HttpError(400, "定时规则没有具体的讨论：不能等待回应、不能按“本人已在处理/已有人回复”跳过，也不能静默排查");
  if (r.trigger.event === "schedule" && !r.conversationId && r.actions.some(a => a.type === "agent" && (["auto", "draft"].includes(a.reply) || a.failureTo === "chat"))) throw new HttpError(400, "定时规则要回复时，先选发到哪个会话；不回复就选“只告诉我”");
  checkMeetingRule(app, r);
  checkDocRule(r);
  const at = now();
  const id = input.id ?? newId("rule");
  const prev = input.id ? one<Row>(app.db, "select * from rules where id = ?", input.id) : undefined;
  run(
    app.db,
    `insert into rules(id, name, description, enabled, trigger, conditions, judge, judge_with, actions, created_by, created_at, updated_at, temporary, space_id, conversation_id) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(id) do update set name = excluded.name, description = excluded.description, enabled = excluded.enabled, trigger = excluded.trigger,
       conditions = excluded.conditions, judge = excluded.judge, judge_with = excluded.judge_with, actions = excluded.actions, updated_at = excluded.updated_at, temporary = coalesce(excluded.temporary, rules.temporary), space_id = excluded.space_id, conversation_id = excluded.conversation_id`,
    id,
    r.name,
    r.description,
    r.enabled ? 1 : 0,
    JSON.stringify(r.trigger),
    r.conditions ? JSON.stringify(r.conditions) : null,
    r.judge,
    r.judgeWith,
    JSON.stringify(r.actions),
    prev?.created_by ?? by,
    prev?.created_at ?? at,
    at,
    input.temporary ? JSON.stringify(input.temporary) : null,
    r.spaceId ?? null,
    r.conversationId ?? null,
  );
  // What earlier firings left (reports, lists it keeps) follows the rule into its new space.
  if (prev && r.spaceId && prev.space_id !== r.spaceId) moveRuleWorkFiles(app, id, r.spaceId);
  // A schedule rule runs from the scheduler like the built-in tasks (schedule id rule:<id>).
  if (r.trigger.event === "schedule") upsertSchedule(app, { id: `rule:${id}`, kind: "rule", cron: r.trigger.cron!, config: { ruleId: id }, enabled: r.enabled });
  else if (prev && JSON.parse(prev.trigger).event === "schedule") deleteSchedule(app, `rule:${id}`);
  queueMicrotask(() => app.emit({ type: "changed", entity: "rule", id, spaceId: r.spaceId }));
  return getRule(app, id);
}

export function deleteRule(app: App, id: string) {
  const rule = getRule(app, id);
  run(app.db, "delete from rules where id = ?", id);
  if (one(app.db, "select 1 from schedules where id = ?", `rule:${id}`)) deleteSchedule(app, `rule:${id}`);
  run(app.db, "delete from rule_handled where rule_id = ?", id);
  queueMicrotask(() => app.emit({ type: "changed", entity: "rule", id, spaceId: rule.spaceId }));
}

/** Claim an event for a rule; false when it was handled before (by the other source, say). */
export function claimEvent(app: App, ruleId: string, key: string) {
  return run(app.db, "insert or ignore into rule_handled(rule_id, key, at) values(?,?,?)", ruleId, key, now()).changes === 1;
}
/**
 * A message someone sent to the bot itself (@-mentioned it): the bot answers it directly, so
 * rules step aside — whichever path (bot or capture) brings the message to them later.
 */
const ADDRESSED = "@bot";
export function markAddressed(app: App, key: string) {
  claimEvent(app, ADDRESSED, key);
}
export function addressed(app: App, key: string) {
  return !!one(app.db, "select 1 from rule_handled where rule_id = ? and key = ?", ADDRESSED, key);
}
/** Whether any rule took this event (claimed it, to act now or after a wait). */
export function claimedByRule(app: App, key: string) {
  return !!one(app.db, "select 1 from rule_handled where key = ? and rule_id != ?", key, ADDRESSED);
}
/**
 * Events the rules are judging right now, in this process (by event key; engine.ts marks them).
 * 有人找你 starts on a message only after the rules had their say on it (src/mentions/mentions.ts):
 * taken by a rule, it steps aside; so a rule's model and the triage never both judge one message.
 */
const judging = new Map<string, number>();
export function startJudging(key: string) {
  judging.set(key, (judging.get(key) ?? 0) + 1);
}
export function endJudging(key: string) {
  const n = (judging.get(key) ?? 1) - 1;
  if (n > 0) judging.set(key, n);
  else judging.delete(key);
}
export function rulesJudging(key: string) {
  return judging.has(key);
}

/**
 * The rule that took a message, for 有人找你 (src/mentions/mentions.ts), which steps aside for it: one
 * that fired on it (whatever its actions; a skip because the owner or someone else was already on it
 * counts too), followed up on it in a topic its agent spoke in, or claimed it and is still at it —
 * waiting (a queued rule-fire run) or acting. A rule that did not match is not here; nor one whose
 * wait ended with the model saying no (claimed, no firing, its rule-fire run over).
 * `chatKey` (`chat:<id>`): a rule firing once per chat counts from `since` (the message's time) on.
 */
export function ruleClaim(app: App, key: string, chatKey: string, since: string): { rule: string; waiting: boolean } | null {
  const fired = one<{ name: string }>(app.db,
    `select r.name from rule_firings f join rules r on r.id = f.rule_id
      where f.event_key in (?, ?) or (f.event_key = ? and f.at >= ?) order by f.id desc limit 1`,
    key, `follow:${key}`, chatKey, since);
  if (fired) return { rule: fired.name, waiting: false };
  const pending = one<{ name: string }>(app.db,
    `select r.name from rule_handled h join rules r on r.id = h.rule_id
      where r.enabled = 1 and (h.key = ? or (h.key = ? and h.at >= ?))
        and exists (select 1 from runs where kind = 'rule-fire' and status in ('queued','running')
                     and json_extract(input, '$.ruleId') = h.rule_id and json_extract(input, '$.key') = h.key)
      limit 1`,
    key, chatKey, since);
  return pending ? { rule: pending.name, waiting: true } : null;
}
export function releaseEvent(app: App, ruleId: string, key: string) {
  run(app.db, "delete from rule_handled where rule_id = ? and key = ?", ruleId, key);
}

export type Firing = { id: number; ruleId: string; eventKey: string; at: string; summary: string; judgedBy: string; reason: string; results: { action: string; ok: boolean; detail: string; runId?: string }[] };

/** Log a firing; a skipped one (the owner was already on it, someone answered) is logged but not counted. */
export function recordFiring(app: App, f: Omit<Firing, "id" | "at">, opts: { skipped?: boolean } = {}) {
  const at = now();
  run(app.db, "insert into rule_firings(rule_id, event_key, at, summary, judged_by, reason, results) values(?,?,?,?,?,?,?)", f.ruleId, f.eventKey, at, f.summary, f.judgedBy, f.reason, JSON.stringify(f.results));
  if (!opts.skipped) run(app.db, "update rules set hits = hits + 1, last_fired_at = ? where id = ?", at, f.ruleId);
}

export function listFirings(app: App, ruleId: string, limit = 50): Firing[] {
  return all<{ id: number; rule_id: string; event_key: string; at: string; summary: string; judged_by: string; reason: string; results: string }>(
    app.db,
    "select * from rule_firings where rule_id = ? order by id desc limit ?",
    ruleId,
    limit,
  ).map((r) => ({ id: r.id, ruleId: r.rule_id, eventKey: r.event_key, at: r.at, summary: r.summary, judgedBy: r.judged_by, reason: r.reason, results: json(r.results, []) }));
}
