import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { changeLongTask, getLongTask, longTaskCommandSchema, startLongTask, startLongTaskSchema } from "../agents/long-tasks.ts";
import { supervisorFacts, supervisorUsage } from "../agents/supervisor.ts";
import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { personalSpaceId } from "../core/users.ts";
import { HttpError } from "../core/util.ts";
import { itemAccess, itemScope } from "../items/access.ts";
import { itemEvents } from "../items/store.ts";

const createBody = startLongTaskSchema.omit({ spaceId: true }).extend({ space: z.string().min(1).optional() });
const listQuery = z.object({
  space: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export function registerLongTaskRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => string) {
  server.get("/api/long-tasks", async req => {
    const result = listQuery.safeParse(req.query);
    if (!result.success) throw new HttpError(400, "空间或分页参数不对");
    const { space, limit, offset } = result.data;
    const user = who(req);
    const scope = itemScope(app, user, space ? [space] : null);
    const where: string[] = [], params: string[] = [];
    if (scope.spaceIds) {
      where.push("space_id in (select value from json_each(?))");
      params.push(JSON.stringify(scope.spaceIds));
    }
    if (scope.userId) {
      where.push("(user_id=? or space_id in (select value from json_each(?)))");
      params.push(scope.userId, JSON.stringify(scope.sharedSpaces ?? []));
    }
    const tasks = all(app.db, `select id,space_id spaceId,user_id userId,thread_id threadId,item_id itemId,source_kind sourceKind,source_id sourceId,goal,status,
      created_at createdAt,updated_at updatedAt from long_tasks ${where.length ? "where " + where.join(" and ") : ""}
      order by updated_at desc,id limit ? offset ?`, ...params, limit, offset);
    return { tasks };
  });
  server.post("/api/long-tasks", async req => {
    const body = createBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, body.error.message);
    const { space, ...fields } = body.data, userId = who(req);
    return startLongTask(app, { ...fields, spaceId: space ?? personalSpaceId(userId), userId });
  });
  server.get("/api/long-tasks/:id", async req => {
    const task = getLongTask(app, (req.params as { id: string }).id);
    if (!itemAccess(app, who(req), task, "read")) throw new HttpError(404, "没有这个长任务");
    const last = task.notes.at(-1);
    const report = last && one<{ report: string; progressText: string }>(app.db,
      "select json_extract(output,'$.supervisorReport') report,json_extract(output,'$.progressText') progressText from runs where id=?", last.runId);
    return { ...task, report: report?.report ? JSON.parse(report.report) : null, progressText: report?.progressText ?? null,
      progress: supervisorFacts(app, task),
      usage: supervisorUsage(app, task), timeline: itemEvents(app, task.itemId) };
  });
  server.patch("/api/long-tasks/:id", async req => {
    const task = getLongTask(app, (req.params as { id: string }).id), user = who(req);
    if (task.userId !== user)
      throw new HttpError(403, "只有任务发起人可以操作");
    const command = longTaskCommandSchema.safeParse(req.body);
    if (!command.success) throw new HttpError(400, command.error.message);
    return changeLongTask(app, task.id, command.data);
  });
}
