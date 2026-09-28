/** Pure helpers for grouping code files into architecture modules and
 * aggregating parser edges into a deterministic module dependency graph.
 * Kept free of Vue / DOM so it is unit-testable. */
import type { CodeEdge, CodeFile, CodeSymbol } from "../review-api";
import type { CodeUnderstandingListItem } from "../review-api";

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

/** Pick the curated module-architect understanding that best describes a module
 * bucket. The curated `targetId` is a repo directory (e.g.
 * `apps/server/src/memory`); we match it by longest prefix against the module's
 * files, preferring the current (non-stale, non-rejected) row. Pure. */
export function matchModuleUnderstanding(
  mod: { files: CodeFile[] },
  items: CodeUnderstandingListItem[],
): CodeUnderstandingListItem | null {
  const candidates = items.filter(
    (it) =>
      it.targetType === "module" &&
      it.source === "curated-seed" &&
      !it.stale &&
      (it.status === "seed" || it.status === "generated" || it.status === "verified"),
  );
  if (!candidates.length) return null;
  // Match by ANY file in the module, not just a "representative" shortest path:
  // for e.g. the `web` module, apps/web/package.json (depth 3) used to shadow
  // the curated targetId `apps/web/src` (depth 4). We check every file and pick
  // the longest curated prefix that covers at least one file.
  const paths = mod.files.map((f) => f.path);
  let best: CodeUnderstandingListItem | null = null;
  let bestLen = -1;
  for (const it of candidates) {
    const prefix = it.targetId.replace(/\/$/, "");
    const covers = paths.some((p) => p === prefix || p.startsWith(prefix + "/"));
    if (covers && prefix.length > bestLen) {
      best = it;
      bestLen = prefix.length;
    }
  }
  return best;
}

/** Resolve an edge to a drill target. Same-file symbol edges DO drill (to a
 * symbol/range frame) rather than being swallowed; only truly external /
 * unresolved targets are non-navigable. */
export type EdgeDrill =
  | { kind: "file"; fileId: string; line?: number }
  | { kind: "symbol"; fileId: string; symbolId: string; line: number }
  | { kind: "none" };

export function edgeDrillTarget(
  edge: CodeEdge,
  fileMap: Map<string, CodeFile>,
  symbolMap: Map<string, CodeSymbol>,
  selfFileId: string,
): EdgeDrill {
  if (edge.toSymbolId && symbolMap.has(edge.toSymbolId)) {
    const s = symbolMap.get(edge.toSymbolId)!;
    const f = fileMap.get(s.fileId);
    const line = s.rangeStart?.line ?? 1;
    if (!f) return { kind: "none" };
    return f.fileId === selfFileId
      ? { kind: "symbol", fileId: f.fileId, symbolId: s.symbolId, line }
      : { kind: "file", fileId: f.fileId, line };
  }
  if (edge.toFileId && fileMap.has(edge.toFileId)) {
    const f = fileMap.get(edge.toFileId)!;
    if (f.fileId === selfFileId) return { kind: "none" };
    return { kind: "file", fileId: f.fileId };
  }
  return { kind: "none" };
}

/** Find a code file by its repo-relative path (used to turn a fragment
 * relation's filePath back into a code-file trail frame). */
export function fileByPath(fileMap: Map<string, CodeFile>, path: string): CodeFile | undefined {
  for (const f of fileMap.values()) if (f.path === path) return f;
  return undefined;
}

// ---- Human label resolution (DTO-first; never leaks an internal id) --------
// Prefer the server DTO display fields; fall back to a readable raw field
// (basename / name / path). If nothing readable exists, say "未命名{type}" —
// the internal id must NEVER appear as a DOM label.

export function fileLabel(f: Partial<Pick<CodeFile, "displayTitle" | "path">>): string {
  return f.displayTitle || (f.path && f.path.split("/").pop()) || "未命名文件";
}

export function filePathLabel(f: Partial<Pick<CodeFile, "displayPath" | "path">>): string {
  return f.displayPath || f.path || "";
}

export function symbolLabel(s: Partial<Pick<CodeSymbol, "displayTitle" | "name">>): string {
  return s.displayTitle || s.name || "未命名符号";
}

export function edgeReason(e: Partial<Pick<CodeEdge, "actionable" | "reason" | "status">>): string | null {
  if (e.actionable === false) return e.reason || "不可解析";
  if (e.actionable == null) {
    if (e.status === "missing") return "仓库内未解析";
    if (e.status === "stale") return "已过期";
  }
  return null;
}

export function edgeDisabled(e: Partial<Pick<CodeEdge, "actionable" | "status">>): boolean {
  if (e.actionable != null) return !e.actionable;
  return e.status === "missing";
}
