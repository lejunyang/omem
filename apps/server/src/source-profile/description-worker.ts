import { randomUUID } from "node:crypto";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import { DurableJobWorker } from "../jobs/worker.js";
import type { JobLease } from "../jobs/repository.js";
import type { KnowledgeRepository } from "../knowledge/repository.js";

const kind = "material:maintain-description";
const active = new Set(["queued", "retry_wait", "leased", "running"]);
type Follow = { source_id: string; enabled: number; processed_revision: string | null; job_id: string | null };

/** Explicitly followed sources only. Imported annotations never enroll a whole
 * library. A pending request reads the latest revision, coalescing rapid edits. */
export class MaterialDescriptionWorker {
  private worker?: DurableJobWorker;
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<unknown> | null = null;
  private stopped = false;

  constructor(readonly repository: KnowledgeRepository, readonly options: {
    run?: (material: KnowledgeMaterial, job: JobLease, signal: AbortSignal) => Promise<void>;
    blocked?: () => boolean;
    onError?: (error: unknown) => void;
  } = {}) {
    const { store } = repository;
    store.db.exec(`CREATE TABLE IF NOT EXISTS material_description_maintenance(
      source_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
      processed_revision TEXT, job_id TEXT);`);
    if (options.run) this.worker = new DurableJobWorker(store.jobs, `material-descriptions-${randomUUID()}`, {
      [kind]: async (job, signal) => {
        const sourceId = (job.inputRefs[0] as { sourceId: string }).sourceId;
        if (job.cause === "material-description-refresh" && !this.follow(sourceId)?.enabled) return {};
        const material = repository.materials().find(m => m.sourceId === sourceId);
        if (!material) {
          store.db.prepare(`UPDATE material_description_maintenance SET processed_revision=(SELECT head FROM sources WHERE id=?)
            WHERE source_id=?`).run(sourceId, sourceId);
          return {};
        }
        try {
          // A manual correction made while queued always wins. A later correction
          // during execution is protected by the description's optimistic version.
          const current = store.descriptions.get(material.revisionId);
          if (current?.author !== "user" && !(current && job.cause === "material-description-refresh"))
            await options.run!(material, job, signal);
          return { resultRef: material.revisionId };
        } finally {
          if (!signal.aborted || (!this.stopped && store.jobs.get(job.id)?.cancelRequested)) store.db.prepare(
            "UPDATE material_description_maintenance SET processed_revision=? WHERE source_id=?",
          ).run(material.revisionId, sourceId);
        }
      },
    }, {
      kinds: [kind], leaseMs: 60000, heartbeatMs: 10000,
      fingerprint: () => ({ model: null, effort: null, promptHash: kind, skillHash: "", toolHash: "" }),
    });
  }

  private follow(sourceId: string) {
    return this.repository.store.db.prepare("SELECT * FROM material_description_maintenance WHERE source_id=?").get(sourceId) as Follow | undefined;
  }
  private source(revisionId: string) {
    const row = this.repository.store.db.prepare("SELECT s.id,s.head FROM sources s JOIN revisions r ON r.source_id=s.id WHERE r.id=?").get(revisionId);
    if (!row) throw Error("材料版本不存在");
    return { id: String(row.id), head: String(row.head) };
  }

  setEnabled(revisionId: string, enabled: boolean) {
    const source = this.source(revisionId), { store } = this.repository;
    if (source.head !== revisionId) throw Error("请在当前版本调整自动整理");
    const baseline = store.descriptions.get(revisionId) ? revisionId : null;
    store.db.prepare(`INSERT INTO material_description_maintenance VALUES(?,?,?,NULL)
      ON CONFLICT(source_id) DO UPDATE SET enabled=excluded.enabled`).run(source.id, enabled ? 1 : 0, baseline);
    const row = this.follow(source.id)!;
    if (enabled && !baseline) this.request(revisionId, true);
    if (!enabled && row.job_id) {
      const job = store.jobs.get(row.job_id);
      if (job && job.cause === "material-description-refresh" && active.has(job.state)) {
        const request = { jobId: job.id, expectedGeneration: job.generation, requestId: randomUUID() };
        if (this.worker) this.worker.cancel(request); else store.jobs.cancel(request);
      }
    }
    return this.status(revisionId);
  }

  request(revisionId: string, automatic = false) {
    const source = this.source(revisionId), { store } = this.repository;
    if (source.head !== revisionId) throw Error("材料已更新，请重新选择当前版本");
    return store.tx(() => {
      const previous = this.follow(source.id);
      const job = previous?.job_id ? store.jobs.get(previous.job_id) : null;
      if (job && active.has(job.state)) return job;
      const queued = store.jobs.enqueueInCurrentTransaction({ kind,
        inputRefs: [{ sourceId: source.id, request: randomUUID() }],
        roleVersion: "material-description@1", policyVersion: "followed-source@1",
        cause: automatic ? "material-description-refresh" : "material-description-request",
      }).job;
      store.db.prepare(`INSERT INTO material_description_maintenance VALUES(?,0,NULL,?)
        ON CONFLICT(source_id) DO UPDATE SET job_id=excluded.job_id`).run(source.id, queued.id);
      return queued;
    });
  }

  observe() {
    const { store } = this.repository;
    for (const row of store.db.prepare(`SELECT m.*,s.head FROM material_description_maintenance m
      JOIN sources s ON s.id=m.source_id WHERE m.enabled=1`).all()) {
      const revision = String(row.head);
      if (revision === row.processed_revision) continue;
      if (store.descriptions.get(revision)) {
        store.db.prepare("UPDATE material_description_maintenance SET processed_revision=? WHERE source_id=?").run(revision, String(row.source_id));
      } else this.request(revision, true);
    }
  }

  status(revisionId: string) {
    const source = this.source(revisionId), follow = this.follow(source.id);
    const job = follow?.job_id ? this.repository.store.jobs.get(follow.job_id) : null;
    const historical = source.head !== revisionId;
    const state = historical || !job ? "idle" : ["queued", "retry_wait"].includes(job.state) ? "queued"
      : ["leased", "running"].includes(job.state) ? "running" : job.state === "failed" ? "failed"
      : job.state === "succeeded" ? "done" : "idle";
    return { enabled: !!follow?.enabled, state, revisionIds: [revisionId],
      error: state === "failed" ? job?.lastError ?? null : null };
  }

  async processOne() {
    if (!this.worker || this.stopped || this.pending || this.options.blocked?.()) return;
    this.pending = this.worker.processOne();
    try { return await this.pending; } finally { this.pending = null; }
  }
  start() {
    if (this.timer || !this.worker) return;
    const tick = () => {
      try { this.observe(); void this.processOne().catch(e => this.options.onError?.(e)); }
      catch (e) { this.options.onError?.(e); }
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
