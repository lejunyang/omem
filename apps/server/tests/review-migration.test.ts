import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import type { CaptureInput } from "../../packages/contracts/src/index.js";
import {
  migrateLegacySources,
  sourceIdForExternalId,
  getSourceMeta,
  ensureReviewRelationsTable,
  upsertReviewRelation,
  relationsForFragment,
  relationsForCodePath,
  invalidateStaleRelations,
} from "../src/review/store.js";

const stores: { store: Store; dir: string }[] = [];
function setup(dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "omem-review-mig-"));
  const store = new Store(d);
  stores.push({ store, dir: d });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Hand-build a legacy content-hash source: one source row, one head revision
 * (with context.filePath) and one fragment. Mirrors the pre-path-identity era. */
function insertLegacySource(
  store: Store,
  opts: {
    externalId: string;
    filePath: string;
    version: number;
    createdAt: string;
    fragmentText: string;
  },
): { sourceId: string; revisionId: string; fragmentId: string } {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const fragmentId = randomUUID();
  const body = JSON.stringify({
    parts: [{ type: "text", text: opts.fragmentText }],
    context: {
      filePath: opts.filePath,
      category: "architecture",
      contentHash: opts.externalId,
    },
  });
  store.db
    .prepare("INSERT INTO sources VALUES(?,?,?,?)")
    .run(sourceId, "file", opts.externalId, revisionId);
  store.db
    .prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)")
    .run(
      revisionId,
      sourceId,
      opts.version,
      opts.filePath,
      body,
      "fp-" + opts.externalId,
      null,
      opts.createdAt,
    );
  store.db
    .prepare("INSERT INTO fragments VALUES(?,?,?,?)")
    .run(fragmentId, revisionId, 0, opts.fragmentText);
  return { sourceId, revisionId, fragmentId };
}

function fragmentCount(store: Store): number {
  return Number(
    (store.db.prepare("SELECT COUNT(*) AS n FROM fragments").get() as {
      n: number;
    }).n,
  );
}

function currentSourceExternalIds(store: Store): string[] {
  return (
    store.db
      .prepare(
        `SELECT s.external_id AS ext FROM sources s
         JOIN revisions r ON s.head = r.id WHERE s.namespace='file'`,
      )
      .all() as { ext: string }[]
  ).map((r) => r.ext);
}

function headOf(store: Store, sourceId: string): string | null {
  return (
    store.db.prepare("SELECT head FROM sources WHERE id=?").get(sourceId) as {
      head: string | null;
    } | undefined
  )?.head ?? null;
}

