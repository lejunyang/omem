/** Reading context is a separate projection: parents are not extra ranked hits. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { KnowledgeMaterial } from "../../../../packages/contracts/src/knowledge.js";
import {
  materialSections,
  type MaterialSection,
} from "../knowledge/structure.js";

export const CONTEXT_VERSION = "section-tree-v1";
export type ContextNode = MaterialSection & {
  id: string;
  parentId: string | null;
  children: string[];
};
export type ContextHierarchy = {
  nodes: ContextNode[];
  members: Record<string, string>;
};
type Member = { id: string; startLine: number; endLine: number };
const contains = (node: MaterialSection, start: number, end: number) =>
  node.startLine <= start && node.endLine >= end;

export function enclosingContext(
  nodes: ContextNode[],
  start: number,
  end = start,
) {
  return nodes
    .filter((n) => n.kind !== "document" && contains(n, start, end))
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
}

export function buildContextHierarchy(
  material: KnowledgeMaterial,
  members: Member[] = [],
): ContextHierarchy {
  const sections: MaterialSection[] = [
    {
      title: material.title,
      startLine: 1,
      endLine: material.lineCount,
      kind: "document",
    },
    ...materialSections(material).filter((s) => s.kind !== "document"),
  ];
  const nodes: ContextNode[] = [
    ...new Map(
      sections.map((s) => {
        const id = createHash("sha256")
          .update(
            JSON.stringify([
              CONTEXT_VERSION,
              material.revisionId,
              s.kind,
              s.title,
              s.startLine,
              s.endLine,
            ]),
          )
          .digest("hex");
        return [id, { ...s, id, parentId: null, children: [] } as ContextNode];
      }),
    ).values(),
  ];
  const root = nodes[0]!;
  for (const node of nodes.slice(1)) {
    // Equal line ranges do not prove nesting (e.g. two declarations on one line).
    const parent =
      nodes
        .filter(
          (n) =>
            n !== node &&
            n.kind !== "document" &&
            contains(n, node.startLine, node.endLine) &&
            (n.startLine < node.startLine || n.endLine > node.endLine),
        )
        .sort(
          (a, b) => a.endLine - a.startLine - (b.endLine - b.startLine),
        )[0] ?? root;
    node.parentId = parent.id;
    parent.children.push(node.id);
  }
  return {
    nodes,
    members: Object.fromEntries(
      members.map((m) => [
        m.id,
        (enclosingContext(nodes, m.startLine, m.endLine) ?? root).id,
      ]),
    ),
  };
}

export function saveContextHierarchy(
  db: DatabaseSync,
  material: KnowledgeMaterial,
  members: Member[],
) {
  const hierarchy = buildContextHierarchy(material, members);
  db.prepare(
    "INSERT OR REPLACE INTO retrieval_contexts(owner,revision_id,version,nodes_json,members_json) VALUES(?,?,?,?,?)",
  ).run(
    "source:" + material.sourceId,
    material.revisionId,
    CONTEXT_VERSION,
    JSON.stringify(hierarchy.nodes),
    JSON.stringify(hierarchy.members),
  );
}

/** Old fixed revisions use their own structure, never the source's current head. */
export function contextHierarchy(
  material: KnowledgeMaterial,
  db?: DatabaseSync,
): ContextHierarchy {
  if (db) {
    const row = db
      .prepare(
        "SELECT nodes_json,members_json FROM retrieval_contexts WHERE owner=? AND revision_id=? AND version=?",
      )
      .get("source:" + material.sourceId, material.revisionId, CONTEXT_VERSION);
    if (row)
      return {
        nodes: JSON.parse(String(row.nodes_json)),
        members: JSON.parse(String(row.members_json)),
      };
  }
  return buildContextHierarchy(material);
}
