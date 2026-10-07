import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ScheduleInput,
  ScheduledTask,
} from "../../../packages/contracts/src/schedules.js";
import { Store } from "../src/store.js";
import { registerSchedules } from "../src/schedules/api.js";
import {
  defaultDiscoveryId,
  SCHEDULE_JOB_KIND,
} from "../src/schedules/repository.js";
import {
  ScheduleService,
  type ScheduleHandler,
  type ScheduleServiceOptions,
} from "../src/schedules/service.js";
import { nextScheduleRun } from "../src/schedules/timing.js";

const resources: {
  directory: string;
  store: Store;
  service: ScheduleService;
}[] = [];
let at = new Date("2026-10-07T00:00:00.000Z");
const setup = (
  handler: ScheduleHandler = async () => ({ summary: "已检查，没有新增事项" }),
  options: ScheduleServiceOptions = {},
  directory = mkdtempSync(join(tmpdir(), "omem-schedules-")),
) => {
  const store = new Store(directory);
  const service = new ScheduleService(store, handler, {
    now: () => at,
    heartbeatMs: 0,
    ...options,
  });
  resources.push({ directory, store, service });
  return { store, service, directory };
};
const input = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  kind: "daily_brief",
  name: "项目跟进简报",
  instruction: "最近变化和等待回复",
  contextIds: [],
  enabled: true,
  timing: { type: "interval", everyMinutes: 30 },
  ...overrides,
});
const editable = (task: ScheduledTask): ScheduleInput => ({
  kind: task.kind,
  name: task.name,
  instruction: task.instruction,
  contextIds: task.contextIds,
  enabled: task.enabled,
  timing: task.timing,
  expectedVersion: task.version,
});

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.service.stop();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
  at = new Date("2026-10-07T00:00:00.000Z");
});