describe("migrateLegacySources: collision handling", () => {
  it("1. same path: newest old-hash source becomes the path head, the rest demoted to aliases", () => {
    const store = setup();
    const stateDir = mkdtempSync(join(tmpdir(), "omem-review-migstate-"));
    const loser = insertLegacySource(store, {
      externalId: "hashAAAA1111",
      filePath: "apps/server/src/same.ts",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      fragmentText: "OLD_FRAGMENT_AAA",
    });
    const winner = insertLegacySource(store, {
      externalId: "hashBBBB2222",
      filePath: "apps/server/src/same.ts",
      version: 2,
      createdAt: "2024-06-01T00:00:00.000Z",
      fragmentText: "NEW_FRAGMENT_BBB",
    });
    const beforeFragments = fragmentCount(store);

    const moved = migrateLegacySources(store, stateDir);
    expect(moved).toBe(1);

    // The newest source owns the path identity.
    const pathId = "omem:apps/server/src/same.ts";
    expect(sourceIdForExternalId(store, pathId)).toBe(winner.sourceId);
    expect(sourceIdForExternalId(store, "hashBBBB2222")).toBeNull();
    // The loser keeps its old external id but is detached from current browsing.
    expect(sourceIdForExternalId(store, "hashAAAA1111")).toBe(loser.sourceId);
    expect(headOf(store, loser.sourceId)).toBeNull();
    // Winner still has its head revision live.
    expect(headOf(store, winner.sourceId)).toBe(winner.revisionId);

    // Loser is recorded as a historical alias.
    expect(getSourceMeta(store, loser.sourceId).legacyAliasOf).toBe(pathId);
    expect(getSourceMeta(store, winner.sourceId).legacyAliasOf).toBeNull();

    // Exactly one current source for this path.
    const current = currentSourceExternalIds(store);
    expect(current.filter((e) => e === pathId).length).toBe(1);
    expect(current).not.toContain("hashAAAA1111");

    // Nothing was deleted.
    expect(fragmentCount(store)).toBe(beforeFragments);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("2. identical content at different paths stays two independent current sources", () => {
    const store = setup();
    const stateDir = mkdtempSync(join(tmpdir(), "omem-review-migstate-"));
    insertLegacySource(store, {
      externalId: "hashCCCC3333",
      filePath: "apps/server/src/one.ts",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      fragmentText: "SHARED_BODY",
    });
    insertLegacySource(store, {
      externalId: "hashDDDD4444",
      filePath: "apps/server/src/two.ts",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      fragmentText: "SHARED_BODY",
    });

    migrateLegacySources(store, stateDir);

    const a = sourceIdForExternalId(store, "omem:apps/server/src/one.ts");
    const b = sourceIdForExternalId(store, "omem:apps/server/src/two.ts");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    // Neither is demoted: each path has its own current head.
    expect(headOf(store, a!)).not.toBeNull();
    expect(headOf(store, b!)).not.toBeNull();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("3. demoted legacy source stays readable via its old external id", () => {
    const store = setup();
    const stateDir = mkdtempSync(join(tmpdir(), "omem-review-migstate-"));
    const loser = insertLegacySource(store, {
      externalId: "hashEEEE5555",
      filePath: "apps/server/src/hist.ts",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      fragmentText: "HISTORIC_FRAGMENT_ZZZ",
    });
    insertLegacySource(store, {
      externalId: "hashFFFF6666",
      filePath: "apps/server/src/hist.ts",
      version: 2,
      createdAt: "2024-06-01T00:00:00.000Z",
      fragmentText: "HISTORIC_FRAGMENT_WWW",
    });

    migrateLegacySources(store, stateDir);

    // Resolved by old external id, and its revision/fragment rows are intact.
    const sid = sourceIdForExternalId(store, "hashEEEE5555");
    expect(sid).toBe(loser.sourceId);
    const revision = store.revision(loser.revisionId);
    expect(revision).not.toBeNull();
    expect(revision!.current).toBe(false); // detached from head, but readable
    expect(revision!.fragments.some((f) => f.id === loser.fragmentId)).toBe(true);
    expect(store.history(loser.sourceId).length).toBe(1);
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("4. idempotent: a second migration run changes nothing", () => {
    const store = setup();
    const stateDir = mkdtempSync(join(tmpdir(), "omem-review-migstate-"));
    const loser = insertLegacySource(store, {
      externalId: "hashGGGG7777",
      filePath: "apps/server/src/idem.ts",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      fragmentText: "IDEM_OLD",
    });
    const winner = insertLegacySource(store, {
      externalId: "hashHHHH8888",
      filePath: "apps/server/src/idem.ts",
      version: 2,
      createdAt: "2024-06-01T00:00:00.000Z",
      fragmentText: "IDEM_NEW",
    });

    migrateLegacySources(store, stateDir);
    const snapshot = () =>
      store.db
        .prepare(
          `SELECT s.external_id AS ext, s.head AS head,
                  (SELECT legacy_alias_of FROM review_source_meta WHERE source_id=s.id) AS alias
           FROM sources s WHERE s.namespace='file' ORDER BY s.external_id`,
        )
        .all() as { ext: string; head: string | null; alias: string | null }[];
    const before = snapshot();

    const second = migrateLegacySources(store, stateDir);
    expect(second).toBe(0);
    const after = snapshot();
    expect(after).toEqual(before);

    // Sanity: first run really did settle into the expected state.
    expect(sourceIdForExternalId(store, "omem:apps/server/src/idem.ts")).toBe(
      winner.sourceId,
    );
    expect(headOf(store, loser.sourceId)).toBeNull();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("5. never deletes data: fragment total is unchanged", () => {
    const store = setup();
    const stateDir = mkdtempSync(join(tmpdir(), "omem-review-migstate-"));
    insertLegacySource(store, {
      externalId: "hashIIII9999",
      filePath: "apps/server/src/keep.ts",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      fragmentText: "KEEP_ONE",
    });
    insertLegacySource(store, {
      externalId: "hashJJJJ0000",
      filePath: "apps/server/src/keep.ts",
      version: 2,
      createdAt: "2024-02-01T00:00:00.000Z",
      fragmentText: "KEEP_TWO",
    });
    const before = fragmentCount(store);

    migrateLegacySources(store, stateDir);
    expect(fragmentCount(store)).toBe(before);
    rmSync(stateDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Relation lifecycle: head bumps demote old relations to stale.
// ---------------------------------------------------------------------------

function captureText(
  store: Store,
  externalId: string,
  filePath: string,
  text: string,
) {
  return store.capture({
    source: "file",
    externalId,
    title: filePath,
    parts: [{ type: "text", text }],
    context: { filePath, category: "architecture" },
  } as unknown as CaptureInput);
}

describe("relation lifecycle: invalidateStaleRelations", () => {
  it("marks relations against superseded fragments stale; default view hides them", () => {
    const store = setup();
    // Code source advances from v1 -> v2.
    const v1 = captureText(
      store,
      "omem:apps/server/src/code.ts",
      "apps/server/src/code.ts",
      "CODE_V1",
    );
    const v2 = captureText(
      store,
      "omem:apps/server/src/code.ts",
      "apps/server/src/code.ts",
      "CODE_V2_CHANGED",
    );
    // A decision target, still current.
    const dec = captureText(
      store,
      "omem:docs/reviews/d.md",
      "docs/reviews/d.md",
      "DECISION_BODY",
    );
    ensureReviewRelationsTable(store);
    const oldCodeFrag = v1.revision.fragments[0]!;
    const decFrag = dec.revision.fragments[0]!;

    upsertReviewRelation(store, {
      seedIdentity: "test-oldcode#implements",
      sourceFragmentId: oldCodeFrag.id,
      targetFragmentId: decFrag.id,
      relationType: "implements",
      status: "confirmed",
      sourceRevisionId: v1.revision.id,
      targetRevisionId: dec.revision.id,
    });

    // Before invalidation the old relation still looks live.
    const live = relationsForFragment(store, oldCodeFrag.id);
    expect(live.length).toBe(1);
    expect(live[0]!.relationStatus).toBe("confirmed");
    expect(live[0]!.otherCurrent).toBe(true);

    // Code source advanced; invalidate relations for that source.
    const n = invalidateStaleRelations(store, "omem:apps/server/src/code.ts");
    expect(n).toBe(1);

    // Default view hides the now-stale relation; includeStale keeps it, flagged.
    expect(relationsForFragment(store, oldCodeFrag.id).length).toBe(0);
    const withStale = relationsForFragment(store, oldCodeFrag.id, {
      includeStale: true,
    });
    expect(withStale.length).toBe(1);
    expect(withStale[0]!.relationStatus).toBe("stale");

    // Removed raw context cannot be restored via the code path. The old locator
    // remains a tombstone, and never changes to the new fragment.
    expect(
      relationsForCodePath(store, "apps/server/src/code.ts").length,
    ).toBe(0);
    expect(
      relationsForCodePath(store, "apps/server/src/code.ts", {
        includeHistorical: true,
        includeStale: true,
      }).length,
    ).toBe(0);
    expect(store.evidence(oldCodeFrag.id)).toBeNull();
    expect(store.retention.fragmentAvailability(oldCodeFrag.id)?.available).toBe(false);

    // v2 head exists and is the current one.
    expect(v2.revision.version).toBe(2);
    expect(v2.revision.current).toBe(true);
  });
});
