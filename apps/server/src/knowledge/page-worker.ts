import { randomUUID } from "node:crypto";
import type { WikiPageBrief, PageMaintenanceStatus } from "../../../../packages/contracts/src/knowledge.js";
import { DurableJobWorker } from "../jobs/worker.js";
import type { JobLease } from "../jobs/repository.js";
import { stableDigest } from "../storage/digest.js";
import type { KnowledgeRepository } from "./repository.js";

const kind = "knowledge:maintain-page";
const active = new Set(["queued", "retry_wait", "leased", "running"]);
type Follow = { document_key: string; enabled: number; target_digest: string; processed_digest: string | null; job_id: string | null };

/** One persistent request per page. Pending changes coalesce; each execution
 * captures the latest explicitly selected originals through KnowledgePipeline. */
export class KnowledgePageWorker {
  private worker: DurableJobWorker | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<unknown> | null = null;
  private stopped = false;

  constructor(
    readonly repository: KnowledgeRepository,
    readonly options: {
      run?: (plan: WikiPageBrief, job: JobLease, signal: AbortSignal) => Promise<string | undefined>;
      blocked?: () => boolean;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    repository.store.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_page_maintenance(
      document_key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      target_digest TEXT NOT NULL, processed_digest TEXT, job_id TEXT);`);
    if (options.run) this.worker = new DurableJobWorker(repository.store.jobs, `knowledge-pages-${randomUUID()}`, {
      [kind]: async (job, signal) => {
        const key = (job.inputRefs[0] as { key: string }).key;
        const follow = this.follow(key);
        if (!follow || (job.cause === "knowledge-maintenance" && !follow.enabled)) return {};
        const plan = this.plan(key);
        const digest = this.scopeDigest(plan);
        try {
          const resultRef = await options.run!(plan, job, signal);
          return { resultRef };
        } finally {
          // Do not retry the same failed input forever. A material change or an
          // explicit retry creates a new request; shutdown retains pending work.
          const cancelledByUser = !this.stopped && repository.store.jobs.get(job.id)?.cancelRequested;
          if (!signal.aborted || cancelledByUser) repository.store.db.prepare(
            "UPDATE knowledge_page_maintenance SET processed_digest=? WHERE document_key=?",
          ).run(digest, key);
        }
      },
    }, {
      kinds: [kind], leaseMs: 60000, heartbeatMs: 10000,
      fingerprint: () => ({ model: null, effort: null, promptHash: kind, skillHash: "", toolHash: "" }),
    });
  }

  private follow(key: string) {
    return this.repository.store.db.prepare("SELECT * FROM knowledge_page_maintenance WHERE document_key=?").get(key) as Follow | undefined;
  }
  private plan(key: string) {
    const plan = this.repository.pages().find(p => p.key === key)?.plan;
    if (!plan) throw Error("这篇文章没有保存阅读目标");
    return plan;
  }
  private scopeDigest(plan: WikiPageBrief) {
    const materials = this.repository.materialsForPlan(plan);
    const byKey = new Map(materials.map(m => [m.key, m.digest]));
    const keys = materials.map(m => m.key);
    return stableDigest({ plan, materials: [...new Set(keys)].sort().map(key => ({ key, digest: byKey.get(key) ?? null })) });
  }

  setEnabled(key: string, enabled: boolean) {
    const plan = this.plan(key);
    if (enabled && !plan.materialKeys?.length && !plan.contextIds?.length) throw Error("请先在调整材料与目标中选择材料、项目或主题");
    const before = this.follow(key);
    const digest = this.scopeDigest(plan);
    this.repository.refresh();
    const article = this.repository.get(key);
    const scopeUnchanged = !plan.contextIds?.length || stableDigest(article?.selection?.materialKeys ?? []) === stableDigest(this.repository.materialsForPlan(plan).map(m => m.key).sort());
    const baseline = article?.current && scopeUnchanged ? digest : null;
    this.repository.store.db.prepare(`INSERT INTO knowledge_page_maintenance VALUES(?,?,?,?,NULL)
      ON CONFLICT(document_key) DO UPDATE SET enabled=excluded.enabled,target_digest=excluded.target_digest,
      processed_digest=CASE WHEN knowledge_page_maintenance.enabled=0 AND excluded.enabled=1
        THEN excluded.processed_digest ELSE knowledge_page_maintenance.processed_digest END`)
      .run(key, enabled ? 1 : 0, digest, baseline);
    if (!enabled && before?.job_id) {
      const job = this.repository.store.jobs.get(before.job_id);
      if (job && job.cause === "knowledge-maintenance" && active.has(job.state)) {
        const request = { jobId: job.id, expectedGeneration: job.generation, requestId: randomUUID() };
        if (this.worker) this.worker.cancel(request);
        else this.repository.store.jobs.cancel(request);
      }
    }
    return this.status(key);
  }

  request(key: string, automatic = false) {
    const digest = this.scopeDigest(this.plan(key));
    return this.repository.store.tx(() => {
      const follow = this.follow(key);
      const previous = follow?.job_id ? this.repository.store.jobs.get(follow.job_id) : null;
      if (previous && active.has(previous.state)) {
        this.repository.store.db.prepare("UPDATE knowledge_page_maintenance SET target_digest=? WHERE document_key=?").run(digest, key);
        return previous;
      }
      const { job } = this.repository.store.jobs.enqueueInCurrentTransaction({
        kind, inputRefs: [{ key, request: randomUUID() }], roleVersion: "page-maintenance@1", policyVersion: "selected-materials@1",
        cause: automatic ? "knowledge-maintenance" : "knowledge-request",
      });
      this.repository.store.db.prepare(`INSERT INTO knowledge_page_maintenance VALUES(?,0,?,NULL,?)
        ON CONFLICT(document_key) DO UPDATE SET target_digest=excluded.target_digest,job_id=excluded.job_id`)
        .run(key, digest, job.id);
      return job;
    });
  }

  /** Observe source changes independently of HTTP reads. No model runs here. */
  observe() {
    const plans = new Map(this.repository.pages().map(p => [p.key, p.plan]));
    for (const row of this.repository.store.db.prepare("SELECT * FROM knowledge_page_maintenance WHERE enabled=1").all() as Follow[]) {
      const plan = plans.get(row.document_key);
      if (!plan || (!plan.materialKeys?.length && !plan.contextIds?.length)) continue;
      const digest = this.scopeDigest(plan);
      if (digest !== row.target_digest) this.repository.store.db.prepare(
        "UPDATE knowledge_page_maintenance SET target_digest=? WHERE document_key=?",
      ).run(digest, row.document_key);
      if (digest !== row.processed_digest) this.request(row.document_key, true);
    }
  }

  status(key: string): PageMaintenanceStatus | null {
    const row = this.follow(key);
    if (!row) return null;
    const job = row.job_id ? this.repository.store.jobs.get(row.job_id) : null;
    if (row.enabled && row.target_digest !== row.processed_digest && job && !active.has(job.state))
      return { enabled: true, state: "queued", error: null, updatedAt: job.finishedAt };
    const state = !job ? "idle" : ["queued", "retry_wait"].includes(job.state) ? "queued"
      : ["leased", "running"].includes(job.state) ? "writing" : job.state === "failed" ? "failed"
      : job.state === "succeeded" ? "published" : "idle";
    return { enabled: !!row.enabled, state, error: state === "failed" ? job?.lastError ?? null : null,
      updatedAt: job?.finishedAt ?? null };
  }
  busy() {
    return !!this.repository.store.db.prepare(`SELECT 1 FROM knowledge_page_maintenance m JOIN jobs j ON j.id=m.job_id
      WHERE j.state IN ('queued','retry_wait','leased','running') LIMIT 1`).get();
  }
  lastRun() {
    const row = this.repository.store.db.prepare(`SELECT m.document_key FROM knowledge_page_maintenance m
      JOIN jobs j ON j.id=m.job_id ORDER BY j.updated_at DESC LIMIT 1`).get();
    if (!row) return null;
    const key = String(row.document_key), status = this.status(key)!;
    return { ...status, key, title: this.repository.pages().find(p => p.key === key)?.plan?.title ?? "文章" };
  }
  async processOne() {
    if (!this.worker || this.stopped || this.pending || this.options.blocked?.()) return;
    this.pending = this.worker.processOne();
    try { return await this.pending; } finally { this.pending = null; }
  }
  start() {
    if (this.timer || !this.worker) return;
    const tick = () => {
      try {
        this.observe();
        void this.processOne().catch(error => this.options.onError?.(error));
      } catch (error) { this.options.onError?.(error); }
    };
    this.timer = setInterval(tick, 3000);
    this.timer.unref();
    tick();
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.worker?.stop();
    await this.pending;
  }
}
