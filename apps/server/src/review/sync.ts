/** Incremental scanner that turns the omem repo itself into a code-review
 * knowledge base. Each file is one source whose identity is its repo-relative
 * path (`omem:<path>`), NOT a content hash: editing the same file appends a new
 * revision on the same source, while two files that happen to share bytes stay
 * independent sources. Content hash is recorded per revision only to detect change.
 *
 * Snapshot honesty: every captured revision records the real HEAD commit, whether
 * the working tree was dirty, the content hash and the sync time — never mtime.
 * Incremental scans cover both committed changes and uncommitted/untracked work.
 * Git failures degrade to a full rescan instead of silently reporting success.
 *
 * Only whitelisted plain text under fixed roots is read; symlink/junction escape,
 * non-UTF-8 bytes and oversized files are rejected per-file without aborting.
 * Nothing here touches the network, reads secrets, or starts any worker. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  lstatSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import {
  reviewStateDir,
  EXTERNAL_ID_PREFIX,
  ensureReviewMetaTable,
  migrateLegacySources,
  setSourceMeta,
  sourceIdForExternalId,
} from "./store.js";

const execFileAsync = promisify(execFile);

export type ReviewCategory = "architecture" | "progress" | "decisions" | "research";

export type FailedFile = { path: string; reason: string };

export type SyncStats = {
  totalScanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failedCount: number;
};

export type SyncResult = Omit<SyncStats, "failedCount"> & {
  lastSyncCommit: string | null;
  lastSyncAt: string;
  dirty: boolean;
  /** Files that could not be read/decoded/imported; the rest of the sync is
   * unaffected. */
  failed: FailedFile[];
  warnings: string[];
};

export type SyncOptions = {
  /** Import exactly these repo-relative paths (tests / ad-hoc), bypassing the
   * git-diff incremental logic and not touching the on-disk sync state. */
  only?: string[];
  /** Override where last-sync state lives (tests). */
  stateDir?: string;
};

const CATEGORY_NAMES: Record<ReviewCategory, string> = {
  architecture: "架构与实现",
  progress: "进度追踪",
  decisions: "历史决策",
  research: "背景调研",
};

export function categoryName(category: string): string {
  return (
    (CATEGORY_NAMES as Record<string, string>)[category] ?? category
  );
}

/** Top-level directories the scanner is allowed to descend into. Keeping this
 * list fixed means node_modules / .git / build output are never walked. */
const SCAN_ROOTS = ["apps", "packages", "docs", "scripts"];

/** Root-level files explicitly admitted to the read whitelist. */
const ROOT_FILES = [
  "design.md",
  "AGENTS.md",
  "README.md",
  "osdk.toml",
  "package.json",
];

const EXCLUDED_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".repo-review",
]);

/** Reject any single source file larger than this (binary/lockfile guard). */
const MAX_FILE_BYTES = 500_000;

function isExcluded(rel: string): boolean {
  const segments = rel.split("/");
  if (segments.some((s) => EXCLUDED_DIR_SEGMENTS.has(s))) return true;
  if (rel.endsWith(".local.json")) return true;
  if ((segments.at(-1) ?? "").startsWith(".env")) return true;
  if (rel.startsWith("apps/server/tests/fixtures/")) return true;
  return false;
}

function classify(rel: string): ReviewCategory | null {
  if (isExcluded(rel)) return null;
  if (rel.startsWith("apps/") && rel.endsWith(".ts")) return "architecture";
  if (rel.startsWith("packages/") && rel.endsWith(".ts")) return "architecture";
  if (
    rel.startsWith("apps/web/") &&
    (rel.endsWith(".ts") || rel.endsWith(".vue"))
  )
    return "architecture";
  if (
    rel === "docs/implementation/status.md" ||
    rel === "AGENTS.md" ||
    rel === "README.md"
  )
    return "progress";
  if (rel.startsWith("docs/reviews/") && rel.endsWith(".md")) return "decisions";
  if (
    rel.startsWith("docs/implementation/assistant-v3/") &&
    rel.endsWith(".md")
  )
    return "decisions";
  if (rel.startsWith("docs/research/") && rel.endsWith(".md")) return "research";
  return null;
}

/** True when `abs` is a symlink/junction or resolves outside repoRoot. */
function isUnsafeLink(abs: string, repoRoot: string): boolean {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return true;
  }
  if (st.isSymbolicLink()) return true;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return true;
  }
  const rel = relative(repoRoot, real).split(sep).join("/");
  return rel.startsWith("..");
}

