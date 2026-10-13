import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { learningProgress, studyStats } from "./cards.ts";

/**
 * A learning goal ("英语口语：工作中开会和写邮件"): which space holds its
 * material, how many new cards a day, and when to be reminded. The daily
 * learning job feeds new cards from fresh material, and reminds at the chosen
 * time when cards are due; reviews update the goal's progress.
 */
export type LearnGoal = {
  id: string;
  userId: string;
  spaceId: string;
  title: string;
  detail: string;
  dailyNew: number;
  remindAt: string;
  status: "active" | "paused" | "done";
  createdAt: string;
  updatedAt: string;
  lastFedAt: string | null;
  lastRemindedAt: string | null;
};
type Row = {
  id: string;
  user_id: string;
  space_id: string;
  title: string;
  detail: string;
  daily_new: number;
  remind_at: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_fed_at: string | null;
  last_reminded_at: string | null;
};
const toGoal = (r: Row): LearnGoal => ({
  id: r.id,
  userId: r.user_id,
  spaceId: r.space_id,
  title: r.title,
  detail: r.detail,
  dailyNew: r.daily_new,
  remindAt: r.remind_at,
  status: r.status as LearnGoal["status"],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastFedAt: r.last_fed_at,
  lastRemindedAt: r.last_reminded_at,
});

export function getGoal(app: App, id: string) {
  const r = one<Row>(app.db, "select * from learn_goals where id = ?", id);
  if (!r) throw new HttpError(404, `学习目标不存在：${id}`);
  return toGoal(r);
}

export function listGoals(app: App, opts: { userId?: string; status?: string } = {}) {
  const w: string[] = [];
  const p: string[] = [];
  if (opts.userId) w.push("user_id = ?"), p.push(opts.userId);
  if (opts.status && opts.status !== "all") w.push("status = ?"), p.push(opts.status);
  return all<Row>(app.db, `select * from learn_goals ${w.length ? "where " + w.join(" and ") : ""} order by created_at`, ...p).map(toGoal);
}

export function upsertGoal(app: App, id: string | undefined, input: Partial<Omit<LearnGoal, "id" | "createdAt" | "updatedAt">>) {
  if (input.remindAt && !/^\d{1,2}:\d{2}$/.test(input.remindAt)) throw new HttpError(400, "提醒时间写成 HH:MM");
  const at = now();
  if (!id) {
    if (!input.title || !input.spaceId) throw new HttpError(400, "学习目标需要标题和空间");
    const gid = newId("g");
    run(
      app.db,
      "insert into learn_goals(id,user_id,space_id,title,detail,daily_new,remind_at,status,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)",
      gid,
      input.userId ?? "owner",
      input.spaceId,
      input.title,
      input.detail ?? "",
      input.dailyNew ?? 10,
      input.remindAt ?? "20:30",
      input.status ?? "active",
      at,
      at,
    );
    return getGoal(app, gid);
  }
  const g = getGoal(app, id);
  const n = { ...g, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as LearnGoal;
  run(
    app.db,
    "update learn_goals set space_id=?, title=?, detail=?, daily_new=?, remind_at=?, status=?, updated_at=?, last_fed_at=?, last_reminded_at=? where id=?",
    n.spaceId,
    n.title,
    n.detail,
    n.dailyNew,
    n.remindAt,
    n.status,
    at,
    n.lastFedAt,
    n.lastRemindedAt,
    id,
  );
  return getGoal(app, id);
}

/** Local date (YYYY-MM-DD) and minutes since midnight in the configured time zone. */
export function localClock(app: App, d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: app.config.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function goalSummary(app: App, g: LearnGoal) {
  const stats = studyStats(app, { goalId: g.id, userId: g.userId });
  const p = learningProgress(app, { goalId: g.id, userId: g.userId });
  return {
    ...g,
    stats,
    progress: p,
    text: `${g.title}：${stats.total} 张卡（${p.mature} 张已掌握），${stats.due} 张到期；近 30 天复习 ${p.reviews} 次，记住率 ${p.recall === null ? "—" : Math.round(p.recall * 100) + "%"}，连续 ${p.streak} 天${p.weak.length ? `；反复忘：${p.weak.slice(0, 5).map((w) => w.front.slice(0, 20)).join("、")}` : ""}`,
  };
}
