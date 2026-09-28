/** Code Knowledge sync: walks the repo, parses TS/Vue files deterministically,
 * and projects them onto the isolated review SQLite side tables. It does NOT
 * capture file bodies 鈥?that is review/sync.ts's job. Code rows are a projection
 * over already-captured fragments; fragment_id is filled by locating the head
 * review fragment that contains a symbol's declaration line.
 *
 * Snapshot identity = repo + commit + dirty + sorted content-hash list. Two runs
 * over identical input reuse the same snapshot row (idempotent). When the tree
 * changes, a new snapshot row appears and edges/symbols from the previous parse
 * are re-upserted onto the new head; anything not re-produced flips stale.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import type { Store } from "../store.js";
import type {
  CodeKnowledgePort,
  CodeKnowledgeSyncResult,
} from "../../../../packages/contracts/src/index.js";
import {
  PARSER_VERSION,
  codeRepositoryId,
  ensureCodeTables,
  fileById,
  fileIdFor,
  getSnapshot,
  graphView,
  insertSnapshot,
  invalidateStaleEdges,
  latestSnapshot,
  listFiles,
  listSnapshots,
  listRepositories,
  snapshotIdFor,
  symbolIdFor,
  symbolsOfFile,
  symbolsOfSnapshot,
  edgesTouching,
  understandingOf,
  upsertFile,
  upsertRepository,
  upsertSymbol,
  upsertEdge,
  writeDeterministicUnderstanding,
} from "./store.js";
import { projectCuratedSeeds } from "./understanding-store.js";
import { parseFile, type ParsedFile } from "./parse.js";
import {
  EXTERNAL_ID_PREFIX,
  ensureReviewMetaTable,
  sourceIdForExternalId,
} from "../review/store.js";

const execFileAsync = promisify(execFile);

const CODE_ROOTS = ["apps", "packages", "scripts"];
const EXCLUDED = new Set(["node_modules", "dist", ".git", ".repo-review", "coverage"]);
const MAX_BYTES = 500_000;

function walk(dir: string, root: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join("/");
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (EXCLUDED.has(e.name)) continue;
      walk(abs, root, out);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

function isCodeFile(rel: string): boolean {
  if (rel.includes("/node_modules/") || rel.includes("/dist/")) return false;
  if (rel.endsWith(".local.json")) return false;
  if (rel.startsWith("apps/server/tests/fixtures/")) return false;
  return /\.(ts|tsx|vue|mjs|js|json|toml|md)$/.test(rel);
}

async function git(args: string[], root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      timeout: 15_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Resolve a TS/Vue import specifier relative from `fromPath` to a repo-relative
 * path, when it points at an in-repo module. Returns null for bare packages. */
function resolveImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // bare package import
  const base = dirname(fromPath);
  let target = join(base, specifier).split(sep).join("/");
  // Strip .js/.mjs extension to find the TS source; try common extensions.
  const candidates = [target];
  for (const ext of [".ts", ".tsx", ".vue", "/index.ts", ".mjs", ".js"]) {
    if (target.endsWith(".js") || target.endsWith(".mjs")) {
      candidates.push(target.replace(/\.(m?js)$/, ext === ".js" ? ".js" : ext));
    } else {
      candidates.push(target + ext);
    }
  }
  for (const c of candidates) {
    const normalized = c.split(sep).join("/");
    if (existsSync(join(repoRootGuard, normalized))) return normalized;
  }
  return null;
}

// set by runCodeSync before resolution (avoids threading repoRoot everywhere)
let repoRootGuard = "";

/** Locate the head review fragment for `path` whose text contains the line
 * starting with `declText` (trimmed prefix). Falls back to the first head
 * fragment. Returns null when the file was never captured by review sync. */
function bindFragment(
  store: Store,
  path: string,
  declText: string | null,
): string | null {
  const sid = sourceIdForExternalId(store, EXTERNAL_ID_PREFIX + path);
  if (!sid) return null;
  const head = (store.db
    .prepare("SELECT head FROM sources WHERE id=?")
    .get(sid) as { head: string | null } | undefined)?.head;
  if (!head) return null;
  const frags = store.fragments(String(head));
  if (!frags.length) return null;
  if (declText) {
    const needle = declText.trim().slice(0, 60);
    const hit = frags.find((f) => f.text.includes(needle));
    if (hit) return hit.id;
  }
  return frags[0]!.id;
}

