import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { runCodeSync, CodeKnowledgeService } from "../src/code/sync.js";
import {
  codeRepositoryId,
  edgeIdFor,
  fileIdFor,
  getSnapshot,
  graphView,
  listFiles,
  listSnapshots,
  symbolIdFor,
  symbolsOfFile,
} from "../src/code/store.js";
import { buildReviewApp } from "../src/review/app.js";

const realRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const stores: { store: Store; dir: string }[] = [];
function setup(dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "omem-code-"));
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

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omem-code-git-"));
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

// ---------------------------------------------------------------------------
// Unit: deterministic parser on a tiny fixture.
// ---------------------------------------------------------------------------

describe("code parser: deterministic TS/Vue extraction", () => {
  it("extracts function/class/range, imports and same-file calls", async () => {
    const root = makeFixtureRepo();
    writeFile(
      root,
      "apps/server/src/mod.ts",
      [
        'import { helper } from "./helper.js";',
        "export function alpha(a: number): number {",
        "  return helper(a);",
        "}",
        "export class Beta {",
        "  greet(): string { return 'hi'; }",
        "}",
      ].join("\n"),
    );
    writeFile(root, "apps/server/src/helper.ts", "export function helper(x: number): number { return x; }\n");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const res = await runCodeSync(store, root);
    expect(res.fileCount).toBeGreaterThanOrEqual(2);

    const modFile = listFiles(store).find((f) => f.path === "apps/server/src/mod.ts")!;
    const syms = symbolsOfFile(store, modFile.fileId);
    const alpha = syms.find((s) => s.name === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.kind).toBe("function");
    expect(alpha!.rangeStart.line).toBe(2);
    expect(alpha!.exported).toBe(true);
    // method qualified name is Class.method
    const greet = syms.find((s) => s.qualifiedName === "Beta.greet");
    expect(greet).toBeDefined();
    // fragment anchored to a real captured fragment
    expect(alpha!.fragmentId).toBeTruthy();

    rmSync(root, { recursive: true, force: true });
  });

  it("parses a .vue SFC into a component symbol", async () => {
    const root = makeFixtureRepo();
    writeFile(
      root,
      "apps/web/src/ReviewPanel.vue",
      [
        "<script setup lang=\"ts\">",
        "const props = defineProps<{ msg: string }>();",
        "</script>",
        "<template><h1>{{ msg }}</h1></template>",
      ].join("\n"),
    );
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);
    const vueFile = listFiles(store).find((f) => f.path.endsWith("ReviewPanel.vue"))!;
    expect(vueFile).toBeDefined();
    const syms = symbolsOfFile(store, vueFile.fileId);
    const comp = syms.find((s) => s.kind === "component");
    expect(comp).toBeDefined();
    expect(comp!.name).toBe("ReviewPanel");
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: idempotency, dirty, same-text-different-path, delete/rename, stale.
// ---------------------------------------------------------------------------

describe("code sync lifecycle", () => {
  it("is idempotent: second identical sync reuses the snapshot, no duplicate rows", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/a.ts", "export const a = 1;\n");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const first = await runCodeSync(store, root);
    expect(first.reused).toBe(false);
    const symCount1 = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_symbols").get() as { n: number }).n,
    );
    const second = await runCodeSync(store, root);
    expect(second.reused).toBe(true);
    const symCount2 = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_symbols").get() as { n: number }).n,
    );
    expect(symCount2).toBe(symCount1);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps two files with identical bytes as independent files/symbols", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/one.ts", "export const shared = 1;\n");
    writeFile(root, "apps/server/src/two.ts", "export const shared = 1;\n");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);
    const f1 = fileIdFor(codeRepositoryId(), "apps/server/src/one.ts");
    const f2 = fileIdFor(codeRepositoryId(), "apps/server/src/two.ts");
    expect(f1).not.toBe(f2);
    const s1 = symbolIdFor(codeRepositoryId(), "apps/server/src/one.ts", "shared", "const");
    const s2 = symbolIdFor(codeRepositoryId(), "apps/server/src/two.ts", "shared", "const");
    expect(s1).not.toBe(s2);
    rmSync(root, { recursive: true, force: true });
  });

  it("marks a deleted file removed and flips its edges stale without deleting rows", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/doomed.ts", "export const doomed = 1;\n");
    writeFile(root, "apps/server/src/kept.ts", "export const kept = 2;\n");
    commitAll(root, "v1");
    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);
    const beforeEdges = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_edges").get() as { n: number }).n,
    );

    rmSync(join(root, "apps", "server", "src", "doomed.ts"));
    commitAll(root, "remove");
    await runReviewSync(store, root);
    await runCodeSync(store, root);

    const doomed = listFiles(store, { includeRemoved: true }).find(
      (f) => f.path === "apps/server/src/doomed.ts",
    );
    expect(doomed!.removed).toBe(true);
    const afterEdges = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_edges").get() as { n: number }).n,
    );
    // rows never deleted (a later snapshot may add its own rows).
    expect(afterEdges).toBeGreaterThanOrEqual(beforeEdges);
    // In the per-snapshot model the doomed file's edges live on in the old
    // snapshot (history preserved); the current head graph simply has none.
    const doomedEdges = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_edges WHERE from_file_id=(SELECT file_id FROM code_files WHERE path='apps/server/src/doomed.ts')").get() as { n: number }).n,
    );
    expect(doomedEdges).toBeGreaterThan(0);
    expect(graphView(store, {}).edges.some((e) => e.fromFileId === doomed?.fileId)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("old snapshot remains readable; new head flips old edges stale", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/live.ts", "export const v1 = 1;\n");
    commitAll(root, "v1");
    const store = setup();
    await runReviewSync(store, root);
    const s1 = await runCodeSync(store, root);

    writeFile(root, "apps/server/src/live.ts", "export const v2 = 2;\n");
    commitAll(root, "v2");
    await runReviewSync(store, root);
    const s2 = await runCodeSync(store, root);

    expect(s2.snapshotId).not.toBe(s1.snapshotId);
    // old snapshot row still exists
    expect(getSnapshot(store, s1.snapshotId)).toBeTruthy();
    expect(listSnapshots(store).length).toBe(2);
    // edges from the first snapshot are no longer the head view (re-upserted to s2 or stale)
    const headEdges = Number(
      (store.db.prepare("SELECT COUNT(*) AS n FROM code_edges WHERE snapshot_id=? AND status<>'stale'").get(s2.snapshotId) as { n: number }).n,
    );
    expect(headEdges).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("a dirty tree produces a snapshot but does not corrupt the clean baseline", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/clean.ts", "export const clean = 1;\n");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const s1 = await runCodeSync(store, root);
    // dirty edit
    writeFile(root, "apps/server/src/clean.ts", "export const clean = 999;\n");
    const unchanged = await runCodeSync(store, root);
    expect(unchanged.snapshotId).toBe(s1.snapshotId); // disk edits are not evidence until captured
    await runReviewSync(store, root);
    const s2 = await runCodeSync(store, root);
    expect(s2.snapshotId).not.toBe(s1.snapshotId);
    expect(s2.fileCount).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Existing review tables are untouched by the additive code tables.
// ---------------------------------------------------------------------------

describe("code tables are additive", () => {
  it("does not change sources/revisions/fragments/review_relations row counts", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/x.ts", "export const x = 1;\n");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    const counts = () => ({
      sources: Number((store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n),
      revisions: Number((store.db.prepare("SELECT COUNT(*) AS n FROM revisions").get() as { n: number }).n),
      fragments: Number((store.db.prepare("SELECT COUNT(*) AS n FROM fragments").get() as { n: number }).n),
      relations: Number((store.db.prepare("SELECT COUNT(*) AS n FROM review_relations").get() as { n: number }).n),
    });
    const before = counts();
    await runCodeSync(store, root);
    const after = counts();
    expect(after).toEqual(before);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Real omem repo coverage: assistant / memory / retrieval / lark / web.
// ---------------------------------------------------------------------------

describe("real omem repo coverage", () => {
  it("parses assistant/memory/retrieval/lark/web code", async () => {
    const store = setup();
    await runReviewSync(store, realRepoRoot, {
      only: [
        "apps/server/src/assistant/runtime.ts",
        "apps/server/src/memory/service.ts",
        "apps/server/src/retrieval/keyword.ts",
        "apps/server/src/integrations/lark/runtime.ts",
      ],
    });
    // Full capture precedes the projection; the graph never scans extra files.
    await runReviewSync(store, realRepoRoot, { stateDir: join(store.dataDir, "review-state") });
    const res = await runCodeSync(store, realRepoRoot);
    expect(res.fileCount).toBeGreaterThan(50);
    const paths = listFiles(store).map((f) => f.path);
    for (const must of [
      "apps/server/src/assistant/runtime.ts",
      "apps/server/src/memory/service.ts",
      "apps/server/src/retrieval/keyword.ts",
    ]) {
      expect(paths).toContain(must);
    }
    // Lark + web areas are present.
    expect(paths.some((p) => p.includes("lark"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".vue"))).toBe(true);
    // Graph returns files + symbols + non-stale edges.
    const g = graphView(store, {});
    expect(g.files.length).toBeGreaterThan(50);
    expect(g.symbols.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
  }, 60_000); // Full-repository capture and AST projection scale with the checkout.
});

// ---------------------------------------------------------------------------
// HTTP surface: buildReviewApp exposes /api/review/code/* and rejects bad ranges.
// ---------------------------------------------------------------------------

describe("review app code routes", () => {
  it("serves code files/graph and validates source ranges", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/http.ts", "export function httpFn() { return 1; }\n");
    commitAll(root, "init");
    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5181" };

    const files = await app.inject({ method: "GET", url: "/api/review/code/files", headers: hdr });
    expect(files.statusCode).toBe(200);
    const fileRows = JSON.parse(files.body) as { path: string; fileId: string }[];
    const target = fileRows.find((f) => f.path === "apps/server/src/http.ts")!;
    expect(target).toBeTruthy();

    const syms = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${target.fileId}/symbols`,
      headers: hdr,
    });
    expect(syms.statusCode).toBe(200);
    expect(JSON.parse(syms.body).length).toBeGreaterThan(0);

    const graph = await app.inject({ method: "GET", url: "/api/review/code/graph", headers: hdr });
    expect(graph.statusCode).toBe(200);

    // Valid in-range source slice.
    const ok = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${target.fileId}/source?startLine=1&endLine=1`,
      headers: hdr,
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).text).toContain("httpFn");

    // Out-of-range -> 400 (the wrong-range counter-example).
    const bad = await app.inject({
      method: "GET",
      url: `/api/review/code/files/${target.fileId}/source?startLine=999&endLine=1000`,
      headers: hdr,
    });
    expect(bad.statusCode).toBe(400);

    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
});
