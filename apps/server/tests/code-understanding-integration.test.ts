import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { runCodeSync } from "../src/code/sync.js";
import { listUnderstandings, understandingDetail } from "../src/code/understanding-store.js";
import { buildReviewApp } from "../src/review/app.js";

const realRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const stores: { store: Store; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-cu-"));
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omem-cu-git-"));
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

const ALPHA_TS = [
  "export class Alpha {",
  "  greet(): string { return 'hi'; }",
  "}",
  "export function helper(x: number): number { return x; }",
].join("\n") + "\n";

function writeSeed(root: string, name: string, body: object) {
  writeFile(
    root,
    `.repo-review/knowledge/understandings/${name}`,
    JSON.stringify(body, null, 2),
  );
}

const goodSeed = {
  result_id: "seed:module-architect:alpha",
  target: { type: "module", id: "apps/server/src/alpha", title: "Alpha" },
  curated: { by: "tester", at: "2026-09-28T10:00:00Z", against_commit: "x", note: "fixture" },
  output: {
    module_responsibilities: ["holds the Alpha fixture surface"],
    boundaries: ["no external calls"],
    key_flows: [
      {
        name: "greet",
        description: "Alpha.greet returns a greeting",
        nodes: [
          { path: "apps/server/src/alpha.ts", qualified: "Alpha", kind: "class" },
          { path: "apps/server/src/alpha.ts", qualified: "Alpha.greet", kind: "method" },
        ],
      },
    ],
    entry_points: ["Alpha.greet"],
    exit_points: ["helper"],
    risks_and_limits: ["fixture only"],
    unknowns: ["not exercised"],
    claims: [
      {
        text: "class Alpha is declared in apps/server/src/alpha.ts",
        nodes: [{ path: "apps/server/src/alpha.ts", qualified: "Alpha", kind: "class" }],
        evidence: ["alpha-doc"],
      },
    ],
    evidence: [
      {
        id_hint: "alpha-doc",
        kind: "doc",
        ref: "apps/server/src/alpha.ts::Alpha",
        text: "Alpha fixture class",
        selector: { path: "apps/server/src/alpha.ts", start_line: 1, end_line: 3 },
      },
    ],
  },
};

describe("curated code understandings: schema, projection, staleness", () => {
  it("projects a curated seed as a current seed row and is idempotent", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/alpha.ts", ALPHA_TS);
    writeSeed(root, "alpha.seed.json", goodSeed);
    commitAll(root, "init");

    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);

    let rows = listUnderstandings(store);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.result_id).toBeUndefined();
    expect(row.target_id).toBe("apps/server/src/alpha");
    expect(row.status).toBe("seed");
    expect(Number(row.seed)).toBe(1);
    expect(Number(row.verified_by_agent)).toBe(0);
    expect(row.model).toBeNull();
    expect(row.confidence).toBeCloseTo(0.1);
    expect(row.source).toBe("curated-seed");

    // Same snapshot re-sync -> same understanding_id, still one current row.
    await runCodeSync(store, root);
    rows = listUnderstandings(store);
    expect(rows.length).toBe(1);

    const detail = understandingDetail(store, String(row.understanding_id))!;
    expect(detail).not.toBeNull();
    expect(detail.refs.length).toBeGreaterThan(0);
    // references the resolved node and the evidence doc.
    expect(detail.refs.some((r) => String(r.ref_kind) === "node")).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a seed that cites a ghost symbol without polluting current", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/alpha.ts", ALPHA_TS);
    writeSeed(root, "alpha.seed.json", goodSeed);
    const ghost = structuredClone(goodSeed) as typeof goodSeed;
    ghost.result_id = "seed:module-architect:alpha-ghost";
    ghost.target.id = "apps/server/src/alpha-ghost";
    ghost.output.claims[0]!.nodes = [
      { path: "apps/server/src/alpha.ts", qualified: "DoesNotExist", kind: "class" },
    ];
    ghost.output.key_flows[0]!.nodes = [];
    writeSeed(root, "ghost.seed.json", ghost);
    commitAll(root, "init");

    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);

    const current = listUnderstandings(store);
    // Only the good seed is current; the ghost is rejected and hidden.
    expect(current.map((r) => String(r.target_id))).not.toContain("apps/server/src/alpha-ghost");
    expect(current.length).toBe(1);

    const all = listUnderstandings(store, { all: true });
    const rejected = all.find((r) => String(r.target_id) === "apps/server/src/alpha-ghost");
    expect(rejected).toBeDefined();
    expect(rejected!.status).toBe("rejected");

    rmSync(root, { recursive: true, force: true });
  });

  it("marks the prior understanding stale when the input snapshot changes", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/alpha.ts", ALPHA_TS);
    writeSeed(root, "alpha.seed.json", goodSeed);
    commitAll(root, "init");

    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);
    const before = listUnderstandings(store);
    expect(before.length).toBe(1);
    const beforeId = String(before[0]!.understanding_id);

    // Change the file content -> new snapshot -> new input_digest.
    writeFile(
      root,
      "apps/server/src/alpha.ts",
      ALPHA_TS + "// touched\n",
    );
    commitAll(root, "touch");
    await runCodeSync(store, root);

    const current = listUnderstandings(store);
    expect(current.length).toBe(1);
    expect(String(current[0]!.understanding_id)).not.toBe(beforeId);

    const all = listUnderstandings(store, { all: true });
    expect(all.length).toBe(2);
    const old = all.find((r) => String(r.understanding_id) === beforeId);
    expect(old).toBeDefined();
    expect(Number(old!.stale)).toBe(1);
    // The new row supersedes the old one.
    expect(String(current[0]!.supersedes_id)).toBe(beforeId);

    rmSync(root, { recursive: true, force: true });
  });

  it("serves the read-only HTTP surface and states model unavailability; raw graph still works", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/alpha.ts", ALPHA_TS);
    writeSeed(root, "alpha.seed.json", goodSeed);
    commitAll(root, "init");

    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);

    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5181" };

    const model = await app.inject({ method: "GET", url: "/api/review/code/model-status", headers: hdr });
    expect(model.statusCode).toBe(200);
    expect(JSON.parse(model.body).available).toBe(false);

    const list = await app.inject({ method: "GET", url: "/api/review/code/understandings", headers: hdr });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).items.length).toBe(1);
    const id = String(JSON.parse(list.body).items[0].understandingId);

    const detail = await app.inject({ method: "GET", url: `/api/review/code/understandings/${id}`, headers: hdr });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).seed).toBe(true);
    expect(JSON.parse(detail.body).verifiedByAgent).toBe(false);

    // Raw graph endpoint still works with no model.
    const graph = await app.inject({ method: "GET", url: "/api/review/code/graph", headers: hdr });
    expect(graph.statusCode).toBe(200);

    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not touch old review rows when projecting understandings", async () => {
    const root = makeFixtureRepo();
    writeFile(root, "apps/server/src/alpha.ts", ALPHA_TS);
    writeSeed(root, "alpha.seed.json", goodSeed);
    commitAll(root, "init");

    const store = setup();
    await runReviewSync(store, root);
    await runCodeSync(store, root);

    const sourcesBefore = (store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n;
    const fragmentsBefore = (store.db.prepare("SELECT COUNT(*) AS n FROM fragments").get() as { n: number }).n;
    await runCodeSync(store, root);
    const sourcesAfter = (store.db.prepare("SELECT COUNT(*) AS n FROM sources").get() as { n: number }).n;
    const fragmentsAfter = (store.db.prepare("SELECT COUNT(*) AS n FROM fragments").get() as { n: number }).n;
    expect(sourcesAfter).toBe(sourcesBefore);
    expect(fragmentsAfter).toBe(fragmentsBefore);

    rmSync(root, { recursive: true, force: true });
  });

  it("projects the committed curated seeds against the real omem repo", { timeout: 60_000 }, async () => {
    const store = setup();
    await runReviewSync(store, realRepoRoot);
    const res = await runCodeSync(store, realRepoRoot);
    expect(res.fileCount).toBeGreaterThan(10);

    const rows = listUnderstandings(store);
    const targets = new Set(rows.map((r) => String(r.target_id)));
    // The five required modules are present as current seed understandings.
    expect(targets.has("apps/server/src/assistant")).toBe(true);
    expect(targets.has("apps/server/src/memory")).toBe(true);
    expect(targets.has("apps/server/src/retrieval")).toBe(true);
    expect(targets.has("apps/server/src/integrations/lark")).toBe(true);
    expect(targets.has("apps/web/src")).toBe(true);
    for (const r of rows) {
      expect(String(r.status)).toBe("seed");
      expect(Number(r.seed)).toBe(1);
      expect(Number(r.verified_by_agent)).toBe(0);
      expect(r.model).toBeNull();
    }
  });
});
