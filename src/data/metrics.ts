import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { metricProviders } from "../plugins/process-hooks.ts";
import { canWrite, OWNER } from "../core/users.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";
import { fingerprint, mayPropose, recordChoice } from "../items/choices.ts";

/**
 * Metrics: the numbers of the owner's work the assistant keeps an eye on — events tracked by a
 * feature, errors and usage after a release, an old platform against its replacement. omem keeps the
 * definitions (what it measures and why, which system holds it and how to read it, which item or 关注 it
 * serves, how often to take it, what change matters, how it is drawn) and the points; the configured
 * provider or an agent with the appropriate skills reads the system.
 *
 * Where a metric comes from: the owner (on the web, or in their own turn with the assistant) defines it
 * outright; a background agent (an observation plan, a line's daily look) only proposes it. A proposal
 * is taken like any other, so there are real numbers when the owner decides, but its changes are never
 * told. The owner keeps it (active, `confirmedAt`), changes it, or drops it (`dropped`, no longer
 * taken); the last of those decisions are read by the agents that propose more (`metricLessons`).
 *
 * A point recorded is compared with the metric's baseline (its own, or the median of the points before
 * it); a change past the threshold of an active metric is told: into the conversation of the 关注 it
 * serves, on the item's timeline, and to the owner as a later-urgency notification.
 */
export type MetricSchedule = "none" | "hourly" | "daily" | "weekly";
export type MetricStatus = "active" | "paused" | "proposed" | "dropped";
export type MetricDefiner = "owner" | "agent" | "omem";
/**
 * How the page draws a metric (packages/plugin-sdk/charts.ts kinds): `line` / `area` / `bar` over time,
 * `stack` columns adding the series up, `compare` the series side by side (by `compareBy`, a dimension),
 * `pie` the newest point's parts, `table` the numbers only, `number` the latest figure only. `ratio`
 * adds a chart of each series' share; `focus` is the series the tile shows (and whose share is drawn).
 */
export const VIEW_KINDS = ["line", "area", "bar", "stack", "compare", "pie", "table", "number"] as const;
export type MetricViewKind = (typeof VIEW_KINDS)[number];
export type MetricView = { kind: MetricViewKind; compareBy?: string; ratio?: boolean; focus?: string };
export const metricViewSchema = z.object({
  kind: z.enum(VIEW_KINDS).describe("line 走势 / area 看量 / bar 每天的柱 / stack 几类叠加 / compare 几组并排（配 compareBy）/ pie 最近一次的构成 / table 只列数 / number 只看最新的数"),
  compareBy: z.string().trim().min(1).max(40).optional().describe("按哪个维度分组并排，例如 side（新 / 旧）"),
  ratio: z.boolean().optional().describe("另画一张各组的占比"),
  focus: z.string().trim().min(1).max(60).optional().describe("卡片上显示哪一组（compareBy 的某个值），占比也画它"),
});

