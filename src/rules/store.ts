import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { deleteSchedule, upsertSchedule } from "../core/scheduler.ts";
import { HttpError, json, newId, now } from "../core/util.ts";
import { ruleInputSchema, type Rule, type RuleInput } from "./types.ts";

type Row = {
  id: string;
  name: string;
  description: string;
  enabled: number;
  trigger: string;
  conditions: string | null;
  judge: string;
  actions: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  hits: number;
  last_fired_at: string | null;
};

const toRule = (r: Row): Rule => ({
  id: r.id,
  name: r.name,
  description: r.description,
  enabled: !!r.enabled,
  trigger: { waitMinutes: 0, unless: [], ...json(r.trigger, { event: "message" as const, once: "event" as const }) },
  conditions: r.conditions ? json(r.conditions, null) : null,
  judge: r.judge as Rule["judge"],
  actions: json(r.actions, []),
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  hits: r.hits,
  lastFiredAt: r.last_fired_at,
});

export function listRules(app: App, opts: { enabledOnly?: boolean } = {}): Rule[] {
  return all<Row>(app.db, `select * from rules ${opts.enabledOnly ? "where enabled = 1" : ""} order by created_at`).map(toRule);
}

export function getRule(app: App, id: string): Rule {
  const r = one<Row>(app.db, "select * from rules where id = ?", id);
  if (!r) throw new HttpError(404, "规则不存在");
  return toRule(r);
}

/** Create or replace a rule; checks it can work (conditions for code judging, a cron for schedules). */
export function saveRule(app: App, input: RuleInput & { id?: string }, by: "user" | "agent" = "user"): Rule {
  const r = ruleInputSchema.parse(input);
  if (r.judge !== "ai" && !r.conditions && r.trigger.event !== "schedule") throw new HttpError(400, "按条件判断需要条件；没有条件就选“交给 AI 判断”，或先从规则原话生成条件");
  if (r.trigger.event === "schedule" && !r.trigger.cron) throw new HttpError(400, "定时规则需要 cron，例如 0 9 * * 1-5");
  if (r.trigger.event === "schedule" && r.actions.some((a) => a.type === "invite-bot" || a.type === "capture" || a.type === "watch" || (a.type === "agent" && a.ownTopic)))
    throw new HttpError(400, "定时规则没有具体的群或消息：只能交给 Agent（不开话题）或通知本人");
  if (r.trigger.event === "schedule" && (r.trigger.waitMinutes || r.trigger.unless.length || r.actions.some((a) => a.type === "agent" && a.reply === "silent")))
    throw new HttpError(400, "定时规则没有具体的讨论：不能等待回应、不能按“本人已在处理/已有人回复”跳过，也不能静默排查");
  const at = now();
  const id = input.id ?? newId("rule");
  const prev = input.id ? one<Row>(app.db, "select * from rules where id = ?", input.id) : undefined;
  run(
    app.db,
    `insert into rules(id, name, description, enabled, trigger, conditions, judge, actions, created_by, created_at, updated_at) values(?,?,?,?,?,?,?,?,?,?,?)
     on conflict(id) do update set name = excluded.name, description = excluded.description, enabled = excluded.enabled, trigger = excluded.trigger,
       conditions = excluded.conditions, judge = excluded.judge, actions = excluded.actions, updated_at = excluded.updated_at`,
    id,
    r.name,
    r.description,
    r.enabled ? 1 : 0,
    JSON.stringify(r.trigger),
    r.conditions ? JSON.stringify(r.conditions) : null,
    r.judge,
    JSON.stringify(r.actions),
    prev?.created_by ?? by,
    prev?.created_at ?? at,
    at,
  );
  // A schedule rule runs from the scheduler like the built-in tasks (schedule id rule:<id>).
  if (r.trigger.event === "schedule") upsertSchedule(app, { id: `rule:${id}`, kind: "rule", cron: r.trigger.cron!, config: { ruleId: id }, enabled: r.enabled });
  else if (prev && JSON.parse(prev.trigger).event === "schedule") deleteSchedule(app, `rule:${id}`);
  return getRule(app, id);
}

export function deleteRule(app: App, id: string) {
  getRule(app, id);
  run(app.db, "delete from rules where id = ?", id);
  if (one(app.db, "select 1 from schedules where id = ?", `rule:${id}`)) deleteSchedule(app, `rule:${id}`);
  run(app.db, "delete from rule_handled where rule_id = ?", id);
}

/** Claim an event for a rule; false when it was handled before (by the other source, say). */
export function claimEvent(app: App, ruleId: string, key: string) {
  return run(app.db, "insert or ignore into rule_handled(rule_id, key, at) values(?,?,?)", ruleId, key, now()).changes === 1;
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
