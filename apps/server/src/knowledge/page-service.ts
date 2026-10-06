import {
  wikiPageBriefSchema,
  type WikiPageBrief,
} from "../../../../packages/contracts/src/knowledge.js";
import type { KnowledgeRepository } from "./repository.js";
import type { KnowledgePageWorker } from "./page-worker.js";

/** Shared by HTTP and the assistant; saving an updated plan never replaces a
 * running worker's frozen input. Observation schedules the latest plan next. */
export class KnowledgePageService {
  constructor(
    readonly repository: KnowledgeRepository,
    readonly maintenance: KnowledgePageWorker,
    readonly available: boolean,
  ) {}
  save(value: WikiPageBrief, editing: boolean) {
    if (!this.available) throw Error("请先在能力与连接中配置 Agent");
    const plan = wikiPageBriefSchema.parse(value);
    const exists = this.repository
      .pages()
      .some((p) => p.key === plan.key && p.plan);
    if (exists !== editing)
      throw Error(
        editing ? "这篇文章没有保存阅读目标" : "文章已存在，请调整原文章",
      );
    if (!plan.materialKeys?.length && !plan.contextIds?.length)
      throw Error("请选择原始材料、项目或主题");
    this.repository.store.contexts.validate(plan.contextIds ?? []);
    if (!this.repository.materialsForPlan(plan).length)
      throw Error("所选范围还没有材料，请先保存材料");
    this.repository.savePlan(plan, true);
    return this.refresh(plan.key);
  }
  refresh(key: string) {
    if (!this.available) throw Error("请先在能力与连接中配置 Agent");
    const job = this.maintenance.request(key);
    return { state: "queued", key, jobId: job.id };
  }
}
