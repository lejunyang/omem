import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { profileSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../src/app.js";
import { FeedbackService, MemoryService } from "../src/memory/service.js";
import { LearningPipeline } from "../src/learning/pipeline.js";
import { Store } from "../src/store.js";

const directories: string[] = [];
const temporary = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const fixtureAgent = resolve("apps/server/tests/fixtures/role-acp-agent.mjs");
const profile = (args: string[] = [fixtureAgent]) =>
  profileSchema.parse({
    id: "traex",
    name: "Learning pipeline fixture",
    transport: "acp",
    command: process.execPath,
    args,
    timeoutMs: 3000,
  });

const capture = (store: Store, externalId = "pipeline-source") =>
  store.capture({
    source: "manual",
    externalId,
    title: "Controlled worker input",
    parts: [{ type: "text", text: "PIPELINE_TASK" }],
    context: { application: "pipeline-test" },
    provenance: {
      collectorId: "pipeline-test",
      actorId: "owner",
      actorType: "owner",
      actorVerifiedBy: "authenticated-test",
      sourceUri: null,
      eventId: `${externalId}-event`,
      eventAt: "2026-09-27T08:00:00+08:00",
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  });

const pipeline = (store: Store, workspaceRoot: string, selected = profile()) =>
  new LearningPipeline({
    store,
    memory: new MemoryService(store, { ownerId: "owner" }),
    feedback: new FeedbackService(store),
    profile: selected,
    workspaceRoot,
    pollMs: 20,
  });

describe("B2-08 controlled learning pipeline", () => {
  it("runs capture through independent extractor/verifier sessions and atomic application", async () => {
    const directory = temporary("omem-learning-app-");
    const built = await buildApp({
      dataDir: directory,
      agentCwd: join(directory, "agent"),
      host: "127.0.0.1",
      port: 0,
      token: undefined,
      captureRoots: [],
      notifications: { mode: "instant" },
      learning: { enabled: true, profileId: "traex", pollMs: 20 },
      profiles: [profile()],
    });
    try {
      const response = await built.app.inject({
        method: "POST",
        url: "/api/captures",
        payload: {
          source: "manual",
          externalId: "pipeline-http",
          title: "Controlled worker input",
          parts: [{ type: "text", text: "PIPELINE_TASK" }],
          context: { application: "pipeline-test" },
          provenance: {
            collectorId: "pipeline-test",
            actorId: "owner",
            actorType: "owner",
            actorVerifiedBy: "authenticated-test",
            sourceUri: null,
            eventId: "pipeline-http-event",
            eventAt: "2026-09-27T08:00:00+08:00",
            timezone: "Asia/Shanghai",
            quoted: false,
            forwarded: false,
            producerKind: "original",
          },
        },
      });
      expect(response.statusCode).toBe(200);
      for (let index = 0; index < 200 && !built.store.tasks().length; index++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(built.store.tasks()).toMatchObject([
        {
          title: "完成受控 worker 集成",
          ownerId: "owner",
          nextStep: "核对持久回执",
        },
      ]);
      const jobs = built.store.jobs.list();
      expect(jobs).toHaveLength(2);
      expect(jobs.map((job) => job.kind).sort()).toEqual([
        "extract_claims",
        "verify_proposals",
      ]);
      expect(jobs.every((job) => job.state === "succeeded")).toBe(true);
      const sessions = jobs.flatMap((job) =>
        built.store.jobs.attempts(job.id).map((attempt) => attempt.sessionId),
      );
      expect(sessions).toHaveLength(2);
      expect(new Set(sessions).size).toBe(2);
      expect(built.memory.proposals()).toMatchObject([
        {
          state: "applied",
          policyResult: { outcome: "auto_apply" },
          origin: { job_id: response.json().job.id },
        },
      ]);
      expect(
        Number(
          (
            built.store.db
              .prepare("SELECT count(*) AS count FROM application_receipts")
              .get() as { count: number }
          ).count,
        ),
      ).toBe(1);
      expect(
        (await built.app.inject("/api/health")).json().learning,
      ).toMatchObject({ running: true, lastError: null });
    } finally {
      await built.app.close();
    }
  });

  it("resumes a persisted verifier job after restart without duplicate effects", async () => {
    const directory = temporary("omem-learning-restart-");
    let store = new Store(directory);
    const captured = capture(store, "pipeline-restart");
    const first = pipeline(store, join(directory, "agent-first"));
    expect((await first.processOne()).processed).toBe(true);
    expect(store.jobs.get(captured.job!.id)?.state).toBe("succeeded");
    expect(store.jobs.list()).toHaveLength(2);
    expect(store.tasks()).toEqual([]);
    await first.stop();
    store.close();

    store = new Store(directory);
    try {
      const restarted = pipeline(store, join(directory, "agent-second"));
      expect(await restarted.drain()).toBe(1);
      expect(store.tasks()).toHaveLength(1);
      expect(store.jobs.list().every((job) => job.state === "succeeded")).toBe(
        true,
      );
      expect(
        Number(
          (
            store.db
              .prepare("SELECT count(*) AS count FROM application_receipts")
              .get() as { count: number }
          ).count,
        ),
      ).toBe(1);
      const extraction = store.jobs
        .list()
        .find((job) => job.kind === "extract_claims")!;
      store.jobs.enqueue({
        kind: "verify_proposals",
        inputRefs: [
          {
            roleOutputId: extraction.resultRef,
            extractionJobId: extraction.id,
            replay: true,
          },
          ...extraction.inputRefs,
        ],
        roleVersion: "verifier@1",
        policyVersion: extraction.policyVersion,
        parentJobId: extraction.id,
        cause: "crash_replay",
      });
      expect(await restarted.drain()).toBe(1);
      expect(store.tasks()).toHaveLength(1);
      expect(
        Number(
          (
            store.db
              .prepare("SELECT count(*) AS count FROM application_receipts")
              .get() as { count: number }
          ).count,
        ),
      ).toBe(1);
      await restarted.stop();
    } finally {
      store.close();
    }
  });

  it("rejects stale input and preserves graceful shutdown as retryable", async () => {
    const directory = temporary("omem-learning-stale-");
    const store = new Store(directory);
    try {
      const stale = capture(store, "pipeline-stale");
      store.capture({
        source: "manual",
        externalId: "pipeline-stale",
        title: "Controlled worker input v2",
        parts: [
          { type: "text", text: "PIPELINE_TASK" },
          { type: "text", text: "new source context" },
        ],
        context: { application: "pipeline-test" },
        provenance: {
          collectorId: "pipeline-test",
          actorId: "owner",
          actorType: "owner",
          actorVerifiedBy: "authenticated-test",
          sourceUri: null,
          eventId: "pipeline-stale-event-v2",
          eventAt: "2026-09-27T08:01:00+08:00",
          timezone: "Asia/Shanghai",
          quoted: false,
          forwarded: false,
          producerKind: "original",
        },
      });
      const running = pipeline(store, join(directory, "agent-stale"));
      await running.processOne();
      expect(store.jobs.get(stale.job!.id)).toMatchObject({
        state: "failed",
        lastError: "STALE_JOB_INPUT",
      });
      await running.drain();
      expect(store.tasks()).toHaveLength(1);
      await running.stop();

      const timeoutCapture = store.capture({
        source: "manual",
        externalId: "pipeline-timeout",
        title: "Interrupted worker",
        parts: [{ type: "text", text: "TIMEOUT" }],
        context: {},
      });
      const stopping = pipeline(
        store,
        join(directory, "agent-stop"),
        profile([fixtureAgent]),
      );
      stopping.start();
      for (
        let index = 0;
        index < 100 &&
        !["leased", "running"].includes(
          store.jobs.get(timeoutCapture.job!.id)?.state || "",
        );
        index++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      await stopping.stop();
      expect(store.jobs.get(timeoutCapture.job!.id)).toMatchObject({
        state: "retry_wait",
        errorKind: "transient",
      });
    } finally {
      store.close();
    }
  });
});
