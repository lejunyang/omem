import type { KnowledgeDocument, KnowledgeMaterial, KnowledgeReview } from "../../../../packages/contracts/src/knowledge.js";
import { bindKnowledgeQuotes } from "./repository.js";

type RangeRepair = NonNullable<KnowledgeReview["verdicts"][number]["rangeRepair"]>;

/** The host may change only exact ranges requested by an independent reviewer.
 * A new claim, citation source or relationship still needs normal writing. */
export function repairCitationRanges(document: KnowledgeDocument, repair: RangeRepair, materials: Map<string, KnowledgeMaterial>): KnowledgeDocument | null {
  const corrected = structuredClone(document);
  let changed = false;
  const seen = new Set<string>();
  for (const range of repair.citations) {
    const citation = corrected.citations.find(c => c.key === range.key);
    const material = citation?.target.kind === "material" ? materials.get(citation.target.key) : undefined;
    if (seen.has(range.key) || !citation || !material || !Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) ||
      range.startLine < 1 || range.endLine < range.startLine || range.endLine > material.lineCount || !material.text.trim()) return null;
    seen.add(range.key);
    changed ||= citation.target.startLine !== range.startLine || citation.target.endLine !== range.endLine;
    citation.target.startLine = range.startLine;
    citation.target.endLine = range.endLine;
  }
  if (!changed || !seen.size) return null;
  return bindKnowledgeQuotes(corrected, materials);
}

/** Send the unchanged argument around repaired citations, rather than the whole
 * page. All fixed originals remain available through the same research tools. */
export function citationReviewExcerpt(document: KnowledgeDocument, citationKeys: string[]): KnowledgeDocument {
  const sections = document.sections.filter(s => citationKeys.some(key => s.body.includes(`[[${key}]]`)));
  const keys = new Set(sections.flatMap(s => [...s.body.matchAll(/\[\[([a-zA-Z][a-zA-Z0-9_-]*)\]\]/g)].map(m => m[1]!)));
  return { ...document, sections, citations: document.citations.filter(c => keys.has(c.key)) };
}
