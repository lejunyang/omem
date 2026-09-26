import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  captureSchema,
  questionSchema,
  taskSchema,
} from "../../../packages/contracts/src/index.js";
import { Store } from "./store.js";
import { Runs } from "./runs.js";
import { acp } from "./agents.js";
import { fileInput, gitInput, larkInput, hookInput } from "./connectors.js";
import type { Config } from "./config.js";
const str = z.string().min(1).max(2000);
export async function buildApp(config: Config) {
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) && !config.token)
    throw Error("OMEM_TOKEN is required for a non-loopback bind");
  const app = Fastify({ bodyLimit: 12_000_000, logger: false });
  const store = new Store(config.dataDir);
  const runs = new Runs(store, config);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    if (config.token) {
      const candidate = String(req.headers.authorization || "").replace(
        /^Bearer /,
        "",
      );
      const a = Buffer.from(candidate),
        b = Buffer.from(config.token);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return reply.code(401).send({ error: "Access token required" });
    } else {
      const host = new URL("http://" + (req.headers.host || "invalid"))
        .hostname;
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host))
        return reply.code(403).send({ error: "Local host required" });
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
          return reply
            .code(403)
            .send({ error: "Cross-origin request rejected" });
      }
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error;
    const code = e.message.includes("REBASE_REQUIRED")
      ? 409
      : e.message.includes("already active")
        ? 429
        : e instanceof z.ZodError
          ? 400
          : 400;
    reply
      .code(code)
      .send({
        error:
          e instanceof z.ZodError
            ? "Invalid input: " +
              e.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")
            : e.message,
      });
  });
  app.get("/api/health", async () => ({
    status: "ok",
    storage: "sqlite",
    mode: "personal",
    notificationMode: config.notifications.mode,
  }));
  app.get("/api/sources", async () => store.list());
  app.post("/api/captures", async (req) =>
    store.capture(captureSchema.parse(req.body)),
  );
  app.post("/api/connectors/file", async (req) => {
    const b = z.object({ path: str }).parse(req.body);
    return store.capture(
      captureSchema.parse(await fileInput(b.path, config.captureRoots)),
    );
  });
  app.post("/api/connectors/git", async (req) => {
    const b = z
      .object({ repo: str, path: str, ref: str.default("HEAD") })
      .parse(req.body);
    return store.capture(
      captureSchema.parse(
        await gitInput(b.repo, b.path, b.ref, config.captureRoots),
      ),
    );
  });
  app.post("/api/connectors/lark", async (req) => {
    const b = z.object({ url: z.url() }).parse(req.body);
    return store.capture(captureSchema.parse(await larkInput(b.url)));
  });
  app.post("/api/hooks/traex", async (req) =>
    store.capture(captureSchema.parse(hookInput(req.body))),
  );
  app.get<{ Params: { id: string } }>(
    "/api/revisions/:id",
    async (req, reply) =>
      store.revision(req.params.id) ||
      reply.code(404).send({ error: "Revision not found" }),
  );
  app.get<{ Params: { id: string } }>("/api/sources/:id/history", async (req) =>
    store.history(req.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/api/evidence/:id",
    async (req, reply) =>
      store.evidence(req.params.id) ||
      reply.code(404).send({ error: "Evidence not found" }),
  );
  app.post("/api/relations", async (req) => {
    const b = z.object({ from: str, to: str }).strict().parse(req.body);
    return store.link(b.from, b.to);
  });
  app.get<{ Querystring: { q?: string } }>("/api/search", async (req) =>
    store.search((req.query.q || "").slice(0, 300)),
  );
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    const bytes = store.asset(req.params.id);
    if (!bytes) return reply.code(404).send({ error: "Asset not found" });
    const type =
      bytes[0] === 137
        ? "image/png"
        : bytes[0] === 255
          ? "image/jpeg"
          : "image/webp";
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .type(type)
      .send(bytes);
  });
  app.get("/api/changes", async () => store.changes());
  app.post<{ Params: { id: string } }>(
    "/api/changes/:id/restore",
    async (req) => {
      const b = z.object({ expectedHead: str }).strict().parse(req.body);
      return store.restore(req.params.id, b.expectedHead);
    },
  );
  app.get("/api/notifications", async () => {
    store.remind();
    return store.notifications();
  });
  app.post<{ Params: { id: string } }>(
    "/api/notifications/:id/read",
    async (req) => {
      store.readNotification(req.params.id);
      return { ok: true };
    },
  );
  app.get("/api/tasks", async () => store.tasks());
  app.post("/api/tasks", async (req) =>
    store.createTask(taskSchema.parse(req.body)),
  );
  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (req) => {
    const b = z.object({ status: z.enum(["open", "done"]) }).parse(req.body);
    store.setTaskStatus(req.params.id, b.status);
    return { ok: true };
  });
  app.get("/api/profiles", async () =>
    config.profiles.map(
      ({ id, name, transport, model, effort, maxContextChars }) => ({
        id,
        name,
        transport,
        model,
        effort,
        maxContextChars,
      }),
    ),
  );
  let probing = false;
  app.post<{ Params: { id: string } }>(
    "/api/profiles/:id/probe",
    async (req) => {
      const p = config.profiles.find((p) => p.id === req.params.id);
      if (!p) throw Error("Profile not found");
      if (p.transport !== "acp")
        return {
          configOptions: [],
          note: "CLI profile; model and effort are validated by the installed CLI",
        };
      if (probing) throw Error("Probe already active");
      probing = true;
      try {
        return await acp(
          p,
          config.agentCwd,
          null,
          () => {},
          new AbortController().signal,
        );
      } finally {
        probing = false;
      }
    },
  );
  app.post("/api/runs", async (req, reply) =>
    reply.code(202).send(runs.start(questionSchema.parse(req.body))),
  );
  app.get<{ Params: { id: string } }>(
    "/api/runs/:id",
    async (req, reply) =>
      runs.get(req.params.id) ||
      reply.code(404).send({ error: "Run not found" }),
  );
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req) => {
    runs.cancel(req.params.id);
    return { ok: true };
  });
  const web = resolve("apps/web/dist");
  if (existsSync(web))
    await app.register(staticFiles, { root: web, prefix: "/" });
  const tick = setInterval(() => store.remind(), 30000);
  tick.unref();
  app.addHook("onClose", async () => {
    clearInterval(tick);
    await runs.close();
    store.close();
  });
  return { app, store, runs };
}
