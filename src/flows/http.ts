import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "../core/app.ts";
import { can } from "../auth/permissions.ts";
import { accessibleSpaces, canWrite } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { getItem } from "../items/store.ts";
import { listFlows, parseFlow, removeFlow, saveFlow, describeStage, describeFlow, budgetSchema } from "./definitions.ts";
import { flowView, ownerAction, recordStage, signStageTest, startFlow, startRound, stopFlow, updateStageBudget, type OwnerAction } from "./engine.ts";
import { itemStages } from "./store.ts";
import { settleChange } from "./follow.ts";
import { all } from "../core/db.ts";
import { gateGrants, revokeGate } from "./gates.ts";

type CurrentStage = { item_id: string; title: string; space_id: string; user_id: string; due_at: string | null; flow_id: string; flow_name: string; round: number; stage_id: string; name: string; state: string; by: string | null; waiting_on: string | null; since: string };
/** Shared selection for lists and the board: owner/blocked, doing, then the next pending/stale stage. */
function currentStages(app: App, scope: { ids?: string[]; spaces?: string[] | null }) {
  return all<CurrentStage>(app.db, `
    select * from (select f.item_id, i.title, i.space_id, coalesce(i.user_id,'owner') user_id, i.due_at,
      f.flow_id, json_extract(f.definition,'$.name') flow_name, f.round,
      s.stage_id, json_extract(d.value, '$.name') name, s.state, s."by", s.waiting_on, s.since,
      row_number() over (partition by f.item_id order by case
        when s.state in ('gated','blocked') or s.waiting_on='owner' or s.state='doing' and s."by"='owner' then 0
        when s.state='doing' then 1 else 2 end, cast(d.key as integer)) position
    from item_flows f join items i on i.id=f.item_id join item_stages s on s.item_id=f.item_id
    join json_each(f.definition, '$.stages') d on json_extract(d.value, '$.id')=s.stage_id
    where f.ended_at is null
      ${scope.ids ? "and f.item_id in (select value from json_each(?))" : ""}
      ${scope.spaces ? "and i.space_id in (select value from json_each(?))" : ""}
      and s.state in ('gated','doing','blocked','stale','pending')
    ) where position=1 order by since,item_id`, ...(scope.ids ? [JSON.stringify(scope.ids)] : []), ...(scope.spaces ? [JSON.stringify(scope.spaces)] : []));
}
const waitsForOwner = (r: CurrentStage) => r.state === "gated" || r.state === "doing" && r.by === "owner" || r.waiting_on === "owner";
/** One bounded query for the already permission-filtered item list; never loads flow bodies. */
export function itemFlowSummaries(app: App, ids: string[]) {
  const result = new Map<string, { stage: string; name: string; waiting: boolean }>();
  if (!ids.length) return result;
  for (const r of currentStages(app, { ids })) result.set(r.item_id, { stage: r.stage_id, name: r.name, waiting: waitsForOwner(r) });
  return result;
}
export function flowBoard(app: App, userId: string, only?: "mine" | "blocked") {
  return currentStages(app, { spaces: accessibleSpaces(app, userId) }).filter((r) => only === "mine" ? r.user_id === userId && waitsForOwner(r) : only === "blocked" ? r.state === "blocked" : true).map((r) => ({
    itemId: r.item_id, title: r.title, spaceId: r.space_id, flowId: r.flow_id, flowName: r.flow_name, round: r.round,
    stage: { id: r.stage_id, name: r.name, state: r.state }, waiting: waitsForOwner(r) ? "owner" as const : r.state === "blocked" ? "blocked" as const : null,
    since: r.since, stale: Date.now() - Date.parse(r.since) > app.config.flows.staleDays * 86400000, dueAt: r.due_at,
  }));
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
  // drafts: definitions the assistant wrote up (save_flow) still waiting for the owner's 启用 / 不用.
  server.get("/api/flows", async (req) => {
    const userId = who(req);
    const drafts = all<{ id: string; context: string; created_at: string; conversation_id: string | null }>(
      app.db, "select id, context, created_at, conversation_id from asks where status = 'pending' and user_id = ? and json_extract(context, '$.handler') = 'flow-save' order by created_at desc limit 20", userId,
    ).flatMap((a) => {
      try {
        const raw = String((JSON.parse(a.context) as { raw?: unknown }).raw ?? "");
        const f = parseFlow(raw);
        return [{ askId: a.id, conversationId: a.conversation_id, createdAt: a.created_at, id: f.id, name: f.name, description: f.description ?? "", stages: f.stages.length, replaces: listFlows(app).some((x) => x.id === f.id) }];
      } catch {
        return [];
      }
    });
    return { flows: listFlows(app).map((f) => ({ ...f, grants: gateGrants(app, f.id, userId) })), drafts };
  });
  server.get("/api/flows/board", async (req) => {
    const { only } = body(z.object({ only: z.enum(["mine", "blocked"]).optional() }), req.query);
    return flowBoard(app, who(req), only);
  });
  server.delete("/api/flows/:id/gates/:stage", async (req) => {
    const { id, stage } = req.params as { id: string; stage: string };
    revokeGate(app, id, stage, who(req));
    return { ok: true };
  });
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
  server.post("/api/items/:id/flow/stages/:stage/record", async (req) => {
    const id = itemId(req, true), { stage } = req.params as { stage: string };
    const b = body(z.object({ note: z.string().trim().min(1).max(4000), refs: z.array(z.string()).max(100).optional() }), req.body);
    return view(app, id, await recordStage(app, id, stage, b.note, b.refs, who(req)));
  });
  server.post("/api/items/:id/flow/stages/:stage/tests/:test", async (req) => {
    const id = itemId(req, true), { stage, test } = req.params as { stage: string; test: string };
    const b = body(z.object({ verdict: z.enum(["ok", "wrong"]).nullable(), note: z.string().max(4000).optional() }), req.body);
    return view(app, id, await signStageTest(app, id, stage, test, b.verdict, b.note, who(req)));
  });
  for (const action of ["confirm", "hold", "skip", "done", "reopen"] as OwnerAction[]) server.post(`/api/items/:id/flow/stages/:stage/${action}`, async (req) => {
    const id = itemId(req, true), { stage } = req.params as { stage: string };
    const b = body(z.object({ note: z.string().max(4000).optional() }), req.body ?? {});
    return view(app, id, await ownerAction(app, id, stage, action, b.note, who(req)));
  });
}
