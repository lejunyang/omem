import type { JobAttemptFingerprint } from "../../../../packages/contracts/src/index.js";
import {
  JobRepository,
  type JobFailureKind,
  type JobLease,
} from "./repository.js";
import {
  errorSummary,
  getLogger,
  withLogContext,
  type LogContext,
} from "../logging/logger.js";

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
      kinds?: string[];
      jobIds?: string[];
    },
  ) {}

  async processOne() {
    const now = this.options.now ?? (() => new Date());
    const leaseMs = this.options.leaseMs ?? 60_000;
    const lease = this.repository.claimNext({
      workerId: this.workerId,
      kinds: this.options.kinds,
      jobIds: this.options.jobIds,
      fingerprint: this.options.fingerprint(),
      leaseMs,
      now: now(),
    });
    if (!lease) return { processed: false as const };
    const identifiers: LogContext = { jobId: lease.id, jobKind: lease.kind };
    for (const ref of lease.inputRefs) {
      if (!ref || typeof ref !== "object") continue;
      for (const key of ["sourceId", "revisionId", "messageId"] as const) {
        const value = (ref as Record<string, unknown>)[key];
        if (typeof value === "string" && !identifiers[key])
          identifiers[key] = value;
      }
    }
    const logger = getLogger({ ...identifiers, component: "worker" });
    const startedAt = performance.now();
    logger.debug(
      { event: "job.started", attempt: lease.attempt, workerId: this.workerId },
      "job.started",
    );
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
      logger.error(
        {
          event: "job.failed",
          attempt: lease.attempt,
          state: job.state,
          failureKind: "config",
          reason: "handler_not_registered",
        },
        "job.failed",
      );
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
        } catch (error) {
          logger.warn(
            { event: "job.heartbeat_failed", error: errorSummary(error) },
            "job.heartbeat_failed",
          );
          controller.abort();
        }
      }, heartbeatMs);
      heartbeat.unref();
    }
    try {
      const result = await withLogContext(identifiers, () =>
        handler(lease, controller.signal),
      );
      const job = this.repository.succeed({
        jobId: lease.id,
        leaseToken: lease.leaseToken,
        resultRef: result.resultRef,
        usage: result.usage,
        now: now(),
      });
      logger.info(
        {
          event: "job.completed",
          attempt: lease.attempt,
          elapsedMs: Math.round(performance.now() - startedAt),
          state: job.state,
        },
        "job.completed",
      );
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
        logger.warn(
          {
            event: "job.failed",
            attempt: lease.attempt,
            elapsedMs: Math.round(performance.now() - startedAt),
            state: job.state,
            failureKind: job.errorKind,
            error: errorSummary(error),
          },
          "job.failed",
        );
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
