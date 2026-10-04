import {
  assistantReplySchema,
  type AssistantReply,
} from "../../../../packages/contracts/src/assistant.js";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import { prepareAgentResearch } from "../knowledge/agent-research.js";
import {
  materialFromRevision,
  type KnowledgeRepository,
} from "../knowledge/repository.js";
import { sourceAnchor } from "../retrieval/units.js";
import { materialSections } from "../knowledge/structure.js";
import type { RetrievalConfig } from "../retrieval/factory.js";
import type { AssistantEvidence, AssistantModelPort } from "./runtime.js";
import { parseAssistantReply } from "./acp-model.js";
import type { ResearchTool } from "../knowledge/agent-research.js";

export function evidenceForRange(
  material: KnowledgeMaterial,
  startLine: number,
  endLine: number,
  visible: (id: string) => boolean,
): AssistantEvidence {
  if (startLine < 1 || endLine < startLine || endLine > material.lineCount)
    throw Error(`引用范围无效：${material.title} 共 ${material.lineCount} 行`);
  const target = sourceAnchor(material, startLine, endLine);
  if (!target.fragmentIds.length || !target.fragmentIds.every(visible))
    throw Error(`引用原文不可见：${material.title}`);
  const fragmentId = target.fragmentIds[0]!;
  const section = materialSections(material)
    .filter((s) => s.startLine <= startLine && s.endLine >= endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  return {
    fragmentId,
    citationId: `e:${fragmentId}:${startLine}:${endLine}`,
    sourceRevisionId: material.revisionId,
    revisionTitle: material.title,
    materialKey: material.key,
    path: material.path,
    sectionTitle: section?.title,
    text: material.text
      .split("\n")
      .slice(startLine - 1, endLine)
      .join("\n"),
    sourceTarget: target,
  };
}

export async function prepareAssistantResearch(input: {
  repository: KnowledgeRepository;
  workspace: string;
  retrievalConfig?: RetrievalConfig;
  context: Parameters<AssistantModelPort["generate"]>[0];
  tools?: ResearchTool[];
  beforeSubmit?: (answer: string, reply: AssistantReply) => void;
}) {
  const context = input.context,
    visible = context.visible ?? (() => context.visibility === "private");
  const materials = input.repository
    .materials()
    .filter((m) =>
      m.fragments.length
        ? m.fragments.every((f) => visible(f.id))
        : context.visibility === "private",
    );
  const offered = new Map(materials.map((m) => [m.key, m]));
  // The shared snapshot admits articles against their exact dependency revisions,
  // and uses that same admitted set for native catalogs and MCP reads.
  const articles = input.repository.published();
  let evidence: AssistantEvidence[] = [];
  const environment = await prepareAgentResearch({
    repository: input.repository,
    materials,
    articles,
    workspace: input.workspace,
    retrievalConfig: input.retrievalConfig,
    visible,
    includeUnanchoredState: context.visibility === "private",
    schema: assistantReplySchema,
    onActivity: context.onResearchActivity,
    tools: input.tools,
    validate: (out) => {
      const parsed = assistantReplySchema.parse(out),
        identities = new Set<string>();
      input.beforeSubmit?.(parsed.answer, parsed);
      if (parsed.create_task && parsed.update_task)
        throw Error("每次只能提议一个事项操作");
      const update = parsed.update_task;
      if (
        update?.action === "reschedule" &&
        (!update.due_at || !update.due_expression)
      )
        throw Error(
          "reschedule 只改真实截止时间，需要 due_at 和原文 due_expression；若只是稍后再提醒检查，用 snooze：next_check_at=snoozed_until，waiting_on=null，due_at=null",
        );
      if (
        update?.action === "snooze" &&
        (!update.follow_up?.snoozed_until ||
          update.follow_up.next_check_at !== update.follow_up.snoozed_until ||
          update.follow_up.waiting_on !== null)
      )
        throw Error(
          "snooze 需要 follow_up.next_check_at=snoozed_until，waiting_on=null 以保留原等待对象；时间词从当前请求原样复制",
        );
      const citations = new Map<string, string>();
      evidence = parsed.citations.map((c) => {
        if (identities.has(c.id)) throw Error(`重复引用编号 ${c.id}`);
        identities.add(c.id);
        const current = offered.get(c.key);
        if (!current) throw Error(`引用不在本次授权材料中：${c.key}`);
        const m =
          c.revision && c.revision !== current.revisionId
            ? materialFromRevision(input.repository.store, c.revision)
            : current;
        if (
          !m ||
          m.sourceId !== current.sourceId ||
          !m.fragments.every((f) => visible(f.id))
        )
          throw Error(`历史版本不在本次授权材料中：${c.key}`);
        const item = evidenceForRange(
          { ...m, key: current.key },
          c.startLine,
          c.endLine,
          visible,
        );
        item.materialDescription =
          input.repository.store.descriptions.get(m.revisionId) ?? undefined;
        citations.set(c.id, item.citationId!);
        return item;
      });
      for (const match of parsed.answer.matchAll(/\[\[(cite_\d+)\]\]/g))
        if (!citations.has(match[1]!))
          throw Error(`正文引用没有原文定位：${match[1]}`);
      if (
        context.mode === "research" &&
        (parsed.create_task || parsed.update_task)
      )
        throw Error("此次仅调查回答，不允许事项操作；两个事项字段须为 null");
      const reply = parseAssistantReply(
        JSON.stringify({
          ...parsed,
          citation_ids: parsed.citations.map((c) => c.id),
        }),
        citations,
      );
      return {
        ...reply,
        researchedEvidence: [
          ...new Map(evidence.map((e) => [e.citationId, e])).values(),
        ],
      };
    },
  });
  return environment;
}
