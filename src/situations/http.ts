import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { OWNER } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { findItem, itemEvents } from "../items/store.ts";
import { finishSituation, listSituations, requireInstance, startSituation } from "./instances.ts";

export function registerSituationRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  function owner(req: FastifyRequest) {
    const user = who(req);
    if (user !== OWNER) throw new HttpError(403, "只有本人可以管理自己的持续跟进");
    return user;
  }
  function parse<T>(s: z.ZodType<T>, body: unknown) {
    const r = s.safeParse(body ?? {});
    if (!r.success) throw new HttpError(400, r.error.issues.map(i => `${i.path.join(".")}：${i.message}`).join("；"));
    return r.data;
  }
  const id = (req: FastifyRequest) => (req.params as { id: string }).id;
  server.get("/api/situation-instances", async req => {
    const userId = owner(req);
    return listSituations(app, userId, parse(z.object({ contextId: z.string().optional(), status: z.enum(["active", "ended"]).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), req.query));
  });
  server.get("/api/situation-instances/:id", async req => {
    const instance = requireInstance(app, owner(req), id(req));
    return { instance, item: findItem(app, instance.itemId) ?? null, events: itemEvents(app, instance.itemId) };
  });
  server.post("/api/listen/:id/start", async req => {
    const userId = owner(req);
    const b = parse(z.object({ about: z.string().trim().min(1).max(2000) }), req.body);
    return startSituation(app, userId, id(req), b.about);
  });
  server.post("/api/situation-instances/:id/end", async req => {
    const userId = owner(req);
    const b = parse(z.object({ summary: z.string().trim().min(1).max(3000).optional() }), req.body);
    return finishSituation(app, userId, id(req), b.summary);
  });
}
