import type { JobAttemptFingerprint } from "../../../../packages/contracts/src/index.js";
import {
  JobRepository,
  type JobFailureKind,
  type JobLease,
} from "./repository.js";

export class JobExecutionError extends Error {
  constructor(
    message: string,
    readonly kind: JobFailureKind,
  ) {
    super(message);
    this.name = "JobExecutionError";
  }
}

export type JobHandlerResult = {
  resultRef?: string | null;
  usage?: Record<string, unknown>;
};

export type JobHandler = (
  job: JobLease,
  signal: AbortSignal,
) => Promise<JobHandlerResult>;

export class DurableJobWorker {
  private readonly active = new Map<string, AbortController>();
  private stopping = false;

  constructor(
    readonly repository: JobRepository,
    readonly workerId: string,
    private readonly handlers: Record<string, JobHandler>,
    private readonly options: {
      fingerprint: () => JobAttemptFingerprint;
      leaseMs?: number;
      heartbeatMs?: number;
      retryBaseMs?: number;
      now?: () => Date;
    },
  ) {}

  async processOne() {
    const now = this.options.now ?? (() => new Date());
    const leaseMs = this.options.leaseMs ?? 60_000;
    const lease = this.repository.claimNext({
      workerId: this.workerId,
      fingerprint: this.options.fingerprint(),
      leaseMs,
      now: now(),
    });
    if (!lease) return { processed: false as const };
    const handler = this.handlers[lease.kind];
    if (!handler) {
      this.repository.markRunning(lease.id, lease.leaseToken, now());
      const job = this.repository.fail({
        jobId: lease.id,
        leaseToken: lease.leaseToken,
        kind: "config",
        message: `No handler registered for job kind ${lease.kind}`,
        now: now(),
      });
      return { processed: true as const, job };
    }

    const controller = new AbortController();
    this.active.set(lease.id, controller);
    this.repository.markRunning(lease.id, lease.leaseToken, now());
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const heartbeatMs = this.options.heartbeatMs ?? Math.max(1000, leaseMs / 3);
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        try {
          this.repository.heartbeat(lease.id, lease.leaseToken, now(), leaseMs);
        } catch {
          controller.abort();
        }
      }, heartbeatMs);
      heartbeat.unref();
    }
    try {
      const result = await handler(lease, controller.signal);
      const job = this.repository.succeed({
        jobId: lease.id,
        leaseToken: lease.leaseToken,
        resultRef: result.resultRef,
        usage: result.usage,
        now: now(),
      });
      return { processed: true as const, job };
    } catch (error) {
      const failure =
        error instanceof JobExecutionError
          ? error
          : new JobExecutionError(
              error instanceof Error ? error.message : "Job execution failed",
              controller.signal.aborted ? "cancelled" : "permanent",
            );
      try {
        const interruptedByShutdown =
          controller.signal.aborted && this.stopping;
        const job = this.repository.fail({
          jobId: lease.id,
          leaseToken: lease.leaseToken,
          kind: interruptedByShutdown
            ? "transient"
            : controller.signal.aborted
              ? "cancelled"
              : failure.kind,
          message: interruptedByShutdown
            ? "Worker stopped before completion"
            : failure.message,
          now: now(),
          retryBaseMs: this.options.retryBaseMs,
        });
        return { processed: true as const, job };
      } catch (finishError) {
        if (
          finishError instanceof Error &&
          finishError.message === "STALE_JOB_LEASE"
        )
          return { processed: true as const, stale: true as const };
        throw finishError;
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.active.delete(lease.id);
    }
  }

  cancel(input: {
    jobId: string;
    expectedGeneration: number;
    requestId: string;
    workspaceId?: string;
  }) {
    const result = this.repository.cancel(input);
    if (result.mode === "cancelling") this.active.get(input.jobId)?.abort();
    return result;
  }

  stop() {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort();
  }
}
