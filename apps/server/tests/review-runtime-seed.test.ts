import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import {
  ensureReviewRuntimeSeeded,
  reviewDataDir,
  reviewStateDir,
} from "../src/review/store.js";

const roots: string[] = [];
function makeRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "omem-review-seed-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function sha(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/** Build a legacy tracked snapshot: a populated Store at .repo-review/data plus
 * sync-state files at .repo-review/. Returns the row counts captured. */
function buildLegacy(repoRoot: string): { sources: number; fragments: number } {
  const dataDir = join(repoRoot, ".repo-review", "data");
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  // Seed one source + revision + fragment directly so the backup carries real
  // rows (schema created by Store migrations).
  store.db
    .prepare("INSERT INTO sources(id,namespace,external_id,head) VALUES(?,?,?,?)")
    .run("src-1", "file", "omem:README.md", "rev-1");
  store.db
    .prepare(
      "INSERT INTO revisions(id,source_id,version,title,body,fingerprint,previous_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "rev-1",
      "src-1",
      1,
      "README",
      JSON.stringify({ context: { filePath: "README.md" } }),
      "fp-1",
      null,
      "2026-09-01T00:00:00.000Z",
    );
  store.db
    .prepare("INSERT INTO fragments(id,revision_id,ordinal,text) VALUES(?,?,?,?)")
    .run("frag-1", "rev-1", 0, "hello legacy world");
  const sources = Number(
    (store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n,
  );
  const fragments = Number(
    (store.db.prepare("SELECT COUNT(*) AS n FROM fragments").get() as { n: number }).n,
  );
  store.close();
  // Legacy state files.
  writeFileSync(join(repoRoot, ".repo-review", "last-sync.txt"), "abc123\n", "utf8");
  writeFileSync(
    join(repoRoot, ".repo-review", "last-sync.json"),
    JSON.stringify({ commit: "abc123", dirty: false }),
    "utf8",
  );
  writeFileSync(
    join(repoRoot, ".repo-review", "migrated-v2.flag"),
    "2026-09-01T00:00:00.000Z\n",
    "utf8",
  );
  return { sources, fragments };
}

function count(dbPath: string, table: string): number {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    );
  } finally {
    d.close();
  }
}

describe("ensureReviewRuntimeSeeded", () => {
  it("backs up the legacy DB and projects state on first boot, leaving legacy untouched", () => {
    const repoRoot = makeRepoRoot();
    const legacy = buildLegacy(repoRoot);
    const legacyDb = join(repoRoot, ".repo-review", "data", "omem.sqlite");
    const legacyHashBefore = sha(legacyDb);
    const legacyStateBefore = sha(join(repoRoot, ".repo-review", "last-sync.txt"));

    ensureReviewRuntimeSeeded(repoRoot);

    const runtimeDb = join(reviewDataDir(repoRoot), "omem.sqlite");
    expect(existsSync(runtimeDb)).toBe(true);
    // Row counts preserved across the consistent backup.
    expect(count(runtimeDb, "sources")).toBe(legacy.sources);
    expect(count(runtimeDb, "fragments")).toBe(legacy.fragments);
    // State projection.
    expect(readFileSync(join(reviewStateDir(repoRoot), "last-sync.txt"), "utf8")).toBe(
      "abc123\n",
    );
    expect(
      existsSync(join(reviewStateDir(repoRoot), "migrated-v2.flag")),
    ).toBe(true);
    // Legacy files untouched.
    expect(sha(legacyDb)).toBe(legacyHashBefore);
    expect(sha(join(repoRoot, ".repo-review", "last-sync.txt"))).toBe(
      legacyStateBefore,
    );
  });

  it("is idempotent: a second call does not overwrite the runtime or touch legacy", () => {
    const repoRoot = makeRepoRoot();
    buildLegacy(repoRoot);
    ensureReviewRuntimeSeeded(repoRoot);
    const runtimeDb = join(reviewDataDir(repoRoot), "omem.sqlite");
    const firstHash = sha(runtimeDb);

    // Mutate the runtime to prove a second seed does not re-copy.
    const d = new DatabaseSync(runtimeDb);
    d.exec("CREATE TABLE marker(who TEXT)");
    d.prepare("INSERT INTO marker VALUES ('second')").run();
    d.close();

    ensureReviewRuntimeSeeded(repoRoot); // must be a no-op
    const after = new DatabaseSync(runtimeDb, { readOnly: true });
    expect(
      (after.prepare("SELECT COUNT(*) AS n FROM marker").get() as { n: number }).n,
    ).toBe(1);
    after.close();
    expect(sha(runtimeDb)).not.toBe(firstHash); // we did write to it; seed did not reset it
  });

  it("does nothing when there is no legacy snapshot (fresh start)", () => {
    const repoRoot = makeRepoRoot();
    ensureReviewRuntimeSeeded(repoRoot);
    expect(existsSync(join(reviewDataDir(repoRoot), "omem.sqlite"))).toBe(false);
  });

  it("removes a partial destination on failure and leaves legacy intact", () => {
    const repoRoot = makeRepoRoot();
    const dataDir = join(repoRoot, ".repo-review", "data");
    mkdirSync(dataDir, { recursive: true });
    // Corrupt legacy DB: not valid SQLite.
    writeFileSync(join(dataDir, "omem.sqlite"), "this is not sqlite at all", "utf8");
    const before = sha(join(dataDir, "omem.sqlite"));

    expect(() => ensureReviewRuntimeSeeded(repoRoot)).toThrow();
    // Partial runtime removed so next boot can retry.
    expect(existsSync(join(reviewDataDir(repoRoot), "omem.sqlite"))).toBe(false);
    // Legacy untouched.
    expect(sha(join(dataDir, "omem.sqlite"))).toBe(before);
  });
});
