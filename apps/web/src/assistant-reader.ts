import type { SourceAnchor } from "../../server/src/retrieval/port";

export type AnswerEvidence = {
  fragmentId: string;
  citationId?: string;
  revisionTitle: string;
  sectionTitle?: string;
  sourceTarget?: SourceAnchor;
};

/** Turn-local citation aliases become readable links to the selected fixed range. */
export function readAssistantAnswer(
  answer: string,
  evidence: AnswerEvidence[],
) {
  const references = [
    ...new Map(
      evidence.map((e) => [
        e.sourceTarget ? JSON.stringify(e.sourceTarget) : e.fragmentId,
        e,
      ]),
    ).values(),
  ];
  const citations = references.map((e, index) => ({
    key: `answer_${index}`,
    target: e.sourceTarget,
    label: e.sectionTitle || e.revisionTitle.split(/[\\/]/).pop() || "原始材料",
    reason: e.sourceTarget
      ? `${e.revisionTitle}，第 ${e.sourceTarget.startLine}–${e.sourceTarget.endLine} 行`
      : e.revisionTitle,
    actionable: true,
  }));
  const mentioned = new Set<string>();
  const aliases = new Map<string, string[]>();
  for (const e of evidence) {
    const index = references.findIndex((r) =>
      r.sourceTarget && e.sourceTarget
        ? JSON.stringify(r.sourceTarget) === JSON.stringify(e.sourceTarget)
        : r.fragmentId === e.fragmentId,
    );
    const key = citations[index]!.key;
    for (const alias of [e.citationId ?? e.fragmentId, e.fragmentId]) {
      aliases.set(alias, [...new Set([...(aliases.get(alias) ?? []), key])]);
    }
  }
  // Match only supplied aliases. Ordinary Markdown links keep their own meaning.
  const escaped = [...aliases.keys()].map((id) =>
    id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  let source = answer;
  if (escaped.length)
    source = source.replace(
      new RegExp(`\\[\\[?(${escaped.join("|")})\\]\\]?`, "g"),
      (_token, id: string) =>
        aliases
          .get(id)!
          .map((key) => {
            mentioned.add(key);
            return `[[${key}]]`;
          })
          .join(" · "),
    );
  source = source.replace(
    /\[\[?(?:e:[\w-]+:\d+:\d+|[a-f0-9]{8}-[a-f0-9-]{25,40})\]\]?/gi,
    "（引用不可用：本次回答未提供对应原文）",
  );
  return {
    source,
    citations,
    references,
    additional: citations.filter((c) => !mentioned.has(c.key)),
  };
}
