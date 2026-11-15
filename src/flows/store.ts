import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { addItemEvent, getItem } from "../items/store.ts";
import type { FlowDefinition } from "./definitions.ts";

export type StageState = "pending" | "gated" | "doing" | "blocked" | "done" | "skipped" | "stale";
export type FlowActor = { actor: string; runId?: string; userId?: string };
export type StageControl = {
  runId?: string;
  whenYes?: boolean; whenAttempt?: number; whenNo?: boolean;
  question?: "when" | "gate" | "owner" | "done" | "skip" | "refuse";
  confirmed?: boolean; reported?: boolean; feedback?: string;
  reminderAt?: string; reminders?: number;
};
export type StageRow = {
  itemId: string; id: string; state: StageState; attempt: number; enteredAt: string | null; doneAt: string | null;
  by: string | null; waitingOn: string | null; evidence: string[]; note: string; askId: string | null;
  since: string; control: StageControl;
};
export type ItemFlow = { itemId: string; id: string; definition: FlowDefinition; startedAt: string; endedAt: string | null; autoStreak: number; card: string | null; startedBy: string };
type FlowDb = { item_id: string; flow_id: string; definition: string; started_at: string; ended_at: string | null; auto_streak: number; card: string | null; started_by: string };
type StageDb = { item_id: string; stage_id: string; state: StageState; attempt: number; entered_at: string | null; done_at: string | null; by: string | null; waiting_on: string | null; evidence: string; note: string; ask_id: string | null; since: string; control: string };
export function itemFlow(app: App, itemId: string): ItemFlow | null {
  const f = one<FlowDb>(app.db, "select * from item_flows where item_id = ?", itemId);
  return f ? { itemId, id: f.flow_id, definition: json(f.definition, {} as FlowDefinition), startedAt: f.started_at, endedAt: f.ended_at, autoStreak: f.auto_streak, card: f.card, startedBy: f.started_by } : null;
}
const stage = (s: StageDb): StageRow => ({ itemId: s.item_id, id: s.stage_id, state: s.state, attempt: s.attempt, enteredAt: s.entered_at, doneAt: s.done_at, by: s.by, waitingOn: s.waiting_on, evidence: json(s.evidence, []), note: s.note, askId: s.ask_id, since: s.since, control: json(s.control, {}) });
export const itemStages = (app: App, id: string) => all<StageDb>(app.db, "select * from item_stages where item_id = ?", id).map(stage);
export function getStage(app: App, itemId: string, id: string) {
  const s = one<StageDb>(app.db, "select * from item_stages where item_id = ? and stage_id = ?", itemId, id);
  if (!s) throw new HttpError(404, `没有阶段 ${id}`);
  return stage(s);
}
export type StageLog = { id: number; stageId: string; at: string; fromState: StageState | null; toState: StageState; actor: string; runId: string | null; refs: string[]; note: string };
export const stageLog = (app: App, id: string, limit = 50): StageLog[] => all<{ id: number; stage_id: string; at: string; from_state: StageState | null; to_state: StageState; actor: string; run_id: string | null; refs: string; note: string }>(app.db, "select * from item_stage_log where item_id = ? order by id desc limit ?", id, limit).map((l) => ({ id: l.id, stageId: l.stage_id, at: l.at, fromState: l.from_state, toState: l.to_state, actor: l.actor, runId: l.run_id, refs: json(l.refs, []), note: l.note }));
export const atomic = <T>(app: App, fn: () => T): T => app.db.isTransaction ? fn() : tx(app.db, fn);
const LABEL: Record<StageState, string> = { pending: "未到", gated: "等你确认", doing: "进行中", blocked: "卡住", done: "完成", skipped: "跳过", stale: "待复核" };

