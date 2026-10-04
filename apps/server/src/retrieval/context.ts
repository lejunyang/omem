import type { Store } from "../store.js";
import { materialFromRevision } from "../knowledge/repository.js";
import {
  containingSection,
  fragmentPositions,
} from "../knowledge/structure.js";
import { sourceAnchor } from "./units.js";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import type { SourceAnchor } from "./port.js";
import type { DatabaseSync } from "node:sqlite";
import { contextHierarchy, enclosingContext } from "./hierarchy.js";

/** Recall locates a passage; answering needs its enclosing chapter/operation.
 * Expand only within the same immutable original, never to the current head.
 * Unstructured documents keep their hit range instead of attaching a whole file.
 */
export function sourceContextRange(
  material: KnowledgeMaterial,
  hit: SourceAnchor,
  visible: (id: string) => boolean,
  projection?: { db: DatabaseSync; unitId: string },
): SourceAnchor {
  const hierarchy = contextHierarchy(material, projection?.db);
  const member =
    projection &&
    hierarchy.nodes.find((n) => n.id === hierarchy.members[projection.unitId]);
  const section =
    member &&
    member.kind !== "document" &&
    member.startLine <= hit.startLine &&
    member.endLine >= hit.endLine
      ? member
      : enclosingContext(hierarchy.nodes, hit.startLine, hit.endLine);
  if (!section) return hit;
  // A document's single outer H1 is its title, not an instruction to read every
  // chapter. A hit in its introduction keeps that introduction. Ordinary
  // chapters still include their subsections (e.g. a budget's refund rules).
  const siblings = hierarchy.nodes.filter(
    (n) => n.parentId === section.parentId,
  );
  const firstChild = Math.min(
    ...hierarchy.nodes
      .filter((n) => n.parentId === section.id)
      .map((n) => n.startLine),
  );
  const isDocumentTitle =
    section.kind === "section" &&
    section.depth === 1 &&
    hierarchy.nodes.find((n) => n.id === section.parentId)?.kind ===
      "document" &&
    siblings.length === 1;
  const endLine =
    isDocumentTitle && hit.endLine < firstChild
      ? Math.min(section.endLine, firstChild - 1)
      : section.endLine;
  const parent = sourceAnchor(material, section.startLine, endLine);
  // The parent's heading and siblings are also content. A visible child does
  // not grant access to them; keep the original match if expansion is hidden.
  return parent.fragmentIds.length && parent.fragmentIds.every(visible)
    ? { ...parent, key: hit.key }
    : hit;
}

/** Keep a chapter's inherited introduction alongside the focused passage.
 * These are separate fixed citations, not a synthetic concatenated original.
 * Sibling chapters stay available through Agent navigation rather than being
 * appended wholesale. This supplies explicit scope, not inferred prerequisites.
 */
export function sourceContextRanges(
  material: KnowledgeMaterial,
  hit: SourceAnchor,
  visible: (id: string) => boolean,
  projection?: { db: DatabaseSync; unitId: string },
): SourceAnchor[] {
  const focus = sourceContextRange(material, hit, visible, projection);
  const { nodes } = contextHierarchy(material, projection?.db);
  const enclosing = enclosingContext(nodes, focus.startLine, focus.endLine);
  const parents: SourceAnchor[] = [];
  let parentId = enclosing?.parentId;
  while (parentId) {
    const parent = nodes.find((n) => n.id === parentId);
    if (!parent) break;
    parentId = parent.parentId;
    if (parent.kind !== "section") continue;
    const firstChild = Math.min(
      ...nodes.filter((n) => n.parentId === parent.id).map((n) => n.startLine),
    );
    const endLine = firstChild - 1;
    if (endLine <= parent.startLine) continue;
    const text = material.text
      .split("\n")
      .slice(parent.startLine - 1, endLine)
      .join("\n");
    if (
      !text
        .split("\n")
        .some((line) => line.trim() && !/^\s*#{1,6}\s/.test(line))
    )
      continue;
    const anchor = sourceAnchor(material, parent.startLine, endLine);
    if (anchor.fragmentIds.length && anchor.fragmentIds.every(visible))
      parents.unshift({ ...anchor, key: hit.key });
  }
  return [...parents, focus];
}

/** Complement a hit with its heading / nearby original fragments, not a new fact. */
export function evidenceNeighbors(
  store: Store,
  fragmentId: string,
  visible: (id: string) => boolean,
) {
  const evidence = store.evidence(fragmentId);
  if (!evidence) return [];
  const material = materialFromRevision(store, evidence.revision.id);
  if (!material) return [];
  const positions = fragmentPositions(material),
    hit = positions.find((p) => p.id === fragmentId);
  if (!hit) return [];
  const section = containingSection(material, hit.startLine);
  if (!section) return [];
  const index = positions.indexOf(hit);
  const heading = positions.find(
    (p) => p.startLine <= section.startLine && p.endLine >= section.startLine,
  );
  const neighbors = [heading, positions[index - 1], positions[index + 1]];
  return [
    ...new Set(
      neighbors
        .filter(
          (p) =>
            p &&
            p.id !== fragmentId &&
            p.endLine >= section.startLine &&
            p.startLine <= section.endLine,
        )
        .map((p) => p!.id),
    ),
  ].filter(visible);
}

export function evidenceSection(
  store: Store,
  fragmentId: string,
  visible: (id: string) => boolean = () => true,
) {
  const evidence = store.evidence(fragmentId);
  if (!evidence) return null;
  const material = materialFromRevision(store, evidence.revision.id);
  // Section labels are also content; don't expose one from a hidden fragment.
  if (!material || material.fragments.some((f) => !visible(f.id))) return null;
  const hit = fragmentPositions(material).find((p) => p.id === fragmentId);
  const section = hit && containingSection(material, hit.startLine);
  return section
    ? {
        title: section.title,
        startLine: section.startLine,
        endLine: section.endLine,
      }
    : null;
}
