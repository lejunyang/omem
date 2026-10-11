import type { DatabaseSync } from "node:sqlite";
import type { RetrievalHit, SearchQuery } from "./port.js";
import { materialFromRow, sourceAnchor } from "./units.js";
import { contextHierarchy } from "./hierarchy.js";
import { fragmentPositions } from "../knowledge/structure.js";

/** Supplement the same fixed source, never a current head or a ranked neighbour.
 * The smallest enclosing structure is reading context, not a new search vote. */
export function readParentContext(
  db: DatabaseSync,
  hit: RetrievalHit,
  q: SearchQuery,
): RetrievalHit | undefined {
  if (hit.target.kind !== "source") return;
  const target = hit.target;
  const row = db
    .prepare(
      "SELECT r.*,s.namespace,s.external_id FROM revisions r JOIN sources s ON s.id=r.source_id WHERE r.id=?",
    )
    .get(target.revisionId);
  if (!row) return;
  const material = materialFromRow(db, row);
  if (
    !material ||
    material.key !== target.key ||
    material.digest !== target.digest
  )
    return;
  const node = contextHierarchy(material, db)
    .nodes.filter(
      (n) =>
        n.kind !== "document" &&
        n.startLine <= target.startLine &&
        n.endLine >= target.endLine &&
        (n.startLine < target.startLine || n.endLine > target.endLine),
    )
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
  if (!node) return;
  const fragments = fragmentPositions(material).filter(
    (f) => f.startLine <= node.endLine && f.endLine >= node.startLine,
  );
  if (
    q.visible &&
    (!fragments.length || !fragments.every((f) => q.visible!(f.id)))
  )
    return;
  const anchor = sourceAnchor(material, node.startLine, node.endLine);
  const lines = material.text.split("\n");
  return {
    ...hit,
    text: lines.slice(node.startLine - 1, node.endLine).join("\n"),
    target: anchor,
    references: [anchor],
    headingPath: hit.headingPath.at(-1) === node.title ? hit.headingPath : [...hit.headingPath, node.title],
  };
}
