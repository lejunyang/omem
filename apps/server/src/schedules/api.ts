import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scheduleInputSchema } from "../../../../packages/contracts/src/schedules.js";
import type { ScheduleService } from "./service.js";

const controlSchema = z
  .object({ expectedVersion: z.number().int().positive().optional() })
  .strict();
export function registerSchedules(
  app: FastifyInstance,
  service: ScheduleService,
  options: { systemTasks?: () => unknown[] } = {},
) {
  app.get("/api/schedules", async () => ({
    tasks: service.list(),
    system: options.systemTasks?.() ?? [],
  }));
  app.get<{ Params: { id: string } }>(
    "/api/schedules/:id",
    async (req, reply) => {
      const task = service.get(req.params.id);
      return task ?? reply.code(404).send({ error: "定时任务不存在或已删除" });
    },
  );
  app.post("/api/schedules", async (req) =>
    service.save(scheduleInputSchema.parse(req.body)),
  );
  app.put<{ Params: { id: string } }>(
    "/api/schedules/:id",
    async (req, reply) => {
      const input = scheduleInputSchema.parse(req.body);
      if (!input.expectedVersion)
        return reply.code(400).send({ error: "请提供任务版本并刷新后重试" });
      return service.save(input, req.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/schedules/:id/pause",
    async (req) =>
      service.pause(
        req.params.id,
        controlSchema.parse(req.body ?? {}).expectedVersion,
      ),
  );
  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req) =>
    service.delete(
      req.params.id,
      controlSchema.parse(req.body ?? {}).expectedVersion,
    ),
  );
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req) =>
    service.runOnce(req.params.id),
  );
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/schedules/:id/runs/:runId",
    async (req, reply) => {
      const run = service.repository.run(req.params.runId);
      return run?.taskId === req.params.id
        ? run
        : reply.code(404).send({ error: "定时任务的执行记录不存在" });
    },
  );
}
