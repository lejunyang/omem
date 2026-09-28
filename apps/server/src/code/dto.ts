/** User-facing DTO projection. The code_* tables are a rebuildable typed view over
 * the authoritative Capture->Source/Revision/Fragment chain. We SPREAD the original
 * row so every internal action key (fileId/name/kind/range/endpoints/...) stays for
 * the UI, and ADD human display* fields on top. IDs are never rendered as labels;
 * missing/stale nodes are actionable=false with a reason. */
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
    ...s,
    type: "snapshot",
    displayTitle: `@${shortCommit(s.commit, s.dirty)}`,
    displayPath: null,
    symbolName: null,
    summary: `${s.parserVersion} · ${s.fileCount} files`,
    shortCommit: shortCommit(s.commit, s.dirty),
    citationLabel: `code@${shortCommit(s.commit, s.dirty)}`,
    actionable: true,
    reason: null,
    deepLink: `/api/review/code/current-snapshot`,
    trailLink: `#/code/snapshot/${s.snapshotId}`,
  };
}

export function fileDTO(f: CodeFile, snap?: CodeSnapshot | null) {
  const base = f.path.split("/").pop() ?? f.path;
  return {
    ...f,
    type: "file",
    symbolName: null,
    displayTitle: base,
    displayPath: f.path,
    summary: `${f.language} · ${f.sizeBytes} bytes`,
    version: snap ? shortCommit(snap.commit, snap.dirty) : null,
    shortCommit: snap ? shortCommit(snap.commit, snap.dirty) : null,
    citationLabel: f.path,
    actionable: !f.removed,
    reason: f.removed ? "file removed from repository" : null,
    deepLink: `/api/review/code/files/${f.fileId}`,
    trailLink: `#/code/file/${f.fileId}`,
  };
}

export function symbolDTO(sym: CodeSymbol, file?: CodeFile | null) {
  const label =
    sym.kind === "route" || sym.kind === "test" ? sym.name : sym.qualifiedName;
  const range = sym.rangeStart
    ? `:${sym.rangeStart.line}${sym.rangeStart.col ? ":" + sym.rangeStart.col : ""}`
    : "";
  return {
    ...sym,
    type: `symbol:${sym.kind}`,
    symbolName: sym.name,
    displayTitle: label,
    displayPath: file?.path ?? null,
    summary: sym.signature ?? sym.qualifiedName,
    shortCommit: null,
    citationLabel: `${file?.path ?? "?"}${range}`,
    actionable: true,
    reason: null,
    deepLink: file
      ? `/api/review/code/files/${file.fileId}/source?startLine=${sym.rangeStart?.line ?? 1}&endLine=${sym.rangeEnd?.line ?? sym.rangeStart?.line ?? 1}`
      : `/api/review/code/symbols/${sym.symbolId}`,
    trailLink: `#/code/symbol/${sym.symbolId}`,
  };
}

const EDGE_LABEL: Record<string, string> = {
  defines: "defines",
  imports: "imports",
  exports: "exports",
  module_of: "in module",
  calls: "calls",
  route: "exposes route",
  test_of: "tests",
  vue_component: "is component",
  uses_component: "uses component",
};

export function edgeReason(status: string): string | null {
  switch (status) {
    case "missing": return "unresolved target (bare/outside repo)";
    case "stale": return "superseded by a newer snapshot";
    default: return null;
  }
}

export function edgeDTO(
  e: CodeEdge,
  endpoints: { fromLabel?: string | null; toLabel?: string | null },
) {
  const action = e.status === "confirmed" || e.status === "candidate";
  const kind = e.edgeKind;
  return {
    ...e,
    type: `edge:${kind}`,
    displayTitle: `${endpoints.fromLabel ?? "?"} ${EDGE_LABEL[kind] ?? kind} ${endpoints.toLabel ?? "?"}`,
    displayPath: null,
    summary: e.evidence ?? kind,
    actionable: action,
    reason: edgeReason(e.status),
    deepLink: e.fromFileId ? `/api/review/code/files/${e.fromFileId}` : "/api/review/code/graph",
    trailLink: `#/code/edge/${e.edgeId}`,
  };
}