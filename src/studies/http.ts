import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { HttpError } from "../core/util.ts";
import { requireItem } from "../items/access.ts";
import { studyOperation } from "../flows/engine.ts";
import { closeDirection, direction, setFindingState } from "./store.ts";
import { chooseDirection, studyView } from "./service.ts";
import { putScope, scopeView } from "./scope.ts";
import { fixFinding } from "./fix.ts";
import { cancelTrials } from "./trials.ts";
import { registerPeerTrialRoutes } from "./remote-host.ts";

export function registerStudyRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  // Trials another of the owner's devices hands to this one (remote-host.ts).
  registerPeerTrialRoutes(server, app, who);
  const itemId = (req: FastifyRequest, write: boolean) =>
    requireItem(app, (req.params as { id: string }).id, who(req), write ? "write" : "read").id;
  server.get("/api/items/:id/study", async (req) => studyView(app, itemId(req, false)));
  server.get("/api/items/:id/study/scope", async (req) => scopeView(app, itemId(req, false)));
  server.put("/api/items/:id/study/scope", async (req) => {
    const id = itemId(req, true), b = z.object({ repos: z.array(z.string()).max(100).optional(), allowCode: z.boolean().optional(), thirdParty: z.boolean().optional(), pushRemote: z.string().max(100).optional(), pushPrefix: z.string().max(200).optional() }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, "范围字段不对");
    return studyOperation(app, id, async () => {
      const view = putScope(app, id, b.data, who(req));
      if (b.data.repos || b.data.thirdParty === false) await cancelTrials(app, id, "研究范围已调整，当前试验停止，按新的范围重新定方向");
      return view;
    });
  });
  server.post("/api/items/:id/study/findings/:finding/fix", async (req) => {
    const id = itemId(req, true), b = z.object({ note: z.string().max(4000).optional() }).safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, "修改要求不对");
    await studyOperation(app, id, async () => fixFinding(app, id, (req.params as { finding: string }).finding, b.data.note, who(req)));
    return studyView(app, id);
  });
  // The owner's pick of this round's direction, made on the item page instead of the card.
  server.post("/api/items/:id/study/choose", async (req) => {
    const id = itemId(req, true), b = z.object({ direction: z.string().nullable(), note: z.string().max(2000).optional(), allowCode: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, "要给出选哪个方向；这一轮不跑时 direction 填 null");
    await chooseDirection(app, id, b.data.direction, b.data.note, who(req), b.data.allowCode);
    return studyView(app, id);
  });
  server.post("/api/items/:id/study/findings/:finding", async (req) => {
    const id = itemId(req, true), b = z.object({ state: z.enum(["confirmed", "rejected", "later", "fixed"]), reason: z.string().max(4000).optional() }).safeParse(req.body);
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
