import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { accessibleSpaces, canWrite } from "../core/users.ts";
import { all, one } from "../core/db.ts";
import { HttpError, json } from "../core/util.ts";
import { rootOf } from "../items/tree.ts";
import { changeOf, defineMetric, listMetrics, metricPoints, readMetric, requireMetric } from "./metrics.ts";

/**
 * Metrics on the web: the list (an item's, a 关注's, or all one may read), one metric with its points and
 * chart, and the owner editing a metric's schedule, threshold or status. Reading the systems stays the
 * agents' (src/data/metrics.ts).
 */
export function registerMetricRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const readable = (req: FastifyRequest) => accessibleSpaces(app, who(req));

  server.get("/api/metrics", async (req) => {
    const q = z.object({ item: z.string().optional(), context: z.string().optional(), source: z.string().optional() }).parse(req.query ?? {});
    const list = listMetrics(app, { itemId: q.item, contextId: q.context, spaces: readable(req) }).filter((m) => !q.source || m.source === q.source);
    const title = (id: string) => one<{ title: string }>(app.db, "select title from items where id = ?", id)?.title ?? null;
    return list.map((m) => {
      const pts = metricPoints(app, m.id, { limit: 60 });
      const lastDims = pts.at(-1)?.dims;
      const series = pts.filter((p) => JSON.stringify(p.dims) === JSON.stringify(lastDims));
      // Which matter, and which work line above it, the metric watches: the data page groups by the line.
      const line = m.itemId ? rootOf(app, m.itemId) : null;
      return { ...m, change: changeOf(m, series), spark: series.slice(-30).map((p) => p.value), points: pts.length, itemTitle: m.itemId ? title(m.itemId) : null, lineId: line, lineTitle: line ? title(line) : null };
    });
  });

  // The work files behind the metrics: the data-source catalog, observation plans and collection notes
  // (paths under 数据/ or 观测/, as the built-in skills data-sources and observation-plan write them).
  server.get("/api/metrics/files", async (req) => {
    const spaces = readable(req);
    const rows = all<{ id: string; title: string; uri: string; space_id: string; meta: string; updated_at: string }>(
      app.db,
      "select id, title, uri, space_id, meta, updated_at from sources where kind = 'work' and deleted_at is null and (uri like 'work/数据/%' or uri like 'work/观测/%') order by updated_at desc limit 300",
    );
    return rows.filter((r) => !spaces || spaces.includes(r.space_id)).map((r) => {
      const path = r.uri.replace(/^work\//, "");
      const kind = /数据源目录/.test(path) ? "catalog" : /观测/.test(path) ? "plan" : "note";
      return { id: r.id, title: r.title, path, kind, spaceId: r.space_id, itemId: json<{ links?: { item?: string } }>(r.meta, {}).links?.item ?? null, updatedAt: r.updated_at };
    });
  });

  server.get("/api/metrics/:id", async (req) => {
    const m = requireMetric(app, (req.params as { id: string }).id);
    const spaces = readable(req);
    if (spaces && !spaces.includes(m.spaceId)) throw new HttpError(404, "没有这个指标");
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query ?? {});
    return readMetric(app, m.id, { days: q.days });
  });

  server.put("/api/metrics/:id", async (req) => {
    const m = requireMetric(app, (req.params as { id: string }).id);
    if (!canWrite(app, who(req), m.spaceId)) throw new HttpError(403, "不能改这个指标");
    const b = z.object({ schedule: z.enum(["none", "hourly", "daily", "weekly"]).optional(), threshold: z.number().min(0.01).max(10).optional(), direction: z.enum(["up-good", "down-good", "neutral"]).optional(), status: z.enum(["active", "paused"]).optional(), description: z.string().max(2000).optional() }).safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, "参数错误");
    return defineMetric(app, { id: m.id, name: m.name, ...b.data });
  });
}
