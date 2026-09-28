import { describe, it, expect } from "vitest";
import { resolveEdgeTarget, edgeDrillTarget, matchModuleUnderstanding } from "./modules";
import type { CodeFile, CodeSymbol, CodeEdge, CodeUnderstandingListItem } from "../review-api";

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

describe("edgeDrillTarget", () => {
  const a = f("fA", "apps/server/src/assistant/a.ts");
  const b = f("fB", "apps/server/src/memory/b.ts");
  const files = new Map([[a.fileId, a], [b.fileId, b]]);
  const symA = s("sA", "fA", 715);
  const symB = s("sB", "fB", 12);
  const syms = new Map([[symA.symbolId, symA], [symB.symbolId, symB]]);

  it("opens a symbol/range frame for a same-file symbol edge, not none", () => {
    const e: CodeEdge = { edgeId: "x1", snapshotId: "sn", edgeKind: "calls", fromSymbolId: "sA", fromFileId: "fA", toSymbolId: "sA", toFileId: null, status: "confirmed", origin: "name", evidence: "self" };
    const t = edgeDrillTarget(e, files, syms, "fA");
    expect(t.kind).toBe("symbol");
    if (t.kind === "symbol") {
      expect(t.fileId).toBe("fA");
      expect(t.symbolId).toBe("sA");
      expect(t.line).toBe(715);
    }
  });

  it("opens a file frame for a cross-file symbol edge", () => {
    const e: CodeEdge = { edgeId: "x2", snapshotId: "sn", edgeKind: "calls", fromSymbolId: "sA", fromFileId: "fA", toSymbolId: "sB", toFileId: null, status: "confirmed", origin: "name", evidence: "mem" };
    const t = edgeDrillTarget(e, files, syms, "fA");
    expect(t.kind).toBe("file");
    if (t.kind === "file") expect(t.fileId).toBe("fB");
  });

  it("returns none for external packages", () => {
    const e: CodeEdge = { edgeId: "x3", snapshotId: "sn", edgeKind: "imports", fromSymbolId: null, fromFileId: "fA", toSymbolId: null, toFileId: null, status: "missing", origin: "es", evidence: "react" };
    expect(edgeDrillTarget(e, files, syms, "fA").kind).toBe("none");
  });
});

describe("matchModuleUnderstanding", () => {
  const mem = f("fM", "apps/server/src/memory/service.ts");
  const mod = { files: [mem] };
  const item = (targetId: string, stale = false): CodeUnderstandingListItem => ({
    understandingId: "cu", targetType: "module", targetId, snapshotId: "sn",
    role: "module-architect", status: "seed", confidence: 0.1, seed: true,
    verifiedByAgent: false, verifiedBy: null, stale, source: "curated-seed",
    curatedBy: "x", curatedAt: "2026", generatedAt: "2026", supersedesId: null,
  });

  it("matches the curated module by directory prefix", () => {
    const pick = matchModuleUnderstanding(mod, [item("apps/server/src/memory")]);
    expect(pick?.targetId).toBe("apps/server/src/memory");
  });

  it("prefers the longest (most specific) prefix", () => {
    const pick = matchModuleUnderstanding(mod, [
      item("apps/server/src"),
      item("apps/server/src/memory"),
    ]);
    expect(pick?.targetId).toBe("apps/server/src/memory");
  });

  it("ignores stale / non-curated rows", () => {
    const pick = matchModuleUnderstanding(mod, [item("apps/server/src/memory", true)]);
    expect(pick).toBeNull();
  });
});
