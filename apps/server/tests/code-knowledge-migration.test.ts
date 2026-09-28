import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureCodeTables, graphView, listSnapshots } from "../src/code/store.js";

const stores: { store: Store; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-mig-"));
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try { store.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("code side-table migration preserves history", () => {
  it("copies old single-PK symbols/edges into composite schema without dropping rows", () => {
    const store = setup();
    // Simulate a pre-migration database: old-shape tables keyed by id alone.
    store.db.exec(`CREATE TABLE code_repositories(
      repo_id TEXT PRIMARY KEY, root_path TEXT NOT NULL, remote TEXT, default_branch TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_snapshot_id TEXT)`);
    store.db.exec(`INSERT INTO code_repositories VALUES('omem','/x',NULL,NULL,'2020-01-01','2020-01-01',NULL)`);
    store.db.exec(`CREATE TABLE code_snapshots(
      snapshot_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, commit_hash TEXT, dirty INTEGER,
      captured_at TEXT NOT NULL, parser_version TEXT, file_count INTEGER, changed_count INTEGER, partial INTEGER)`);
    store.db.exec(`INSERT INTO code_snapshots VALUES('snap_old','omem','c1',0,'2020-01-01','v',1,1,0)`);
    store.db.exec(`CREATE TABLE code_files(
      file_id TEXT PRIMARY KEY, repo_id TEXT, path TEXT, language TEXT, size_bytes INTEGER,
      content_hash TEXT, head_snapshot_id TEXT, removed INTEGER, moved_to TEXT)`);
    store.db.exec(`INSERT INTO code_files VALUES('file_old','omem','apps/old.ts','ts',1,'h','snap_old',0,NULL)`);
    // Old single-PK symbols (one row per symbol_id, carrying snapshot).
    store.db.exec(`CREATE TABLE code_symbols(
      symbol_id TEXT PRIMARY KEY, file_id TEXT, snapshot_id TEXT, name TEXT, qualified_name TEXT,
      kind TEXT, range_start TEXT, range_end TEXT, fragment_id TEXT, exported INTEGER, signature TEXT)`);
    store.db.exec(`INSERT INTO code_symbols VALUES('sym_a','file_old','snap_old','alpha','alpha','function','{}','{}',NULL,1,'sig')`);
    // Old single-PK edges.
    store.db.exec(`CREATE TABLE code_edges(
      edge_id TEXT PRIMARY KEY, snapshot_id TEXT, edge_kind TEXT, from_symbol_id TEXT, from_file_id TEXT,
      to_symbol_id TEXT, to_file_id TEXT, status TEXT, origin TEXT, evidence TEXT, seed TEXT,
      created_at TEXT, updated_at TEXT)`);
    store.db.exec(`INSERT INTO code_edges VALUES('e1','snap_old','defines',NULL,'file_old','sym_a',NULL,'confirmed','parser',NULL,'seed','2020-01-01','2020-01-01')`);

    // Run migration.
    ensureCodeTables(store);

    // Rows preserved: old snapshot still listed, symbols/edges survive.
    const snaps = listSnapshots(store);
    expect(snaps.map((s) => s.snapshotId)).toContain("snap_old");
    const sym = store.db.prepare("SELECT COUNT(*) AS n FROM code_symbols").get() as { n: number };
    expect(Number(sym.n)).toBe(1);
    const edge = store.db.prepare("SELECT COUNT(*) AS n FROM code_edges").get() as { n: number };
    expect(Number(edge.n)).toBe(1);
    // Temp legacy tables dropped.
    expect(() => store.db.prepare("SELECT 1 FROM code_symbols_legacy").get()).toThrow();
    // Graph for the old snapshot still serves the historical rows.
    const g = graphView(store, { snapshotId: "snap_old" });
    expect(g.symbols.map((x) => x.symbolId)).toContain("sym_a");
    expect(g.edges.map((x) => x.edgeId)).toContain("e1");
  });
});
