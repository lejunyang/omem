import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { can } from "../auth/permissions.ts";
import { canWrite } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { studyOperation } from "../flows/engine.ts";
import { closeDirection, direction, setFindingState } from "./store.ts";
import { studyView } from "./service.ts";

export function registerStudyRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const itemId = (req: FastifyRequest, write: boolean) => {
    const item = getItem(app, (req.params as { id: string }).id), user = who(req);
    if (!can(app, user, "space.read", item.spaceId)) throw new HttpError(404, "事项不存在");
    if (write && (item.userId !== user || !canWrite(app, user, item.spaceId))) throw new HttpError(403, "只有事项本人能修改课题");
    return item.id;
  };
  server.get("/api/items/:id/study", async (req) => studyView(app, itemId(req, false)));
  server.post("/api/items/:id/study/findings/:finding", async (req) => {
    const id = itemId(req, true), b = z.object({ state: z.enum(["confirmed", "rejected", "later"]), reason: z.string().max(4000).optional() }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, "发现的状态或原因不对");
    await studyOperation(app, id, async () => setFindingState(app, id, (req.params as { finding: string }).finding, b.data.state, b.data.reason));
    return studyView(app, id);
  });
  server.post("/api/items/:id/study/directions/:direction/close", async (req) => {
    const id = itemId(req, true), d = (req.params as { direction: string }).direction;
    const b = z.object({ state: z.enum(["done", "dropped"]), conclusion: z.string().trim().min(1).max(12000) }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, "结束方向需要状态和结论");
    if (direction(app, d).item_id !== id) throw new HttpError(404, "没有这个方向");
    await studyOperation(app, id, async () => closeDirection(app, d, b.data.state, b.data.conclusion));
    return studyView(app, id);
  });
}
