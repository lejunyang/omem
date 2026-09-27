import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TARGET = "apps/server/src/assistant/runtime.ts";

const stores: { store: Store; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-review-sync-"));
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function headRow(store: Store, filePath: string) {
  return store.db
    .prepare(
      `SELECT r.id AS revisionId, r.version,
              json_extract(r.body,'$.context') AS context
       FROM sources s JOIN revisions r ON s.head = r.id
       WHERE json_extract(r.body,'$.context.filePath') = ?`,
    )
    .get(filePath) as
    | { revisionId: string; version: number; context: string }
    | undefined;
}

function revisionCountFor(store: Store, filePath: string): number {
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM revisions r
       JOIN sources s ON s.id = r.source_id
       WHERE s.id = (
         SELECT s2.id FROM sources s2
         JOIN revisions r2 ON s2.head = r2.id
         WHERE json_extract(r2.body,'$.context.filePath') = ?
       )`,
    )
    .get(filePath) as { n: number };
  return Number(row.n);
}

describe("repo-review incremental sync", () => {
  it("imports a code file as an architecture source with fragments, is idempotent, and is searchable", async () => {
    const store = setup();

    const first = await runReviewSync(store, repoRoot, { only: [TARGET] });
    expect(first.totalScanned).toBe(1);
    expect(first.imported).toBe(1);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);

    const head = headRow(store, TARGET);
    expect(head).toBeDefined();
    expect(head!.version).toBe(1);
    const context = JSON.parse(head!.context) as {
      category: string;
      filePath: string;
      symbols: string[];
    };
    expect(context.category).toBe("architecture");
    expect(context.filePath).toBe(TARGET);
    expect(Array.isArray(context.symbols)).toBe(true);

    const revision = store.revision(head!.revisionId)!;
    expect(revision.fragments.length).toBeGreaterThan(0);

    // Second run against the same content: everything is a duplicate, no new
    // revision is created.
    const revisionsAfterFirst = revisionCountFor(store, TARGET);
    const second = await runReviewSync(store, repoRoot, { only: [TARGET] });
    expect(second.unchanged).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);
    expect(revisionCountFor(store, TARGET)).toBe(revisionsAfterFirst);

    // Keyword retrieval can find the imported material.
    const retrieval = new KeywordRetrieval(store.db);
    const hits = retrieval.searchSources({
      text: "ModelUnavailableError",
      limit: 10,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.fragmentId)).toBe(true);
  });
});
