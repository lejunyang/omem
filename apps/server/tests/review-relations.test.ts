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

type Seed = {
  codePath: string;
  symbol: string;
  intent: string;
  requirementRefs: string[];
  decisionRefs: string[];
  researchRefs?: string[];
  testRefs: string[];
  status: string;
  evidence: string;
};

/** Build a fixture repo: two seeds on the SAME requirement G08 but different
 * symbols (must not overwrite each other), one seed with two requirementRefs,
 * a decoy same-named file not listed, a requirement/decision/test doc. */
function buildFixture(root: string, seeds: Seed[]) {
  w(
    root,
    "apps/server/src/assistant/runtime.ts",
    `export function priorWorkingContext() {
  // carries the previous turn's selected evidence
  return [];
}

export function recoverUnfinishedTurns() {
  // retry hook
  return null;
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
  // Requirement doc with a shared G01-G20 style overview TABLE that must never be
  // bound wholesale to an intent fragment.
  w(
    root,
    "docs/implementation/assistant-v3/migration-and-acceptance.md",
    `# acceptance

## coverage

| G01 | bootstraps | done |
| G02 | capture | done |
| G08 | two-turn anaphora | reuse prior turn evidence |
| G09 | retry pending turn | recover |
`,
  );
  w(
    root,
    "docs/reviews/g08-decision.md",
    "# G08 decision\n\nDecided to carry selected evidence across turns.\n",
  );
  w(
    root,
    "apps/server/tests/runtime-rel.test.ts",
    `describe("runtime", () => {
  it("G08: two-turn anaphora reuses prior evidence", () => {
    expect(true).toBe(true);
  });
  it("G09: retry recovers pending turn", () => {
    expect(true).toBe(true);
  });
});
`,
  );
  w(
    root,
    "docs/repo-review/associations.json",
    JSON.stringify({ version: 1, associations: seeds }),
  );
  commitAll(root, "init");
}

function defaultSeeds(): Seed[] {
  return [
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
    // Second seed on the SAME requirement but a DIFFERENT symbol: must get its own
    // intent fragment and own edges, never overwrite the first.
    {
      codePath: "apps/server/src/assistant/runtime.ts",
      symbol: "recoverUnfinishedTurns",
      intent: "G09 重试：recover 未完成轮次",
      requirementRefs: ["G08", "G09"],
      decisionRefs: [],
      researchRefs: [],
      testRefs: [
        "apps/server/tests/runtime-rel.test.ts::G09: retry recovers pending turn",
      ],
      status: "confirmed",
      evidence: "recoverUnfinishedTurns resets stale pending turns",
    },
  ];
}

function relRows(store: Store) {
  return store.db
    .prepare(
      `SELECT id, seed_identity AS sid, source_fragment_id AS sf,
              target_fragment_id AS tf, relation_type AS type, status, evidence
       FROM review_relations ORDER BY relation_type`,
    )
    .all() as {
    id: string;
    sid: string | null;
    sf: string;
    tf: string;
    type: string;
    status: string;
    evidence: string | null;
  }[];
}

/** Head fragments of the virtual intent-index source. */
function intentFragments(store: Store): { id: string; text: string }[] {
  const row = store.db
    .prepare(
      `SELECT rev.id AS rid FROM sources s JOIN revisions rev ON s.head=rev.id
       WHERE s.namespace='file' AND s.external_id='omem:repo-review/intent-index'`,
    )
    .get() as { rid: string } | undefined;
  if (!row) return [];
  return (store.fragments(row.rid) as { id: string; text: string }[]).map((f) => ({
    id: f.id,
    text: f.text,
  }));
}

describe("repo-review relations", () => {
  it("generates a per-seed intent index; implements points at it, not the G01-G20 table", async () => {
    const root = makeRepo();
    buildFixture(root, defaultSeeds());
    const store = setup();
    const res = await runReviewSync(store, root);
    expect(res.relations).toBeDefined();
    expect(res.relations!.associations).toBe(2);

    const intents = intentFragments(store);
    expect(intents.length).toBe(2);
    // Each intent fragment contains only its own seed text, never the shared table.
    for (const f of intents) {
      expect(f.text).not.toContain("| G01 |");
      expect(f.text).not.toContain("| G02 |");
      expect(f.text).toContain("关联ID:");
    }
    const prior = intents.find((f) => f.text.includes("priorWorkingContext"))!;
    expect(prior).toBeTruthy();
    expect(prior.text).toContain("G08 多轮回指");
    const retry = intents.find((f) => f.text.includes("recoverUnfinishedTurns"))!;
    expect(retry).toBeTruthy();
    expect(retry.text).toContain("G09 重试");
    // Two seeds -> two distinct intent fragments, no overwrite.
    expect(prior.id).not.toBe(retry.id);

    const implRows = relRows(store).filter((r) => r.type === "implements");
    expect(implRows.length).toBe(2);
    // implements target is the intent fragment (non-empty), not status.md table.
    for (const impl of implRows) {
      expect(impl.sf).not.toBe("");
      expect(impl.tf).not.toBe("");
      expect(impl.status).toBe("confirmed");
    }

    rmSync(root, { recursive: true, force: true });
  });

  it("builds a requires edge per requirementRef (multi-ref not just [0])", async () => {
    const root = makeRepo();
    buildFixture(root, defaultSeeds());
    const store = setup();
    await runReviewSync(store, root);

    const requires = relRows(store).filter((r) => r.type === "requires");
    // seed1 -> G08 (1), seed2 -> G08 + G09 (2) = 3 total.
    expect(requires.length).toBe(3);
    // requires edges originate at the intent fragment, not at code.
    const codeSf = new Set(
      relRows(store).filter((r) => r.type === "implements").map((r) => r.sf),
    );
    for (const r of requires) expect(codeSf.has(r.sf)).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent: repeated sync reuses relation ids", async () => {
    const root = makeRepo();
    buildFixture(root, defaultSeeds());
    const store = setup();
    await runReviewSync(store, root);
    const idsBefore = relRows(store).map((r) => r.id).sort();

    await runReviewSync(store, root);
    const idsAfter = relRows(store).map((r) => r.id).sort();
    expect(idsAfter).toEqual(idsBefore);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not link an unlisted same-named file", async () => {
    const root = makeRepo();
    buildFixture(root, defaultSeeds());
    const store = setup();
    await runReviewSync(store, root);

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

  it("keeps every missing edge independently visible (no empty-endpoint collision)", async () => {
    const root = makeRepo();
    const seeds = defaultSeeds();
    // Point both seeds at a decision/test that does NOT exist, so both produce
    // missing edges; they must not collapse into one row on source='' target=''.
    seeds[0]!.decisionRefs = ["docs/reviews/does-not-exist.md"];
    seeds[1]!.testRefs = ["apps/server/tests/missing.test.ts::nope"];
    buildFixture(root, seeds);
    const store = setup();
    await runReviewSync(store, root);

    const missing = relRows(store).filter((r) => r.status === "missing");
    expect(missing.length).toBeGreaterThanOrEqual(2);
    // Distinct seed identities, so they never overwrite each other.
    const sids = new Set(missing.map((r) => r.sid));
    expect(sids.size).toBe(missing.length);
    rmSync(root, { recursive: true, force: true });
  });

  it("stales edges for seeds removed from the list", async () => {
    const root = makeRepo();
    buildFixture(root, defaultSeeds());
    const store = setup();
    await runReviewSync(store, root);
    const before = relRows(store).filter((r) => r.status !== "stale").length;
    expect(before).toBeGreaterThan(0);

    // Remove the second seed, keep only the first.
    w(
      root,
      "docs/repo-review/associations.json",
      JSON.stringify({ version: 1, associations: defaultSeeds().slice(0, 1) }),
    );
    commitAll(root, "drop seed2");
    await runReviewSync(store, root);

    const stale = relRows(store).filter((r) => r.status === "stale");
    expect(stale.length).toBeGreaterThan(0);
    // The removed seed's implements edge is stale now, not still green.
    const retryImpl = stale.find((r) => r.sid?.startsWith("assoc_") && r.type === "implements");
    expect(retryImpl).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /fragments/:id/relations returns code→intent outgoing and implemented_by incoming", async () => {
    const root = makeRepo();
    buildFixture(root, defaultSeeds());
    const store = setup();
    await runReviewSync(store, root);

    const impl = relRows(store).find((r) => r.type === "implements")!;
    const { app } = await buildReviewApp({ store, repoRoot: root });
    await app.ready();
    const hdr = { host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" };

    // Code fragment: outgoing implements -> intent.
    const codeRes = await app.inject({
      method: "GET",
      url: `/api/review/fragments/${impl.sf}/relations`,
      headers: hdr,
    });
    expect(codeRes.statusCode).toBe(200);
    const codeBody = codeRes.json() as {
      relations: { relationType: string; relationStatus: string; other: { text: string } | null }[];
    };
    const outTypes = new Set(codeBody.relations.map((r) => r.relationType));
    expect(outTypes.has("implements")).toBe(true);
    // The intent text shown to the user is the short one, not the G01-G20 table.
    const impRel = codeBody.relations.find((r) => r.relationType === "implements")!;
    expect(impRel.relationStatus).toBe("confirmed");
    expect(impRel.other!.text).not.toContain("| G01 |");

    // Intent fragment: outgoing requires/decided_by/tested_by + incoming implemented_by.
    const intentRes = await app.inject({
      method: "GET",
      url: `/api/review/fragments/${impl.tf}/relations`,
      headers: hdr,
    });
    const intentBody = intentRes.json() as { relations: { relationType: string }[] };
    const inTypes = new Set(intentBody.relations.map((r) => r.relationType));
    expect(inTypes.has("implemented_by")).toBe(true);
    expect(inTypes.has("requires")).toBe(true);

    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("/relations filters by status/type and /associations reports counts", async () => {
    const root = makeRepo();
    buildFixture(root, defaultSeeds());
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
    const list = confirmed.json() as { relationType: string; relationStatus: string }[];
    expect(list.length).toBe(2);
    expect(
      list.every((r) => r.relationStatus === "confirmed" && r.relationType === "implements"),
    ).toBe(true);

    const summary = await app.inject({
      method: "GET",
      url: "/api/review/associations",
      headers: hdr,
    });
    const s = summary.json() as { seedCount: number };
    expect(s.seedCount).toBe(2);

    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
});
