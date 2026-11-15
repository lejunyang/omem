import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { can } from "../auth/permissions.ts";
import { canWrite } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { listFlows, parseFlow, removeFlow, saveFlow } from "./definitions.ts";
import { flowView, ownerAction, startFlow, stopFlow, type OwnerAction } from "./engine.ts";

function body<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, `参数不对：${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
  return r.data;
}
export function registerFlowRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  const itemId = (req: FastifyRequest, write: boolean) => {
    const { id } = req.params as { id: string };
    const item = getItem(app, id), userId = who(req);
    if (!can(app, userId, "space.read", item.spaceId)) throw new HttpError(404, "事项不存在");
    if (write && (item.userId !== userId || !canWrite(app, userId, item.spaceId))) throw new HttpError(403, "只有事项本人能修改流程");
    return id;
  };
  server.get("/api/flows", async () => ({ flows: listFlows(app) }));
  server.put("/api/flows/:id", async (req) => {
    const raw = typeof req.body === "string" ? req.body : body(z.object({ yaml: z.string().max(60000) }), req.body).yaml;
    if (parseFlow(raw).id !== (req.params as { id: string }).id) throw new HttpError(400, "路径 id 必须与流程定义 id 相同");
    return saveFlow(app, raw, "owner");
  });
  server.delete("/api/flows/:id", async (req) => { removeFlow(app, (req.params as { id: string }).id, "owner"); return { ok: true }; });
  server.get("/api/items/:id/flow", async (req) => flowView(app, itemId(req, false)));
  server.post("/api/items/:id/flow", async (req) => startFlow(app, itemId(req, true), body(z.object({ flow: z.string() }), req.body).flow, { actor: "owner", userId: who(req) }));
  server.delete("/api/items/:id/flow", async (req) => stopFlow(app, itemId(req, true), who(req)));
  for (const action of ["confirm", "hold", "skip", "done", "reopen"] as OwnerAction[]) server.post(`/api/items/:id/flow/stages/:stage/${action}`, async (req) => {
    const id = itemId(req, true), { stage } = req.params as { stage: string };
    const b = body(z.object({ note: z.string().max(4000).optional() }), req.body ?? {});
    return ownerAction(app, id, stage, action, b.note, who(req));
  });
}