describe("persistent schedules on the durable queue", () => {
  it("registers paused templates once and preserves deletion after restart", async () => {
    let calls = 0;
    const { store, service, directory } = setup(async () => {
      calls++;
      return { summary: "checked" };
    });
    expect(service.list()).toHaveLength(2);
    expect(service.get(defaultDiscoveryId)).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect(service.tick()).toEqual([]);
    expect(await service.processOne()).toEqual({ processed: false });
    expect(calls).toBe(0);
    service.delete(defaultDiscoveryId, 1);
    store.close();
    resources.splice(
      resources.findIndex((r) => r.store === store),
      1,
    );
    const restarted = setup(undefined, {}, directory);
    expect(restarted.service.get(defaultDiscoveryId)).toBeNull();
    expect(restarted.service.list()).toHaveLength(1);
  });

  it("queues one persisted occurrence, recovers it at restart and catches up once after days offline", async () => {
    const first = setup();
    const task = first.service.save(input());
    at = new Date("2026-10-07T00:30:00.000Z");
    const queued = first.service.tick();
    expect(queued).toHaveLength(1);
    expect(first.service.tick()).toEqual([]);
    first.store.close();
    resources.splice(
      resources.findIndex((r) => r.store === first.store),
      1,
    );
    let calls = 0;
    const second = setup(
      async (_task, _signal, occurrence) => {
        calls++;
        return {
          summary: `已检查 ${occurrence.scheduledFor}`,
          skipped: true,
          notificationState: "none",
        };
      },
      {},
      first.directory,
    );
    expect(second.service.tick()).toEqual([]);
    await second.service.processOne();
    expect(calls).toBe(1);
    expect(second.service.get(task.id)?.lastRun).toMatchObject({
      id: queued[0]!.id,
      state: "succeeded",
      skipped: true,
    });
    at = new Date("2026-10-10T12:00:00.000Z");
    expect(second.service.tick()).toHaveLength(1);
    expect(second.service.tick()).toEqual([]);
    expect(second.service.get(task.id)?.nextRunAt).toBe(
      "2026-10-10T12:30:00.000Z",
    );
    await second.service.processOne();
    expect(calls).toBe(2);
    expect(second.service.tick()).toEqual([]);
  });

  it("uses timezone cron computation without a Croner execution timer", () => {
    expect(
      nextScheduleRun(
        { type: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
        at,
      ),
    ).toBe("2026-10-07T01:00:00.000Z");
    expect(
      nextScheduleRun(
        { type: "cron", expression: "0 9 * * *", timezone: "America/New_York" },
        new Date("2026-10-31T14:00:00.000Z"),
      ),
    ).toBe("2026-11-01T14:00:00.000Z");
    expect(() =>
      nextScheduleRun(
        { type: "cron", expression: "* * * * * *", timezone: "Asia/Shanghai" },
        at,
      ),
    ).toThrow("五个字段");
    expect(() =>
      nextScheduleRun(
        { type: "cron", expression: "0 9 * * *", timezone: "No/Such_Zone" },
        at,
      ),
    ).toThrow("时区无效");
  });

  it("uses an already pending run as the only catch-up after days offline", async () => {
    const first = setup();
    const task = first.service.save(input());
    at = new Date("2026-10-07T00:30:00.000Z");
    const run = first.service.tick()[0]!;
    first.store.close();
    resources.splice(
      resources.findIndex((r) => r.store === first.store),
      1,
    );
    at = new Date("2026-10-10T12:00:00.000Z");
    const second = setup(undefined, {}, first.directory);
    expect(second.service.tick()).toEqual([]);
    expect(second.service.get(task.id)?.nextRunAt).toBe(
      "2026-10-10T12:30:00.000Z",
    );
    await second.service.processOne();
    expect(second.service.get(task.id)?.lastRun?.id).toBe(run.id);
    expect(second.service.tick()).toEqual([]);
    expect(second.service.get(task.id)?.recentRuns).toHaveLength(1);
  });

  it("finishes an abandoned cancelling lease after restart so it cannot block the task forever", async () => {
    const { store, service } = setup();
    const task = service.save(input()),
      run = service.runOnce(task.id).run;
    const lease = store.jobs.claimNext({
      workerId: "lost-process",
      kinds: [SCHEDULE_JOB_KIND],
      now: at,
      leaseMs: 100,
      fingerprint: {
        model: null,
        effort: null,
        promptHash: "p",
        skillHash: "s",
        toolHash: "t",
      },
    })!;
    store.jobs.markRunning(lease.id, lease.leaseToken, at);
    service.pause(task.id, task.version);
    expect(service.runOnce(task.id).duplicate).toBe(true);
    at = new Date(at.getTime() + 101);
    service.tick();
    expect(service.repository.run(run.id)?.state).toBe("cancelled");
    expect(service.runOnce(task.id).duplicate).toBe(false);
    await service.processOne();
    expect(service.get(task.id)?.lastRun?.state).toBe("succeeded");
  });

  it("aborts model work on shutdown and resumes the same occurrence", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const { service } = setup(
      async (_task, signal) => {
        calls++;
        if (calls === 1) {
          entered();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(Error("model aborted")),
              { once: true },
            ),
          );
        }
        return { summary: "恢复了同一次简报" };
      },
      { retryBaseMs: 0 },
    );
    const task = service.save(input({ enabled: false })),
      run = service.runOnce(task.id).run;
    service.start();
    await started;
    await service.stop();
    expect(service.repository.run(run.id)).toMatchObject({
      state: "retry_wait",
      error: "Worker stopped before completion",
    });
    await service.processOne();
    expect(service.get(task.id)?.lastRun).toMatchObject({
      id: run.id,
      state: "succeeded",
      summary: "恢复了同一次简报",
    });
    expect(calls).toBe(2);
  });

  it("allows explicit runs of paused tasks, scopes jobs and blocks concurrent occurrences of one task", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { store, service } = setup(async () => {
      entered();
      await released;
      return { summary: "简报已生成", detail: "等待接口回复" };
    });
    const other = store.jobs.enqueue({
      kind: "unrelated",
      inputRefs: [],
      roleVersion: "1",
      policyVersion: "1",
    }).job;
    const task = service.save(input({ enabled: false }));
    const run = service.runOnce(task.id);
    const processing = service.processOne();
    await started;
    expect(service.runOnce(task.id)).toMatchObject({
      duplicate: true,
      run: { id: run.run.id },
    });
    expect(await service.processOne()).toEqual({ processed: false });
    expect(service.get(task.id)?.lastRun?.state).toBe("running");
    release();
    await processing;
    expect(service.get(task.id)?.lastRun).toMatchObject({
      state: "succeeded",
      detail: "等待接口回复",
    });
    expect(store.jobs.get(other.id)?.state).toBe("queued");
    expect(store.jobs.get(run.run.jobId)?.kind).toBe(SCHEDULE_JOB_KIND);
  });

  it("fences obsolete results and sends cancellation when settings change during execution", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aborted = false,
      applied = false;
    const { service } = setup(async (_task, signal, occurrence) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      entered();
      await released;
      occurrence.assertCurrent();
      applied = true;
      return { summary: "不能保存的旧结果" };
    });
    const task = service.save(input()),
      run = service.runOnce(task.id);
    const processing = service.processOne();
    await started;
    const updated = service.save(
      { ...editable(task), instruction: "新的简报范围" },
      task.id,
    );
    expect(updated.version).toBe(task.version + 1);
    expect(aborted).toBe(true);
    expect(service.runOnce(task.id).duplicate).toBe(true);
    release();
    await processing;
    expect(applied).toBe(false);
    expect(service.repository.run(run.run.id)).toMatchObject({
      state: "cancelled",
      summary: null,
    });
    expect(service.runOnce(task.id).duplicate).toBe(false);
    expect(() => service.pause(task.id, task.version)).toThrow("已修改");
  });

  it("rolls back occurrence, queue and next time together on enqueue failure", () => {
    const { store, service } = setup(),
      task = service.save(input());
    at = new Date("2026-10-07T00:30:00.000Z");
    store.db.exec(`CREATE TRIGGER schedule_enqueue_failure BEFORE INSERT ON jobs
      WHEN NEW.kind='scheduled_task' BEGIN SELECT RAISE(ABORT,'injected schedule failure'); END;`);
    expect(() => service.tick()).toThrow("injected schedule failure");
    expect(service.get(task.id)).toMatchObject({
      nextRunAt: "2026-10-07T00:30:00.000Z",
      recentRuns: [],
    });
    store.db.exec("DROP TRIGGER schedule_enqueue_failure");
    expect(service.tick()).toHaveLength(1);
  });

  it("retains failed reasons and bounds its run history without erasing active work", async () => {
    let succeed = false;
    const { store, service } = setup(
      async () => {
        if (!succeed) throw Error("需要重新登录 token=private-credential");
        return { summary: "没有新增需关注内容", notificationState: "none" };
      },
      { historyLimit: 3 },
    );
    const task = service.save(input({ enabled: false }));
    service.runOnce(task.id);
    await service.processOne();
    expect(service.get(task.id)?.lastRun).toMatchObject({
      state: "failed",
      error: "需要重新登录 token=[REDACTED]",
    });
    succeed = true;
    for (let index = 0; index < 5; index++) {
      at = new Date(at.getTime() + 1000);
      service.runOnce(task.id);
      await service.processOne();
    }
    expect(service.get(task.id)?.recentRuns).toHaveLength(3);
    expect(
      store.db
        .prepare("SELECT count(*) AS count FROM schedule_runs WHERE task_id=?")
        .get(task.id)?.count,
    ).toBe(3);
    expect(service.get(task.id)?.lastRun?.summary).toBe("没有新增需关注内容");
  });

  it("acknowledges a saved result after a lost lease without applying the occurrence twice", async () => {
    let calls = 0;
    const { store, service } = setup(async () => {
      calls++;
      return { summary: "同一简报", resultRef: "brief-source" };
    });
    const task = service.save(input({ enabled: false })),
      run = service.runOnce(task.id).run;
    const lease = store.jobs.claimNext({
      workerId: "crashed",
      kinds: [SCHEDULE_JOB_KIND],
      now: at,
      leaseMs: 100,
      fingerprint: {
        model: null,
        effort: null,
        promptHash: "p",
        skillHash: "s",
        toolHash: "t",
      },
    })!;
    store.jobs.markRunning(lease.id, lease.leaseToken, at);
    service.repository.recordResult(run, lease, {
      summary: "同一简报",
      resultRef: "brief-source",
    });
    at = new Date(at.getTime() + 101);
    await service.processOne();
    expect(calls).toBe(0);
    expect(service.get(task.id)?.lastRun).toMatchObject({
      state: "succeeded",
      resultRef: "brief-source",
    });
  });

  it("requires current versions for HTTP edits and exposes live results plus system tasks", async () => {
    const { service } = setup();
    const app = Fastify();
    registerSchedules(app, service, {
      systemTasks: () => [{ id: "poll", name: "消息采集" }],
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: input({ enabled: false }),
      });
      expect(created.statusCode).toBe(200);
      const task = created.json() as ScheduledTask;
      const missingVersion = await app.inject({
        method: "PUT",
        url: `/api/schedules/${task.id}`,
        payload: input(),
      });
      expect(missingVersion.statusCode).toBe(400);
      const updated = await app.inject({
        method: "PUT",
        url: `/api/schedules/${task.id}`,
        payload: { ...input(), expectedVersion: task.version },
      });
      expect(updated.json()).toMatchObject({ version: 2, enabled: true });
      const list = await app.inject({ method: "GET", url: "/api/schedules" });
      expect(list.json()).toMatchObject({
        system: [{ id: "poll", name: "消息采集" }],
      });
      const manual = await app.inject({
        method: "POST",
        url: `/api/schedules/${task.id}/run`,
      });
      expect(manual.json()).toMatchObject({
        duplicate: false,
        run: { state: "queued" },
      });
      await service.processOne();
      const result = await app.inject({
        method: "GET",
        url: `/api/schedules/${task.id}/runs/${manual.json().run.id}`,
      });
      expect(result.json()).toMatchObject({
        state: "succeeded",
        summary: "已检查，没有新增事项",
      });
    } finally {
      await app.close();
    }
  });
});
