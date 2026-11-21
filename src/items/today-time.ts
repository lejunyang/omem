import type { App } from "../core/app.ts";
import { run } from "../core/db.ts";
import { inQuietHours } from "../core/notify.ts";
import { OWNER } from "../core/users.ts";
import { zonedParts } from "../core/util.ts";

/** 今天 (items/today.ts) is on: the nightly cards wait for it. */
export const todayOn = (app: App) => app.config.notify.today?.enabled !== false;

/** Its time of day in minutes (`notify.today.at`, 09:30 by default). */
export function todayMinute(app: App) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(app.config.notify.today?.at ?? "09:30");
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60 + 30;
}

/** The next time the card is due after `at` (later today, or tomorrow). */
export function nextTodayAt(app: App, at = new Date()) {
  const p = zonedParts(at, app.config.timezone);
  let delta = todayMinute(app) - (p.hour * 60 + p.minute);
  if (delta <= 0) delta += 24 * 60;
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000 + delta * 60_000);
}

/**
 * A question for the owner made at night (quiet hours) and held for after them by the Feishu outlet
 * (lark-asks.ts `deferredUntil`): with 今天 on it waits for the morning card, which takes it in, instead
 * of going out on its own when quiet hours end. Asked in the day, it goes out as before.
 */
export function holdForToday(app: App, askId: string, at = new Date()) {
  if (!todayOn(app) || !inQuietHours(app, at)) return;
  run(app.db, `update asks set context = json_set(context, '$.deferredUntil', max(json_extract(context, '$.deferredUntil'), ?), '$.forToday', 1)
    where id = ? and user_id = ? and status = 'pending' and json_extract(context, '$.sentAt') is null and json_extract(context, '$.deferredUntil') is not null`,
    nextTodayAt(app, at).toISOString(), askId, OWNER);
}
