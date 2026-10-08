import { randomUUID } from "node:crypto";
import { stableDigest } from "../storage/digest.js";
import type { MaterialContext } from "../../../../packages/contracts/src/contexts.js";
import type { WikiPageBrief } from "../../../../packages/contracts/src/knowledge.js";
import type { KnowledgePageService } from "./page-service.js";

/** A project/topic's durable understanding is an ordinary knowledge page.
 * This table records identity only; content, sources and jobs remain shared. */
export class ContextViews {
  constructor(readonly pages: KnowledgePageService) {
    pages.repository.store.db.exec(`CREATE TABLE IF NOT EXISTS context_views(
      context_id TEXT PRIMARY KEY REFERENCES material_contexts(id),
      page_key TEXT NOT NULL UNIQUE REFERENCES knowledge_pages(document_key));`);
  }
  private context(id: string) {
    const context = this.pages.repository.store.contexts
      .list()
      .find((c) => c.id === id);
    if (!context) throw Error("项目或主题不存在，请先查看项目列表");
    return context;
  }
  private key(id: string) {
    const row = this.pages.repository.store.db
      .prepare("SELECT page_key FROM context_views WHERE context_id=?")
      .get(id);
    return row ? String(row.page_key) : null;
  }
  list() {
    this.pages.repository.refresh();
    return this.pages.repository.store.contexts
      .list()
      .map((c) => this.read(c.id, false));
  }
  read(id: string, refresh = true) {
    const context = this.context(id),
      key = this.key(id);
    if (refresh) this.pages.repository.refresh();
    const article = key ? this.pages.repository.get(key) : null;
    const plan = key
      ? this.pages.repository.pages().find((p) => p.key === key)?.plan
      : null;
    const maintenance = key ? this.pages.maintenance.status(key) : null;
    const materials = plan ? this.pages.repository.materialsForPlan(plan) : [];
    const snapshot = article?.selection?.materialDigests;
    const sameScope =
      !!snapshot &&
      stableDigest(snapshot) ===
        stableDigest(
          materials
            .map((m) => ({ key: m.key, digest: m.digest }))
            .sort((a, b) => a.key.localeCompare(b.key)),
        );
    const current =
      !!article?.current &&
      sameScope &&
      !["queued", "writing", "failed"].includes(maintenance?.state ?? "idle");
    return {
      context,
      key,
      maintenance,
      current,
      revision: article?.revision ?? null,
      updatedAt: article?.generation.at ?? null,
      document: article?.document ?? null,
      reason: !key
        ? "尚未建立持续理解"
        : !article
          ? "尚未生成项目理解，请查看处理状态"
          : current
            ? null
            : "这份理解尚未覆盖当前全部材料，回答时请补读新增或变化的原文",
    };
  }
  apply(id: string, mode: "start" | "refresh" | "pause" | "resume") {
    const context = this.context(id);
    return this.pages.repository.store.tx(() => {
      let key = this.key(id);
      if (!key) {
        if (mode !== "start") throw Error("尚未建立持续理解，请先开始整理");
        key = `context-view:${randomUUID()}`;
        this.pages.save(contextBrief(context, key), false);
        this.pages.repository.store.db
          .prepare("INSERT INTO context_views VALUES(?,?)")
          .run(id, key);
      } else if (mode === "refresh") {
        this.pages.refresh(key);
      }
      if (mode !== "refresh") {
        if (mode !== "pause" && !this.pages.available)
          throw Error("请先在能力与连接中配置 Agent");
        this.pages.maintenance.setEnabled(key, mode !== "pause");
        if (mode !== "pause") this.pages.maintenance.observe();
      }
      return this.read(id);
    });
  }
}

function contextBrief(context: MaterialContext, key: string): WikiPageBrief {
  return {
    key,
    workflow: "project-understanding",
    title: `${context.name}：当前理解`,
    kind: "explanation",
    order: 0,
    reader: "需要持续了解这个项目或主题的本人",
    goal: "整合已捕获的经历和讨论，快速找回当前安排、约束、变化原因和待解决问题。保留未改变的结论，以原文为依据；未知就明确未知。",
    scenario: context.description || "继续之前的讨论，判断现在的安排和下一步",
    questions: [
      "目前已确认的安排、责任和约束是什么？",
      "重要结论如何随事件变化，变化原因有哪些原文依据？",
      "哪些只是建议、存在矛盾或仍未决定？",
      "下一步是什么，谁在等待什么，已有事项实际处于什么状态？",
    ],
    entryPaths: [],
    contextIds: [context.id],
    topicPath: ["持续理解"],
  };
}
