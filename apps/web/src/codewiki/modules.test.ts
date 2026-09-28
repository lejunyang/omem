import { describe, it, expect } from "vitest";
import { moduleForPath, aggregateGraph, matchModuleUnderstanding } from "./modules";
import type { CodeFile, CodeSymbol, CodeEdge } from "../review-api";
import type { CodeUnderstandingListItem } from "../review-api";

describe("moduleForPath", () => {
  it("buckets required modules", () => {
    expect(moduleForPath("apps/server/src/assistant/agent.ts")).toBe("assistant");
    expect(moduleForPath("apps/server/src/memory/store.ts")).toBe("memory");
    expect(moduleForPath("apps/server/src/retrieval/embedder.ts")).toBe("retrieval");
    expect(moduleForPath("apps/server/src/integrations/lark/client.ts")).toBe("lark");
    expect(moduleForPath("apps/web/src/ReviewApp.vue")).toBe("web");
  });
});

describe("aggregateGraph", () => {
  const files: CodeFile[] = [
    mkFile("f1", "apps/server/src/assistant/a.ts"),
    mkFile("f2", "apps/server/src/memory/m.ts"),
    mkFile("f3", "apps/server/src/web-would-be/app.ts"), // other
  ];
  const symbols: CodeSymbol[] = [
    mkSym("s1", "f1"),
    mkSym("s2", "f1"),
    mkSym("s3", "f2"),
  ];
  const edges: CodeEdge[] = [
    // assistant -> memory confirmed import
    { edgeId: "e1", snapshotId: "sn", edgeKind: "imports", fromSymbolId: null, fromFileId: "f1", toSymbolId: null, toFileId: "f2", status: "confirmed", origin: "es-module", evidence: "./memory" },
    // assistant -> external package (missing, dropped from module edges)
    { edgeId: "e2", snapshotId: "sn", edgeKind: "imports", fromSymbolId: null, fromFileId: "f1", toSymbolId: null, toFileId: null, status: "missing", origin: "es-module", evidence: "react" },
  ];

  it("builds module nodes with counts", () => {
    const { modules } = aggregateGraph(files, symbols, edges);
    const assistant = modules.find((m) => m.id === "assistant")!;
    expect(assistant.fileCount).toBe(1);
    expect(assistant.symbolCount).toBe(2);
    const memory = modules.find((m) => m.id === "memory")!;
    expect(memory.symbolCount).toBe(1);
  });

  it("aggregates only resolved in-repo imports between modules", () => {
    const { edges: e } = aggregateGraph(files, symbols, edges);
    expect(e).toHaveLength(1);
    expect(e[0].from).toBe("assistant");
    expect(e[0].to).toBe("memory");
    expect(e[0].count).toBe(1);
  });
});

function mkFile(id: string, path: string): CodeFile {
  return {
    fileId: id, repoId: "r", path, language: "typescript",
    sizeBytes: 1, contentHash: null, headSnapshotId: "sn", removed: false,
  };
}
function mkSym(id: string, fileId: string): CodeSymbol {
  return {
    symbolId: id, fileId, snapshotId: "sn", name: id, qualifiedName: id,
    kind: "function", rangeStart: { line: 1, col: 1 }, rangeEnd: { line: 5, col: 1 },
    fragmentId: "fr", exported: false, signature: null,
  };
}

describe("matchModuleUnderstanding", () => {
  const webMod = {
    files: [
      mkFile("w1", "apps/web/package.json"), // short path, should NOT shadow src
      mkFile("w2", "apps/web/src/codewiki/CodeWiki.vue"),
      mkFile("w3", "apps/web/src/main.ts"),
    ],
  };
  const curated = (targetId: string, id: string): CodeUnderstandingListItem => ({
    understandingId: id, targetType: "module", targetId, snapshotId: "sn",
    role: "architect", status: "seed", confidence: null, seed: true,
    verifiedByAgent: false, verifiedBy: null, stale: false, source: "curated-seed",
    curatedBy: "human", curatedAt: null, generatedAt: "", supersedesId: null,
  });

  it("picks the deepest curated prefix covering ANY file, not the shortest representative", () => {
    const items = [curated("apps/web", "u1"), curated("apps/web/src", "u2")];
    expect(matchModuleUnderstanding(webMod, items)?.understandingId).toBe("u2");
  });

  it("drops stale / non-curated rows", () => {
    const stale = { ...curated("apps/web/src", "u9"), stale: true };
    expect(matchModuleUnderstanding(webMod, [stale])).toBeNull();
  });
});
