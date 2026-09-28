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
  setCurrentSnapshot,
  upsertFile,
  upsertSnapshotFile,
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

/** Resolve the review revision that supplied `path`'s bytes at this snapshot,
 * plus the fragment whose text contains `declText` (fallback: first fragment).
 * Both are pinned to the snapshot so historical source/ranges survive later
 * review head moves. Returns revisionId=null when never captured. */
function bindFragment(
  store: Store,
  path: string,
  declText: string | null,
): { fragmentId: string | null; revisionId: string | null } {
  const sid = sourceIdForExternalId(store, EXTERNAL_ID_PREFIX + path);
  if (!sid) return { fragmentId: null, revisionId: null };
  const head = (store.db
    .prepare("SELECT head FROM sources WHERE id=?")
    .get(sid) as { head: string | null } | undefined)?.head;
  if (!head) return { fragmentId: null, revisionId: null };
  const revId = String(head);
  const frags = store.fragments(revId);
  if (!frags.length) return { fragmentId: null, revisionId: revId };
  if (declText) {
    const needle = declText.trim().slice(0, 60);
    const hit = frags.find((f) => f.text.includes(needle));
    if (hit) return { fragmentId: hit.id, revisionId: revId };
  }
  return { fragmentId: frags[0]!.id, revisionId: revId };
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
  return bf.frags[0]!.id;
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

  // Both a brand-new snapshot AND a reused one (tree returned to an earlier
  // state) must reconcile head/files/edges/understandings. Rows are upserted
  // idempotently; the snapshot row and its capturedAt stay immutable.
  const reused = !!existing;
  const pathToFileId = new Map<string, string>();
  for (const f of files) pathToFileId.set(f.path, fileIdFor(repoId, f.path));

  const liveSeeds = new Set<string>();

  store.tx(() => {
    for (const f of files) {
      const fileId = fileIdFor(repoId, f.path);
      const bf = bindFile(store, f.path);
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
      upsertSnapshotFile(store, {
        snapshotId: snapId,
        fileId,
        path: f.path,
        reviewRevisionId: bf.revisionId,
        contentHash: f.hash,
        contentText: f.text,
      });

      // 1) Symbols.
      const localQNames = new Map<string, string>();
      for (const sym of f.parsed.symbols) {
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
      }

      // 2) Imports.
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
      }

      // 3) Calls.
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
      }

      // 4) Routes.
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
      if (f.parsed.componentName) {
        const compSym = symbolIdFor(repoId, f.path, f.parsed.componentName, "component");
        for (const used of f.parsed.templateComponents) {
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
          language: f.parsed.language,
          symbolCount: f.parsed.symbols.length,
          importCount: f.parsed.imports.length,
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

  const stale = invalidateStaleEdges(store, liveSeeds, snapId);

  // Invalidate understandings for files that are no longer on disk.
  store.db
    .prepare(
      `UPDATE code_understandings SET stale=1
       WHERE target_type='file' AND target_id IN (SELECT file_id FROM code_files WHERE removed=1)`,
    )
    .run();

  // Explicit head pointer: do NOT trust captured_at ordering.
  setCurrentSnapshot(store, repoId, snapId);

  projectCuratedSeeds(store, repoRoot, snapId);

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
  };
}
