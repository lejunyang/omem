import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { can } from "../auth/permissions.ts";
import { canWrite } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { listFlows, parseFlow, removeFlow, saveFlow, describeStage, describeFlow, budgetSchema } from "./definitions.ts";
import { flowView, ownerAction, startFlow, startRound, stopFlow, updateStageBudget, type OwnerAction } from "./engine.ts";
import { itemStages } from "./store.ts";
import { settleChange } from "./follow.ts";
import { all } from "../core/db.ts";

/** One bounded query for the already permission-filtered item list; never loads flow bodies. */
export function itemFlowSummaries(app: App, ids: string[]) {
  if (!ids.length) return new Map<string, { stage: string; name: string; waiting: boolean }>();
  const rows = all<{ item_id: string; stage_id: string; name: string; state: string; by: string | null; waiting_on: string | null }>(app.db, `
    select * from (select f.item_id, s.stage_id, json_extract(d.value, '$.name') name, s.state, s."by", s.waiting_on,
      row_number() over (partition by f.item_id order by case when s.state in ('gated','blocked') or s.waiting_on='owner' then 0 else 1 end, cast(d.key as integer)) position
    from item_flows f join item_stages s on s.item_id=f.item_id
    join json_each(f.definition, '$.stages') d on json_extract(d.value, '$.id')=s.stage_id
    where f.ended_at is null and f.item_id in (${ids.map(() => "?").join(",")})
      and s.state in ('gated','doing','blocked','stale')
    ) where position=1`, ...ids);
  const result = new Map<string, { stage: string; name: string; waiting: boolean }>();
  for (const r of rows) if (!result.has(r.item_id)) result.set(r.item_id, { stage: r.stage_id, name: r.name, waiting: r.state === "gated" || r.by === "owner" || r.waiting_on === "owner" });
  return result;
}

/** The engine's question kind is needed to distinguish an entry gate from completion approval. */
function view(app: App, id: string, payload = flowView(app, id)) {
  const rows = itemStages(app, id);
  return { ...payload, stages: payload.stages.map((s) => ({ ...s, question: rows.find((r) => r.id === s.id)?.control.question ?? null })) };
}

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
  server.post("/api/flows/validate", async (req) => {
    const raw = body(z.object({ yaml: z.string().max(60000) }), req.body).yaml;
    try {
      const f = parseFlow(raw);
      return { ok: true, id: f.id, name: f.name, description: f.description, repeat: f.repeat ?? null, repeatDescription: describeFlow(f), stages: f.stages.map((s) => ({ id: s.id, name: s.name, ...describeStage(s), needs: s.needs })) };
    } catch (e) { return { ok: false, problem: (e as Error).message }; }
  });
  server.put("/api/flows/:id", async (req) => {
    const raw = typeof req.body === "string" ? req.body : body(z.object({ yaml: z.string().max(60000) }), req.body).yaml;
    if (parseFlow(raw).id !== (req.params as { id: string }).id) throw new HttpError(400, "路径 id 必须与流程定义 id 相同");
    return saveFlow(app, raw, "owner");
  });
  server.delete("/api/flows/:id", async (req) => { removeFlow(app, (req.params as { id: string }).id, "owner"); return { ok: true }; });
  server.get("/api/items/:id/flow", async (req) => view(app, itemId(req, false)));
  server.post("/api/items/:id/flow", async (req) => { const id = itemId(req, true); return view(app, id, await startFlow(app, id, body(z.object({ flow: z.string() }), req.body).flow, { actor: "owner", userId: who(req) })); });
  server.delete("/api/items/:id/flow", async (req) => { const id = itemId(req, true); return view(app, id, await stopFlow(app, id, who(req))); });
  server.post("/api/items/:id/flow/round", async (req) => {
    const id = itemId(req, true);
    return view(app, id, await startRound(app, id, { actor: "owner", userId: who(req) }));
  });
  // The owner settles one change the follow-up found: fold it in, make it its own item, or leave it.
  server.post("/api/items/:id/flow/changes/:change", async (req) => {
    const id = itemId(req, true), b = body(z.object({ choice: z.enum(["merge", "split", "dismiss"]) }), req.body);
    await settleChange(app, id, (req.params as { change: string }).change, b.choice, who(req));
    return view(app, id);
  });
  server.post("/api/items/:id/flow/stages/:stage/budget", async (req) => {
    const id = itemId(req, true), { stage } = req.params as { stage: string };
    const patch = body(z.object({ budget: budgetSchema.optional(), escalate: z.object({ max: z.number().int().min(0).max(100) }).strict().optional() }).strict(), req.body);
    return view(app, id, await updateStageBudget(app, id, stage, patch, who(req)));
  });
  for (const action of ["confirm", "hold", "skip", "done", "reopen"] as OwnerAction[]) server.post(`/api/items/:id/flow/stages/:stage/${action}`, async (req) => {
    const id = itemId(req, true), { stage } = req.params as { stage: string };
    const b = body(z.object({ note: z.string().max(4000).optional() }), req.body ?? {});
    return view(app, id, await ownerAction(app, id, stage, action, b.note, who(req)));
  });
}
