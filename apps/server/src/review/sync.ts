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
  ensureReviewRelationsTable,
  upsertReviewRelation,
  invalidateRemovedSeeds,
  type RelationType,
  type RelationStatus,
} from "./store.js";
import { loadAssociations, parseRef, type AssociationSeed } from "./associations.js";

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
  /** Relation build stats from the human-maintained associations seed, when a
   * full (non-`only`) sync ran. */
  relations?: RelationBuildStats;
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
  // Tests are implementation evidence: split per test case under "architecture".
  if (rel.startsWith("apps/") && rel.endsWith(".ts")) return "architecture";
  if (rel.startsWith("packages/") && rel.endsWith(".ts")) return "architecture";
  if (
    rel.startsWith("apps/web/") &&
    (rel.endsWith(".ts") || rel.endsWith(".vue"))
  )
    return "architecture";
  // High-level architecture: root design system doc and the system design doc.
  if (rel === "design.md" || rel === "docs/design.md") return "architecture";
  if (
    rel === "docs/implementation/status.md" ||
    rel === "AGENTS.md" ||
    rel === "README.md"
  )
    return "progress";
  // All implementation docs are decision records (status.md above stays progress).
  if (rel.startsWith("docs/implementation/") && rel.endsWith(".md"))
    return "decisions";
  if (rel.startsWith("docs/reviews/") && rel.endsWith(".md")) return "decisions";
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

/** Test files split per test case: each `it(`/`test(`/`describe(` opens a new
 * fragment so a failing case can be cited directly. */
