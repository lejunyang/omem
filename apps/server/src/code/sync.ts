/** Code Knowledge sync: parses captured TS/Vue originals deterministically,
 * and projects them onto the isolated review SQLite side tables. It does NOT
 * capture file bodies 鈥?that is review/sync.ts's job. Code rows are a projection
 * over already-captured fragments; fragment_id is filled by locating the head
 * review fragment that contains a symbol's declaration line.
 *
 * Snapshot identity includes repo/commit/dirty and captured revision identities
 * with their content hashes. Repeating the same capture reuses the snapshot.
 * Reverting after a replaced original was removed creates a new snapshot. When the tree
 * changes, a new snapshot row appears and edges/symbols from the previous parse
 * are re-upserted onto the new head; anything not re-produced flips stale.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { revisionText } from "../source-text.js";
import type { Store } from "../store.js";
import type {
  CodeKnowledgePort,
  CodeKnowledgeSyncResult,
} from "../../../../packages/contracts/src/index.js";
import {
  PARSER_VERSION,
  codeRepositoryId,
  currentSnapshotId,
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
  setCurrentSnapshot,
  upsertFile,
  upsertSnapshotFile,
  upsertRepository,
  upsertSymbol,
  upsertEdge,
  writeDeterministicUnderstanding,
} from "./store.js";
import { restoreGeneratedUnderstandings } from "./artifacts.js";
import { projectCuratedSeeds } from "./understanding-store.js";
import { parseFile, type ParsedFile } from "./parse.js";
import {
  EXTERNAL_ID_PREFIX,
  ensureReviewMetaTable,
  sourceIdForExternalId,
} from "../review/store.js";

const execFileAsync = promisify(execFile);

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

/** Resolve only within the captured file set, without consulting live disk. */
function resolveImport(fromPath: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = posix.join(posix.dirname(fromPath), specifier);
  const base = target.replace(/\.(m?js)$/, "");
  return [target, ...[".ts", ".tsx", ".vue", "/index.ts", ".mjs", ".js"].map(ext => base + ext)].find(p => known.has(p)) ?? null;
}

type BoundFile = { revisionId: string | null; frags: { id: string; text: string }[] };

function bindFile(store: Store, path: string): BoundFile {
  const sid = sourceIdForExternalId(store, EXTERNAL_ID_PREFIX + path);
  if (!sid) return { revisionId: null, frags: [] };
  const head = (store.db
    .prepare("SELECT head FROM sources WHERE id=?")
    .get(sid) as { head: string | null } | undefined)?.head;
  if (!head) return { revisionId: null, frags: [] };
  return { revisionId: String(head), frags: store.fragments(String(head)) };
}

