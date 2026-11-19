import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { defineMetric, getMetric } from "./metrics.ts";

/**
 * omem's own use, kept day by day as metrics (source `omem`): how many runs of each kind and how they
 * ended, how long they took and on which AI, how answers were judged (by the owner or by the labelling
 * model, and whether a later pass revised it), what the 关注 cases decided, new conversations by channel.
 * Raw runs and events age out; these daily points stay, so the data page and later reviews have history.
 * Taken by the heartbeat once a day for the days not yet taken (up to 30 back).
 */
type Def = { id: string; name: string; description: string; unit: string; sql: string; dims: string[] };

const DEFS: Def[] = [
  {
    id: "omem.runs", name: "omem 运行数", unit: "次", description: "每天开始的运行，按类型、结果和触发方式分。",
    sql: "select kind, status, coalesce(trigger, '') trigger, count(*) value from runs where created_at >= ? and created_at < ? group by 1, 2, 3", dims: ["kind", "status", "trigger"],
  },
  {
    id: "omem.run_minutes", name: "omem 运行时长", unit: "分钟", description: "每天结束的运行花的时间（开始到结束），按类型分。",
    sql: "select kind, round(sum((julianday(finished_at) - julianday(started_at)) * 1440), 1) value from runs where finished_at >= ? and finished_at < ? and started_at is not null group by 1", dims: ["kind"],
  },
  {
    id: "omem.runs_by_ai", name: "omem 各 AI 的运行", unit: "次", description: "每天结束的运行用的后端和模型。",
    sql: "select coalesce(json_extract(ai, '$.profile'), profile_id, '') profile, coalesce(json_extract(ai, '$.model'), '') model, count(*) value from runs where finished_at >= ? and finished_at < ? group by 1, 2", dims: ["profile", "model"],
  },
  {
    id: "omem.reply_outcomes", name: "回答有没有用", unit: "条", description: "每天发出的回答后来被判成什么：谁判的（本人 / 模型），之后有没有被复判改过。",
    sql: "select coalesce(revised_label, label, '未判') label, case when \"by\" = 'owner' then '本人' when label is null then '' else '模型' end judge, case when revised_label is not null then '改判过' else '' end revised, count(*) value from reply_outcomes where at >= ? and at < ? group by 1, 2, 3", dims: ["label", "judge", "revised"],
  },
  {
    id: "omem.cases", name: "关注和有人找你的案例", unit: "个", description: "每天新增的案例，按来源和本人的决定（照发、改了、没发、本人自己回、没回……）。",
    sql: "select source, coalesce(decision, case when owner_reply is not null then 'owner-replied' else 'none' end) decision, count(*) value from reply_samples where created_at >= ? and created_at < ? group by 1, 2", dims: ["source", "decision"],
  },
  {
    id: "omem.conversations", name: "新会话", unit: "个", description: "每天新开的会话，按渠道。",
    sql: "select channel, count(*) value from conversations where created_at >= ? and created_at < ? group by 1", dims: ["channel"],
  },
];

/** The owner's day boundaries as UTC instants (a fixed offset of the configured time zone). */
function dayStart(tz: string, day: string) {
  const probe = new Date(`${day}T12:00:00Z`);
  const local = new Date(probe.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  const offset = local.getTime() - utc.getTime();
  return new Date(Date.parse(`${day}T00:00:00Z`) - offset);
}
function localDay(tz: string, at = new Date()) {
  return at.toLocaleDateString("en-CA", { timeZone: tz });
}

const KEY = "omem_usage_snapshot_day";

/** Take the days not yet taken, up to yesterday (at most `maxDays` back). Returns the days taken. */
export function snapshotOmemUsage(app: App, opts: { now?: Date; maxDays?: number } = {}) {
  const tz = app.config.timezone || "Asia/Shanghai";
  const today = localDay(tz, opts.now);
  const last = one<{ value: string }>(app.db, "select value from kv where key = ?", KEY)?.value;
  const days: string[] = [];
  for (let i = opts.maxDays ?? 30; i >= 1; i--) {
    const d = localDay(tz, new Date(dayStart(tz, today).getTime() - i * 86400_000 + 12 * 3600_000));
    if (!last || d > last) days.push(d);
  }
  if (!days.length) return [];
  for (const def of DEFS) if (!getMetric(app, def.id)) defineMetric(app, { id: def.id, name: def.name, description: def.description, unit: def.unit, source: "omem", query: "omem 每天自己统计（宿主写入，不用取数）", schedule: "none" });
  const at = new Date().toISOString();
  for (const day of days) {
    const from = dayStart(tz, day).toISOString();
    const to = new Date(dayStart(tz, day).getTime() + 86400_000).toISOString();
    for (const def of DEFS) {
      for (const r of all<Record<string, string | number>>(app.db, def.sql, from, to)) {
        const dims = Object.fromEntries(def.dims.map((k) => [k, String(r[k] ?? "")]).filter(([, v]) => v !== ""));
        const key = JSON.stringify(Object.fromEntries(Object.entries(dims).sort(([a], [b]) => a.localeCompare(b))));
        run(app.db, "insert into metric_points(metric_id,at,value,dims,note,run_id,created_at) values(?,?,?,?,null,null,?) on conflict(metric_id,at,dims) do update set value=excluded.value, created_at=excluded.created_at", def.id, day, Number(r.value) || 0, key, at);
      }
    }
  }
  for (const def of DEFS) run(app.db, "update metrics set last_at = ? where id = ?", at, def.id);
  run(app.db, "insert into kv(key,value) values(?,?) on conflict(key) do update set value = excluded.value", KEY, days.at(-1)!);
  return days;
}
