import type { Store } from "../store.js";
import { materialFromRevision } from "../knowledge/repository.js";
import { containingSection, fragmentPositions, materialSections } from "../knowledge/structure.js";
import { sourceAnchor } from "./units.js";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import type { SourceAnchor } from "./port.js";

/** Recall locates a passage; answering needs its enclosing chapter/operation.
 * Expand only within the same immutable original, never to the current head.
 * Unstructured documents keep their hit range instead of attaching a whole file.
 */
export function sourceContextRange(
  material: KnowledgeMaterial,
  hit: SourceAnchor,
  visible: (id: string) => boolean,
): SourceAnchor {
  const section = materialSections(material)
    .filter(s => s.kind !== "document" && s.startLine <= hit.startLine && s.endLine >= hit.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (!section) return hit;
  const parent = sourceAnchor(material, section.startLine, section.endLine);
  // The parent's heading and siblings are also content. A visible child does
  // not grant access to them; keep the original match if expansion is hidden.
  return parent.fragmentIds.length && parent.fragmentIds.every(visible)
    ? { ...parent, key: hit.key }
    : hit;
}

/** Complement a hit with its heading / nearby original fragments, not a new fact. */
export function evidenceNeighbors(store: Store, fragmentId: string, visible: (id: string) => boolean) {
  const evidence = store.evidence(fragmentId);
  if (!evidence) return [];
  const material = materialFromRevision(store, evidence.revision.id);
  if (!material) return [];
  const positions = fragmentPositions(material), hit = positions.find(p => p.id === fragmentId);
  if (!hit) return [];
  const section = containingSection(material, hit.startLine);
  if (!section) return [];
  const index = positions.indexOf(hit);
  const heading = positions.find(p => p.startLine <= section.startLine && p.endLine >= section.startLine);
  const neighbors = [heading, positions[index - 1], positions[index + 1]];
  return [...new Set(neighbors.filter(p => p && p.id !== fragmentId && p.endLine >= section.startLine && p.startLine <= section.endLine).map(p => p!.id))].filter(visible);
}

export function evidenceSection(store: Store, fragmentId: string, visible: (id: string) => boolean = () => true) {
  const evidence = store.evidence(fragmentId);
  if (!evidence) return null;
  const material = materialFromRevision(store, evidence.revision.id);
  // Section labels are also content; don't expose one from a hidden fragment.
  if (!material || material.fragments.some(f => !visible(f.id))) return null;
  const hit = fragmentPositions(material).find(p => p.id === fragmentId);
  const section = hit && containingSection(material, hit.startLine);
  return section ? { title: section.title, startLine: section.startLine, endLine: section.endLine } : null;
}
