import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { runReviewSync, readSyncStatus } from "../src/review/sync.js";
import { removedSourceIds } from "../src/review/store.js";
import { buildReviewApp } from "../src/review/app.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";

const realRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TARGET = "apps/server/src/assistant/runtime.ts";

const stores: { store: Store; dir: string }[] = [];
function setup(dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "omem-review-sync-"));
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

// ---------------------------------------------------------------------------
// Temp git fixture helpers.
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omem-review-git-"));
  git(["init", "-q", root], root);
  git(["config", "user.email", "t@example.com"], root);
  git(["config", "user.name", "tester"], root);
  git(["config", "commit.gpgsign", "false"], root);
  return root;
}

function writeFile(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function commitAll(root: string, message: string) {
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", message], root);
}

function headCommit(root: string): string {
  return git(["rev-parse", "HEAD"], root).trim();
}

function archFile(root: string, name: string, body: string) {
  writeFile(
    root,
    `apps/server/src/${name}.ts`,
    `export const ${name} = ${JSON.stringify(body)};\n`,
  );
}

function decisionsFile(root: string, name: string, body: string) {
  writeFile(root, `docs/reviews/${name}.md`, `# ${name}\n\n${body}\n`);
}

function sourceRow(store: Store, extId: string) {
  return store.db
    .prepare(
      "SELECT id, external_id AS ext FROM sources WHERE namespace='file' AND external_id=?",
    )
    .get(extId) as { id: string; ext: string } | undefined;
}

function revisionsFor(store: Store, sourceId: string) {
  return store.db
    .prepare(
      `SELECT r.id, r.version, (s.head=r.id) AS current,
              json_extract(r.body,'$.context.contentHash') AS contentHash
       FROM revisions r JOIN sources s ON s.id=r.source_id
       WHERE r.source_id=? ORDER BY r.version`,
    )
    .all(sourceId) as {
    id: string;
    version: number;
    current: number;
    contentHash: string;
  }[];
}

function search(store: Store, text: string, limit = 50) {
  return new KeywordRetrieval(store.db).searchSources({ text, limit });
}

// ---------------------------------------------------------------------------
// Existing behavior: the real repo, explicit `only` capture.
// ---------------------------------------------------------------------------

describe("repo-review explicit-only capture (existing behavior)", () => {
  it("imports a code file, is idempotent, and is searchable", async () => {
    const store = setup();
    const first = await runReviewSync(store, realRepoRoot, { only: [TARGET] });
    expect(first.totalScanned).toBe(1);
    expect(first.imported).toBe(1);

    const before = revisionsFor(
      store,
      String(sourceRow(store, "omem:" + TARGET)!.id),
    ).length;
    const second = await runReviewSync(store, realRepoRoot, { only: [TARGET] });
    expect(second.unchanged).toBe(1);
    expect(second.imported).toBe(0);
    expect(
      revisionsFor(store, String(sourceRow(store, "omem:" + TARGET)!.id)).length,
    ).toBe(before);

    const hits = search(store, "ModelUnavailableError", 10);
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Group 1: stable source identity + revision history.
// ---------------------------------------------------------------------------

describe("group 1: source identity and revisions", () => {
  it("keeps two files with identical content as independent sources", async () => {
    const root = makeFixtureRepo();
    archFile(root, "one", "SHARED_BODY_ALPHA");
    archFile(root, "two", "SHARED_BODY_ALPHA");
    commitAll(root, "init");
    const store = setup();

    const res = await runReviewSync(store, root);
    expect(res.imported).toBe(2);
    const a = sourceRow(store, "omem:apps/server/src/one.ts");
    const b = sourceRow(store, "omem:apps/server/src/two.ts");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.id).not.toBe(b!.id);
    rmSync(root, { recursive: true, force: true });
  });

  it("appends a revision on content change; old revision current=false and not default-recalled", async () => {
    const root = makeFixtureRepo();
    archFile(root, "live", "VERSION_ONE_TOKEN_XYZ");
    commitAll(root, "v1");
    const store = setup();

    await runReviewSync(store, root);
    const src = sourceRow(store, "omem:apps/server/src/live.ts")!;
    expect(revisionsFor(store, src.id).length).toBe(1);

    archFile(root, "live", "VERSION_TWO_TOKEN_UVW");
    commitAll(root, "v2");
    await runReviewSync(store, root);

    const revs = revisionsFor(store, src.id);
    expect(revs.length).toBe(2);
    expect(revs[1]!.current).toBe(1); // v2 head
    expect(revs[0]!.current).toBe(0); // v1 historical

    expect(search(store, "VERSION_ONE_TOKEN_XYZ", 20).length).toBe(0);
    expect(search(store, "VERSION_TWO_TOKEN_UVW", 20).length).toBeGreaterThan(0);

    const oldRev = store.revision(revs[0]!.id)!;
    expect(oldRev.current).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("marks a deleted source removed and excludes it from default search", async () => {
    const root = makeFixtureRepo();
    archFile(root, "doomed", "DOOMED_TOKEN");
    archFile(root, "kept", "KEPT_TOKEN");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const doomed = sourceRow(store, "omem:apps/server/src/doomed.ts")!;
    expect(search(store, "DOOMED_TOKEN", 20).length).toBeGreaterThan(0);

    rmSync(join(root, "apps", "server", "src", "doomed.ts"));
    commitAll(root, "remove doomed");
    await runReviewSync(store, root);

    expect(removedSourceIds(store).has(doomed.id)).toBe(true);

    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" };
    const def = await app.inject({ method: "GET", url: "/api/review/search?q=DOOMED_TOKEN", headers: hdr });
    expect(JSON.parse(def.body).length).toBe(0);
    const incl = await app.inject({ method: "GET", url: "/api/review/search?q=DOOMED_TOKEN&includeRemoved=true", headers: hdr });
    expect(JSON.parse(incl.body).length).toBeGreaterThan(0);
    const kept = await app.inject({ method: "GET", url: "/api/review/search?q=KEPT_TOKEN", headers: hdr });
    expect(JSON.parse(kept.body).length).toBeGreaterThan(0);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("repeat sync with no changes adds zero revisions", async () => {
    const root = makeFixtureRepo();
    archFile(root, "stable", "STABLE_TOKEN");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const src = sourceRow(store, "omem:apps/server/src/stable.ts")!;
    const before = revisionsFor(store, src.id).length;

    const second = await runReviewSync(store, root);
    expect(second.unchanged + second.imported + second.updated).toBe(0);
    expect(revisionsFor(store, src.id).length).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Group 2: incremental / snapshot reliability.
// ---------------------------------------------------------------------------

describe("group 2: incremental and snapshot reliability", () => {
  it("clean worktree at baseline==HEAD scans nothing", async () => {
    const root = makeFixtureRepo();
    archFile(root, "c", "CLEAN_TOKEN");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const second = await runReviewSync(store, root);
    expect(second.totalScanned).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("scans both modified tracked and new untracked files on a dirty tree", async () => {
    const root = makeFixtureRepo();
    archFile(root, "tracked", "ORIGINAL_TRACKED");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);

    archFile(root, "tracked", "MODIFIED_TRACKED_DIRTY");
    archFile(root, "untracked", "NEW_UNTRACKED_FILE");
    const res = await runReviewSync(store, root);

    expect(search(store, "MODIFIED_TRACKED_DIRTY", 20).length).toBeGreaterThan(0);
    expect(search(store, "NEW_UNTRACKED_FILE", 20).length).toBeGreaterThan(0);
    expect(res.dirty).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("covers committed drift AND current dirty files when baseline!=HEAD", async () => {
    const root = makeFixtureRepo();
    archFile(root, "committed", "BASE_COMMITTED");
    commitAll(root, "c1");
    const store = setup();
    await runReviewSync(store, root); // baseline = c1

    archFile(root, "committed", "NEW_COMMITTED_VALUE");
    commitAll(root, "c2");
    archFile(root, "dirtyfile", "UNCOMMITTED_DIRTY");
    await runReviewSync(store, root);

    expect(search(store, "NEW_COMMITTED_VALUE", 20).length).toBeGreaterThan(0);
    expect(search(store, "UNCOMMITTED_DIRTY", 20).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("records real commit + dirty + contentHash in the snapshot context", async () => {
    const root = makeFixtureRepo();
    archFile(root, "snap", "SNAP_TOKEN");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const row = store.db
      .prepare(
        `SELECT r.body AS body FROM sources s JOIN revisions r ON s.head=r.id
         WHERE s.external_id=?`,
      )
      .get("omem:apps/server/src/snap.ts") as { body: string };
    const ctx = JSON.parse(row.body).context as {
      gitCommit: string;
      dirty: boolean;
      contentHash: string;
      syncedAt: string;
    };
    expect(ctx.gitCommit).toBe(headCommit(root));
    expect(typeof ctx.dirty).toBe("boolean");
    expect(ctx.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.syncedAt).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  });

  it("treats a missing baseline commit as a full rescan, not a silent skip", async () => {
    const root = makeFixtureRepo();
    archFile(root, "a", "A_TOKEN");
    commitAll(root, "init");
    const stateDir = mkdtempSync(join(tmpdir(), "omem-review-state-"));
    writeFileSync(join(stateDir, "last-sync.txt"), "deadbeef".repeat(10) + "\n", "utf8");
    const store = setup();
    const res = await runReviewSync(store, root, { stateDir });
    expect(res.imported).toBe(1);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(search(store, "A_TOKEN", 10).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("non-UTF-8 file is marked failed without crashing the sync", async () => {
    const root = makeFixtureRepo();
    archFile(root, "ok", "OK_TOKEN");
    mkdirSync(join(root, "apps", "server", "src"), { recursive: true });
    writeFileSync(
      join(root, "apps", "server", "src", "binary.ts"),
      Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    );
    commitAll(root, "init");
    const store = setup();
    const res = await runReviewSync(store, root);
    expect(res.failed.some((f) => f.path.includes("binary.ts"))).toBe(true);
    expect(search(store, "OK_TOKEN", 10).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not follow a symlink out of the whitelist", async () => {
    const root = makeFixtureRepo();
    archFile(root, "real", "REAL_TOKEN");
    const outside = mkdtempSync(join(tmpdir(), "omem-review-out-"));
    writeFileSync(join(outside, "leak.ts"), "export const LEAKED_TOKEN = 1;\n");
    let made = false;
    try {
      symlinkSync(outside, join(root, "apps", "linked"), "junction");
      made = true;
    } catch {
      try {
        symlinkSync(outside, join(root, "apps", "linked"), "dir");
        made = true;
      } catch {
        made = false;
      }
    }
    const store = setup();
    await runReviewSync(store, root);
    if (made) expect(search(store, "LEAKED_TOKEN", 20).length).toBe(0);
    expect(search(store, "REAL_TOKEN", 10).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Group 4: retrieval / API safety.
// ---------------------------------------------------------------------------

describe("group 4: retrieval and API safety", () => {
  it("category filter still returns results when other categories dominate the top-N", async () => {
    const root = makeFixtureRepo();
    for (let i = 0; i < 22; i++) archFile(root, `arch${i}`, "SHARED_Q");
    decisionsFile(root, "my-decision", "decided SHARED_Q approach");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);

    const all = search(store, "SHARED_Q", 100);
    expect(all.length).toBeGreaterThanOrEqual(22);

    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/review/search?q=SHARED_Q&category=decisions",
      headers: { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { category: string }[];
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((r) => r.category === "decisions")).toBe(true);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a cross-origin POST /sync when no token is set", async () => {
    const root = makeFixtureRepo();
    archFile(root, "x", "X_TOKEN");
    commitAll(root, "init");
    const store = setup();
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const bad = await app.inject({
      method: "POST",
      url: "/api/review/sync",
      headers: { host: "127.0.0.1:5180", origin: "http://evil.example.com" },
    });
    expect(bad.statusCode).toBe(403);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("health never exposes an absolute dataDir", async () => {
    const root = makeFixtureRepo();
    archFile(root, "y", "Y_TOKEN");
    commitAll(root, "init");
    const store = setup();
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/review/health",
      headers: { host: "127.0.0.1:5180" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { dataDir: string };
    expect(body.dataDir).toBe(".repo-review/runtime/data");
    expect(body.dataDir).not.toContain(":");
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("versions endpoint lists every revision with current flags", async () => {
    const root = makeFixtureRepo();
    archFile(root, "hist", "HIST_ONE");
    commitAll(root, "v1");
    const store = setup();
    await runReviewSync(store, root);
    const src = sourceRow(store, "omem:apps/server/src/hist.ts")!;
    archFile(root, "hist", "HIST_TWO");
    commitAll(root, "v2");
    await runReviewSync(store, root);

    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: `/api/review/sources/${src.id}/versions`,
      headers: { host: "127.0.0.1:5180" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: number; current: boolean; contentHash: string }[];
    expect(body.length).toBe(2);
    expect(body.find((v) => v.version === 2)!.current).toBe(true);
    expect(body.find((v) => v.version === 1)!.current).toBe(false);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Group 5: retrieval pre-filtering + sync reliability (Group A fixes).
// ---------------------------------------------------------------------------

describe("group 5: pre-filtering and sync reliability", () => {
  it("category filter returns the lone decision hit even when >200 architecture hits dominate", async () => {
    const root = makeFixtureRepo();
    for (let i = 0; i < 250; i++) archFile(root, `arch${i}`, "SHARED_Q");
    decisionsFile(root, "the-decision", "decided SHARED_Q approach");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);

    // The raw keyword pool is capped (per-term LIMIT 200 / top-N), so the lone
    // decision row is buried beneath the 250 architecture rows.
    const raw = search(store, "SHARED_Q", 200);
    expect(raw.length).toBeLessThanOrEqual(200);

    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/api/review/search?q=SHARED_Q&category=decisions",
      headers: { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { category: string; filePath: string }[];
    expect(body.length).toBe(1);
    expect(body[0]!.category).toBe("decisions");
    expect(body[0]!.filePath).toBe("docs/reviews/the-decision.md");
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("untracked files with non-ASCII paths are not escaped/mangled by git status", async () => {
    const root = makeFixtureRepo();
    archFile(root, "seed", "SEED_TOKEN");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);

    writeFile(root, "apps/server/src/中文组件.ts", "export const zh = ZH_UNIQUE_TOKEN;\n");
    const res = await runReviewSync(store, root);
    expect(res.dirty).toBe(true);
    expect(search(store, "ZH_UNIQUE_TOKEN", 10).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("an untracked directory is expanded to the files inside", async () => {
    const root = makeFixtureRepo();
    archFile(root, "seed", "SEED_TOKEN");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);

    mkdirSync(join(root, "apps/server/src/newdir"), { recursive: true });
    writeFileSync(
      join(root, "apps/server/src/newdir/extra.ts"),
      "export const extra = NEWDIR_TOKEN;\n",
      "utf8",
    );
    await runReviewSync(store, root);
    expect(search(store, "NEWDIR_TOKEN", 10).length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("a dirty sync does not advance the baseline; restoring to HEAD re-scans", async () => {
    const root = makeFixtureRepo();
    archFile(root, "a", "V1_TOKEN");
    commitAll(root, "c1");
    const store = setup();
    await runReviewSync(store, root);
    expect(readSyncStatus(root).lastSyncCommit).toBe(headCommit(root));

    archFile(root, "a", "V2_DIRTY_TOKEN"); // uncommitted
    const dirty = await runReviewSync(store, root);
    expect(dirty.dirty).toBe(true);
    // baseline NOT advanced: still points at c1
    expect(readSyncStatus(root).lastSyncCommit).toBe(headCommit(root));
    expect(search(store, "V2_DIRTY_TOKEN", 10).length).toBeGreaterThan(0);

    git(["restore", "."], root); // clean tree back to V1
    await runReviewSync(store, root);
    expect(search(store, "V1_TOKEN", 10).length).toBeGreaterThan(0);
    expect(search(store, "V2_DIRTY_TOKEN", 10).length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("a failed file does not advance the baseline until it is fixed", async () => {
    const root = makeFixtureRepo();
    archFile(root, "ok", "OK_TOKEN");
    mkdirSync(join(root, "apps/server/src"), { recursive: true });
    writeFileSync(
      join(root, "apps/server/src/bad.ts"),
      Buffer.from([0xff, 0xfe, 0x00, 0x01]),
    );
    commitAll(root, "init");
    const store = setup();
    const res = await runReviewSync(store, root);
    expect(res.failed.some((f) => f.path.includes("bad.ts"))).toBe(true);
    expect(search(store, "OK_TOKEN", 10).length).toBeGreaterThan(0);
    // baseline held back because a file failed
    expect(readSyncStatus(root).lastSyncCommit).toBeNull();

    archFile(root, "bad", "NOW_VALID_TOKEN");
    commitAll(root, "fix");
    const res2 = await runReviewSync(store, root);
    expect(res2.failed.length).toBe(0);
    expect(readSyncStatus(root).lastSyncCommit).toBe(headCommit(root));
    rmSync(root, { recursive: true, force: true });
  });

  it("requirement refs anchor to their own heading fragment, not a shared G01-G20 table", async () => {
    const root = makeFixtureRepo();
    writeFile(
      root,
      "docs/implementation/status.md",
      [
        "# Status",
        "",
        "## Acceptance overview",
        "| ID | Intent |",
        "|----|--------|",
        "| G01 | overview one |",
        "| G08 | overview eight |",
        "| G09 | overview nine |",
        "",
        "## G08",
        "G08 specific intent: alpha-marker.",
        "",
        "## G09",
        "G09 specific intent: beta-marker.",
        "",
      ].join("\n"),
    );
    writeFile(
      root,
      "apps/server/src/demo.ts",
      "export const alphaThing = 1;\nexport const betaThing = 2;\n",
    );
    writeFile(
      root,
      "docs/repo-review/associations.json",
      JSON.stringify({
        version: 1,
        associations: [
          {
            codePath: "apps/server/src/demo.ts",
            symbol: "alphaThing",
            intent: "a",
            requirementRefs: ["G08"],
            decisionRefs: [],
            researchRefs: [],
            testRefs: [],
            status: "confirmed",
            evidence: "e",
          },
          {
            codePath: "apps/server/src/demo.ts",
            symbol: "betaThing",
            intent: "b",
            requirementRefs: ["G09"],
            decisionRefs: [],
            researchRefs: [],
            testRefs: [],
            status: "confirmed",
            evidence: "e",
          },
        ],
      }),
    );
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);

    const texts = (
      store.db
        .prepare(
          `SELECT f.text AS t FROM review_relations r
           JOIN fragments f ON f.id = r.target_fragment_id
           WHERE r.relation_type='requires'`,
        )
        .all() as { t: string }[]
    ).map((r) => r.t);
    const g08 = texts.find((t) => t.includes("alpha-marker"));
    const g09 = texts.find((t) => t.includes("beta-marker"));
    expect(g08).toBeDefined();
    expect(g09).toBeDefined();
    expect(g08).toContain("G08 specific");
    expect(g08).not.toContain("overview");
    expect(g08).not.toContain("beta-marker");
    expect(g09).toContain("G09 specific");
    expect(g09).not.toContain("overview");
    expect(g09).not.toContain("alpha-marker");
    rmSync(root, { recursive: true, force: true });
  });

  it("decisionDate comes from the document, syncedAt stays independent", async () => {
    const root = makeFixtureRepo();
    decisionsFile(root, "dated", "Decided on 2026-09-27 to adopt the plan.");
    decisionsFile(root, "undated", "No explicit date written here.");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);

    const ctxOf = async (ext: string) => {
      const row = store.db
        .prepare(
          `SELECT r.body AS body FROM sources s JOIN revisions r ON s.head=r.id
           WHERE s.external_id=?`,
        )
        .get(ext) as { body: string };
      return JSON.parse(row.body).context as Record<string, unknown>;
    };
    const dated = await ctxOf("omem:docs/reviews/dated.md");
    expect(dated.decisionDate).toBe("2026-09-27");
    expect(typeof dated.syncedAt).toBe("string");
    expect(dated.syncedAt).toBeTruthy();
    expect(dated.reviewDate).toBeUndefined();

    const undated = await ctxOf("omem:docs/reviews/undated.md");
    expect(undated.decisionDate).toBe("unknown");
    rmSync(root, { recursive: true, force: true });
  });
});
