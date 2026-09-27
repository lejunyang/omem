/** repo-review is a code-review-only knowledge base that shares omem's Store,
 * capture and retrieval primitives but points at an isolated data directory. It
 * never touches the personal workspace SQLite/state, runs no Lark/learning workers,
 * and never reads secrets. */
import { join } from "node:path";
import { Store } from "../store.js";

/** Relative (POSIX) directory, inside the repo, that holds both the SQLite/assets
 * and the sync state files. It is gitignored end-to-end. */
export const REVIEW_DIR = ".repo-review";

export function reviewDataDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR, "data");
}

export function reviewStateDir(repoRoot: string): string {
  return join(repoRoot, REVIEW_DIR);
}

/** Build a Store bound to `.repo-review/data`: its own omem.sqlite and assets dir,
 * fully separate from the personal workspace under `.omem/`. */
export function createReviewStore(repoRoot: string): Store {
  return new Store(reviewDataDir(repoRoot));
}
