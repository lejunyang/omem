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
  const previousSelection = previous.selection?.materialKeys ?? previous.reading?.materialKeys;
  const newlySelected = previousSelection
    ? materials
        .filter((m) => !previousSelection.includes(m.key))
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
      ? "保持同一文章身份。先按当前读者与目标试读 previousDraft，决定哪些解释有用、哪些内容妨碍理解，在 composition 中给出取舍。旧稿不是事实来源；已有标题或逐题提到了相关词不代表完成了读者任务。再用 changedFields、materialChanges、newlySelected 和 sections 调查影响，按用途决定哪些变化值得进入正文，不要求将所有变更写入文章。原路线仍适用时局部维护；需要重组时保留必要事实与例子，不保留旧的叙述负担。hunks 是原文调查入口，不是语义结论；material_history 可读 previousRevision。旧引用属于旧版，核对当前原件中的位置与含义。交付完整文章，调查与验证经过留在记录中。"
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