function walk(dir: string, repoRoot: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(repoRoot, abs).split(sep).join("/");
    if (entry.isSymbolicLink()) continue; // never follow links
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_SEGMENTS.has(entry.name)) continue;
      walk(abs, repoRoot, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** Every candidate (file, category) the scanner knows about right now. */
function collectCandidates(repoRoot: string): { rel: string; category: ReviewCategory }[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const rootAbs = join(repoRoot, root);
    if (existsSync(rootAbs) && !isUnsafeLink(rootAbs, repoRoot))
      walk(rootAbs, repoRoot, files);
  }
  for (const rel of ROOT_FILES)
    if (existsSync(join(repoRoot, rel))) files.push(rel);
  const out: { rel: string; category: ReviewCategory }[] = [];
  for (const rel of files) {
    const category = classify(rel);
    if (category) out.push({ rel, category });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fragment splitters. The store later splits each text part on blank lines; we
// emit one part per detected section so symbol/heading boundaries are stable.
// ---------------------------------------------------------------------------

const CODE_BOUNDARY =
  /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|enum|interface|type)\s+[A-Za-z_$]/;

function splitCodeFragments(text: string): string[] {
  return splitByBoundary(text, CODE_BOUNDARY);
}

function splitMarkdownFragments(text: string): string[] {
  return splitByBoundary(text, /^#{1,6}\s+\S/);
}

function splitByBoundary(text: string, boundary: RegExp): string[] {
  const lines = text.split("\n");
  const fragments: string[] = [];
  let current: string[] = [];
  const hasContent = () => current.some((l) => l.trim());
  for (const line of lines) {
    if (boundary.test(line) && hasContent()) {
      fragments.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (hasContent()) fragments.push(current.join("\n").trim());
  return fragments.filter((f) => f.length > 0);
}

function extractSymbols(text: string): string[] {
  const symbols: string[] = [];
  const re =
    /^\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|const|let|var|enum|interface|type)\s+([A-Za-z0-9_$]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) symbols.push(match[1]!);
  return [...new Set(symbols)].slice(0, 200);
}

// ---------------------------------------------------------------------------
// Git helpers. Every call returns a tagged result so callers can distinguish
// "git ran, empty output" from "git failed" — the latter must degrade to a full
// rescan, never to a silent empty-set + baseline advance.
// ---------------------------------------------------------------------------

type GitOutcome = { ok: true; stdout: string } | { ok: false; error: string };

async function git(args: string[], repoRoot: string): Promise<GitOutcome> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      timeout: 15_000,
      maxBuffer: 4_000_000,
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}

type GitChange = { path: string; code: string; oldPath?: string };

function parsePorcelain(stdout: string): GitChange[] {
  const out: GitChange[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (!rest.trim()) continue;
    if (rest.includes("->")) {
      const arrow = rest.indexOf("->");
      const oldPath = rest.slice(0, arrow).trim().replace(/^"|"$/g, "");
      const newPath = rest.slice(arrow + 2).trim().replace(/^"|"$/g, "");
      out.push({ path: newPath, code: "R", oldPath });
    } else {
      out.push({
        path: rest.trim().replace(/^"|"$/g, "").split("\\").join("/"),
        code: xy.trim(),
      });
    }
  }
  return out;
}

const normPath = (p: string) => p.split("\\").join("/");

// ---------------------------------------------------------------------------
// State persistence.
// ---------------------------------------------------------------------------

function statePaths(stateDir: string) {
  return {
    commit: join(stateDir, "last-sync.txt"),
    meta: join(stateDir, "last-sync.json"),
  };
}

function readLastCommit(stateDir: string): string | null {
  const file = statePaths(stateDir).commit;
  if (!existsSync(file)) return null;
  const value = readFileSync(file, "utf8").trim();
  return value.length ? value : null;
}

function persistState(stateDir: string, result: SyncResult, advance: boolean): void {
  mkdirSync(stateDir, { recursive: true });
  const { commit, meta } = statePaths(stateDir);
  if (advance && result.lastSyncCommit)
    writeFileSync(commit, result.lastSyncCommit + "\n", "utf8");
  writeFileSync(meta, JSON.stringify(result, null, 2), "utf8");
}

export function readSyncStatus(
  repoRoot: string,
  stateDir: string = reviewStateDir(repoRoot),
): {
  lastSyncCommit: string | null;
  lastSyncAt: string | null;
  stats: SyncStats | null;
  dirty: boolean;
  failed: FailedFile[];
  warnings: string[];
} {
  const { commit, meta } = statePaths(stateDir);
  const lastSyncCommit = existsSync(commit)
    ? readFileSync(commit, "utf8").trim() || null
    : null;
  if (!existsSync(meta))
    return { lastSyncCommit, lastSyncAt: null, stats: null, dirty: false, failed: [], warnings: [] };
  try {
    const parsed = JSON.parse(readFileSync(meta, "utf8")) as SyncResult;
    return {
      lastSyncCommit,
      lastSyncAt: parsed.lastSyncAt ?? null,
      stats: {
        totalScanned: parsed.totalScanned,
        imported: parsed.imported,
        updated: parsed.updated,
        unchanged: parsed.unchanged,
        skipped: parsed.skipped,
        failedCount: Array.isArray(parsed.failed) ? parsed.failed.length : 0,
      },
      dirty: parsed.dirty ?? false,
      failed: parsed.failed ?? [],
      warnings: parsed.warnings ?? [],
    };
  } catch {
    return { lastSyncCommit, lastSyncAt: null, stats: null, dirty: false, failed: [], warnings: [] };
  }
}

// ---------------------------------------------------------------------------
// Core: import one file through store.capture().
// ---------------------------------------------------------------------------

type Snapshot = { commit: string | null; dirty: boolean };
type CaptureOutcome = "imported" | "updated" | "unchanged" | "skipped" | "failed";

function headContentHash(store: Store, externalId: string): string | null {
  const row = store.db
    .prepare(
      `SELECT r.body AS body FROM sources s JOIN revisions r ON s.head=r.id
       WHERE s.namespace='file' AND s.external_id=?`,
    )
    .get(externalId) as { body: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.body) as {
      context?: { contentHash?: string };
    };
    return parsed.context?.contentHash ?? null;
  } catch {
    return null;
  }
}

function captureOne(
  store: Store,
  repoRoot: string,
  rel: string,
  category: ReviewCategory,
  snapshot: Snapshot,
  recordFailed: (path: string, reason: string) => void,
): CaptureOutcome {
  const abs = join(repoRoot, rel);
  if (isUnsafeLink(abs, repoRoot)) {
    recordFailed(rel, "symlink/junction escapes whitelist");
    return "failed";
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch {
    recordFailed(rel, "unreadable");
    return "failed";
  }
  if (bytes.length > MAX_FILE_BYTES) {
    recordFailed(rel, `exceeds ${MAX_FILE_BYTES} bytes`);
    return "failed";
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    recordFailed(rel, "not valid UTF-8");
    return "failed";
  }
  if (!text.trim()) return "skipped";

  const digest = createHash("sha256").update(text).digest("hex");
  const externalId = EXTERNAL_ID_PREFIX + rel;

  // Idempotency: if the head revision already captured this exact content, do NOT
  // call capture (which would otherwise fingerprint the changing syncedAt and
  // mint a duplicate revision). This keeps repeat syncs revision-for-revision stable.
  if (headContentHash(store, externalId) === digest) return "unchanged";

  const sections =
    category === "architecture"
      ? splitCodeFragments(text)
      : splitMarkdownFragments(text);
  let parts: CaptureInput["parts"];
  if (sections.length > 0 && sections.length <= 1500)
    parts = sections.map((section) => ({ type: "text" as const, text: section }));
  else parts = [{ type: "text" as const, text }];

  const context: Record<string, unknown> = {
    category,
    filePath: rel,
    gitCommit: snapshot.commit,
    dirty: snapshot.dirty,
    contentHash: digest,
    syncedAt: new Date().toISOString(),
  };
  if (category === "architecture") context.symbols = extractSymbols(text);
  if (category === "decisions") {
    // Review decision date = when it was synced, not file mtime.
    context.reviewDate = new Date().toISOString().slice(0, 10);
  }

  const result = store.capture({
    source: "file",
    externalId,
    title: rel,
    parts,
    context: context as unknown as CaptureInput["context"],
  });
  if (result.duplicate) return "unchanged";
  return result.revision.version > 1 ? "updated" : "imported";
}

/** Reconcile removed/moved state: any path-identified source whose file is gone
 * is marked removed; a reappearing file is un-removed. Renames get a moved_to
 * pointer on the old source. */
function reconcileSources(
  store: Store,
  repoRoot: string,
  renames: Map<string, string>,
): void {
  const rows = store.db
    .prepare(
      `SELECT s.id AS id, s.external_id AS ext FROM sources s
       WHERE s.namespace='file' AND s.external_id LIKE ?`,
    )
    .all(EXTERNAL_ID_PREFIX + "%") as { id: string; ext: string }[];
  for (const row of rows) {
    const p = String(row.ext).slice(EXTERNAL_ID_PREFIX.length);
    const exists = existsSync(join(repoRoot, p));
    const sid = String(row.id);
    if (!exists) {
      setSourceMeta(store, sid, { removed: true });
    } else {
      setSourceMeta(store, sid, { removed: false });
    }
  }
  for (const [oldPath, newPath] of renames) {
    const sid = sourceIdForExternalId(store, EXTERNAL_ID_PREFIX + oldPath);
    if (sid) setSourceMeta(store, sid, { movedTo: newPath });
  }
}

// ---------------------------------------------------------------------------
// Core: run the incremental review sync.
// ---------------------------------------------------------------------------

export async function runReviewSync(
  store: Store,
  repoRoot: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  ensureReviewMetaTable(store);
  const stateDir = options.stateDir ?? reviewStateDir(repoRoot);
  mkdirSync(stateDir, { recursive: true });
  migrateLegacySources(store, stateDir);

  const stats: SyncStats = {
    totalScanned: 0,
    imported: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failedCount: 0,
  };
  const failed: FailedFile[] = [];
  const warnings: string[] = [];
  const recordFailed = (path: string, reason: string) => {
    failed.push({ path, reason });
    stats.failedCount++;
  };

  let targets: { rel: string; category: ReviewCategory }[];
  const snapshot: Snapshot = { commit: null, dirty: false };
  let advanceBaseline = true;

  if (options.only?.length) {
    targets = options.only
      .map((rel) => {
        const normalized = normPath(rel);
        return { rel: normalized, category: classify(normalized) };
      })
      .filter(
        (t): t is { rel: string; category: ReviewCategory } =>
          t.category !== null,
      );
  } else {
    const head = await git(["rev-parse", "HEAD"], repoRoot);
    const current = head.ok ? head.stdout.trim() : null;
    snapshot.commit = current || null;
    const baseline = readLastCommit(stateDir);

    const changed = new Map<string, GitChange>();
    const renames = new Map<string, string>();
    let fullRescan = false;

    const status = await git(["status", "--porcelain"], repoRoot);
    if (!status.ok) {
      warnings.push(`git status failed: ${status.error}`);
      fullRescan = true;
      advanceBaseline = false;
    } else {
      snapshot.dirty = status.stdout.trim().length > 0;
      for (const c of parsePorcelain(status.stdout)) {
        changed.set(c.path, c);
        if (c.code.startsWith("R") && c.oldPath)
          renames.set(c.oldPath, c.path);
      }
    }

    let baselineValid = false;
    if (baseline && current) {
      const cat = await git(["cat-file", "-t", baseline], repoRoot);
      baselineValid = cat.ok;
      if (baseline && !baselineValid)
        warnings.push(`baseline commit ${baseline} missing; full rescan`);
    }

    if (!fullRescan && baseline && current && baselineValid && baseline !== current) {
      const diff = await git(["diff", "--name-only", baseline, current], repoRoot);
      if (!diff.ok) {
        warnings.push(`git diff failed: ${diff.error}`);
        fullRescan = true;
        advanceBaseline = false;
      } else {
        for (const p of diff.stdout
          .split(/\r?\n/)
          .map((s) => normPath(s.trim()))
          .filter(Boolean)) {
          if (!changed.has(p)) changed.set(p, { path: p, code: "M" });
        }
      }
    }

    const all = collectCandidates(repoRoot);

    if (fullRescan) {
      targets = all;
    } else if (!baseline || !current || !baselineValid) {
      targets = all; // first run or lost baseline: full
    } else if (changed.size === 0) {
      targets = []; // baseline==HEAD and clean: nothing to do
    } else {
      targets = all.filter((t) => changed.has(t.rel));
    }

    reconcileSources(store, repoRoot, renames);
  }

  for (const target of targets) {
    stats.totalScanned++;
    switch (
      captureOne(store, repoRoot, target.rel, target.category, snapshot, recordFailed)
    ) {
      case "imported":
        stats.imported++;
        break;
      case "updated":
        stats.updated++;
        break;
      case "unchanged":
        stats.unchanged++;
        break;
      case "skipped":
        stats.skipped++;
        break;
      case "failed":
        // counted inside recordFailed
        break;
    }
  }

  const result: SyncResult = {
    ...stats,
    lastSyncCommit: options.only ? null : snapshot.commit,
    lastSyncAt: new Date().toISOString(),
    dirty: snapshot.dirty,
    failed,
    warnings,
  };
  if (!options.only) persistState(stateDir, result, advanceBaseline);
  return result;
}
