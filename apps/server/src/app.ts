import {
  RequirementTasks,
  registerRequirementTasks,
} from "./knowledge/requirement-tasks.js";
import { agentIdleTimeout } from "./agent-timeout.js";
import { assetPath } from "./paths.js";
import { PersonalLarkService } from "./integrations/lark-personal/service.js";
import { registerPersonalLark } from "./integrations/lark-personal/api.js";
import type { PersonalLarkPort } from "./integrations/lark-personal/client.js";
import { ScheduleService } from "./schedules/service.js";
import { JobExecutionError } from "./jobs/worker.js";
import { registerSchedules } from "./schedules/api.js";
import { ScheduledBriefService } from "./assistant/scheduled-brief.js";
import { evidenceSection } from "./retrieval/context.js";
import { codeIntents, retrievalPurposes } from "./retrieval/port.js";
import {
  importDevelopmentKnowledge,
  developmentRetrieval,
} from "./review/development.js";
import { taskCommandSchema } from "../../../packages/contracts/src/task-flow.js";
import { messageWorkflows } from "./assistant/message-workflows.js";
import { registerKnowledgeRoutes } from "./knowledge/api.js";
import {
  contextInputSchema,
  contextIdsSchema,
} from "../../../packages/contracts/src/contexts.js";
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
import { documentInput } from "./imports/documents.js";
import { DecisionService } from "./decision/service.js";
import { intakeQuestions } from "./decision/questions.js";
import { assessPassages } from "./decision/passages.js";
import {
  assistantProfile as selectAssistantProfile,
  knowledgeProfile,
  assistantReadingProfile,
  developmentProfiles,
  type Config,
} from "./config.js";
import { FeedbackService, MemoryService } from "./memory/service.js";
import { LarkOnboardingService } from "./integrations/lark/onboarding.js";
import { OMEM_LARK_DEFAULT_CONFIG } from "./integrations/lark/defaults.js";
import { LearningPipeline } from "./learning/pipeline.js";
import {
  materialDescriptionSchema,
  materialRoles,
} from "../../../packages/contracts/src/material-description.js";
import {
  OfficialLarkCapabilityProbe,
  OfficialLarkRegistrationAdapter,
} from "./integrations/lark/registration.js";
import { EncryptedSecretStore } from "./integrations/lark/secret-store.js";
import { BotmuxExistingAppProvider } from "./integrations/lark/existing-apps.js";
import { LarkRuntimeHost } from "./integrations/lark/runtime.js";
import { AssistantRuntime } from "./assistant/runtime.js";
import { AcpAssistantModel } from "./assistant/acp-model.js";
import {
  AgentSettings,
  agentProbeSchema,
  agentSetupSchema,
} from "./agent-settings.js";
import { AssistantWork } from "./assistant/work.js";
import { workActionSchema } from "../../../packages/contracts/src/work.js";
import { DevelopmentQueue } from "./development/queue.js";
import { KnowledgeRepository } from "./knowledge/repository.js";
import { createRetrieval } from "./retrieval/factory.js";
import { QualityRepository, qualityLabelSchema } from "./quality/repository.js";
const str = z.string().min(1).max(2000);
export async function buildApp(
  config: Config,
  dependencies: {
    lark?: LarkOnboardingService;
    larkRuntime?: LarkRuntimeHost;
    personalLarkPort?: PersonalLarkPort;
  } = {},
) {
  const assistantProfile = () => selectAssistantProfile(config);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.host) && !config.token)
    throw Error("OMEM_TOKEN is required for a non-loopback bind");
  const app = Fastify({ bodyLimit: 12_000_000, logger: false });
  const store = new Store(config.dataDir, {
    externalNotifications: config.notifications.external,
  });
  const development = process.env.OMEM_REPO_ROOT
    ? importDevelopmentKnowledge(store, resolve(process.env.OMEM_REPO_ROOT))
    : undefined;
  const runs = new Runs(store, config);
  const agentSettings = new AgentSettings(config);
  app.get("/api/agents/settings", async () => agentSettings.status());
  app.post("/api/agents/probe", async (req) =>
    agentSettings.probe(agentProbeSchema.parse(req.body)),
  );
  app.put("/api/agents/settings", async (req) =>
    agentSettings.save(agentSetupSchema.parse(req.body)),
  );
  const memory = new MemoryService(store);
  const decisions = new DecisionService(config.decisions ?? { mode: "auto" });
  let work!: AssistantWork;
  let schedules!: ScheduleService;
  let brief!: ScheduledBriefService;
  const personalLark = new PersonalLarkService(
    store,
    decisions,
    dependencies.personalLarkPort,
    {
      watchedContextSummary: () => ({
        projects: store.contexts
          .list()
          .map((p) => ({ id: p.id, name: p.name, description: p.description })),
        requirements:
          work?.catalog().requirements.map((r) => ({
            title: r.title,
            goal: r.goal,
            attention: r.attention,
            summary: r.summary,
            contextIds: r.contextIds,
          })) ?? [],
      }),
      autoWatchNextAt: () =>
        schedules?.list().find((t) => t.kind === "lark_discovery")?.nextRunAt ??
        null,
      onAutoWatchConfigured: (settings) => {
        if (!schedules) return;
        const task = schedules.list().find((t) => t.kind === "lark_discovery");
        if (!task && !settings.enabled) return;
        if (
          task?.enabled === settings.enabled &&
          task.timing.type === "interval" &&
          task.timing.everyMinutes === settings.intervalMinutes
        )
          return;
        schedules.save(
          {
            kind: "lark_discovery",
            name: task?.name ?? "发现飞书会话",
            instruction: task?.instruction ?? "按已保存关注策略筛选最近活跃群",
            contextIds: [],
            enabled: settings.enabled,
            timing: {
              type: "interval",
              everyMinutes: settings.intervalMinutes,
            },
            ...(task ? { expectedVersion: task.version } : {}),
          },
          task?.id,
        );
      },
    },
  );
  schedules = new ScheduleService(
    store,
    async (task, signal, occurrence) => {
      if (task.kind === "daily_brief")
        return brief.run(task, signal, occurrence);
      const result = await personalLark.discoverAndWatch(signal);
      occurrence.assertCurrent();
      if (result.status === "cancelled")
        throw new JobExecutionError(
          "飞书自动关注已取消或政策已变化",
          "cancelled",
        );
      if (result.status === "failed")
        throw Error(result.notice ?? "飞书会话发现失败");
      return {
        summary:
          result.status === "disabled"
            ? (result.notice ?? "自动发现或消息采集已暂停")
            : `检查${result.discovered}个最近会话，新增关注${result.selected.length}个群；${result.pending.length}个待判断。`,
        detail: JSON.stringify(result, null, 2),
        skipped: result.status === "disabled",
      };
    },
    {
      onSaved: (task) => {
        if (task.kind === "lark_discovery")
          personalLark.configureAutoWatch({
            enabled: task.enabled,
            intervalMinutes:
              task.timing.type === "interval" ? task.timing.everyMinutes : 30,
          });
      },
      onDeleted: (task) => {
        if (task.kind === "lark_discovery")
          personalLark.configureAutoWatch({ enabled: false });
      },
      onBackgroundError: (error) => app.log.error(error),
    },
  );
  let reminderLastCheckedAt: string | null = null;
  registerSchedules(app, schedules, {
    systemTasks: () => [
      {
        id: "task-reminders",
        name: "事项提醒检查",
        kind: "task_reminders",
        enabled: true,
        intervalSeconds: 30,
        lastCheckedAt: reminderLastCheckedAt,
        nextRunAt: reminderLastCheckedAt
          ? new Date(Date.parse(reminderLastCheckedAt) + 30000).toISOString()
          : null,
        pendingCount: store
          .tasks()
          .filter(
            (t) =>
              !["done", "cancelled"].includes(String(t.status)) &&
              (t.followUp?.next_check_at || t.dueAt),
          ).length,
        detail: "每30秒检查已设置的事项提醒；具体提醒时间在事项与待办中设置。",
      },
    ],
  });
  registerPersonalLark(app, personalLark, () => work);
  const feedback = new FeedbackService(store);
  // Production assistant uses the real ACP adapter against a configured profile.
  // When no ACP profile can actually run (missing CLI / auth / wrong transport)
  // the adapter raises ModelUnavailableError and the runtime degrades honestly.
  app.get("/api/memory-refreshes", async () =>
    store.db
      .prepare(
        `SELECT id,source_id AS sourceId,new_revision_id AS revisionId,affected_count AS affectedCount,
      affected_memory_ids AS affectedMemoryIds,status,result_json AS result,created_at AS createdAt
     FROM refresh_records ORDER BY created_at DESC LIMIT 100`,
      )
      .all()
      .map((row) => ({
        ...row,
        affectedMemoryIds: JSON.parse(String(row.affectedMemoryIds)),
        result: JSON.parse(String(row.result)),
      })),
  );

  const retrievalService = createRetrieval(store.db, config.retrieval);
  const assistantRetrieval = development
    ? developmentRetrieval(store, retrievalService.retrieval)
    : retrievalService.retrieval;
  const requirementTasks = new RequirementTasks(store);
  registerRequirementTasks(app, requirementTasks);
  const knowledgeRepository = registerKnowledgeRoutes(app, {
    preparePage: (plan) => work?.preparePage(plan),
    beforePageRun: (plan, signal) => work.investigationHints(plan, signal),
    onPublish: (article) => {
      requirementTasks.sync(article);
      work.published(article);
    },
    onService: (pages) => {
      work = new AssistantWork(
        pages,
        new DevelopmentQueue(
          store,
          pages,
          () => developmentProfiles(config)?.coding ?? null,
          {
            get reviewProfile() {
              return developmentProfiles(config)?.review;
            },
            decisions: config.decisions?.mode !== "off" ? decisions : undefined,
            onError: (error) => app.log.error(error),
          },
        ),
        decisions,
        { personalLark, schedules },
      );
    },
    store,
    repository: development?.repository,
    prefix: "/api/knowledge",
    workspace: resolve(config.dataDir, "knowledge-agents"),
    get profile() {
      return knowledgeProfile(config);
    },
    retrievalConfig: config.retrieval,
    retrieval: assistantRetrieval,
  });
  const assistantModel = new AcpAssistantModel({
    get profile() {
      return assistantProfile();
    },
    get readingProfile() {
      return assistantReadingProfile(config);
    },
    workspaceRoot: config.agentCwd,
    repository: knowledgeRepository,
    researchWorkspace: resolve(config.dataDir, "assistant-agents"),
    retrievalConfig: config.retrieval,
    work,
  });
  brief = new ScheduledBriefService(
    store,
    work,
    assistantModel,
    config.notifications.external?.timezone ?? "Asia/Shanghai",
  );
  app.get("/api/work", async () => work.catalog());
  app.post("/api/work/actions", async (req) => {
    const input = z
      .object({
        requestId: z.uuid(),
        action: workActionSchema,
        userText: z.string().min(1),
      })
      .strict()
      .parse(req.body);
    return work.apply(input.action, {
      requestId: input.requestId,
      userText: input.userText,
      conversationId: "web-followup",
      principalId: "owner",
      visibility: "private",
    });
  });
  app.get<{ Params: { id: string } }>(
    "/api/work/development/:id/result",
    async (req) => {
      const query = z
        .object({
          startLine: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .parse(req.query);
      return work.result(req.params.id, query.startLine, query.limit);
    },
  );
  app.get<{ Params: { key: string } }>(
    "/api/work/requirements/:key",
    async (req) => work.status(req.params.key),
  );
  app.get<{ Params: { id: string } }>(
    "/api/work/development/:id",
    async (req) => work.development.read(req.params.id),
  );
  app.get<{ Params: { alias: string } }>(
    "/api/work/repositories/:alias",
    async (req) => ({
      project:
        work.development.runner
          .projects()
          .find((p) => p.alias === req.params.alias) ?? null,
      preparation: work.development.runner.repositories.status(
        req.params.alias,
      ),
    }),
  );
  app.addHook("onReady", async () => {
    work.development.start();
    work.repositories.start();
  });
  app.addHook("preClose", async () => {
    await Promise.all([work.development.stop(), work.repositories.stop()]);
  });
  const assistant = new AssistantRuntime(store, assistantModel, {
    ownerId: "owner",
    memory,
    feedback,
    work,
    retrieval: assistantRetrieval,
    timezone: config.notifications.external?.timezone,
    decisions:
      config.decisions && config.decisions.mode !== "off"
        ? decisions
        : undefined,
    get turnTimeoutMs() {
      const profile = assistantProfile();
      return profile ? agentIdleTimeout(profile) : 60_000;
    },
  });
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
        get profile() {
          return config.profiles.find(
            (p) => p.id === config.learning!.profileId,
          )!;
        },
        workspaceRoot: config.agentCwd,
        pollMs: learningConfig?.pollMs,
        retrieval: assistantRetrieval,
        retrievalConfig: config.retrieval,
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
        work,
        onboarding: lark,
        secrets,
        assistantModel,
        get assistantTimeoutMs() {
          const profile = assistantProfile();
          return profile ? agentIdleTimeout(profile) : undefined;
        },
        retrieval: assistantRetrieval,
        pollMs: config.lark.pollMs,
      });
    } catch (error) {
      store.close();
      throw error;
    }
  }
  const quality =
    larkRuntime?.quality.repository ?? new QualityRepository(store.db);
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
    personalLark: personalLark.health(),
    schedules: {
      enabled: schedules.list().filter((t) => t.enabled).length,
      running: schedules.list().filter((t) => t.lastRun?.state === "running")
        .length,
    },
    storage: "sqlite",
    mode: "personal",
    retrieval: assistantRetrieval.health(),
    notificationMode: config.notifications.mode,
    accessProtected: !!config.token,
    processingEnabled: !!learningConfig?.enabled,
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
  app.get("/api/contexts", async () => store.contexts.list());
  app.post("/api/contexts", async (req) =>
    store.contexts.create(contextInputSchema.parse(req.body)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/sources/:id/contexts",
    async (req) => {
      const assignment = store.contexts.assignment(req.params.id);
      return {
        contextIds: store.contexts.forSource(req.params.id),
        assignment,
        candidates: store.contexts
          .list()
          .filter((c) => assignment?.candidateIds.includes(c.id)),
      };
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/sources/:id/contexts",
    async (req, reply) => {
      const { contextIds } = z
        .object({ contextIds: contextIdsSchema })
        .strict()
        .parse(req.body);
      try {
        return store.setSourceContexts(req.params.id, contextIds);
      } catch (error) {
        return reply.code(400).send({
          error: String(error instanceof Error ? error.message : error),
        });
      }
    },
  );
  app.get<{ Params: { revision: string } }>(
    "/api/material-descriptions/:revision",
    async (req, reply) => {
      if (!store.revision(req.params.revision))
        return reply.code(404).send({ error: "材料版本不存在" });
      return { record: store.descriptions.get(req.params.revision) };
    },
  );
  app.put<{ Params: { revision: string } }>(
    "/api/material-descriptions/:revision",
    async (req, reply) => {
      const input = z
        .object({
          expectedVersion: z.number().int().nonnegative(),
          description: materialDescriptionSchema,
        })
        .strict()
        .parse(req.body);
      try {
        return {
          record: store.descriptions.save(
            req.params.revision,
            input.description,
            "user",
            input.expectedVersion,
          ),
        };
      } catch (error) {
        return reply.code(409).send({
          error: String(error instanceof Error ? error.message : error),
        });
      }
    },
  );
  app.post("/api/captures", async (req) => {
    const { contextIds, ...capture } = captureSchema
      .extend({ contextIds: contextIdsSchema.optional() })
      .parse(req.body);
    return store.capture(capture, { contextIds });
  });
  app.get("/api/decisions/status", async () => decisions.status());
  app.post("/api/decisions/intake", async (req, reply) => {
    const { revisionId } = z
      .object({ revisionId: str })
      .strict()
      .parse(req.body);
    const revision = store.revision(revisionId);
    if (!revision) return reply.code(404).send({ error: "材料版本不存在" });
    const text = revision.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n\n");
    const result = await decisions.decide(
      {
        title: revision.title,
        material: text.slice(0, 12_000),
        partial_excerpt: text.length > 12_000,
      },
      intakeQuestions,
    );
    return { result, status: decisions.status() };
  });
  app.get<{ Querystring: { q?: string } }>(
    "/api/decisions/search",
    async (req) => {
      const question = (req.query.q || "").slice(0, 300);
      const hits =
        (await assistantRetrieval.search?.({
          text: question,
          limit: 30,
          diversify: false,
        })) ?? [];
      return assessPassages(decisions, question, hits);
    },
  );
  app.post("/api/connectors/file", async (req) => {
    const b = z
      .object({ path: str, contextIds: contextIdsSchema.optional() })
      .parse(req.body);
    return store.capture(
      captureSchema.parse(
        await fileInput(b.path, config.captureRoots, config.dataDir),
      ),
      { contextIds: b.contextIds },
    );
  });
  app.post(
    "/api/connectors/document",
    { bodyLimit: 28_000_000 },
    async (req) => {
      const b = z
        .object({
          name: z.string().min(1).max(300),
          data: z.string().min(1).max(27_000_000),
          externalId: z.string().min(1).max(300),
          contextIds: contextIdsSchema.optional(),
        })
        .strict()
        .parse(req.body);
      const bytes = Buffer.from(b.data, "base64");
      if (bytes.toString("base64") !== b.data) throw Error("文件编码无效");
      return store.capture(
        captureSchema.parse(
          await documentInput(bytes, b.name, config.dataDir, b.externalId),
        ),
        { contextIds: b.contextIds },
      );
    },
  );
  app.post("/api/connectors/git", async (req) => {
    const b = z
      .object({
        repo: str,
        path: str,
        ref: str.default("HEAD"),
        contextIds: contextIdsSchema.optional(),
      })
      .parse(req.body);
    return store.capture(
      captureSchema.parse(
        await gitInput(b.repo, b.path, b.ref, config.captureRoots),
      ),
      { contextIds: b.contextIds },
    );
  });
  app.post("/api/connectors/lark", async (req) => {
    const b = z
      .object({ url: z.url(), contextIds: contextIdsSchema.optional() })
      .parse(req.body);
    return store.capture(
      captureSchema.parse(await larkInput(b.url, config.dataDir)),
      { contextIds: b.contextIds },
    );
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
  app.get<{ Params: { revision: string } }>(
    "/api/source-profiles/:revision",
    async (req, reply) => {
      const profile = store.profiles.latest(req.params.revision);
      if (!profile)
        return reply.code(404).send({
          error: "Source readable, smart profile pending",
          sourceReadable: true,
        });
      return profile;
    },
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
  app.get<{ Params: { id: string; asset: string } }>(
    "/api/revisions/:id/document/:asset",
    async (req, reply) => {
      const document = store.revision(req.params.id)?.context.document;
      if (!document)
        return reply.code(404).send({ error: "此版本没有文档原件" });
      const asset = req.params.asset;
      if (asset === "original" || asset === "structure") {
        const bytes = store.asset(
          asset === "original"
            ? document.originalAssetId
            : document.structureAssetId,
        );
        if (!bytes) return reply.code(404).send({ error: "文档附件缺失" });
        if (asset === "original")
          reply.header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName)}`,
          );
        return reply
          .header("X-Content-Type-Options", "nosniff")
          .type(asset === "original" ? document.mimeType : "application/json")
          .send(bytes);
      }
      const raw = store.asset(document.structureAssetId);
      const structure = raw ? JSON.parse(raw.toString()) : null;
      if (
        !structure?.blocks?.some(
          (b: { imageAssetId?: string }) => b.imageAssetId === asset,
        )
      )
        return reply.code(404).send({ error: "文档图片不存在" });
      const bytes = store.asset(asset);
      return bytes
        ? reply
            .type("image/png")
            .header("X-Content-Type-Options", "nosniff")
            .send(bytes)
        : reply.code(404).send({ error: "图片附件缺失" });
    },
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
  app.get<{
    Querystring: {
      q?: string;
      purpose?: string;
      codeIntent?: string;
      role?: string;
      effectiveAt?: string;
    };
  }>("/api/search", async (req, reply) => {
    const purpose = z
      .enum(retrievalPurposes)
      .safeParse(req.query.purpose ?? "balanced");
    if (!purpose.success)
      return reply.code(400).send({ error: "查找用途无效" });
    const codeIntent = z
      .enum(codeIntents)
      .optional()
      .safeParse(req.query.codeIntent);
    if (!codeIntent.success)
      return reply.code(400).send({ error: "代码查找方式无效" });
    const role = z
      .enum(materialRoles)
      .optional()
      .safeParse(req.query.role || undefined);
    const effectiveAt = z.iso
      .datetime({ offset: true })
      .optional()
      .safeParse(req.query.effectiveAt || undefined);
    if (!role.success || !effectiveAt.success)
      return reply.code(400).send({ error: "材料筛选条件无效" });
    const query = {
      text: (req.query.q || "").slice(0, 300),
      limit: 30,
      purpose: purpose.data,
      codeIntent: codeIntent.data,
      ...(role.data ? { materialRoles: [role.data] } : {}),
      ...(effectiveAt.data ? { effectiveAt: effectiveAt.data } : {}),
    };
    if (assistantRetrieval.search) return assistantRetrieval.search(query);
    const hits = await (assistantRetrieval.searchSourcesAsync?.(query) ??
      assistantRetrieval.searchSources(query));
    return hits.flatMap((hit) => {
      const entry = store.evidence(hit.fragmentId);
      return entry
        ? [
            {
              id: hit.fragmentId,
              text: hit.snippet,
              title: entry.revision.title,
              version: entry.revision.version,
              score: hit.score,
              routes: hit.routes,
              section: evidenceSection(store, hit.fragmentId),
            },
          ]
        : [];
    });
  });
  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    const bytes = store.asset(req.params.id);
    if (!bytes) return reply.code(404).send({ error: "Asset not found" });
    const type =
      bytes[0] === 137
        ? "image/png"
        : bytes[0] === 255
          ? "image/jpeg"
          : bytes.toString("ascii", 0, 4) === "RIFF" &&
              bytes.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp"
            : "application/octet-stream";
    return reply
      .header("X-Content-Type-Options", "nosniff")
      .type(type)
      .send(bytes);
  });
  app.get("/api/changes", async () => store.changes());
  app.get<{ Params: { id: string } }>(
    "/api/changes/:id/content",
    async (req, reply) => {
      const change = store.db
        .prepare("SELECT kind,before_id,after_id FROM changes WHERE id=?")
        .get(req.params.id);
      if (!change) return reply.code(404).send({ error: "变化记录不存在" });
      function content(id: unknown) {
        if (!id) return null;
        if (change!.kind === "knowledge") {
          const row = store.db
            .prepare("SELECT artifact FROM knowledge_revisions WHERE id=?")
            .get(String(id));
          if (!row) return null;
          const { document, generation } = JSON.parse(String(row.artifact));
          const citationNames = new Map(
            document.citations.map((c: { key: string; label: string }) => [
              c.key,
              c.label,
            ]),
          );
          const sections = document.sections.map(
            (s: { title: string; body: string }) =>
              "## " +
              s.title +
              "\n\n" +
              s.body.replace(
                /\[\[([^\]]+)\]\]/g,
                (_: string, key: string) =>
                  "〔参考：" + (citationNames.get(key) ?? "未找到引用") + "〕",
              ),
          );
          const references = document.citations.map(
            (c: {
              label: string;
              reason: string;
              target: {
                kind: string;
                key: string;
                startLine?: number;
                endLine?: number;
              };
            }) =>
              c.label +
              "：" +
              c.reason +
              (c.target.kind === "material"
                ? `（${c.target.key.replace(/^omem:/, "")}，第 ${c.target.startLine}–${c.target.endLine} 行）`
                : ""),
          );
          return {
            title: document.title,
            text:
              document.summary +
              "\n\n" +
              sections.join("\n\n") +
              "\n\n引用说明：\n" +
              references.join("\n"),
            version: "知识正文 · " + generation.at,
          };
        }
        const revision = store.revision(String(id));
        return revision
          ? {
              title: revision.title,
              version: "v" + revision.version,
              text: revision.parts
                .map((p) =>
                  p.type === "text"
                    ? p.text
                    : p.type === "link"
                      ? p.url
                      : "[图片：" + p.label + "]",
                )
                .join("\n\n"),
            }
          : null;
      }
      return {
        before: content(change.before_id),
        after: content(change.after_id),
        kind: change.kind,
        hasBefore: !!change.before_id,
      };
    },
  );
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
  app.get("/api/assistant/workflows", async () =>
    messageWorkflows.map(({ instruction: _instruction, ...recipe }) => recipe),
  );
  app.get("/api/tasks", async () => store.tasks());
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/commands",
    async (req) => {
      const command = taskCommandSchema.parse(req.body);
      const task = store.tasks().find((t) => t.id === req.params.id);
      if (!task) throw Error("Task not found");
      const label = {
        complete: "标记完成",
        reopen: "重新打开",
        reschedule: "修改截止时间",
        wait: "记录等待",
        snooze: "暂缓提醒",
        cancel: "取消",
      }[command.action];
      const description = [
        `用户对已有事项“${task.title}”执行：${label}。`,
        command.followUp?.waiting_on
          ? `等待：${command.followUp.waiting_on}`
          : "",
        command.followUp?.time_expression
          ? `跟进时间：${command.followUp.time_expression}（${command.followUp.timezone}）`
          : "",
        command.dueExpression ? `截止时间：${command.dueExpression}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const revision = store.capture({
        source: "manual",
        externalId: `task-control:${command.requestId}`,
        title: `事项操作：${task.title}`,
        parts: [{ type: "text", text: description }],
        context: {},
        provenance: {
          collectorId: "task-controls",
          actorId: "owner",
          actorType: "owner",
          actorVerifiedBy: "local-user",
          sourceUri: null,
          eventId: command.requestId,
          eventAt: new Date().toISOString(),
          timezone:
            command.followUp?.timezone ??
            config.notifications.external?.timezone ??
            "Asia/Shanghai",
          quoted: false,
          forwarded: false,
          producerKind: "original",
        },
      }).revision;
      return memory.commandTask({
        taskId: req.params.id,
        ...command,
        evidenceId: revision.fragments[0]!.id,
      });
    },
  );
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
  app.get("/api/jobs", async () =>
    store.db
      .prepare(
        // Recurring runs have their own board and must not crowd out material history.
        `SELECT id FROM jobs WHERE workspace_id='personal' AND kind!='scheduled_task'
    ORDER BY CASE WHEN state IN ('running','leased') THEN 0 WHEN state IN ('failed','retry_wait','awaiting_decision') THEN 1 WHEN state='queued' THEN 3 ELSE 2 END, created_at DESC LIMIT 200`,
      )
      .all()
      .map((row) => store.jobs.get(String(row.id))!)
      .map((job) => {
        const ref = job.inputRefs.find(
          (ref): ref is { revisionId: string } =>
            !!ref &&
            typeof ref === "object" &&
            "revisionId" in ref &&
            typeof ref.revisionId === "string",
        );
        const revision = ref?.revisionId
          ? store.revision(String(ref.revisionId))
          : null;
        const assignment = revision
          ? store.contexts.assignment(revision.sourceId)
          : null;
        return {
          ...job,
          materialTitle: revision?.title ?? null,
          evidenceId: revision?.fragments[0]?.id ?? null,
          sourceRevisionId: revision?.id ?? null,
          contextQuestion:
            job.kind === "extract_claims" &&
            job.state === "succeeded" &&
            assignment?.status === "ambiguous" &&
            assignment.revisionId === revision?.id
              ? assignment.question
              : null,
        };
      }),
  );
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
  app.get("/api/quality/datasets", async () => quality.datasets());
  app.get<{ Params: { id: string } }>(
    "/api/quality/datasets/:id/samples",
    async (req) => quality.samples(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/quality/samples/:id/revise",
    async (req) => {
      const body = z
        .object({
          expectedLabelDigest: z.string().regex(/^[a-f0-9]{64}$/),
          label: qualityLabelSchema,
        })
        .strict()
        .parse(req.body);
      return quality.revise({ sampleId: req.params.id, ...body });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/quality/datasets/:id/freeze",
    async (req) => quality.freeze(req.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/quality/datasets/:id/annotation-session",
    async (req) => {
      if (!larkRuntime) throw Error("LARK_RUNTIME_NOT_CONFIGURED");
      const body = z
        .object({
          appId: z
            .string()
            .regex(/^cli_[a-zA-Z0-9]+$/)
            .optional(),
          resend: z.boolean().default(false),
        })
        .strict()
        .parse(req.body ?? {});
      return larkRuntime.quality.start(req.params.id, body.appId, {
        resend: body.resend,
      });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/quality/annotation-sessions/:id/cancel",
    async (req) => {
      if (!larkRuntime) throw Error("LARK_RUNTIME_NOT_CONFIGURED");
      return larkRuntime.quality.cancel(req.params.id);
    },
  );
  app.post("/api/integrations/lark/onboarding", async (req) =>
    requireLark().start(larkOnboardingStartSchema.parse(req.body)),
  );
  app.get<{ Params: { id: string } }>(
    "/api/integrations/lark/onboarding/:id",
    async (req) => requireLark().status(req.params.id),
  );
  app.get("/api/integrations/lark/onboardings", async () =>
    requireLark().pending(),
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
  const probes = new Map<string, ReturnType<typeof acp>>();
  app.post<{ Params: { id: string } }>(
    "/api/profiles/:id/probe",
    async (req) => {
      const p = config.profiles.find((p) => p.id === req.params.id);
      if (!p) throw Error("Profile not found");
      if (p.transport !== "acp")
        return {
          configOptions: [],
          note: "此接入使用 CLI；模型与思考强度由已安装的 CLI 校验，未提供自动能力列表。",
        };
      const current = probes.get(p.id);
      if (current) return current;
      const pending = acp(
        p,
        config.agentCwd,
        null,
        () => {},
        new AbortController().signal,
      );
      probes.set(p.id, pending);
      try {
        return await pending;
      } finally {
        if (probes.get(p.id) === pending) probes.delete(p.id);
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
  app.post("/api/assistant/conversations", async (req) => {
    const body = z
      .object({
        chatId: z.string().min(1).max(200),
        threadId: z.string().max(200).nullish(),
        // C: web callers cannot assert a Lark channel, group visibility, or choose
        // the principal. The server owns these; a forged lark_*/group request is a
        // 400. Lark conversations are opened only by the trusted LarkRuntimeHost.
        principalId: z.string().max(200).optional(),
        channel: z.enum(["web", "lark_p2p", "lark_group"]).optional(),
        visibility: z.enum(["private", "group"]).optional(),
      })
      .strict()
      .parse(req.body);
    if (body.channel === "lark_p2p" || body.channel === "lark_group")
      throw Error("WEB_CANNOT_FORGE_LARK_CHANNEL");
    if (body.visibility === "group")
      throw Error("WEB_CANNOT_FORGE_GROUP_VISIBILITY");
    return assistant.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: body.chatId,
      threadId: body.threadId ?? null,
      visibility: "private",
    });
  });
  app.post<{ Params: { id: string } }>(
    "/api/assistant/conversations/:id/turns",
    async (req, reply) => {
      const body = z
        .object({
          text: str,
          requestId: z.string().min(1).max(200).optional(),
          mode: z.enum(["assist", "research"]).optional(),
          purpose: z.enum(retrievalPurposes).optional(),
        })
        .strict()
        .parse(req.body);
      const result = await assistant.turn({
        conversationId: req.params.id,
        userText: body.text,
        transportEventId: body.requestId ? `web:${body.requestId}` : null,
        mode: body.mode,
        purpose: body.purpose,
      });
      if (!result.conversation)
        return reply.code(404).send({ error: "Conversation not found" });
      return result;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/assistant/conversations/:id/turns",
    async (req, reply) =>
      assistant.conversations.get(req.params.id)
        ? assistant.conversations.turns(req.params.id)
        : reply.code(404).send({ error: "Conversation not found" }),
  );
  app.post<{ Params: { id: string; turnId: string } }>(
    "/api/assistant/conversations/:id/turns/:turnId/cancel",
    async (req, reply) => {
      const conversation = assistant.conversations.get(req.params.id);
      if (!conversation)
        return reply.code(404).send({ error: "Conversation not found" });
      const ok = assistant.cancelTurn(req.params.turnId);
      return ok
        ? { ok: true }
        : reply.code(404).send({ error: "Turn not found" });
    },
  );
  app.post<{ Params: { id: string; turnId: string } }>(
    "/api/assistant/conversations/:id/turns/:turnId/retry",
    async (req, reply) => {
      const conversation = assistant.conversations.get(req.params.id);
      if (!conversation)
        return reply.code(404).send({ error: "Conversation not found" });
      const result = await assistant.retryTurn(req.params.turnId);
      return result.ok ? result : reply.code(409).send(result);
    },
  );
  const web = assetPath("apps/web/dist");
  if (existsSync(web))
    await app.register(staticFiles, { root: web, prefix: "/" });
  // G20: recover any pending/running turns from a previous process.
  // Recovery can involve long native investigation. Start once in the
  // background so health, cancellation and persisted progress stay reachable.
  const recovery = assistant
    .recoverUnfinishedTurns()
    .catch((error) => app.log.error(error));
  const tick = setInterval(() => {
    store.remind();
    reminderLastCheckedAt = new Date().toISOString();
  }, 30000);
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
  personalLark.start();
  schedules.start();
  learning?.start();
  larkRuntime?.start();
  app.addHook("onClose", async () => {
    await schedules.stop();
    await personalLark.stop();
    await decisions.close();
    assistant.shutdown();
    await recovery;
    clearInterval(tick);
    clearInterval(inputTick);
    await learning?.stop();
    await larkRuntime?.stop();
    await runs.close();
    await retrievalService.close();
    store.close();
  });
  return {
    app,
    store,
    runs,
    memory,
    feedback,
    quality,
    learning,
    lark,
    larkRuntime,
    assistant,
    work,
    personalLark,
    schedules,
    brief,
  };
}
