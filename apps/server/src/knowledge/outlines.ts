import { randomUUID } from "node:crypto";
import {
  knowledgeOutlineInputSchema,
  knowledgeOutlineProposalSchema,
  knowledgeOutlinePageInputSchema,
  type KnowledgeOutlineInput,
  type KnowledgeOutlineDraft,
  type KnowledgeOutlineProposal,
  type KnowledgeOutlineView,
} from "../../../../packages/contracts/src/knowledge-outline.js";
import { wikiPageBriefSchema } from "../../../../packages/contracts/src/knowledge.js";
import { DurableJobWorker } from "../jobs/worker.js";
import type { JobLease } from "../jobs/repository.js";
import type { KnowledgeRepository } from "./repository.js";
import type { KnowledgePageService } from "./page-service.js";

const kind = "knowledge:outline";
const active = new Set(["queued", "retry_wait", "leased", "running"]);
const timestamp = () => new Date().toISOString();

/** Directory proposals are saved separately from the published articles.
 * Confirmation applies ordinary reader plans and queues their existing writer. */
export class KnowledgeOutlineService {
  private worker: DurableJobWorker | undefined;
  private pending: Promise<unknown> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    readonly repository: KnowledgeRepository,
    readonly pages: KnowledgePageService,
    readonly options: {
      run?: (
        draft: KnowledgeOutlineDraft,
        job: JobLease,
        signal: AbortSignal,
      ) => Promise<KnowledgeOutlineProposal>;
      blocked?: () => boolean;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    repository.store.db
      .exec(`CREATE TABLE IF NOT EXISTS knowledge_outline_drafts(
      id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL,job_id TEXT,
      payload TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    if (options.run)
      this.worker = new DurableJobWorker(
        repository.store.jobs,
        `knowledge-outlines-${randomUUID()}`,
        {
          [kind]: async (job, signal) => {
            const { id, version } = job.inputRefs[0] as {
              id: string;
              version: number;
            };
            const draft = this.raw(id);
            if (
              !draft ||
              draft.version !== version ||
              draft.jobId !== job.id ||
              draft.state !== "planning"
            )
              return {};
            try {
              this.validateScope(draft, false);
              const result = knowledgeOutlineProposalSchema.parse(
                await options.run!(draft, job, signal),
              );
              const candidate = {
                ...draft,
                pages: result.pages.map((p) => ({ ...p, id: randomUUID() })),
              };
              this.validateScope(candidate, true);
              if (signal.aborted) throw Error("目录规划已暂停");
              this.compareAndWrite(
                {
                  ...candidate,
                  version: version + 1,
                  state: "ready",
                  rationale: result.rationale,
                  gaps: result.gaps,
                  error: null,
                  updatedAt: timestamp(),
                },
                version,
                job.id,
              );
              return { resultRef: id };
            } catch (error) {
              // A reader edit cancels the old candidate. Shutdown keeps the queued
              // request recoverable; a failed model never erases a useful old draft.
              if (!signal.aborted)
                this.compareAndWrite(
                  {
                    ...draft,
                    version: version + 1,
                    state: "failed",
                    error:
                      error instanceof Error ? error.message : String(error),
                    updatedAt: timestamp(),
                  },
                  version,
                  job.id,
                );
              throw error;
            }
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
            toolHash: "",
          }),
        },
      );
  }

  private raw(id: string): KnowledgeOutlineDraft | null {
    const row = this.repository.store.db
      .prepare("SELECT payload FROM knowledge_outline_drafts WHERE id=?")
      .get(id);
    return row
      ? (JSON.parse(String(row.payload)) as KnowledgeOutlineDraft)
      : null;
  }
  private write(draft: KnowledgeOutlineDraft) {
    this.repository.store.db
      .prepare(
        `INSERT INTO knowledge_outline_drafts VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,job_id=excluded.job_id,payload=excluded.payload,updated_at=excluded.updated_at`,
      )
      .run(
        draft.id,
        draft.version,
        draft.state,
        draft.jobId,
        JSON.stringify(draft),
        draft.updatedAt,
      );
    return draft;
  }
  private compareAndWrite(
    draft: KnowledgeOutlineDraft,
    version: number,
    jobId: string,
  ) {
    return this.repository.store.db
      .prepare(
        `UPDATE knowledge_outline_drafts SET version=?,state=?,payload=?,updated_at=?
      WHERE id=? AND version=? AND job_id=? AND state='planning'`,
      )
      .run(
        draft.version,
        draft.state,
        JSON.stringify(draft),
        draft.updatedAt,
        draft.id,
        version,
        jobId,
      ).changes;
  }
  private expect(id: string, version: number) {
    const draft = this.raw(id);
    if (!draft) throw Error("目录草案不存在");
    if (!Number.isSafeInteger(version) || draft.version !== version)
      throw Error("草案已在其他窗口更新，请重新载入后再修改");
    return draft;
  }
  /** Child scopes are explicit subsets. Reusing an existing article does not
   * silently import its previous materials, workflow or attached private state. */
  validateScope(input: KnowledgeOutlineInput, complete: boolean) {
    const contexts = new Set(input.contextIds);
    this.repository.store.contexts.validate(input.contextIds);
    const all = this.repository.materials();
    const rootKeys = new Set(input.materialKeys);
    if ([...rootKeys].some((key) => !all.some((m) => m.key === key)))
      throw Error("部分所选材料已不可用，请调整草案材料范围");
    const sources = this.repository.store.contexts.sourceIds(input.contextIds);
    for (const material of all)
      if (sources.has(material.sourceId)) rootKeys.add(material.key);
    if (complete && !rootKeys.size)
      throw Error("请选择已有原始材料、项目或主题，所选范围尚无材料");
    if (new Set(input.pages.map((p) => p.id)).size !== input.pages.length)
      throw Error("草案页面重复，请保留一个页面后重试");
    const existing = new Set<string>();
    for (const page of input.pages) {
      if (complete) {
        const { id: _id, ...content } = page;
        if (!knowledgeOutlinePageInputSchema.safeParse(content).success)
          throw Error(
            `请补全「${page.title || "未命名页面"}」的标题、读者、目标与需要回答的问题`,
          );
      }
      if (
        page.materialKeys.some((key) => !rootKeys.has(key)) ||
        page.contextIds.some((id) => !contexts.has(id))
      )
        throw Error(
          `「${page.title}」的材料超出目录草案范围，请先把材料加入整个草案`,
        );
      if (complete && !page.materialKeys.length && !page.contextIds.length)
        throw Error(`请为「${page.title}」选择材料或项目`);
      if (page.existingKey) {
        const saved = this.repository
          .pages()
          .find((p) => p.key === page.existingKey);
        if (!saved?.plan || saved.plan.workflow === "requirement-followup")
          throw Error(`「${page.title}」不能延续所选文章，请选择普通知识文章`);
        if (existing.has(page.existingKey))
          throw Error("同一篇已有文章只能在草案中出现一次");
        existing.add(page.existingKey);
        // Host-attached inputs are a separate workflow scope. An ordinary
        // outline cannot inherit those outside the owner's selected originals.
        const attached = this.repository.store.db
          .prepare(
            "SELECT source_id FROM knowledge_page_inputs WHERE document_key=?",
          )
          .all(page.existingKey);
        const pageSources = this.repository.store.contexts.sourceIds(
          page.contextIds,
        );
        for (const material of all)
          if (page.materialKeys.includes(material.key))
            pageSources.add(material.sourceId);
        if (attached.some((row) => !pageSources.has(String(row.source_id))))
          throw Error(
            `「${page.title}」有未选入本页的关联材料，请扩大本页范围或新建文章`,
          );
      }
    }
    return all.filter((m) => rootKeys.has(m.key));
  }
  create(value: unknown) {
    const input = knowledgeOutlineInputSchema.parse(value);
    this.validateScope(input, false);
    const at = timestamp();
    return this.write({
      ...input,
      id: randomUUID(),
      version: 1,
      state: "editing",
      rationale: "",
      gaps: [],
      error: null,
      jobId: null,
      appliedPages: [],
      createdAt: at,
      updatedAt: at,
    });
  }
  list() {
    return this.repository.store.db
      .prepare(
        "SELECT id FROM knowledge_outline_drafts ORDER BY updated_at DESC",
      )
      .all()
      .map((row) => this.get(String(row.id))!);
  }
  get(id: string): KnowledgeOutlineView | null {
    let draft = this.raw(id);
    if (!draft) return null;
    const job = draft.jobId && this.repository.store.jobs.get(draft.jobId);
    if (
      draft.state === "planning" &&
      job &&
      ["failed", "cancelled", "awaiting_user"].includes(job.state)
    ) {
      draft = this.write({
        ...draft,
        version: draft.version + 1,
        state: "failed",
        error: job.lastError ?? "目录规划未完成，可以保留修改后重试",
        updatedAt: timestamp(),
      });
    }
    return {
      ...draft,
      pageStatuses: draft.appliedPages.map((page) => {
        const saved = this.repository.pages().find((p) => p.key === page.key);
        const status = this.pages.maintenance.status(page.key);
        return {
          id: page.id,
          key: page.key,
          title: saved?.plan?.title ?? "文章",
          state: status?.state ?? saved?.state ?? "planned",
          error: status?.error ?? (saved?.error as string | null) ?? null,
        };
      }),
    };
  }
  save(id: string, version: number, value: unknown) {
    const input = knowledgeOutlineInputSchema.parse(value);
    this.validateScope(input, false);
    return this.repository.store.tx(() => {
      const draft = this.expect(id, version);
      if (draft.state === "applied")
        throw Error("这个草案已确认，请新建草案或调整文章的材料与目标");
      this.cancelPlanning(draft);
      return this.write({
        ...draft,
        ...input,
        version: version + 1,
        state: "editing",
        error: null,
        jobId: null,
        updatedAt: timestamp(),
      });
    });
  }
  propose(id: string, version: number) {
    if (!this.options.run)
      throw Error("请先在能力与连接中配置 Agent，再生成目录建议");
    return this.repository.store.tx(() => {
      const draft = this.expect(id, version);
      if (draft.state === "applied") throw Error("这个草案已确认，请新建草案");
      if (!draft.title || !draft.reader || !draft.goal)
        throw Error("请先填写目录标题、读者与阅读目标");
      if (!this.validateScope(draft, false).length)
        throw Error("请选择已有原始材料、项目或主题，所选范围尚无材料");
      if (draft.state === "planning") return draft;
      const next = version + 1;
      const { job } = this.repository.store.jobs.enqueueInCurrentTransaction({
        kind,
        inputRefs: [{ id, version: next }],
        roleVersion: "knowledge-outline@1",
        policyVersion: "reader-directory@1",
        cause: "knowledge-outline",
        maxAttempts: 3,
      });
      return this.write({
        ...draft,
        version: next,
        state: "planning",
        jobId: job.id,
        error: null,
        updatedAt: timestamp(),
      });
    });
  }
  apply(id: string, version: number) {
    if (!this.pages.available)
      throw Error("请先在能力与连接中配置 Agent，再确认目录并整理正文");
    return this.repository.store.tx(() => {
      const prior = this.raw(id);
      if (
        prior?.state === "applied" &&
        (version === prior.version || version === prior.version - 1)
      )
        return this.get(id)!;
      const draft = this.expect(id, version);
      if (draft.state === "planning")
        throw Error("Agent 正在调查目录，请等待完成或保存人工修改后确认");
      if (!draft.pages.length) throw Error("请先添加至少一个页面");
      if (!draft.title || !draft.reader || !draft.goal)
        throw Error("请补全目录标题、读者与阅读目标");
      this.validateScope(draft, true);
      const plans = draft.pages.map((page, order) => {
        const { id: _id, existingKey, ...content } = page;
        const previous = existingKey
          ? this.repository.pages().find((p) => p.key === existingKey)?.plan
          : null;
        const plan = wikiPageBriefSchema.parse({
          ...previous,
          ...content,
          key: existingKey ?? `page:${randomUUID()}`,
          order,
          ...(content.contextIds.length ? {} : { contextIds: undefined }),
        });
        if (!this.repository.materialsForPlan(plan).length)
          throw Error(`「${plan.title}」的范围尚无材料，请重新选择`);
        if (
          existingKey &&
          ["queued", "writing"].includes(
            this.pages.maintenance.status(existingKey)?.state ?? "",
          )
        )
          throw Error(`「${plan.title}」正在整理，请等待本次完成再确认草案`);
        return plan;
      });
      // Every plan and queue entry commits together. The worker cannot observe
      // a partially applied hierarchy; old article bodies and citations remain.
      const appliedPages = plans.map((plan, index) => {
        this.repository.savePlan(plan, true);
        const { jobId } = this.pages.refresh(plan.key);
        return { id: draft.pages[index]!.id, key: plan.key, jobId };
      });
      this.write({
        ...draft,
        version: version + 1,
        state: "applied",
        error: null,
        appliedPages,
        updatedAt: timestamp(),
      });
      return this.get(id)!;
    });
  }
  delete(id: string, version: number) {
    return this.repository.store.tx(() => {
      const draft = this.expect(id, version);
      this.cancelPlanning(draft);
      this.repository.store.db
        .prepare("DELETE FROM knowledge_outline_drafts WHERE id=?")
        .run(id);
      return { deleted: true };
    });
  }
  private cancelPlanning(draft: KnowledgeOutlineDraft) {
    const job = draft.jobId && this.repository.store.jobs.get(draft.jobId);
    if (draft.state !== "planning" || !job || !active.has(job.state)) return;
    const request = {
      jobId: job.id,
      expectedGeneration: job.generation,
      requestId: randomUUID(),
    };
    if (this.worker) this.worker.cancel(request);
    else this.repository.store.jobs.cancel(request);
  }
  busy() {
    return this.pending !== null;
  }
  async processOne() {
    if (
      !this.worker ||
      this.stopped ||
      this.pending ||
      this.options.blocked?.()
    )
      return;
    this.pending = this.worker.processOne();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  start() {
    if (this.timer || !this.worker) return;
    const tick = () => {
      void this.processOne().catch((error) => this.options.onError?.(error));
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
