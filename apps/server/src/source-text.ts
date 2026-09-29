import type { Store } from "./store.js";

/** Exact text from a fixed Capture revision. Legacy lossy captures are explicit
 * misses; never reconstruct evidence by reading the current working tree. */
export function revisionText(store: Store, revisionId: string): string | null {
  const row = store.db.prepare("SELECT body FROM revisions WHERE id=?").get(revisionId) as { body: string } | undefined;
  if (!row) return null;
  const body = JSON.parse(row.body);
  if (body.context?.captureFormat !== "verbatim-v1") return null;
  return body.parts.filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("");
}
