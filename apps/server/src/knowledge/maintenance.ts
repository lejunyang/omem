import { structuredPatch } from "diff";
import type {
  KnowledgeMaterial,
  WikiPageBrief,
} from "../../../../packages/contracts/src/knowledge.js";
import { stableDigest } from "../storage/digest.js";
import type { KnowledgeArticle, KnowledgeRepository } from "./repository.js";

/** Prior explanations are useful context, but cannot widen the new selection. */
export function articleWithinMaterials(
  repository: KnowledgeRepository,
  materials: KnowledgeMaterial[],
) {
  const keys = new Set(materials.map((m) => m.key));
  const checked = new Map<string, boolean>();
  const visit = (article: KnowledgeArticle): boolean => {
    if (checked.has(article.revision)) return checked.get(article.revision)!;
    checked.set(article.revision, false);
    const allowed =
      (article.investigation ?? []).every((m) => keys.has(m.key)) &&
      article.dependencies.every((d) => {
        if (d.kind === "material")
          return (
            keys.has(d.key) && !!repository.resolveMaterial(d.key, d.digest)
          );
        const child = repository.get(d.key, d.digest);
        return !!child && visit(child);
      });
    checked.set(article.revision, allowed);
    return allowed;
  };
  return visit;
}

export function planMaintenance(
  repository: KnowledgeRepository,
  previous: KnowledgeArticle,
  brief: WikiPageBrief,
  materials: KnowledgeMaterial[],
) {
  const available = new Map(materials.map((m) => [m.key, m]));
  const priorInputs = new Map([
    ...(previous.investigation ?? []).map((m) => [m.key, m.digest] as const),
    ...previous.dependencies
      .filter((d) => d.kind === "material")
      .map((d) => [d.key, d.digest] as const),
  ]);
  const materialChanges = [...priorInputs].flatMap(([key, digest]) => {
    const current = available.get(key);
    if (!current || current.digest === digest) return [];
    const before = repository.resolveMaterial(key, digest)?.material;
    return [
      {
        key,
        title: current.title,
        previousRevision: before?.revisionId,
        currentRevision: current.revisionId,
        // These are investigation starting points, never remapped citations.
        hunks: before
          ? structuredPatch(
              "before",
              "after",
              before.text,
              current.text,
              "",
              "",
              { context: 3 },
            ).hunks.map((h) => ({
              before: {
                startLine: Math.max(1, h.oldStart),
                lineCount: h.oldLines,
              },
              after: {
                startLine: Math.max(1, h.newStart),
                lineCount: h.newLines,
              },
            }))
          : null,
        metadataChanged: before
          ? [
              "actorId",
              "actorVerifiedBy",
              "eventAt",
              "quoted",
              "forwarded",
              "images",
            ].filter(
              (k) =>
                stableDigest(before[k as keyof KnowledgeMaterial] ?? null) !==
                stableDigest(current[k as keyof KnowledgeMaterial] ?? null),
            )
          : [],
      },
    ];
  });
  // An unscoped old plan did not record the whole catalog. Do not pretend every
  // previously unread source is newly added, or trigger a whole-library reread.
  const newlySelected = previous.reading?.materialKeys
    ? materials
        .filter((m) => !previous.reading!.materialKeys!.includes(m.key))
        .map((m) => ({ key: m.key, title: m.title }))
    : [];
  const changedFields = (
    [
      ...new Set([
        ...Object.keys(brief),
        ...Object.keys(previous.reading ?? {}),
      ]),
    ] as (keyof WikiPageBrief)[]
  ).filter(
    (k) =>
      k !== "key" &&
      k !== "order" &&
      stableDigest(brief[k] ?? null) !==
        stableDigest(previous.reading?.[k] ?? null),
  );
  const reusable = articleWithinMaterials(repository, materials)(previous);
  const states = reusable ? repository.statusReader()(previous) : {};
  return {
    previousRevision: previous.revision,
    previousDraft: reusable ? previous.document : undefined,
    previousReading: reusable ? previous.reading : undefined,
    changedFields,
    materialChanges,
    newlySelected,
    sections: reusable
      ? previous.document.sections.map((s) => ({
          key: s.key,
          title: s.title,
          ...states[s.key],
        }))
      : [],
    instruction: reusable
      ? "维护同一篇文章。previousDraft 是旧版解释，不是新的事实来源。先按 changedFields、materialChanges、newlySelected 和 sections 定位本次问题；保留仍回答读者问题的案例、解释和结构。围绕变化及其影响补读，发现矛盾再扩大调查，不从头遍历整个材料库。阅读目标改变时允许重组或删除旧内容。hunks 仅是新旧原文调查入口，不是已确认的语义变化；可用 material_history 读 previousRevision。旧引用行号属于旧版，重新核对当前快照中的位置和含义，不能照抄旧坐标或把旧文当证据。交付完整文章，不写修订日志。"
      : "原文章依赖或调查背景已超出本次材料范围，因此不提供旧正文。保持页面身份，按本次目标和选定材料重新调查、写作；不要寻找或恢复移出范围的内容。",
  };
}

export type ArticleMaintenance = ReturnType<typeof planMaintenance>;

/** Keep a compact provenance record; the complete old page already has history. */
export function maintenanceTrace(maintenance: ArticleMaintenance) {
  const { previousDraft, previousReading, instruction, ...changes } =
    maintenance;
  return { ...changes, reusedDraft: !!previousDraft };
}
