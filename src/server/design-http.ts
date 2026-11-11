import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { findSpace } from "../core/spaces.ts";
import { accessibleSpaces, canWrite, OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { designChanges, designDiff } from "../designs/changes.ts";
import { decideDesign, designRevisions, designSummary, getDesign, listDesigns, setConcernState, type Design } from "../designs/store.ts";
import { CONCERN_STATES } from "../designs/types.ts";

/**
 * Designs over HTTP (docs/v2/coding-plan.md §6.4): list and read them in the spaces the person may
 * read; start an assessment of someone else's design; the owner's (or a writer's) confirmation of an
 * own design and the state of a concern.
 */
export function registerDesignRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
    const r = schema.safeParse(value ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  };
  const visible = (req: FastifyRequest, id: string): Design => {
    const d = getDesign(app, id);
    const allowed = accessibleSpaces(app, who(req));
    if (allowed && !allowed.includes(d.spaceId)) throw new HttpError(404, `没有方案 ${id}`);
    return d;
  };
  const writable = (req: FastifyRequest, d: Design) => {
    const user = who(req);
    if (user !== OWNER && !canWrite(app, user, d.spaceId)) throw new HttpError(403, "只有本人或能修改这个空间的人可以确认方案、标意见");
  };

  server.get("/api/designs", async (req) => {
    const o = parse(z.object({ item: z.string().optional(), space: z.string().optional(), work: z.string().optional(), limit: z.coerce.number().optional() }), req.query);
    return { designs: listDesigns(app, { item: o.item, space: o.space, work: o.work, spaces: accessibleSpaces(app, who(req)), limit: o.limit }) };
  });

  server.get("/api/designs/:id", async (req) => {
    const o = parse(z.object({ revision: z.coerce.number().int().min(1).optional() }), req.query);
    const d = visible(req, (req.params as { id: string }).id);
    const { designBodyAt } = await import("../designs/store.ts");
    const body = designBodyAt(app, d, o.revision);
    const shown = { ...d, body };
    const item = d.itemId ? one<{ id: string; title: string }>(app.db, "select id, title from items where id = ?", d.itemId) ?? null : null;
    const reqs = d.itemId
      ? all<{ id: string; title: string; kind: string }>(app.db, "select n.id, n.title, n.kind from item_materials m join req_nodes n on n.id = m.ref where m.kind = 'req' and n.status = 'active' and m.item_id = ? order by m.id", d.itemId)
      : [];
    const workRow = d.workId ? one<{ id: string; title: string; branches: string | null }>(app.db, "select id, title, json_extract(input, '$.branches') branches from runs where id = ?", d.workId) : undefined;
    const work = workRow ? { rootId: workRow.id, title: workRow.title, branchReview: !!workRow.branches } : null;
    const { changes, outside } = await designChanges(app, shown);
    return {
      ...designSummary(shown),
      revision: o.revision ?? d.revision,
      sources: d.sources, repos: d.repos, body,
      revisions: designRevisions(app, d.id).map((r) => ({ revision: r.revision, at: r.at, note: r.note, runId: r.runId })),
      item, reqs, work, changes, outside,
      // The run writing or assessing it now, else the one that wrote the current version.
      runId: one<{ id: string }>(app.db, "select id from runs where status in ('queued', 'running') and json_extract(input, '$.designId') = ? order by created_at desc limit 1", d.id)?.id ?? d.runId,
    };
  });

  server.get("/api/designs/:id/diff", async (req) => {
    const o = parse(z.object({ decision: z.string().min(1) }), req.query);
    return await designDiff(app, visible(req, (req.params as { id: string }).id), o.decision);
  });

  server.post("/api/designs", async (req) => {
    const b = parse(z.object({
      title: z.string().min(1).max(200), sources: z.array(z.string().min(1)).min(1).max(10), repos: z.array(z.string()).max(10).default([]),
      itemId: z.string().optional(), space: z.string().optional(), author: z.string().max(80).optional(), note: z.string().max(4000).optional(),
      /** Assess this external design again (its document changed): a new version of the same design. */
      designId: z.string().optional(),
    }), req.body);
    const user = who(req);
    const allowed = accessibleSpaces(app, user);
    const readable = (id: string) => {
      if (!findSpace(app, id) || (allowed && !allowed.includes(id))) throw new HttpError(404, `没有空间 ${id}`);
      return id;
    };
    const item = b.itemId ? getItem(app, b.itemId) : null;
    if (item && item.userId !== user) throw new HttpError(403, "只能用自己的事项");
    const again = b.designId ? visible(req, b.designId) : null;
    const target = readable(again?.spaceId ?? b.space ?? item?.spaceId ?? "personal");
    if (!canWrite(app, user, target) || findSpace(app, target)!.kind === "worktree") throw new HttpError(403, `无权修改空间 ${target}`);
    const repos = [...new Set(b.repos.map(readable))];
    const { resolveDesignSources, startAssessment } = await import("../designs/assess.ts");
    const sources = await resolveDesignSources(app, b.sources, { userId: user, spaces: allowed });
    const { design, run } = startAssessment(app, { title: b.title, sources, repos, spaceId: target, userId: user, itemId: item?.id ?? again?.itemId, author: b.author, note: b.note, designId: again?.id, readable: allowed });
    return { id: design.id, runId: run.id };
  });

  server.post("/api/designs/:id/decide", async (req) => {
    const b = parse(z.object({ action: z.enum(["approve", "comment", "rethink"]), text: z.string().max(4000).optional(), answers: z.record(z.string(), z.string().max(1000)).optional() }), req.body);
    const d = visible(req, (req.params as { id: string }).id);
    writable(req, d);
    const user = who(req);
    return designSummary(decideDesign(app, d.id, { action: b.action, text: b.text, answers: b.answers, by: user === OWNER ? "owner" : user }));
  });

  server.post("/api/designs/:id/concerns/:cid", async (req) => {
    const b = parse(z.object({ state: z.enum(CONCERN_STATES), note: z.string().max(1000).optional() }), req.body);
    const p = req.params as { id: string; cid: string };
    const d = visible(req, p.id);
    writable(req, d);
    const user = who(req);
    return designSummary(setConcernState(app, d.id, p.cid, { state: b.state, note: b.note, by: user === OWNER ? "owner" : user }));
  });
}
