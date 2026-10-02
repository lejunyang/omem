import { marked } from "marked";
import { parseFile } from "../code/parse.js";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";

export type MaterialSection = { title: string; startLine: number; endLine: number; kind: "section" | "symbol" | "document" };
const cache = new WeakMap<KnowledgeMaterial, MaterialSection[]>();
type PositionedFragment = KnowledgeMaterial["fragments"][number] & { start: number; end: number; startLine: number; endLine: number };
const positionsCache = new WeakMap<KnowledgeMaterial, PositionedFragment[]>();

/** Reading structure is a projection; original fragments and their IDs never change. */
export function materialSections(material: KnowledgeMaterial): MaterialSection[] {
  const saved = cache.get(material); if (saved) return saved;
  const path = material.path ?? material.title;
  let sections: MaterialSection[] = [];
  if (/\.(?:[cm]?[jt]sx?|vue)$/.test(path)) {
    sections = parseFile(path, material.text).symbols.map(s => ({ title: s.qualifiedName, startLine: s.rangeStart.line, endLine: s.rangeEnd.line, kind: "symbol" }));
  } else if (/\.(?:md|markdown)$/i.test(path) || /^#{1,6}\s/m.test(material.text)) {
    // Use the same Markdown parser as the reader: fenced headings aren't sections.
    let cursor = 0;
    const headings: (MaterialSection & { depth: number })[] = [];
    for (const token of marked.lexer(material.text)) {
      const offset = material.text.indexOf(token.raw, cursor);
      if (offset < 0) continue;
      if (token.type === "heading") headings.push({ title: token.text, startLine: material.text.slice(0, offset).split("\n").length, endLine: material.lineCount, kind: "section", depth: token.depth });
      cursor = offset + token.raw.length;
    }
    sections = headings.map((heading, index) => ({ ...heading, endLine: (headings.slice(index + 1).find(next => next.depth <= heading.depth)?.startLine ?? material.lineCount + 1) - 1 }));
  }
  if (!sections.length) sections = [{ title: material.title, startLine: 1, endLine: material.lineCount, kind: "document" }];
  cache.set(material, sections); return sections;
}

export function fragmentPositions(material: KnowledgeMaterial) {
  const saved = positionsCache.get(material); if (saved) return saved;
  let cursor = 0;
  const positions = material.fragments.flatMap(fragment => {
    const start = material.text.indexOf(fragment.text, cursor);
    if (start < 0) return [];
    cursor = start + fragment.text.length;
    return [{ ...fragment, start, end: cursor, startLine: material.text.slice(0, start).split("\n").length, endLine: material.text.slice(0, cursor).split("\n").length }];
  });
  positionsCache.set(material, positions);
  return positions;
}

export function containingSection(material: KnowledgeMaterial, line: number) {
  return materialSections(material).filter(s => s.startLine <= line && s.endLine >= line).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}
