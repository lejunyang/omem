import { restrictedSourceFilter } from "../auth/visibility.ts";
import { itemAccess, requireItem } from "../items/access.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { accessibleSpaces, canWrite } from "../core/users.ts";
import { all, one } from "../core/db.ts";
import { HttpError, json } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { descendantIds, rootOf } from "../items/tree.ts";
import { changeOf, defineMetric, figureSeries, latestOf, listMetrics, metricPoints, metricTable, metricViewSchema, nextTake, readMetric, requireMetric } from "./metrics.ts";

/**
 * Metrics on the web: the list (an item's and those under it, a 关注's, or all one may read), one metric
 * with its points and the charts its view draws, the work files behind them (catalog, observation plans,
 * collection notes, reports), and a person keeping, changing or dropping a metric. Reading the systems
 * stays the agents' (src/data/metrics.ts).
 */
export function registerMetricRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const readable = (req: FastifyRequest) => accessibleSpaces(app, who(req));
  const visibleBranch = (id: string, req: FastifyRequest) => {
    requireItem(app, id, who(req), "read");
    return [id, ...descendantIds(app, id, readable(req) ?? undefined)];
  };
  const title = (id: string) => one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? null;
  /** The observation plan a metric came from: `src:<id>#…` to the work file and its title. */
  const planOf = (ref: string | null) => {
    const id = ref?.match(/^src:([\w-]+)/)?.[1];
    const r = id ? one<{ id: string; title: string }>(app.db, "select id, title from sources where id = ? and deleted_at is null", id) : null;
    return r ? { id: r.id, title: r.title } : null;
  };

  server.get("/api/metrics", async (req) => {
    const q = z.object({ item: z.string().optional(), context: z.string().optional(), source: z.string().optional(), dropped: z.string().optional() }).parse(req.query ?? {});
    // An item's metrics are its own and those of the items under it (a line shows its requirements').
    const itemIds = q.item ? visibleBranch(q.item, req) : undefined;
    const root = q.item ? getItem(app, rootOf(app, q.item)) : null;
    const visibleRoot = root && itemAccess(app, who(req), root, "read") ? root.id : null;
    const list = listMetrics(app, { itemIds, contextId: q.context, spaces: readable(req), includeDropped: q.dropped === "1" }).filter((m) => !q.source || m.source === q.source);
    return list.map((m) => {
      const pts = metricPoints(app, m.id, { limit: 120 });
      const fig = figureSeries(m, pts);
      // Which matter, and which work line above it, the metric watches: the data page groups by the line.
      const line = q.item ? visibleRoot : m.itemId ? rootOf(app, m.itemId) : null;
      return {
        ...m, change: changeOf(m, fig.values.map((value) => ({ value }))), spark: fig.values.slice(-30), figure: fig.name, latest: latestOf(metricTable(m, pts)), points: pts.length, nextAt: nextTake(m),
        plan: planOf(m.planRef), itemTitle: m.itemId ? title(m.itemId) : null, lineId: line, lineTitle: line ? title(line) : null,
      };
    });
  });

  // The work files behind the metrics: the data-source catalog, observation plans, collection notes (paths
  // under 数据/ or 观测/, as the built-in skills data-sources and observation-plan write them), and reports:
  // files under 数据/报表/, or any work file with a ```chart block (drawn on the page). `item`: the files
  // linked to that item or to one under it.
  server.get("/api/metrics/files", async (req) => {
    const q = z.object({ item: z.string().optional() }).parse(req.query ?? {});
    const spaces = readable(req);
    const under = q.item ? new Set(visibleBranch(q.item, req)) : null;
    const filter = under ? restrictedSourceFilter(app, who(req)) : { sql: "1", params: [] };
    const rows = all<{ id: string; title: string; uri: string; space_id: string; meta: string; updated_at: string; charts: number }>(
      app.db,
      `select id, title, uri, space_id, meta, updated_at, instr(text, '\`\`\`chart') > 0 charts from sources
       where kind = 'work' and deleted_at is null and ${filter.sql} and (uri like 'work/数据/%' or uri like 'work/观测/%' or instr(text, '\`\`\`chart') > 0) order by updated_at desc limit 300`, ...filter.params,
    );
    return rows.filter((r) => !spaces || spaces.includes(r.space_id)).map((r) => {
      const path = r.uri.replace(/^work\//, "");
      const kind = /数据源目录/.test(path) ? "catalog" : /^观测\//.test(path) ? "plan" : /^数据\/报表\//.test(path) || r.charts ? "report" : "note";
      return { id: r.id, title: r.title, path, kind, charts: !!r.charts, spaceId: r.space_id, itemId: json<{ links?: { item?: string } }>(r.meta, {}).links?.item ?? null, updatedAt: r.updated_at };
    }).filter((f) => !under || (f.itemId !== null && under.has(f.itemId)));
  });

  server.get("/api/metrics/:id", async (req) => {
    const m = requireMetric(app, (req.params as { id: string }).id);
    const spaces = readable(req);
    if (spaces && !spaces.includes(m.spaceId)) throw new HttpError(404, "没有这个指标");
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query ?? {});
    return readMetric(app, m.id, { days: q.days });
  });

  // Keep (status active), drop (dropped, with an optional word why), pause, or change what it is and how it is drawn.
  server.put("/api/metrics/:id", async (req) => {
    const m = requireMetric(app, (req.params as { id: string }).id);
    if (!canWrite(app, who(req), m.spaceId)) throw new HttpError(403, "不能改这个指标");
    const b = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      unit: z.string().trim().max(20).optional(),
      why: z.string().trim().max(300).optional(),
      description: z.string().max(2000).optional(),
      schedule: z.enum(["none", "hourly", "daily", "weekly"]).optional(),
      threshold: z.number().min(0.01).max(10).optional(),
      baseline: z.number().finite().nullable().optional(),
      direction: z.enum(["up-good", "down-good", "neutral"]).optional(),
      status: z.enum(["active", "paused", "dropped"]).optional(),
      view: metricViewSchema.nullable().optional(),
      note: z.string().trim().max(300).optional(),
    }).safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, `参数错误：${b.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
    const { note, name, ...rest } = b.data;
    return defineMetric(app, { id: m.id, name: name ?? m.name, ...rest, ...(note !== undefined ? { ownerNote: note } : {}) }, { by: "owner" });
  });
}
