import type {
  KnowledgeArtifact,
  KnowledgeCitation,
  KnowledgeMaterial,
  KnowledgeRole,
  SectionStatus,
} from "../../../../packages/contracts/src/knowledge.js";
import { materialSections } from "./structure.js";

/** Legacy migration uses saved reader intent, not keys, paths or topic names. */
export function publicationRole(a: KnowledgeArtifact): KnowledgeRole {
  return (
    a.publication?.role ??
    (a.reading
      ? a.reading.kind === "reference"
        ? "reference"
        : "article"
      : "note")
  );
}

type Inputs = {
  material: (
    key: string,
    digest?: string,
  ) => KnowledgeMaterial | null | undefined;
  article: (
    key: string,
    revision?: string,
  ) => KnowledgeArtifact | null | undefined;
  invalidated: ReadonlySet<string>;
};
const textAt = (m: KnowledgeMaterial, start: number, end: number) =>
  m.text
    .split("\n")
    .slice(start - 1, end)
    .join("\n")
    .trimEnd();

/** A citation remains pinned to its original. This comparison only decides
 * whether its surrounding chapter/function still applies, including moved lines.
 * No semantic remapping or replacement of the citation happens here. */
export function unchangedContext(
  before: KnowledgeMaterial,
  after: KnowledgeMaterial,
  c: Pick<KnowledgeCitation, "target">,
): boolean {
  if (
    ["actorId", "actorVerifiedBy", "quoted", "forwarded", "eventAt"].some(
      (k) =>
        before[k as keyof KnowledgeMaterial] !==
        after[k as keyof KnowledgeMaterial],
    )
  )
    return false;
  if (before.digest === after.digest) return true;
  if (
    before.images.length ||
    after.images.length ||
    !c.target.startLine ||
    !c.target.endLine
  )
    return false;
  const enclosing = materialSections(before)
    .filter(
      (s) =>
        s.startLine <= c.target.startLine! && s.endLine >= c.target.endLine!,
    )
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (!enclosing || enclosing.kind === "document") return false;
  const candidates = materialSections(after).filter(
    (s) => s.title === enclosing.title && s.kind === enclosing.kind,
  );
  return (
    candidates.length === 1 &&
    textAt(before, enclosing.startLine, enclosing.endLine) ===
      textAt(after, candidates[0]!.startLine, candidates[0]!.endLine)
  );
}

/** Shared by publication, API and retrieval. One changed chapter doesn't erase
 * the rest of an explanation. Investigation reads remain available in the trace. */
export function knowledgeStatus(inputs: Inputs) {
  const cache = new WeakMap<KnowledgeArtifact, Record<string, SectionStatus>>();
  const assess = (a: KnowledgeArtifact): Record<string, SectionStatus> => {
    const saved = cache.get(a);
    if (saved) return saved;
    const result: Record<string, SectionStatus> = Object.fromEntries(
      a.document.sections.map((s) => [
        s.key,
        { state: "needs-review", reason: "关联内容正在核对" },
      ]),
    );
    cache.set(a, result);
    for (const section of a.document.sections) {
      if (inputs.invalidated.has(a.document.key)) {
        result[section.key] = {
          state: "needs-review",
          reason: "已有补充或纠正，需要重新整理这一篇",
        };
        continue;
      }
      const keys = [...section.body.matchAll(/\[\[([\w-]+)\]\]/g)].map(
        (m) => m[1]!,
      );
      let status: SectionStatus = keys.length
        ? { state: "current" }
        : { state: "needs-review", reason: "这一节尚无可核对的来源" };
      const sources: (
        | (Pick<KnowledgeCitation, "target"> & { premise?: string })
        | undefined
      )[] = [
        ...keys.map((key) => a.document.citations.find((c) => c.key === key)),
        ...(section.reviewSources ?? []).map((r) => ({
          target: {
            kind: "material" as const,
            key: r.key,
            startLine: r.startLine,
            endLine: r.endLine,
          },
          premise: r.reason,
        })),
      ];
      for (const c of sources) {
        const dependency =
          c &&
          a.dependencies.find(
            (d) => d.kind === c.target.kind && d.key === c.target.key,
          );
        if (!c || !dependency) {
          status = { state: "unavailable", reason: "这一节的固定来源不完整" };
          break;
        }
        if (c.target.kind === "material") {
          const before = inputs.material(c.target.key, dependency.digest),
            after = inputs.material(c.target.key);
          if (!before || !after) {
            status = {
              state: "unavailable",
              reason: "这一节的来源已移除或无法读取",
            };
            break;
          }
          if (!unchangedContext(before, after, c))
            status = {
              state: "needs-review",
              reason:
                "premise" in c
                  ? `背景前提已有变化：${c.premise}`
                  : "这一节引用的原文章节或函数已有变化，需重新核对",
            };
        } else {
          const child = inputs.article(c.target.key, dependency.digest);
          if (!child) {
            status = { state: "unavailable", reason: "引用的知识版本无法读取" };
            break;
          }
          const states = assess(child);
          const selected = c.target.section
            ? [states[c.target.section]]
            : Object.values(states);
          if (selected.some((s) => !s || s.state === "unavailable")) {
            status = {
              state: "unavailable",
              reason: "引用的知识章节缺少可读来源",
            };
            break;
          }
          if (selected.some((s) => s?.state !== "current"))
            status = {
              state: "needs-review",
              reason: "引用的知识章节需要更新",
            };
          // A replacement can correct prose without touching its originals.
          const latest = inputs.article(c.target.key);
          if (
            latest &&
            (c.target.section
              ? JSON.stringify(
                  latest.document.sections.find(
                    (s) => s.key === c.target.section,
                  ),
                ) !==
                JSON.stringify(
                  child.document.sections.find(
                    (s) => s.key === c.target.section,
                  ),
                )
              : JSON.stringify(latest.document) !==
                JSON.stringify(child.document))
          )
            status = {
              state: "needs-review",
              reason: "引用的知识已有新的解释，需要核对",
            };
        }
      }
      result[section.key] = status;
    }
    return result;
  };
  return assess;
}