export class CodeKnowledgeService implements CodeKnowledgePort {
  constructor(
    private readonly store: Store,
    private readonly repoRoot: string,
  ) {}

  currentSnapshot() {
    return latestSnapshot(this.store);
  }
  listRepositories() {
    return listRepositories(this.store);
  }
  listSnapshots(repoId?: string) {
    return listSnapshots(this.store, repoId);
  }
  listFiles(filter?: { language?: string; includeRemoved?: boolean }) {
    return listFiles(this.store, filter);
  }
  fileById(fileId: string) {
    return fileById(this.store, fileId);
  }
  symbolsOfFile(fileId: string) {
    return symbolsOfFile(this.store, fileId);
  }
  symbolsOfSnapshot(snapshotId: string) {
    return symbolsOfSnapshot(this.store, snapshotId);
  }
  edgesOf(
    ref: { symbolId?: string; fileId?: string },
    opts?: { includeStale?: boolean },
  ) {
    return edgesTouching(this.store, ref, opts);
  }
  graph(opts?: { snapshotId?: string; includeStale?: boolean }) {
    return graphView(this.store, opts);
  }
  understandingOf(target: { type: "file" | "symbol"; id: string }) {
    return understandingOf(this.store, target);
  }

  async sync(_opts: { only?: string[] } = {}): Promise<CodeKnowledgeSyncResult> {
    return runCodeSync(this.store, this.repoRoot);
  }
}

