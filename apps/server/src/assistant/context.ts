import type { KnowledgeArtifact } from "../../../../packages/contracts/src/knowledge.js";
import type { Store } from "../store.js";
import { materialFromRevision } from "../knowledge/repository.js";
import { sourceContextRanges } from "../retrieval/context.js";
import { decodeUnit } from "../retrieval/units.js";
import type { RetrievalHit } from "../retrieval/port.js";
import { evidenceForRange } from "./research.js";
import type { AssistantBackground, AssistantEvidence } from "./runtime.js";

/** Search ranks paragraphs; answering reads the admitted chapter they belong to.
 * Only the same fixed revision and section may expand, using the projection's
 * existing eligibility and visibility rules. Other chapters are not appended.
 */
function knowledgeContext(
  store: Store,
  hit: RetrievalHit,
  visible: (id: string) => boolean,
): RetrievalHit | null {
  const target = hit.target;
  if (target.kind !== "knowledge") return null;
  const units = store.db
    .prepare(
      "SELECT * FROM retrieval_units WHERE owner=? AND json_extract(target,'$.revision')=? AND json_extract(target,'$.section')=?",
    )
    .all("knowledge:" + target.key, target.revision, target.section)
    .map(decodeUnit);
  if (
    !units.length ||
    units.some(
      (u) =>
        !u.visibilityIds.length ||
        !u.visibilityIds.every(visible) ||
        u.references.some((r) => !r.fragmentIds.every(visible)),
    )
  )
    return null;
  const row = store.db
    .prepare(
      "SELECT r.artifact FROM knowledge_revisions r JOIN knowledge_heads h ON h.revision_id=r.id WHERE r.document_key=? AND r.id=?",
    )
    .get(target.key, target.revision);
  if (!row) return null;
  const article = JSON.parse(String(row.artifact)) as KnowledgeArtifact;
  const section = article.document.sections.find(
    (s) => s.key === target.section,
  );
  if (!section) return null;
  return {
    ...hit,
    text: section.body,
    headingPath: [section.title],
    references: [
      ...new Map(
        units.flatMap((u) => u.references).map((r) => [JSON.stringify(r), r]),
      ).values(),
    ],
    citations: article.document.citations
      .filter((c) => section.body.includes(`[[${c.key}]]`))
      .map((c) => ({ ...c, actionable: true })),
  };
}

export function mergeBackground(entries: AssistantBackground[]) {
  return [
    ...new Map(
      entries.map((b) => [
        JSON.stringify([b.target, b.kind, b.title, b.text]),
        b,
      ]),
    ).values(),
  ];
}

/** Limit distinct reading contexts, not the number of references needed to
 * understand them. Keep every selected chapter's original citations together.
 */
export function assembleAnswerContext(
  store: Store,
  hits: RetrievalHit[],
  visible: (id: string) => boolean,
  maxContexts = 16,
) {
  const evidence = new Map<string, AssistantEvidence>();
  const background: AssistantBackground[] = [];
  const selected = new Set<string>();
  const chapters = new Map<string, RetrievalHit | null>();
  for (const candidate of hits) {
    const targetId = JSON.stringify(candidate.target);
    if (candidate.kind !== "source" && selected.has(targetId)) continue;
    let hit = candidate;
    if (candidate.kind === "knowledge") {
      if (!chapters.has(targetId))
        chapters.set(targetId, knowledgeContext(store, candidate, visible));
      hit = chapters.get(targetId) ?? candidate;
    }
    const contexts = hit.references.flatMap((reference) => {
      const material = materialFromRevision(store, reference.revisionId);
      if (
        !material ||
        !reference.fragmentIds.length ||
        !reference.fragmentIds.every(visible)
      )
        return [];
      const ranges =
        hit.kind === "source"
          ? sourceContextRanges(material, reference, visible, {
              db: store.db,
              unitId: hit.id,
            })
          : [reference];
      return ranges.map((range) => ({ material, range, key: reference.key }));
    });
    const identity =
      hit.kind === "source"
        ? JSON.stringify(
            contexts.map((c) => [
              c.range.revisionId,
              c.range.startLine,
              c.range.endLine,
            ]),
          )
        : hit.kind === "knowledge" && !chapters.get(targetId)
          ? hit.id
          : targetId;
    if ((hit.kind === "source" && !contexts.length) || selected.has(identity))
      continue;
    if (selected.size >= maxContexts) break;
    selected.add(identity);
    const citationIds: string[] = [];
    for (const { material, range, key } of contexts) {
      const entry = evidenceForRange(
        material,
        range.startLine,
        range.endLine,
        visible,
      );
      entry.sourceTarget = range;
      entry.materialKey = key;
      entry.materialDescription =
        store.descriptions.get(range.revisionId) ?? undefined;
      if (
        hit.kind === "source" &&
        !entry.sectionTitle &&
        hit.headingPath.length
      )
        entry.sectionTitle = hit.headingPath.join(" / ");
      if (!evidence.has(entry.citationId!))
        evidence.set(entry.citationId!, entry);
      citationIds.push(entry.citationId!);
    }
    if (hit.kind !== "source")
      background.push({
        kind: hit.kind,
        target: hit.target,
        title: hit.title,
        text: hit.text.replace(
          /\[\[([\w-]+)\]\]/g,
          (_ref, key: string) =>
            hit.citations?.find((c) => c.key === key)?.label ??
            "（引用见文章）",
        ),
        headingPath: hit.headingPath,
        materialDescription: hit.materialDescription,
        citationIds: [...new Set(citationIds)],
        ...(hit.target.kind === "knowledge" && hit.target.reviewState
          ? { reviewState: hit.target.reviewState }
          : {}),
      });
  }
  // Keep an original passage once when another admitted range already contains
  // it. Never join revisions or manufacture a wider range. Background links are
  // remapped to the retained fixed citation rather than left dangling.
  const entries = [...evidence.values()];
  const owners = new Map(
    entries.map((entry) => {
      let owner = entry;
      for (const candidate of entries) {
        const range = owner.sourceTarget;
        const parent = candidate.sourceTarget;
        if (
          range &&
          parent &&
          parent.revisionId === range.revisionId &&
          parent.startLine <= range.startLine &&
          parent.endLine >= range.endLine &&
          (parent.startLine < range.startLine || parent.endLine > range.endLine)
        )
          owner = candidate;
      }
      return [entry.citationId!, owner];
    }),
  );
  return {
    evidence: [...new Set(owners.values())],
    background: background.map((entry) => ({
      ...entry,
      citationIds: [
        ...new Set(
          entry.citationIds.map((id) => owners.get(id)?.citationId ?? id),
        ),
      ],
    })),
  };
}
