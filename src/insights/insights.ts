import { z } from "zod";
import type { App } from "../core/app.ts";
import { all } from "../core/db.ts";
import { accessibleSpaces, OWNER } from "../core/users.ts";
import { runReadableSpaces } from "../auth/permissions.ts";
import { DECISION_SCENES } from "../core/decision-scenes.ts";
import { HttpError, localStamp } from "../core/util.ts";
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
  if (!parsed.success) throw new HttpError(400, "成效筛选条件不正确");
  const f = parsed.data;
  for (const day of [f.from, f.to]) if (day && (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)) throw new HttpError(400, "日期须为有效的 YYYY-MM-DD");
  const to = f.to ?? localDay(Date.now(), app.config.timezone);
  const from = f.from ?? dayAdd(to, -29);
  for (const s of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new HttpError(400, "日期须为有效的 YYYY-MM-DD");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  if (days < 1 || days > 180) throw new HttpError(400, "成效时间范围为 1 至 180 天");
  return { ...f, from, to, days, start: midnight(from, app.config.timezone), end: midnight(dayAdd(to, 1), app.config.timezone) };
}
function queryString(f: Normal) {
  return new URLSearchParams(Object.entries(f).filter(([k, v]) => !["start", "end", "days"].includes(k) && v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
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
  const runs = all<RunRow>(app.db, DAILY_SQL, f.start, f.end).filter(r => {
    if (!visible(r)) return false;
    const ai = parseAi(r.ai);
    return (!f.space || r.space_id === f.space) && (!f.by || r.trigger_by === f.by) && (!f.bot || r.bot === f.bot)
      && (!f.scene || sceneOf(r) === f.scene) && (!f.profile || r.spec === f.profile || r.roles?.split("|").includes(f.profile))
      && (!f.model || ai.model === f.model) && (!f.chat || r.place === f.chat);
  });
  return { app, viewer, f, runs, ids: new Set(runs.map(r => r.id)), records: new Map(), visible, link: key => `#/insights?${queryString(f)}&detail=${encodeURIComponent(key)}` };
}
function parseAi(s: string | null): { profile?: string; model?: string } { try { return JSON.parse(s ?? "null") ?? {}; } catch { return {}; } }
const runReferences = new WeakMap<RunRow, RecordRef>();
const refRun = (r: RunRow): RecordRef => {
  let ref = runReferences.get(r);
  if (!ref) { ref = { id: r.id, label: `${r.kind} · ${r.status}`, at: r.created_at, link: `#/runs/${r.id}` }; runReferences.set(r, ref); }
  return ref;
};
const refs = (rs: RunRow[]) => rs.map(refRun);
function metric(c: Ctx, key: string, label: string, value: number | null, records: RecordRef[], unit?: string, note?: string): Metric {
  c.records.set(key, records);
  return { key, label, value, link: c.link(key), ...(unit ? { unit } : {}), ...(note ? { note } : {}) };
}
const section = (id: string, title: string, description: string): Section => ({ id, title, description, metrics: [], charts: [], notes: [] });
const percent = (xs: number[], p: number) => xs.length ? round([...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * p) - 1)]) : null;
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? round((a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2) : null; };
const usageRuns = (c: Ctx) => c.runs.filter(r => c.f.housekeeping || sceneOf(r) !== "整理（后台）");
function grouped(c: Ctx, s: Section, key: string, label: string, rows: RunRow[], by: (r: RunRow) => string, top?: number) {
  const groups = new Map<string, RunRow[]>();
  for (const r of rows) { const k = by(r); const g = groups.get(k) ?? []; g.push(r); groups.set(k, g); }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, top);
  const points = sorted.map(([k, rs]) => metric(c, `${key}:${k}`, `${label} · ${k}`, rs.length, refs(rs)));
  s.metrics.push(...points);
  const plotted = sorted.slice(0, 12);
  if (plotted.length) s.charts.push({ title: `${label}${sorted.length > 12 ? "（前 12 项，全部见指标）" : ""}`, kind: "hbar", labels: plotted.map(x => x[0]), series: [{ name: "运行", values: plotted.map(x => x[1].length) }], points: points.slice(0, 12) });
}
export function usageSection(c: Ctx): Section {
  const s = section("usage", "用量与覆盖", "按运行计数；后台整理单列，默认不计入用量。每周人数按触发身份去重。");
  const rs = usageRuns(c), upkeep = c.runs.filter(r => sceneOf(r) === "整理（后台）");
  if (!rs.length && !upkeep.length) return { ...s, empty: "还没有运行记录；向助手提一个问题后会出现用量。" };
  const finished = rs.filter(r => ["done", "failed"].includes(r.status) && sceneOf(r) !== "整理（后台）");
  s.metrics = [metric(c, "usage:total", "运行次数", rs.length, refs(rs)), metric(c, "usage:upkeep", "后台整理", upkeep.length, refs(upkeep)),
    metric(c, "usage:success", "成功率", ratio(finished.filter(r => r.status === "done").length, finished.length), refs(finished), "%", "done / (done + failed)，始终排除后台整理及取消、未完成运行。")];
  s.metrics.push(metric(c, "usage:people", "使用身份数", new Set(rs.flatMap(r => r.trigger_by ? [r.trigger_by] : r.user_id ? [`user:${r.user_id}`] : [])).size, refs(rs.filter(r => r.trigger_by || r.user_id)), undefined, "期间按触发身份键去重；缺失身份不补猜，同人跨渠道可能重复。"));
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
  s.charts.push({ title: "每日运行（按场景）", kind: "area", stack: true, labels: days, series: plotted.map(name => ({ name, values: days.map(d => counts.get(`${d}/${name}`) ?? 0) })),
    points: days.flatMap(d => plotted.map(name => metric(c, `usage:day:${d}:${name}`, `${d} · ${name}`, counts.get(`${d}/${name}`) ?? 0, refs(dailyRows.get(`${d}/${name}`) ?? [])))) });
  const weekKeys = [...weeks.keys()].sort();
  s.charts.push({ title: "每周用过的身份数（周一开始，边界周只含所选日期）", kind: "line", labels: weekKeys, series: ["本人", "成员", "访客与机器人"].map((name, i) => ({ name, values: weekKeys.map(w => weeks.get(w)![i].size) })) });
  for (const w of weekKeys) for (const [i, label] of ["本人", "成员", "访客与机器人"].entries()) {
    const keys = weeks.get(w)![i];
    s.metrics.push(metric(c, `usage:week:${w}:${i}`, `${w} 周 · ${label}`, keys.size, refs(weeklyRows.get(w)![i])));
  }
  s.charts[1].points = s.metrics.filter(m => m.key.startsWith("usage:week:"));
  if (unknown) s.metrics.push(metric(c, "usage:unknown", "未记录触发身份", unknown, refs(rs.filter(r => !r.trigger_by && !r.user_id)), undefined, "旧运行的触发身份可能未记录，不推断为本人。"));
  return s;
}
export function coverageSection(c: Ctx): Section {
  const s = section("coverage", "用在哪", "场景按固定表归类；会话仅展示触发位置和次数，不读取消息。");
  const rs = usageRuns(c);
  if (!rs.length) return { ...s, empty: "还没有可统计的使用记录；运行任务后会显示场景与空间。" };
  grouped(c, s, "coverage:scene", "场景", rs, sceneOf);
  grouped(c, s, "coverage:space", "空间", rs, r => r.space_id ?? "未指定空间");
  grouped(c, s, "coverage:profile", "Agent 档案 / 角色", rs, r => r.spec ?? r.roles?.split("|").filter(Boolean)[0] ?? "未记录档案");
  grouped(c, s, "coverage:chat", "触发会话（前十）", rs.filter(r => r.place), r => r.place!, 10);
  s.notes.push("通用 agent / rule 运行默认归排查；已知写作、会议、编码、评审角色按固定表细分。名称相同的会话合并，where 没有稳定会话 ID。旧记录缺失触发信息时不补猜。");
  return s;
}
type Sample = { id: string; handle_run: string | null; created_at: string; last_ms: number; owner_reply_at: string | null; decision: string | null };
function samples(c: Ctx) {
  return all<Sample>(c.app.db, "select id, handle_run, created_at, last_ms, owner_reply_at, decision from reply_samples where created_at >= ? and created_at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.id));
}
function sampleRefs(c: Ctx, xs: Sample[]): RecordRef[] { return xs.map(r => ({ id: r.id, label: `回复样本 · ${r.decision ?? "未决定"}`, at: r.created_at, link: `#/runs/${r.id}` })); }
export function shieldSection(c: Ctx): Section {
  const s = section("shield", "替本人挡了多少", "有人找你的处理批次及通知结果；分支并非一条严格递减的消息漏斗。");
  if (c.viewer !== OWNER) return { ...s, empty: "本人的分诊和通知结果仅主人可看；成员可查看自己的用量。" };
  const rs = c.runs.filter(r => r.kind === "mention" && !(r.waited && r.waited > 0));
  if (!rs.length) return { ...s, empty: "还没有有人找你的运行；开启渠道中的“有人找你”后会记录处理批次。" };
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
  const steps: [string, string, RunRow[]][] = [["reached", "进入流程的批次", rs], ["screened", "分诊前筛掉（旁支）", screened], ["triaged", "实际完成分诊", triaged], ["handled", "交给 Agent（含合并）", handled], ["delivered", "已有提醒或代答", delivered]];
  for (const [key, label, rows] of steps) s.metrics.push(metric(c, `shield:${key}`, label, rows.length, refs(rows)));
  const path = [rs, triaged, handled.filter(r => !!r.triage), delivered.filter(r => !!r.triage && !!r.handled)];
  s.charts.push({ title: "分诊主路径（旁支在指标中单列）", kind: "hbar", labels: ["进入流程", "分诊", "分诊后代查", "代查后提醒或代答"].map((label, i) => `${label}${i ? ` · 上步 ${ratio(path[i].length, path[i - 1].length) ?? "—"}%` : ""}`), series: [{ name: "批次", values: path.map(x => x.length) }], points: path.map((rows, i) => metric(c, `shield:path:${i}`, ["进入流程", "分诊", "分诊后代查", "代查后提醒或代答"][i], rows.length, refs(rows))) });
  s.metrics.push(metric(c, "shield:answered", "已代答的样本", answers.length, sampleRefs(c, answers)));
  for (const [key, label] of Object.entries({ acted: "本人处理了", known: "本人已先知道", read: "只看了", unread: "没看", negative: "表示反感", pending: "待标注结果" })) {
    const ns = notices.filter(n => key === "pending" ? !n.outcome : n.outcome === key);
    s.metrics.push(metric(c, `shield:outcome:${key}`, label, ns.length, noticeRefs(ns)));
  }
  s.notes.push("进入：mention 首次运行批次（重试等待 waited>0 排除）；预筛：done、quiet 且无 triage/handleRun/joined；分诊：triage.action 有值；代查：handleRun 或 joined 有值；提醒或代答：关联通知或 sent/edited/auto 样本。", "同批可含多条消息。预筛、合并、额度耗尽提醒是旁支；没有独立预筛原因字段，不把未完成运行算成预筛。通知结果沿用 outcome 既有口径，排除静默、替换和捆绑容器；尚未标注的不猜测。筛选和日期均以运行批次为准，通知本身也须在所选日期内。" );
  return s;
}
export function othersSection(c: Ctx): Section {
  const s = section("others", "给别人带来什么", "访客直接问机器人的次数与身份数；完成用时包含排队，只是两类已记录样本的描述。");
  const rs = c.runs.filter(r => r.kind === "guest");
  if (!rs.length) return { ...s, empty: "还没有人直接问过机器人；开启访客提问后会有记录。" };
  const answered = rs.filter(r => r.status === "done" && r.verdict === "answer" && r.finished_at && Date.parse(r.finished_at) >= Date.parse(r.created_at));
  const times = answered.map(r => (Date.parse(r.finished_at!) - Date.parse(r.created_at)) / 1000);
  const own = c.viewer === OWNER ? samples(c).filter(r => r.owner_reply_at && Date.parse(r.owner_reply_at) >= r.last_ms) : [];
  const ownTimes = own.map(r => (Date.parse(r.owner_reply_at!) - r.last_ms) / 1000);
  const enough = times.length >= 10 && ownTimes.length >= 10;
  s.metrics = [metric(c, "others:questions", "直接提问", rs.length, refs(rs)), metric(c, "others:people", "不同提问身份", new Set(rs.flatMap(r => r.trigger_by ? [r.trigger_by] : [])).size, refs(rs), undefined, "仅按 trigger_by 去重；缺失身份不补猜，同人跨身份可能重复。"),
    { ...metric(c, "others:median", "机器人完成用时中位数", median(times), refs(answered), "秒"), samples: times.length },
    { ...metric(c, "others:p90", "机器人完成用时 P90", percent(times, .9), refs(answered), "秒"), samples: times.length },
    { ...metric(c, "others:owner", "本人自行回复中位数", median(ownTimes), sampleRefs(c, own), "秒"), samples: ownTimes.length }];
  if (enough) s.charts.push({ title: `已完成样本的用时（机器人 n=${times.length}；本人 n=${ownTimes.length}）`, kind: "hbar", labels: ["机器人完成", "本人自行回复"], unit: "秒", series: [{ name: "中位数", values: [median(times)!, median(ownTimes)!] }], points: s.metrics.filter(m => ["others:median", "others:owner"].includes(m.key)) });
  else s.notes.push(`机器人 ${times.length} 个有效用时样本，本人 ${ownTimes.length} 个；任一方不足 10 个时不画对比条，也不推断更快。`);
  grouped(c, s, "others:chat", "访客提问所在会话", rs.filter(r => r.place), r => r.place!);
  s.notes.push("本人基线来自 reply_samples.owner_reply_at − last_ms，不读取回复文字；这是找本人和直接问机器人的两类样本，不代表同一任务的因果对比。done 表示运行完成，未另存实际送达时间。" );
  return s;
}
export function qualitySection(c: Ctx): Section {
  const s = section("quality", "质量", "只统计反馈、草稿去向、评审裁决与已核完的抽检；没有反馈不等于满意。");
  const feedback = all<{ id: string; run_id: string; polarity: string; at: string }>(c.app.db, "select id, run_id, polarity, at from feedback where at >= ? and at < ? and removed_at is null and on_bot = 1 and actor_kind != 'bot'", c.f.start, c.f.end).filter(r => c.ids.has(r.run_id));
  const fr = (xs: typeof feedback) => xs.map(r => ({ id: r.id, label: `反馈 · ${r.polarity}`, at: r.at, link: `#/runs/${r.run_id}` }));
  const feedbackRuns = new Set(feedback.map(f => f.run_id));
  if (feedback.length) for (const [pol, label] of [["positive", "正面"], ["negative", "负面"]]) {
    const fs = feedback.filter(f => f.polarity === pol);
    s.metrics.push(metric(c, `quality:${pol}`, `${label}反馈条数`, fs.length, fr(fs)), metric(c, `quality:${pol}Rate`, `${label}反馈运行占比`, ratio(new Set(fs.map(f => f.run_id)).size, feedbackRuns.size), fr(feedback), "%", "有这类反馈的不同运行 / 获得任意有效反馈的不同运行；两类可重叠。"));
  }
  const ss = c.viewer === OWNER ? samples(c) : [];
  for (const [key, label] of [["sent", "草稿照发"], ["edited", "草稿改后发"], ["dropped", "草稿没发"], ["auto", "持续授权代答"]]) if (ss.some(x => x.decision)) {
    const xs = ss.filter(x => x.decision === key); s.metrics.push(metric(c, `quality:draft:${key}`, label, xs.length, sampleRefs(c, xs)));
  }
  const decided = ss.filter(x => ["sent", "edited", "dropped"].includes(x.decision ?? ""));
  if (decided.length) s.metrics.push(metric(c, "quality:draft:rate", "草稿照发率", ratio(decided.filter(x => x.decision === "sent").length, decided.length), sampleRefs(c, decided), "%", "照发 / (照发 + 改后发 + 没发)，持续授权不算本人裁决。"));
  const findings = all<{ id: number; code_run_id: string; check_name: string; state: string; decision: string | null; created_at: string }>(c.app.db,
    "select f.id, r.code_run_id, r.check_name, f.state, f.decision, r.created_at from review_findings f join reviews r on r.id = f.review_id where r.created_at >= ? and r.created_at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.code_run_id));
  for (const check of new Set(findings.map(f => f.check_name))) {
    const fs = findings.filter(f => f.check_name === check);
    for (const [key, label, xs] of [
      ["accepted", "采纳", fs.filter(f => f.decision === "fix" || f.decision === "later" || f.decision !== "wontfix" && ["accepted", "fixed"].includes(f.state))],
      ["rejected", "不采纳", fs.filter(f => f.decision === "wontfix" || f.state === "rejected" && !["fix", "later"].includes(f.decision ?? ""))],
    ] as const) s.metrics.push(metric(c, `quality:check:${check}:${key}`, `${check} · ${label}`, xs.length, xs.map(f => ({ id: String(f.id), at: f.created_at, label: `${check} · ${label}`, link: `#/runs/${f.code_run_id}` }))));
    const points = s.metrics.slice(-2);
    s.charts.push({ title: `评审项 · ${check}`, kind: "hbar", labels: ["采纳", "不采纳"], series: [{ name: "发现", values: points.map(m => m.value ?? 0) }], points });
    const decidedRefs = points.flatMap(m => c.records.get(m.key) ?? []);
    if (decidedRefs.length) s.metrics.push(metric(c, `quality:check:${check}:rate`, `${check} · 采纳率`, ratio(points[0].value ?? 0, decidedRefs.length), decidedRefs, "%", "采纳 / (采纳 + 不采纳)，未裁决和合并不计入分母。"));
  }
  const audits = all<{ id: string; at: string; verdict: string; audit_run: string | null; space_id: string; category: string }>(c.app.db, "select id, at, verdict, audit_run, space_id, category from quality_audits where at >= ? and at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.audit_run ?? ""));
  for (const category of ["page", "level"]) {
    const as = audits.filter(a => a.category === category && a.verdict !== "unchecked");
    if (as.length) s.metrics.push(metric(c, `quality:audit:${category}`, category === "page" ? "写作抽检准确率" : "定级抽检准确率", ratio(as.filter(a => a.verdict !== "wrong").length, as.length), as.map(a => ({ id: a.id, at: a.at, label: `抽检 · ${a.verdict}`, link: "#/quality" })), "%", "排除没核完；只有写法问题计入没有事实问题。"));
  }
  const replay = replayRows(c);
  for (const [key, label] of [["win", "复盘胜"], ["tie", "复盘平"], ["loss", "复盘负"]]) if (replay.length) {
    const rs = replay.filter(r => r.verdict === key); s.metrics.push(metric(c, `quality:replay:${key}`, label, rs.length, replayRefs(rs)));
  }
  const decisions = c.viewer === OWNER ? all<{ id: string; at: string; scene: keyof typeof DECISION_SCENES; choice: string; taken: string; label: string | null; ref: string | null }>(c.app.db, 'select id, at, scene, choice, taken, label, ref from decisions where at >= ? and at < ?', c.f.start, c.f.end).filter(d => d.ref && c.ids.has(d.ref)) : [];
  if (decisions.length) {
    const dr = (xs: typeof decisions) => xs.map(d => ({ id: d.id, at: d.at, label: `决策 · ${DECISION_SCENES[d.scene]?.label ?? d.scene}`, link: `#/runs/${d.ref}` }));
    const misses = decisions.filter(d => DECISION_SCENES[d.scene] && d.taken === DECISION_SCENES[d.scene].risky && d.label === "needed");
    const lowered = decisions.filter(d => d.choice !== d.taken);
    s.metrics.push(metric(c, "quality:misses", "决策已知漏看", misses.length, dr(misses)), metric(c, "quality:lowered", "决策降低冒险选择", lowered.length, dr(lowered)));
  }
  if (feedback.length) {
    const days = [...new Set(feedback.map(f => localDay(f.at, c.app.config.timezone)))].sort();
    s.charts.push({ title: "反馈条数走势", kind: "line", labels: days, series: ["positive", "negative"].map((p, i) => ({ name: i ? "负面" : "正面", values: days.map(d => feedback.filter(f => f.polarity === p && localDay(f.at, c.app.config.timezone) === d).length) })), points: days.flatMap(d => ["positive", "negative"].map(p => { const fs = feedback.filter(f => f.polarity === p && localDay(f.at, c.app.config.timezone) === d); return metric(c, `quality:day:${d}:${p}`, `${d} · ${p === "positive" ? "正面" : "负面"}`, fs.length, fr(fs)); })) });
  }
  if (!s.metrics.length) s.empty = "还没有质量结果；收到反馈、决定草稿去向或完成评审、抽检、复盘后会填入。";
  s.notes.push("评审按评审项计发现，不把未裁决、合并当成拒绝；决策漏看与降低口径同 decisionReport，只取能关联所选运行的记录。抽检、复盘和决策没有可归属运行的旧记录不纳入。" );
  return s;
}
type ReplayRow = { id: string; at: string; base_run_id: string; verdict: string | null; skill: string | null };
function replayRows(c: Ctx) { return all<ReplayRow>(c.app.db, "select id, at, base_run_id, verdict, json_extract(variant, '$.skillName') skill from replays where at >= ? and at < ?", c.f.start, c.f.end).filter(r => c.ids.has(r.base_run_id)); }
const replayRefs = (xs: ReplayRow[]) => xs.map(r => ({ id: r.id, at: r.at, label: `复盘 · ${r.verdict ?? "未裁决"}`, link: "#/agents" }));
export function deliverySection(c: Ctx): Section {
  const s = section("delivery", "交付", "按编码首轮归属时间统计交办，后续轮次合并；应用和丢弃取记录的状态。");
  const roots = c.runs.filter(r => r.kind === "code" && !r.root);
  if (!roots.length) return { ...s, empty: "还没有编码交办；从运行页交办后会显示交付记录。" };
  const ids = new Set(roots.map(r => r.id));
  // Later rounds may be outside the selected period. They still belong to this start cohort.
  const rounds = all<RunRow>(c.app.db, `select ${RUN_COLUMNS} from runs indexed by runs_insights where created_at >= ? and kind = 'code'`, c.f.start).filter(r => ids.has(r.root ?? r.id) && c.visible(r));
  const rootRounds = new Map<string, RunRow[]>();
  for (const r of rounds) { const root = r.root ?? r.id; const rows = rootRounds.get(root) ?? []; rows.push(r); rootRounds.set(root, rows); }
  const byRoot = (r: RunRow) => rootRounds.get(r.id) ?? [];
  const applied = roots.filter(r => byRoot(r).some(x => x.applied)), discarded = roots.filter(r => byRoot(r).some(x => x.discarded));
  const approved = roots.filter(r => byRoot(r).some(x => x.verdict === "approved"));
  const durations = applied.map(r => (Date.parse(byRoot(r).find(x => x.applied)!.applied!) - Date.parse(r.created_at)) / 3600_000).filter(n => Number.isFinite(n) && n >= 0);
  s.metrics = [metric(c, "delivery:started", "发起交办", roots.length, refs(roots)), metric(c, "delivery:approved", "评审通过", approved.length, refs(approved)), metric(c, "delivery:applied", "已应用", applied.length, refs(applied)), metric(c, "delivery:discarded", "已丢弃", discarded.length, refs(discarded)), metric(c, "delivery:rounds", "轮数中位数", median(roots.map(r => byRoot(r).length)), refs(rounds)), metric(c, "delivery:time", "发起到应用中位数", median(durations), refs(applied), "小时")];
  s.charts.push({ title: "交办当前去向（状态可重叠）", kind: "hbar", labels: s.metrics.slice(0, 4).map(m => m.label), series: [{ name: "交办", values: s.metrics.slice(0, 4).map(m => m.value!) }], points: s.metrics.slice(0, 4) });
  s.notes.push("通过指任一轮 output.verdict=approved，应用指 appliedAt，丢弃指 discardedAt；后续状态会随时间变化。只记录推送分支、没有 appliedAt 的交办不当作应用。" );
  return s;
}
export function knowledgeSection(c: Ctx): Section {
  const s = section("knowledge", "知识", "页面阅读没有记录用途，按全部阅读展示；记忆召回区分回答与整理，命中指记录中的 used。");
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
      s.metrics.push(metric(c, "knowledge:pages", "现存页面", pages.length, pr), metric(c, "knowledge:read", "期间读过的现存页面占比", ratio(readPages.length, pages.length), pr, "%", "全部阅读，无法区分回答或整理；明细为现存页面，值 1 表示期间读过、0 表示没读过。page_reads.day 按 UTC 日期记录。"));
      const point = metric(c, "knowledge:readPages", "期间读过的现存页面", readPages.length, readPages);
      s.metrics.push(point);
      s.charts.push({ title: "页面阅读（全部用途）", kind: "hbar", labels: ["现存页面", "期间读过"], series: [{ name: "页面", values: [pages.length, readPages.length] }], points: [s.metrics[0], point] });
    }
    const lessons = all<{ id: string; space_id: string; hits: number; last_hit_at: string | null }>(c.app.db, "select id, space_id, hits, last_hit_at from repo_lessons").filter(p => visible(p.space_id));
    if (lessons.length) s.metrics.push(metric(c, "knowledge:lessons", "仓库约定累计命中", lessons.reduce((n, p) => n + p.hits, 0), lessons.map(p => ({ id: p.id, at: p.last_hit_at ?? "", label: `仓库约定 · ${p.space_id}`, link: `#/settings?tab=spaces&space=${encodeURIComponent(p.space_id)}`, value: p.hits })), undefined, "累计值，没有逐次命中时间；不受期间限制，不做上一段对比。"));
  } else s.notes.push("页面阅读与约定累计命中没有运行或人员归属；成员视图及按人、机器人、场景、档案、模型、会话筛选时不展示。" );
  const recalls = all<{ id: number; at: string; run_id: string | null; purpose: string; used: number }>(c.app.db, "select id, at, run_id, purpose, used from memory_recalls where at >= ? and at < ?", c.f.start, c.f.end).filter(r => r.run_id && c.ids.has(r.run_id));
  for (const [purpose, label] of [["answer", "回答与办事"], ["upkeep", "后台整理"]]) {
    const xs = recalls.filter(r => r.purpose === purpose);
    const rr = xs.map(r => ({ id: String(r.id), at: r.at, label: `记忆召回 · ${label}`, link: `#/runs/${r.run_id}`, value: r.used }));
    if (recalls.length) s.metrics.push(metric(c, `knowledge:recall:${purpose}`, `${label}召回`, xs.length, rr), metric(c, `knowledge:hit:${purpose}`, `${label}引用率`, ratio(xs.filter(r => r.used).length, xs.length), rr, "%", "used=1 的召回 / 这类召回；不是检索相关性评测。"));
  }
  const replays = replayRows(c).filter(r => r.skill);
  for (const name of new Set(replays.map(r => r.skill!))) for (const [v, label] of [["all", "尝试"], ["win", "胜"], ["tie", "平"], ["loss", "负"]]) {
    const rs = replays.filter(r => r.skill === name && (v === "all" || r.verdict === v));
    s.metrics.push(metric(c, `knowledge:skill:${name}:${v}`, `技能 ${name} · ${label}`, rs.length, replayRefs(rs)));
  }
  const ms = s.metrics.filter(m => m.key.startsWith("knowledge:recall:"));
  if (ms.length) s.charts.push({ title: "记忆召回用途", kind: "hbar", labels: ms.map(m => m.label), series: [{ name: "召回", values: ms.map(m => m.value!) }], points: ms });
  if (!s.metrics.length) s.empty = "还没有可归属的知识使用记录；阅读 Wiki、召回记忆或尝试技能后会填入。";
  s.notes.push("普通技能调用次数、查不到的问题没有独立计数表，本页不扫描工具事件。技能仅统计期间复盘中的尝试及裁决，不等于所有调用。" );
  return s;
}
export function costSection(c: Ctx): Section {
  const s = section("cost", "成本", "运行次数与起止时间；并行运行时长相加，不代表账单、CPU 时间或 Token 费用。");
  const rs = usageRuns(c);
  if (!rs.length) return { ...s, empty: "还没有可统计的运行；完成任务后会显示后端、模型和运行时长。" };
  const dimensions = [["backend", "后端", (r: RunRow) => parseAi(r.ai).profile ?? "未记录后端"], ["model", "模型", (r: RunRow) => parseAi(r.ai).model ?? "未记录模型"], ["scene", "场景", sceneOf]] as const;
  for (const [key, label, by] of dimensions) {
    grouped(c, s, `cost:${key}`, label, rs, by);
    for (const group of new Set(rs.map(by))) {
      const rows = rs.filter(r => by(r) === group && r.started_at && r.finished_at && Date.parse(r.finished_at) >= Date.parse(r.started_at));
      if (rows.length) s.metrics.push(metric(c, `cost:${key}:hours:${group}`, `${label} ${group} · 总运行时长`, round(rows.reduce((n, r) => n + (Date.parse(r.finished_at!) - Date.parse(r.started_at!)) / 3600_000, 0)), refs(rows), "小时"));
    }
  }
  s.notes.push("ai 只记首次成功调用使用的后端和模型；未记录的保留单独一组。运行时长不含排队，没有起止时间的运行只计次数。" );
  return s;
}
const builders = [usageSection, coverageSection, shieldSection, othersSection, qualitySection, deliverySection, knowledgeSection, costSection];
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
      return { ...section(build.name.replace("Section", ""), ({ usageSection: "用量与覆盖", coverageSection: "用在哪", shieldSection: "替本人挡了多少", othersSection: "给别人带来什么", qualitySection: "质量", deliverySection: "交付", knowledgeSection: "知识", costSection: "成本" } as Record<string, string>)[build.name], "这部分暂时无法读取。"), error: "这部分暂时无法读取，请稍后重试。" };
    }
  });
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
  return `# 成效记录\n\n${report.from} 至 ${report.to}（${report.timezone}）\n\n` + report.sections.map(s => {
    const rs = rows.slice(1).filter(r => r[0] === s.title);
    return `## ${s.title}\n\n${s.description}\n\n| ${rows[0].slice(1).join(" | ")} |\n| ${rows[0].slice(1).map(() => "---").join(" | ")} |\n${rs.map(r => `| ${r.slice(1).map(esc).join(" | ")} |`).join("\n")}`;
  }).join("\n\n");
}
