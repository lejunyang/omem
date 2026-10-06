import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PersonalLarkService } from "./service.js";
import type { AssistantWork } from "../../assistant/work.js";
import { MessageUnderstanding } from "../../messages/understanding.js";
import { messageFeedbackInput } from "../../messages/feedback.js";
export function registerPersonalLark(
  app: FastifyInstance,
  service: PersonalLarkService,
  work: () => AssistantWork,
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
  app.post<{ Params: { id: string } }>(
    "/api/integrations/lark-personal/inbox/:id/understand",
    async (req) => service.store.messageFeedback.retry(req.params.id),
  );
  app.get("/api/integrations/lark-personal/inbox", async () =>
    new MessageUnderstanding(service.store, work()).read(service.inbox()),
  );
  app.post<{ Params: { id: string } }>(
    "/api/integrations/lark-personal/inbox/:id/feedback",
    async (req) => {
      const result = service.store.messageFeedback.save(
        req.params.id,
        messageFeedbackInput.parse(req.body),
      );
      const affected =
        new MessageUnderstanding(service.store, work()).read(
          service.inbox().filter((i) => i.id === req.params.id),
        )[0]?.understanding.requirements ?? [];
      for (const follow of affected)
        if (work().pages.available) work().pages.refresh(follow.key);
      return { ...result, requirementsQueued: affected.map((f) => f.title) };
    },
  );
  app.delete<{ Params: { id: string; feedbackId: string } }>(
    "/api/integrations/lark-personal/inbox/:id/feedback/:feedbackId",
    async (req) => {
      const message = service.inbox().find((i) => i.id === req.params.id);
      const sourceId =
        message?.revision_id &&
        service.store.revision(String(message.revision_id))?.sourceId;
      if (
        !sourceId ||
        !service.store.messageFeedback
          .history(sourceId)
          .some((f) => f.id === req.params.feedbackId)
      )
        throw Error("纠正不属于这条消息");
      const result = service.store.messageFeedback.revoke(
        req.params.feedbackId,
      );
      const affected = new MessageUnderstanding(service.store, work()).read([
        message!,
      ])[0]!.understanding.requirements;
      for (const follow of affected)
        if (work().pages.available) work().pages.refresh(follow.key);
      return result;
    },
  );
}
