import type { DatabaseSync } from "node:sqlite";
import type { RetrievalUnit } from "./units.js";

/** A separate vector identity keeps concept text out of the body-vector cache. */
export const CONCEPT_VECTOR_VERSION = "range-concepts-v1";

export function conceptWindows(unit: RetrievalUnit) {
  if (unit.target.kind !== "source") return [];
  const target = unit.target;
  const lines = unit.text.split("\n");
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  return (unit.materialDescription?.description.concepts ?? [])
    .filter(
      (c) => c.startLine <= target.endLine && c.endLine >= target.startLine,
    )
    .map((c) => {
      const first = Math.max(0, c.startLine - target.startLine);
      const last = Math.min(lines.length, c.endLine - target.startLine + 1);
      return {
        key: JSON.stringify([
          target.key,
          target.revisionId,
          c.label,
          c.aliases,
          c.startLine,
          c.endLine,
        ]),
        text: [c.label, ...c.aliases].join("；"),
        start: offsets[first] ?? unit.text.length,
        end: Math.min(
          unit.text.length,
          (offsets[last] ?? unit.text.length) - 1,
        ),
      };
    })
    .filter((card) => card.end > card.start);
}

/** The caller supplies only eligible units. Concept vectors stay bound to those
 * units; repeated projections of one concept spend one recall slot. */
export function conceptCandidates(
  db: DatabaseSync,
  modelId: string,
  units: ReadonlyMap<string, RetrievalUnit>,
  query: number[],
) {
  type Candidate = {
    unit: RetrievalUnit;
    score: number;
    routes: string[];
    excerpt: string;
  };
  const cards = new Map<string, { hit: Candidate; span: number }>();
  const windowsByUnit = new Map<string, ReturnType<typeof conceptWindows>>();
  for (const row of db
    .prepare(
      "SELECT unit_id,part,vector FROM retrieval_unit_vectors WHERE model_id=?",
    )
    .iterate(modelId)) {
    const unit = units.get(String(row.unit_id));
    if (!unit) continue;
    let windows = windowsByUnit.get(unit.id);
    if (!windows) {
      windows = conceptWindows(unit);
      windowsByUnit.set(unit.id, windows);
    }
    const card = windows[Number(row.part)];
    if (!card) continue;
    const bytes = row.vector as Uint8Array;
    const stored = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    if (stored.length !== query.length)
      throw Error("Concept embedding dimensions changed without new identity");
    const score = query.reduce((n, v, i) => n + v * stored[i]!, 0);
    const previous = cards.get(card.key);
    const span = card.end - card.start;
    if (
      previous &&
      (previous.hit.score > score ||
        (previous.hit.score === score && previous.span >= span))
    )
      continue;
    cards.set(card.key, {
      span,
      hit: {
        unit,
        score,
        routes: ["semantic-concept"],
        excerpt: unit.text.slice(card.start, card.end),
      },
    });
  }
  const hits = new Map<string, Candidate>();
  for (const { hit } of cards.values())
    if (hit.score > (hits.get(hit.unit.id)?.score ?? -Infinity))
      hits.set(hit.unit.id, hit);
  return [...hits.values()];
}
