import { z } from "zod";
import type { App } from "../core/app.ts";
import { one, run } from "../core/db.ts";
import { now, untilAbort } from "../core/util.ts";
import { materialViews } from "../items/materials.ts";
import { getItem, type Item } from "../items/store.ts";
import { flowSignals } from "../plugins/process-hooks.ts";
import type { FlowStage } from "./definitions.ts";
import { completeBySignal } from "./engine.ts";
import { getStage, itemFlow, type ItemFlow, type StageRow } from "./store.ts";

export const evidenceSchema = z.array(z.object({
  text: z.string().trim().min(1).max(2000),
  link: z.string().max(4096).refine(s => /^(?:https?:\/\/|#\/|src:[\w-]+(?:#|$))/.test(s), "证据链接无效").optional(),
})).max(30);
const result = z.object({ done: z.boolean(), evidence: evidenceSchema.optional(), waitingOn: z.string().max(1000).optional(), recheckAfterSec: z.number().optional() });

export async function flowContext(app: App, item: Item, d: FlowStage, s: StageRow, params: unknown) {
  const materials = (await materialViews(app, item.id, item.userId)).filter(m => m.readable && !m.missing && m.spaceId === item.spaceId)
    .map(({ kind, ref }) => ({ kind, ref }));
  return { item: { id: item.id, title: item.title, spaceId: item.spaceId }, stage: { id: d.id, name: d.name, since: s.enteredAt ?? s.since }, with: params ?? {}, materials };
}

function observation(app: App, s: StageRow, type: string) {
  const last = one<{ at: string; keys: string; outcome: string }>(app.db,
    "select at,keys,outcome from flow_signals where item_id=? and stage_id=? and type=? and at>=? order by id desc limit 1",
    s.itemId, s.id, type, s.enteredAt ?? s.since);
  return last && { checkedAt: last.at, note: last.outcome, ...JSON.parse(last.keys) as { failures: number; nextAt: string } };
}
const unavailable = "等的信号现在没人能判断";
export function pluginSignalWaiting(app: App, s: StageRow, type: string) {
  const entry = flowSignals.get(type), last = observation(app, s, type);
  const available = !!entry && (!entry.spaces.length || entry.spaces.includes(getItem(app, s.itemId).spaceId));
  return { type, checkedAt: last?.checkedAt ?? null, nextAt: last?.nextAt, failures: last?.failures ?? 0, available,
    note: available ? last?.note ?? entry.def.describe : unavailable };
}

const active = new WeakMap<App, Set<string>>();
export async function pollFlowSignal(app: App, f: ItemFlow, d: FlowStage, s: StageRow) {
  if (typeof d.done !== "object" || !("signal" in d.done)) return;
  const type = d.done.signal, entry = flowSignals.get(type);
  if (!entry) return;
  const item = getItem(app, f.itemId);
  if (entry.spaces.length && !entry.spaces.includes(item.spaceId)) return;
  const calls = active.get(app) ?? new Set<string>(), key = JSON.stringify([item.id, s.id]);
  if (calls.has(key)) return;
  const last = observation(app, s, type);
  if (last && Date.parse(last.nextAt) > Date.now()) return;
  active.set(app, calls);
  calls.add(key);
  try {
    let failures = 0, delay = 60, note = entry.def.describe;
    let ready: z.infer<typeof result> | undefined;
    const signal = entry.context(app, item.userId, item.spaceId, AbortSignal.timeout(5000)).signal;
    try {
      const ctx = await flowContext(app, item, d, s, d.done.with);
      ready = result.parse(await untilAbort(signal, () => entry.def.check(ctx, signal)));
      delay = Math.max(10, Math.min(3600, ready.recheckAfterSec ?? delay));
      note = ready.done ? entry.def.describe : ready.waitingOn || note;
    } catch (e) {
      failures = (last?.failures ?? 0) + 1;
      delay = Math.min(3600, 30 * 2 ** Math.min(7, failures - 1));
      note = "问不到：" + String(e).slice(0, 500);
    }
    const current = itemFlow(app, item.id);
    if (!current || current.endedAt || current.startedAt !== f.startedAt || current.round !== f.round || flowSignals.get(type) !== entry) return;
    const stage = getStage(app, item.id, d.id);
    if (stage.state !== "doing" || stage.attempt !== s.attempt || stage.enteredAt !== s.enteredAt) return;
    run(app.db, "insert into flow_signals(at,type,keys,item_id,stage_id,outcome) values(?,?,?,?,?,?)", now(), type,
      JSON.stringify({ failures, nextAt: new Date(Date.now() + delay * 1000).toISOString() }), item.id, d.id, note);
    if (ready?.done) await completeBySignal(app, item.id, d.id, note, ready.evidence?.map(e => e.link ?? e.text) ?? [], {
      startedAt: f.startedAt, attempt: s.attempt, enteredAt: s.enteredAt, type, pluginEvidence: ready.evidence, current: () => flowSignals.get(type) === entry });
  } finally { calls.delete(key); }
}
