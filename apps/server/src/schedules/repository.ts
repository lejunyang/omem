import { randomUUID } from "node:crypto";
import type {
  ScheduleResult,
  ScheduleRun,
  ScheduleTiming,
  ScheduledTask,
} from "../../../../packages/contracts/src/schedules.js";
import { scheduleInputSchema } from "../../../../packages/contracts/src/schedules.js";
import type { JobLease, JobRecord } from "../jobs/repository.js";
import type { Store } from "../store.js";

export const SCHEDULE_JOB_KIND = "scheduled_task";
export const defaultDiscoveryId = "lark-discovery";
const terminal = new Set(["succeeded", "skipped", "failed", "cancelled"]);
type Row = Record<string, unknown>;
export type NextScheduleRun = (timing: ScheduleTiming, after: Date) => string;

/** Schedule rows describe recurrence; the shared durable jobs remain the queue. */
export class ScheduleRepository {
  constructor(
    private readonly store: Store,
    private readonly nextRun: NextScheduleRun,
    private readonly options: {
      now?: () => Date;
      historyLimit?: number;
      discoveryTemplate?: boolean;
    } = {},
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks(
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL DEFAULT 'personal',
        kind TEXT NOT NULL, name TEXT NOT NULL, instruction TEXT NOT NULL,
        context_ids TEXT NOT NULL, timing TEXT NOT NULL, enabled INTEGER NOT NULL,
        version INTEGER NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(enabled,next_run_at);
      CREATE UNIQUE INDEX IF NOT EXISTS scheduled_tasks_discovery ON scheduled_tasks(kind) WHERE kind='lark_discovery';
      CREATE TABLE IF NOT EXISTS schedule_runs(
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_version INTEGER NOT NULL,
        job_id TEXT NOT NULL UNIQUE, trigger TEXT NOT NULL, scheduled_for TEXT NOT NULL,
        queued_at TEXT NOT NULL, summary TEXT, detail TEXT, result_ref TEXT, usage TEXT, result_meta TEXT);
      CREATE INDEX IF NOT EXISTS schedule_runs_task ON schedule_runs(task_id,queued_at);
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_occurrence ON schedule_runs(task_id,task_version,scheduled_for)
        WHERE trigger='scheduled';
      CREATE TABLE IF NOT EXISTS schedule_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    if (
      !store.db
        .prepare("PRAGMA table_info(schedule_runs)")
        .all()
        .some((column) => column.name === "result_meta")
    )
      store.db.exec("ALTER TABLE schedule_runs ADD COLUMN result_meta TEXT");
    this.seedTemplates();
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private seedTemplates() {
    this.store.tx(() => {
      if (
        this.store.db
          .prepare("SELECT 1 FROM schedule_metadata WHERE key='templates-v1'")
          .get()
      )
        return;
      if (this.options.discoveryTemplate !== false)
        this.save(
          {
            kind: "lark_discovery",
            name: "发现飞书会话",
            instruction: "发现最近参与的飞书会话，按已设置的关注策略更新会话。",
            contextIds: [],
            enabled: false,
            timing: { type: "interval", everyMinutes: 30 },
          },
          defaultDiscoveryId,
        );
      this.save(
        {
          kind: "daily_brief",
          name: "每日简报",
          instruction:
            "整理最近变化、等待回复和今天需要跟进的事项，引用已保存材料，明确需要本人决定的内容。",
          contextIds: [],
          enabled: false,
          timing: {
            type: "cron",
            expression: "0 9 * * *",
            timezone: "Asia/Shanghai",
          },
        },
        "daily-brief",
      );
      this.store.db
        .prepare(
          "INSERT INTO schedule_metadata VALUES('templates-v1','registered')",
        )
        .run();
    });
  }

  private taskFromRow(row: Row): ScheduledTask {
    const recentRuns = this.history(String(row.id));
    return {
      id: String(row.id),
      kind: row.kind as ScheduledTask["kind"],
      name: String(row.name),
      instruction: String(row.instruction),
      contextIds: JSON.parse(String(row.context_ids)),
      timing: JSON.parse(String(row.timing)),
      enabled: Boolean(row.enabled),
      version: Number(row.version),
      nextRunAt: row.next_run_at ? String(row.next_run_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastRun: recentRuns[0] ?? null,
      recentRuns,
    };
  }

  list(): ScheduledTask[] {
    return this.store.db
      .prepare(
        "SELECT * FROM scheduled_tasks WHERE workspace_id='personal' ORDER BY created_at,id",
      )
      .all()
      .map((row) => this.taskFromRow(row));
  }

  get(id: string): ScheduledTask | null {
    const row = this.store.db
      .prepare(
        "SELECT * FROM scheduled_tasks WHERE id=? AND workspace_id='personal'",
      )
      .get(id);
    return row ? this.taskFromRow(row) : null;
  }

  private require(id: string, expectedVersion?: number) {
    const task = this.get(id);
    if (!task) throw Error("定时任务不存在或已删除");
    if (expectedVersion !== undefined && task.version !== expectedVersion)
      throw Error("定时任务已修改，请刷新后重试");
    return task;
  }

  save(raw: unknown, id?: string): ScheduledTask {
    const input = scheduleInputSchema.parse(raw);
    if (input.kind === "lark_discovery" && input.timing.type !== "interval")
      throw Error("飞书会话发现使用分钟间隔，请选择间隔方式");
    const contextIds = this.store.contexts.validate(input.contextIds);
    // Validate a paused cron too: enabling it later must not reveal a bad pattern.
    const next = this.nextRun(input.timing, this.now());
    return this.store.tx(() => {
      const old = id ? this.get(id) : null;
      if (id && !old && id !== "lark-discovery" && id !== "daily-brief")
        throw Error("定时任务不存在或已删除");
      if (
        old &&
        input.expectedVersion !== undefined &&
        old.version !== input.expectedVersion
      )
        throw Error("定时任务已修改，请刷新后重试");
      if (
        input.kind === "lark_discovery" &&
        this.list().some(
          (task) => task.kind === "lark_discovery" && task.id !== id,
        )
      )
        throw Error("已有飞书会话发现任务，请修改现有任务");
      const taskId = old?.id ?? id ?? randomUUID(),
        at = this.now().toISOString();
      if (old)
        this.cancelActive(old.id, `schedule-save-${old.id}-${old.version + 1}`);
      this.store.db
        .prepare(
          `INSERT INTO scheduled_tasks(
        id,workspace_id,kind,name,instruction,context_ids,timing,enabled,version,next_run_at,created_at,updated_at)
        VALUES(?,'personal',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,name=excluded.name,instruction=excluded.instruction,context_ids=excluded.context_ids,
        timing=excluded.timing,enabled=excluded.enabled,version=excluded.version,
        next_run_at=excluded.next_run_at,updated_at=excluded.updated_at`,
        )
        .run(
          taskId,
          input.kind,
          input.name,
          input.instruction,
          JSON.stringify(contextIds),
          JSON.stringify(input.timing),
          Number(input.enabled),
          (old?.version ?? 0) + 1,
          input.enabled ? next : null,
          old?.createdAt ?? at,
          at,
        );
      return this.get(taskId)!;
    });
  }

  pause(id: string, expectedVersion?: number) {
    const task = this.require(id, expectedVersion);
    const {
      id: _id,
      version: _version,
      createdAt: _created,
      updatedAt: _updated,
      nextRunAt: _next,
      lastRun: _last,
      recentRuns: _history,
      ...input
    } = task;
    return this.save(
      { ...input, enabled: false, expectedVersion: task.version },
      id,
    );
  }

  delete(id: string, expectedVersion?: number) {
    return this.store.tx(() => {
      const task = this.require(id, expectedVersion);
      this.cancelActive(id, `schedule-delete-${id}-${task.version}`);
      this.store.db.prepare("DELETE FROM scheduled_tasks WHERE id=?").run(id);
      this.prune(id);
      return { deleted: true as const };
    });
  }

  activeJobs(id: string): JobRecord[] {
    return this.store.db
      .prepare(
        `SELECT j.id FROM schedule_runs r JOIN jobs j ON j.id=r.job_id
      WHERE r.task_id=? AND j.state NOT IN ('succeeded','failed','cancelled') ORDER BY r.queued_at`,
      )
      .all(id)
      .map((r) => this.store.jobs.get(String(r.id))!);
  }

  private cancelActive(id: string, requestPrefix: string) {
    for (const job of this.activeJobs(id))
      this.store.jobs.cancel({
        jobId: job.id,
        expectedGeneration: job.generation,
        requestId: `${requestPrefix}-${job.id}`,
        now: this.now(),
      });
  }

  private runFromRow(row: Row): ScheduleRun {
    const job = this.store.jobs.get(String(row.job_id));
    const attempts = job ? this.store.jobs.attempts(job.id) : [];
    const meta = JSON.parse(String(row.result_meta ?? "{}"));
    const state = !job
      ? "failed"
      : job.state === "leased" || job.state === "running"
        ? "running"
        : job.state === "skipped"
          ? "cancelled"
          : job.state === "awaiting_decision"
            ? "queued"
            : job.state;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      taskVersion: Number(row.task_version),
      jobId: String(row.job_id),
      trigger: row.trigger as ScheduleRun["trigger"],
      scheduledFor: String(row.scheduled_for),
      queuedAt: String(row.queued_at),
      startedAt: attempts[0]?.startedAt ?? null,
      finishedAt: job?.finishedAt ?? null,
      state,
      summary:
        state === "succeeded" && row.summary ? String(row.summary) : null,
      detail: state === "succeeded" && row.detail ? String(row.detail) : null,
      resultRef:
        state === "succeeded"
          ? row.result_ref
            ? String(row.result_ref)
            : (job?.resultRef ?? null)
          : null,
      error: !job
        ? "执行记录已不可用"
        : (job.lastError ??
          (job.cancelRequested ? "任务已修改、暂停或删除，执行已取消" : null)),
      skipped: Boolean(meta.skipped),
      notificationState: meta.notificationState ?? null,
    };
  }

  history(id: string): ScheduleRun[] {
    const limit = Math.max(1, Math.min(this.options.historyLimit ?? 20, 100));
    return this.store.db
      .prepare(
        "SELECT * FROM schedule_runs WHERE task_id=? ORDER BY queued_at DESC,rowid DESC LIMIT ?",
      )
      .all(id, limit)
      .map((row) => this.runFromRow(row));
  }

  run(id: string): ScheduleRun | null {
    const row = this.store.db
      .prepare("SELECT * FROM schedule_runs WHERE id=?")
      .get(id);
    return row ? this.runFromRow(row) : null;
  }

  runForJob(jobId: string): ScheduleRun | null {
    const row = this.store.db
      .prepare("SELECT * FROM schedule_runs WHERE job_id=?")
      .get(jobId);
    return row ? this.runFromRow(row) : null;
  }

  enqueue(id: string, trigger: ScheduleRun["trigger"]) {
    return this.store.tx(() => {
      this.recoverCancelled();
      const task = this.require(id),
        now = this.now(),
        at = now.toISOString();
      const active = this.activeJobs(id)[0];
      if (active) {
        // A pending occurrence already is the one catch-up. Skip missed slots
        // while it is in flight, including after an extended service outage.
        if (
          trigger === "scheduled" &&
          task.enabled &&
          task.nextRunAt &&
          task.nextRunAt <= at
        )
          this.store.db
            .prepare(
              "UPDATE scheduled_tasks SET next_run_at=? WHERE id=? AND version=?",
            )
            .run(this.nextRun(task.timing, now), id, task.version);
        return {
          task: this.get(id)!,
          run: this.runForJob(active.id)!,
          duplicate: true,
        };
      }
      if (
        trigger === "scheduled" &&
        (!task.enabled || !task.nextRunAt || task.nextRunAt > at)
      )
        return null;
      const scheduledFor = trigger === "scheduled" ? task.nextRunAt! : at;
      const runId = randomUUID();
      const { job } = this.store.jobs.enqueueInCurrentTransaction({
        kind: SCHEDULE_JOB_KIND,
        inputRefs: [
          {
            scheduleId: task.id,
            scheduleVersion: task.version,
            occurrenceId: runId,
            trigger,
            scheduledFor,
          },
        ],
        roleVersion: "scheduled-task@1",
        policyVersion: "schedule@1",
        notBefore: at,
        maxAttempts: 3,
        cause: trigger === "manual" ? "manual_schedule" : "schedule",
      });
      this.store.db
        .prepare(
          `INSERT INTO schedule_runs(id,task_id,task_version,job_id,trigger,scheduled_for,queued_at)
        VALUES(?,?,?,?,?,?,?)`,
        )
        .run(runId, id, task.version, job.id, trigger, scheduledFor, at);
      if (trigger === "scheduled")
        this.store.db
          .prepare(
            "UPDATE scheduled_tasks SET next_run_at=? WHERE id=? AND version=?",
          )
          .run(this.nextRun(task.timing, now), id, task.version);
      this.prune(id);
      return { task: this.get(id)!, run: this.run(runId)!, duplicate: false };
    });
  }

  queueDue() {
    this.recoverCancelled();
    const at = this.now().toISOString();
    const rows = this.store.db
      .prepare(
        `SELECT id FROM scheduled_tasks WHERE enabled=1 AND next_run_at<=?
      AND workspace_id='personal' ORDER BY next_run_at,id`,
      )
      .all(at);
    const queued: ScheduleRun[] = [];
    for (const row of rows) {
      const result = this.enqueue(String(row.id), "scheduled");
      if (result && !result.duplicate) queued.push(result.run);
    }
    return queued;
  }

  /** Cancelled leases must finish after a crash: claimNext intentionally excludes them. */
  private recoverCancelled() {
    const at = this.now();
    const rows = this.store.db
      .prepare(
        `SELECT j.id FROM jobs j JOIN schedule_runs r ON r.job_id=j.id
      WHERE j.cancel_requested=1 AND j.state IN ('leased','running') AND j.lease_expires_at<=?`,
      )
      .all(at.toISOString());
    for (const row of rows) {
      const job = this.store.jobs.get(String(row.id))!;
      this.store.jobs.fail({
        jobId: job.id,
        leaseToken: job.leaseToken!,
        kind: "cancelled",
        message: "任务已修改、暂停或删除，执行已取消",
        now: at,
      });
    }
  }

  assertCurrent(run: ScheduleRun, lease: JobLease) {
    const task = this.get(run.taskId),
      job = this.store.jobs.get(run.jobId);
    if (
      !task ||
      task.version !== run.taskVersion ||
      !job ||
      job.cancelRequested ||
      job.leaseToken !== lease.leaseToken ||
      !["leased", "running"].includes(job.state) ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= this.now().toISOString()
    )
      throw Error("定时任务已修改、暂停、删除或失去执行租约，旧结果不会应用");
    return task;
  }

  storedResult(runId: string): ScheduleResult | null {
    const row = this.store.db
      .prepare(
        "SELECT summary,detail,result_ref,usage,result_meta FROM schedule_runs WHERE id=?",
      )
      .get(runId);
    return row?.summary
      ? {
          summary: String(row.summary),
          detail: row.detail ? String(row.detail) : undefined,
          resultRef: row.result_ref ? String(row.result_ref) : null,
          usage: JSON.parse(String(row.usage ?? "{}")),
          ...JSON.parse(String(row.result_meta ?? "{}")),
        }
      : null;
  }

  recordResult(run: ScheduleRun, lease: JobLease, result: ScheduleResult) {
    return this.store.tx(() => {
      this.assertCurrent(run, lease);
      if (!result.summary.trim()) throw Error("定时任务没有返回可读的执行结果");
      this.store.db
        .prepare(
          "UPDATE schedule_runs SET summary=?,detail=?,result_ref=?,usage=?,result_meta=? WHERE id=?",
        )
        .run(
          result.summary.slice(0, 3000),
          result.detail?.slice(0, 100_000) ?? null,
          result.resultRef ?? null,
          JSON.stringify(result.usage ?? {}),
          JSON.stringify({
            skipped: Boolean(result.skipped),
            notificationState: result.notificationState?.slice(0, 100) ?? null,
          }),
          run.id,
        );
    });
  }

  private prune(id: string) {
    const limit = Math.max(1, Math.min(this.options.historyLimit ?? 20, 100));
    const rows = this.store.db
      .prepare(
        "SELECT id,job_id FROM schedule_runs WHERE task_id=? ORDER BY queued_at DESC,rowid DESC",
      )
      .all(id);
    for (const row of rows.slice(limit)) {
      const job = this.store.jobs.get(String(row.job_id));
      if (!job || terminal.has(job.state))
        this.store.db
          .prepare("DELETE FROM schedule_runs WHERE id=?")
          .run(String(row.id));
    }
  }
}
