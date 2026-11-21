import { itemScope } from "../items/access.ts";
import { spacesWithCapability } from "../auth/capabilities.ts";
import { restrictedSourceFilter } from "../auth/visibility.ts";
import { itemAccess, requireItem } from "../items/access.ts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { canWrite, OWNER } from "../core/users.ts";
import { all, one, tx } from "../core/db.ts";
import { HttpError, json } from "../core/util.ts";
import { metricProviders } from "../plugins/process-hooks.ts";
import { getItem } from "../items/store.ts";
import { visibleBranchIds } from "../items/member-work.ts";
import { rootOf } from "../items/tree.ts";
import { changeOf, defineMetric, latestOf, listMetrics, metricPoints, metricTable, metricViewSchema, nextTake, readMetric, requireMetric, tileSeries } from "./metrics.ts";

/**
 * Metrics on the web: the list (an item's and those under it, a 关注's, or all one may read), one metric
 * with its points and the charts its view draws, the work files behind them (catalog, observation plans,
 * collection notes, reports), and a person keeping, changing or dropping a metric. Background collection is in
 * src/data/metrics.ts.
 */
export function registerMetricRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const readable = (req: FastifyRequest) => spacesWithCapability(app, who(req), "metrics.view");
  const visibleBranch = (id: string, req: FastifyRequest) => {
    const user = who(req);
    return visibleBranchIds(app, requireItem(app, id, user, "read"), user);
  };
  server.get("/api/metrics/providers", async (req) => {
    const spaces = readable(req);
    return [...metricProviders].filter(([, entry]) => !entry.spaces.length || !spaces || entry.spaces.some(id => spaces.includes(id)))
      .map(([id, { def }]) => ({ id, label: def.label, querySchema: z.toJSONSchema(def.querySchema, { io: "input" }) }));
  });

  server.get("/api/metrics", async (req) => {
    const q = z.object({ item: z.string().optional(), context: z.string().optional(), source: z.string().optional(), dropped: z.string().optional() }).parse(req.query ?? {});
    // An item's metrics are its own and those of the items under it (a line shows its requirements').
    const itemIds = q.item ? visibleBranch(q.item, req) : undefined;
    const root = q.item ? getItem(app, rootOf(app, q.item)) : null;
    const visibleRoot = root && itemAccess(app, who(req), root, "read") ? root.id : null;
    const list = listMetrics(app, { itemIds, contextId: q.context, spaces: readable(req), includeDropped: q.dropped === "1" }).filter((m) => !q.source || m.source === q.source);
    const scope = itemScope(app, who(req));
    const items = new Map(all<{ id: string; title: string }>(app.db, `with recursive ancestors(id) as (
      select value from json_each(?) union select i.parent_id from items i join ancestors a on a.id=i.id where i.parent_id is not null
    ) select id,title from items where id in (select id from ancestors)
      and (? is null or space_id in (select value from json_each(?)))
      and (? is null or user_id=? or space_id in (select value from json_each(?)))`,
      JSON.stringify(list.map(m => m.itemId).filter(Boolean)), scope.spaceIds ? 1 : null, JSON.stringify(scope.spaceIds ?? []),
      scope.userId ?? null, scope.userId ?? null, JSON.stringify(scope.sharedSpaces ?? [])).map(r => [r.id, r.title]));
    const planId = (ref: string | null) => ref?.match(/^src:([\w-]+)/)?.[1] ?? "";
    const sourceSpaces = spacesWithCapability(app, who(req), "sources.view");
    const filter = restrictedSourceFilter(app, who(req));
    const plans = new Map(all<{ id: string; title: string }>(app.db, `select id,title from sources where id in (select value from json_each(?))
      and deleted_at is null and ${filter.sql} and (? is null or space_id in (select value from json_each(?)))
      and (?='owner' or kind!='doc' or json_extract(meta,'$.documentId') is null or not exists (
        select 1 from spaces s where s.id=sources.space_id and json_extract(s.settings,'$.larkAccess'))
        or exists(select 1 from source_access a where a.user_id=? and a.source_id=sources.id and a.allowed=1 and a.checked_at>?))`,
      JSON.stringify(list.map(m => planId(m.planRef))), ...filter.params, sourceSpaces ? 1 : null, JSON.stringify(sourceSpaces ?? []),
      who(req), who(req), new Date(Date.now() - 86400000).toISOString()).map(row => [row.id, row]));
    // The last six weeks of points, enough for a tile's course however many ways a metric is split.
    const since = new Date(Date.now() - 42 * 86400_000).toISOString();
    return list.map((m) => {
      const pts = metricPoints(app, m.id, { since, limit: 4000 });
      const fig = tileSeries(m, pts);
      // Which matter, and which work line above it, the metric watches: the data page groups by the line.
      const line = q.item ? visibleRoot : m.itemId ? rootOf(app, m.itemId) : null;
      return {
        ...m, change: changeOf(m, fig.values.map((value) => ({ value }))), spark: fig.values.slice(-30), figure: fig.name, groups: fig.groups, latest: latestOf(metricTable(m, pts)), points: pts.length, nextAt: nextTake(m),
        plan: plans.get(planId(m.planRef)) ?? null, itemTitle: items.get(m.itemId ?? "") ?? null, lineId: line && items.has(line) ? line : null, lineTitle: items.get(line ?? "") ?? null,
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
    const filter = restrictedSourceFilter(app, who(req));
    const sources = spacesWithCapability(app, who(req), "sources.view");
    const allowed = spaces?.filter(id => !sources || sources.includes(id));
    const rows = all<{ id: string; title: string; uri: string; space_id: string; meta: string; updated_at: string; charts: number }>(
      app.db,
      `select id, title, uri, space_id, meta, updated_at, instr(text, '\`\`\`chart') > 0 charts from sources
       where kind = 'work' and deleted_at is null and ${filter.sql} ${allowed ? "and space_id in (select value from json_each(?))" : ""} and (uri like 'work/数据/%' or uri like 'work/观测/%' or instr(text, '\`\`\`chart') > 0) order by updated_at desc limit 300`, ...filter.params, ...(allowed ? [JSON.stringify(allowed)] : []),
    );
    return rows.map((r) => {
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

  // Several proposals decided at once (a group, or all of them): kept, or dropped with an optional word why.
  // All or nothing: a metric one may not change stops the batch before any write.
  server.post("/api/metrics/decide", async (req) => {
    const b = z.object({ ids: z.array(z.string().min(1)).min(1).max(200), status: z.enum(["active", "dropped"]), note: z.string().trim().max(300).optional() }).safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, `参数错误：${b.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
    const ms = [...new Set(b.data.ids)].map((id) => requireMetric(app, id));
    const spaces = readable(req);
    for (const m of ms) {
      if (spaces && !spaces.includes(m.spaceId)) throw new HttpError(404, "没有这个指标");
      if (!canWrite(app, who(req), m.spaceId)) throw new HttpError(403, `不能改指标「${m.name}」`);
    }
    const done = tx(app.db, () => ms.map((m) => defineMetric(app, { id: m.id, name: m.name, status: b.data.status, ...(b.data.note ? { ownerNote: b.data.note } : {}) }, { by: "owner" })));
    return { changed: done.map((m) => ({ id: m.id, status: m.status })) };
  });

  // Keep (status active), drop (dropped, with an optional word why), pause, or change what it is and how it is drawn.
  server.put("/api/metrics/:id", async (req) => {
    const m = requireMetric(app, (req.params as { id: string }).id);
    if (!canWrite(app, who(req), m.spaceId)) throw new HttpError(403, "不能改这个指标");
    const b = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      providerId: z.string().min(1).nullable().optional(),
      providerQuery: z.unknown().optional(),
      query: z.string().max(4000).optional(),
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
    // The fallback collection agent runs as the owner.
    if (b.data.query !== undefined && who(req) !== OWNER) throw new HttpError(403, "只有本人能修改 Agent 的采集指令");
    const { note, name, ...rest } = b.data;
    return defineMetric(app, { id: m.id, name: name ?? m.name, ...rest, ...(note !== undefined ? { ownerNote: note } : {}) }, { by: "owner", userId: who(req) });
  });
}
