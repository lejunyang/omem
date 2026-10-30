import { Cron } from "croner";
import type { App } from "./app.ts";
import { all, one, run } from "./db.ts";
import { json, newId, now } from "./util.ts";

export type Schedule = { id: string; kind: string; cron: string; spaceId: string | null; config: Record<string, unknown>; enabled: boolean; lastRunAt: string | null };
type Row = { id: string; kind: string; cron: string; space_id: string | null; config: string; enabled: number; last_run_at: string | null };
const toSchedule = (r: Row): Schedule => ({ id: r.id, kind: r.kind, cron: r.cron, spaceId: r.space_id, config: json(r.config, {}), enabled: !!r.enabled, lastRunAt: r.last_run_at });

/**
 * Built-in schedules exist from the start. A library created after a default changed gets the new
 * default; existing ones keep the row they have (`insert or ignore`), so turning the nightly dream on
 * by default does not switch it on for libraries that already had it off.
 */
const DEFAULTS: { id: string; kind: string; cron: string; enabled: boolean; label: string }[] = [
  { id: "heartbeat", kind: "heartbeat", cron: "*/15 * * * *", enabled: true, label: "巡检：到期提醒、等待回复与关注事项" },
  { id: "activity", kind: "activity", cron: "*/30 * * * *", enabled: true, label: "记录代码仓库的活动：新提交和未提交的改动（只读本机 Git）" },
  { id: "learn", kind: "learn", cron: "*/15 * * * *", enabled: true, label: "学习：每天按学习目标出新卡，到点提醒复习（没有学习目标时什么都不做）" },
  { id: "brief", kind: "brief", cron: "45 8 * * 1-5", enabled: false, label: "工作日早上的简报：今天要处理的、在等的、发生的变化" },
  { id: "memory-review", kind: "memory-review", cron: "20 * * * *", enabled: true, label: "复核新写入的记忆：保留、改写或撤回（可配置成与写入不同的模型；没有新记忆时什么都不做）" },
  { id: "item-sweep", kind: "item-sweep", cron: "7 * * * *", enabled: true, label: "事项收尾：没有新进展的按期限自动过期；本人在来源会话里回过、回了表情的，交给助理判断是否已办并关掉（都能在事项页恢复）" },
  { id: "item-digest", kind: "item-digest", cron: "30 9 * * *", enabled: true, label: "事项清点：每天一张卡片，列出自动收尾的和明天过期的，可逐条保留或恢复（没有变化时不发）" },
  { id: "memory-organize", kind: "memory-organize", cron: "50 */2 * * *", enabled: true, label: "整理记忆目录：把还没归档的记忆放进目录，每周看一遍目录结构（拆、并、改名、补说明；没有新记忆时什么都不做）" },
  { id: "dream", kind: "dream", cron: "30 3 * * *", enabled: true, label: "每晚整理记忆与页面：合并重复和存量整理写下的经验记忆、处理冲突与过期、按不足信号补漏（第一次只看最近 7 天）" },
  { id: "profile-review", kind: "profile-review", cron: "10 4 * * *", enabled: true, label: "复盘 Agent 档案和内置角色：最近的运行和本人随后的纠正沉淀成它们的记忆，提示词、技能和设置的改动提为待确认的建议（最近没有足够运行或没有纠正时什么都不做）" },
  { id: "replay", kind: "replay", cron: "30 4 * * *", enabled: false, label: "夜间复盘：挑最近的问题回到提问时重答，基线和只改一处的变体对比，盲评后把结论用在记忆复核、原件级别和任务选型上（先给 replay-judge 选模型；每晚题数在设置 → Agent 里改）" },
  { id: "repo-sync", kind: "repo-sync", cron: "0 * * * *", enabled: false, label: "每小时同步代码仓库空间并检查受影响页面" },
  { id: "lark-curate", kind: "lark-curate", cron: "15 9 * * 1", enabled: false, label: "每周按设定方向筛选值得关注的飞书群（需要填写方向）" },
  { id: "lark-docs-watch", kind: "lark-docs-watch", cron: "40 4 * * *", enabled: true, label: "检查飞书文档有没有更新：上次修改后 7 天、1 个月、3 个月、半年、一年各查一次，有修改才重新读（没有飞书文档时什么都不做）" },
  { id: "digest", kind: "digest", cron: "*/10 * * * *", enabled: true, label: "整理存量材料：按本人开的整理任务，一批一批地给原件分级、把重点材料提炼成知识页和记忆（没有进行中的整理任务时什么都不做）" },
  { id: "lark-poll", kind: "lark-poll", cron: "*/10 * * * *", enabled: false, label: "采集飞书消息（全部或已订阅的会话，含附件和文档）、日程和妙记（只读）；被监听的群交给处理 Agent" },
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

export function deleteSchedule(app: App, id: string) {
  run(app.db, "delete from schedules where id = ?", id);
  restartScheduler(app);
}
