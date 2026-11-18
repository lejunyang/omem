import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { runImages } from "../agents/artifacts.ts";
import { HttpError, json, now, truncate } from "../core/util.ts";
import { addItemEvent, getItem } from "../items/store.ts";
import type { FlowDefinition } from "./definitions.ts";
import type { Execution } from "../agents/execution.ts";
import type { StageEvent } from "./review.ts";

export type StageState = "pending" | "gated" | "doing" | "blocked" | "done" | "skipped" | "stale";
export type FlowActor = { actor: string; runId?: string; userId?: string };
export type StageControl = {
  objectAfter?: string;
  recorded?: boolean;
  gateLimit?: boolean; grantedGate?: boolean;
  runId?: string;
  whenYes?: boolean; whenAttempt?: number; whenNo?: boolean;
  question?: "when" | "gate" | "owner" | "done" | "skip" | "refuse";
  confirmed?: boolean; reported?: boolean; feedback?: string;
  reminderAt?: string; reminders?: number;
  waitUntil?: string; tierFallback?: string[]; execution?: Execution; escalations?: number; escalated?: boolean;
  budgetStartedAt?: string; usedMinutes?: number;
  budgetExceeded?: boolean;
  admitted?: boolean;
  trialId?: string; trialEscalated?: boolean; trialFailures?: number; completedTrials?: number;
  fixIds?: string[]; fixIndex?: number; fixWorkId?: string;
  /** An upstream stage was reopened while this one was being done: the card asking the owner whether to stop it. */
  upstream?: { askId: string; stage: string; reason: string };
};
export type StageRow = {
  itemId: string; id: string; state: StageState; attempt: number; enteredAt: string | null; doneAt: string | null;
  by: string | null; waitingOn: string | null; evidence: string[]; note: string; askId: string | null;
  since: string; control: StageControl; round: number;
};
export type ItemFlow = { itemId: string; id: string; definition: FlowDefinition; startedAt: string; endedAt: string | null; autoStreak: number; card: string | null; startedBy: string; round: number; roundStartedAt: string; roundClosedAt: string | null; nextRoundAt: string | null };
type FlowDb = { item_id: string; flow_id: string; definition: string; started_at: string; ended_at: string | null; auto_streak: number; card: string | null; started_by: string; round: number; round_started_at: string; round_closed_at: string | null; next_round_at: string | null };
type StageDb = { item_id: string; stage_id: string; state: StageState; attempt: number; entered_at: string | null; done_at: string | null; by: string | null; waiting_on: string | null; evidence: string; note: string; ask_id: string | null; since: string; control: string; round: number };
export function itemFlow(app: App, itemId: string): ItemFlow | null {
  const f = one<FlowDb>(app.db, "select * from item_flows where item_id = ?", itemId);
  return f ? { itemId, id: f.flow_id, definition: json(f.definition, {} as FlowDefinition), startedAt: f.started_at, endedAt: f.ended_at, autoStreak: f.auto_streak, card: f.card, startedBy: f.started_by, round: f.round, roundStartedAt: f.round_started_at ?? f.started_at, roundClosedAt: f.round_closed_at, nextRoundAt: f.next_round_at } : null;
}
const stage = (s: StageDb): StageRow => ({ itemId: s.item_id, id: s.stage_id, state: s.state, attempt: s.attempt, enteredAt: s.entered_at, doneAt: s.done_at, by: s.by, waitingOn: s.waiting_on, evidence: json(s.evidence, []), note: s.note, askId: s.ask_id, since: s.since, control: json(s.control, {}), round: s.round });
export const itemStages = (app: App, id: string) => all<StageDb>(app.db, "select * from item_stages where item_id = ?", id).map(stage);
export function getStage(app: App, itemId: string, id: string) {
  const s = one<StageDb>(app.db, "select * from item_stages where item_id = ? and stage_id = ?", itemId, id);
  if (!s) throw new HttpError(404, `没有阶段 ${id}`);
  return stage(s);
}
export type StageLog = { id: number; stageId: string; round: number; at: string; fromState: StageState | null; toState: StageState; actor: string; runId: string | null; refs: string[]; note: string };
export const stageLog = (app: App, id: string, limit = 50): StageLog[] => all<{ id: number; stage_id: string; round: number; at: string; from_state: StageState | null; to_state: StageState; actor: string; run_id: string | null; refs: string; note: string }>(app.db, "select * from item_stage_log where item_id = ? order by id desc limit ?", id, limit).map((l) => ({ id: l.id, stageId: l.stage_id, round: l.round, at: l.at, fromState: l.from_state, toState: l.to_state, actor: l.actor, runId: l.run_id, refs: json(l.refs, []), note: l.note }));
export const roundHistory = (app: App, f: ItemFlow) => all<{ round: number; ended_at: string; stages: string }>(app.db, "select round,ended_at,stages from item_flow_rounds where item_id=? and started_at=? order by round desc limit 10", f.itemId, f.startedAt).map((r) => ({ round: r.round, endedAt: r.ended_at, stages: json<StageRow[]>(r.stages, []) }));
export const atomic = <T>(app: App, fn: () => T): T => app.db.isTransaction ? fn() : tx(app.db, fn);
const LABEL: Record<StageState, string> = { pending: "未到", gated: "等你确认", doing: "进行中", blocked: "卡住", done: "完成", skipped: "跳过", stale: "待复核" };

