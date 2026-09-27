/** Incremental scanner that turns the omem repo itself into a code-review
 * knowledge base. Four material categories are imported through the normal
 * store.capture() pipeline; each file is one source whose externalId is the sha256
 * of its content, so unchanged files are captured as duplicates (no new revision)
 * and content changes land as fresh snapshots.
 *
 * Only plain text under a few fixed roots is read. Nothing here touches the
 * network, reads secrets, or starts any worker. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import type { CaptureInput } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import { reviewStateDir } from "./store.js";

const exec = promisify(execFile);

export type ReviewCategory = "architecture" | "progress" | "decisions" | "research";

export type SyncStats = {
  totalScanned: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

export type SyncResult = SyncStats & {
  lastSyncCommit: string | null;
  lastSyncAt: string;
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
const SCAN_ROOTS = ["apps/server/src", "packages", "apps/web/src", "docs"];

const EXCLUDED_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".repo-review",
]);

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
  if (rel.startsWith("apps/server/src/") && rel.endsWith(".ts"))
    return "architecture";
  if (rel.startsWith("packages/") && rel.endsWith(".ts")) return "architecture";
  if (
    rel.startsWith("apps/web/src/") &&
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
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root), repoRoot, files);
  // Root-level files the walker never reaches.
  for (const rel of ["AGENTS.md", "README.md"])
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
// Git helpers. Best-effort: any failure (not a git repo, git missing) degrades
// to a full scan and a null revision rather than crashing.
// ---------------------------------------------------------------------------

async function git(args: string[], repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", args, {
      cwd: repoRoot,
      timeout: 15_000,
      maxBuffer: 2_000_000,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function currentCommit(repoRoot: string): Promise<string | null> {
  const out = await git(["rev-parse", "HEAD"], repoRoot);
  return out ? out.trim() : null;
}

async function changedFilesBetween(
  repoRoot: string,
  from: string,
  to: string,
): Promise<Set<string>> {
  const out = await git(["diff", "--name-only", from, to], repoRoot);
  if (!out) return new Set();
  return new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((p) => p.split("\\").join("/")),
  );
}

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

function persistState(
  stateDir: string,
  result: SyncResult,
): void {
  mkdirSync(stateDir, { recursive: true });
  const { commit, meta } = statePaths(stateDir);
  if (result.lastSyncCommit)
    writeFileSync(commit, result.lastSyncCommit + "\n", "utf8");
  writeFileSync(meta, JSON.stringify(result, null, 2), "utf8");
}

export function readSyncStatus(
  repoRoot: string,
  stateDir: string = reviewStateDir(repoRoot),
): { lastSyncCommit: string | null; lastSyncAt: string | null; stats: SyncStats | null } {
  const { commit, meta } = statePaths(stateDir);
  const lastSyncCommit = existsSync(commit)
    ? readFileSync(commit, "utf8").trim() || null
    : null;
  if (!existsSync(meta))
    return { lastSyncCommit, lastSyncAt: null, stats: null };
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
      },
    };
  } catch {
    return { lastSyncCommit, lastSyncAt: null, stats: null };
  }
}

// ---------------------------------------------------------------------------
// Core: import one file through store.capture().
// ---------------------------------------------------------------------------

function captureOne(
  store: Store,
  repoRoot: string,
  rel: string,
  category: ReviewCategory,
  gitRevision: string | null,
): "imported" | "updated" | "unchanged" | "skipped" {
  const abs = join(repoRoot, rel);
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch {
    return "skipped";
  }
  // Reject binaries (images, fonts, compiled output, ...).
  if (bytes.includes(0)) return "skipped";
  const text = new TextDecoder("utf-8").decode(bytes);
  if (!text.trim()) return "skipped";

  const digest = createHash("sha256").update(text).digest("hex");
  const sections =
    category === "architecture"
      ? splitCodeFragments(text)
      : splitMarkdownFragments(text);
  // store.capture enforces a 2000-fragment budget; huge files fall back to a
  // single whole-text part rather than throwing.
  let parts: CaptureInput["parts"];
  if (sections.length > 0 && sections.length <= 1500)
    parts = sections.map((section) => ({ type: "text" as const, text: section }));
  else parts = [{ type: "text" as const, text }];

  const context: Record<string, unknown> = { category, filePath: rel };
  if (category === "architecture") {
    if (gitRevision) context.gitRevision = gitRevision;
    context.symbols = extractSymbols(text);
  }
  if (category === "decisions") {
    try {
      context.reviewDate = new Date(statSync(abs).mtime).toISOString().slice(0, 10);
    } catch {
      /* leave reviewDate absent */
    }
  }

  const result = store.capture({
    source: "file",
    externalId: digest,
    title: rel,
    parts,
    context: context as unknown as CaptureInput["context"],
  });
  if (result.duplicate) return "unchanged";
  return result.revision.version > 1 ? "updated" : "imported";
}

/** Run the incremental review sync. First run (or when no git baseline exists)
 * imports every candidate file; later runs only re-examine files that changed
 * between the recorded commit and HEAD. */
export async function runReviewSync(
  store: Store,
  repoRoot: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const stateDir = options.stateDir ?? reviewStateDir(repoRoot);
  const stats: SyncStats = {
    totalScanned: 0,
    imported: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };

  let targets: { rel: string; category: ReviewCategory }[];
  if (options.only?.length) {
    targets = options.only
      .map((rel) => {
        const normalized = rel.split("\\").join("/");
        return { rel: normalized, category: classify(normalized) };
      })
      .filter(
        (t): t is { rel: string; category: ReviewCategory } => t.category !== null,
      );
  } else {
    const current = await currentCommit(repoRoot);
    const baseline = readLastCommit(stateDir);
    const all = collectCandidates(repoRoot);
    if (baseline && current && baseline !== current) {
      const changed = await changedFilesBetween(repoRoot, baseline, current);
      targets = all.filter((t) => changed.has(t.rel));
    } else {
      targets = all;
    }
  }

  const gitRevision = options.only
    ? null
    : await currentCommit(repoRoot);

  for (const target of targets) {
    stats.totalScanned++;
    switch (captureOne(store, repoRoot, target.rel, target.category, gitRevision)) {
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
    }
  }

  const result: SyncResult = {
    ...stats,
    lastSyncCommit: options.only ? null : await currentCommit(repoRoot),
    lastSyncAt: new Date().toISOString(),
  };
  if (!options.only) persistState(stateDir, result);
  return result;
}
