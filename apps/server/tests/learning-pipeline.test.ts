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
  it("returns task-owner feedback to the native agent so responsibility survives as a fact", async () => {
    const directory = temporary("omem-learning-responsibility-");
    const store = new Store(directory);
    const worker = pipeline(store, join(directory, "agent"), profile([fixtureAgent, "--repair-foreign-task"]));
    try {
      capture(store);
      await worker.drain();
      expect(store.jobs.list().every(job => job.state === "succeeded")).toBe(true);
      expect(store.tasks()).toEqual([]);
      const rows = store.db.prepare("SELECT m.kind,r.body FROM memories m JOIN memory_revisions r ON r.id=m.head_revision_id").all();
      expect(rows).toMatchObject([{ kind: "claim", body: expect.stringContaining("同事负责这次集成") }]);
      const assessment = store.db.prepare("SELECT details FROM evidence_assessments").get();
      expect(JSON.parse(String(assessment?.details))).toMatchObject({
        uncertaintyReview: { verdict: "non_blocking", reason: "具体方案不影响明确陈述的负责人事实。" },
        missingContext: [],
      });
    } finally { await worker.stop(); store.close(); }
  });

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

describe("F: G17 evaluateBatch wired into the real verify path", () => {
  const captureBatch = (store: Store, text: string, externalId: string) =>
    store.capture({
      source: "manual",
      externalId,
      title: "Batch source",
      parts: [{ type: "text", text }],
      context: { application: "batch-test" },
      provenance: {
        collectorId: "batch-test",
        actorId: "owner",
        actorType: "owner",
        actorVerifiedBy: "authenticated-test",
        sourceUri: null,
        eventId: `${externalId}-event`,
        eventAt: "2026-09-27T10:00:00+08:00",
        timezone: "Asia/Shanghai",
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    });

  it("gates 12 distinct creates as one ChangeSet: parked, one AttentionCase, nothing applied", async () => {
    const directory = temporary("omem-batch-distinct-");
    const store = new Store(directory);
    try {
      captureBatch(store, "BATCH_CREATE_DISTINCT", "batch-distinct");
      const p = pipeline(store, join(directory, "agent-distinct"));
      expect(await p.drain()).toBe(2);
      await p.stop();
      // The whole ChangeSet reached evaluateBatch as 12 proposals.
      const proposals = store.db
        .prepare("SELECT state FROM proposals ORDER BY id")
        .all() as { state: string }[];
      expect(proposals).toHaveLength(12);
      // None auto-applied: every would-be-auto-apply create is parked.
      expect(
        proposals.every((row) => row.state === "awaiting_decision"),
      ).toBe(true);
      // Exactly ONE consolidated AttentionCase, not 12 cards.
      const decisionRows = store.db
        .prepare("SELECT attention_case FROM decisions ORDER BY created_at")
        .all() as { attention_case: string }[];
      expect(decisionRows).toHaveLength(1);
      const attentionCase = JSON.parse(decisionRows[0]!.attention_case);
      expect(attentionCase.topic).toContain("批量变更");
      expect(String(attentionCase.question).length).toBeGreaterThan(0);
      expect(Array.isArray(attentionCase.options)).toBe(true);
      expect(attentionCase.options.length).toBeGreaterThan(0);
      expect(String(attentionCase.attemptedResolution).length).toBeGreaterThan(0);
      expect(Array.isArray(attentionCase.evidenceRefs)).toBe(true);
      expect(attentionCase.evidenceRefs.length).toBeGreaterThan(0);
      expect(String(attentionCase.dedupeKey)).toContain("attention-batch");
      // Nothing materialized: the gate blocked the whole over-budget batch.
      expect(
        Number(
          (
            store.db
              .prepare("SELECT count(*) AS c FROM application_receipts")
              .get() as { c: number }
          ).c,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            store.db
              .prepare(
                "SELECT count(*) AS c FROM memories WHERE status='active'",
              )
              .get() as { c: number }
          ).c,
        ),
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  it("dedupes 12 same-entity creates to impact=1: auto-applied, no AttentionCase", async () => {
    const directory = temporary("omem-batch-same-");
    const store = new Store(directory);
    try {
      captureBatch(store, "BATCH_CREATE_SAME", "batch-same");
      const p = pipeline(store, join(directory, "agent-same"));
      expect(await p.drain()).toBe(2);
      await p.stop();
      const states = store.db
        .prepare("SELECT state FROM proposals ORDER BY id")
        .all() as { state: string }[];
      expect(states).toHaveLength(12);
      // One new memory applied; the other 11 same-statement creates are retained as
      // duplicates (de-duplicated impact=1, under budget, no card).
      expect(states.filter((row) => row.state === "applied")).toHaveLength(1);
      expect(states.filter((row) => row.state === "retained")).toHaveLength(11);
      expect(
        Number(
          (
            store.db
              .prepare("SELECT count(*) AS c FROM decisions")
              .get() as { c: number }
          ).c,
        ),
      ).toBe(0);
      expect(
        Number(
          (
            store.db
              .prepare(
                "SELECT count(*) AS c FROM memories WHERE status='active' AND kind='claim'",
              )
              .get() as { c: number }
          ).c,
        ),
      ).toBe(1);
    } finally {
      store.close();
    }
  });
});

it("leaves knowledge-role work for the knowledge worker", async () => {
  const directory = temporary("omem-learning-kind-isolation-");
  const store = new Store(directory);
  const p = pipeline(store, join(directory, "agents"));
  try {
    const { job } = store.jobs.enqueue({ kind: "knowledge:code-analyst", inputRefs: ["fixed-material"], roleVersion: "1", policyVersion: "knowledge@1" });
    expect(await p.drain()).toBe(0);
    expect(store.jobs.get(job.id)?.state).toBe("queued");
    expect(store.jobs.attempts(job.id)).toHaveLength(0);
  } finally { await p.stop(); store.close(); }
});