function pickFragment(bf: BoundFile, declText: string | null): string | null {
  if (!bf.frags.length) return null;
  if (declText) {
    const needle = declText.trim().slice(0, 60);
    const hit = bf.frags.find((f) => f.text.includes(needle));
    if (hit) return hit.id;
  }
  return null;
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
  const started = performance.now();
  let parsedFiles = 0, cacheHits = 0, parseMs = 0;
  ensureCodeTables(store);
  ensureReviewMetaTable(store);

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

  // The Capture chain owns the bytes. Code analysis reads its immutable head
  // revisions and never pairs live filesystem text with an older fragment.
  const captured = store.db.prepare(`SELECT r.id, s.external_id
    FROM sources s JOIN revisions r ON r.id=s.head
    LEFT JOIN review_source_meta m ON m.source_id=s.id
    WHERE s.namespace='file' AND s.external_id LIKE 'omem:%'
      AND COALESCE(m.removed,0)=0 ORDER BY s.external_id`).all() as { id: string; external_id: string }[];
  // Read each captured original once. Determine fixed identity before parsing;
  // an already-current projection needs neither AST parsing nor graph rewriting.
  const sources = captured.map(row => {
    const text = revisionText(store, row.id);
    return { ...row, text, hash: sha256(text ?? "") };
  });
  const status = await git(["status", "--porcelain"], repoRoot);
  const dirty = !!status && status.length > 0;
  const snapId = snapshotIdFor(repoId, commit, dirty,
    sources.map(row => `${row.external_id}:${row.id}:${row.hash}`));
  const existing = getSnapshot(store, snapId);
  const projectionReused = !!existing && currentSnapshotId(store) === snapId;
  const cached = store.db.prepare("SELECT parsed_json,output_hash FROM code_parse_cache WHERE path=? AND content_hash=? AND parser_version=?");
  type FileRec = { path: string; text: string; hash: string; size: number; parsed?: ParsedFile };
  const files: FileRec[] = [];
  for (const row of sources) {
    const path = row.external_id.slice(EXTERNAL_ID_PREFIX.length);
    if (!/^(apps|packages|scripts)\//.test(path) || !/\.(ts|tsx|vue|mjs|js|json|toml|md)$/.test(path)) continue;
    if (row.text === null || !row.text.trim()) continue;
    let parsed: ParsedFile | undefined;
    if (!projectionReused) {
      const cache = cached.get(path, row.hash, PARSER_VERSION);
      if (cache && sha256(String(cache.parsed_json)) === cache.output_hash) {
        try { parsed = JSON.parse(String(cache.parsed_json)); cacheHits++; } catch { /* rebuild damaged cache */ }
      }
      if (!parsed) {
        const before = performance.now();
        parsed = parseFile(path, row.text); parseMs += performance.now() - before; parsedFiles++;
      }
    }
    files.push({path, text:row.text, hash:row.hash, size:Buffer.byteLength(row.text), parsed});
  }
  const readMs = performance.now() - started - parseMs;
  const knownPaths = new Set(files.map(f => f.path));

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

  // Returning to an older snapshot reconciles the current graph and bindings.
  // An already-current projection keeps its graph. Snapshot identity and its
  // capturedAt stay immutable in both cases.
  const reused = !!existing;
  const pathToFileId = new Map<string, string>();
  for (const f of files) pathToFileId.set(f.path, fileIdFor(repoId, f.path));

  const liveSeeds = new Set<string>();

  const projectionStarted = performance.now();
  if (!projectionReused) store.tx(() => {
    for (const row of sources) {
      const path = row.external_id.slice(EXTERNAL_ID_PREFIX.length);
      if (row.text === null) continue;
      store.db.prepare("INSERT OR IGNORE INTO code_snapshot_sources VALUES(?,?,?,?)").run(snapId, path, row.id, row.hash);
    }
    for (const f of files) {
      const parsed = f.parsed!;
      const json = JSON.stringify(parsed);
      store.db.prepare("INSERT OR REPLACE INTO code_parse_cache VALUES(?,?,?,?,?)").run(f.path,f.hash,PARSER_VERSION,json,sha256(json));
      const fileId = fileIdFor(repoId, f.path);
      const bf = bindFile(store, f.path);
      upsertFile(store, {
        fileId,
        repoId,
        path: f.path,
        language: parsed.language,
        sizeBytes: f.size,
        contentHash: f.hash,
        headSnapshotId: snapId,
        removed: false,
        movedTo: null,
      });
      upsertSnapshotFile(store, {
        snapshotId: snapId,
        fileId,
        path: f.path,
        reviewRevisionId: bf.revisionId,
        contentHash: f.hash,
        contentText: null,
      });

      // 1) Symbols.
      const localQNames = new Map<string, string>();
      for (const sym of parsed.symbols) {
        const sid = symbolIdFor(repoId, f.path, sym.qualifiedName, sym.kind);
        const declLine = f.text.split("\n")[sym.rangeStart.line - 1] ?? null;
        upsertSymbol(store, {
          symbolId: sid,
          fileId,
          snapshotId: snapId,
          name: sym.name,
          qualifiedName: sym.qualifiedName,
          kind: sym.kind,
          rangeStart: sym.rangeStart,
          rangeEnd: sym.rangeEnd,
          fragmentId: pickFragment(bf, declLine),
          exported: sym.exported,
          signature: sym.signature,
        });
        localQNames.set(sym.qualifiedName, sid);
        localQNames.set(sym.name, sid);
      }

      // defines edges.
      for (const sym of parsed.symbols) {
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
      }

      // 2) Imports.
      for (const imp of parsed.imports) {
        const target = resolveImport(f.path, imp.specifier, knownPaths);
        const toFile = target ? pathToFileId.get(target) ?? null : null;
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
      }

      // 3) Calls.
      for (const call of parsed.calls) {
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
      }

      // 4) Routes.
      for (const route of parsed.routes) {
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
          fragmentId: pickFragment(bf, route.path),
          exported: false,
          signature: qname,
        });
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
      }

      // 5) Tests.
      for (const t of parsed.tests) {
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
          fragmentId: pickFragment(bf, t.name),
          exported: false,
          signature: `it('${t.name}')`,
        });
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
      }

      // 6) Vue components.
      if (parsed.componentName) {
        const compSym = symbolIdFor(repoId, f.path, parsed.componentName, "component");
        for (const used of parsed.templateComponents) {
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
        }
      }

      // Deterministic understanding.
      writeDeterministicUnderstanding(store, {
        targetType: "file",
        targetId: fileId,
        snapshotId: snapId,
        inputHash: f.hash,
        outputJson: JSON.stringify({
          language: parsed.language,
          symbolCount: parsed.symbols.length,
          importCount: parsed.imports.length,
        }),
        unknowns: ["call resolution is name-level within one file, no cross-file types"],
        evidenceRefs: [],
      });
    }

    // Mark files that disappeared as removed.
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

  store.db.exec("DELETE FROM code_parse_cache WHERE path NOT IN (SELECT path FROM code_files WHERE removed=0)");
  const stale = projectionReused ? 0 : invalidateStaleEdges(store, liveSeeds, snapId);

  // Invalidate understandings for files that are no longer on disk.
  store.db
    .prepare(
      `UPDATE code_understandings SET stale=1
       WHERE target_type='file' AND target_id IN (SELECT file_id FROM code_files WHERE removed=1)`,
    )
    .run();

  // Explicit head pointer: do NOT trust captured_at ordering.
  setCurrentSnapshot(store, repoId, snapId);

  store.db.prepare("UPDATE code_understandings SET stale=1 WHERE source='model-generated' AND snapshot_id<>?").run(snapId);
  const projectionMs = performance.now() - projectionStarted;
  const restoreStarted = performance.now();
  projectCuratedSeeds(store, repoRoot, snapId);
  const restored = restoreGeneratedUnderstandings(store, repoRoot);
  for (const row of restored) if (row.status !== "restored") console.warn(`Wiki ${row.status}: ${row.file}: ${row.reason}`);

  return {
    snapshotId: snapId,
    fileCount: files.length,
    symbolCount: Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_symbols WHERE snapshot_id=?").get(snapId) as { n: number }).n,
    ),
    edgeCount: Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_edges WHERE snapshot_id=? AND status<>'stale'").get(snapId) as { n: number }).n,
    ),
    staleEdgeCount: stale,
    reused,
    analysis: {parsedFiles,cacheHits,skippedFiles:projectionReused ? files.length : 0,projectionReused},
    timingsMs: {read:readMs,parse:parseMs,projection:projectionMs,restore:performance.now()-restoreStarted,total:performance.now()-started},
  };
}