export async function runCodeSync(
  store: Store,
  repoRoot: string,
): Promise<CodeKnowledgeSyncResult> {
  ensureCodeTables(store);
  ensureReviewMetaTable(store);
  repoRootGuard = repoRoot;

  const repoId = codeRepositoryId();
  const commit = await git(["rev-parse", "HEAD"], repoRoot);
  const remote = await git(["remote", "get-url", "origin"], repoRoot);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  upsertRepository(store, {
    repoId,
    rootPath: repoRoot,
    remote: remote || null,
    defaultBranch: branch || null,
  });

  // Gather code files currently on disk.
  const rels: string[] = [];
  for (const root of CODE_ROOTS) {
    const abs = join(repoRoot, root);
    if (existsSync(abs)) walk(abs, repoRoot, rels);
  }
  const codePaths = rels.filter(isCodeFile).sort();

  // Read + hash + parse every file on disk.
  type FileRec = {
    path: string;
    text: string;
    hash: string;
    size: number;
    parsed: ParsedFile;
  };
  const files: FileRec[] = [];
  for (const path of codePaths) {
    const abs = join(repoRoot, path);
    let st: { size: number };
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.size > MAX_BYTES) continue;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    files.push({
      path,
      text,
      hash: sha256(text),
      size: st.size,
      parsed: parseFile(path, text),
    });
  }

  // Snapshot identity: repo + commit + dirty + sorted hashes.
  const status = await git(["status", "--porcelain"], repoRoot);
  const dirty = !!status && status.length > 0;
  const snapId = snapshotIdFor(
    repoId,
    commit,
    dirty,
    files.map((f) => f.hash),
  );
  const existing = getSnapshot(store, snapId);

  insertSnapshot(store, {
    snapshotId: snapId,
    repoId,
    commit,
    dirty,
    baselineCommit: null,
    parserVersion: PARSER_VERSION,
    fileCount: files.length,
    changedCount: files.length,
    partial: false,
  });

  if (existing) {
    // Identical input: rows already reflect this head. Re-project curated
    // seeds idempotently (same input_digest -> same understanding_id) and
    // return; no graph rebuild needed.
    projectCuratedSeeds(store, repoRoot, snapId);
    return {
      snapshotId: snapId,
      fileCount: files.length,
      symbolCount: Number(
        (store.db.prepare("SELECT COUNT(*) AS n FROM code_symbols WHERE snapshot_id=?").get(snapId) as { n: number }).n,
      ),
      edgeCount: Number(
        (store.db.prepare("SELECT COUNT(*) AS n FROM code_edges WHERE snapshot_id=?").get(snapId) as { n: number }).n,
      ),
      staleEdgeCount: 0,
      reused: true,
    };
  }

  // Map path 鈫?fileId, and path 鈫?symbols (qualifiedName 鈫?symbolId) for call resolution.
  const pathToFileId = new Map<string, string>();
  for (const f of files) pathToFileId.set(f.path, fileIdFor(repoId, f.path));

  const liveSeeds = new Set<string>();
  let symbolCount = 0;
  let edgeCount = 0;

  store.tx(() => {
    for (const f of files) {
      const fileId = fileIdFor(repoId, f.path);
      upsertFile(store, {
        fileId,
        repoId,
        path: f.path,
        language: f.parsed.language,
        sizeBytes: f.size,
        contentHash: f.hash,
        headSnapshotId: snapId,
        removed: false,
        movedTo: null,
      });

      // 1) Symbols.
      const localQNames = new Map<string, string>(); // qualifiedName -> symbolId
      for (const sym of f.parsed.symbols) {
        const sid = symbolIdFor(repoId, f.path, sym.qualifiedName, sym.kind);
        const declLine = f.text.split("\n")[sym.rangeStart.line - 1] ?? null;
        const fragId = bindFragment(store, f.path, declLine);
        upsertSymbol(store, {
          symbolId: sid,
          fileId,
          snapshotId: snapId,
          name: sym.name,
          qualifiedName: sym.qualifiedName,
          kind: sym.kind,
          rangeStart: sym.rangeStart,
          rangeEnd: sym.rangeEnd,
          fragmentId: fragId,
          exported: sym.exported,
          signature: sym.signature,
        });
        localQNames.set(sym.qualifiedName, sid);
        localQNames.set(sym.name, sid);
        symbolCount++;
      }

      // defines edges: file -> each symbol.
      for (const sym of f.parsed.symbols) {
        const toSym = symbolIdFor(repoId, f.path, sym.qualifiedName, sym.kind);
        const seed = `defines|${f.path}|${sym.qualifiedName}|${sym.kind}`;
        liveSeeds.add(seed);
        upsertEdge(store, {
          seed,
          snapshotId: snapId,
          edgeKind: "defines",
          fromSymbolId: null,
          fromFileId: fileId,
          toSymbolId: toSym,
          toFileId: null,
          status: "confirmed",
          origin: "parser",
          evidence: sym.signature,
        });
        edgeCount++;
      }

      // 2) Imports: file -> resolved file.
      for (const imp of f.parsed.imports) {
        const target = resolveImport(f.path, imp.specifier);
        const toFile = target ? pathToFileId.get(target) ?? fileIdFor(repoId, target) : null;
        const seed = `imports|${f.path}|${imp.specifier}`;
        liveSeeds.add(seed);
        upsertEdge(store, {
          seed,
          snapshotId: snapId,
          edgeKind: "imports",
          fromSymbolId: null,
          fromFileId: fileId,
          toSymbolId: null,
          toFileId: toFile,
          status: toFile ? "confirmed" : "missing",
          origin: "parser",
          evidence: imp.specifier,
        });
        edgeCount++;
      }

      // 3) Calls (name-level, same-file candidate).
      for (const call of f.parsed.calls) {
        const fromSym = localQNames.get(call.callerQName);
        const toSym = localQNames.get(call.callee);
        if (!toSym) continue;
        const seed = `calls|${f.path}|${call.callerQName || "<top>"}|${call.callee}`;
        liveSeeds.add(seed);
        upsertEdge(store, {
          seed,
          snapshotId: snapId,
          edgeKind: "calls",
          fromSymbolId: fromSym ?? null,
          fromFileId: fileId,
          toSymbolId: toSym,
          toFileId: null,
          status: "candidate",
          origin: "parser",
          evidence: `${call.callerQName || "<top>"} -> ${call.callee}`,
        });
        edgeCount++;
      }

      // 4) Routes: register a route symbol + a route edge.
      for (const route of f.parsed.routes) {
        const qname = `${route.method} ${route.path}`;
        const rid = symbolIdFor(repoId, f.path, qname, "route");
        upsertSymbol(store, {
          symbolId: rid,
          fileId,
          snapshotId: snapId,
          name: route.path,
          qualifiedName: qname,
          kind: "route",
          rangeStart: route.rangeStart,
          rangeEnd: route.rangeStart,
          fragmentId: bindFragment(store, f.path, route.path),
          exported: false,
          signature: qname,
        });
        symbolCount++;
        const seed = `route|${f.path}|${qname}`;
        liveSeeds.add(seed);
        upsertEdge(store, {
          seed,
          snapshotId: snapId,
          edgeKind: "route",
          fromSymbolId: rid,
          fromFileId: fileId,
          toSymbolId: null,
          toFileId: null,
          status: "confirmed",
          origin: "parser",
          evidence: qname,
        });
        edgeCount++;
      }

      // 5) Tests: register a test symbol + test_of edge to its own file.
      for (const t of f.parsed.tests) {
        const qname = `test:${t.name}`;
        const tid = symbolIdFor(repoId, f.path, qname, "test");
        upsertSymbol(store, {
          symbolId: tid,
          fileId,
          snapshotId: snapId,
          name: t.name,
          qualifiedName: qname,
          kind: "test",
          rangeStart: t.rangeStart,
          rangeEnd: t.rangeStart,
          fragmentId: bindFragment(store, f.path, t.name),
          exported: false,
          signature: `it('${t.name}')`,
        });
        symbolCount++;
        const seed = `test_of|${f.path}|${qname}`;
        liveSeeds.add(seed);
        upsertEdge(store, {
          seed,
          snapshotId: snapId,
          edgeKind: "test_of",
          fromSymbolId: tid,
          fromFileId: fileId,
          toSymbolId: null,
          toFileId: fileId,
          status: "confirmed",
          origin: "parser",
          evidence: t.name,
        });
        edgeCount++;
      }

      // 6) Vue: component symbol + uses_component template edges.
      if (f.parsed.componentName) {
        const compSym = symbolIdFor(repoId, f.path, f.parsed.componentName, "component");
        for (const used of f.parsed.templateComponents) {
          // candidate: we do not cross-resolve component files in PoC.
          const seed = `uses_component|${f.path}|${used}`;
          liveSeeds.add(seed);
          upsertEdge(store, {
            seed,
            snapshotId: snapId,
            edgeKind: "uses_component",
            fromSymbolId: compSym,
            fromFileId: fileId,
            toSymbolId: null,
            toFileId: null,
            status: "candidate",
            origin: "parser",
            evidence: `<${used} />`,
          });
          edgeCount++;
        }
      }

      // Deterministic understanding (no model): record what was parsed.
      writeDeterministicUnderstanding(store, {
        targetType: "file",
        targetId: fileId,
        snapshotId: snapId,
        inputHash: f.hash,
        outputJson: JSON.stringify({
          language: f.parsed.language,
          symbolCount: f.parsed.symbols.length,
          importCount: f.parsed.imports.length,
        }),
        unknowns: ["call resolution is name-level within one file, no cross-file types"],
        evidenceRefs: [],
      });
    }

    // Mark code_files rows for files that disappeared as removed.
    const known = new Set(files.map((f) => f.path));
    const existingRows = store.db
      .prepare("SELECT file_id, path FROM code_files")
      .all() as { file_id: string; path: string }[];
    for (const row of existingRows) {
      if (!known.has(String(row.path)) && Number((store.db.prepare("SELECT removed FROM code_files WHERE file_id=?").get(String(row.file_id)) as { removed: number }).removed) === 0) {
        upsertFile(store, {
          fileId: String(row.file_id),
          repoId,
          path: String(row.path),
          language: "unknown",
          sizeBytes: 0,
          contentHash: null,
          headSnapshotId: snapId,
          removed: true,
          movedTo: null,
        });
      }
    }
  });

  const stale = invalidateStaleEdges(store, liveSeeds);

  // Project committed curated module seeds onto the fresh head snapshot.
  projectCuratedSeeds(store, repoRoot, snapId);

  return {
    snapshotId: snapId,
    fileCount: files.length,
    symbolCount,
    edgeCount,
    staleEdgeCount: stale,
    reused: false,
  };
}
