import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { json, localStamp, zoneMidnight } from "../core/util.ts";
import { itemFlow, itemStages } from "./store.ts";
import { stageTiming } from "./timing.ts";

export const extraFollowNote = "临近计划时间或截止时间，今天的批数放宽一倍";

function nearDeadline(app: App, id: string, at: Date) {
  const tz = app.config.timezone, from = at.getTime(), to = from + 48 * 3600_000;
  const near = (value: string | null | undefined) => {
    if (!value) return false;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = Date.parse(value);
    // A day without a time runs through the end of that local day.
    const time = dateOnly && Number.isFinite(parsed)
      ? zoneMidnight(new Date(parsed + 86400_000).toISOString().slice(0, 10), tz).getTime() - 1 : parsed;
    return time >= from && time <= to;
  };
  if (near(one<{ due_at: string | null }>(app.db, "select due_at from items where id=?", id)?.due_at)) return true;
  const flow = itemFlow(app, id);
  if (!flow || flow.endedAt || flow.roundClosedAt) return false;
  return itemStages(app, id).some(stage => {
    if (stage.state === "done" || stage.state === "skipped") return false;
    if (near(stage.control.ownerPlanAt)) return true;
    const definition = flow.definition.stages.find(s => s.id === stage.id);
    if (!definition?.at && !definition?.window) return false;
    if (stage.state !== "pending") return false;
    return near(stageTiming(at, tz, definition, new Date(flow.roundStartedAt)).nextAt);
  });
}

/** Only runs count; both follow and ordinary reconciliation draw on the same local day's budget. */
export function followLimit(app: App, id: string, at = new Date()) {
  const max = app.config.flows.follow.maxRunsPerDay;
  if (!max) return { capped: false, count: 0, noted: false };
  const day = localStamp(at, app.config.timezone).slice(0, 10);
  const hour = 3600_000;
  const rows = all<{ at: string; keys: string }>(app.db, `select at,keys from flow_signals
    where item_id=? and type in ('context.batch','reconcile') and json_extract(keys,'$.focused') is null and at>=? and at<=?`,
  id, new Date(at.getTime() - 36 * hour).toISOString(), new Date(at.getTime() + 36 * hour).toISOString())
    .filter(r => localStamp(r.at, app.config.timezone).slice(0, 10) === day)
    .map(r => json<{ runId?: string; capped?: boolean; extra?: boolean }>(r.keys, {}));
  const count = rows.filter(r => !!r.runId).length;
  // Close to a planned time or the due date the day's allowance doubles; `extra` marks the first batch past the usual one, to say so once.
  const near = count >= max && count < max * 2 && nearDeadline(app, id, at);
  const extra = near && !rows.some(r => r.extra);
  return { capped: count >= max && !near, count, noted: rows.some(r => r.capped), ...(extra ? { extra: true } : {}) };
}
