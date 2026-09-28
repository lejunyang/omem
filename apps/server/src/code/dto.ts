/** User-facing DTO projection. The code_* tables are a rebuildable typed view over
 * the authoritative Capture → Source/Revision/Fragment chain (review store). These
 * mappers turn raw rows into labels humans can read: no ID is ever shown as a
 * label; missing/stale nodes are flagged actionable=false with a reason; every
 * deepLink resolves to an existing /api/review route. */
import type {
  CodeEdge,
  CodeFile,
  CodeSnapshot,
  CodeSymbol,
} from "../../../../packages/contracts/src/index.js";

export function shortCommit(commit: string | null, dirty = false): string {
  if (commit) return commit.slice(0, 7);
  return dirty ? "dirty" : "no-commit";
}

export function snapshotMeta(s: CodeSnapshot) {
  return {
    snapshotId: s.snapshotId,
    type: "snapshot",
    displayTitle: `@${shortCommit(s.commit, s.dirty)}`,
    shortCommit: shortCommit(s.commit, s.dirty),
    version: s.commit ?? "dirty",
    dirty: s.dirty,
    capturedAt: s.capturedAt,
    citationLabel: `code@${shortCommit(s.commit, s.dirty)}`,
    actionable: true,
    reason: null,
    deepLink: `/api/review/code/current-snapshot`,
  };
}

export function fileDTO(f: CodeFile, snap?: CodeSnapshot | null) {
  const base = f.path.split("/").pop() ?? f.path;
  const actionable = !f.removed;
  return {
    fileId: f.fileId,
    path: f.path,
    type: "file",
    symbolName: null,
    displayTitle: base,
    displayPath: f.path,
    summary: `${f.language} · ${f.sizeBytes} bytes`,
    version: snap ? shortCommit(snap.commit, snap.dirty) : null,
    shortCommit: snap ? shortCommit(snap.commit, snap.dirty) : null,
    citationLabel: f.path,
    actionable,
    reason: f.removed ? "file removed from repository" : null,
    deepLink: `/api/review/code/files/${f.fileId}`,
  };
}

export function symbolDTO(sym: CodeSymbol, file?: CodeFile | null) {
  const label = sym.kind === "route" || sym.kind === "test"
    ? sym.name
    : sym.qualifiedName;
  const range = sym.rangeStart
    ? `:${sym.rangeStart.line}${sym.rangeStart.col ? ":" + sym.rangeStart.col : ""}`
    : "";
  return {
    symbolId: sym.symbolId,
    type: `symbol:${sym.kind}`,
    symbolName: sym.name,
    displayTitle: label,
    displayPath: file?.path ?? null,
    summary: sym.signature ?? sym.qualifiedName,
    version: null,
    shortCommit: null,
    citationLabel: `${file?.path ?? "?"}${range}`,
    actionable: true,
    reason: null,
    deepLink: file
      ? `/api/review/code/files/${file.fileId}/source?startLine=${sym.rangeStart?.line ?? 1}&endLine=${sym.rangeEnd?.line ?? sym.rangeStart?.line ?? 1}`
      : `/api/review/code/symbols/${sym.symbolId}`,
  };
}

const EDGE_LABEL: Record<string, string> = {
  defines: "defines",
  imports: "imports",
  calls: "calls",
  route: "exposes route",
  test_of: "tests",
  uses_component: "uses component",
};

export function edgeReason(status: string): string | null {
  switch (status) {
    case "missing": return "unresolved target (bare/outside repo)";
    case "stale": return "superseded by a newer snapshot";
    default: return null;
  }
}

export function edgeDTO(e: CodeEdge, endpoints: { fromLabel?: string | null; toLabel?: string | null }) {
  const action = e.status === "confirmed" || e.status === "candidate";
  return {
    edgeId: e.edgeId,
    type: `edge:${e.edgeKind}`,
    displayTitle: `${endpoints.fromLabel ?? "?"} ${EDGE_LABEL[e.edgeKind] ?? e.edgeKind} ${endpoints.toLabel ?? "?"}`,
    displayPath: null,
    summary: e.evidence ?? e.edgeKind,
    status: e.status,
    actionable: action,
    reason: edgeReason(e.status),
    deepLink: e.fromFileId ? `/api/review/code/files/${e.fromFileId}` : "/api/review/code/graph",
  };
}