/** All stage writes, including initial rows and same-state decisions, have one audit path. */
/** `event`: what kind of step this is when the states alone do not say (flows/review.ts reads it): reopen, refuse, gate-agree… */
export function changeStage(app: App, itemId: string, id: string, state: StageState, patch: Partial<Omit<StageRow, "itemId" | "id" | "state">>, by: FlowActor, note: string, refs: string[] = [], event?: StageEvent) {
  const prev = itemStages(app, itemId).find((s) => s.id === id);
  const f = itemFlow(app, itemId);
  if (!f) throw new HttpError(404, "事项没有流程");
  const at = now();
  const changed = !prev || prev.state !== state;
  const next: StageRow = { itemId, id, state, round: f.round, attempt: 0, enteredAt: null, doneAt: null, by: null, waitingOn: null, evidence: [], note: "", askId: null, since: at, control: {}, ...prev, ...patch };
  next.state = state;
  next.note = note;
  if (changed) {
    next.since = at;
    next.control = { ...next.control, reminders: 0, reminderAt: at };
    next.doneAt = state === "done" || state === "skipped" ? at : null;
  }
  const name = f.definition.stages.find((s) => s.id === id)?.name ?? id;
  atomic(app, () => {
    run(app.db, `insert into item_stages(item_id,stage_id,state,attempt,entered_at,done_at,"by",waiting_on,evidence,note,ask_id,since,control,updated_at,round) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(item_id,stage_id) do update set state=excluded.state,attempt=excluded.attempt,entered_at=excluded.entered_at,done_at=excluded.done_at,"by"=excluded."by",waiting_on=excluded.waiting_on,evidence=excluded.evidence,note=excluded.note,ask_id=excluded.ask_id,since=excluded.since,control=excluded.control,updated_at=excluded.updated_at,round=excluded.round`,
      itemId, id, state, next.attempt, next.enteredAt, next.doneAt, next.by, next.waitingOn, JSON.stringify(next.evidence), note, next.askId, next.since, JSON.stringify(next.control), at, next.round);
    run(app.db, "insert into item_stage_log(item_id,stage_id,at,from_state,to_state,actor,run_id,refs,note,round,waiting_on,event) values(?,?,?,?,?,?,?,?,?,?,?,?)", itemId, id, at, prev?.state ?? null, state, by.actor, by.runId ?? null, JSON.stringify(refs), note, f.round, next.waitingOn, event ?? null);
    addItemEvent(app, itemId, "stage", truncate(`「${name}」${LABEL[state]}${note ? `：${note}` : ""}`.replace(/\s+/g, " "), 180), by.actor, refs, by.runId);
    run(app.db, "update item_flows set updated_at=? where item_id=?", at, itemId);
    run(app.db, "update items set updated_at=? where id=?", at, itemId);
  });
  app.emit({ type: "changed", entity: "item", id: itemId });
  // Starts, gates (they have their own question card) and the owner's own clicks say nothing new to the
  // owner; a result, a skip, a stop or a re-check written by an Agent or the host does.
  const what = !changed || by.actor === "owner" ? null : state === "done" ? "做完了" : state === "skipped" ? "跳过了" : state === "blocked" ? `卡住了${next.waitingOn ? `，${waitText(next.waitingOn)}` : ""}` : state === "stale" ? "要复核" : null;
  // Stuck on the owner after the stage's own run already asked them: that question is the card.
  const asked = state === "blocked" && !!by.runId && !!one(app.db, "select 1 from asks where run_id=? and status='pending' limit 1", by.runId);
  // A result or a stop from a run carries what it saw: its screenshots go on the card too.
  const images = what && by.runId && (state === "done" || state === "blocked") ? runImages(app, [by.runId]).map((a) => a.id) : [];
  if (what && !asked) markProgress(app, itemId, `「${name}」${what}${note ? `：${cardText(note, state === "done" || state === "blocked" ? 1200 : 300)}` : ""}`, state === "blocked" && next.waitingOn === "owner", images);
  return next;
}

