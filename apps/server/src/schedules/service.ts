import { randomUUID } from "node:crypto";
import type {
  ScheduleResult,
  ScheduleRun,
  ScheduledTask,
} from "../../../../packages/contracts/src/schedules.js";
import type { JobRecord } from "../jobs/repository.js";
import { DurableJobWorker, JobExecutionError } from "../jobs/worker.js";
import { stableDigest } from "../storage/digest.js";
import type { Store } from "../store.js";
import { ScheduleRepository, SCHEDULE_JOB_KIND } from "./repository.js";
import { nextScheduleRun } from "./timing.js";

export type ScheduleOccurrence = ScheduleRun & {
  /** Call directly before synchronous application/outbox writes after any await. */
  assertCurrent: () => ScheduledTask;
};
export type ScheduleHandler = (
  task: ScheduledTask,
  signal: AbortSignal,
  occurrence: ScheduleOccurrence,
) => Promise<ScheduleResult>;
export type ScheduleServiceOptions = {
  now?: () => Date;
  pollMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  retryBaseMs?: number;
  historyLimit?: number;
  discoveryTemplate?: boolean;
  onSaved?: (task: ScheduledTask) => void;
  onDeleted?: (task: ScheduledTask) => void;
  onBackgroundError?: (error: unknown) => void;
};

export class ScheduleService {
  readonly repository: ScheduleRepository;
  private worker: DurableJobWorker;
  private timer?: ReturnType<typeof setInterval>;
  private processing?: Promise<void>;
  private started = false;

  constructor(
    readonly store: Store,
    private readonly handler: ScheduleHandler,
    private readonly options: ScheduleServiceOptions = {},
  ) {
    this.repository = new ScheduleRepository(store, nextScheduleRun, options);
    this.worker = this.createWorker();
  }

  private createWorker() {
    const hash = stableDigest("scheduled-task@1");
    return new DurableJobWorker(
      this.store.jobs,
      `schedule-${randomUUID()}`,
      {
        [SCHEDULE_JOB_KIND]: async (lease, signal) => {
          const run = this.repository.runForJob(lease.id);
          if (!run)
            throw new JobExecutionError(
              "定时任务的执行记录已不可用",
              "cancelled",
            );
          const assertCurrent = () => {
            if (signal.aborted)
              throw new JobExecutionError("定时任务执行已停止", "cancelled");
            try {
              return this.repository.assertCurrent(run, lease);
            } catch (error) {
              throw new JobExecutionError(
                error instanceof Error ? error.message : "定时任务已过期",
                "cancelled",
              );
            }
          };
          const task = assertCurrent();
          // A crash after saving the result must acknowledge the same occurrence.
          const persisted = this.repository.storedResult(run.id);
          if (persisted)
            return {
              resultRef: persisted.resultRef ?? run.id,
              usage: persisted.usage,
            };
          const result = await this.handler(task, signal, {
            ...run,
            assertCurrent,
          });
          assertCurrent();
          this.repository.recordResult(run, lease, result);
          return { resultRef: result.resultRef ?? run.id, usage: result.usage };
        },
      },
      {
        fingerprint: () => ({
          model: null,
          effort: null,
          promptHash: hash,
          skillHash: hash,
          toolHash: hash,
        }),
        kinds: [SCHEDULE_JOB_KIND],
        now: this.options.now,
        heartbeatMs: this.options.heartbeatMs,
        leaseMs: this.options.leaseMs,
        retryBaseMs: this.options.retryBaseMs,
      },
    );
  }

  list() {
    return this.repository.list();
  }
  get(id: string) {
    return this.repository.get(id);
  }

  private abortCancelled(jobs: JobRecord[]) {
    for (const job of jobs)
      this.worker.cancel({
        jobId: job.id,
        expectedGeneration: job.generation,
        requestId: `schedule-abort-${job.id}-${job.generation}`,
      });
  }

  save(input: unknown, id?: string) {
    if (id && !this.get(id)) throw Error("定时任务不存在或已删除");
    const active = id ? this.repository.activeJobs(id) : [];
    const task = this.store.tx(() => {
      const saved = this.repository.save(input, id);
      this.options.onSaved?.(saved);
      return saved;
    });
    this.abortCancelled(active);
    return task;
  }

  pause(id: string, expectedVersion?: number) {
    const active = this.repository.activeJobs(id);
    const task = this.store.tx(() => {
      const paused = this.repository.pause(id, expectedVersion);
      this.options.onSaved?.(paused);
      return paused;
    });
    this.abortCancelled(active);
    return task;
  }

  delete(id: string, expectedVersion?: number) {
    const task = this.get(id);
    if (!task) throw Error("定时任务不存在或已删除");
    const active = this.repository.activeJobs(id);
    const result = this.store.tx(() => {
      const removed = this.repository.delete(id, expectedVersion);
      this.options.onDeleted?.(task);
      return removed;
    });
    this.abortCancelled(active);
    return result;
  }

  runOnce(id: string) {
    const result = this.repository.enqueue(id, "manual")!;
    if (this.started) this.wake();
    return result;
  }

  tick() {
    return this.repository.queueDue();
  }
  async processOne() {
    return this.worker.processOne();
  }

  private wake() {
    if (!this.started || this.processing) return;
    this.processing = (async () => {
      this.tick();
      while (this.started && (await this.processOne()).processed) this.tick();
    })()
      .catch((error) => this.options.onBackgroundError?.(error))
      .finally(() => {
        this.processing = undefined;
      });
  }

  start() {
    if (this.started) return;
    this.worker = this.createWorker();
    this.started = true;
    this.timer = setInterval(
      () => this.wake(),
      Math.max(100, this.options.pollMs ?? 1000),
    );
    this.timer.unref();
    this.wake();
  }

  async stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.worker.stop();
    await this.processing;
  }
}
