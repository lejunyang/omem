import type { Store } from "../store.js";
import { materialFromRevision } from "../knowledge/repository.js";
import { containingSection, fragmentPositions } from "../knowledge/structure.js";

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
