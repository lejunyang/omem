import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobAttemptFingerprint } from "../../../packages/contracts/src/index.js";
import { Store } from "../src/store.js";
import { DurableJobWorker, JobExecutionError } from "../src/jobs/worker.js";

const resources: { store: Store; directory: string }[] = [];
const setup = (directory = mkdtempSync(join(tmpdir(), "omem-jobs-"))) => {
  const store = new Store(directory);
  resources.push({ store, directory });
  return store;
};

afterEach(() => {
  const directories = new Set<string>();
  for (const resource of resources.splice(0)) {
    resource.store.close();
    directories.add(resource.directory);
  }
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const fingerprint = (version: string): JobAttemptFingerprint => ({
  model: `model-${version}`,
  effort: version === "v1" ? "low" : "high",
  promptHash: hash(`prompt-${version}`),
  skillHash: hash(`skill-${version}`),
  toolHash: hash(`tool-${version}`),
});
const enqueue = (store: Store, kind: string) =>
  store.jobs.enqueue({
    kind,
    inputRefs: [{ revisionId: `revision-${kind}` }],
    roleVersion: "extractor@1",
    policyVersion: "policy@1",
  }).job;
const scalar = (store: Store, table: string) =>
  Number(
    (
      store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );

describe("B2-02 durable job acceptance", () => {
  it("A-J01 commits capture and queued work before a worker exists, then resumes after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-jobs-restart-"));
    const first = setup(directory);
    const input = {
      source: "manual",
      externalId: "restart-source",
      title: "Restart evidence",
      parts: [{ type: "text", text: "persist before worker" }],
      context: {},
    } as const;
    first.db.exec(
      `CREATE TRIGGER inject_enqueue_failure BEFORE INSERT ON jobs
       BEGIN SELECT RAISE(ABORT,'injected enqueue failure'); END;`,
    );
    expect(() => first.capture(input)).toThrow("injected enqueue failure");
    expect(first.list()).toHaveLength(0);
    expect(first.notifications()).toHaveLength(0);
    first.db.exec("DROP TRIGGER inject_enqueue_failure");
    const captured = first.capture(input);
    expect(captured.job).toMatchObject({
      state: "queued",
      kind: "extract_claims",
    });
    const jobId = captured.job!.id;
    first.close();
    resources.splice(
      resources.findIndex((resource) => resource.store === first),
      1,
    );

    const second = setup(directory);
    let calls = 0;
    const worker = new DurableJobWorker(
      second.jobs,
      "restart-worker",
      {
        extract_claims: async () => {
          calls++;
          return { resultRef: "result-after-restart" };
        },
      },
      { fingerprint: () => fingerprint("v1"), heartbeatMs: 0 },
    );
    expect((await worker.processOne()).processed).toBe(true);
    expect(calls).toBe(1);
    expect(second.jobs.get(jobId)).toMatchObject({
      state: "succeeded",
      resultRef: "result-after-restart",
    });
    expect(second.revision(captured.revision.id)?.fragments[0]?.text).toBe(
      "persist before worker",
    );
  });

  it("A-J02 grants one lease to two competing workers and applies once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omem-jobs-race-"));
    const first = setup(directory);
    const second = setup(directory);
    const job = enqueue(first, "race");
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const releasePromise = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const handler = async () => {
      calls++;
      started();
      await releasePromise;
      const receipt = first.applications.applyTask({
        metadata: {
          workspaceId: "personal",
          applicationId: job.id,
          proposalDigest: hash(job.id),
          generation: 1,
          title: "single application",
          details: "two workers raced",
          delivery: {
            channelBindingVersion: 1,
            channel: "in_app",
            target: "notification-center",
          },
        },
        task: { title: "once", detail: "", nextStep: "done" },
      });
      return { resultRef: receipt.id };
    };
    const workerA = new DurableJobWorker(
      first.jobs,
      "worker-a",
      { race: handler },
      { fingerprint: () => fingerprint("v1"), heartbeatMs: 0 },
    );
    const workerB = new DurableJobWorker(
      second.jobs,
      "worker-b",
      { race: handler },
      { fingerprint: () => fingerprint("v1"), heartbeatMs: 0 },
    );
    const running = workerA.processOne();
    await startedPromise;
    expect(await workerB.processOne()).toEqual({ processed: false });
    release();
    await running;
    expect(calls).toBe(1);
    expect(first.jobs.attempts(job.id)).toHaveLength(1);
    expect(scalar(first, "application_receipts")).toBe(1);
    expect(scalar(first, "tasks")).toBe(1);
  });

  it("A-J03 rejects a late result after lease expiry and fencing-token replacement", () => {
    const store = setup();
    const job = enqueue(store, "fencing");
    const start = new Date(job.notBefore);
    const oldLease = store.jobs.claimNext({
      workerId: "old-worker",
      fingerprint: fingerprint("v1"),
      now: start,
      leaseMs: 100,
    })!;
    store.jobs.markRunning(job.id, oldLease.leaseToken, start);
    const replacement = store.jobs.claimNext({
      workerId: "new-worker",
      fingerprint: fingerprint("v1"),
      now: new Date(start.getTime() + 101),
      leaseMs: 100,
    })!;
    expect(replacement.leaseToken).not.toBe(oldLease.leaseToken);
    expect(() =>
      store.jobs.succeed({
        jobId: job.id,
        leaseToken: oldLease.leaseToken,
        now: new Date(start.getTime() + 102),
      }),
    ).toThrow("STALE_JOB_LEASE");
    store.jobs.markRunning(
      job.id,
      replacement.leaseToken,
      new Date(start.getTime() + 102),
    );
    store.jobs.succeed({
      jobId: job.id,
      leaseToken: replacement.leaseToken,
      resultRef: "new-result",
      now: new Date(start.getTime() + 103),
    });
    expect(store.jobs.get(job.id)).toMatchObject({
      state: "succeeded",
      resultRef: "new-result",
    });
    expect(
      store.jobs.attempts(job.id).map((attempt) => attempt.outcome),
    ).toEqual(["lease_expired", "succeeded"]);
  });

  it("A-J04 bounds transient and bad-output retries while stopping auth retries", async () => {
    const store = setup();
    const transient = enqueue(store, "transient");
    const badOutput = enqueue(store, "bad-output");
    const auth = enqueue(store, "auth");
    const calls = { transient: 0, bad: 0, auth: 0 };
    const worker = new DurableJobWorker(
      store.jobs,
      "retry-worker",
      {
        transient: async () => {
          calls.transient++;
          throw new JobExecutionError("temporary network failure", "transient");
        },
        "bad-output": async () => {
          calls.bad++;
          throw new JobExecutionError("invalid JSON", "bad_output");
        },
        auth: async () => {
          calls.auth++;
          throw new JobExecutionError(
            "authentication required token=sk-this-must-never-persist",
            "auth",
          );
        },
      },
      {
        fingerprint: () => fingerprint("v1"),
        heartbeatMs: 0,
        retryBaseMs: 0,
      },
    );
    for (let index = 0; index < 6; index++) await worker.processOne();
    expect(store.jobs.get(transient.id)?.state).toBe("failed");
    expect(store.jobs.get(badOutput.id)?.state).toBe("failed");
    expect(store.jobs.get(auth.id)?.state).toBe("failed");
    expect(calls).toEqual({ transient: 3, bad: 2, auth: 1 });
    expect(store.jobs.attempts(transient.id)).toHaveLength(3);
    expect(store.jobs.attempts(badOutput.id)).toHaveLength(2);
    expect(store.jobs.attempts(auth.id)).toHaveLength(1);
    expect(store.jobs.get(auth.id)?.lastError).not.toContain(
      "sk-this-must-never-persist",
    );
    expect((await worker.processOne()).processed).toBe(false);
  });

  it("A-J05 cancels queued/running jobs and requires compensation after apply", async () => {
    const store = setup();
    const queued = enqueue(store, "queued-cancel");
    expect(
      store.jobs.cancel({
        jobId: queued.id,
        expectedGeneration: 1,
        requestId: "cancel-queued",
      }),
    ).toEqual({ mode: "cancelled", state: "cancelled" });

    const running = enqueue(store, "running-cancel");
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const worker = new DurableJobWorker(
      store.jobs,
      "cancel-worker",
      {
        "running-cancel": async (_job, signal) => {
          started();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          throw new JobExecutionError("cancelled by owner", "cancelled");
        },
        applied: async (job) => {
          const receipt = store.applications.applyTask({
            metadata: {
              workspaceId: "personal",
              applicationId: job.id,
              proposalDigest: hash(job.id),
              generation: job.generation,
              title: "applied task",
              details: "application completed",
              delivery: {
                channelBindingVersion: 1,
                channel: "in_app",
                target: "notification-center",
              },
            },
            task: { title: "applied", detail: "", nextStep: "complete" },
          });
          return { resultRef: receipt.id };
        },
      },
      { fingerprint: () => fingerprint("v1"), heartbeatMs: 0 },
    );
    const processing = worker.processOne();
    await startedPromise;
    expect(
      worker.cancel({
        jobId: running.id,
        expectedGeneration: 1,
        requestId: "cancel-running",
      }),
    ).toEqual({ mode: "cancelling", state: "running" });
    await processing;
    expect(store.jobs.get(running.id)?.state).toBe("cancelled");

    const applied = enqueue(store, "applied");
    await worker.processOne();
    expect(store.jobs.get(applied.id)?.state).toBe("succeeded");
    expect(
      worker.cancel({
        jobId: applied.id,
        expectedGeneration: 1,
        requestId: "cancel-applied",
      }),
    ).toEqual({ mode: "compensation_required", state: "succeeded" });
    expect(scalar(store, "tasks")).toBe(1);
  });

  it("A-J06 replays a post-application crash without duplicate business effects", async () => {
    const store = setup();
    const job = enqueue(store, "crash-after-application");
    let executions = 0;
    const worker = new DurableJobWorker(
      store.jobs,
      "crash-worker",
      {
        "crash-after-application": async (lease) => {
          executions++;
          const receipt = store.applications.applyTask({
            metadata: {
              workspaceId: "personal",
              applicationId: lease.id,
              proposalDigest: hash(lease.id),
              generation: 1,
              title: "idempotent apply",
              details: "crash boundary",
              delivery: {
                channelBindingVersion: 1,
                channel: "in_app",
                target: "notification-center",
              },
            },
            task: { title: "one task", detail: "", nextStep: "verify" },
          });
          if (executions === 1)
            throw new JobExecutionError(
              "crash after application before job receipt",
              "transient",
            );
          expect(receipt.duplicate).toBe(true);
          return { resultRef: receipt.id };
        },
      },
      {
        fingerprint: () => fingerprint("v1"),
        heartbeatMs: 0,
        retryBaseMs: 0,
      },
    );
    await worker.processOne();
    expect(store.jobs.get(job.id)?.state).toBe("retry_wait");
    await worker.processOne();
    expect(store.jobs.get(job.id)?.state).toBe("succeeded");
    expect(executions).toBe(2);
    expect(scalar(store, "tasks")).toBe(1);
    expect(scalar(store, "application_receipts")).toBe(1);
    expect(scalar(store, "notifications")).toBe(1);
    expect(scalar(store, "delivery_intents")).toBe(1);
  });

  it("A-J07 creates a new generation and fingerprint without rewriting old attempts", async () => {
    const store = setup();
    const job = enqueue(store, "profile-change");
    const firstWorker = new DurableJobWorker(
      store.jobs,
      "profile-worker-v1",
      {
        "profile-change": async () => {
          throw new JobExecutionError("old credentials", "auth");
        },
      },
      { fingerprint: () => fingerprint("v1"), heartbeatMs: 0 },
    );
    await firstWorker.processOne();
    const oldAttempt = store.jobs.attempts(job.id)[0]!;
    expect(oldAttempt).toMatchObject({ generation: 1, errorKind: "auth" });
    const retried = store.jobs.retry({
      jobId: job.id,
      expectedGeneration: 1,
      requestId: "retry-with-new-profile",
    });
    expect(retried).toEqual({ state: "queued", generation: 2 });
    expect(
      store.jobs.retry({
        jobId: job.id,
        expectedGeneration: 1,
        requestId: "retry-with-new-profile",
      }),
    ).toEqual(retried);
    const secondWorker = new DurableJobWorker(
      store.jobs,
      "profile-worker-v2",
      { "profile-change": async () => ({ resultRef: "new-profile-result" }) },
      { fingerprint: () => fingerprint("v2"), heartbeatMs: 0 },
    );
    await secondWorker.processOne();
    const attempts = store.jobs.attempts(job.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(oldAttempt);
    expect(attempts[1]).toMatchObject({
      generation: 2,
      model: "model-v2",
      effort: "high",
      outcome: "succeeded",
    });
    expect(attempts[1]!.fingerprint).not.toBe(oldAttempt.fingerprint);
    expect(store.jobs.get(job.id)).toMatchObject({
      state: "succeeded",
      generation: 2,
      roleVersion: "extractor@1",
    });
  });
});