export type Metric = {
  id: string;
  name: string;
  description: string;
  /** One line: what question of the owner's this number answers. */
  why: string;
  unit: string;
  /** The system that holds it (as the data-source catalog names it). */
  source: string;
  /** How to read it: the skill, command or query and its parameters, in words an agent can follow. */
  query: string;
  /** The observation plan section it came from: `src:<id>#L起-L止`. */
  planRef: string | null;
  providerId?: string;
  providerQuery?: unknown;
  providerUserId?: string;
  lastAttemptAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  itemId: string | null;
  contextId: string | null;
  spaceId: string;
  schedule: MetricSchedule;
  /** Fixed reference value; unset: the median of the last points before the newest. */
  baseline?: number;
  /** Relative change (0.3 = 30%) past which a change is told; default 0.3. */
  threshold?: number;
  /** Which way is good: an increase of errors is bad, of usage good. */
  direction?: "up-good" | "down-good" | "neutral";
  status: MetricStatus;
  definedBy: MetricDefiner;
  /** The run that defined it, when an agent did. */
  definedRun: string | null;
  /** When the owner kept it (or defined it themselves). */
  confirmedAt: string | null;
  droppedAt: string | null;
  /** The owner's word when dropping it (why not). */
  ownerNote: string | null;
  view: MetricView | null;
  lastAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type MetricPoint = { at: string; value: number; dims: Record<string, string>; note: string | null; runId: string | null };

type Row = {
  id: string; name: string; description: string; why: string; unit: string; source: string; query: string; plan_ref: string | null; item_id: string | null; context_id: string | null;
  space_id: string; schedule: MetricSchedule; settings: string; status: MetricStatus; defined_by: MetricDefiner; defined_run: string | null; confirmed_at: string | null;
  dropped_at: string | null; owner_note: string | null; view: string | null; last_at: string | null; created_at: string; updated_at: string;
};
type Settings = Pick<Metric, "baseline" | "threshold" | "direction" | "providerId" | "providerQuery" | "providerUserId" | "lastAttemptAt" | "lastError" | "lastErrorAt">;

const DEFAULT_THRESHOLD = 0.3;
const SCHEDULE_MS: Record<Exclude<MetricSchedule, "none">, number> = { hourly: 3600_000, daily: 86400_000, weekly: 7 * 86400_000 };
/** Taken (by schedule or on demand): kept ones and proposals. */
export const COLLECTED: MetricStatus[] = ["active", "proposed"];

function toMetric(r: Row): Metric {
  const s = json<Settings>(r.settings, {});
  return {
    id: r.id, name: r.name, description: r.description, why: r.why ?? "", unit: r.unit, source: r.source, query: r.query, planRef: r.plan_ref ?? null, itemId: r.item_id, contextId: r.context_id,
    spaceId: r.space_id, schedule: r.schedule, ...s, status: r.status, definedBy: r.defined_by ?? "agent", definedRun: r.defined_run ?? null, confirmedAt: r.confirmed_at ?? null,
    droppedAt: r.dropped_at ?? null, ownerNote: r.owner_note ?? null, view: json<MetricView | null>(r.view, null), lastAt: r.last_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getMetric(app: App, idOrName: string): Metric | null {
  const r = one<Row>(app.db, "select * from metrics where id = ? or name = ? order by created_at limit 1", idOrName, idOrName);
  return r ? toMetric(r) : null;
}
export function requireMetric(app: App, idOrName: string): Metric {
  const m = getMetric(app, idOrName);
  if (!m) throw new HttpError(404, `没有这个指标：${idOrName}（metric_read 不带参数列出全部）`);
  return m;
}

/** Metrics, newest change first. Dropped ones only with `includeDropped`; `activeOnly`: kept ones being watched; `collected`: kept ones and proposals. */
export function listMetrics(app: App, opts: { itemId?: string; itemIds?: string[]; contextId?: string; spaces?: string[] | null; activeOnly?: boolean; collected?: boolean; includeDropped?: boolean } = {}): Metric[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.itemId) (where.push("item_id = ?"), params.push(opts.itemId));
  if (opts.itemIds) {
    where.push("item_id in (select value from json_each(?))");
    params.push(JSON.stringify(opts.itemIds));
  }
  if (opts.contextId) (where.push("context_id = ?"), params.push(opts.contextId));
  if (opts.activeOnly) where.push("status = 'active'");
  else if (opts.collected) where.push("status in ('active','proposed')");
  else if (!opts.includeDropped) where.push("status != 'dropped'");
  if (opts.spaces) where.push(`space_id in (${opts.spaces.map(() => "?").join(",") || "''"})`), params.push(...opts.spaces);
  return all<Row>(app.db, `select * from metrics ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc limit 500`, ...params).map(toMetric);
}

export type MetricInput = Partial<Omit<Metric, "lastAt" | "createdAt" | "updatedAt" | "baseline" | "planRef" | "view" | "definedBy" | "definedRun" | "confirmedAt" | "droppedAt" | "providerId" | "providerUserId" | "lastAttemptAt" | "lastError" | "lastErrorAt">> & {
  name: string;
  providerId?: string | null;
  baseline?: number | null;
  planRef?: string | null;
  view?: MetricView | null;
};
/** Who is defining: the owner (the web, their own turn), a background agent (and its run), or omem itself. */
export type MetricBy = { by: MetricDefiner; runId?: string | null; userId?: string };

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/**
 * Create a metric, or update the one with this id (or name). An agent's new metric is a proposal; an
 * agent cannot keep, drop or bring back a metric — the owner decides (`by.by` owner keeps with status
 * active, drops with dropped).
 */
export function defineMetric(app: App, input: MetricInput, by: MetricBy = { by: "owner" }): Metric {
  const prev = input.id ? getMetric(app, input.id) : getMetric(app, input.name);
  const agent = by.by === "agent";
  const providerId = input.providerId === undefined ? prev?.providerId : input.providerId ?? undefined;
  const providerChanged = input.providerId !== undefined || input.providerQuery !== undefined || (input.spaceId !== undefined && input.spaceId !== prev?.spaceId);
  const providerQuery = input.providerQuery !== undefined ? input.providerQuery : providerId === prev?.providerId ? prev?.providerQuery : undefined;
  if (providerId && providerChanged) {
    const entry = metricProviders.get(providerId);
    if (!entry) throw new HttpError(400, `指标数据源不可用：${providerId}`);
    const checked = entry.def.querySchema.safeParse(providerQuery);
    if (!checked.success) throw new HttpError(400, `数据源查询不符合要求：${checked.error.message}`);
  }
  if (!providerId && input.providerQuery !== undefined) throw new HttpError(400, "providerQuery 需要指定 providerId");
  if (!providerId && (!prev || prev.providerId) && !(input.query ?? prev?.query)?.trim()) throw new HttpError(400, "新指标要写查法（query）：哪个系统、用哪个技能或命令、什么参数，后台照着取数");
  if (!prev && agent && !input.why?.trim()) throw new HttpError(400, "提议新指标要写 why：这个数回答本人的什么问题（一句话），本人凭它决定要不要");
  if (input.threshold !== undefined && !(input.threshold > 0 && input.threshold <= 10)) throw new HttpError(400, "threshold 是相对变化，例如 0.3 表示 30%");
  if (input.planRef && !/^src:[\w-]+(#L\d+(-L?\d+)?)?$/.test(input.planRef.trim())) throw new HttpError(400, "planRef 写观测计划那一节的引用：src:<原件id>#L起-L止");
  const view = input.view === undefined ? prev?.view ?? null : input.view ? metricViewSchema.parse(input.view) : null;
  const at = now();
  let status: MetricStatus;
  let confirmedAt = prev?.confirmedAt ?? null;
  let droppedAt = prev?.droppedAt ?? null;
  if (input.status === "proposed") throw new HttpError(400, "status 只能是 active、paused 或 dropped");
  if (!prev && input.status === "dropped") throw new HttpError(400, "还没有这个指标，不用标“不要”");
  if (agent) {
    // Said 不要 to a metric of this name before (it may have been removed since, or named a little
    // differently): not proposed again unless its query changed (items/choices.ts, the one record of choices).
    if (!prev) {
      const said = mayPropose(app, by.userId ?? OWNER, "metric", fingerprint(input.name), fingerprint(input.query ?? ""));
      if (!said.ok) throw new HttpError(409, `${said.why}，不要再提议同样的指标；查法变了才可以再提`);
    }
    if (prev?.status === "dropped") throw new HttpError(409, `本人不要这个指标（${day(prev.droppedAt)}${prev.ownerNote ? `，本人说：${prev.ownerNote}` : ""}），不要再提议同样的；本人在对话里亲口要回来时才能改`);
    if (input.status === "dropped") throw new HttpError(403, "要不要一个指标由本人定：不再需要的写进 why 或说明，本人在数据页点“不要”");
    // A proposal stays one until the owner decides; a kept metric may be paused and resumed.
    status = !prev ? "proposed" : prev.status === "proposed" ? "proposed" : input.status ?? prev.status;
  } else {
    status = input.status ?? prev?.status ?? "active";
    if (!prev) confirmedAt = at;
    if (status === "active") {
      confirmedAt ??= at;
      droppedAt = null;
    }
    if (status === "dropped" && prev?.status !== "dropped") droppedAt = at;
    // The owner's word on an agent's proposal, in the one record of choices (items/choices.ts).
    if (prev?.definedBy === "agent" && status !== prev.status && (status === "dropped" || (status === "active" && prev.status === "proposed")))
      recordChoice(app, { userId: by.userId ?? OWNER, kind: "metric", target: fingerprint(prev.name), version: fingerprint(input.query ?? prev.query), choice: status === "dropped" ? "drop" : "keep", reason: input.ownerNote ?? null, via: "web" });
  }
  const m: Metric = {
    id: prev?.id ?? input.id ?? newId("m"),
    name: input.name.trim().slice(0, 120),
    description: input.description ?? prev?.description ?? "",
    why: (input.why ?? prev?.why ?? "").trim().slice(0, 300),
    unit: input.unit ?? prev?.unit ?? "",
    source: input.source ?? prev?.source ?? "",
    query: input.query ?? prev?.query ?? "",
    planRef: input.planRef === undefined ? prev?.planRef ?? null : input.planRef?.trim() || null,
    itemId: input.itemId === undefined ? (prev?.itemId ?? null) : input.itemId,
    contextId: input.contextId === undefined ? (prev?.contextId ?? null) : input.contextId,
    spaceId: input.spaceId ?? prev?.spaceId ?? "personal",
    schedule: input.schedule ?? prev?.schedule ?? "none",
    baseline: input.baseline === undefined ? prev?.baseline : input.baseline ?? undefined,
    threshold: input.threshold === undefined ? prev?.threshold : input.threshold,
    direction: input.direction ?? prev?.direction,
    status,
    definedBy: prev?.definedBy ?? by.by,
    definedRun: prev ? prev.definedRun : (by.runId ?? null),
    confirmedAt,
    droppedAt,
    ownerNote: agent ? prev?.ownerNote ?? null : input.ownerNote === undefined ? prev?.ownerNote ?? null : input.ownerNote?.trim() || null,
    view,
    lastAt: prev?.lastAt ?? null,
    createdAt: prev?.createdAt ?? at,
    updatedAt: at,
  };
  const settings: Settings = { ...(m.baseline !== undefined ? { baseline: m.baseline } : {}), ...(m.threshold !== undefined ? { threshold: m.threshold } : {}), ...(m.direction ? { direction: m.direction } : {}) };
  if (providerId) {
    Object.assign(settings, { providerId, providerQuery, providerUserId: providerChanged ? by.userId ?? OWNER : prev?.providerUserId });
    if (!providerChanged) Object.assign(settings, { lastAttemptAt: prev?.lastAttemptAt, lastError: prev?.lastError, lastErrorAt: prev?.lastErrorAt });
  }
  run(
    app.db,
    `insert into metrics(id,name,description,why,unit,source,query,plan_ref,item_id,context_id,space_id,schedule,settings,status,defined_by,defined_run,confirmed_at,dropped_at,owner_note,view,last_at,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(id) do update set name=excluded.name, description=excluded.description, why=excluded.why, unit=excluded.unit, source=excluded.source, query=excluded.query,
       plan_ref=excluded.plan_ref, item_id=excluded.item_id, context_id=excluded.context_id, space_id=excluded.space_id, schedule=excluded.schedule, settings=excluded.settings,
       status=excluded.status, confirmed_at=excluded.confirmed_at, dropped_at=excluded.dropped_at, owner_note=excluded.owner_note, view=excluded.view, updated_at=excluded.updated_at`,
    m.id, m.name, m.description, m.why, m.unit, m.source, m.query, m.planRef, m.itemId, m.contextId, m.spaceId, m.schedule, JSON.stringify(settings), m.status,
    m.definedBy, m.definedRun, m.confirmedAt, m.droppedAt, m.ownerNote, m.view ? JSON.stringify(m.view) : null, m.lastAt, m.createdAt, m.updatedAt,
  );
  return getMetric(app, m.id)!;
}

const dimsKey = (d: Record<string, string> | undefined) => JSON.stringify(Object.fromEntries(Object.entries(d ?? {}).sort(([a], [b]) => a.localeCompare(b))));

/**
 * A dimension value that is a whole JSON object (omem's own run counts kept the run's trigger as it was
 * stored, before they kept only how it came in) reads as that `via`; points that become the same series
 * and time that way are added up.
 */
function readDims(raw: string): Record<string, string> {
  const d = json<Record<string, string>>(raw, {});
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== "string" || !v.startsWith("{")) continue;
    const o = json<{ via?: unknown } | null>(v, null);
    if (o && typeof o === "object") d[k] = typeof o.via === "string" && o.via ? o.via : "其他";
  }
  return d;
}

export function metricPoints(app: App, metricId: string, opts: { since?: string; dims?: Record<string, string>; limit?: number } = {}): MetricPoint[] {
  const rows = all<{ at: string; value: number; dims: string; note: string | null; run_id: string | null }>(
    app.db,
    `select at, value, dims, note, run_id from metric_points where metric_id = ? ${opts.since ? "and at >= ?" : ""} ${opts.dims ? "and dims = ?" : ""} order by at desc limit ?`,
    metricId, ...(opts.since ? [opts.since] : []), ...(opts.dims ? [dimsKey(opts.dims)] : []), opts.limit ?? 500,
  ).reverse();
  const out: MetricPoint[] = [];
  const seen = new Map<string, MetricPoint>();
  for (const r of rows) {
    const legacy = r.dims.includes('"{');
    const p = { at: r.at, value: r.value, dims: legacy ? readDims(r.dims) : json<Record<string, string>>(r.dims, {}), note: r.note, runId: r.run_id };
    const k = `${p.at}|${dimsKey(p.dims)}`;
    const same = seen.get(k);
    if (same) {
      same.value += p.value;
      continue;
    }
    seen.set(k, p);
    out.push(p);
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export type MetricChange = { value: number; base: number | null; rel: number | null; flagged: boolean; good: boolean | null };

/** The newest point (of one series) against the baseline: its own, or the median of up to 7 points before it. */
export function changeOf(m: Metric, series: Pick<MetricPoint, "value">[]): MetricChange | null {
  const last = series.at(-1);
  if (!last) return null;
  const base = m.baseline ?? median(series.slice(-8, -1).map((p) => p.value));
  const rel = base === null || base === 0 ? null : (last.value - base) / Math.abs(base);
  const flagged = rel !== null && Math.abs(rel) >= (m.threshold ?? DEFAULT_THRESHOLD);
  const good = rel === null || !m.direction || m.direction === "neutral" ? null : (rel > 0) === (m.direction === "up-good");
  return { value: last.value, base, rel, flagged, good };
}

const pct = (r: number) => `${r > 0 ? "+" : ""}${Math.round(r * 1000) / 10}%`;
export const describeChange = (m: Metric, c: MetricChange) =>
  `${m.name}：${c.value}${m.unit}${c.base !== null ? `（基线 ${Math.round(c.base * 100) / 100}${m.unit}${c.rel !== null ? `，${pct(c.rel)}` : ""}）` : ""}${c.good === null ? "" : c.good ? "，向好" : "，变差"}`;

/** Record points (from a collection run or by hand); a change past the threshold of a kept metric is told. Returns the change of each series touched. */
export async function recordPoints(app: App, idOrName: string, points: { value: number; at?: string; dims?: Record<string, string>; note?: string }[], runId: string | null = null, defaultItemId?: string) {
  const m = requireMetric(app, idOrName);
  if (m.status === "dropped") throw new HttpError(409, `本人不要指标「${m.name}」了，不用再记它的数`);
  if (!points.length) throw new HttpError(400, "没有要记的点");
  const at = now();
  tx(app.db, () => {
    for (const p of points) {
      if (!Number.isFinite(p.value)) throw new HttpError(400, `不是数字：${p.value}`);
      run(app.db, "insert into metric_points(metric_id,at,value,dims,note,run_id,created_at) values(?,?,?,?,?,?,?) on conflict(metric_id,at,dims) do update set value=excluded.value, note=excluded.note, run_id=excluded.run_id, created_at=excluded.created_at",
        m.id, p.at ?? at, p.value, dimsKey(p.dims), p.note ?? null, runId, at);
    }
    run(app.db, "update metrics set last_at = ?, updated_at = ? where id = ?", at, at, m.id);
  });
  const series = [...new Set(points.map((p) => dimsKey(p.dims)))];
  const changes = series.map((d) => ({ dims: json<Record<string, string>>(d, {}), change: changeOf(m, metricPoints(app, m.id, { dims: json(d, {}), limit: 30 })) }));
  const flagged = changes.filter((c) => c.change?.flagged);
  // A proposal (or a paused metric) is taken but never told: the owner has not said they want it.
  // The newest point recorded names this crossing in the change ledger: collecting the same points again is the same change.
  const newest = points.map((p) => p.at ?? at).sort().at(-1) ?? at;
  if (flagged.length && m.status === "active") await tellChange(app, m, flagged.map((c) => `${Object.keys(c.dims).length ? `[${Object.entries(c.dims).map(([k, v]) => `${k}=${v}`).join(",")}] ` : ""}${describeChange(m, c.change!)}`), m.itemId ?? defaultItemId, `metric:${m.id}@${newest}`);
  return changes;
}

async function tellChange(app: App, m: Metric, lines: string[], itemId?: string, source?: string) {
  const body = `${lines.join("\n")}${m.why ? `\n\n${truncate(m.why, 200)}` : m.description ? `\n\n${truncate(m.description, 200)}` : ""}`;
  const { notify } = await import("../core/notify.ts");
  // A change in the numbers is not a first nudge about a new item (no grace period), and a notification
  // the host declines (the same thing just told) must not lose the timeline and conversation below.
  try {
    notify(app, { title: `指标「${m.name}」有变化`, body, urgency: "later", plain: true, graceDone: true, ...(m.itemId ? { entity: "item" as const, entityId: m.itemId } : {}), link: m.itemId ? `#/work/${m.itemId}` : `#/insights?tab=${m.source === "omem" ? "omem" : "work"}&metric=${m.id}` });
  } catch (e) {
    console.warn(`[omem] 指标「${m.name}」的变化没有通知本人：${(e as Error).message}`);
  }
  if (m.contextId) {
    const { getContext } = await import("../channels/listen.ts");
    const c = getContext(app, m.contextId);
    if (c?.conversationId) {
      const { addMessage } = await import("../agents/threads.ts");
      addMessage(app, c.conversationId, "user", `（指标变化）${body}`, null, { command: true, metric: m.id });
    }
  }
  if (itemId) {
    try {
      // A key result on the line's timeline (items/changes.ts), noted only; the same crossing told again is not a second one.
      const { recordChange } = await import("../items/changes.ts");
      const noted = recordChange(app, { itemId, type: "result", origin: "metric", source, summary: `指标变化：${truncate(lines[0] ?? m.name, 200)}${lines.length > 1 ? ` 等 ${lines.length} 处` : ""}`, detail: lines.length > 1 ? lines.join("\n") : m.why || m.description ? truncate(m.why || m.description, 300) : null });
      const { addItemEvent } = await import("../items/store.ts");
      if (noted?.created) addItemEvent(app, itemId, "note", `指标变化：${lines.join("；")}`, "agent");
    } catch {
      // The item may be gone; the notification still says it.
    }
  }
}

// ------------------------------------------------------------------ how a metric is drawn

/** Units whose values are averaged, not added, when several points fall into one series and time. */
const AVERAGED = /^(%|‰|ms|毫秒|秒|分钟|小时|天|倍|分)$/;
/** Whether a metric's series add up to a whole (counts) rather than average (rates, durations). */
export const additive = (m: Pick<Metric, "unit">) => !AVERAGED.test(m.unit.trim());
/** A chart for the page or a report (the subset of packages/plugin-sdk/charts.ts ChartSpec built here). */
export type MetricChart = {
  kind: "line" | "area" | "bar" | "hbar" | "pie";
  title?: string;
  unit?: string;
  caption?: string;
  note?: string;
  stack?: boolean;
  labels: string[];
  series: { name: string; values: number[]; slot?: number }[];
};
/** The numbers by time and series, missing ones null (the page's table and the few-points line). */
export type MetricTable = { labels: string[]; series: { name: string; values: (number | null)[] }[] };

const cutOf = (m: Metric) => (m.schedule === "hourly" ? 13 : 10);
const shown = (l: string) => l.slice(5).replace("T", " ");

/**
 * The points as series by label (day, or hour for an hourly metric): one series per combination of
 * dimensions, or with `view.compareBy` one per value of that dimension (several combinations in a
 * group are added up, or averaged for rates). The newest point of a series and time wins. `focus`
 * comes first.
 */
export function metricTable(m: Metric, points: MetricPoint[]): MetricTable {
  const cut = cutOf(m);
  const by = m.view?.compareBy;
  const last = new Map<string, { group: string; name: string; label: string; value: number }>();
  for (const p of points) {
    const label = p.at.slice(0, cut);
    const group = by ? (p.dims[by] ?? "（没分）") : dimsKey(p.dims);
    const name = by ? group : Object.values(p.dims).join(" / ") || m.name;
    last.set(`${dimsKey(p.dims)}|${label}`, { group, name, label, value: p.value });
  }
  const groups = new Map<string, { name: string; sum: Map<string, number>; n: Map<string, number> }>();
  for (const x of last.values()) {
    let g = groups.get(x.group);
    if (!g) groups.set(x.group, (g = { name: x.name, sum: new Map(), n: new Map() }));
    g.sum.set(x.label, (g.sum.get(x.label) ?? 0) + x.value);
    g.n.set(x.label, (g.n.get(x.label) ?? 0) + 1);
  }
  const labels = [...new Set([...last.values()].map((x) => x.label))].sort();
  const avg = AVERAGED.test(m.unit.trim());
  let series = [...groups.values()].map((g) => ({ name: g.name, values: labels.map((l) => (g.sum.has(l) ? (avg ? g.sum.get(l)! / g.n.get(l)! : g.sum.get(l)!) : null)) }));
  const focus = m.view?.focus;
  if (focus) series = [...series.filter((s) => s.name === focus), ...series.filter((s) => s.name !== focus)];
  return { labels: labels.map(shown), series };
}

/** Charts take numbers only: a time without a point carries the one before it on a line (0 before the first), and is empty for columns. */
const filled = (values: (number | null)[], carry: boolean) => {
  let prev = 0;
  return values.map((v) => (v === null ? (carry ? prev : 0) : (prev = v)));
};
const round1 = (v: number) => Math.round(v * 10) / 10;

/** What the view draws: the time chart in its kind (lines when none is given), the newest point's parts, a chart of shares. */
export function metricCharts(m: Metric, t: MetricTable): { kind: MetricViewKind; chart: MetricChart; charts: MetricChart[] } {
  const kind: MetricViewKind = m.view?.kind ?? "line";
  const unit = m.unit;
  const per = m.schedule === "hourly" ? "小时" : "天";
  const series = t.series.slice(0, 6);
  const col = kind === "bar" || kind === "stack";
  const time: MetricChart = {
    kind: kind === "area" ? "area" : col ? "bar" : "line",
    title: m.name,
    unit,
    caption: col ? `一根一${per}` : `一个点一${per}`,
    ...(kind === "stack" && series.length > 1 ? { stack: true } : {}),
    labels: t.labels,
    series: series.map((s, i) => ({ name: s.name, values: filled(s.values, !col), slot: i })),
  };
  const charts: MetricChart[] = [];
  if (kind === "pie") {
    // The newest time's parts, where each was last seen.
    const parts = t.series.slice(0, 8).map((s) => ({ name: s.name, v: s.values.at(-1) })).filter((p): p is { name: string; v: number } => p.v !== null && p.v !== undefined && p.v > 0);
    if (parts.length >= 2) charts.push({ kind: "pie", title: `${m.name}（${t.labels.at(-1)}）`, unit, labels: parts.map((p) => p.name), series: [{ name: m.name, values: parts.map((p) => p.v) }] });
    else charts.push(time);
  } else if (kind !== "table" && kind !== "number") charts.push(time);
  if (m.view?.ratio && series.length >= 2 && kind !== "table" && kind !== "number") {
    const totals = t.labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
    const share = (s: (typeof series)[number]) => s.values.map((v, i) => (totals[i] ? round1(((v ?? 0) / totals[i]) * 100) : 0));
    charts.push(series.length === 2
      ? { kind: "line", title: `${series[0].name} 的占比`, unit: "%", caption: `${series[0].name} ÷（${series.map((s) => s.name).join(" + ")}）`, labels: t.labels, series: [{ name: `${series[0].name} 占比`, values: share(series[0]) }] }
      : { kind: "area", title: `${m.name} · 各组占比`, unit: "%", caption: "加起来是 100%", stack: true, labels: t.labels, series: series.map((s, i) => ({ name: s.name, values: share(s), slot: i })) });
  }
  return { kind, chart: time, charts };
}

/** The series a figure shows: the focus group (compareBy) or the series of the newest point. */
export function figureSeries(m: Metric, points: MetricPoint[]): { values: number[]; name: string | null } {
  if (m.view?.compareBy) {
    const t = metricTable(m, points);
    const s = t.series[0];
    return s ? { values: s.values.filter((v): v is number => v !== null), name: s.name } : { values: [], name: null };
  }
  const lastDims = dimsKey(points.at(-1)?.dims);
  const ps = points.filter((p) => dimsKey(p.dims) === lastDims);
  return { values: ps.map((p) => p.value), name: ps.length && Object.keys(ps[0].dims).length ? Object.values(ps[0].dims).join(" / ") : null };
}

/**
 * The series a tile on the page shows, one tile per metric however many combinations of dimensions it
 * has: the focus group (compareBy); the only series; the sum of all of them for counts (omem's own
 * daily numbers are counts and totals, minutes included); else the newest point's series, named.
 * `groups`: how many series there are (the details compare them).
 */
export function tileSeries(m: Metric, points: MetricPoint[]): { values: number[]; name: string | null; groups: number } {
  const t = metricTable(m, points);
  const groups = t.series.length;
  if (m.view?.compareBy || groups <= 1) return { ...figureSeries(m, points), groups };
  if (additive(m) || m.source === "omem") {
    const values = t.labels.flatMap((_, i) => {
      const xs = t.series.map((s) => s.values[i]).filter((v): v is number => v !== null);
      return xs.length ? [round1(xs.reduce((a, b) => a + b, 0))] : [];
    });
    return { values, name: null, groups };
  }
  return { ...figureSeries(m, points), groups };
}

/** The newest time and each series' value then (the tile, the few-points line). */
export function latestOf(t: MetricTable): { label: string; values: { name: string; value: number }[] } | null {
  const i = t.labels.length - 1;
  if (i < 0) return null;
  return { label: t.labels[i], values: t.series.flatMap((s) => (s.values[i] === null ? [] : [{ name: s.name, value: s.values[i]! }])) };
}

/** When the next point is due: null when it is not taken on a schedule (or not taken at all); now when never taken yet. */
export function nextTake(m: Metric): string | null {
  if (m.schedule === "none" || !COLLECTED.includes(m.status)) return null;
  const last = latestAttempt(m);
  return last ? new Date(Date.parse(last) + SCHEDULE_MS[m.schedule]).toISOString() : now();
}

/** Points and figures of a metric for a reply or a report: series, newest against the baseline, and the charts its view draws. */
export function readMetric(app: App, idOrName: string, opts: { days?: number; dims?: Record<string, string> } = {}) {
  const m = requireMetric(app, idOrName);
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400_000).toISOString();
  // Up to a few thousand points: a metric split many ways has dozens a day.
  const points = metricPoints(app, m.id, { since, dims: opts.dims, limit: 6000 });
  const bySeries = new Map<string, MetricPoint[]>();
  for (const p of points) {
    const k = dimsKey(p.dims);
    bySeries.set(k, [...(bySeries.get(k) ?? []), p]);
  }
  const table = metricTable(m, points);
  const { kind, chart, charts } = metricCharts(m, table);
  const changes = [...bySeries.entries()].map(([k, ps]) => ({ dims: json<Record<string, string>>(k, {}), change: changeOf(m, ps) }));
  return { metric: m, points, changes, kind, chart, charts, table, latest: latestOf(table) };
}

const STATUS_TEXT: Record<MetricStatus, string> = { active: "在看", paused: "暂停", proposed: "AI 提议，待本人确认（照样取数，变化不通知）", dropped: "本人不要了" };

/** Text for an agent: the definition, the latest figures and chart blocks a report can embed. */
export function metricText(app: App, idOrName: string, opts: { days?: number; dims?: Record<string, string>; chart?: boolean } = {}) {
  const r = readMetric(app, idOrName, opts);
  const m = r.metric;
  const head = [
    `## ${m.name}（${m.id}）`,
    m.why ? `回答的问题：${m.why}` : "",
    m.description,
    `状态：${STATUS_TEXT[m.status]}${m.planRef ? `；来自观测计划 ${m.planRef}` : ""}${m.view ? `；网页上画成 ${m.view.kind}${m.view.compareBy ? `（按 ${m.view.compareBy} 并排${m.view.ratio ? "，带占比" : ""}）` : ""}` : ""}`,
    `来源：${m.source || "（没写）"}；查法：${truncate(m.query, 400)}`,
    m.providerId ? `指标数据源：${metricProviders.get(m.providerId)?.def.label ?? m.providerId}（${m.providerId}）` : "",
    m.lastError ? `最近采集失败（${m.lastErrorAt}）：${m.lastError}` : "",
    `采集：${m.schedule}${m.lastAt ? `，最近 ${m.lastAt.slice(0, 16).replace("T", " ")}` : "，还没有数据"}${m.itemId ? `；事项 ${m.itemId}` : ""}${m.contextId ? `；关注 ${m.contextId}` : ""}`,
  ].filter(Boolean);
  const changes = r.changes.filter((c) => c.change).map((c) => `- ${Object.keys(c.dims).length ? `[${Object.entries(c.dims).map(([k, v]) => `${k}=${v}`).join(",")}] ` : ""}${describeChange(m, c.change!)}${c.change!.flagged ? "（超过门槛）" : ""}`);
  const recent = r.points.slice(-12).map((p) => `${p.at.slice(0, 16).replace("T", " ")} ${Object.values(p.dims).join("/")}${Object.keys(p.dims).length ? " " : ""}${p.value}${m.unit}`).join("；");
  const blocks = (r.charts.length ? r.charts : [r.chart]).map((c) => `\`\`\`chart\n${JSON.stringify(c)}\n\`\`\``).join("\n\n");
  return [...head, changes.length ? `最近的变化：\n${changes.join("\n")}` : "", recent ? `最近的点：${recent}` : "", opts.chart && r.points.length ? `报表里放图用这${r.charts.length > 1 ? "几" : "一"}段（放进 数据/报表/ 下的工作文件，网页上画成图）：\n${blocks}` : ""].filter(Boolean).join("\n");
}

/** One line per metric (for lists, the weekly report and an item's page). */
export function metricsSummary(app: App, metrics: Metric[]) {
  return metrics.map((m) => {
    const c = changeOf(m, figureSeries(m, metricPoints(app, m.id, { limit: 60 })).values.map((value) => ({ value })));
    return `- ${m.name}${m.status === "proposed" ? "（待本人确认）" : ""}${c ? `：${describeChange(m, c).slice(m.name.length + 1)}` : "：还没有数据"}`;
  }).join("\n");
}

// ------------------------------------------------------------------ what the owner kept and dropped

export type MetricDecision = { id: string; name: string; why: string; decision: "kept" | "dropped"; note: string | null; at: string; itemId: string | null };

/** The owner's latest decisions on metrics agents proposed, newest first. */
export function metricDecisions(app: App, opts: { spaces?: string[] | null; limit?: number; days?: number } = {}): MetricDecision[] {
  const since = new Date(Date.now() - (opts.days ?? 90) * 86400_000).toISOString();
  const spaces = opts.spaces ? `and space_id in (${opts.spaces.map(() => "?").join(",") || "''"})` : "";
  return all<Row>(
    app.db,
    `select * from metrics where defined_by = 'agent' and ((status = 'dropped' and dropped_at > ?) or (status != 'dropped' and confirmed_at > ?)) ${spaces}
     order by coalesce(dropped_at, confirmed_at) desc limit ?`,
    since, since, ...(opts.spaces ?? []), opts.limit ?? 8,
  ).map(toMetric).map((m) => ({ id: m.id, name: m.name, why: m.why, decision: m.status === "dropped" ? "dropped" : "kept", note: m.ownerNote, at: (m.status === "dropped" ? m.droppedAt : m.confirmedAt) ?? m.updatedAt, itemId: m.itemId }));
}

/**
 * For agents about to propose metrics (metric_define, metric_read, a line's daily look): what the owner
 * kept and dropped lately, and how many proposals still wait. Empty when there is nothing to learn.
 */
export function metricLessons(app: App, opts: { spaces?: string[] | null; limit?: number } = {}): string {
  const d = metricDecisions(app, { spaces: opts.spaces, limit: opts.limit ?? 8 });
  const spaces = opts.spaces ? `and space_id in (${opts.spaces.map(() => "?").join(",") || "''"})` : "";
  const waiting = one<{ n: number }>(app.db, `select count(*) n from metrics where status = 'proposed' ${spaces}`, ...(opts.spaces ?? []))?.n ?? 0;
  if (!d.length && !waiting) return "";
  const lines = d.map((x) => `- ${x.at.slice(5, 10)} ${x.decision === "kept" ? "留下" : "不要"}「${x.name}」${x.why ? `（${truncate(x.why, 80)}）` : ""}${x.note ? `，本人说：${truncate(x.note, 120)}` : ""}`);
  return [
    "本人对 AI 提议的指标最近是这么定的（新的在前）：",
    ...(lines.length ? lines : ["- （还没定过）"]),
    waiting ? `还有 ${waiting} 个提议等本人定：先别再加同类的，少而准，只提本人真会问的问题对应的数。` : "少而准：只提本人真会问的问题对应的数，像本人不要的那类就别提。",
  ].join("\n");
}

// ------------------------------------------------------------------ taking the numbers

/** Collection runs a day at most (all metrics together): a guard against a schedule gone wrong. */
const COLLECT_PER_DAY = 40;

function latestAttempt(m: Metric) {
  return m.lastAttemptAt && (!m.lastAt || m.lastAttemptAt > m.lastAt) ? m.lastAttemptAt : m.lastAt;
}

const providerPoint = z.object({
  metricId: z.string(), at: z.union([z.iso.datetime({ offset: true }), z.iso.date()]),
  value: z.number().finite(), dims: z.record(z.string().min(1).max(120), z.string().max(500)).optional(),
  source: z.string().max(2000).optional(),
});

function sameBinding(app: App, m: Metric) {
  const current = getMetric(app, m.id);
  return current && current.schedule !== "none" && COLLECTED.includes(current.status) && current.spaceId === m.spaceId && current.providerId === m.providerId &&
    current.providerUserId === m.providerUserId && JSON.stringify(current.providerQuery) === JSON.stringify(m.providerQuery);
}

function collectionResult(app: App, m: Metric, at: string, error?: string) {
  const patch = { lastAttemptAt: at, lastErrorAt: error ? at : null, lastError: error ?? null };
  run(app.db, "update metrics set settings=json_patch(settings,?), updated_at=? where id=?", JSON.stringify(patch), at, m.id);
}

async function collectProvider(app: App, batch: Metric[], at: number) {
  const first = batch[0];
  const to = new Date(at).toISOString();
  const entry = metricProviders.get(first.providerId!);
  const userId = first.providerUserId!;
  try {
    if (!entry) throw new Error(`指标数据源不可用：${first.providerId}`);
    if (!canWrite(app, userId, first.spaceId)) throw new Error("连接用户已失去指标空间的写权限");
    const signal = AbortSignal.timeout(15_000);
    const ctx = entry.context(app, userId, first.spaceId, signal);
    const metrics = batch.map(m => ({ id: m.id, query: entry.def.querySchema.parse(m.providerQuery) }));
    const starts = batch.map(m => m.lastAt ? Date.parse(m.lastAt) : at - SCHEDULE_MS[m.schedule as Exclude<MetricSchedule, "none">]);
    const from = new Date(Math.min(...starts)).toISOString();
    const raw = await Promise.race([
      entry.def.collect(ctx, { metrics, from, to }),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
    const grouped = new Map(batch.map(m => [m.id, [] as z.infer<typeof providerPoint>[]]));
    for (const p of z.array(providerPoint).max(10000).parse(raw)) {
      const rows = grouped.get(p.metricId);
      if (!rows) throw new Error("数据源返回了本批之外的指标");
      rows.push(p);
    }
    for (const m of batch) {
      if (!sameBinding(app, m) || entry !== metricProviders.get(m.providerId!) || !canWrite(app, userId, m.spaceId)) continue;
      const rows = grouped.get(m.id)!;
      if (rows.length) await recordPoints(app, m.id, rows.map(p => ({ at: p.at.length === 10 ? p.at : new Date(p.at).toISOString(), value: p.value, dims: p.dims, note: p.source })));
      if (sameBinding(app, m)) collectionResult(app, m, to);
    }
  } catch (e) {
    const error = truncate(e instanceof Error ? e.message : String(e), 500) || "指标采集失败";
    const failed = batch.filter(m => sameBinding(app, m));
    for (const m of failed) collectionResult(app, m, to, error);
    const newlyFailed = failed.filter(m => !m.lastError && m.status === "active");
    if (newlyFailed.length && canWrite(app, userId, first.spaceId)) {
      const { notify } = await import("../core/notify.ts");
      notify(app, { userId, title: `指标采集失败：${entry?.def.label ?? first.providerId}`,
        body: `${newlyFailed.map(m => m.name).join("、")}：${error}`, urgency: "later", plain: true });
    }
  }
}

const collecting = new WeakMap<App, Promise<string[]>>();
export function collectDue(app: App, at = Date.now()): Promise<string[]> {
  const pending = collecting.get(app);
  if (pending) return pending;
  const work = collectScheduled(app, at).finally(() => collecting.delete(app));
  collecting.set(app, work);
  return work;
}

async function collectScheduled(app: App, at: number) {
  const due = listMetrics(app, { collected: true }).filter(m => {
    const last = latestAttempt(m);
    return m.schedule !== "none" && (!last || at - Date.parse(last) >= SCHEDULE_MS[m.schedule] - 5 * 60_000);
  });
  const batches = new Map<string, Metric[]>();
  const agentMetrics: Metric[] = [];
  for (const m of due) {
    if (!m.providerId) { agentMetrics.push(m); continue; }
    const key = JSON.stringify([m.providerId, m.providerUserId, m.spaceId]);
    const batch = batches.get(key);
    if (batch) batch.push(m);
    else batches.set(key, [m]);
  }
  const created = await queueAgentMetrics(app, agentMetrics, at);
  for (const batch of batches.values()) {
    const current = batch.filter(m => sameBinding(app, m));
    if (current.length) await collectProvider(app, current, at);
  }
  return created;
}

async function queueAgentMetrics(app: App, agentMetrics: Metric[], at: number) {
  if (!agentMetrics.length) return [];
  const start = new Date(at);
  start.setHours(0, 0, 0, 0);
  const today = one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'agent' and json_extract(input, '$.metricCollect') is not null and created_at >= ?", start.toISOString())?.n ?? 0;
  if (today >= COLLECT_PER_DAY) return [];
  const created: string[] = [];
  const bySpace = new Map<string, Metric[]>();
  for (const m of agentMetrics) bySpace.set(m.spaceId, [...(bySpace.get(m.spaceId) ?? []), m]);
  return import("../agents/runs.ts").then(({ createRun, runsInLane }) => {
    for (const [space, ms] of bySpace) {
      const lane = `metric-collect:${space}`;
      if (runsInLane(app, lane).length) continue;
      const task = [
        "# 按时取指标",
        "",
        "下面这些指标到了采集时间。按每个指标的查法（用对应的技能或命令）取到最新的值，用 `metric_record` 记下（带时间；分维度的每个维度一条，dims 写清）。只读查询，不改任何系统。",
        "取不到的写清卡在哪（权限、登录、查法过时），本人需要处理的用 notify 说一次；查法明显过时的用 `metric_define` 改正它的 query。",
        "标着“待确认”的是 AI 提议、本人还没定的指标：照样取数，让本人决定时有真实的数；不要为它们通知本人。",
        "这一轮不用回答本人，取完调用 stay_quiet。",
        "",
        ...ms.map((m) => `- ${m.id}「${m.name}」${m.status === "proposed" ? "（待确认）" : ""}（${m.unit || "无单位"}）：来源 ${m.source || "（没写）"}；查法：${m.query}${m.lastAt ? `；上次 ${m.lastAt.slice(0, 16).replace("T", " ")}` : "；第一次取"}`),
      ].join("\n");
      const r = createRun(app, {
        kind: "agent",
        spaceId: space,
        lane,
        title: `取指标：${ms.map((m) => m.name).join("、").slice(0, 60)}`,
        userId: OWNER,
        input: {
          spec: "assistant",
          task,
          metricCollect: ms.map((m) => m.id),
          assistantScope: { spaces: [space, "personal"], userId: OWNER, denyTools: ["delegate_code", "review_branch", "continue_code_run", "settle_code_task", "apply_code_run", "code_git_action", "save_rule", "set_chat_watch", "lark_send", "lark_card", "lark_write", "lark_invite", "run_agent", "upsert_item"], lark: { chats: [], draft: true } },
        },
      });
      created.push(r.id);
    }
    return created;
  });
}
