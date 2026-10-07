import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import { DurableJobWorker, JobExecutionError } from "../jobs/worker.js";
import type { JobLease } from "../jobs/repository.js";
import { documentInput, saveImportAsset } from "./documents.js";

export type DocumentImport = {
  id: string;
  externalId: string;
  name: string;
  originalAssetId: string;
  state: string;
  error: string | null;
  revisionId: string | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ImportSelection = {
  contextIds?: string[];
  learning?: boolean;
  notify?: boolean;
};
export type DocumentParser = typeof documentInput;
type Row = Record<string, unknown>;

/** One retained original per document identity; jobs pin the exact uploaded bytes. */
export class DocumentImportService {
  private readonly worker: DurableJobWorker;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<unknown>;
  private stopped = false;
  constructor(
    readonly store: Store,
    private options: { parser?: DocumentParser; pollMs?: number; learningEnabled?: boolean } = {},
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS document_imports(
      id TEXT PRIMARY KEY, external_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      original_asset_id TEXT NOT NULL, selection TEXT NOT NULL, state TEXT NOT NULL,
      error TEXT, revision_id TEXT, job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const fingerprint = "document-import@1";
    this.worker = new DurableJobWorker(
      store.jobs,
      `documents-${randomUUID()}`,
      {
        document_parse: (job, signal) => this.parse(job, signal),
      },
      {
        kinds: ["document_parse"],
        fingerprint: () => ({
          model: null,
          effort: null,
          promptHash: fingerprint,
          skillHash: fingerprint,
          toolHash: fingerprint,
        }),
      },
    );
  }
  private record(row: Row): DocumentImport {
    const job = row.job_id ? this.store.jobs.get(String(row.job_id)) : null;
    return {
      id: String(row.id),
      externalId: String(row.external_id),
      name: String(row.name),
      originalAssetId: String(row.original_asset_id),
      state:
        job && !["succeeded"].includes(job.state)
          ? job.state
          : String(row.state),
      error: job?.lastError ?? (row.error ? String(row.error) : null),
      revisionId: row.revision_id ? String(row.revision_id) : null,
      jobId: row.job_id ? String(row.job_id) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  get(id: string) {
    const row = this.store.db
      .prepare("SELECT * FROM document_imports WHERE id=?")
      .get(id);
    return row ? this.record(row) : null;
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT * FROM document_imports ORDER BY updated_at DESC LIMIT 200",
      )
      .all()
      .map((r) => this.record(r));
  }
  async save(
    input: {
      bytes: Buffer;
      name: string;
      externalId: string;
    } & ImportSelection,
  ) {
    if (![".pdf", ".docx"].includes(extname(input.name).toLowerCase()))
      throw Error("支持 PDF、DOCX 文件");
    if (!input.bytes.length || input.bytes.length > 20_000_000)
      throw Error("文件不能超过 20 MB");
    if (!input.externalId || input.externalId.length > 300)
      throw Error("文档身份无效");
    if (input.contextIds) this.store.contexts.validate(input.contextIds);
    const assetId = await saveImportAsset(this.store.dataDir, input.bytes),
      at = new Date().toISOString();
    const previous = this.store.db
      .prepare("SELECT id FROM document_imports WHERE external_id=?")
      .get(input.externalId);
    const id = previous ? String(previous.id) : randomUUID();
    return this.store.tx(() => {
      this.store.db
        .prepare(
          `INSERT INTO document_imports VALUES(?,?,?,?,?,'saved',NULL,NULL,NULL,?,?)
        ON CONFLICT(external_id) DO UPDATE SET name=excluded.name,original_asset_id=excluded.original_asset_id,
        selection=excluded.selection,state='saved',error=NULL,updated_at=excluded.updated_at`,
        )
        .run(
          id,
          input.externalId,
          basename(input.name),
          assetId,
          JSON.stringify({
            contextIds: input.contextIds,
            learning: input.learning,
            notify: input.notify,
          }),
          at,
          at,
        );
      return this.reparse(id);
    });
  }
  reparse(id: string, options: { requestId?: string } = {}) {
    const row = this.store.db
      .prepare("SELECT * FROM document_imports WHERE id=?")
      .get(id);
    if (!row) throw Error("导入记录不存在");
    if (!this.store.asset(String(row.original_asset_id)))
      throw Error("保存的文档原件不可用，请挂载冷存储或恢复备份");
    const queued = this.store.jobs.enqueue({
      kind: "document_parse",
      inputRefs: [
        {
          importId: id,
          originalAssetId: row.original_asset_id,
          name: row.name,
          externalId: row.external_id,
          selection: JSON.parse(String(row.selection)),
          requestId: options.requestId ?? randomUUID(),
        },
      ],
      roleVersion: "document-parser@1",
      policyVersion: "original-first@1",
      maxAttempts: 3,
      cause: "reparse_saved_original",
    });
    this.store.db
      .prepare(
        "UPDATE document_imports SET job_id=?,state='queued',error=NULL,updated_at=? WHERE id=?",
      )
      .run(queued.job.id, new Date().toISOString(), id);
    return { import: this.get(id)!, job: queued.job };
  }
  private async parse(job: JobLease, signal: AbortSignal) {
    const ref = job.inputRefs[0] as {
      importId: string;
      originalAssetId: string;
      name: string;
      externalId: string;
      selection: ImportSelection;
    };
    const current = () =>
      this.store.db
        .prepare(
          "SELECT original_asset_id,job_id FROM document_imports WHERE id=?",
        )
        .get(ref.importId);
    if (current()?.job_id !== job.id) return { usage: { superseded: true } };
    const bytes = this.store.asset(ref.originalAssetId);
    if (!bytes)
      throw new JobExecutionError(
        "保存的文档原件不可用，请挂载冷存储或恢复备份",
        "config",
      );
    try {
      const input: CaptureInput = await (this.options.parser ?? documentInput)(
        bytes,
        ref.name,
        this.store.dataDir,
        ref.externalId,
      );
      if (signal.aborted)
        throw new JobExecutionError("文档解析已中断，原件仍保留", "transient");
      if (
        current()?.job_id !== job.id ||
        current()?.original_asset_id !== ref.originalAssetId
      )
        return { usage: { superseded: true } };
      const captured = this.store.capture(input, {
        ...ref.selection,
        learning: false,
      });
      const learningJob =
        this.options.learningEnabled !== false && ref.selection.learning !== false
          ? this.store.jobs.enqueue({
              kind: "extract_claims",
              inputRefs: [
                {
                  sourceId: captured.revision.sourceId,
                  revisionId: captured.revision.id,
                  validityEpoch: Number(
                    this.store.db
                      .prepare(
                        "SELECT validity_epoch FROM source_state WHERE source_id=?",
                      )
                      .get(captured.revision.sourceId)!.validity_epoch,
                  ),
                  documentParseJobId: job.id,
                },
              ],
              roleVersion: "extractor@1",
              policyVersion: "memory-policy@1",
              cause: "reparse_saved_original",
              parentJobId: job.id,
            }).job
          : null;
      this.store.db
        .prepare(
          "UPDATE document_imports SET state='parsed',revision_id=?,error=NULL,updated_at=? WHERE id=? AND job_id=?",
        )
        .run(
          captured.revision.id,
          new Date().toISOString(),
          ref.importId,
          job.id,
        );
      return {
        resultRef: captured.revision.id,
        usage: { learningJobId: learningJob?.id ?? null },
      };
    } catch (error) {
      this.store.db
        .prepare(
          "UPDATE document_imports SET state='failed',error=?,updated_at=? WHERE id=? AND job_id=?",
        )
        .run(
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "文档解析失败",
          new Date().toISOString(),
          ref.importId,
          job.id,
        );
      throw error;
    }
  }
  processOnce() {
    return this.worker.processOne();
  }
  start() {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      this.active = this.processOnce()
        .catch(() => {})
        .finally(() => {
          this.active = undefined;
          if (!this.stopped) {
            this.timer = setTimeout(tick, this.options.pollMs ?? 1000);
            this.timer.unref();
          }
        });
    };
    if (!this.active && !this.timer) tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.worker.stop();
    await this.active;
  }
}
