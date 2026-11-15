import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, json, now } from "../core/util.ts";
import { addItemEvent } from "../items/store.ts";
import { cancelAsk, createAsk, registerAskHandler } from "../agents/asks.ts";
import { readFlow, type FlowDefinition, type FlowStage } from "./definitions.ts";

type Streak = { flowId: string; stageId: string; userId: string; count: number; askId?: string };
const key = (flowId: string, stageId: string, userId: string) => `flow_gate:${JSON.stringify([flowId, stageId, userId])}`;
function streak(app: App, flowId: string, stageId: string, userId: string): Streak {
  return json(one<{ value: string }>(app.db, "select value from kv where key=?", key(flowId, stageId, userId))?.value, { flowId, stageId, userId, count: 0 });
}
function save(app: App, s: Streak) {
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value=excluded.value", key(s.flowId, s.stageId, s.userId), JSON.stringify(s));
}
/** How many times in a row the owner let this gate through without remarks (what the ladder counts toward asking). */
export function gateStreak(app: App, flowId: string, stageId: string, userId: string) { return streak(app, flowId, stageId, userId).count; }
export function resetGateStreak(app: App, flowId: string, stageId: string, userId: string) {
  const s = streak(app, flowId, stageId, userId);
  if (s.askId) cancelAsk(app, s.askId, "关卡的连续同意重新计数");
  save(app, { ...s, count: 0, askId: undefined });
}
export function gateGranted(app: App, flowId: string, d: FlowStage, userId: string) {
  return d.gate === "confirm" && !d.fixed && !!one(app.db, "select 1 from flow_gate_grants where flow_id=? and stage_id=? and user_id=? and revoked_at is null", flowId, d.id, userId);
}
export function gateGrants(app: App, flowId: string, userId: string) {
  return all<{ stage_id: string; granted_at: string }>(app.db, "select stage_id,granted_at from flow_gate_grants where flow_id=? and user_id=? and revoked_at is null order by stage_id", flowId, userId).map((r) => ({ stage: r.stage_id, grantedAt: r.granted_at }));
}
/** Like tool approvals, only an explicit owner decision can promote a gate. */
export function agreedGate(app: App, f: FlowDefinition, d: FlowStage, userId: string) {
  const config = app.config.flows.gateLadder;
  if (!config.enabled || d.gate !== "confirm" || d.fixed || gateGranted(app, f.id, d, userId)) return;
  const s = streak(app, f.id, d.id, userId);
  if (s.askId) {
    if (one<{ status: string }>(app.db, "select status from asks where id=?", s.askId)?.status === "pending") return;
    s.askId = undefined;
    s.count = 0;
  }
  s.count++;
  if (s.count >= config.after) {
    s.askId = createAsk(app, { userId, runId: null, question: `「${f.name}」的「${d.name}」你连着同意了 ${s.count} 次，以后轮到它就直接开始吗？`,
      options: [{ label: "以后直接开始" }, { label: "还是每次问我" }], allowText: false,
      context: { handler: "flow-gate-promote", flowId: f.id, stageId: d.id, userId } }).id;
    s.count = 0;
  }
  save(app, s);
}

export function revokeGate(app: App, flowId: string, stageId: string, userId: string, itemId?: string) {
  const at = now();
  const changed = run(app.db, "update flow_gate_grants set revoked_at=?,updated_at=? where flow_id=? and stage_id=? and user_id=? and revoked_at is null", at, at, flowId, stageId, userId).changes;
  resetGateStreak(app, flowId, stageId, userId);
  if (changed && itemId) addItemEvent(app, itemId, "stage", `本人撤销了「${stageId}」以后直接开始的授权，下次先问本人`, "owner");
  return !!changed;
}

/** Keep tombstones so a later pull cannot restore a removed stage's old consent. */
export function pruneGateGrants(app: App, flowId: string, stages: FlowStage[]) {
  const valid = new Set(stages.filter((s) => s.gate === "confirm" && !s.fixed).map((s) => s.id));
  for (const r of all<{ stage_id: string; user_id: string }>(app.db, "select stage_id,user_id from flow_gate_grants where flow_id=? and revoked_at is null", flowId)) {
    if (!valid.has(r.stage_id)) revokeGate(app, flowId, r.stage_id, r.user_id);
  }
  for (const r of all<{ value: string }>(app.db, "select value from kv where key like 'flow_gate:%'")) {
    const s = json<Streak | null>(r.value, null);
    if (s?.flowId === flowId && !valid.has(s.stageId)) resetGateStreak(app, flowId, s.stageId, s.userId);
  }
}

registerAskHandler("flow-gate-promote", async (app, ask, ctx) => {
  const flowId = String(ctx.flowId), stageId = String(ctx.stageId), userId = ask.userId;
  if (ask.answeredBy !== userId || userId !== ctx.userId) return;
  const s = streak(app, flowId, stageId, userId);
  if (s.askId !== ask.id) return;
  save(app, { ...s, count: 0, askId: undefined });
  if (ask.choice !== 0) return;
  let f: FlowDefinition;
  try { f = readFlow(app, flowId); } catch { return; }
  const d = f.stages.find((d) => d.id === stageId);
  if (!d || d.gate !== "confirm" || d.fixed) return;
  const at = now();
  run(app.db, `insert into flow_gate_grants(flow_id,stage_id,user_id,granted_at,updated_at) values(?,?,?,?,?)
    on conflict(flow_id,stage_id,user_id) do update set granted_at=excluded.granted_at,revoked_at=null,updated_at=excluded.updated_at`, flowId, stageId, userId, at, at);
  run(app.db, "update asks set result=? where id=?", "以后轮到这一段就直接开始；仍受连续自动推进上限约束", ask.id);
}, (_app, ask, ctx, by) => {
  if (ask.userId !== by || by !== ctx.userId) throw new HttpError(403, "关卡授权只能由本人回答");
});
