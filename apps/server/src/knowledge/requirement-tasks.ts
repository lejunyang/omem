import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MemoryService } from "../memory/service.js";
import { stableDigest } from "../storage/digest.js";
import { KnowledgeRepository, type KnowledgeArticle } from "./repository.js";
import type { Store } from "../store.js";
import { fragmentPositions } from "./structure.js";

/** A user follows a particular action. Later accepted revisions update that same
 * personal follow-up task; names in the source remain collaborators, not owner IDs. */
export class RequirementTasks {
  readonly repository: KnowledgeRepository;
  constructor(readonly store: Store) {
    this.repository = new KnowledgeRepository(store);
  }
  board(key: string) {
    this.repository.refresh();
    const article = this.repository.get(key);
    if (article?.reading?.workflow !== "requirement-followup")
      throw Error("需求页不存在");
    return {
      key,
      revision: article.revision,
      current: article.current,
      title: article.document.title,
      requirement: article.document.requirement ?? null,
      questions: article.document.questions,
      links: this.store.db
        .prepare("SELECT * FROM requirement_tasks WHERE page_key=?")
        .all(key),
    };
  }
  follow(key: string, actionId: string, expectedRevision: string, taskId?: string) {
    const board = this.board(key);
    if (board.revision !== expectedRevision || !board.current)
      throw Error("需求页已变化，请重新读取当前行动项");
    const action = board.requirement?.actions.find((a) => a.id === actionId);
    if (!action) throw Error("行动项不存在；请先更新需求页");
    if (action.certainty !== "confirmed")
      throw Error("该事项尚未明确，先补充材料或澄清，不能自动当作承诺");
    const existing = taskId ? this.store.tasks().find(t => t.id === taskId) : null;
    if (taskId && (!existing || existing.workspaceId !== "personal" || existing.ownerId !== "owner" || ["done", "cancelled"].includes(String(existing.status))))
      throw Error("只能关联本人尚未结束的已有待办");
    const contexts = this.repository.get(key)!.reading?.contextIds ?? [];
    if (existing?.projectId && !contexts.includes(String(existing.projectId)))
      throw Error("已有待办属于另一个项目，不能合并");
    this.store.db
      .prepare(
        `INSERT INTO requirement_tasks(page_key,action_id,enabled,updated_at)
      VALUES(?,?,1,?) ON CONFLICT(page_key,action_id) DO UPDATE SET enabled=1,error=NULL,updated_at=excluded.updated_at`,
      )
      .run(key, actionId, new Date().toISOString());
    if (existing) {
      this.store.db.prepare(`UPDATE requirement_tasks SET task_id=?,task_version=?,action_digest=?,article_revision=?,error=NULL WHERE page_key=? AND action_id=?`)
        .run(String(existing.id),Number(existing.version),stableDigest(action),expectedRevision,key,actionId);
    }
    // Explicit follow also acknowledges the latest personal task state before resuming sync.
    this.store.db
      .prepare(
        `UPDATE requirement_tasks SET task_version=(SELECT version FROM tasks WHERE id=task_id) WHERE page_key=? AND action_id=?`,
      )
      .run(key, actionId);
    this.sync(this.repository.get(key)!);
    return this.board(key);
  }
  unfollow(key: string, actionId: string) {
    this.store.db
      .prepare(
        "UPDATE requirement_tasks SET enabled=0,updated_at=? WHERE page_key=? AND action_id=?",
      )
      .run(new Date().toISOString(), key, actionId);
    return this.board(key);
  }
  sync(article: KnowledgeArticle) {
    if (
      article.reading?.workflow !== "requirement-followup" ||
      !article.current ||
      !article.document.requirement
    )
      return;
    for (const link of this.store.db
      .prepare("SELECT * FROM requirement_tasks WHERE page_key=? AND enabled=1")
      .all(article.document.key)) {
      try {
        const action = article.document.requirement.actions.find(
          (a) => a.id === link.action_id,
        );
        if (!action) throw Error("新稿未保留该行动项，旧待办保持不变，请核对");
        if (action.certainty !== "confirmed")
          throw Error("最新材料不再明确，保留原待办等待判断");
        const original = action.evidence
          .map((key) => article.document.citations.find((c) => c.key === key))
          .find((c) => c?.target.kind === "material");
        if (!original) throw Error("行动项缺少原始材料依据");
        const dependency = article.dependencies.find(
          (d) => d.kind === "material" && d.key === original.target.key,
        );
        const material =
          dependency &&
          this.repository.resolveMaterial(dependency.key, dependency.digest)
            ?.material;
        if (!material) throw Error("固定材料不可用");
        const evidence = fragmentPositions(material).find(
          (f) =>
            f.startLine <= (original.target.endLine ?? 1) &&
            f.endLine >= (original.target.startLine ?? 1),
        );
        if (!evidence) throw Error("行动项无法定位到原文");
        const current = link.task_id
          ? this.store.tasks().find((t) => t.id === link.task_id)
          : undefined;
        if (current && current.version !== link.task_version)
          throw Error(
            "待办已由你或其他流程修改；保留修改，重新 follow 后才继续同步",
          );
        const signature = stableDigest(action);
        if (link.action_digest === signature) continue;
        new MemoryService(this.store).applyRequirementFollowUp({
          key: article.document.key,
          actionId: action.id,
          revision: article.revision,
          action,
          evidenceId: evidence.id,
          taskId: current ? String(current.id) : undefined,
          expectedVersion: current ? Number(current.version) : undefined,
          projectId:
            article.reading.contextIds?.length === 1
              ? article.reading.contextIds[0]
              : null,
        });
      } catch (error) {
        this.store.db
          .prepare(
            "UPDATE requirement_tasks SET error=?,updated_at=? WHERE page_key=? AND action_id=?",
          )
          .run(
            String(error),
            new Date().toISOString(),
            article.document.key,
            String(link.action_id),
          );
      }
    }
  }
  syncAll() {
    this.repository.refresh();
    for (const article of this.repository.published()) this.sync(article);
  }
}
export function registerRequirementTasks(
  app: FastifyInstance,
  service: RequirementTasks,
) {
  app.get<{ Params: { key: string } }>("/api/requirements/:key", async (req) =>
    service.board(req.params.key),
  );
  app.post<{ Params: { key: string; id: string } }>(
    "/api/requirements/:key/actions/:id/follow",
    async (req) => {
      const input = z
        .object({ expectedRevision: z.string().min(1), taskId: z.uuid().optional() })
        .parse(req.body);
      return service.follow(
        req.params.key,
        req.params.id,
        input.expectedRevision,
        input.taskId,
      );
    },
  );
  app.delete<{ Params: { key: string; id: string } }>(
    "/api/requirements/:key/actions/:id/follow",
    async (req) => service.unfollow(req.params.key, req.params.id),
  );
  app.addHook("onReady", async () => service.syncAll());
}
