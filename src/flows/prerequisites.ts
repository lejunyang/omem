import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import type { FlowStage } from "./definitions.ts";
import type { ItemFlow, StageRow } from "./store.ts";

type NeedState = { id: string; state: string; control?: { upstream?: unknown } };

export function unmetNeed(stages: FlowStage[], needs: string[], rows: NeedState[]): string | undefined {
  for (const id of needs) {
    const row = rows.find(r => r.id === id);
    if (!row || row.control?.upstream || row.state !== "done" && row.state !== "skipped") return id;
    if (row.state === "skipped") {
      const missing = unmetNeed(stages, stages.find(stage => stage.id === id)?.needs ?? [], rows);
      if (missing) return missing;
    }
  }
}

export function prematureStart(app: App, flow: ItemFlow, stage: FlowStage, row: StageRow, missing: string) {
  if (!row.enteredAt || row.control.reported || row.control.upstream || row.control.confirmed || row.evidence.length || stage.needs.includes(missing)) return false;
  const start = one<{ id: number }>(app.db, `select id from item_stage_log where item_id=? and stage_id=? and round=? and at>=?
    and from_state<>to_state and to_state='doing' order by id desc limit 1`, row.itemId, row.id, row.round, row.enteredAt);
  if (!start || one(app.db, `select 1 from item_stage_log where item_id=? and stage_id=? and round=? and at>=? and actor not in ('host','flow-reconcile')
    and (id>=? or event in ('gate-agree','gate-agree-note','limit-agree','reopen')) limit 1`, row.itemId, row.id, row.round, flow.roundStartedAt, start.id)) return false;
  const before = all<NeedState>(app.db, `select stage_id id,to_state state from item_stage_log where id in (
    select max(id) from item_stage_log where item_id=? and round=? and at>=? and id<? group by stage_id)`, row.itemId, row.round, flow.roundStartedAt, start.id);
  return stage.needs.every(id => before.some(r => r.id === id && (r.state === "done" || r.state === "skipped")))
    && !!unmetNeed(flow.definition.stages, stage.needs, before);
}