const TEST_BOUNDARY = /^\s*(?:it|test|describe)\s*\(\s*["'`]/;

function isTestFile(rel: string): boolean {
  return rel.startsWith("apps/server/tests/") && rel.endsWith(".test.ts");
}

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

/** Parse `git status --porcelain -z` output. With `-z` entries are NUL-separated
 * and paths are emitted verbatim (no C-quoting/escaping), so Chinese / spaces /
 * backslashes survive untouched. Renames consume two NUL fields: "XY old" then
 * the bare new path. */
function parsePorcelain(stdout: string): GitChange[] {
  const out: GitChange[] = [];
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const head = parts[i] ?? "";
    i++;
    if (!head) continue;
    const xy = head.slice(0, 2);
    const rest = head.slice(3);
    if (!rest) continue;
    if (xy.trim().startsWith("R")) {
      // Rename/copy: next field is the destination path.
      const newPath = (parts[i] ?? "").trim();
      if (newPath) i++;
      out.push({
        path: normPath(newPath || rest),
        code: xy.trim(),
        oldPath: normPath(rest),
      });
    } else {
      out.push({ path: normPath(rest), code: xy.trim() });
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

/** Whether the most recent recorded sync ran against a dirty working tree. A
 * dirty sync deliberately does not advance the baseline, so the next run must
 * re-scan to converge the captured revisions back to the real tree. */
function readPrevDirty(stateDir: string): boolean {
  const file = statePaths(stateDir).meta;
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { dirty?: boolean };
    return parsed.dirty === true;
  } catch {
    return false;
  }
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

/** First explicit ISO date (YYYY-MM-DD) written in the decision document, or
 * null when the doc does not state one. Never infers a date from mtime/sync. */
function extractDecisionDate(text: string): string | null {
  const m = text.match(/\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  return m ? m[0] : null;
}

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
      ? isTestFile(rel)
        ? splitByBoundary(text, TEST_BOUNDARY)
        : splitCodeFragments(text)
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
    // The decision date is the explicit date written in the source document,
    // NOT the sync day. syncedAt (set above) records when we ingested it.
    context.decisionDate = extractDecisionDate(text) ?? "unknown";
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
 * pointer on the old source.
 *
 * Virtual derived sources (externalId `omem:repo-review/...`, e.g. the generated
 * intent index) have NO backing file on disk. They must never be treated as
 * deleted; any earlier mis-flag is healed here on every sync. */
const VIRTUAL_SOURCE_PREFIX = "repo-review/";

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
    const sid = String(row.id);
    if (p.startsWith(VIRTUAL_SOURCE_PREFIX)) {
      // Derived, generated at sync time: never removed; heal any prior flag.
      setSourceMeta(store, sid, { removed: false });
      continue;
    }
    const exists = existsSync(join(repoRoot, p));
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
// Relation building: turn the hand-maintained associations seed into
// bidirectional review_relations rows. Word similarity never promotes to
// confirmed; only listed associations create edges, and unresolvable refs are
// recorded as status=missing instead of being silently skipped.
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type LocatedFragment = {
  fragmentId: string;
  revisionId: string;
  text: string;
};

/** Head revision fragments for a path-identified source, or null if never
 * synced. */
function headFragments(
  store: Store,
  path: string,
): { revisionId: string; fragments: { id: string; ordinal: number; text: string }[] } | null {
  const sourceId = sourceIdForExternalId(store, EXTERNAL_ID_PREFIX + path);
  if (!sourceId) return null;
  const revisionId = String(
    (store.db.prepare("SELECT head FROM sources WHERE id=?").get(sourceId) as {
      head: string;
    } | undefined)?.head ?? "",
  );
  if (!revisionId) return null;
  return { revisionId, fragments: store.fragments(revisionId) };
}

/** Earliest head fragment whose text defines `symbol`. Prefers real
 * declaration/method lines over bare token occurrences. */
function matchSymbolFragment(
  fragments: { id: string; ordinal: number; text: string }[],
  symbol: string,
): { id: string; text: string } | null {
  const esc = escapeRegExp(symbol);
  const declRe = new RegExp(
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?` +
      `(?:private\\s+|public\\s+|protected\\s+|readonly\\s+|static\\s+|override\\s+)?` +
      `(?:function|class|const|let|var|enum|interface|type)\\s+${esc}\\b`,
    "m",
  );
  const methodRe = new RegExp(
    `^\\s*(?:private|public|protected|async|readonly|static|override)\\s+${esc}\\s*\\(`,
    "m",
  );
  const tokenRe = new RegExp(`\\b${esc}\\b`);
  const def = fragments.find((f) => declRe.test(f.text) || methodRe.test(f.text));
  if (def) return { id: def.id, text: def.text };
  const any = fragments.find((f) => tokenRe.test(f.text));
  return any ? { id: any.id, text: any.text } : null;
}

/** Resolve a `path` or `path::anchor` ref to a head fragment. No anchor →
 * first fragment. Anchor missing → null (caller records missing). */
function resolveRef(
  store: Store,
  ref: string,
): LocatedFragment | null {
  const { path, anchor } = parseRef(ref);
  const head = headFragments(store, path);
  if (!head) return null;
  if (!anchor) {
    const first = head.fragments[0];
    return first ? { fragmentId: first.id, revisionId: head.revisionId, text: first.text } : null;
  }
  const hit = head.fragments.find((f) => f.text.includes(anchor));
  return hit
    ? { fragmentId: hit.id, revisionId: head.revisionId, text: hit.text }
    : null;
}

/** True when a fragment names `id` as its own heading/list subject (e.g.
 * `## G08 ...`, `- G08 ...`, `**G08** ...`) rather than merely mentioning it
 * inside a shared summary table. This is the precise anchor: without it a
 * G01-G20 table fragment would be bound to every requirement, collapsing the
 * per-requirement relations onto one row. */
/** Requirement-style ids like G08, F3, A12 used to detect a shared overview
 * table that lists many requirements at once. */
const REQUIREMENT_ID = /\b[A-Z]\d{1,3}\b/g;

function fragmentAnchoredTo(text: string, id: string): boolean {
  const esc = escapeRegExp(id);
  // (a) The fragment heading/list actually names this requirement as its subject.
  const headingRe = new RegExp(
    "^\\s*(?:#{1,6}\\s+|[-*]\\s+|\\d+\\.\\s*)?\\*{0,2}" + esc +
      "(?=\\b|\\s|\\*\\*|[：:])",
    "m",
  );
  if (headingRe.test(text)) return true;
  // (b) No heading, but the fragment is dedicated to this single requirement
  // (it is the only requirement id mentioned). A shared G01-G20 overview table
  // lists several ids and is deliberately rejected, so we never bind the whole
  // table to one requirement.
  const ids = text.match(REQUIREMENT_ID);
  const unique = new Set(ids ?? []);
  return unique.size === 1 && unique.has(id);
}

/** The requirement/intent fragment backing an implements relation. Picks the
 * fragment whose heading actually names the requirement id; if the id only
 * appears inside a shared table/overview (no heading anchor), returns null so
 * the relation is recorded as `missing` instead of binding the whole doc. */
function resolveRequirementFragment(
  store: Store,
  reqId: string,
): LocatedFragment | null {
  const docs = [
    "docs/implementation/status.md",
    "docs/implementation/assistant-v3/migration-and-acceptance.md",
  ];
  for (const path of docs) {
    const head = headFragments(store, path);
    if (!head) continue;
    const anchored = head.fragments.find(
      (f) => f.text.includes(reqId) && fragmentAnchoredTo(f.text, reqId),
    );
    if (anchored)
      return { fragmentId: anchored.id, revisionId: head.revisionId, text: anchored.text };
  }
  return null;
}

export type RelationBuildStats = {
  associations: number;
  confirmed: number;
  candidate: number;
  missing: number;
};

/** Virtual source holding one curated intent fragment per association. It is a
 * DERIVED index (curated=true, derived=true), never independent raw evidence:
 * each fragment contains only that seed's intent line + requirement ids, so a
 * code fragment's "implements" target is never the whole G01-G20 status table. */
const INTENT_INDEX_EXTERNAL_ID = "omem:repo-review/intent-index";
const INTENT_INDEX_PATH = "repo-review/intent-index";

/** Stable per-association identity, derived from codePath+symbol. Used both as
 * the anchor text inside the intent fragment and as the seed_identity of every
 * edge this seed produces (so missing rows never collide on empty endpoints). */
function assocSeedId(codePath: string, symbol: string): string {
  return (
    "assoc_" +
    createHash("sha1").update(`${codePath}:${symbol}`).digest("hex").slice(0, 16)
  );
}

/** Build review_relations from the human-maintained seed. Idempotent: repeat
 * syncs reuse deterministic seed_identity ids.
 *
 * Edge shape (code → intent → raw material):
 *   code fragment  ──implements──▶  intent fragment (this seed's own index row)
 *   intent fragment ──requires──▶    requirement doc fragment (one per reqId)
 *   intent fragment ──decided_by──▶ decision doc fragment
 *   intent fragment ──researched_by──▶ research doc fragment
 *   intent fragment ──tested_by──▶  test fragment
 * A seed removed from the JSON is flipped to stale (never silently kept green). */
export function buildReviewRelations(
  store: Store,
  repoRoot: string,
): RelationBuildStats {
  ensureReviewRelationsTable(store);
  const seeds = loadAssociations(repoRoot);
  const stats: RelationBuildStats = {
    associations: seeds.length,
    confirmed: 0,
    candidate: 0,
    missing: 0,
  };
  const tally = (status: string) => {
    if (status === "confirmed") stats.confirmed++;
    else if (status === "candidate") stats.candidate++;
    else if (status === "missing") stats.missing++;
    // "stale" rows are surfaced at read time; not bucketed here.
  };

  // 1) Capture the virtual intent-index source. One part per seed; each part is a
  //    single block (no blank lines inside) so it becomes exactly one fragment.
  const parts: CaptureInput["parts"] = seeds.map((seed) => {
    const aid = assocSeedId(seed.codePath, seed.symbol);
    return {
      type: "text" as const,
      text: [
        `## ${seed.symbol} — ${seed.intent}`,
        `需求: ${seed.requirementRefs.join(", ")}`,
        `代码: ${seed.codePath}`,
        `关联ID: ${aid}`,
      ].join("\n"),
    };
  });
  store.capture({
    source: "file",
    externalId: INTENT_INDEX_EXTERNAL_ID,
    title: "repo-review 实现意图索引",
    parts,
    context: {
      category: "decisions",
      filePath: "docs/repo-review/associations.json",
      curated: true,
      derived: true,
      syncedAt: new Date().toISOString(),
    } as unknown as CaptureInput["context"],
  });

  // 2) Resolve each seed's own intent fragment by its stable 关联ID anchor.
  const intentHead = headFragments(store, INTENT_INDEX_PATH);
  const intentFor = (aid: string): LocatedFragment | null => {
    if (!intentHead) return null;
    const f = intentHead.fragments.find((x) => x.text.includes(`关联ID: ${aid}`));
    return f
      ? { fragmentId: f.id, revisionId: intentHead.revisionId, text: f.text }
      : null;
  };

  const validAssocIds = new Set<string>();
  for (const seed of seeds) {
    const aid = assocSeedId(seed.codePath, seed.symbol);
    validAssocIds.add(aid);
    const intent = intentFor(aid);

    const codeHead = headFragments(store, seed.codePath);
    const codeFrag = codeHead ? matchSymbolFragment(codeHead.fragments, seed.symbol) : null;
    const code: LocatedFragment | null =
      codeHead && codeFrag
        ? { fragmentId: codeFrag.id, revisionId: codeHead.revisionId, text: codeFrag.text }
        : null;

    // code → intent (implements). Missing code OR missing intent is missing.
    upsertReviewRelation(store, {
      seedIdentity: `${aid}#implements`,
      sourceFragmentId: code ? code.fragmentId : "",
      targetFragmentId: intent ? intent.fragmentId : "",
      relationType: "implements",
      status: code && intent ? seed.status : "missing",
      evidence: code
        ? `${seed.intent}｜依据：${seed.evidence}｜需求：${seed.requirementRefs.join(", ")}`
        : `代码未入库或符号未定位：${seed.codePath}::${seed.symbol}`,
      sourceRevisionId: code ? code.revisionId : null,
      targetRevisionId: intent ? intent.revisionId : null,
    });
    tally(code && intent ? seed.status : "missing");

    // Downstream edges originate at the intent fragment.
    if (!intent) continue;
    const edge = (
      refs: string[],
      type: RelationType,
      label: string,
      resolve: (ref: string) => LocatedFragment | null,
      seedKind: string,
    ) => {
      for (const ref of refs) {
        const target = resolve(ref);
        const effective: RelationStatus = target ? seed.status : "missing";
        upsertReviewRelation(store, {
          seedIdentity: `${aid}#${seedKind}#${ref}`,
          sourceFragmentId: intent.fragmentId,
          targetFragmentId: target ? target.fragmentId : "",
          relationType: type,
          status: effective,
          evidence: `${label}：${ref}`,
          sourceRevisionId: intent.revisionId,
          targetRevisionId: target ? target.revisionId : null,
        });
        tally(effective);
      }
    };

    edge(seed.requirementRefs, "requires", "需求", (req) =>
      resolveRequirementFragment(store, req),
      "requires",
    );
    edge(seed.decisionRefs, "decided_by", "决策", (r) => resolveRef(store, r), "decided_by");
    edge(seed.researchRefs, "researched_by", "调研", (r) => resolveRef(store, r), "researched_by");
    edge(seed.testRefs, "tested_by", "测试", (r) => resolveRef(store, r), "tested_by");
  }

  // 3) Seeds removed from the JSON must not keep rendering green.
  invalidateRemovedSeeds(store, validAssocIds);
  return stats;
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
    // If the previous sync ran against a dirty tree we did NOT advance the
    // baseline. Re-running a full scan converges the captured revisions back to
    // whatever the working tree now holds (dirty edits restored, or new commits),
    // instead of pinning the DB to the stale dirty snapshot forever.
    const prevDirty = readPrevDirty(stateDir);

    const changed = new Map<string, GitChange>();
    const renames = new Map<string, string>();
    let fullRescan = false;

    const status = await git(["status", "--porcelain", "-z"], repoRoot);
    if (!status.ok) {
      warnings.push(`git status failed: ${status.error}`);
      fullRescan = true;
      advanceBaseline = false;
    } else {
      const parsed = parsePorcelain(status.stdout);
      // The .repo-review state dir (sqlite + sync state) is created by this very
      // run and must never count as a working-tree change, otherwise every sync
      // looks dirty and the baseline can never advance.
      const isInternal = (rel: string) =>
        rel === ".repo-review" || rel.startsWith(".repo-review/");
      const realChanges = parsed.filter((c) => !isInternal(c.path));
      snapshot.dirty = realChanges.length > 0;
      for (const c of realChanges) {
        // An untracked *directory* (`?? newdir/`) is reported collapsed; expand
        // it to the files inside so new directories are actually captured.
        if (c.code === "??" && c.path.endsWith("/")) {
          const dirAbs = join(repoRoot, c.path.replace(/\/$/, ""));
          if (!isUnsafeLink(dirAbs, repoRoot)) {
            const inside: string[] = [];
            walk(dirAbs, repoRoot, inside);
            for (const f of inside)
              if (!isInternal(f)) changed.set(f, { path: f, code: "??" });
          }
          continue;
        }
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
    } else if (prevDirty) {
      targets = all; // last capture was dirty: re-converge to current tree
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

  // Rebuild relations from the hand-maintained seed after scanning. Skipped for
  // ad-hoc `only` captures (those are partial, fixture-style imports).
  let relations: RelationBuildStats | undefined;
  if (!options.only) {
    try {
      relations = buildReviewRelations(store, repoRoot);
    } catch (e) {
      warnings.push(`relation build failed: ${String(e)}`);
    }
  }

  // Do NOT advance the baseline when the tree was dirty (captured content is
  // the uncommitted working tree, not HEAD) or when any file failed to
  // read/import — otherwise the next sync would skip exactly the files that
  // still need re-capture and permanently pin the DB to a stale/failed state.
  if (!options.only && (snapshot.dirty || failed.length > 0))
    advanceBaseline = false;

  const result: SyncResult = {
    ...stats,
    lastSyncCommit: options.only ? null : snapshot.commit,
    lastSyncAt: new Date().toISOString(),
    dirty: snapshot.dirty,
    failed,
    warnings,
    relations,
  };
  if (!options.only) persistState(stateDir, result, advanceBaseline);
  return result;
}
