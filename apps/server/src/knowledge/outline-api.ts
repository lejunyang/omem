import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { KnowledgeOutlineService } from "./outlines.js";

export function registerOutlineRoutes(
  app: FastifyInstance,
  prefix: string,
  service: KnowledgeOutlineService,
) {
  const failure = (error: unknown) => ({
    error:
      error instanceof ZodError
        ? "请填写目录标题、读者、目标与各页面计划，并选择已有材料"
        : error instanceof Error
          ? error.message
          : String(error),
  });
  app.get(prefix + "/outlines", async () => ({
    drafts: service.list(),
    available: service.pages.available,
  }));
  app.post<{ Body: unknown }>(prefix + "/outlines", async (req, reply) => {
    try {
      return reply.code(201).send(service.create(req.body));
    } catch (error) {
      return reply
        .code(error instanceof ZodError ? 400 : 409)
        .send(failure(error));
    }
  });
  app.get<{ Params: { id: string } }>(
    prefix + "/outlines/:id",
    async (req, reply) =>
      service.get(req.params.id) ??
      reply.code(404).send({ error: "目录草案不存在" }),
  );
  app.put<{
    Params: { id: string };
    Body: { version: number; draft: unknown };
  }>(prefix + "/outlines/:id", async (req, reply) => {
    try {
      return service.save(req.params.id, req.body?.version, req.body?.draft);
    } catch (error) {
      return reply
        .code(error instanceof ZodError ? 400 : 409)
        .send(failure(error));
    }
  });
  app.post<{ Params: { id: string }; Body: { version: number } }>(
    prefix + "/outlines/:id/propose",
    async (req, reply) => {
      if (!service.options.run)
        return reply
          .code(503)
          .send({ error: "请先在能力与连接中配置 Agent，再生成目录建议" });
      try {
        return reply
          .code(202)
          .send(service.propose(req.params.id, req.body?.version));
      } catch (error) {
        return reply.code(409).send(failure(error));
      }
    },
  );
  app.post<{ Params: { id: string }; Body: { version: number } }>(
    prefix + "/outlines/:id/apply",
    async (req, reply) => {
      if (!service.pages.available)
        return reply
          .code(503)
          .send({
            error: "请先在能力与连接中配置 Agent，再确认目录并整理正文",
          });
      try {
        return reply
          .code(202)
          .send(service.apply(req.params.id, req.body?.version));
      } catch (error) {
        return reply.code(409).send(failure(error));
      }
    },
  );
  app.delete<{ Params: { id: string }; Querystring: { version?: string } }>(
    prefix + "/outlines/:id",
    async (req, reply) => {
      try {
        return service.delete(req.params.id, Number(req.query.version));
      } catch (error) {
        return reply.code(409).send(failure(error));
      }
    },
  );
}
