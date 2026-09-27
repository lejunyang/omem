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
import { runReviewSync } from "../src/review/sync.js";
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
    expect(body.dataDir).toBe(".repo-review/data");
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
