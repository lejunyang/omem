/** Pure helpers for grouping code files into architecture modules and
 * aggregating parser edges into a deterministic module dependency graph.
 * Kept free of Vue / DOM so it is unit-testable. */
import type { CodeEdge, CodeFile, CodeSymbol } from "../review-api";

/** Map a repo-relative path to a stable module bucket id. The required modules
 * (assistant / memory / retrieval / lark / web) all resolve here. */
export function moduleForPath(path: string): string {
  if (path.startsWith("apps/web/")) return "web";
  if (path.startsWith("packages/ui/")) return "ui";
  if (path.startsWith("packages/contracts/")) return "contracts";
  if (path.startsWith("packages/agent-runtime/")) return "agent-runtime";
  if (path.startsWith("apps/server/src/integrations/lark/")) return "lark";
  if (path.startsWith("apps/server/src/")) {
    const parts = path.split("/");
    if (parts.length <= 4) return "server-root";
    return parts[3];
  }
  if (path.startsWith("scripts/")) return "scripts";
  return "other";
}

export const MODULE_LABELS: Record<string, string> = {
  assistant: "assistant",
  memory: "memory",
  retrieval: "retrieval",
  lark: "Lark",
  web: "web",
  review: "review",
  code: "code",
  conversation: "conversation",
  inputs: "inputs",
  integrations: "integrations",
  jobs: "jobs",
  learning: "learning",
  quality: "quality",
  "source-profile": "source-profile",
  storage: "storage",
  "agent-runtime": "agent-runtime",
  ui: "ui",
  contracts: "contracts",
  scripts: "scripts",
  server: "server",
  other: "other",
};

export function moduleLabel(id: string): string {
  return MODULE_LABELS[id] ?? id;
}

export type AggModule = {
  id: string;
  fileCount: number;
  symbolCount: number;
  files: CodeFile[];
};

export type AggEdge = {
  id: string;
  from: string;
  to: string;
  count: number;
  status: CodeEdge["status"];
  evidence: string[];
};

/** Aggregate files+symbols+edges into module nodes and inter-module edges.
 * Only confirmed in-repo `imports` edges with a resolved toFileId count as
 * module dependencies; missing (external package) imports are dropped here and
 * shown per-file instead. */
export function aggregateGraph(
  files: CodeFile[],
  symbols: CodeSymbol[],
  edges: CodeEdge[],
): { modules: AggModule[]; edges: AggEdge[] } {
  const fileModule = new Map<string, string>();
  const modFiles = new Map<string, CodeFile[]>();
  const modSymCount = new Map<string, number>();
  for (const f of files) {
    if (f.removed) continue;
    const m = moduleForPath(f.path);
    fileModule.set(f.fileId, m);
    if (!modFiles.has(m)) modFiles.set(m, []);
    modFiles.get(m)!.push(f);
    modSymCount.set(m, modSymCount.get(m) ?? 0);
  }
  for (const s of symbols) {
    const m = fileModule.get(s.fileId);
    if (m) modSymCount.set(m, (modSymCount.get(m) ?? 0) + 1);
  }
  const modules: AggModule[] = [...modFiles.entries()]
    .map(([id, fs]) => ({
      id,
      fileCount: fs.length,
      symbolCount: modSymCount.get(id) ?? 0,
      files: fs.sort((a, b) => a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Aggregate import edges between modules.
  const edgeMap = new Map<string, AggEdge>();
  for (const e of edges) {
    if (e.edgeKind !== "imports") continue;
    if (!e.fromFileId || !e.toFileId) continue;
    const from = fileModule.get(e.fromFileId);
    const to = fileModule.get(e.toFileId);
    if (!from || !to || from === to) continue;
    const key = from + "->" + to;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count++;
      if (e.evidence) existing.evidence.push(e.evidence);
      if (e.status === "candidate" || e.status === "missing") existing.status = e.status;
    } else {
      edgeMap.set(key, {
        id: key,
        from,
        to,
        count: 1,
        status: e.status,
        evidence: e.evidence ? [e.evidence] : [],
      });
    }
  }
  return { modules, edges: [...edgeMap.values()] };
}

/** Group a file's symbols into a compact outline. */
export function outlineSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  return symbols
    .filter((s) => ["function", "class", "method", "component", "route", "test", "interface", "type"].includes(s.kind))
    .sort((a, b) => (a.rangeStart?.line ?? 0) - (b.rangeStart?.line ?? 0));
}

export interface ResolvedTarget {
  fileId?: string;
  line?: number;
  symbolName?: string;
  resolvable: boolean;
}

export function resolveEdgeTarget(
  edge: CodeEdge,
  fileMap: Map<string, CodeFile>,
  symbolMap: Map<string, CodeSymbol>,
  selfFileId: string,
): ResolvedTarget {
  if (edge.toFileId && fileMap.has(edge.toFileId)) {
    const f = fileMap.get(edge.toFileId)!;
    return { fileId: f.fileId, resolvable: f.fileId !== selfFileId };
  }
  if (edge.toSymbolId && symbolMap.has(edge.toSymbolId)) {
    const s = symbolMap.get(edge.toSymbolId)!;
    const f = fileMap.get(s.fileId);
    return { fileId: f?.fileId, line: s.rangeStart?.line ?? undefined, symbolName: s.name, resolvable: !!f && f.fileId !== selfFileId };
  }
  return { resolvable: false };
}
