import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { runCodeSync } from "../src/code/sync.js";
import {
  currentSnapshotId,
  getSnapshot,
  graphView,
  listFiles,
} from "../src/code/store.js";
import { buildReviewApp } from "../src/review/app.js";

const stores: { store: Store; dir: string }[] = [];
function setup(dir: string) {
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omem-snap-"));
  git(["init", "-q", root], root);
  git(["config", "user.email", "t@e.com"], root);
  git(["config", "user.name", "t"], root);
  git(["config", "commit.gpgsign", "false"], root);
  return root;
}
function w(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
function commit(root: string, msg: string) {
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", msg], root);
}

const V1 = "export function alpha() { return 1; }\n";
const V2 = "export function alpha() { return 2; }\n";
const TEMP = "export function tempOnly() { return 9; }\n";

describe("code snapshot lifecycle: explicit head pointer + immutable snapshots", () => {
  it("A->B(dirty)->A: latest source remains readable and old snapshot links never change target", async () => {
    const root = makeRepo();
    w(root, "apps/server/src/a.ts", V1);
    commit(root, "v1");
    const dir = mkdtempSync(join(tmpdir(), "omem-snapdb-"));
    const store = setup(dir);

    // Snapshot A: clean baseline.
    await runReviewSync(store, root);
    const A = await runCodeSync(store, root);
    expect(A.reused).toBe(false);
    expect(A.fileCount).toBe(1);
    const capturedA = getSnapshot(store, A.snapshotId)!.capturedAt;
    expect(currentSnapshotId(store)).toBe(A.snapshotId);

    // Snapshot B: dirty tree — edit a.ts to v2 + add temp file (no commit).
    w(root, "apps/server/src/a.ts", V2);
    w(root, "apps/server/src/temp.ts", TEMP);
    await runReviewSync(store, root);
    const B = await runCodeSync(store, root);
    expect(B.reused).toBe(false);
    expect(B.snapshotId).not.toBe(A.snapshotId);
    expect(B.fileCount).toBe(2);
    expect(currentSnapshotId(store)).toBe(B.snapshotId);
    let gB = graphView(store, { snapshotId: B.snapshotId });
    expect(gB.files.some((f) => f.path.endsWith("temp.ts"))).toBe(true);

    // Revert dirty tree back to committed baseline (v1, no temp).
    w(root, "apps/server/src/a.ts", V1);
    rmSync(join(root, "apps", "server", "src", "temp.ts"));
    await runReviewSync(store, root);
    const C = await runCodeSync(store, root);
    expect(C.reused).toBe(false);
    expect(C.snapshotId).not.toBe(A.snapshotId);
    expect(C.fileCount).toBe(1);

    // The reverted bytes have a fresh captured identity; old A cannot be rebound.
    expect(currentSnapshotId(store)).toBe(C.snapshotId);
    // capturedAt of A immutable.
    expect(getSnapshot(store, A.snapshotId)!.capturedAt).toBe(capturedA);

    // Current head graph excludes the temp file.
    let gHead = graphView(store, {});
    expect(gHead.files.some((f) => f.path.endsWith("temp.ts"))).toBe(false);
    expect(
      listFiles(store, { includeRemoved: true }).find((f) =>
        f.path.endsWith("temp.ts"),
      )!.removed,
    ).toBe(true);

    // B snapshot STILL readable and still contains temp (history preserved).
    let gBnow = graphView(store, { snapshotId: B.snapshotId });
    expect(gBnow.files.some((f) => f.path.endsWith("temp.ts"))).toBe(true);

    // Through the HTTP API: /source pinned per snapshot.
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5181" };
    const aFile = listFiles(store, { includeRemoved: true }).find((f) =>
      f.path.endsWith("/a.ts"),
    )!;

    const srcA = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${aFile.fileId}/source?snapshotId=${A.snapshotId}&startLine=1&endLine=1`,
      headers: hdr,
    });
    expect(srcA.statusCode).toBe(404);
    const srcCurrent = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${aFile.fileId}/source?snapshotId=${C.snapshotId}&startLine=1&endLine=1`,
      headers: hdr,
    });
    expect(srcCurrent.statusCode).toBe(200);
    expect(JSON.parse(srcCurrent.body).text).toContain("return 1");

    const srcB = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${aFile.fileId}/source?snapshotId=${B.snapshotId}&startLine=1&endLine=1`,
      headers: hdr,
    });
    expect(srcB.statusCode).toBe(404);

    // The deleted temp file's source at B is the pinned immutable blob, NOT a
    // live read (it no longer exists on disk at A).
    const tempFileB = listFiles(store, { includeRemoved: true }).find((f) =>
      f.path.endsWith("temp.ts"),
    )!;
    const srcTemp = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${tempFileB.fileId}/source?snapshotId=${B.snapshotId}&startLine=1&endLine=1`,
      headers: hdr,
    });
    expect(srcTemp.statusCode).toBe(200);
    expect(JSON.parse(srcTemp.body).text).toContain("tempOnly");
    // At A the temp file was never pinned -> source unavailable (never guessed).
    const srcTempA = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${tempFileB.fileId}/source?snapshotId=${A.snapshotId}&startLine=1&endLine=1`,
      headers: hdr,
    });
    expect(srcTempA.statusCode).toBe(404);

    // Understanding of the removed temp file is flagged stale.
    const tempFile = listFiles(store, { includeRemoved: true }).find((f) =>
      f.path.endsWith("temp.ts"),
    )!;
    const cu = store.db
      .prepare(
        "SELECT stale FROM code_understandings WHERE target_type='file' AND target_id=?",
      )
      .get(tempFile.fileId) as { stale: number } | undefined;
    expect(cu).toBeDefined();
    expect(Number(cu!.stale)).toBe(1);

    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
});
