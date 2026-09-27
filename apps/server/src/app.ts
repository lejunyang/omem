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
  taskUpdateSchema,
  jobControlSchema,
  runtimeRequestDecisionSchema,
  proposalSchema,
  proposalAssessmentInputSchema,
  decisionActionSchema,
  feedbackInputSchema,
  larkOnboardingStartSchema,
  larkPairingConfirmSchema,
  larkExistingImportSchema,
} from "../../../packages/contracts/src/index.js";
import { Store } from "./store.js";
import { Runs } from "./runs.js";
import { acp } from "./agents.js";
import { fileInput, gitInput, larkInput, hookInput } from "./connectors.js";
import type { Config } from "./config.js";
import { FeedbackService, MemoryService } from "./memory/service.js";
import { LarkOnboardingService } from "./integrations/lark/onboarding.js";
import { OMEM_LARK_DEFAULT_CONFIG } from "./integrations/lark/defaults.js";
import { LearningPipeline } from "./learning/pipeline.js";
import {
  OfficialLarkCapabilityProbe,
  OfficialLarkRegistrationAdapter,
} from "./integrations/lark/registration.js";
import { EncryptedSecretStore } from "./integrations/lark/secret-store.js";
import { BotmuxExistingAppProvider } from "./integrations/lark/existing-apps.js";
import { LarkRuntimeHost } from "./integrations/lark/runtime.js";
const str = z.string().min(1).max(2000);
export async function buildApp(
  config: Config,
  dependencies: {
    lark?: LarkOnboardingService;
    larkRuntime?: LarkRuntimeHost;
  } = {},
) {
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) && !config.token)
    throw Error("OMEM_TOKEN is required for a non-loopback bind");
  const app = Fastify({ bodyLimit: 12_000_000, logger: false });
  const store = new Store(config.dataDir, {
    externalNotifications: config.notifications.external,
  });
  const runs = new Runs(store, config);
  const memory = new MemoryService(store);
  const feedback = new FeedbackService(store);
  const learningConfig = config.learning;
  const learningProfile = learningConfig?.enabled
    ? config.profiles.find((profile) => profile.id === learningConfig.profileId)
    : undefined;
  if (learningConfig?.enabled && !learningProfile)
    throw Error(`Learning profile not found: ${learningConfig.profileId}`);
  const learning = learningProfile
    ? new LearningPipeline({
        store,
        memory,
        feedback,
        profile: learningProfile,
        workspaceRoot: config.agentCwd,
        pollMs: learningConfig?.pollMs,
      })
    : null;
  let lark = dependencies.lark;
  let larkRuntime = dependencies.larkRuntime ?? null;
  if (config.lark?.enabled && !lark) {
    try {
      const secrets = EncryptedSecretStore.fromEnvironment(config.dataDir);
      lark = new LarkOnboardingService(
        store.db,
        secrets,
        new OfficialLarkRegistrationAdapter(),
        new OfficialLarkCapabilityProbe(),
        () => new Date(),
        new BotmuxExistingAppProvider(config.lark.botmuxConfig),
      );
      larkRuntime = new LarkRuntimeHost({
        store,
        memory,
        onboarding: lark,
        secrets,
        pollMs: config.lark.pollMs,
      });
    } catch (error) {
      store.close();
      throw error;
    }
  }
  const requireLark = () => {
    if (!lark) throw Error("LARK_ONBOARDING_NOT_CONFIGURED");
    return lark;
  };
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
    const code =
      e.message.includes("REBASE_REQUIRED") ||
      e.message.includes("STALE_") ||
      e.message.includes("_CONFLICT")
        ? 409
        : e.message.includes("already active")
          ? 429
          : e instanceof z.ZodError
            ? 400
            : 400;
    reply.code(code).send({
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
    learning: learning?.status() ?? {
      running: false,
      processed: 0,
      lastError: null,
    },
    lark: larkRuntime?.status() ?? {
      running: false,
      connections: 0,
      processedDeliveries: 0,
      processedCards: 0,
      lastError: null,
    },
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
  app.post("/api/input-events", async (req) => {
    const input = captureSchema.parse(req.body);
    const event = store.inputs.ingest(input);
    const batches = store.inputs.flushReady(
      (envelope) => store.capture(envelope),
      { now: new Date() },
    );
    return { event, batches };
  });
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
  app.get<{ Params: { id: string } }>(
    "/api/notifications/:id",
    async (req, reply) =>
      store.notification(req.params.id) ??
      reply.code(404).send({ error: "Notification not found" }),
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
    const b = taskUpdateSchema.parse(req.body);
    return {
      ok: true,
      ...store.setTaskStatus(req.params.id, b.status, b.expectedVersion),
    };
  });
  app.get("/api/jobs", async () => store.jobs.list());
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req, reply) => {
    const job = store.jobs.get(req.params.id);
    return job
      ? { ...job, attempts: store.jobs.attempts(job.id) }
      : reply.code(404).send({ error: "Job not found" });
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    const body = jobControlSchema.parse(req.body);
    return learning
      ? learning.cancel({ jobId: req.params.id, ...body })
      : store.jobs.cancel({ jobId: req.params.id, ...body });
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/retry", async (req) => {
    const body = jobControlSchema.parse(req.body);
    return store.jobs.retry({ jobId: req.params.id, ...body });
  });
  app.get("/api/input-batches", async () => store.inputs.batches());
  app.get("/api/runtime-requests", async () => store.runtimeRequests.list());
  app.post<{ Params: { id: string } }>(
    "/api/runtime-requests/:id/respond",
    async (req) => {
      const body = runtimeRequestDecisionSchema.parse(req.body);
      return store.runtimeRequests.resolve({ id: req.params.id, ...body });
    },
  );
  app.get("/api/proposals", async () => memory.proposals());
  app.get<{ Params: { id: string } }>(
    "/api/proposals/:id",
    async (req, reply) =>
      memory.proposal(req.params.id) ??
      reply.code(404).send({ error: "Proposal not found" }),
  );
  app.post("/api/proposals/evaluate", async (req) => {
    const body = z
      .object({
        proposal: proposalSchema,
        assessment: proposalAssessmentInputSchema,
        impactCount: z.number().int().min(0).max(10_000).default(1),
      })
      .strict()
      .parse(req.body);
    return memory.evaluate(body.proposal, body.assessment, {
      impactCount: body.impactCount,
    });
  });
  app.get("/api/decisions", async () => memory.decisions());
  app.post<{ Params: { id: string } }>("/api/decisions/:id", async (req) =>
    memory.decide(req.params.id, decisionActionSchema.parse(req.body)),
  );
  app.get("/api/memories", async () => memory.memories());
  app.get<{ Params: { id: string } }>(
    "/api/memories/:id/revisions",
    async (req) =>
      store.db
        .prepare(
          "SELECT * FROM memory_revisions WHERE memory_id=? ORDER BY version DESC",
        )
        .all(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/memories/:id/restore",
    async (req) => {
      const body = z
        .object({
          expectedVersion: z.number().int().min(1),
          targetVersion: z.number().int().min(1),
          requestId: z.string().min(1).max(500),
        })
        .strict()
        .parse(req.body);
      return memory.restoreMemory({ memoryId: req.params.id, ...body });
    },
  );
  app.post("/api/feedback", async (req) =>
    feedback.record(feedbackInputSchema.parse(req.body)),
  );
  app.get<{ Querystring: { projectId?: string; subjectId?: string } }>(
    "/api/feedback/constraints",
    async (req) =>
      feedback.recall({
        workspace_id: "personal",
        project_id: req.query.projectId || null,
        subject_id: req.query.subjectId || null,
      }),
  );
  app.post("/api/integrations/lark/onboarding", async (req) =>
    requireLark().start(larkOnboardingStartSchema.parse(req.body)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/integrations/lark/onboarding/:id",
    async (req) => requireLark().status(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/integrations/lark/onboarding/:id/cancel",
    async (req) => requireLark().cancel(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/integrations/lark/onboarding/:id/pairing-code",
    async (req) => requireLark().issuePairingCode(req.params.id),
  );
  app.post("/api/integrations/lark/bindings/confirm", async (req) =>
    requireLark().confirmPairing(larkPairingConfirmSchema.parse(req.body)),
  );
  app.get("/api/integrations/lark/status", async () =>
    requireLark().connections(),
  );
  app.get(
    "/api/integrations/lark/default-config",
    async () => OMEM_LARK_DEFAULT_CONFIG,
  );
  app.get("/api/integrations/lark/reusable-apps", async () =>
    requireLark().listReusableApps(),
  );
  app.post("/api/integrations/lark/existing", async (req) =>
    requireLark().importExisting(larkExistingImportSchema.parse(req.body)),
  );
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
  let lastInputError = "";
  const inputTick = setInterval(() => {
    try {
      store.inputs.flushReady((input) => store.capture(input));
      lastInputError = "";
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (message !== lastInputError)
        console.error(`omem input aggregation failed: ${message}`);
      lastInputError = message;
    }
  }, 1000);
  inputTick.unref();
  learning?.start();
  larkRuntime?.start();
  app.addHook("onClose", async () => {
    clearInterval(tick);
    clearInterval(inputTick);
    await learning?.stop();
    await larkRuntime?.stop();
    await runs.close();
    store.close();
  });
  return {
    app,
    store,
    runs,
    memory,
    feedback,
    learning,
    lark,
    larkRuntime,
  };
}
