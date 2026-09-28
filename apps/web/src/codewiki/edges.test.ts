import { describe, it, expect } from "vitest";
import { resolveEdgeTarget } from "./modules";
import type { CodeFile, CodeSymbol, CodeEdge } from "../review-api";

function f(id: string, path: string): CodeFile {
  return { fileId: id, repoId: "r", path, language: "ts", sizeBytes: 1, contentHash: null, headSnapshotId: "sn", removed: false };
}
function s(id: string, fileId: string, line: number): CodeSymbol {
  return { symbolId: id, fileId, snapshotId: "sn", name: id, qualifiedName: id, kind: "function", rangeStart: { line, col: 1 }, rangeEnd: { line: line + 3, col: 1 }, fragmentId: "fr", exported: false, signature: null };
}

describe("resolveEdgeTarget", () => {
  const a = f("fA", "apps/server/src/assistant/a.ts");
  const b = f("fB", "apps/server/src/memory/b.ts");
  const files = new Map([[a.fileId, a], [b.fileId, b]]);
  const syms = new Map([[s("sB", "fB", 12).symbolId, s("sB", "fB", 12)]]);

  it("resolves an import edge to a target file", () => {
    const e: CodeEdge = { edgeId: "e1", snapshotId: "sn", edgeKind: "imports", fromSymbolId: null, fromFileId: "fA", toSymbolId: null, toFileId: "fB", status: "confirmed", origin: "es", evidence: "./memory" };
    const t = resolveEdgeTarget(e, files, syms, "fA");
    expect(t.resolvable).toBe(true);
    expect(t.fileId).toBe("fB");
  });

  it("resolves a call edge to a symbol line", () => {
    const e: CodeEdge = { edgeId: "e2", snapshotId: "sn", edgeKind: "calls", fromSymbolId: null, fromFileId: "fA", toSymbolId: "sB", toFileId: null, status: "candidate", origin: "name", evidence: "memory" };
    const t = resolveEdgeTarget(e, files, syms, "fA");
    expect(t.resolvable).toBe(true);
    expect(t.fileId).toBe("fB");
    expect(t.line).toBe(12);
    expect(t.symbolName).toBe("sB");
  });

  it("marks external / missing edges non-interactive", () => {
    const e: CodeEdge = { edgeId: "e3", snapshotId: "sn", edgeKind: "imports", fromSymbolId: null, fromFileId: "fA", toSymbolId: null, toFileId: null, status: "missing", origin: "es", evidence: "react" };
    expect(resolveEdgeTarget(e, files, syms, "fA").resolvable).toBe(false);
  });

  it("does not drill into the same file", () => {
    const e: CodeEdge = { edgeId: "e4", snapshotId: "sn", edgeKind: "imports", fromSymbolId: null, fromFileId: "fA", toSymbolId: null, toFileId: "fA", status: "confirmed", origin: "es", evidence: "." };
    expect(resolveEdgeTarget(e, files, syms, "fA").resolvable).toBe(false);
  });
});
