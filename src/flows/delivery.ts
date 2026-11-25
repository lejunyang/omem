import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { localStamp } from "../core/util.ts";
import { addRunEvent, getRun } from "../agents/runs.ts";
import { addItemEvent, type Item } from "../items/store.ts";

export function recordFlowPush(app: App, runId: string, actor: string) {
  const rootId = String(getRun(app, runId).input.continueFrom ?? runId);
  for (const row of all<{ item_id: string }>(app.db, `select distinct item_id from item_materials where kind='run' and ref in (?,?)`, rootId, runId)) {
    addItemEvent(app, row.item_id, "git-push", "编码交办已推到远端", actor, [runId], runId);
  }
  addRunEvent(app, runId, "flow-push", { text: "编码交办已推到远端" });
}

export function deliveryFacts(app: App, item: Item, since: string, through: string) {
  const stages = all<{ note: string; refs: string }>(app.db, `select note,refs from item_stage_log l where item_id=? and at>? and at<=? and to_state='done' and from_state!='done'
    and not exists (select 1 from runs where id=l.run_id and kind='flow-reconcile') order by id desc limit 8`, item.id, since, through);
  const pushes = all<{ run_id: string }>(app.db, `select distinct run_id from item_events where item_id=? and kind='git-push' and at>? and at<=? order by id desc limit 8`, item.id, since, through);
  const approved = deliveryCodeRounds(app, item, since, through, true);
  return [...stages.map(stage => `阶段完成：${stage.note} ${stage.refs}`), ...approved.map(round => `编码第 ${round.round} 轮评审通过：${round.id}`), ...pushes.map(push => `编码交办已推到远端：${push.run_id}`)];
}

/** Use the same linked delegation root for review, completion and later rounds. */
export function deliveryCodeRounds(app: App, item: Item, since: string, through: string, approvedOnly = false) {
  return all<{ id: string; round: number; summary: string; status: string; verdict: string | null; at: string; space: string | null }>(app.db, `with roots as (
      select distinct root.id from item_materials m join runs linked on linked.id=m.ref
      join runs root on root.id=coalesce(json_extract(linked.input,'$.continueFrom'),linked.id)
      where m.item_id=? and m.kind='run' and coalesce(root.user_id,'owner')=? and root.kind='code'
        and (json_extract(root.input,'$.itemId')=? or json_extract(m.meta,'$.joined')=1)
    ), rounds as (
      select r.* from roots join runs r on r.id=roots.id
      union all select r.* from roots join runs r on json_extract(r.input,'$.continueFrom')=roots.id and r.id!=roots.id
    )
    select id,coalesce(json_extract(input,'$.round'),1) round,finished_at at,space_id space,status,
      json_extract(output,'$.verdict') verdict, substr(coalesce(nullif(json_extract(output,'$.summary'),''),title),1,170) summary
    from rounds where kind='code' and finished_at>? and finished_at<=?
      and ${approvedOnly ? "status='done' and json_extract(output,'$.verdict')='approved'" : "status in ('done','failed','cancelled')"}
    order by finished_at desc limit ?`, item.id, item.userId, item.id, since, through, approvedOnly ? 8 : 30);
}

export function ownerActiveToday(app: App, item: Item, at: Date) {
  const today = localStamp(at, app.config.timezone).slice(0, 10);
  const since = new Date(at.getTime() - 25 * 3600_000).toISOString();
  const through = at.toISOString();
  const events = all<{ at: string }>(app.db, `select at from item_events where item_id=? and actor in ('owner','user') and at>? and at<=?
    union all select at from item_changes where item_id=? and origin='owner' and noise=0 and at>? and at<=?`, item.id, since, through, item.id, since, through);
  return events.some(event => localStamp(event.at, app.config.timezone).startsWith(today));
}
