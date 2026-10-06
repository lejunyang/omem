import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { WorkActor } from "../../../../packages/contracts/src/work.js";
import { DurableJobWorker, JobExecutionError } from "../jobs/worker.js";
import { queueOwnerNotice } from "../integrations/lark/owner-notice.js";
import { DevelopmentRunner } from "./runner.js";
import { repositoryLocation, repositoryRef } from "./repositories.js";

const kind = "assistant:prepare_repository";
const active = new Set(["queued", "leased", "running", "retry_wait"]);
export class RepositoryQueue {
  private readonly worker: DurableJobWorker;
  private pending?: Promise<unknown>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    readonly store: Store,
    readonly runner: DevelopmentRunner,
    readonly onError?: (error: unknown) => void,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_repositories(
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, alias TEXT NOT NULL,
      job_id TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, result TEXT);`);
    if (
      !store.db
        .prepare("PRAGMA table_info(assistant_repositories)")
        .all()
        .some((c) => c.name === "result")
    )
      store.db.exec(
        "ALTER TABLE assistant_repositories ADD COLUMN result TEXT",
      );
    this.worker = new DurableJobWorker(
      store.jobs,
      `repositories-${randomUUID()}`,
      {
        [kind]: async (job, signal) => {
          const input = job.inputRefs[0] as {
            alias: string;
            url: string;
            ref: string;
            requestId: string;
          };
          try {
            await runner.prepareRepository(input.alias, input.url, input.ref, {
              requestId: input.requestId,
              signal,
            });
          } catch (error) {
            signal.throwIfAborted();
            throw new JobExecutionError(String(error), "config");
          } finally {
            const state = runner.repositories.status(input.alias);
            if (state?.requestId === input.requestId)
              store.db
                .prepare(
                  "UPDATE assistant_repositories SET result=? WHERE request_id=?",
                )
                .run(JSON.stringify(state), input.requestId);
          }
          return { resultRef: input.alias };
        },
      },
      {
        kinds: [kind],
        leaseMs: 60000,
        heartbeatMs: 10000,
        fingerprint: () => ({
          model: null,
          effort: null,
          promptHash: kind,
          skillHash: "",
          toolHash: "git-fetch-worktree@1",
        }),
      },
    );
  }
  enqueue(alias: string, url: string, ref: string, actor: WorkActor) {
    this.runner.projectFile(alias);
    url = repositoryLocation(url);
    ref = repositoryRef(ref);
    const project = this.runner.projects().find((p) => p.alias === alias);
    if (project && project.origin?.url !== url)
      throw Error("该项目别名绑定其他仓库，请使用新别名");
    const previous = this.list().find(
      (t) =>
        t.requestId === actor.requestId ||
        (t.alias === alias && active.has(t.job.state)),
    );
    if (previous) {
      const input = previous.job.inputRefs[0] as { url: string; ref: string };
      if (input.url !== url || input.ref !== ref)
        throw Error("该项目正在准备另一个版本，请等当前任务结束后再指定新版本");
      return previous;
    }
    const id = randomUUID();
    this.store.tx(() => {
      const { job } = this.store.jobs.enqueueInCurrentTransaction({
        kind,
        inputRefs: [{ alias, url, ref, requestId: actor.requestId, actor }],
        roleVersion: "git-preparation@1",
        policyVersion: "owner-selected@1",
        maxAttempts: 3,
      });
      this.store.db
        .prepare(
          "INSERT INTO assistant_repositories(id,request_id,alias,job_id,notified,created_at) VALUES(?,?,?,?,0,?)",
        )
        .run(id, actor.requestId, alias, job.id, new Date().toISOString());
    });
    return this.read(id);
  }
  read(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM assistant_repositories WHERE id=?")
      .get(id);
    if (!row) throw Error("仓库准备任务不存在");
    const job = this.store.jobs.get(String(row.job_id))!;
    const state = this.runner.repositories.status(String(row.alias));
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      alias: String(row.alias),
      job,
      preparation: row.result
        ? JSON.parse(String(row.result))
        : state?.requestId === row.request_id
          ? state
          : null,
    };
  }
  list() {
    return this.store.db
      .prepare("SELECT id FROM assistant_repositories ORDER BY created_at DESC")
      .all()
      .map((r) => this.read(String(r.id)));
  }
  async processOne() {
    if (this.pending || this.stopped) return;
    this.pending = this.worker.processOne();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
      for (const row of this.store.db
        .prepare("SELECT id FROM assistant_repositories WHERE notified=0")
        .all()) {
        const task = this.read(String(row.id));
        if (active.has(task.job.state)) continue;
        const body =
          task.job.state === "succeeded"
            ? `「${task.alias}」仓库准备完成，提交 ${task.preparation?.commit ?? "见任务记录"}。可以继续配置检查与交办实现；尚未编码或推送。`
            : `「${task.alias}」仓库准备未完成：${task.job.lastError ?? task.preparation?.message ?? task.job.state}。处理后可重试原项目。`;
        this.store.tx(() => {
          const changed = this.store.db
            .prepare(
              "UPDATE assistant_repositories SET notified=1 WHERE id=? AND notified=0",
            )
            .run(task.id);
          if (!changed.changes) return;
          const now = new Date().toISOString(),
            change = this.store.record(
              "development",
              "仓库准备有结果",
              null,
              null,
              body,
            );
          queueOwnerNotice(
            this.store.db,
            change,
            "仓库准备有结果",
            body,
            now,
            this.store.applications.externalDeliveryTiming(now),
          );
        });
      }
    }
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      void this.processOne().catch((e) => this.onError?.(e));
    };
    this.timer = setInterval(tick, 2000);
    this.timer.unref();
    tick();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.worker.stop();
    await this.pending;
  }
}
