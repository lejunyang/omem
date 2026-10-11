import { Cron } from "croner";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { json, newId, now } from "./util.ts";

export type Schedule = { id: string; kind: string; cron: string; spaceId: string | null; config: Record<string, unknown>; enabled: boolean; lastRunAt: string | null };
type Row = { id: string; kind: string; cron: string; space_id: string | null; config: string; enabled: number; last_run_at: string | null };
const toSchedule = (r: Row): Schedule => ({ id: r.id, kind: r.kind, cron: r.cron, spaceId: r.space_id, config: json(r.config, {}), enabled: !!r.enabled, lastRunAt: r.last_run_at });

/** Built-in schedules exist from the start; background ones begin disabled except reminders. */
const DEFAULTS: { id: string; kind: string; cron: string; enabled: boolean; label: string }[] = [
  { id: "heartbeat", kind: "heartbeat", cron: "*/15 * * * *", enabled: true, label: "巡检：到期提醒、等待回复与关注事项" },
  { id: "dream", kind: "dream", cron: "30 3 * * *", enabled: false, label: "每晚整理记忆与页面" },
  { id: "repo-sync", kind: "repo-sync", cron: "0 * * * *", enabled: false, label: "每小时同步代码仓库空间并检查受影响页面" },
];
export const scheduleLabels = Object.fromEntries(DEFAULTS.map((d) => [d.kind, d.label]));

export function ensureDefaultSchedules(app: App) {
  for (const d of DEFAULTS)
    run(app.db, "insert or ignore into schedules(id,kind,cron,config,enabled) values(?,?,?,?,?)", d.id, d.kind, d.cron, "{}", d.enabled ? 1 : 0);
}

export function listSchedules(app: App) {
  return all<Row>(app.db, "select * from schedules order by id").map(toSchedule);
}

export function upsertSchedule(app: App, input: Partial<Schedule> & { kind: string; cron: string }) {
  new Cron(input.cron, { paused: true, timezone: app.config.timezone }).stop(); // validates
  const id = input.id ?? newId("sch");
  run(
    app.db,
    `insert into schedules(id,kind,cron,space_id,config,enabled) values(?,?,?,?,?,?)
     on conflict(id) do update set cron=excluded.cron, space_id=excluded.space_id, config=excluded.config, enabled=excluded.enabled`,
    id,
    input.kind,
    input.cron,
    input.spaceId ?? null,
    JSON.stringify(input.config ?? {}),
    input.enabled ? 1 : 0,
  );
  restartScheduler(app);
  return toSchedule(one<Row>(app.db, "select * from schedules where id = ?", id)!);
}

type Runner = (app: App, s: Schedule) => void;
const runners = new Map<string, Runner>();
export function registerScheduleKind(kind: string, runner: Runner) {
  runners.set(kind, runner);
}

let jobs: Cron[] = [];
export function restartScheduler(app: App) {
  for (const j of jobs) j.stop();
  jobs = [];
  for (const s of listSchedules(app)) {
    if (!s.enabled) continue;
    const runner = runners.get(s.kind);
    if (!runner) continue;
    jobs.push(
      new Cron(s.cron, { timezone: app.config.timezone, protect: true }, () => {
        run(app.db, "update schedules set last_run_at = ? where id = ?", now(), s.id);
        try {
          runner(app, s);
        } catch (e) {
          console.warn(`[omem] 定时任务 ${s.id} 失败`, e);
        }
      }),
    );
  }
}

export function triggerSchedule(app: App, id: string) {
  const s = listSchedules(app).find((x) => x.id === id);
  if (!s) return false;
  runners.get(s.kind)?.(app, s);
  run(app.db, "update schedules set last_run_at = ? where id = ?", now(), s.id);
  return true;
}

export function nextRuns(app: App) {
  return Object.fromEntries(listSchedules(app).map((s) => [s.id, s.enabled ? (new Cron(s.cron, { paused: true, timezone: app.config.timezone }).nextRun()?.toISOString() ?? null) : null]));
}
