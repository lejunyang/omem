import type { App } from "../core/app.ts";
import { all, one, run, tx } from "../core/db.ts";
import { OWNER } from "../core/users.ts";
import { HttpError, json, newId, now, truncate } from "../core/util.ts";

/**
 * Metrics: the numbers of the owner's work the assistant keeps an eye on — events tracked by a
 * feature, errors and usage after a release, an old platform against its replacement. omem keeps the
 * definitions (what it measures, which system holds it and how to read it, which item or 关注 it
 * serves, how often to take it, what change matters) and the points; reading the systems themselves
 * is the agents' work through skills (the systems are the owner's, described in their data directory).
 *
 * A point recorded is compared with the metric's baseline (its own, or the median of the points before
 * it); a change past the threshold is told: into the conversation of the 关注 it serves, on the item's
 * timeline, and to the owner as a later-urgency notification.
 */
export type MetricSchedule = "none" | "hourly" | "daily" | "weekly";
export type Metric = {
  id: string;
  name: string;
  description: string;
  unit: string;
  /** The system that holds it (as the data-source catalog names it). */
  source: string;
  /** How to read it: the skill, command or query and its parameters, in words an agent can follow. */
  query: string;
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
  status: "active" | "paused";
  lastAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type MetricPoint = { at: string; value: number; dims: Record<string, string>; note: string | null; runId: string | null };

type Row = {
  id: string; name: string; description: string; unit: string; source: string; query: string; item_id: string | null; context_id: string | null;
  space_id: string; schedule: MetricSchedule; settings: string; status: "active" | "paused"; last_at: string | null; created_at: string; updated_at: string;
};
type Settings = Pick<Metric, "baseline" | "threshold" | "direction">;

const DEFAULT_THRESHOLD = 0.3;
const SCHEDULE_MS: Record<Exclude<MetricSchedule, "none">, number> = { hourly: 3600_000, daily: 86400_000, weekly: 7 * 86400_000 };

function toMetric(r: Row): Metric {
  const s = json<Settings>(r.settings, {});
  return {
    id: r.id, name: r.name, description: r.description, unit: r.unit, source: r.source, query: r.query, itemId: r.item_id, contextId: r.context_id,
    spaceId: r.space_id, schedule: r.schedule, ...s, status: r.status, lastAt: r.last_at, createdAt: r.created_at, updatedAt: r.updated_at,
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

export function listMetrics(app: App, opts: { itemId?: string; contextId?: string; spaces?: string[] | null; activeOnly?: boolean } = {}): Metric[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.itemId) (where.push("item_id = ?"), params.push(opts.itemId));
  if (opts.contextId) (where.push("context_id = ?"), params.push(opts.contextId));
  if (opts.activeOnly) where.push("status = 'active'");
  if (opts.spaces) where.push(`space_id in (${opts.spaces.map(() => "?").join(",") || "''"})`), params.push(...opts.spaces);
  return all<Row>(app.db, `select * from metrics ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc limit 500`, ...params).map(toMetric);
}

export type MetricInput = Partial<Omit<Metric, "lastAt" | "createdAt" | "updatedAt">> & { name: string };

/** Create a metric, or update the one with this id (or name). */
export function defineMetric(app: App, input: MetricInput): Metric {
  const prev = input.id ? getMetric(app, input.id) : getMetric(app, input.name);
  if (!prev && !input.query?.trim()) throw new HttpError(400, "新指标要写查法（query）：哪个系统、用哪个技能或命令、什么参数，后台照着取数");
  if (input.threshold !== undefined && !(input.threshold > 0 && input.threshold <= 10)) throw new HttpError(400, "threshold 是相对变化，例如 0.3 表示 30%");
  const at = now();
  const m: Metric = {
    id: prev?.id ?? input.id ?? newId("m"),
    name: input.name.trim().slice(0, 120),
    description: input.description ?? prev?.description ?? "",
    unit: input.unit ?? prev?.unit ?? "",
    source: input.source ?? prev?.source ?? "",
    query: input.query ?? prev?.query ?? "",
    itemId: input.itemId === undefined ? (prev?.itemId ?? null) : input.itemId,
    contextId: input.contextId === undefined ? (prev?.contextId ?? null) : input.contextId,
    spaceId: input.spaceId ?? prev?.spaceId ?? "personal",
    schedule: input.schedule ?? prev?.schedule ?? "none",
    baseline: input.baseline === undefined ? prev?.baseline : input.baseline,
    threshold: input.threshold === undefined ? prev?.threshold : input.threshold,
    direction: input.direction ?? prev?.direction,
    status: input.status ?? prev?.status ?? "active",
    lastAt: prev?.lastAt ?? null,
    createdAt: prev?.createdAt ?? at,
    updatedAt: at,
  };
  const settings: Settings = { ...(m.baseline !== undefined ? { baseline: m.baseline } : {}), ...(m.threshold !== undefined ? { threshold: m.threshold } : {}), ...(m.direction ? { direction: m.direction } : {}) };
  run(
    app.db,
    `insert into metrics(id,name,description,unit,source,query,item_id,context_id,space_id,schedule,settings,status,last_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(id) do update set name=excluded.name, description=excluded.description, unit=excluded.unit, source=excluded.source, query=excluded.query,
       item_id=excluded.item_id, context_id=excluded.context_id, space_id=excluded.space_id, schedule=excluded.schedule, settings=excluded.settings,
       status=excluded.status, updated_at=excluded.updated_at`,
    m.id, m.name, m.description, m.unit, m.source, m.query, m.itemId, m.contextId, m.spaceId, m.schedule, JSON.stringify(settings), m.status, m.lastAt, m.createdAt, m.updatedAt,
  );
  return getMetric(app, m.id)!;
}

const dimsKey = (d: Record<string, string> | undefined) => JSON.stringify(Object.fromEntries(Object.entries(d ?? {}).sort(([a], [b]) => a.localeCompare(b))));

export function metricPoints(app: App, metricId: string, opts: { since?: string; dims?: Record<string, string>; limit?: number } = {}): MetricPoint[] {
  return all<{ at: string; value: number; dims: string; note: string | null; run_id: string | null }>(
    app.db,
    `select at, value, dims, note, run_id from metric_points where metric_id = ? ${opts.since ? "and at >= ?" : ""} ${opts.dims ? "and dims = ?" : ""} order by at desc limit ?`,
    metricId, ...(opts.since ? [opts.since] : []), ...(opts.dims ? [dimsKey(opts.dims)] : []), opts.limit ?? 500,
  ).reverse().map((r) => ({ at: r.at, value: r.value, dims: json(r.dims, {}), note: r.note, runId: r.run_id }));
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export type MetricChange = { value: number; base: number | null; rel: number | null; flagged: boolean; good: boolean | null };

/** The newest point (of one series) against the baseline: its own, or the median of up to 7 points before it. */
export function changeOf(m: Metric, series: MetricPoint[]): MetricChange | null {
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

/** Record points (from a collection run or by hand); a change past the threshold is told. Returns the change of each series touched. */
export async function recordPoints(app: App, idOrName: string, points: { value: number; at?: string; dims?: Record<string, string>; note?: string }[], runId: string | null = null) {
  const m = requireMetric(app, idOrName);
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
  if (flagged.length) await tellChange(app, m, flagged.map((c) => `${Object.keys(c.dims).length ? `[${Object.entries(c.dims).map(([k, v]) => `${k}=${v}`).join(",")}] ` : ""}${describeChange(m, c.change!)}`));
  return changes;
}

async function tellChange(app: App, m: Metric, lines: string[]) {
  const body = `${lines.join("\n")}${m.description ? `\n\n${truncate(m.description, 200)}` : ""}`;
  const { notify } = await import("../core/notify.ts");
  notify(app, { title: `指标「${m.name}」有变化`, body, urgency: "later", plain: true, ...(m.itemId ? { entity: "item" as const, entityId: m.itemId } : {}), link: m.itemId ? `#/items/${m.itemId}` : "#/data" });
  if (m.contextId) {
    const { getContext } = await import("../channels/listen.ts");
    const c = getContext(app, m.contextId);
    if (c?.conversationId) {
      const { addMessage } = await import("../agents/threads.ts");
      addMessage(app, c.conversationId, "user", `（指标变化）${body}`, null, { command: true, metric: m.id });
    }
  }
  if (m.itemId) {
    try {
      const { addItemEvent } = await import("../items/store.ts");
      addItemEvent(app, m.itemId, "note", `指标变化：${lines.join("；")}`, "agent");
    } catch {
      // The item may be gone; the notification still says it.
    }
  }
}

/** Points and figures of a metric for a reply or a report: series, newest against the baseline, and a chart spec. */
export function readMetric(app: App, idOrName: string, opts: { days?: number; dims?: Record<string, string> } = {}) {
  const m = requireMetric(app, idOrName);
  const since = new Date(Date.now() - (opts.days ?? 30) * 86400_000).toISOString();
  const points = metricPoints(app, m.id, { since, dims: opts.dims });
  const bySeries = new Map<string, MetricPoint[]>();
  for (const p of points) {
    const k = dimsKey(p.dims);
    bySeries.set(k, [...(bySeries.get(k) ?? []), p]);
  }
  const labels = [...new Set(points.map((p) => p.at.slice(0, m.schedule === "hourly" ? 13 : 10)))].sort();
  const chart = {
    kind: "line" as const,
    title: m.name,
    unit: m.unit,
    labels: labels.map((l) => l.slice(5).replace("T", " ")),
    series: [...bySeries.entries()].slice(0, 6).map(([k, ps]) => {
      const dims = json<Record<string, string>>(k, {});
      const byLabel = new Map(ps.map((p) => [p.at.slice(0, m.schedule === "hourly" ? 13 : 10), p.value]));
      // Charts take numbers only: a day without a point carries the one before it (0 before the first).
      let prev = 0;
      return { name: Object.values(dims).join(" / ") || m.name, values: labels.map((l) => (prev = byLabel.get(l) ?? prev)) };
    }),
  };
  const changes = [...bySeries.entries()].map(([k, ps]) => ({ dims: json<Record<string, string>>(k, {}), change: changeOf(m, ps) }));
  return { metric: m, points, changes, chart };
}

/** Text for an agent: the definition, the latest figures and a chart block a report can embed. */
export function metricText(app: App, idOrName: string, opts: { days?: number; dims?: Record<string, string>; chart?: boolean } = {}) {
  const r = readMetric(app, idOrName, opts);
  const m = r.metric;
  const head = [`## ${m.name}（${m.id}）`, m.description, `来源：${m.source || "（没写）"}；查法：${truncate(m.query, 400)}`, `采集：${m.schedule}${m.lastAt ? `，最近 ${m.lastAt.slice(0, 16).replace("T", " ")}` : "，还没有数据"}${m.itemId ? `；事项 ${m.itemId}` : ""}${m.contextId ? `；关注 ${m.contextId}` : ""}`].filter(Boolean);
  const changes = r.changes.filter((c) => c.change).map((c) => `- ${Object.keys(c.dims).length ? `[${Object.entries(c.dims).map(([k, v]) => `${k}=${v}`).join(",")}] ` : ""}${describeChange(m, c.change!)}${c.change!.flagged ? "（超过门槛）" : ""}`);
  const recent = r.points.slice(-12).map((p) => `${p.at.slice(0, 16).replace("T", " ")} ${Object.values(p.dims).join("/")}${Object.keys(p.dims).length ? " " : ""}${p.value}${m.unit}`).join("；");
  return [...head, changes.length ? `最近的变化：\n${changes.join("\n")}` : "", recent ? `最近的点：${recent}` : "", opts.chart && r.points.length ? `报表里放图用这一段：\n\`\`\`chart\n${JSON.stringify(r.chart)}\n\`\`\`` : ""].filter(Boolean).join("\n");
}

/** One line per metric (for lists, the weekly report and an item's page). */
export function metricsSummary(app: App, metrics: Metric[]) {
  return metrics.map((m) => {
    const c = changeOf(m, metricPoints(app, m.id, { limit: 30 }).filter((p, _i, all) => dimsKey(p.dims) === dimsKey(all.at(-1)?.dims)));
    return `- ${m.name}${c ? `：${describeChange(m, c).slice(m.name.length + 1)}` : "：还没有数据"}`;
  }).join("\n");
}

/** Collection runs a day at most (all metrics together): a guard against a schedule gone wrong. */
const COLLECT_PER_DAY = 40;

/** Heartbeat: scheduled metrics whose time came get one collection run for the batch (grouped by space). */
export function collectDue(app: App, at = Date.now()) {
  const due = listMetrics(app, { activeOnly: true }).filter((m) => m.schedule !== "none" && (!m.lastAt || at - Date.parse(m.lastAt) >= SCHEDULE_MS[m.schedule] - 5 * 60_000));
  if (!due.length) return [];
  const start = new Date(at);
  start.setHours(0, 0, 0, 0);
  const today = one<{ n: number }>(app.db, "select count(*) n from runs where kind = 'agent' and json_extract(input, '$.metricCollect') is not null and created_at >= ?", start.toISOString())?.n ?? 0;
  if (today >= COLLECT_PER_DAY) return [];
  const created: string[] = [];
  const bySpace = new Map<string, Metric[]>();
  for (const m of due) bySpace.set(m.spaceId, [...(bySpace.get(m.spaceId) ?? []), m]);
  return import("../agents/runs.ts").then(({ createRun, runsInLane }) => {
    for (const [space, ms] of bySpace) {
      const lane = `metric-collect:${space}`;
      if (runsInLane(app, lane).length) continue;
      const task = [
        "# 按时取指标",
        "",
        "下面这些指标到了采集时间。按每个指标的查法（用对应的技能或命令）取到最新的值，用 `metric_record` 记下（带时间；分维度的每个维度一条，dims 写清）。只读查询，不改任何系统。",
        "取不到的写清卡在哪（权限、登录、查法过时），本人需要处理的用 notify 说一次；查法明显过时的用 `metric_define` 改正它的 query。",
        "这一轮不用回答本人，取完调用 stay_quiet。",
        "",
        ...ms.map((m) => `- ${m.id}「${m.name}」（${m.unit || "无单位"}）：来源 ${m.source || "（没写）"}；查法：${m.query}${m.lastAt ? `；上次 ${m.lastAt.slice(0, 16).replace("T", " ")}` : "；第一次取"}`),
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
