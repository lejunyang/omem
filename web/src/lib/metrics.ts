/**
 * Metrics on the page (GET /api/metrics, src/data/http.ts): the shapes the board and a metric's details
 * share, and how their words read — the schedule, a metric with no numbers yet, the dimensions omem's
 * own daily numbers are split by.
 */
import { fmt } from "./time";

export type ViewKind = "line" | "area" | "bar" | "stack" | "compare" | "pie" | "table" | "number";
export type MetricView = { kind: ViewKind; compareBy?: string; ratio?: boolean; focus?: string };
export type MetricChange = { value: number; base: number | null; rel: number | null; flagged: boolean; good: boolean | null };
export type MetricStatus = "active" | "paused" | "proposed" | "dropped";
export type Metric = {
  id: string; name: string; unit: string; source: string; query: string; schedule: string; description: string; why: string; direction?: string; status: MetricStatus;
  baseline?: number; threshold?: number; lastAt: string | null; nextAt: string | null; change: MetricChange | null; spark: number[]; figure: string | null; groups: number;
  latest: { label: string; values: { name: string; value: number }[] } | null; points: number; view: MetricView | null;
  planRef: string | null; plan: { id: string; title: string } | null; definedBy: "owner" | "agent" | "omem"; definedRun: string | null; confirmedAt: string | null; createdAt: string;
  itemId: string | null; itemTitle: string | null; lineId: string | null; lineTitle: string | null; spaceId: string;
};
export type MetricTable = { labels: string[]; series: { name: string; values: (number | null)[] }[] };
export type MetricDetail = { kind: ViewKind; charts: import("@omem-ai/plugin-sdk/charts").ChartSpec[]; table: MetricTable; points: { at: string; value: number; dims: Record<string, string> }[] };
export type DataFile = { id: string; title: string; path: string; kind: "catalog" | "plan" | "note" | "report"; itemId: string | null; spaceId: string; updatedAt: string };

export const SCHEDULE: Record<string, string> = { none: "按需取", hourly: "每小时", daily: "每天", weekly: "每周" };
export const SCHEDULES = [{ value: "none", label: "按需取（用到时才取）" }, { value: "hourly", label: "每小时" }, { value: "daily", label: "每天" }, { value: "weekly", label: "每周" }];
export const KINDS: { value: ViewKind; label: string }[] = [
  { value: "line", label: "走势线" }, { value: "area", label: "面积（看量）" }, { value: "bar", label: "每天一根柱" }, { value: "stack", label: "叠加的柱（看合计）" },
  { value: "compare", label: "几组并排" }, { value: "pie", label: "最近一次的构成" }, { value: "table", label: "只列数" }, { value: "number", label: "只看最新的数" },
];
export const kindLabel = (k: ViewKind) => KINDS.find((x) => x.value === k)?.label ?? k;
export const pct = (r: number) => `${r > 0 ? "+" : ""}${Math.round(r * 1000) / 10}%`;
export const when = (iso: string) => fmt(iso, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export const shortDay = (iso: string) => fmt(iso, { month: "numeric", day: "numeric" });
const clock = (iso: string) => fmt(iso, { hour: "2-digit", minute: "2-digit", hour12: false });

/** Units whose values average rather than add up (src/data/metrics.ts AVERAGED). */
const AVERAGED = /^(%|‰|ms|毫秒|秒|分钟|小时|天|倍|分)$/;
/** Whether a metric's groups add up to a whole: counts do; omem's own daily numbers are counts and totals. */
export const additive = (m: Pick<Metric, "unit" | "source">) => m.source === "omem" || !AVERAGED.test(m.unit.trim());

/** When the next number is taken, short: today's time, or the day and time. */
function nextText(m: Metric) {
  if (!m.nextAt || Date.parse(m.nextAt) - Date.now() < 15 * 60_000) return "几分钟内";
  const d = new Date(m.nextAt), now = new Date();
  return d.toDateString() === now.toDateString() ? clock(m.nextAt) : when(m.nextAt);
}
/** A metric without a number yet, in one short line (a tile, a row). */
export function notYet(m: Metric) {
  if (m.source === "omem") return "这段时间还没有";
  if (m.status === "paused") return "暂停中，不取数";
  if (m.schedule === "none") return "还没取到 · 用到时才取";
  return `还没取到 · 下次 ${nextText(m)}`;
}
/** The same, said fully (the details). */
export function notYetLong(m: Metric, work: boolean) {
  if (m.source === "omem") return "这段时间还没有记录，omem 每天统计一次。";
  if (m.status === "paused") return "暂停中，不取数。";
  const from = m.source && work ? `从${m.source}` : "";
  if (m.schedule === "none") return `按需取：助手用到它时才${from}取一次。要按时看，点“改”把取数改成每天。`;
  return `${SCHEDULE[m.schedule] ?? m.schedule}${from}取一次，第一次在${nextText(m)}。`;
}
/** How often and when last, for the line under a number. */
export const takenText = (m: Metric) => `${SCHEDULE[m.schedule] ?? m.schedule}${m.lastAt ? ` · 上次 ${shortDay(m.lastAt)}` : ""}`;

export function origin(m: Metric) {
  if (m.definedBy === "omem") return "omem 自己每天统计";
  if (m.definedBy === "owner") return `你定的 · ${shortDay(m.createdAt)}`;
  return m.status === "proposed" ? `AI 提议 · ${shortDay(m.createdAt)}` : m.confirmedAt ? `AI 提议 · ${shortDay(m.createdAt)}，你 ${shortDay(m.confirmedAt)} 留下` : `AI 提议 · ${shortDay(m.createdAt)}`;
}

/** omem's own daily numbers are split by these (src/data/omem-usage.ts); a work metric's dimensions are named by whoever defined them. */
const DIM_NAMES: Record<string, string> = {
  kind: "类型", status: "结果", trigger: "经由", profile: "后端", model: "模型", label: "判成", judge: "谁判的", revised: "改判", review: "复查", source: "来源", decision: "决定", channel: "渠道",
};
const DIM_VALUES: Record<string, Record<string, string>> = {
  status: { done: "做完", failed: "失败", cancelled: "取消", running: "进行中", queued: "排队中" },
  trigger: { chat: "对话", web: "网页", lark: "飞书", schedule: "定时", mention: "有人找你", guest: "访客", rule: "规则", heartbeat: "定时巡检", api: "接口", peer: "别的设备" },
  label: { resolved: "解决了", followup: "被追问", corrected: "被纠正", taken_over: "别人接手了", unrelated: "无关", silent: "没人接话", unjudged: "看不出", 未判: "还没判" },
  decision: { sent: "照发", edited: "改了再发", dropped: "没发", auto: "自动答", none: "没回", "owner-replied": "你自己回的" },
  channel: { web: "网页", lark: "飞书", mcp: "外部 Agent", api: "接口" },
};
export const dimName = (m: Pick<Metric, "source">, key: string) => (m.source === "omem" ? DIM_NAMES[key] ?? key : key);
export function dimValue(m: Pick<Metric, "source">, key: string, value: string) {
  // A whole JSON object kept as a value by an older version reads as its `via`.
  if (value.startsWith("{")) {
    try {
      const o = JSON.parse(value) as { via?: string };
      value = typeof o?.via === "string" ? o.via : "其他";
    } catch { /* not JSON after all */ }
  }
  return m.source === "omem" ? DIM_VALUES[key]?.[value] ?? value : value;
}