/** All stage writes, including initial rows and same-state decisions, have one audit path. */
export function changeStage(app: App, itemId: string, id: string, state: StageState, patch: Partial<Omit<StageRow, "itemId" | "id" | "state">>, by: FlowActor, note: string, refs: string[] = []) {
  const prev = itemStages(app, itemId).find((s) => s.id === id);
  const f = itemFlow(app, itemId);
  if (!f) throw new HttpError(404, "事项没有流程");
  const at = now();
  const changed = !prev || prev.state !== state;
  const next: StageRow = { itemId, id, state, attempt: 0, enteredAt: null, doneAt: null, by: null, waitingOn: null, evidence: [], note: "", askId: null, since: at, control: {}, ...prev, ...patch };
  next.state = state;
  next.note = note;
  if (changed) {
    next.since = at;
    next.control = { ...next.control, reminders: 0, reminderAt: at };
    next.doneAt = state === "done" || state === "skipped" ? at : null;
  }
  const name = f.definition.stages.find((s) => s.id === id)?.name ?? id;
  atomic(app, () => {
    run(app.db, `insert into item_stages(item_id,stage_id,state,attempt,entered_at,done_at,"by",waiting_on,evidence,note,ask_id,since,control,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(item_id,stage_id) do update set state=excluded.state,attempt=excluded.attempt,entered_at=excluded.entered_at,done_at=excluded.done_at,"by"=excluded."by",waiting_on=excluded.waiting_on,evidence=excluded.evidence,note=excluded.note,ask_id=excluded.ask_id,since=excluded.since,control=excluded.control,updated_at=excluded.updated_at`,
      itemId, id, state, next.attempt, next.enteredAt, next.doneAt, next.by, next.waitingOn, JSON.stringify(next.evidence), note, next.askId, next.since, JSON.stringify(next.control), at);
    run(app.db, "insert into item_stage_log(item_id,stage_id,at,from_state,to_state,actor,run_id,refs,note) values(?,?,?,?,?,?,?,?,?)", itemId, id, at, prev?.state ?? null, state, by.actor, by.runId ?? null, JSON.stringify(refs), note);
    addItemEvent(app, itemId, "stage", truncate(`「${name}」${LABEL[state]}${note ? `：${note}` : ""}`.replace(/\s+/g, " "), 180), by.actor, refs, by.runId);
    run(app.db, "update item_flows set updated_at=? where item_id=?", at, itemId);
    run(app.db, "update items set updated_at=? where id=?", at, itemId);
  });
  app.emit({ type: "changed", entity: "item", id: itemId });
  markProgress(app, itemId, changed && (state === "gated" || state === "blocked" && next.waitingOn === "owner"));
  return next;
}

// One operation of the engine changes several stages (starting a flow writes every stage): the card is
// refreshed once when the operation ends (engine.ts serial), not once per change.
const stale = new WeakMap<App, Map<string, boolean>>();
function markProgress(app: App, id: string, ownerWaiting: boolean) {
  let m = stale.get(app);
  if (!m) stale.set(app, m = new Map());
  m.set(id, (m.get(id) ?? false) || ownerWaiting);
}
/** Send the progress card if anything changed since the last one. */
export function flushProgress(app: App, id: string) {
  const m = stale.get(app);
  if (!m?.has(id)) return;
  const ownerWaiting = m.get(id)!;
  m.delete(id);
  progress(app, id, ownerWaiting);
}

/** A newer notification replaces the previous card; questions remain separate asks. */
export function progress(app: App, id: string, ownerWaiting = false) {
  const f = itemFlow(app, id);
  if (!f) return;
  const item = getItem(app, id);
  const rows = itemStages(app, id);
  const icon: Record<StageState, string> = { done: "✓", doing: "▶", gated: "…", pending: "·", blocked: "!", skipped: "−", stale: "↺" };
  const body = [
    ...f.definition.stages.map((d) => {
      const s = rows.find((r) => r.id === d.id);
      if (!s) return `· ${d.name}`;
      const hours = s.enteredAt ? Math.floor((Date.now() - Date.parse(s.enteredAt)) / 3600_000) : 0;
      return `${icon[s.state]} ${d.name}${s.state === "doing" ? `（第 ${s.attempt} 次，${hours ? `${hours} 小时` : "不足 1 小时"}${s.by === "owner" ? "，等你" : ""}）` : s.state === "gated" ? "（等你）" : s.state === "blocked" ? `（等${s.waitingOn === "owner" ? "你" : s.waitingOn || "处理"}）` : s.state === "stale" ? "（待复核）" : ""}`;
    }),
    ...rows.filter((s) => s.waitingOn).map((s) => `${f.definition.stages.find((d) => d.id === s.id)?.name}：等${s.waitingOn === "owner" ? "你" : s.waitingOn}${s.note ? `，${s.note}` : ""}`),
    ...(f.endedAt ? [rows.every((s) => ["done", "skipped"].includes(s.state)) ? "流程已走完；事项仍由你决定是否关闭。" : "流程已停止。"] : []),
  ].join("\n");
  const n = notify(app, { userId: item.userId, title: item.title, body, entity: "item", entityId: id, sourceRefs: [], graceDone: true, urgency: ownerWaiting ? "normal" : "later", replaces: f.card ?? undefined, link: `#/items/${id}` });
  run(app.db, "update item_flows set card=? where item_id=?", n.id, id);
}
