import type { z } from "zod";
import type { reprocessingInput } from "./reprocessing.js";
import type { Store } from "./store.js";
import type { Config } from "./config.js";
import { knowledgeProfile } from "./config.js";
import type { KnowledgeRepository } from "./knowledge/repository.js";
import type { KnowledgePageService } from "./knowledge/page-service.js";
import type { MaterialDescriptionWorker } from "./source-profile/description-worker.js";
import type { DocumentImportService } from "./imports/service.js";
import type { PersonalLarkService } from "./integrations/lark-personal/service.js";
import { sourceForMaterialKey } from "./knowledge/material-identity.js";
import { fileInput, gitInput, larkInput } from "./connectors.js";
import { captureSchema } from "../../../packages/contracts/src/index.js";
type Input = z.infer<typeof reprocessingInput>;

export function reprocessingOperations(deps: {
  store: Store;
  config: Config;
  repository: KnowledgeRepository;
  pages: KnowledgePageService;
  descriptions: MaterialDescriptionWorker;
  documents: DocumentImportService;
  personalLark: PersonalLarkService;
  bot: (
    id: string,
    remote: boolean,
    replace: boolean,
    requestId: string,
  ) => Promise<{ jobIds?: string[]; revisionId?: string; summary?: string }>;
}) {
  const { store } = deps;
  function source(input: Input) {
    let id = input.targetId;
    if (input.target === "message") {
      const message = store.db
        .prepare("SELECT revision_id FROM personal_lark_messages WHERE id=?")
        .get(id);
      if (!message?.revision_id)
        throw Error("消息原文尚未保存，先重新读取资源");
      id = String(message.revision_id);
    }
    if (input.target === "document") {
      const item = deps.documents.get(id);
      if (!item?.revisionId) return null;
      id = item.revisionId;
    }
    const row =
      store.db
        .prepare(
          "SELECT id,head,namespace,external_id FROM sources WHERE id=? OR id=(SELECT source_id FROM revisions WHERE id=?)",
        )
        .get(id, id) ??
      (() => {
        const material = sourceForMaterialKey(store.db, id);
        return material
          ? store.db
              .prepare(
                "SELECT id,head,namespace,external_id FROM sources WHERE id=?",
              )
              .get(material)
          : undefined;
      })();
    if (!row) throw Error("材料来源不存在");
    const revision = store.revision(String(row.head));
    if (!revision) throw Error("材料原件已移除或尚未保存");
    return {
      id: String(row.id),
      externalId: String(row.external_id),
      revision,
    };
  }
  function document(input: Input) {
    if (input.target === "document") return deps.documents.get(input.targetId);
    const material = source(input);
    const item =
      material &&
      store.db
        .prepare(
          "SELECT id FROM document_imports WHERE revision_id=? OR external_id=? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(material.revision.id, material.externalId);
    return item ? deps.documents.get(String(item.id)) : null;
  }
  function validate(input: Input) {
    const choices: Record<Input["target"], Input["action"][]> = {
      source: ["parse", "understand", "describe", "refresh", "delete"],
      document: ["parse", "understand", "describe", "delete"],
      message: ["understand", "describe", "refresh", "delete"],
      article: ["write", "delete"],
      "bot-event": ["understand", "refresh"],
    };
    if (!choices[input.target].includes(input.action))
      throw Error("这个对象不支持所选处理方式");
    if (
      ["write", "describe"].includes(input.action) &&
      !knowledgeProfile(deps.config)
    )
      throw Error("请先在能力与连接中配置知识 Agent");
    if (
      (input.action === "understand" ||
        (input.target === "bot-event" && input.action === "refresh")) &&
      !(
        deps.config.learning?.enabled &&
        deps.config.profiles.some(
          (p) => p.id === deps.config.learning?.profileId,
        )
      )
    )
      throw Error("请先启用材料理解并配置学习 Agent");
    if (input.target === "article") {
      if (
        !deps.repository.pages().some((p) => p.key === input.targetId && p.plan)
      )
        throw Error("文章没有保存阅读目标");
    } else if (input.target === "bot-event") {
      if (
        !store.db
          .prepare("SELECT 1 FROM event_inbox WHERE id=?")
          .get(input.targetId)
      )
        throw Error("机器人收件记录不存在");
    } else if (input.action === "parse") {
      if (
        !document(input) &&
        source(input)?.revision.context.document?.parser !== "docling"
      )
        throw Error("这份材料没有保存可重新解析的原文件");
    } else if (!source(input)) throw Error("原件尚未解析完成");
  }
  return {
    validate,
    async run(input: Input, requestId: string, signal: AbortSignal) {
      signal.throwIfAborted();
      if (input.target === "bot-event")
        return deps.bot(
          input.targetId,
          input.action === "refresh",
          input.replace,
          requestId,
        );
      if (input.target === "article") {
        const cleared =
          input.replace || input.action === "delete"
            ? deps.repository.clear(input.targetId)
            : undefined;
        if (input.action === "delete")
          return { summary: "文章正文及旧成果已删除，阅读目标保留", cleared };
        return {
          jobIds: [deps.pages.refresh(input.targetId).jobId],
          summary: "已安排重新调查、写作和独立复核",
          cleared,
        };
      }
      const material = source(input);
      const clear = () =>
        material
          ? store.retention.clearDerived(material.id, {
              learning: input.action !== "describe",
              descriptions: input.action !== "understand",
              articles: ["delete", "refresh"].includes(input.action),
            })
          : undefined;
      const cleared =
        input.replace || input.action === "delete" ? clear() : undefined;
      if (input.action === "delete")
        return {
          summary: "旧派生成果已清除，原件保留；人工调整的事项仍可继续跟进",
          cleared,
        };
      if (input.action === "parse") {
        const item = document(input);
        const original = material?.revision.context.document;
        const bytes =
          !item && original ? store.asset(original.originalAssetId) : null;
        if (!item && (!bytes || !original || !material))
          throw Error("保存的原文件不可用，请检查冷存储");
        const result = item
          ? deps.documents.reparse(item.id, { requestId })
          : await deps.documents.save({
              bytes: bytes!,
              name: original!.originalName,
              externalId: material!.externalId,
              contextIds: store.contexts.forSource(material!.id),
            });
        return {
          jobIds: [result.job.id],
          summary: "正在使用保存的原文件重新解析",
          cleared,
        };
      }
      if (!material) throw Error("原件尚未解析完成");
      if (input.action === "describe")
        return {
          jobIds: [deps.descriptions.request(material.revision.id).id],
          summary: "已安排重写材料用途与概念说明",
          cleared,
        };
      if (input.action === "understand") {
        const state = store.db
          .prepare("SELECT validity_epoch FROM source_state WHERE source_id=?")
          .get(material.id);
        const job = store.jobs.enqueue({
          kind: "extract_claims",
          inputRefs: [
            {
              sourceId: material.id,
              revisionId: material.revision.id,
              validityEpoch: Number(state?.validity_epoch ?? 1),
              reprocessingId: requestId,
            },
          ],
          roleVersion: "extractor@1",
          policyVersion: "memory-policy@1",
          cause: "reprocess_saved_original",
        }).job;
        return {
          jobIds: [job.id],
          summary: "已安排重新理解保存的材料并独立复查",
          cleared,
        };
      }
      if (input.action === "refresh") {
        if (input.target === "message") {
          await deps.personalLark.retry(input.targetId);
          const current = source(input)!;
          // This explicit request must not reuse a previous successful learning run.
          if (deps.config.learning?.enabled) {
            const state = store.db
              .prepare(
                "SELECT validity_epoch FROM source_state WHERE source_id=?",
              )
              .get(current.id);
            const job = store.jobs.enqueue({
              kind: "extract_claims",
              inputRefs: [
                {
                  sourceId: current.id,
                  revisionId: current.revision.id,
                  validityEpoch: Number(state?.validity_epoch ?? 1),
                  reprocessingId: requestId,
                },
              ],
              roleVersion: "extractor@1",
              policyVersion: "memory-policy@1",
              cause: "reprocess_remote_message",
            }).job;
            return {
              jobIds: [job.id],
              revisionId: current.revision.id,
              summary: "资源与分类已重新读取，已安排理解",
              cleared,
            };
          }
          return {
            revisionId: current.revision.id,
            summary: "资源与分类已重新读取，材料理解尚未启用",
            cleared,
          };
        }
        const connector = material.revision.context.connector;
        let updated;
        if (connector?.kind === "file" && connector.path)
          updated = await fileInput(
            connector.path,
            deps.config.captureRoots,
            store.dataDir,
          );
        else if (connector?.kind === "git" && connector.repo && connector.path)
          updated = await gitInput(
            connector.repo,
            connector.path,
            connector.ref ?? "HEAD",
            deps.config.captureRoots,
          );
        else if (connector?.kind === "lark" && connector.url)
          updated = await larkInput(connector.url, store.dataDir);
        else throw Error("这份材料没有保存来源连接信息，请重新导入最新版");
        signal.throwIfAborted();
        const result = store.capture(captureSchema.parse(updated), {
          contextIds: store.contexts.forSource(material.id),
          learning: false,
        });
        const job = deps.config.learning?.enabled
          ? store.jobs.enqueue({
              kind: "extract_claims",
              inputRefs: [
                {
                  sourceId: result.revision.sourceId,
                  revisionId: result.revision.id,
                  validityEpoch: Number(
                    store.db
                      .prepare(
                        "SELECT validity_epoch FROM source_state WHERE source_id=?",
                      )
                      .get(result.revision.sourceId)?.validity_epoch ?? 1,
                  ),
                  reprocessingId: requestId,
                },
              ],
              roleVersion: "extractor@1",
              policyVersion: "memory-policy@1",
              cause: "reprocess_remote_original",
            }).job
          : null;
        return {
          jobIds: job ? [job.id] : [],
          revisionId: result.revision.id,
          summary: "已从来源读取当前内容",
          cleared,
        };
      }
      throw Error("处理方式不支持");
    },
  };
}
