/** Human-maintained seed associations between code fragments and the
 * intent / decision / research / test fragments that justify them.
 *
 * This is NOT an automatic semantic matcher: every entry is hand-curated and
 * must cite concrete requirement ids, decision docs, research docs and test
 * cases. The sync step turns each entry into review_relations rows; word-similar
 * hits that are not listed here never become `confirmed` relations.
 *
 * The data itself lives at `<repoRoot>/docs/repo-review/associations.json` so it
 * is plain JSON (readable by the built server without importing TS), while the
 * shape is type-checked here. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RelationStatus } from "./store.js";

export const ASSOCIATIONS_DIR = "docs/repo-review";
export const ASSOCIATIONS_FILE = "associations.json";

/** A ref is a repo-relative path, optionally `path::anchor` where anchor is a
 * substring matched inside the target fragment (a requirement id, a test name,
 * a heading phrase). */
export type AssociationRef = string;

export type AssociationSeed = {
  /** Code file repo-relative path, e.g. apps/server/src/assistant/runtime.ts. */
  codePath: string;
  /** Symbol whose definition line anchors the code fragment. */
  symbol: string;
  /** Free-text statement of the implemented intent. */
  intent: string;
  /** Requirement / acceptance ids (G08, F3, A...). Recorded as labels, not
   * fragment targets. */
  requirementRefs: string[];
  /** Decision doc refs (path or path::anchor). */
  decisionRefs: AssociationRef[];
  /** Research doc refs. */
  researchRefs: AssociationRef[];
  /** Test refs, usually path::"test name". */
  testRefs: AssociationRef[];
  status: RelationStatus;
  /** Why this code implements this intent; stored on the relation as evidence. */
  evidence: string;
};

export type AssociationsFile = {
  version: 1;
  notes?: string;
  associations: AssociationSeed[];
};

export function associationsPath(repoRoot: string): string {
  return join(repoRoot, ASSOCIATIONS_DIR, ASSOCIATIONS_FILE);
}

/** Load and minimally validate the seed associations. Returns an empty list
 * when the file is absent (fresh checkouts / fixtures that supply their own).
 * Throws on malformed JSON so a broken seed never silently drops relations. */
export function loadAssociations(repoRoot: string): AssociationSeed[] {
  const file = associationsPath(repoRoot);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw Error(`Invalid associations JSON at ${file}: ${String(e)}`);
  }
  const root = parsed as Partial<AssociationsFile>;
  if (!root || !Array.isArray(root.associations))
    throw Error(`associations.json must have an "associations" array`);
  const out: AssociationSeed[] = [];
  for (const [i, a] of root.associations.entries()) {
    if (!a || typeof a.codePath !== "string" || typeof a.symbol !== "string")
      throw Error(`associations[${i}] needs codePath and symbol strings`);
    out.push({
      codePath: a.codePath,
      symbol: a.symbol,
      intent: typeof a.intent === "string" ? a.intent : "",
      requirementRefs: Array.isArray(a.requirementRefs) ? a.requirementRefs : [],
      decisionRefs: Array.isArray(a.decisionRefs) ? a.decisionRefs : [],
      researchRefs: Array.isArray(a.researchRefs) ? a.researchRefs : [],
      testRefs: Array.isArray(a.testRefs) ? a.testRefs : [],
      status:
        a.status === "candidate" || a.status === "missing"
          ? a.status
          : "confirmed",
      evidence: typeof a.evidence === "string" ? a.evidence : "",
    });
  }
  return out;
}

/** Split "path::anchor" into its parts. */
export function parseRef(ref: AssociationRef): {
  path: string;
  anchor: string | null;
} {
  const idx = ref.indexOf("::");
  if (idx < 0) return { path: ref, anchor: null };
  return { path: ref.slice(0, idx), anchor: ref.slice(idx + 2) };
}
