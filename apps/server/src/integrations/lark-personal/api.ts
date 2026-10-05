import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PersonalLarkService } from "./service.js";
export function registerPersonalLark(
  app: FastifyInstance,
  service: PersonalLarkService,
) {
  app.get("/api/integrations/lark-personal", async () => service.status());
  app.put("/api/integrations/lark-personal", async (req) =>
    service.configure(req.body),
  );
  app.post("/api/integrations/lark-personal/discover", async () =>
    service.discover(),
  );
  app.put<{ Params: { id: string } }>(
    "/api/integrations/lark-personal/chats/:id",
    async (req) =>
      service.subscribe(
        req.params.id,
        z.object({ mode: z.enum(["watch", "off", "excluded"]) }).parse(req.body)
          .mode,
      ),
  );
  app.post("/api/integrations/lark-personal/sync", async () =>
    service.schedule(true),
  );
  app.post<{ Params: { id: string } }>(
    "/api/integrations/lark-personal/inbox/:id/retry",
    async (req) => service.retry(req.params.id),
  );
  app.get("/api/integrations/lark-personal/inbox", async () => service.inbox());
}
