import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import type { Direction, Trial, Finding } from "../studies/store.ts";
import { fixVerified } from "../studies/fix.ts";
import { flowLog, reviewStages, type ReviewStageDef } from "../flows/review.ts";
import { accessibleSpaces, OWNER } from "../core/users.ts";
import { runReadableSpaces } from "../auth/permissions.ts";
import { DECISION_SCENES } from "../core/decision-scenes.ts";
import { HttpError, localStamp } from "../core/util.ts";
import { replyOutcomes } from "../agents/reply-outcomes.ts";
import { sceneOf, scenes, sceneTable } from "./scenes.ts";
import type { Metric, RecordRef, Section, Report } from "./types.ts";

const flag = z.preprocess(v => v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v, z.boolean().default(false));
export const insightFilters = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), space: z.string().max(200).optional(), by: z.string().max(200).optional(),
  bot: z.string().max(100).optional(), scene: z.enum(scenes).optional(), profile: z.string().max(200).optional(), model: z.string().max(200).optional(),
  chat: z.string().max(300).optional(), compare: flag, housekeeping: flag,
});
export type Filters = Partial<z.input<typeof insightFilters>>;
type Normal = z.output<typeof insightFilters> & { from: string; to: string; start: string; end: string; days: number };
type RunRow = {
  id: string; created_at: string; kind: string; status: string; space_id: string | null; user_id: string | null; trigger_by: string | null;
  profile_id: string | null; ai: string | null; started_at: string | null; finished_at: string | null; roles: string | null;
  spec: string | null; via: string | null; place: string | null; bot: string | null; root: string | null; applied: string | null; discarded: string | null;
  verdict: string | null; triage: string | null; handled: string | null; joined: string | null; quiet: number; waited: number | null;
};
// Each expression below is also in runs_insights. SQLite reads its value from the index, never the JSON blobs.
export const RUN_COLUMNS = `id, created_at, kind, status, space_id, user_id, trigger_by, profile_id, ai, started_at, finished_at, roles, quiet,
 json_extract(input, '$.spec') spec, json_extract(trigger, '$.via') via, json_extract(trigger, '$.where') place,
 coalesce(json_extract(input, '$.lark.bot'), json_extract(input, '$.bot')) bot, json_extract(input, '$.continueFrom') root,
 json_extract(output, '$.appliedAt') applied, json_extract(output, '$.discardedAt') discarded, json_extract(output, '$.verdict') verdict,
 json_extract(output, '$.triage.action') triage, json_extract(output, '$.handleRun') handled, json_extract(output, '$.joined') joined,
 json_extract(input, '$.waited') waited`;