/** "等本人确认" and "本人确认" both read as one 等. */
export const waitText = (w: string) => `等${w === "owner" ? "你" : w.replace(/^等+/, "")}`;
// Run, question and other internal ids mean nothing on a card the owner reads.
// A result keeps its paragraphs (conclusion, steps, cause); other lines stay one line.
const cardText = (note: string, max = 300) => {
  const t = note.replace(/\s*[（(]?\b(?:ask|r|n|i)0m[0-9a-z]{10,}\b[）)]?/g, "");
  return truncate((max > 300 ? t.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n") : t.replace(/\s+/g, " ")).trim(), max);
};

// One operation of the engine changes several stages: what happened is collected and sent as one card
// when the operation ends (engine.ts serial), not once per change.
const stale = new WeakMap<App, Map<string, { lines: string[]; ownerWaiting: boolean; images: string[] }>>();
export function markProgress(app: App, id: string, line: string, ownerWaiting = false, images: string[] = []) {
  let m = stale.get(app);
  if (!m) stale.set(app, m = new Map());
  const cur = m.get(id) ?? { lines: [], ownerWaiting: false, images: [] };
  m.set(id, { lines: [...cur.lines, line], ownerWaiting: cur.ownerWaiting || ownerWaiting, images: [...cur.images, ...images] });
}
/** Send the progress card if something worth telling happened since the last one. */
export function flushProgress(app: App, id: string) {
  const m = stale.get(app);
  const pending = m?.get(id);
  if (!pending) return;
  m!.delete(id);
  progress(app, id, pending.lines, pending.ownerWaiting, pending.images);
}

/**
 * What happened first, then one line of where the flow stands. Questions for the owner stay separate
 * asks; a newer card replaces the previous one.
 */
export function progress(app: App, id: string, lines: string[], ownerWaiting = false, images: string[] = []) {
  const f = itemFlow(app, id);
  if (!f) return;
  const item = getItem(app, id);
  const rows = itemStages(app, id);
  const named = (state: StageState) => f.definition.stages.filter((d) => rows.find((r) => r.id === d.id)?.state === state);
  const doing = named("doing"), gated = named("gated"), blocked = named("blocked");
  const now_ = f.endedAt ? rows.every((s) => ["done", "skipped"].includes(s.state)) ? "流程已走完；事项仍由你决定是否关闭。" : "流程已停止。"
    : [doing.length ? `在做：${doing.map((d) => d.name).join("、")}` : "", gated.length ? `等你开始：${gated.map((d) => d.name).join("、")}` : "", blocked.length ? `卡住：${blocked.map((d) => d.name).join("、")}` : ""].filter(Boolean).join("；");
  const body = [...lines, now_ ? `现在 · ${now_}` : ""].filter(Boolean).join("\n");
  const n = notify(app, { userId: item.userId, title: item.title, body, entity: "item", entityId: id, sourceRefs: [], graceDone: true, urgency: ownerWaiting ? "normal" : "later", replaces: f.card ?? undefined, link: `#/items/${id}/flow`, images: images.slice(-4) });
  run(app.db, "update item_flows set card=? where item_id=?", n.id, id);
}
