import type { KnowledgeOutlinePage } from "../../../../packages/contracts/src/knowledge-outline";

export const outlineLines = (value: string) => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];

export const outlinePath = (value: string) =>
  value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

/** A directory move keeps inherited subdirectories and leaves separately placed pages alone. */
export function moveOutlineRoot(
  pages: KnowledgeOutlinePage[],
  previousRoot: string[],
  nextRoot: string[],
): KnowledgeOutlinePage[] {
  return pages.map((page) => {
    const inherited = previousRoot.length
      ? previousRoot.every((part, index) => page.topicPath[index] === part)
      : page.topicPath.length === 0;
    return inherited
      ? {
          ...page,
          topicPath: [
            ...nextRoot,
            ...page.topicPath.slice(previousRoot.length),
          ],
        }
      : page;
  });
}

/** Keep the target page's identity so merging does not replace a published page. */
export function mergeOutlinePages(
  pages: KnowledgeOutlinePage[],
  sourceId: string,
  targetId: string,
): KnowledgeOutlinePage[] {
  const source = pages.find((page) => page.id === sourceId);
  const target = pages.find((page) => page.id === targetId);
  if (!source || !target || source.id === target.id) return pages;
  const combine = (left?: string[], right?: string[]) => [
    ...new Set([...(left ?? []), ...(right ?? [])]),
  ];
  const contexts = combine(target.contextIds, source.contextIds);
  const merged: KnowledgeOutlinePage = {
    ...target,
    goal: outlineLines(target.goal + "\n" + source.goal).join("\n"),
    scenario: outlineLines(target.scenario + "\n" + source.scenario).join("\n"),
    questions: combine(target.questions, source.questions),
    entryPaths: combine(target.entryPaths, source.entryPaths),
    materialKeys: combine(target.materialKeys, source.materialKeys),
    contextIds: contexts,
  };
  return pages
    .filter((page) => page.id !== sourceId)
    .map((page) => (page.id === targetId ? merged : page));
}