export const DAILY_SQL = `select ${RUN_COLUMNS} from runs indexed by runs_insights where created_at >= ? and created_at < ?`;
type Ctx = { app: App; viewer: string; f: Normal; runs: RunRow[]; ids: Set<string>; records: Map<string, RecordRef[]>; visible: (r: RunRow) => boolean; link: (key: string) => string };
const round = (n: number) => Math.round(n * 10) / 10;
const ratio = (n: number, d: number) => d ? round(100 * n / d) : null;
// Reuse the formatter: creating one per row costs seconds at normal library scale.
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function localDay(at: string | number, zone: string) {
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    if (dayFormatters.size >= 16) dayFormatters.delete(dayFormatters.keys().next().value!);
    dayFormatters.set(zone, formatter);
  }
  return formatter.format(new Date(at));
}
const dayAdd = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
function midnight(day: string, zone: string) {
  const target = Date.parse(`${day}T00:00:00Z`);
  let ms = target;
  for (let i = 0; i < 5; i++) {
    const local = Date.parse(localStamp(ms, zone, { seconds: true }).replace(" ", "T") + "Z");
    const delta = target - local;
    if (!delta) break;
    ms += delta;
  }
  return new Date(ms).toISOString();
}
export function normalizeFilters(app: App, input: Filters = {}): Normal {
  const parsed = insightFilters.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "筛选条件不正确");
  const f = parsed.data;
  for (const day of [f.from, f.to]) if (day && (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) throw new HttpError(400, "日期须为有效的 YYYY-MM-DD");
  const to = f.to ?? localDay(Date.now(), app.config.timezone);
  const from = f.from ?? dayAdd(to, -29);
  for (const s of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new HttpError(400, "日期须为有效的 YYYY-MM-DD");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  if (days < 1 || days > 180) throw new HttpError(400, "时间范围要在 1 到 180 天之间");
  return { ...f, from, to, days, start: midnight(from, app.config.timezone), end: midnight(dayAdd(to, 1), app.config.timezone) };
}
function queryString(f: Normal) {
  return new URLSearchParams(Object.entries(f).filter(([k, v]) => !["start", "end", "days"].includes(k) && v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
}
function matchesFilters(f: Normal, r: RunRow) {
  return (!f.space || r.space_id === f.space) && (!f.by || r.trigger_by === f.by) && (!f.bot || r.bot === f.bot)
    && (!f.scene || sceneOf(r) === f.scene) && (!f.profile || r.spec === f.profile || r.roles?.split("|").includes(f.profile))
    && (!f.model || parseAi(r.ai).model === f.model) && (!f.chat || r.place === f.chat);
}
function context(app: App, viewer: string, f: Normal): Ctx {
  const allowed = accessibleSpaces(app, viewer);
  const readable = runReadableSpaces(app, viewer);
  const visible = (r: RunRow) => {
    // Insights deliberately narrower than shared run history: members see their own part only.
    if (viewer !== OWNER && r.user_id !== viewer && r.trigger_by !== `user:${viewer}`) return false;
    if (viewer !== OWNER && r.space_id && allowed !== null && !allowed.includes(r.space_id)) return false;
    if (viewer !== OWNER && r.user_id !== viewer && readable !== null && (!r.space_id || !readable.includes(r.space_id))) return false;
    return true;
  };
  const runs = all<RunRow>(app.db, DAILY_SQL, f.start, f.end).filter(r => visible(r) && matchesFilters(f, r));
  return { app, viewer, f, runs, ids: new Set(runs.map(r => r.id)), records: new Map(), visible, link: key => `#/insights?${queryString(f)}&detail=${encodeURIComponent(key)}` };
}
function parseAi(s: string | null): { profile?: string; model?: string } { try { return JSON.parse(s ?? "null") ?? {}; } catch { return {}; } }
const RUN_STATUS: Record<string, string> = { done: "做完", failed: "失败", cancelled: "取消", running: "进行中", queued: "排队中" };
const runReferences = new WeakMap<RunRow, RecordRef>();
const refRun = (r: RunRow): RecordRef => {
  let ref = runReferences.get(r);
  if (!ref) { ref = { id: r.id, label: `${sceneOf(r)} · ${RUN_STATUS[r.status] ?? r.status}`, at: r.created_at, link: `#/runs/${r.id}` }; runReferences.set(r, ref); }
  return ref;
};
const refs = (rs: RunRow[]) => rs.map(refRun);
function metric(c: Ctx, key: string, label: string, value: number | null, records: RecordRef[], unit?: string, note?: string, cell?: Metric["cell"]): Metric {
  c.records.set(key, records);
  return { key, label, value, link: c.link(key), ...(unit ? { unit } : {}), ...(note ? { note } : {}), ...(cell ? { cell } : {}) };
}
const section = (id: string, title: string, description: string): Section => ({ id, title, description, metrics: [], charts: [], notes: [] });
const percent = (xs: number[], p: number) => xs.length ? round([...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)]) : null;
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? round((a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2) : null; };
const usageRuns = (c: Ctx) => c.runs.filter(r => c.f.housekeeping || sceneOf(r) !== "整理（后台）");
function grouped(c: Ctx, s: Section, key: string, label: string, rows: RunRow[], by: (r: RunRow) => string, top?: number) {
  const groups = new Map<string, RunRow[]>();
  for (const r of rows) { const k = by(r); const g = groups.get(k) ?? []; g.push(r); groups.set(k, g); }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, top);
  const points = sorted.map(([k, rs]) => metric(c, `${key}:${k}`, `${label} · ${k}`, rs.length, refs(rs), undefined, undefined, { table: label, row: k, col: "次数" }));
  s.metrics.push(...points);
  const plotted = sorted.slice(0, 12);
  if (plotted.length) s.charts.push({ title: `${label}${sorted.length > 12 ? "（前 12 项，全部见指标）" : ""}`, kind: "hbar", labels: plotted.map(x => x[0]), series: [{ name: "运行", values: plotted.map(x => x[1].length) }], points: points.slice(0, 12) });
}
export function usageSection(c: Ctx): Section {
  const s = section("usage", "用了多少", "这段时间 omem 做了多少件事、有几个人在用。系统自己的整理，和没有新动静的定时巡检，另外算，不计在内。");
  const rs = usageRuns(c), upkeep = c.runs.filter(r => sceneOf(r) === "整理（后台）");
  if (!rs.length && !upkeep.length) return { ...s, empty: "这段时间还没有记录。向助手提一个问题，这里就会有数。" };
  const finished = rs.filter(r => ["done", "failed"].includes(r.status) && sceneOf(r) !== "整理（后台）");
  s.metrics = [metric(c, "usage:total", "做了多少件", rs.length, refs(rs)), metric(c, "usage:upkeep", "系统自己的整理", upkeep.length, refs(upkeep)),
    metric(c, "usage:success", "成功率", ratio(finished.filter(r => r.status === "done").length, finished.length), refs(finished), "%", "做完的 ÷（做完的 + 失败的）。取消的和还没结束的不算。")];
  s.metrics.push(metric(c, "usage:people", "用过的人", new Set(rs.flatMap(r => r.trigger_by ? [r.trigger_by] : r.user_id ? [`user:${r.user_id}`] : [])).size, refs(rs.filter(r => r.trigger_by || r.user_id)), undefined, "按是谁触发的去重。同一个人在飞书和网页上可能算成两个。"));
  const days = Array.from({ length: c.f.days }, (_, i) => dayAdd(c.f.from, i));
  const counts = new Map<string, number>();
  const weeks = new Map<string, [Set<string>, Set<string>, Set<string>]>();
  const weeklyRows = new Map<string, RunRow[][]>();
  const dailyRows = new Map<string, RunRow[]>();
  let unknown = 0;
  for (const r of rs) {
    const day = localDay(r.created_at, c.app.config.timezone), scene = sceneOf(r);
    counts.set(`${day}/${scene}`, (counts.get(`${day}/${scene}`) ?? 0) + 1);
    const daily = dailyRows.get(`${day}/${scene}`) ?? []; daily.push(r); dailyRows.set(`${day}/${scene}`, daily);
    const weekday = new Date(day).getUTCDay(); const week = dayAdd(day, -((weekday + 6) % 7));
    if (!weeks.has(week)) { weeks.set(week, [new Set(), new Set(), new Set()]); weeklyRows.set(week, [[], [], []]); }
    const key = r.trigger_by ?? (r.user_id ? `user:${r.user_id}` : null);
    if (!key) { unknown++; continue; }
    const kind = key === "user:owner" ? 0 : key.startsWith("user:") ? 1 : 2;
    weeks.get(week)![kind].add(key);
    weeklyRows.get(week)![kind].push(r);
  }
  const plotted = scenes.filter(x => c.f.housekeeping || x !== "整理（后台）");
  s.charts.push({ title: "每天做了多少件", kind: "area", stack: true, labels: days, series: plotted.map(name => ({ name, values: days.map(d => counts.get(`${d}/${name}`) ?? 0) })),
    points: days.flatMap(d => plotted.map(name => metric(c, `usage:day:${d}:${name}`, `${d} · ${name}`, counts.get(`${d}/${name}`) ?? 0, refs(dailyRows.get(`${d}/${name}`) ?? [])))) });
  const weekKeys = [...weeks.keys()].sort();
  s.charts.push({ title: "每周用过的人", kind: "line", labels: weekKeys, series: ["本人", "成员", "访客与机器人"].map((name, i) => ({ name, values: weekKeys.map(w => weeks.get(w)![i].size) })) });
  for (const w of weekKeys) for (const [i, label] of ["本人", "成员", "访客与机器人"].entries()) {
    const keys = weeks.get(w)![i];
    s.metrics.push(metric(c, `usage:week:${w}:${i}`, `${w} 周 · ${label}`, keys.size, refs(weeklyRows.get(w)![i]), undefined, undefined, { table: "每周用过的人", row: `${w} 起`, col: label }));
  }
  s.charts[1].points = s.metrics.filter(m => m.key.startsWith("usage:week:"));
  if (unknown) s.metrics.push(metric(c, "usage:unknown", "不知道是谁触发的", unknown, refs(rs.filter(r => !r.trigger_by && !r.user_id)), undefined, "较早的记录没有记下是谁触发的，这里不猜。"));
  return s;
}
export function coverageSection(c: Ctx): Section {
  const s = section("coverage", "用在哪", "这些事按用途、空间和 Agent 分别是多少。会话只数次数，不读消息内容。");
  const rs = usageRuns(c);
  if (!rs.length) return { ...s, empty: "这段时间还没有记录。" };
  grouped(c, s, "coverage:scene", "场景", rs, sceneOf);
  grouped(c, s, "coverage:space", "空间", rs, r => r.space_id ?? "不属于哪个空间");
  grouped(c, s, "coverage:profile", "Agent", rs, r => r.spec ?? r.roles?.split("|").filter(Boolean)[0] ?? "没记下是哪个");
  grouped(c, s, "coverage:chat", "触发会话（前十）", rs.filter(r => r.place), r => r.place!, 10);
  s.notes.push("用途按任务的类型归：对话算问答，交办算编码；说不清的 Agent 任务算排查。名字相同的会话算作一个。较早的记录没有记下在哪里触发的，这里不猜。");
  return s;
}
type Sample = { id: string; handle_run: string | null; created_at: string; last_ms: number; owner_reply_at: string | null; decision: string | null };
function samples(c: Ctx) {
  return all<Sample>(c.app.db, "select id, handle_run, created_at, last_ms, owner_reply_at, decision from reply_samples where created_at >= ? and created_at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.id));
}
function sampleRefs(c: Ctx, xs: Sample[]): RecordRef[] { return xs.map(r => ({ id: r.id, label: `回复样本 · ${r.decision ?? "未决定"}`, at: r.created_at, link: `#/runs/${r.id}` })); }
export function shieldSection(c: Ctx): Section {
  const s = section("shield", "替你挡了多少", "别人在群里 @ 你或私聊你时，omem 先看了多少、筛掉多少、替你查了多少，以及你看到提醒以后的反应。");
  if (c.viewer !== OWNER) return { ...s, empty: "这一块只有主人能看。" };
  const rs = c.runs.filter(r => r.kind === "mention" && !(r.waited && r.waited > 0));
  if (!rs.length) return { ...s, empty: "还没有记录。打开 设置 → 代你回复 → 有人找你 以后，这里会出现。" };
  const triaged = rs.filter(r => !!r.triage), screened = rs.filter(r => r.status === "done" && r.quiet && !r.triage && !r.handled && !r.joined);
  const handled = rs.filter(r => r.handled || r.joined);
  const ss = samples(c).filter(x => handled.some(r => r.id === x.id));
  const answers = ss.filter(x => ["sent", "edited", "auto"].includes(x.decision ?? ""));
  const notices = all<{ id: string; at: string; outcome: string | null; run_id: string }>(c.app.db,
    `select id, at, outcome, json_extract(context, '$.runId') run_id from notifications where user_id = 'owner' and at >= ? and at < ?
      and coalesce(json_extract(context, '$.urgency'), '') != 'silent' and json_extract(context, '$.replacedBy') is null and json_extract(context, '$.bundle') is null
      and coalesce(outcome, '') != 'bundled'`, c.f.start, c.f.end).filter(n => c.ids.has(n.run_id) && (c.runs.find(r => r.id === n.run_id)?.via === "mention" || c.runs.find(r => r.id === n.run_id)?.kind === "mention"));
  const noticeRefs = (ns: typeof notices) => ns.map(n => ({ id: n.id, at: n.at, label: `通知 · ${n.outcome ?? "待标注"}`, link: "#/notifications", value: n.outcome ?? "待标注" }));
  const delivered = rs.filter(r => answers.some(a => a.id === r.id) || notices.some(n => n.run_id === r.id || n.run_id === r.handled || n.run_id === r.joined));
  const steps: [string, string, RunRow[]][] = [["reached", "找你的（批）", rs], ["screened", "不用管，直接筛掉", screened], ["triaged", "分诊过的", triaged], ["handled", "替你去查的", handled], ["delivered", "提醒了你或替你答了", delivered]];
  for (const [key, label, rows] of steps) s.metrics.push(metric(c, `shield:${key}`, label, rows.length, refs(rows)));
  const path = [rs, triaged, handled.filter(r => !!r.triage), delivered.filter(r => !!r.triage && !!r.handled)];
  s.charts.push({ title: "从找你到提醒你", kind: "hbar", labels: ["找你的", "分诊过的", "替你去查的", "查完提醒或替你答了"].map((label, i) => `${label}${i ? `（上一步的 ${ratio(path[i].length, path[i - 1].length) ?? "—"}%）` : ""}`), series: [{ name: "批次", values: path.map(x => x.length) }], points: path.map((rows, i) => metric(c, `shield:path:${i}`, ["进入流程", "分诊", "分诊后代查", "代查后提醒或代答"][i], rows.length, refs(rows))) });
  s.metrics.push(metric(c, "shield:answered", "替你答了的", answers.length, sampleRefs(c, answers)));
  for (const [key, label] of Object.entries({ acted: "提醒后你处理了", known: "你已经知道了", read: "你只看了", unread: "你没看", negative: "你不满意", pending: "还没到判断的时候" })) {
    const ns = notices.filter(n => key === "pending" ? !n.outcome : n.outcome === key);
    s.metrics.push(metric(c, `shield:outcome:${key}`, label, ns.length, noticeRefs(ns)));
  }
  s.notes.push("进入：mention 首次运行批次（重试等待 waited>0 排除）；预筛：done、quiet 且无 triage/handleRun/joined；分诊：triage.action 有值；代查：handleRun 或 joined 有值；提醒或代答：关联通知或 sent/edited/auto 样本。", "同批可含多条消息。预筛、合并、额度耗尽提醒是旁支；没有独立预筛原因字段，不把未完成运行算成预筛。通知结果沿用 outcome 既有口径，排除静默、替换和捆绑容器；尚未标注的不猜测。筛选和日期均以运行批次为准，通知本身也须在所选日期内。" );
  return s;
}
export function othersSection(c: Ctx): Section {
  const s = section("others", "给别人带来什么", "同事和别的机器人直接问 omem 的次数，以及多久得到回答。旁边是你自己以往回复别人花的时间，供参照。");
  const rs = c.runs.filter(r => r.kind === "guest");
  if (!rs.length) return { ...s, empty: "还没有人直接问过机器人。打开访客提问以后这里会有记录。" };
  const answered = rs.filter(r => r.status === "done" && r.verdict === "answer" && r.finished_at && Date.parse(r.finished_at) >= Date.parse(r.created_at));
  const times = answered.map(r => (Date.parse(r.finished_at!) - Date.parse(r.created_at)) / 1000);
  const own = c.viewer === OWNER ? samples(c).filter(r => r.owner_reply_at && Date.parse(r.owner_reply_at) >= r.last_ms) : [];
  const ownTimes = own.map(r => (Date.parse(r.owner_reply_at!) - r.last_ms) / 1000);
  const enough = times.length >= 10 && ownTimes.length >= 10;
  s.metrics = [metric(c, "others:questions", "直接提问", rs.length, refs(rs)), metric(c, "others:people", "来问的人", new Set(rs.flatMap(r => r.trigger_by ? [r.trigger_by] : [])).size, refs(rs), undefined, "按提问的人去重。同一个人用不同身份可能算成两个。"),
    { ...metric(c, "others:median", "机器人多久答完（中位数）", median(times), refs(answered), "秒"), samples: times.length },
    { ...metric(c, "others:p90", "机器人多久答完（九成在这以内）", percent(times, .9), refs(answered), "秒"), samples: times.length },
    { ...metric(c, "others:owner", "你自己多久回复（中位数）", median(ownTimes), sampleRefs(c, own), "秒"), samples: ownTimes.length }];
  if (enough) s.charts.push({ title: `已完成样本的用时（机器人 n=${times.length}；本人 n=${ownTimes.length}）`, kind: "hbar", labels: ["机器人完成", "本人自行回复"], unit: "秒", series: [{ name: "中位数", values: [median(times)!, median(ownTimes)!] }], points: s.metrics.filter(m => ["others:median", "others:owner"].includes(m.key)) });
  else s.notes.push(`机器人的回答有 ${times.length} 个样本，你自己的回复有 ${ownTimes.length} 个。任何一边不到 10 个就不画对比，也不下“更快”的结论。`);
  grouped(c, s, "others:chat", "访客提问所在会话", rs.filter(r => r.place), r => r.place!);
  s.notes.push("你自己的回复时间取自“有人找你”的记录：对方的消息到你自己回复之间隔了多久，不读回复的内容。两边是不同的问题，只能当参照，不能直接算成省了多少时间。机器人的时间从任务开始算到任务结束，包含排队。");
  return s;
}
export function qualitySection(c: Ctx): Section {
  const s = section("quality", "做得怎么样", "只数有记录的：大家点的表情、回复草稿你发没发、评审意见采没采纳、每晚抽检和复盘的结果。没人反馈不等于满意。");
  const feedback = all<{ id: string; run_id: string; polarity: string; at: string }>(c.app.db, "select id, run_id, polarity, at from feedback where at >= ? and at < ? and removed_at is null and on_bot = 1 and actor_kind != 'bot'", c.f.start, c.f.end).filter(r => c.ids.has(r.run_id));
  const fr = (xs: typeof feedback) => xs.map(r => ({ id: r.id, label: `反馈 · ${r.polarity}`, at: r.at, link: `#/runs/${r.run_id}` }));
  const feedbackRuns = new Set(feedback.map(f => f.run_id));
  if (feedback.length) for (const [pol, label] of [["positive", "正面"], ["negative", "负面"]]) {
    const fs = feedback.filter(f => f.polarity === pol);
    s.metrics.push(metric(c, `quality:${pol}`, `${label}反馈条数`, fs.length, fr(fs)), metric(c, `quality:${pol}Rate`, `${label}反馈运行占比`, ratio(new Set(fs.map(f => f.run_id)).size, feedbackRuns.size), fr(feedback), "%", "有这类反馈的任务 ÷ 收到过任何反馈的任务。同一个任务可能两种都有。"));
  }
  const ss = c.viewer === OWNER ? samples(c) : [];
  for (const [key, label] of [["sent", "草稿你照发了"], ["edited", "草稿你改了再发"], ["dropped", "草稿你没发"], ["auto", "自动替你答了"]]) if (ss.some(x => x.decision)) {
    const xs = ss.filter(x => x.decision === key); s.metrics.push(metric(c, `quality:draft:${key}`, label, xs.length, sampleRefs(c, xs)));
  }
  const decided = ss.filter(x => ["sent", "edited", "dropped"].includes(x.decision ?? ""));
  if (decided.length) s.metrics.push(metric(c, "quality:draft:rate", "草稿照发率", ratio(decided.filter(x => x.decision === "sent").length, decided.length), sampleRefs(c, decided), "%", "照发 ÷（照发 + 改了再发 + 没发）。自动发出的不算。"));
  const findings = all<{ id: number; code_run_id: string; check_name: string; state: string; decision: string | null; created_at: string }>(c.app.db,
    "select f.id, r.code_run_id, r.check_name, f.state, f.decision, r.created_at from review_findings f join reviews r on r.id = f.review_id where r.created_at >= ? and r.created_at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.code_run_id));
  for (const check of new Set(findings.map(f => f.check_name))) {
    const fs = findings.filter(f => f.check_name === check);
    for (const [key, label, xs] of [
      ["accepted", "采纳", fs.filter(f => f.decision === "fix" || f.decision === "later" || f.decision !== "wontfix" && ["accepted", "fixed"].includes(f.state))],
      ["rejected", "不采纳", fs.filter(f => f.decision === "wontfix" || f.state === "rejected" && !["fix", "later"].includes(f.decision ?? ""))],
    ] as const) s.metrics.push(metric(c, `quality:check:${check}:${key}`, `${check} · ${label}`, xs.length, xs.map(f => ({ id: String(f.id), at: f.created_at, label: `${check} · ${label}`, link: `#/runs/${f.code_run_id}` })), undefined, undefined, { table: "评审意见的去向", row: check, col: label }));
    const points = s.metrics.slice(-2);
    s.charts.push({ title: `评审项 · ${check}`, kind: "hbar", labels: ["采纳", "不采纳"], series: [{ name: "发现", values: points.map(m => m.value ?? 0) }], points });
    const decidedRefs = points.flatMap(m => c.records.get(m.key) ?? []);
    if (decidedRefs.length) s.metrics.push(metric(c, `quality:check:${check}:rate`, `${check} · 采纳率`, ratio(points[0].value ?? 0, decidedRefs.length), decidedRefs, "%", "采纳 ÷（采纳 + 不采纳）。没裁决的和被合并的不算。", { table: "评审意见的去向", row: check, col: "采纳率" }));
  }
  const audits = all<{ id: string; at: string; verdict: string; audit_run: string | null; space_id: string; category: string }>(c.app.db, "select id, at, verdict, audit_run, space_id, category from quality_audits where at >= ? and at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.audit_run ?? ""));
  for (const category of ["page", "level"]) {
    const as = audits.filter(a => a.category === category && a.verdict !== "unchecked");
    if (as.length) s.metrics.push(metric(c, `quality:audit:${category}`, category === "page" ? "写作抽检准确率" : "定级抽检准确率", ratio(as.filter(a => a.verdict !== "wrong").length, as.length), as.map(a => ({ id: a.id, at: a.at, label: `抽检 · ${a.verdict}`, link: "#/quality" })), "%", "只算核完的。只有写法问题、事实没错的算准确。"));
  }
  // How replies went, read from what people said afterwards (agents/reply-outcomes.ts): a small table by who was answered.
  const outcomes = replyOutcomes(c.app, c.f.start, c.f.end).filter(o => o.label && c.ids.has(o.runId));
  if (outcomes.length) {
    const kindOf = new Map(c.runs.map(r => [r.id, r.kind]));
    const rowOf = (o: typeof outcomes[number]) => ({ guest: "别人问机器人的", "rule-fire": "规则触发的回答", agent: "交给 Agent 的" } as Record<string, string>)[kindOf.get(o.runId) ?? ""] ?? "对话里的回答";
    const refs = (xs: typeof outcomes) => xs.map(o => ({ id: o.runId, at: o.at, label: `回复 · ${o.text}${o.revised ? "（改判过）" : o.checked?.verdict === "confirmed" ? "（复查同意）" : ""}`, link: `#/runs/${o.runId}` }));
    const cols: [string, string, (o: typeof outcomes[number]) => boolean][] = [
      ["resolved", "解决了", o => o.label === "resolved"], ["followup", "被追问", o => o.label === "followup"], ["corrected", "被纠正", o => o.label === "corrected"],
      ["taken", "别人接手了", o => o.label === "taken_over"], ["unclear", "看不出", o => ["unrelated", "silent", "unjudged"].includes(o.label!)],
    ];
    for (const row of [...new Set(outcomes.map(rowOf))]) {
      const rs = outcomes.filter(o => rowOf(o) === row);
      for (const [key, label, is] of cols) s.metrics.push(metric(c, `quality:reply:${row}:${key}`, `${row} · ${label}`, rs.filter(is).length, refs(rs.filter(is)), undefined, undefined, { table: "回复发出后的结果", row, col: label }));
    }
    const clear = outcomes.filter(o => ["resolved", "followup", "corrected", "taken_over"].includes(o.label!));
    s.metrics.push(metric(c, "quality:reply:rate", "回复有用的占比", ratio(clear.filter(o => o.label === "resolved").length, clear.length), refs(clear), "%", "解决了 ÷（解决了 + 被追问 + 被纠正 + 别人接手了）。没人接话和看不出的不算。按回复发出几小时后大家说的话判断，不是表情。"));
    const revised = outcomes.filter(o => o.revised);
    const modelled = outcomes.filter(o => o.first && o.first.confidence !== null);
    if (modelled.length) s.metrics.push(metric(c, "quality:reply:revised", "被复盘改判的", revised.length, refs(revised), undefined, `第一遍由决策模型标（${modelled.length} 条）；夜里复查、夜间复盘的评判和 coach 重读后续消息，认为标错了就改，本人也可以在运行页改。改判得多，说明决策模型在这件事上不可靠。`));
    // The nightly second reading (agents/outcome-review.ts): how often it agreed with the first label.
    const checked = outcomes.filter(o => o.checked);
    if (checked.length) {
      const agreed = (xs: typeof outcomes) => xs.filter(o => o.checked!.verdict === "confirmed").length;
      const sampled = checked.filter(o => o.checked!.pick === "sample");
      s.metrics.push(
        metric(c, "quality:reply:checked", "夜里复查过的", checked.length, refs(checked), undefined, "回答发出一到三天后，由 outcome-reviewer 带着发出后一整天的消息重看第一遍的标注；同意的记同意，不同意的改判（第一遍的标注留着）。本人标的和按表情记的不复查。"),
        metric(c, "quality:reply:agree", "复查同意第一遍的占比", ratio(agreed(checked), checked.length), refs(checked), "%", "复查同意 ÷ 复查过的。复查先挑后来的动静对不上的、把握不够的和标成看不出的，所以这个比例比第一遍整体的准确率低；随机抽的那部分单算一个数。"),
      );
      if (sampled.length) s.metrics.push(metric(c, "quality:reply:agree:sample", "随机抽查里同意第一遍的占比", ratio(agreed(sampled), sampled.length), refs(sampled), "%", "只算每晚随机抽的、第一遍有把握的回答：最接近第一遍平常有多准。条数少时只作参考。"));
    }
  }
  const replay = replayRows(c);
  for (const [key, label] of [["win", "夜间复盘：改了更好"], ["tie", "夜间复盘：没差别"], ["loss", "夜间复盘：改了更差"]]) if (replay.length) {
    const rs = replay.filter(r => r.verdict === key); s.metrics.push(metric(c, `quality:replay:${key}`, label, rs.length, replayRefs(rs)));
  }
  const decisions = c.viewer === OWNER ? all<{ id: string; at: string; scene: keyof typeof DECISION_SCENES; choice: string; taken: string; label: string | null; ref: string | null }>(c.app.db, 'select id, at, scene, choice, taken, label, ref from decisions where at >= ? and at < ?', c.f.start, c.f.end).filter(d => d.ref && c.ids.has(d.ref)) : [];
  if (decisions.length) {
    const dr = (xs: typeof decisions) => xs.map(d => ({ id: d.id, at: d.at, label: `决策 · ${DECISION_SCENES[d.scene]?.label ?? d.scene}`, link: `#/runs/${d.ref}` }));
    const misses = decisions.filter(d => DECISION_SCENES[d.scene] && d.taken === DECISION_SCENES[d.scene].risky && d.label === "needed");
    const lowered = decisions.filter(d => d.choice !== d.taken);
    s.metrics.push(metric(c, "quality:misses", "决策已知漏看", misses.length, dr(misses)), metric(c, "quality:lowered", "决策模型把握不够、改按谨慎处理", lowered.length, dr(lowered)));
  }
  if (feedback.length) {
    const days = [...new Set(feedback.map(f => localDay(f.at, c.app.config.timezone)))].sort();
    s.charts.push({ title: "每天收到的反馈", kind: "line", labels: days, series: ["positive", "negative"].map((p, i) => ({ name: i ? "负面" : "正面", values: days.map(d => feedback.filter(f => f.polarity === p && localDay(f.at, c.app.config.timezone) === d).length) })), points: days.flatMap(d => ["positive", "negative"].map(p => { const fs = feedback.filter(f => f.polarity === p && localDay(f.at, c.app.config.timezone) === d); return metric(c, `quality:day:${d}:${p}`, `${d} · ${p === "positive" ? "正面" : "负面"}`, fs.length, fr(fs)); })) });
  }
  if (!s.metrics.length) s.empty = "这段时间还没有可以数的：没有表情反馈、草稿、评审、抽检或复盘的记录。";
  s.notes.push("评审意见里没有裁决的和被合并的，不算作不采纳。抽检、复盘和决策记录里，对不上这段时间任务的旧记录没有算进来。");
  return s;
}
type ReplayRow = { id: string; at: string; base_run_id: string; verdict: string | null; skill: string | null };
function replayRows(c: Ctx) { return all<ReplayRow>(c.app.db, "select id, at, base_run_id, verdict, json_extract(variant, '$.skillName') skill from replays where at >= ? and at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.base_run_id)); }
const replayRefs = (xs: ReplayRow[]) => xs.map(r => ({ id: r.id, at: r.at, label: `复盘 · ${r.verdict ?? "未裁决"}`, link: "#/agents" }));
export function deliverySection(c: Ctx): Section {
  const s = section("delivery", "编码交付", "交给 omem 写代码的事：发起了多少、评审通过多少、已经用上多少。同一次交办的后续几轮算在一起。");
  const roots = c.runs.filter(r => r.kind === "code" && !r.root);
  if (!roots.length) return { ...s, empty: "这段时间还没有编码交办。" };
  const ids = new Set(roots.map(r => r.id));
  // Later rounds may be outside the selected period. They still belong to this start cohort.
  const rounds = all<RunRow>(c.app.db, `select ${RUN_COLUMNS} from runs indexed by runs_insights where created_at >= ? and kind = 'code'`, c.f.start).filter(r => ids.has(r.root ?? r.id) && c.visible(r));
  const rootRounds = new Map<string, RunRow[]>();
  for (const r of rounds) { const root = r.root ?? r.id; const rows = rootRounds.get(root) ?? []; rows.push(r); rootRounds.set(root, rows); }
  const byRoot = (r: RunRow) => rootRounds.get(r.id) ?? [];
  const applied = roots.filter(r => byRoot(r).some(x => x.applied)), discarded = roots.filter(r => byRoot(r).some(x => x.discarded));
  const approved = roots.filter(r => byRoot(r).some(x => x.verdict === "approved"));
  const durations = applied.map(r => (Date.parse(byRoot(r).find(x => x.applied)!.applied!) - Date.parse(r.created_at)) / 3600_000).filter(n => Number.isFinite(n) && n >= 0);
  s.metrics = [metric(c, "delivery:started", "发起的交办", roots.length, refs(roots)), metric(c, "delivery:approved", "评审通过", approved.length, refs(approved)), metric(c, "delivery:applied", "已经用上", applied.length, refs(applied)), metric(c, "delivery:discarded", "丢弃了", discarded.length, refs(discarded)), metric(c, "delivery:rounds", "一般要几轮（中位数）", median(roots.map(r => byRoot(r).length)), refs(rounds)), metric(c, "delivery:time", "从发起到用上（中位数）", median(durations), refs(applied), "小时")];
  s.charts.push({ title: "这些交办现在到哪了", kind: "hbar", labels: s.metrics.slice(0, 4).map(m => m.label), series: [{ name: "交办", values: s.metrics.slice(0, 4).map(m => m.value!) }], points: s.metrics.slice(0, 4) });
  s.notes.push("通过是指有一轮评审给了通过；用上是指改动已经应用到你的目录。只推送了分支、没有在 omem 里应用的不算用上。这些状态之后还会变。");
  return s;
}
type FlowRow = { item_id: string; flow_id: string; definition: string; started_at: string; ended_at: string | null; title: string; space_id: string; user_id: string };
const hours = (minutes: number) => round(minutes / 60);
export function flowsSection(c: Ctx): Section {
  const s = section("flows", "流程", "走流程的事项在各段花了多久、其中等你多久、卡住多久、你要求返工几次。只数这段时间里的部分。");
  const allowed = accessibleSpaces(c.app, c.viewer);
  // One row per item that runs a flow (a handful to a few hundred), each stage log read through its item index.
  const flows = all<FlowRow>(c.app.db, `select f.item_id,f.flow_id,f.definition,f.started_at,f.ended_at,i.title,i.space_id,i.user_id from item_flows f join items i on i.id=f.item_id
    where f.started_at < ? and (f.ended_at is null or f.ended_at >= ?)`, c.f.end, c.f.start)
    .filter(f => (!c.f.space || f.space_id === c.f.space) && (allowed === null || allowed.includes(f.space_id)) && (c.viewer === OWNER || f.user_id === c.viewer));
  if (!flows.length) return { ...s, empty: "这段时间没有走流程的事项。" };
  if (c.f.by || c.f.bot || c.f.scene || c.f.profile || c.f.model || c.f.chat) {
    s.notes.push("阶段的记录不归到某一次运行，按人、模型、场景、会话等筛选时不统计流程。");
    return { ...s, empty: "按运行的条件筛选时不统计流程。" };
  }
  const until = new Date(Math.min(Date.now(), Date.parse(c.f.end))).toISOString();
  const itemRef = (f: FlowRow, label: string, value?: number): RecordRef => ({ id: f.item_id, label: `${f.title} · ${label}`, at: f.started_at, link: `#/items/${f.item_id}`, ...(value !== undefined ? { value } : {}) });
  type Touch = { f: FlowRow; doing: number; owner: number; blocked: number; reworks: number };
  const byFlow = new Map<string, { name: string; stages: { id: string; name: string }[]; items: FlowRow[]; touched: Map<string, Touch[]> }>();
  for (const f of flows) {
    const def = (() => { try { return JSON.parse(f.definition) as { name?: string; stages?: ReviewStageDef[] }; } catch { return {}; } })();
    const stages = def.stages ?? [];
    const g = byFlow.get(f.flow_id) ?? { name: def.name ?? f.flow_id, stages: [] as { id: string; name: string }[], items: [] as FlowRow[], touched: new Map<string, Touch[]>() };
    for (const d of stages) if (!g.stages.some(x => x.id === d.id)) g.stages.push({ id: d.id, name: d.name });
    const log = flowLog(c.app, f.item_id, f.started_at);
    const end = f.ended_at && f.ended_at < until ? f.ended_at : until;
    // Minutes: every row, clipped to the period. Counts: only what happened in the period.
    const spans = reviewStages({ stages, log, from: c.f.start, until: end });
    const counts = reviewStages({ stages, log: log.filter(r => r.at >= c.f.start && r.at < c.f.end), until: end });
    let active = false;
    spans.forEach((x, i) => {
      const reworks = counts[i].reworks, busy = x.doingMinutes + x.gatedMinutes + x.blockedMinutes;
      if (!busy && !reworks) return;
      active = true;
      const list = g.touched.get(x.id) ?? [];
      list.push({ f, doing: x.doingMinutes, owner: x.ownerMinutes, blocked: x.blockedMinutes, reworks });
      g.touched.set(x.id, list);
    });
    if (active) g.items.push(f);
    byFlow.set(f.flow_id, g);
  }
  const items = [...byFlow.values()].flatMap(g => g.items);
  if (!items.length) return { ...s, empty: "这段时间没有走流程的事项。" };
  const reviews = all<{ item_id: string; how: string; ended_at: string; flow_id: string }>(c.app.db, "select r.item_id,r.how,r.ended_at,r.flow_id from item_flow_reviews r where r.ended_at >= ? and r.ended_at < ?", c.f.start, c.f.end);
  const titles = new Map(flows.map(f => [f.item_id, f]));
  const ended = (how: string[]) => reviews.filter(r => how.includes(r.how) && (titles.has(r.item_id) || readableItem(c, r.item_id)));
  const endedRef = (r: { item_id: string; how: string; ended_at: string }) => ({ id: r.item_id, label: `${titles.get(r.item_id)?.title ?? r.item_id} · ${({ completed: "走完了", stopped: "本人停止", closed: "事项关闭时结束" } as Record<string, string>)[r.how] ?? r.how}`, at: r.ended_at, link: `#/items/${r.item_id}` });
  const done = ended(["completed"]), cut = ended(["stopped", "closed"]);
  const allTouches = [...byFlow.values()].flatMap(g => [...g.touched.values()].flat());
  s.metrics.push(metric(c, "flows:items", "走流程的事项", items.length, items.map(f => itemRef(f, f.ended_at ? "已结束" : "进行中"))),
    metric(c, "flows:completed", "走完的", done.length, done.map(endedRef)),
    metric(c, "flows:cut", "中途停下或随事项关闭的", cut.length, cut.map(endedRef)),
    metric(c, "flows:owner", "等你的时间合计", hours(allTouches.reduce((n, t) => n + t.owner, 0)), allTouches.filter(t => t.owner).map(t => itemRef(t.f, `等你 ${hours(t.owner)} 小时`, hours(t.owner))), "小时", "关卡等你点头、轮到你做的一段、做完等你确认的时间；运行或交办在做的时间不算。"),
    metric(c, "flows:reworks", "你要求返工", allTouches.reduce((n, t) => n + t.reworks, 0), allTouches.filter(t => t.reworks).map(t => itemRef(t.f, `返工 ${t.reworks} 次`, t.reworks)), "次"));
  for (const [flowId, g] of byFlow) {
    if (!g.items.length) continue;
    const table = `流程「${g.name}」各段（平均每件）`;
    for (const st of g.stages) {
      const ts = g.touched.get(st.id);
      if (!ts?.length) continue;
      const avg = (pick: (t: Touch) => number) => hours(ts.reduce((n, t) => n + pick(t), 0) / ts.length);
      const cells: [string, string, number, RecordRef[], string?][] = [
        ["doing", "在做", avg(t => t.doing), ts.map(t => itemRef(t.f, `${st.name} 在做 ${hours(t.doing)} 小时`, hours(t.doing)))],
        ["owner", "等你", avg(t => t.owner), ts.map(t => itemRef(t.f, `${st.name} 等你 ${hours(t.owner)} 小时`, hours(t.owner)))],
        ["blocked", "卡住", avg(t => t.blocked), ts.map(t => itemRef(t.f, `${st.name} 卡住 ${hours(t.blocked)} 小时`, hours(t.blocked)))],
      ];
      for (const [key, col, value, records] of cells)
        s.metrics.push(metric(c, `flows:${flowId}:${st.id}:${key}`, `${g.name} · ${st.name} · ${col}`, value, records, "小时", undefined, { table, row: st.name, col }));
      const rw = ts.filter(t => t.reworks);
      s.metrics.push(metric(c, `flows:${flowId}:${st.id}:reworks`, `${g.name} · ${st.name} · 返工`, rw.reduce((n, t) => n + t.reworks, 0), rw.map(t => itemRef(t.f, `${st.name} 返工 ${t.reworks} 次`, t.reworks)), "次", undefined, { table, row: st.name, col: "返工" }));
    }
  }
  s.notes.push("每段的平均只算这段时间里在这一段上花过时间或返工过的事项。“等你”是“在做”和“卡住”里等你的部分，加上关卡等你点头的时间，所以三列加起来会比实际多。返工只算你重开和说“还不行”的次数，上游重开带来的复核和换模型重做不算。事项重新开始过流程的，只算最近那一次；走完、停下按流程结束时存下的回顾数。");
  return s;
}
function readableItem(c: Ctx, itemId: string) {
  const i = one<{ space_id: string; user_id: string }>(c.app.db, "select space_id,user_id from items where id=?", itemId);
  const allowed = accessibleSpaces(c.app, c.viewer);
  return !!i && (!c.f.space || i.space_id === c.f.space) && (allowed === null || allowed.includes(i.space_id)) && (c.viewer === OWNER || i.user_id === c.viewer);
}
export function studySection(c: Ctx): Section {
  const s = section("study", "课题", "只数台账里的试验、发现和结束的方向。发现多少不代表做得好坏。");
  const allowed = accessibleSpaces(c.app, c.viewer);
  // Only items that have a ledger: a handful, found through the directions' item index.
  const items = all<{ id: string; title: string; space_id: string }>(c.app.db, "select id,title,space_id from items where id in (select distinct item_id from study_directions)")
    .filter(i => (!c.f.space || i.space_id === c.f.space) && (allowed === null || allowed.includes(i.space_id)));
  const specific = !!(c.f.by || c.f.bot || c.f.scene || c.f.profile || c.f.model || c.f.chat);
  const titles = new Map(items.map(i => [i.id, i.title]));
  const trialRows: Trial[] = [], findingRows: Finding[] = [], directionRows: Direction[] = [];
  const trialRefs = new Map<string, RecordRef>();
  const itemRef = (r: { id: string; item_id: string }, label: string, at: string): RecordRef => ({ id: r.id, label, at, link: `#/items/${r.item_id}` });
  // Per readable study item, so all three ledger queries use their item indexes.
  for (const i of items) {
    const ts = all<Trial>(c.app.db, "select * from study_trials where item_id=? and result is not null and updated_at>=? and updated_at<?", i.id, c.f.start, c.f.end);
    for (const t of ts) {
      const r = t.run_id ? one<RunRow>(c.app.db, `select ${RUN_COLUMNS} from runs where id=?`, t.run_id) : undefined;
      if (specific && (!r || !c.visible(r) || !matchesFilters(c.f, r))) continue;
      trialRows.push(t);
      trialRefs.set(t.id, r && c.visible(r) ? { ...refRun(r), label: `${i.title} · ${t.object} × ${t.check} · ${t.result}`, at: t.updated_at }
        : itemRef(t, `${i.title} · ${t.object} × ${t.check} · ${t.result}`, t.updated_at));
    }
    if (!specific) {
      findingRows.push(...all<Finding>(c.app.db, "select * from study_findings where item_id=? and created_at>=? and created_at<?", i.id, c.f.start, c.f.end));
      directionRows.push(...all<Direction>(c.app.db, "select * from study_directions where item_id=? and state in ('done','dropped') and updated_at>=? and updated_at<?", i.id, c.f.start, c.f.end));
    }
  }
  if (!trialRows.length) return { ...s, empty: "这段时间没有已交结果的试验。" };
  const tr = (xs: Trial[]) => xs.map(t => trialRefs.get(t.id)!);
  s.metrics.push(metric(c, "study:trials", "试验数", trialRows.length, tr(trialRows)));
  for (const item of new Set(trialRows.map(t => t.item_id))) {
    for (const [result, label] of [["passed", "通过"], ["failed", "没通过"], ["blocked", "跑不了"], ["unclear", "说不清"]]) {
      const xs = trialRows.filter(t => t.item_id === item && t.result === result);
      s.metrics.push(metric(c, `study:result:${item}:${result}`, `${titles.get(item)} · ${label}`, xs.length, tr(xs), undefined, undefined,
        { table: "试验结果", row: titles.get(item)!, col: label }));
    }
  }
  if (!specific) {
    const fr = (xs: Finding[]) => xs.map(f => itemRef(f, `${titles.get(f.item_id)} · ${f.title}（${f.state}）`, f.created_at));
    s.metrics.push(metric(c, "study:findings", "新发现数", findingRows.length, fr(findingRows)));
    for (const [key, label, states] of [["confirmed", "本人认可的", ["confirmed"]], ["rejected", "本人判定不算的", ["rejected"]], ["pending", "还没判定的", ["new", "later"]]] as const) {
      const xs = findingRows.filter(f => (states as readonly string[]).includes(f.state));
      s.metrics.push(metric(c, `study:findings:${key}`, label, xs.length, fr(xs)));
    }
    // A handful of findings per item: each one's change and reruns are read through their own indexes.
    const fixes = findingRows.filter(f => f.work_id).map(f => ({ f, verified: fixVerified(c.app, f).verified }));
    for (const [key, label, keep] of [["fixed", "有改动的", () => true], ["passed", "改后重跑通过的", (v: string | null) => v === "passed"], ["failed", "改后重跑仍然失败的", (v: string | null) => v === "failed"]] as const) {
      const xs = fixes.filter(x => keep(x.verified)).map(x => x.f);
      s.metrics.push(metric(c, `study:findings:${key}`, label, xs.length, fr(xs)));
    }
    const dr = (xs: Direction[]) => xs.map(d => itemRef(d, `${titles.get(d.item_id)} · ${d.goal}（${d.state}）`, d.updated_at));
    s.metrics.push(metric(c, "study:directions", "结束的方向数", directionRows.length, dr(directionRows)));
    for (const [key, label] of [["done", "做完的方向"], ["dropped", "放下的方向"]]) {
      const xs = directionRows.filter(d => d.state === key);
      s.metrics.push(metric(c, `study:directions:${key}`, label, xs.length, dr(xs)));
    }
  } else s.notes.push("发现和方向没有运行归属，按人、模型、场景、会话等筛选时不显示。试验按其结果运行匹配这些条件。");
  const rs = c.runs.filter(r => r.kind === "study-trial" && titles.has(one<{ item: string }>(c.app.db, "select json_extract(input,'$.itemId') item from runs where id=?", r.id)?.item ?? ""));
  // Sort labels, never counts: model use is a ledger, not a ranking.
  for (const model of [...new Set(rs.map(r => parseAi(r.ai).model ?? "没记下"))].sort()) {
    const xs = rs.filter(r => (parseAi(r.ai).model ?? "没记下") === model);
    s.metrics.push(metric(c, `study:model:${model}`, `试验运行 · ${model}`, xs.length, refs(xs), undefined, undefined, { table: "试验运行按模型", row: model, col: "次数" }));
  }
  s.notes.push("试验按交结果的更新时间、新发现按建立时间、结束方向按更新时间计；认可、不算及未判定是这些新发现的当前状态，未判定含“以后再说”，duplicate 只计新发现总数。有改动是指这些新发现现在挂着一次编码交办；改后重跑通过 / 仍然失败按改动之后重跑的试验算，没重跑完的两边都不计。运行按创建时间，含重试与升档；运行未保留档位名，按 AI 字段的模型计数。");
  return s;
}
export function knowledgeSection(c: Ctx): Section {
  const s = section("knowledge", "知识用上了没有", "页面有没有被读、记忆有没有被用上。页面的阅读没有记下是回答时读的还是整理时读的，这里放在一起。");
  const scope = accessibleSpaces(c.app, c.viewer);
  const visible = (space: string) => (!c.f.space || space === c.f.space) && (scope === null || scope.includes(space));
  const specific = c.f.by || c.f.bot || c.f.scene || c.f.profile || c.f.model || c.f.chat;
  if (c.viewer === OWNER && !specific) {
    const pages = all<{ space_id: string; slug: string }>(c.app.db, "select space_id, slug from pages").filter(p => visible(p.space_id));
    const reads = all<{ space_id: string; slug: string; day: string; n: number }>(c.app.db, "select space_id, slug, day, n from page_reads where day >= ? and day <= ?", c.f.from, c.f.to).filter(p => visible(p.space_id));
    const readKeys = new Set(reads.map(p => `${p.space_id}/${p.slug}`));
    const pr = pages.map(p => ({ id: `${p.space_id}/${p.slug}`, at: "", label: `${p.space_id}/${p.slug}`, link: `#/wiki/${encodeURIComponent(p.space_id)}/${p.slug.split("/").map(encodeURIComponent).join("/")}`, value: readKeys.has(`${p.space_id}/${p.slug}`) ? 1 : 0 }));
    const readPages = pr.filter(p => p.value === 1);
    if (pages.length || reads.length) {
      s.metrics.push(metric(c, "knowledge:pages", "现有页面", pages.length, pr), metric(c, "knowledge:read", "被读过的页面占比", ratio(readPages.length, pages.length), pr, "%", "全部阅读，无法区分回答或整理；明细为现存页面，值 1 表示期间读过、0 表示没读过。page_reads.day 按 UTC 日期记录。"));
      const point = metric(c, "knowledge:readPages", "被读过的页面", readPages.length, readPages);
      s.metrics.push(point);
      s.charts.push({ title: "页面被读的情况", kind: "hbar", labels: ["现存页面", "期间读过"], series: [{ name: "页面", values: [pages.length, readPages.length] }], points: [s.metrics[0], point] });
    }
    const lessons = all<{ id: string; space_id: string; hits: number; last_hit_at: string | null }>(c.app.db, "select id, space_id, hits, last_hit_at from repo_lessons").filter(p => visible(p.space_id));
    if (lessons.length) s.metrics.push(metric(c, "knowledge:lessons", "仓库约定命中（累计）", lessons.reduce((n, p) => n + p.hits, 0), lessons.map(p => ({ id: p.id, at: p.last_hit_at ?? "", label: `仓库约定 · ${p.space_id}`, link: `#/settings?tab=spaces&space=${encodeURIComponent(p.space_id)}`, value: p.hits })), undefined, "累计值，没有逐次命中时间；不受期间限制，不做上一段对比。"));
  } else s.notes.push("页面的阅读和仓库约定的命中没有记下是谁、哪一件事，所以按人、场景等筛选时不显示。");
  const recalls = all<{ id: number; at: string; run_id: string | null; purpose: string; used: number }>(c.app.db, "select id, at, run_id, purpose, used from memory_recalls where at >= ? and at < ?", c.f.start, c.f.end).filter(r => r.run_id && c.ids.has(r.run_id));
  for (const [purpose, label] of [["answer", "回答与办事"], ["upkeep", "后台整理"]]) {
    const xs = recalls.filter(r => r.purpose === purpose);
    const rr = xs.map(r => ({ id: String(r.id), at: r.at, label: `记忆召回 · ${label}`, link: `#/runs/${r.run_id}`, value: r.used }));
    if (recalls.length) s.metrics.push(metric(c, `knowledge:recall:${purpose}`, `${label}召回`, xs.length, rr), metric(c, `knowledge:hit:${purpose}`, `${label}引用率`, ratio(xs.filter(r => r.used).length, xs.length), rr, "%", "召回以后被用上的 ÷ 这类召回。不是检索质量的评测。"));
  }
  const replays = replayRows(c).filter(r => r.skill);
  for (const name of new Set(replays.map(r => r.skill!))) for (const [v, label] of [["all", "尝试"], ["win", "胜"], ["tie", "平"], ["loss", "负"]]) {
    const rs = replays.filter(r => r.skill === name && (v === "all" || r.verdict === v));
    s.metrics.push(metric(c, `knowledge:skill:${name}:${v}`, `技能 ${name} · ${label}`, rs.length, replayRefs(rs), undefined, undefined, { table: "复盘里试用的技能", row: name, col: label }));
  }
  const ms = s.metrics.filter(m => m.key.startsWith("knowledge:recall:"));
  if (ms.length) s.charts.push({ title: "记忆被召回是为了什么", kind: "hbar", labels: ms.map(m => m.label), series: [{ name: "召回", values: ms.map(m => m.value!) }], points: ms });
  if (!s.metrics.length) s.empty = "还没有可归属的知识使用记录；阅读 Wiki、召回记忆或尝试技能后会填入。";
  s.notes.push("技能只数夜间复盘里试用的次数和胜负，不是全部调用。查不到答案的问题目前没有单独记数。");
  return s;
}
export function costSection(c: Ctx): Section {
  const s = section("cost", "花了多少时间", "各个后端和模型跑了多少次、一共跑了多久。几件事同时跑的时间会相加；这不是账单，也不是费用。");
  const rs = usageRuns(c);
  if (!rs.length) return { ...s, empty: "这段时间还没有记录。" };
  const dimensions = [["backend", "后端", (r: RunRow) => parseAi(r.ai).profile ?? "没记下"], ["model", "模型", (r: RunRow) => parseAi(r.ai).model ?? "没记下"], ["scene", "场景", sceneOf]] as const;
  for (const [key, label, by] of dimensions) {
    grouped(c, s, `cost:${key}`, label, rs, by);
    for (const group of new Set(rs.map(by))) {
      const rows = rs.filter(r => by(r) === group && r.started_at && r.finished_at && Date.parse(r.finished_at) >= Date.parse(r.started_at));
      if (rows.length) s.metrics.push(metric(c, `cost:${key}:hours:${group}`, `${label} ${group} · 总运行时长`, round(rows.reduce((n, r) => n + (Date.parse(r.finished_at!) - Date.parse(r.started_at!)) / 3600_000, 0)), refs(rows), "小时", undefined, { table: label, row: group, col: "时长" }));
    }
  }
  s.notes.push("每件事只记了第一次成功调用用的后端和模型，没记下的单独一组。时长不含排队；没有起止时间的只算次数。");
  return s;
}
const builders = [usageSection, coverageSection, shieldSection, othersSection, qualitySection, deliverySection, flowsSection, studySection, knowledgeSection, costSection];
type Cached = { at: number; report: Report; records: Map<string, RecordRef[]> };
const cache = new WeakMap<App, Map<string, Cached>>();
export function clearInsightsCache(app: App) { cache.delete(app); }
function compute(app: App, viewer: string, input: Filters): Cached {
  const f = normalizeFilters(app, input);
  // Permission state is part of the key: revoked access cannot reuse an older answer.
  const key = JSON.stringify([viewer, f, accessibleSpaces(app, viewer), runReadableSpaces(app, viewer)]);
  let entries = cache.get(app); if (!entries) { entries = new Map(); cache.set(app, entries); }
  const hit = entries.get(key); if (hit && Date.now() - hit.at < 180_000) return hit;
  const c = context(app, viewer, f);
  const prev = f.compare ? context(app, viewer, normalizeFilters(app, { ...input, from: dayAdd(f.from, -f.days), to: dayAdd(f.from, -1), compare: false })) : null;
  const sections = builders.map(build => {
    try {
      const s = build(c);
      if (prev) {
        const previous = build(prev);
        const lookup = new Map(previous.metrics.map(m => [m.key, m]));
        for (const m of s.metrics) if (lookup.has(m.key) && m.key !== "knowledge:lessons" && m.key !== "knowledge:pages" && m.key !== "knowledge:read" && !m.key.startsWith("usage:week:")) m.previous = lookup.get(m.key)!.value;
      }
      return s;
    } catch {
      // No SQL, paths or stored material in public errors.
      return { ...section(build.name.replace("Section", ""), ({ usageSection: "用量与覆盖", coverageSection: "用在哪", shieldSection: "替本人挡了多少", othersSection: "给别人带来什么", qualitySection: "质量", deliverySection: "交付", flowsSection: "流程", studySection: "课题", knowledgeSection: "知识", costSection: "成本" } as Record<string, string>)[build.name], "这部分暂时无法读取。"), error: "这部分暂时无法读取，请稍后重试。" };
    }
  }).filter(s => !s.empty || s.id !== "study" && (s.id !== "flows" || s.notes.length > 0));
  const unique = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((s): s is string => !!s))].sort();
  const result: Cached = { at: Date.now(), records: c.records, report: { from: f.from, to: f.to, timezone: app.config.timezone, owner: viewer === OWNER, scenes, sceneTable, generatedAt: new Date().toISOString(), sections,
    options: { spaces: unique(c.runs.map(r => r.space_id)), people: unique(c.runs.map(r => r.trigger_by)), profiles: unique(c.runs.flatMap(r => [r.spec, ...(r.roles ?? "").split("|")])), models: unique(c.runs.map(r => parseAi(r.ai).model)), bots: unique(c.runs.map(r => r.bot)), chats: unique(c.runs.map(r => r.place)) } } };
  for (const [k, v] of entries) if (Date.now() - v.at >= 180_000) entries.delete(k);
  if (entries.size >= 8) entries.delete(entries.keys().next().value!);
  entries.set(key, result);
  return result;
}
export function insights(app: App, viewer: string, input: Filters = {}) { return compute(app, viewer, input).report; }
export function insightRecords(app: App, viewer: string, input: Filters, metricKey: string, offset = 0) {
  const records = compute(app, viewer, input).records.get(metricKey);
  if (!records) throw new HttpError(404, "没有这项统计的明细");
  offset = Math.max(0, Math.floor(offset) || 0);
  return { records: records.slice(offset, offset + 100), total: records.length };
}
export function exportInsights(app: App, viewer: string, input: Filters, format: "md" | "csv") {
  const report = insights(app, viewer, input);
  const rows: string[][] = [["板块", "指标", "值", "上一段", "单位", "样本数", "口径", "明细"]];
  for (const s of report.sections) {
    if (s.empty || s.error) rows.push([s.title, s.empty ?? s.error!, "", "", "", "", s.description, ""]);
    for (const m of s.metrics) rows.push([s.title, m.label, m.value === null ? "—" : String(m.value), m.previous === undefined ? "" : m.previous === null ? "—" : String(m.previous), m.unit ?? "", m.samples === undefined ? "" : String(m.samples), m.note ?? "", m.link]);
    for (const chart of s.charts) {
      if (chart.points) for (const p of chart.points) rows.push([s.title, `${chart.title} · ${p.label}`, p.value === null ? "—" : String(p.value), "", p.unit ?? chart.unit ?? "", p.samples === undefined ? "" : String(p.samples), "图表数据", p.link]);
      else for (const [i, label] of chart.labels.entries()) for (const serie of chart.series) rows.push([s.title, `${chart.title} · ${label} · ${serie.name}`, String(serie.values[i]), "", chart.unit ?? "", "", "图表数据", ""]);
    }
    for (const note of s.notes) rows.push([s.title, "口径", "", "", "", "", note, ""]);
  }
  if (format === "csv") return "\uFEFF" + [["期间", report.from, report.to, report.timezone], ...rows].map(row => row.map(cell => `"${(/^[=+@\-\t\r]/.test(cell) ? "'" : "") + cell.replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const esc = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `# omem 的数据\n\n${report.from} 至 ${report.to}（${report.timezone}）\n\n` + report.sections.map(s => {
    const rs = rows.slice(1).filter(r => r[0] === s.title);
    return `## ${s.title}\n\n${s.description}\n\n| ${rows[0].slice(1).join(" | ")} |\n| ${rows[0].slice(1).map(() => "---").join(" | ")} |\n${rs.map(r => `| ${r.slice(1).map(esc).join(" | ")} |`).join("\n")}`;
  }).join("\n\n");
}
