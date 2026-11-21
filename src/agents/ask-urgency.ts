import type { App } from "../core/app.ts";
import { one } from "../core/db.ts";
import { deliveryPlan } from "../core/notify.ts";
import type { Ask } from "./asks.ts";

export function askUrgency(app: App, ask: Ask) {
  if (ask.kind === "approval" || ask.handler === "flow-stage") return "urgent";
  const deadline = one<{ deadline: string | null }>(app.db, `select coalesce(json_extract(context,'$.deadline'),json_extract(context,'$.expiresAt')) deadline from asks where id = ?`, ask.id)?.deadline;
  if (deadline) {
    const next = deliveryPlan(app, { outlet: "lark" });
    const latest = Math.max(Date.now() + 3600_000, next.when === "later" && next.at ? Date.parse(next.at) : 0);
    if (Date.parse(deadline) <= latest) return "urgent";
  }
  if (ask.handler || ask.kind !== "question") return "normal";
  const r = one<{ kind: string; status: string; via: string | null; by: string | null; follow: string | null; parent_id: string | null }>(app.db,
    `select kind, status, json_extract(trigger,'$.via') via, trigger_by "by", json_extract(trigger,'$.followUp') follow, parent_id from runs where id = ?`, ask.runId);
  if (r && (r.kind !== "ask" || r.follow || r.parent_id || (r.via && (r.via !== "chat" || r.by !== `user:${ask.userId}`)))) return "normal";
  if (r?.status === "running") return "urgent";
  const recent = new Date(Date.now() - 30 * 60_000).toISOString();
  return one(app.db, `select 1 from messages m join conversations c on c.id=m.conversation_id
    left join runs r on r.id=m.run_id where c.id=? and c.user_id=? and m.created_at>=? and m.role='user'
    and json_extract(m.meta,'$.speaker') is null and json_extract(m.meta,'$.asker') is null and json_extract(m.meta,'$.metric') is null
    and (r.trigger is null or (r.trigger_by=? and json_extract(r.trigger,'$.via')='chat' and json_extract(r.trigger,'$.followUp') is null)) limit 1`,
    ask.conversationId, ask.userId, recent, `user:${ask.userId}`) ? "urgent" : "normal";
}
