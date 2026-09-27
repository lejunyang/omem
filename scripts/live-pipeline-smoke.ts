import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LearningPipeline } from "../apps/server/src/learning/pipeline.js";
import { loadConfig } from "../apps/server/src/config.js";
import {
  FeedbackService,
  MemoryService,
} from "../apps/server/src/memory/service.js";
import { Store } from "../apps/server/src/store.js";
import { selectLiveProfile } from "./live-model.js";

const config = loadConfig();
const configured = config.profiles.find((profile) => profile.id === "traex");
if (!configured) throw Error("TraeX profile is not configured");
const { profile } = await selectLiveProfile(configured, config.agentCwd);
const directory = mkdtempSync(join(tmpdir(), "omem-live-pipeline-"));
const store = new Store(directory);
try {
  const captured = store.capture({
    source: "manual",
    externalId: "live-pipeline-source",
    title: "支付重试任务",
    observedAt: "2026-09-22T08:00:00Z",
    parts: [
      {
        type: "text",
        text: "我负责在本周五18:00前补齐支付重试方案，先核对现有接口。",
      },
    ],
    context: { application: "payments" },
    provenance: {
      collectorId: "live-pipeline-smoke",
      actorId: "owner",
      actorType: "owner",
      actorVerifiedBy: "local-live-test",
      sourceUri: null,
      eventId: "live-pipeline-event-1",
      eventAt: "2026-09-22T08:00:00Z",
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  });
  const memory = new MemoryService(store, { ownerId: "owner" });
  const pipeline = new LearningPipeline({
    store,
    memory,
    feedback: new FeedbackService(store),
    profile,
    workspaceRoot: config.agentCwd,
    workerId: "live-pipeline-worker",
  });
  const processed = await pipeline.drain(10);
  await pipeline.stop();
  const jobs = store.jobs.list();
  const proposals = memory.proposals();
  const tasks = store.tasks();
  const attempts = jobs.flatMap((job) => store.jobs.attempts(job.id));
  if (
    processed !== 2 ||
    jobs.some((job) => job.state !== "succeeded") ||
    proposals.length !== 1 ||
    proposals[0]?.state !== "applied" ||
    tasks.length !== 1
  )
    throw Error("Live controlled pipeline did not produce one applied task");
  const report = {
    createdAt: new Date().toISOString(),
    requestedModel: profile.model ?? null,
    requestedEffort: profile.effort ?? null,
    effectiveModels: [...new Set(attempts.map((attempt) => attempt.model))],
    effectiveEfforts: [...new Set(attempts.map((attempt) => attempt.effort))],
    capturedRevisionId: captured.revision.id,
    processed,
    jobs: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      state: job.state,
      attempts: attempts.filter((attempt) => attempt.jobId === job.id),
    })),
    proposals,
    tasks,
    notificationCount: store.notifications().length,
  };
  const reportPath = resolve(
    process.env.OMEM_LIVE_PIPELINE_REPORT ||
      ".omem/verification/live-pipeline-smoke.json",
  );
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        reportPath,
        requestedModel: report.requestedModel,
        requestedEffort: report.requestedEffort,
        effectiveModels: report.effectiveModels,
        effectiveEfforts: report.effectiveEfforts,
        processed,
        jobStates: jobs.map((job) => `${job.kind}:${job.state}`),
        proposalState: proposals[0]?.state,
        taskCount: tasks.length,
        notificationCount: report.notificationCount,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
