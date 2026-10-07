import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentProfile } from "../../../../packages/contracts/src/index.js";
import type { WorkActor } from "../../../../packages/contracts/src/work.js";
import type { Store } from "../store.js";
import type { DevelopmentProject } from "../../../../packages/contracts/src/development.js";
import { DurableJobWorker, JobExecutionError } from "../jobs/worker.js";
import type { KnowledgePageService } from "../knowledge/page-service.js";
import { DevelopmentRunner } from "./runner.js";
import {
  freezeDevelopmentProfiles,
  type DevelopmentProfiles,
} from "../agent-providers.js";
import { captureDevelopmentResult } from "./results.js";
import { assertRequirementBasis } from "./requirement-basis.js";
import { inspectRequirementChange } from "./replanning.js";
import type { DecisionService } from "../decision/service.js";
import { queueOwnerNotice } from "../integrations/lark/owner-notice.js";
import {
  CapabilityReceipts,
  type DevelopmentHandoff,
} from "../capabilities/receipts.js";

const kind = "assistant:develop";
const active = new Set(["queued", "retry_wait", "leased", "running"]);
type DevelopmentJobInput = {
  taskId: string;
  operation?: "develop" | "apply";
  reviewedFingerprint?: string;
  continuation?: WorkActor;
  capabilities?: import("../../../../packages/contracts/src/capabilities.js").CapabilityReference[];
  handoff?: DevelopmentHandoff;
  profiles?: DevelopmentProfiles;
  project?: DevelopmentProject;
  replan?: boolean;
};
export class DevelopmentQueue {
  get profile() {
    return typeof this.configuredProfile === "function"
      ? this.configuredProfile()
      : this.configuredProfile;
  }
  readonly runner: DevelopmentRunner;
  private readonly worker: DurableJobWorker;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<unknown>;
  private stopped = false;
  constructor(
    readonly store: Store,
    readonly pages: KnowledgePageService,
    private readonly configuredProfile:
      | AgentProfile
      | null
      | (() => AgentProfile | null),
    readonly options: {
      runner?: DevelopmentRunner;
      reviewProfile?: AgentProfile;
      onError?: (e: unknown) => void;
      decisions?: DecisionService;
    } = {},
  ) {
    this.runner = options.runner ?? new DevelopmentRunner(store.dataDir);
    store.db.exec(`CREATE TABLE IF NOT EXISTS assistant_development(
      id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,
      requirement_key TEXT NOT NULL,project TEXT NOT NULL,job_id TEXT NOT NULL,run_id TEXT,
      message TEXT NOT NULL,notified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);`);
    store.db.exec(
      `CREATE TABLE IF NOT EXISTS assistant_development_updates(task_id TEXT PRIMARY KEY,actor TEXT NOT NULL);`,
    );
    this.worker = new DurableJobWorker(
      store.jobs,
      `development-${randomUUID()}`,
      {
        [kind]: async (job, signal) => {
          const input = job.inputRefs[0] as DevelopmentJobInput;
          const task = this.read(input.taskId);
          if (input.operation === "apply") {
            if (!task.runId || !input.reviewedFingerprint)
              throw new JobExecutionError("缺少待应用的已评审版本", "config");
            const applied = await this.runner.apply(task.runId, {
              expectedFingerprint: input.reviewedFingerprint,
              signal,
            });
            store.db
              .prepare("UPDATE assistant_development SET message=? WHERE id=?")
              .run(
                "已将评审补丁应用到登记仓库，保留为未提交修改；未推送或部署。",
                task.id,
              );
            return { resultRef: applied.id };
          }
          const profiles =
            task.run?.profiles ??
            input.profiles ??
            (this.profile &&
              freezeDevelopmentProfiles(this.profile, options.reviewProfile));
          if (!profiles)
            throw new JobExecutionError("尚未配置编码 Agent", "config");
          const repository = pages.repository;
          for (;;) {
            signal.throwIfAborted();
            if (task.run) {
              try {
                assertRequirementBasis(repository, task.run);
                break;
              } catch (error) {
                if (!input.replan) throw error;
                repository.refresh();
                if (repository.get(task.key)?.current) break;
              }
            }
            repository.refresh();
            const article = repository.get(task.key);
            if (article?.current && article.document.requirement) break;
            const status = pages.maintenance.status(task.key);
            if (status?.state === "failed")
              throw Error(`需求整理失败：${status.error}`);
            if (!status?.enabled)
              throw Error("需求跟进已暂停；请更新需求后重新交办");
            pages.refresh(task.key);
            store.db
              .prepare("UPDATE assistant_development SET message=? WHERE id=?")
              .run("等待当前需求完成调查与复核", task.id);
            // Waiting for another owned job is not a failed coding attempt. The
            // durable worker keeps its lease and aborts this wait on shutdown.
            await new Promise<void>((resolve, reject) => {
              const abort = () => {
                clearTimeout(timer);
                reject(signal.reason ?? Error("CANCELLED"));
              };
              const timer = setTimeout(() => {
                signal.removeEventListener("abort", abort);
                resolve();
              }, 3000);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          }
          signal.throwIfAborted();
          let run = task.runId
            ? this.runner.read(task.runId)
            : await this.runner.create(task.project, task.key, store, {
                id: task.id,
                capabilities: input.capabilities,
                handoff: input.handoff,
                profiles,
                project: input.project,
              });
          store.db
            .prepare("UPDATE assistant_development SET run_id=? WHERE id=?")
            .run(run.id, task.id);
          signal.throwIfAborted();
          if (
            !["ready", "applied"].includes(run.state) ||
            (input.replan && run.state === "ready")
          )
            run = await this.runner.execute(run.id, store, profiles.coding, {
              reviewProfile: profiles.review,
              signal,
              continuation: input.continuation,
              replan: input.replan,
              decisions: this.options.decisions,
              log: (message) =>
                store.db
                  .prepare(
                    "UPDATE assistant_development SET message=? WHERE id=?",
                  )
                  .run(message, task.id),
            });
          signal.throwIfAborted();
          const message =
            run.state === "ready"
              ? `已完成实现与独立评审：${run.review?.summary ?? "可查看修改和检查结果"}`
              : run.state === "applied"
                ? "补丁已应用"
                : `实现尚未完成：${run.error ?? run.review?.summary ?? run.state}`;
          store.db
            .prepare("UPDATE assistant_development SET message=? WHERE id=?")
            .run(message, task.id);
          return { resultRef: run.id };
        },
      },
      {
        kinds: [kind],
        leaseMs: 60000,
        heartbeatMs: 10000,
        retryBaseMs: 15000,
        fingerprint: () => ({
          // Each task has two frozen profiles. Actual selected values belong to
          // its role traces, not the worker's possibly changed startup default.
          model: null,
          effort: null,
          promptHash: kind,
          skillHash: "",
          toolHash: "development@1",
        }),
      },
    );
  }
  enqueue(
    key: string,
    project: string,
    actor: WorkActor,
    capabilities?: string[],
    inputReceipts?: string[],
  ) {
    if (!this.profile) throw Error("尚未配置编码 Agent");
    if (!this.runner.projects().some((p) => p.alias === project))
      throw Error("目标项目尚未登记；需要项目仓库和检查配置");
    if (
      !this.pages.repository
        .pages()
        .some(
          (p) => p.key === key && p.plan?.workflow === "requirement-followup",
        )
    )
      throw Error("请先建立需求跟进");
    const previous = this.list().find(
      (t) =>
        t.requestId === actor.requestId ||
        (t.key === key && t.project === project && active.has(t.job.state)),
    );
    if (previous) return previous;
    const projectSnapshot = this.runner.configuration.get(project);
    const profiles = freezeDevelopmentProfiles(
      this.profile,
      this.options.reviewProfile,
    );
    const selected = this.runner.capabilities.references(
      capabilities ??
        this.runner.projects().find((p) => p.alias === project)?.capabilities ??
        [],
    );
    const id = randomUUID();
    const inputs = new CapabilityReceipts(this.store);
    const conversation = inputs.conversations.get(actor.conversationId);
    const handoff: DevelopmentHandoff = conversation
      ? inputs.handoff(
          { conversationId: actor.conversationId, turnId: actor.requestId },
          actor.userText,
          selected.map((c) => c.id),
          inputReceipts,
        )
      : {
          version: 1,
          assignment: {
            requestId: actor.requestId,
            conversationId: actor.conversationId,
            principalId: actor.principalId,
            text: actor.userText,
            at: new Date().toISOString(),
          },
          discussion: [],
          inputs: [],
          selection: "explicit",
        };
    if (!conversation && inputReceipts?.length)
      throw Error("缺少已保存会话，不能交接外部回执");
    const plan = this.pages.repository.pages().find((p) => p.key === key)?.plan;
    for (const ref of handoff.inputs) {
      const receipt = inputs.read(
        { conversationId: actor.conversationId, turnId: actor.requestId },
        ref.recordId,
      );
      const result = receipt.result as {
        isError?: boolean;
        exitCode?: number;
      } | null;
      // Failed reads remain useful diagnostic receipts; they are not evidence.
      if (!result || result.isError || result.exitCode) continue;
      try {
        const material = inputs.capture(
          { conversationId: actor.conversationId, turnId: actor.requestId },
          ref.recordId,
          `外部资料：${ref.capability} / ${ref.tool}`,
          plan?.contextIds,
        );
        ref.material = { key: material.key, revisionId: material.revisionId };
      } catch (error) {
        // The exact receipt is still handed over; report a capture gap rather
        // than treating a locator/image-only unsupported response as a document.
        ref.materialError =
          error instanceof Error ? error.message : String(error);
      }
    }
    // Export before enqueue returns: restart or removal of a chat workspace must
    // not leave a queued task pointing at transient files.
    inputs.export(
      handoff.inputs,
      join(this.runner.root, "runs", id, "external-inputs"),
    );
    this.store.tx(() => {
      const { job } = this.store.jobs.enqueueInCurrentTransaction({
        kind,
        inputRefs: [
          {
            taskId: id,
            capabilities: selected,
            handoff,
            profiles,
            project: projectSnapshot,
          },
        ],
        roleVersion: "coding-and-review@1",
        policyVersion: "owner-delegated@1",
        maxAttempts: 30,
        cause: "owner-delegation",
      });
      this.store.db
        .prepare(
          "INSERT INTO assistant_development(id,request_id,conversation_id,principal_id,requirement_key,project,job_id,message,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          actor.requestId,
          actor.conversationId,
          actor.principalId,
          key,
          project,
          job.id,
          "已交办，等待后台执行",
          new Date().toISOString(),
        );
    });
    return this.read(id);
  }
  read(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM assistant_development WHERE id=?")
      .get(id);
    if (!row) throw Error("编码任务不存在");
    const runId = row.run_id ? String(row.run_id) : null;
    const job = this.store.jobs.get(String(row.job_id))!;
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      conversationId: String(row.conversation_id),
      principalId: String(row.principal_id),
      key: String(row.requirement_key),
      project: String(row.project),
      message: String(row.message),
      createdAt: String(row.created_at),
      job,
      operation:
        (job.inputRefs[0] as DevelopmentJobInput).operation ?? "develop",
      runId,
      run: runId ? this.runner.read(runId) : null,
    };
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT id FROM assistant_development ORDER BY created_at DESC LIMIT 100",
      )
      .all()
      .map((r) => this.read(String(r.id)));
  }
  /** A new user instruction schedules the next step on the existing checkout.
   * Old jobs and their attempts remain available; external inputs stay frozen. */
  continueTask(
    id: string,
    actor: WorkActor,
    reviewedFingerprint?: string,
    automatic = false,
  ) {
    const task = this.read(id);
    if (task.principalId !== actor.principalId)
      throw Error("不能操作其他人的编码任务");
    if (active.has(task.job.state)) {
      if (reviewedFingerprint) throw Error("任务仍在运行，请等待当前操作完成");
      this.store.db
        .prepare(
          "INSERT OR REPLACE INTO assistant_development_updates VALUES(?,?)",
        )
        .run(id, JSON.stringify(actor));
      this.store.db
        .prepare("UPDATE assistant_development SET message=? WHERE id=?")
        .run(
          "已保存继续执行的交办；当前阶段结束后保留副本并核对最新需求。",
          id,
        );
      return this.read(id);
    }
    if (reviewedFingerprint) {
      if (
        task.run?.state !== "ready" ||
        task.run.reviewedFingerprint !== reviewedFingerprint
      )
        throw Error("请先读取当前评审结果，再应用同一份补丁");
    } else {
      if (!this.profile) throw Error("尚未配置编码 Agent");
      if (task.run?.state === "applied")
        throw Error("任务已应用到登记仓库；后续变更需从更新后的仓库交办新任务");
      if (task.run?.state === "ready") {
        const update = inspectRequirementChange(
          this.pages.repository,
          task.run,
        );
        if (!update) throw Error("任务已完成且需求未变化，可直接查看结果");
      }
    }
    this.store.tx(() => {
      const prior = task.job.inputRefs[0] as DevelopmentJobInput;
      const { job } = this.store.jobs.enqueueInCurrentTransaction({
        kind,
        inputRefs: [
          {
            taskId: id,
            capabilities: prior.capabilities,
            handoff: prior.handoff,
            profiles: task.run?.profiles ?? prior.profiles,
            project: task.run?.project ?? prior.project,
            operation: reviewedFingerprint ? "apply" : "develop",
            reviewedFingerprint,
            continuation: automatic ? undefined : actor,
            replan: !reviewedFingerprint,
          },
        ],
        roleVersion: "coding-and-review@1",
        policyVersion: "owner-delegated@1",
        // Filesystem application failures need a fresh owner request after the
        // source is fixed, rather than repeatedly retrying a possibly applied patch.
        maxAttempts: reviewedFingerprint ? 1 : 30,
        cause: `owner-${reviewedFingerprint ? "apply" : "resume"}:${actor.requestId}`,
      });
      this.store.db
        .prepare(
          "UPDATE assistant_development SET job_id=?,notified=0,message=? WHERE id=?",
        )
        .run(
          job.id,
          reviewedFingerprint
            ? "已安排应用这份已评审补丁；后台将再次核对需求与仓库状态，目前尚未应用。"
            : "已安排继续原编码任务，保留副本与已选资料；最新需求复核完成后对比变化，调整实现并独立评审。",
          id,
        );
      this.store.db
        .prepare("DELETE FROM assistant_development_updates WHERE task_id=?")
        .run(id);
    });
    return this.read(id);
  }
  /** Follow only an already delegated implementation. A newly discovered
   * requirement does not create a coding task or expand collection scope. */
  private reconcileChanges() {
    if (!this.profile) return;
    // Refresh applicability only when a delegated task could continue.
    const candidates = this.list().flatMap((task) => {
      const run = task.run;
      if (
        active.has(task.job.state) ||
        task.job.state === "cancelled" ||
        !run ||
        run.state === "applied"
      )
        return [];
      const pending = this.store.db
        .prepare(
          "SELECT actor FROM assistant_development_updates WHERE task_id=?",
        )
        .get(task.id);
      if (!pending && !this.pages.maintenance.status(task.key)?.enabled)
        return [];
      return [{ task, run, pending }];
    });
    if (!candidates.length) return;
    this.pages.repository.refresh();
    for (const { task, run, pending } of candidates) {
      try {
        const current = this.pages.repository.get(task.key);
        if (!current?.current) continue;
        if (
          !pending &&
          (!this.pages.maintenance.status(task.key)?.enabled ||
            current.revision === run.requirementRevision)
        )
          continue;
        const update = inspectRequirementChange(
          this.pages.repository,
          run,
        );
        if (!update && run.state === "ready") {
          if (pending)
            this.store.db
              .prepare(
                "DELETE FROM assistant_development_updates WHERE task_id=?",
              )
              .run(task.id);
          continue;
        }
        if (!update && !pending) continue;
        const actor: WorkActor = pending
          ? JSON.parse(String(pending.actor))
          : {
              requestId: `requirement-change:${task.id}:${current.revision}`,
              conversationId: task.conversationId,
              principalId: task.principalId,
              visibility: "private",
              userText:
                run.handoff?.assignment.text ?? "继续已交办的需求实现",
            };
        this.continueTask(task.id, actor, undefined, !pending);
      } catch (error) {
        // One unavailable old requirement must not stop unrelated queued work.
        this.store.db
          .prepare("UPDATE assistant_development SET message=? WHERE id=?")
          .run(`保留当前副本，暂未继续：${String(error)}`, task.id);
      }
    }
  }
  cancel(id: string, requestId: string) {
    const task = this.read(id);
    if (active.has(task.job.state))
      this.worker.cancel({
        jobId: task.job.id,
        expectedGeneration: task.job.generation,
        requestId,
      });
    this.store.db
      .prepare("UPDATE assistant_development SET message=? WHERE id=?")
      .run("已请求停止，保留现有代码与检查结果", id);
    return this.read(id);
  }
  private notify() {
    for (const row of this.store.db
      .prepare("SELECT id FROM assistant_development WHERE notified=0")
      .all()) {
      const task = this.read(String(row.id));
      if (active.has(task.job.state)) continue;
      const body = `${task.job.state === "succeeded" ? task.message : `编码任务未完成：${task.job.lastError ?? task.job.state}`}\n任务：${task.id}`;
      this.store.tx(() => {
        if (task.run) {
          captureDevelopmentResult(this.store, task.run, {
            id: task.job.id,
            state: task.job.state,
            error: task.job.lastError,
          });
          if (this.pages.maintenance.status(task.key)?.enabled)
            this.pages.maintenance.request(task.key, true);
        }
        const changed = this.store.db
          .prepare(
            "UPDATE assistant_development SET notified=1 WHERE id=? AND notified=0",
          )
          .run(task.id);
        if (!changed.changes) return;
        const change = this.store.record(
          "development",
          "编码任务有结果",
          null,
          null,
          body,
        );
        queueOwnerNotice(
          this.store.db,
          change,
          "编码任务有结果",
          body,
          new Date().toISOString(),
          this.store.applications.externalDeliveryTiming(
            new Date().toISOString(),
          ),
        );
      });
    }
  }
  async processOne() {
    if (this.stopped || this.pending) return;
    this.reconcileChanges();
    this.pending = this.worker.processOne();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
      this.notify();
      this.reconcileChanges();
    }
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      void this.processOne().catch((e) => this.options.onError?.(e));
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
