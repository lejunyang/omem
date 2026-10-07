import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Store } from "./store.js";
import { stableDigest } from "./storage/digest.js";
import { DurableJobWorker, JobExecutionError } from "./jobs/worker.js";

export const reprocessingInput = z
  .object({
    requestId: z.uuid(),
    target: z.enum(["source", "article", "document", "message", "bot-event"]),
    targetId: z.string().min(1).max(2000),
    action: z.enum([
      "parse",
      "understand",
      "describe",
      "refresh",
      "write",
      "delete",
    ]),
    replace: z.boolean().default(false),
  })
  .strict();
type Input = z.infer<typeof reprocessingInput>;
type OperationResult = {
  jobIds?: string[];
  revisionId?: string;
  summary?: string;
  cleared?: unknown;
};
type Row = Record<string, unknown>;
const kind = "material:reprocess";
const active = new Set(["queued", "retry_wait", "leased", "running"]);

/** Persistent requests distinguish replaying saved inputs from fetching current remote inputs. */
export class ReprocessingService {
  private worker: DurableJobWorker;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<unknown>;
  private stopped = false;
  constructor(
    readonly store: Store,
    readonly operations: {
      validate: (input: Input) => void;
      run: (
        input: Input,
        requestId: string,
        signal: AbortSignal,
      ) => Promise<OperationResult>;
      onError?: (error: unknown) => void;
      pollMs?: number;
    },
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS reprocessing_requests(
      id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL,job_id TEXT NOT NULL,
      children TEXT NOT NULL DEFAULT '[]',result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
    this.worker = new DurableJobWorker(
      store.jobs,
      `reprocess-${randomUUID()}`,
      {
        [kind]: async (job, signal) => {
          const id = String(
            (job.inputRefs[0] as { requestId: string }).requestId,
          );
          const row = store.db
            .prepare("SELECT * FROM reprocessing_requests WHERE id=?")
            .get(id);
          if (!row)
            throw new JobExecutionError("重新处理请求不存在", "permanent");
          if (row.result) return { resultRef: id };
          const input = reprocessingInput.parse(
            JSON.parse(String(row.payload)),
          );
          operations.validate(input);
          const result = await operations.run(input, id, signal);
          if (signal.aborted)
            throw new JobExecutionError("重新处理已中断", "transient");
          store.db
            .prepare(
              "UPDATE reprocessing_requests SET children=?,result=?,updated_at=? WHERE id=?",
            )
            .run(
              JSON.stringify(result.jobIds ?? []),
              JSON.stringify(result),
              new Date().toISOString(),
              id,
            );
          return { resultRef: id };
        },
      },
      {
        kinds: [kind],
        fingerprint: () => ({
          model: null,
          effort: null,
          promptHash: kind,
          skillHash: "",
          toolHash: kind,
        }),
      },
    );
  }
  submit(value: unknown) {
    const input = reprocessingInput.parse(value),
      digest = stableDigest(input);
    const existing = this.store.db
      .prepare("SELECT digest FROM reprocessing_requests WHERE id=?")
      .get(input.requestId);
    if (existing) {
      if (existing.digest !== digest) throw Error("同一请求已用于不同操作");
      return this.get(input.requestId)!;
    }
    this.operations.validate(input);
    return this.store.tx(() => {
      const job = this.store.jobs.enqueueInCurrentTransaction({
        kind,
        inputRefs: [{ requestId: input.requestId }],
        roleVersion: "reprocessing@1",
        policyVersion: "explicit-replace@1",
        cause: input.action,
      }).job;
      const at = new Date().toISOString();
      this.store.db
        .prepare(
          "INSERT INTO reprocessing_requests(id,payload,digest,job_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(input.requestId, JSON.stringify(input), digest, job.id, at, at);
      return this.get(input.requestId)!;
    });
  }
  private record(row: Row) {
    const input = reprocessingInput.parse(JSON.parse(String(row.payload)));
    const root = this.store.jobs.get(String(row.job_id));
    const children = this.store.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
      SELECT value FROM json_each(?) UNION SELECT j.id FROM jobs j JOIN descendants d ON j.parent_job_id=d.id
    ) SELECT j.id FROM jobs j JOIN descendants d ON j.id=d.id`,
      )
      .all(String(row.children))
      .map((r) => this.store.jobs.get(String(r.id)))
      .filter((j) => !!j);
    const unfinished = children.find((j) => active.has(j.state));
    const failed = children.find((j) =>
      ["failed", "cancelled", "awaiting_decision"].includes(j.state),
    );
    const state =
      root && active.has(root.state)
        ? root.state
        : root?.state !== "succeeded"
          ? (root?.state ?? "failed")
          : unfinished
            ? "running"
            : (failed?.state ?? "succeeded");
    const title =
      input.target === "article"
        ? this.store.db
            .prepare(
              "SELECT json_extract(plan,'$.title') AS title FROM knowledge_pages WHERE document_key=?",
            )
            .get(input.targetId)?.title
        : input.target === "document"
          ? this.store.db
              .prepare("SELECT name AS title FROM document_imports WHERE id=?")
              .get(input.targetId)?.title
          : input.target === "message"
            ? this.store.db
                .prepare(
                  "SELECT chat_name AS title FROM personal_lark_messages WHERE id=?",
                )
                .get(input.targetId)?.title
            : this.store.db
                .prepare(
                  "SELECT r.title FROM revisions r JOIN sources s ON s.head=r.id WHERE s.id=? OR r.id=?",
                )
                .get(input.targetId, input.targetId)?.title;
    return {
      ...input,
      id: String(row.id),
      title: title
        ? String(title)
        : input.target === "bot-event"
          ? "机器人消息"
          : "保存的材料",
      jobId: String(row.job_id),
      state,
      error: failed?.lastError ?? root?.lastError ?? null,
      result: row.result
        ? (JSON.parse(String(row.result)) as OperationResult)
        : null,
      jobs: children.map((j) => ({
        id: j.id,
        kind: j.kind,
        state: j.state,
        error: j.lastError,
      })),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  get(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM reprocessing_requests WHERE id=?")
      .get(id);
    return row ? this.record(row) : null;
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT * FROM reprocessing_requests ORDER BY created_at DESC LIMIT 100",
      )
      .all()
      .map((row) => this.record(row));
  }
  processOnce() {
    return this.worker.processOne();
  }
  retry(id: string) {
    const record = this.get(id);
    if (!record) throw Error("重新处理记录不存在");
    const failed = record.jobs.find((j) =>
      ["failed", "cancelled", "awaiting_decision"].includes(j.state),
    );
    const job = this.store.jobs.get(failed?.id ?? record.jobId)!;
    this.store.jobs.retry({
      jobId: job.id,
      expectedGeneration: job.generation,
      requestId: randomUUID(),
    });
    return this.get(id)!;
  }
  start() {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.pending = this.processOnce()
        .catch((error) => this.operations.onError?.(error))
        .finally(() => {
          this.pending = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(tick, this.operations.pollMs ?? 500);
            this.timer.unref();
          }
        });
    };
    if (!this.pending && !this.timer) tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.worker.stop();
    await this.pending;
  }
}

export function registerReprocessing(
  app: FastifyInstance,
  service: ReprocessingService,
) {
  app.get("/api/reprocessing", async () => service.list());
  app.get<{ Params: { id: string } }>(
    "/api/reprocessing/:id",
    async (req, reply) =>
      service.get(req.params.id) ??
      reply.code(404).send({ error: "重新处理记录不存在" }),
  );
  app.post("/api/reprocessing", async (req, reply) =>
    reply.code(202).send(service.submit(req.body)),
  );
  app.post<{ Params: { id: string } }>(
    "/api/reprocessing/:id/retry",
    async (req) => service.retry(req.params.id),
  );
}
