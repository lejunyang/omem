import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { buildReviewApp } from "../src/review/app.js";

const stores: { store: Store; dir: string }[] = [];
function setup(dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "omem-review-rel-"));
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

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "omem-review-rel-repo-"));
  git(["init", "-q", root], root);
  git(["config", "user.email", "t@example.com"], root);
  git(["config", "user.name", "tester"], root);
  git(["config", "commit.gpgsign", "false"], root);
  return root;
}

function w(root: string, rel: string, content: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function commitAll(root: string, msg: string) {
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", msg], root);
}

/** Build a fixture repo: one listed code file, a same-named decoy NOT listed,
 * a requirement doc, a decision doc, a real test file, plus an associations seed. */
function buildFixture(root: string, opts: { missingDecision?: boolean } = {}) {
  w(
    root,
    "apps/server/src/assistant/runtime.ts",
    `export function priorWorkingContext() {
  // carries the previous turn's selected evidence
  return [];
}

export function unrelatedHelper() {
  return 42;
}
`,
  );
  // Same symbol, different directory, deliberately NOT in the associations seed.
  w(
    root,
    "apps/server/src/other/runtime.ts",
    `export function priorWorkingContext() {
  return [];
}
`,
  );
  w(
    root,
    "docs/implementation/assistant-v3/migration-and-acceptance.md",
    `# acceptance

## 6. regression scenarios

| G08 | two-turn anaphora | reuse prior turn evidence |
`,
  );
  if (!opts.missingDecision) {
    w(
      root,
      "docs/reviews/g08-decision.md",
      "# G08 decision\n\nDecided to carry selected evidence across turns.\n",
    );
  }
  w(
    root,
    "apps/server/tests/runtime-rel.test.ts",
    `describe("runtime", () => {
  it("G08: two-turn anaphora reuses prior evidence", () => {
    expect(true).toBe(true);
  });
});
`,
  );
  w(
    root,
    "docs/repo-review/associations.json",
    JSON.stringify({
      version: 1,
      associations: [
        {
          codePath: "apps/server/src/assistant/runtime.ts",
          symbol: "priorWorkingContext",
          intent: "G08 多轮回指：前轮 selected evidence 支持纯回指",
          requirementRefs: ["G08"],
          decisionRefs: ["docs/reviews/g08-decision.md::G08 decision"],
          researchRefs: [],
          testRefs: [
            "apps/server/tests/runtime-rel.test.ts::G08: two-turn anaphora reuses prior evidence",
          ],
          status: "confirmed",
          evidence: "governCreateTask merges prior turn selectedEvidence into model input",
        },
      ],
    }),
  );
  commitAll(root, "init");
}

function relRows(store: Store) {
  return store.db
    .prepare(
      "SELECT id, source_fragment_id AS sf, target_fragment_id AS tf, relation_type AS type, status, evidence FROM review_relations ORDER BY relation_type",
    )
    .all() as {
    id: string;
    sf: string;
    tf: string;
    type: string;
    status: string;
    evidence: string | null;
  }[];
}

function headFragmentText(store: Store, relPath: string): string | null {
  const row = store.db
    .prepare(
      `SELECT r.body AS body FROM sources s JOIN revisions r ON s.head=r.id
       WHERE s.namespace='file' AND s.external_id=?`,
    )
    .get("omem:" + relPath) as { body: string } | undefined;
  if (!row) return null;
  return String(row.body);
}

describe("repo-review relations", () => {
  it("builds confirmed bidirectional implements/decided_by/tested_by relations", async () => {
    const root = makeRepo();
    buildFixture(root);
    const store = setup();
    const res = await runReviewSync(store, root);
    expect(res.relations).toBeDefined();
    expect(res.relations!.associations).toBe(1);

    const rows = relRows(store);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const types = new Set(rows.map((r) => r.type));
    expect(types.has("implements")).toBe(true);
    expect(types.has("decided_by")).toBe(true);
    expect(types.has("tested_by")).toBe(true);

    const impl = rows.find((r) => r.type === "implements")!;
    expect(impl.status).toBe("confirmed");
    expect(impl.sf).not.toBe("");
    expect(impl.tf).not.toBe("");
    expect(impl.evidence).toContain("G08");

    // Bidirectional: the requirement fragment sees the inverse relation.
    const back = store.db
      .prepare(
        "SELECT relation_type FROM review_relations WHERE target_fragment_id=?",
      )
      .all(impl.tf) as { relation_type: string }[];
    expect(back.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent: repeated sync reuses relation ids", async () => {
    const root = makeRepo();
    buildFixture(root);
    const store = setup();
    await runReviewSync(store, root);
    const before = relRows(store);
    const idsBefore = before.map((r) => r.id).sort();

    await runReviewSync(store, root); // clean tree, nothing changed
    const after = relRows(store);
    expect(after.map((r) => r.id).sort()).toEqual(idsBefore);
    expect(after.length).toBe(before.length);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not link an unlisted same-named file", async () => {
    const root = makeRepo();
    buildFixture(root);
    const store = setup();
    await runReviewSync(store, root);

    // The decoy file has its own source/fragments but NO relation rows touching them.
    const decoyRows = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_relations r
         JOIN fragments f ON f.id = r.source_fragment_id
         JOIN revisions rev ON rev.id=f.revision_id
         WHERE json_extract(rev.body,'$.context.filePath')=?`,
      )
      .get("apps/server/src/other/runtime.ts") as { n: number };
    expect(decoyRows.n).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("records a missing relation when a referenced decision doc is absent", async () => {
    const root = makeRepo();
    buildFixture(root, { missingDecision: true });
    const store = setup();
    await runReviewSync(store, root);

    const missing = relRows(store).filter((r) => r.status === "missing");
    expect(missing.length).toBeGreaterThanOrEqual(1);
    const decided = missing.find((r) => r.type === "decided_by");
    expect(decided).toBeDefined();
    expect(decided!.tf).toBe(""); // unresolved target
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /fragments/:id/relations returns both directions with evidence", async () => {
    const root = makeRepo();
    buildFixture(root);
    const store = setup();
    await runReviewSync(store, root);

    const impl = relRows(store).find((r) => r.type === "implements")!;
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" };
    const res = await app.inject({
      method: "GET",
      url: `/api/review/fragments/${impl.sf}/relations`,
      headers: hdr,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      relations: { relationType: string; status: string; other: { title: string } | null }[];
    };
    expect(body.relations.length).toBeGreaterThan(0);
    const types = new Set(body.relations.map((r) => r.relationType));
    expect(types.has("implements")).toBe(true); // outgoing from code
    expect(types.has("decided_by")).toBe(true);
    expect(types.has("tested_by")).toBe(true);

    // Reverse side: the requirement fragment sees the inverse label.
    const back = await app.inject({
      method: "GET",
      url: `/api/review/fragments/${impl.tf}/relations`,
      headers: hdr,
    });
    const backBody = back.json() as { relations: { relationType: string }[] };
    expect(
      backBody.relations.some((r) => r.relationType === "implemented_by"),
    ).toBe(true);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("/relations filters by status/type and /associations reports counts", async () => {
    const root = makeRepo();
    buildFixture(root);
    const store = setup();
    await runReviewSync(store, root);
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" };

    const confirmed = await app.inject({
      method: "GET",
      url: "/api/review/relations?status=confirmed&type=implements",
      headers: hdr,
    });
    const list = confirmed.json() as { relationType: string; status: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((r) => r.status === "confirmed" && r.relationType === "implements")).toBe(true);

    const summary = await app.inject({
      method: "GET",
      url: "/api/review/associations",
      headers: hdr,
    });
    const s = summary.json() as { seedCount: number; confirmed: number; missing: number };
    expect(s.seedCount).toBe(1);
    expect(s.confirmed).toBeGreaterThan(0);

    // category filter on search must not affect the relations endpoint.
    const search = await app.inject({
      method: "GET",
      url: "/api/review/search?q=priorWorkingContext&category=decisions",
      headers: hdr,
    });
    expect(search.statusCode).toBe(200);
    const impl = relRows(store).find((r) => r.type === "implements")!;
    const afterFilter = await app.inject({
      method: "GET",
      url: `/api/review/fragments/${impl.sf}/relations`,
      headers: hdr,
    });
    expect(afterFilter.statusCode).toBe(200);
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
});
