import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { App } from "../src/core/app.ts";
import { migrations } from "../src/core/db.ts";
import { ensurePersonalSpace } from "../src/core/spaces.ts";
import { importText } from "../src/sources/import.ts";
import { purgeSource } from "../src/sources/store.ts";

it("upgrades existing libraries so purging a source uses indexed lookups and preserves other sources", () => {
  const home = mkdtempSync(join(tmpdir(), "omem-purge-index-"));
  const old = new DatabaseSync(join(home, "omem.db"));
  for (const migration of migrations.slice(0, -1)) old.exec(migration);
  old.exec(`pragma user_version=${migrations.length - 1}`);
  old.close();
  const app = App.open(home);
  try {
    ensurePersonalSpace(app);
    const make = (uri: string) => importText(app, "personal", { uri, kind: "code", text: "export function example() { return 1; }" });
    const removed = make("removed.ts"), kept = make("kept.ts");
    for (const source of [removed, kept]) app.db.prepare("insert into source_locations(origin_space,uri,source_id) values('personal',?,?)").run(source.id, source.id);
    for (const table of ["symbols", "source_locations"]) {
      const plan = app.db.prepare(`explain query plan delete from ${table} where source_id=?`).all(removed.id);
      expect(plan.some((row) => String(row.detail).includes(`SEARCH ${table} USING`))).toBe(true);
      expect(plan.some((row) => String(row.detail).includes(`SCAN ${table}`))).toBe(false);
    }
    expect(app.db.prepare("select count(*) as n from symbols where source_id=?").get(kept.id)?.n).toBeGreaterThan(0);
    purgeSource(app, removed.id);
    for (const table of ["sources", "symbols", "source_locations"]) {
      const column = table === "sources" ? "id" : "source_id";
      expect(app.db.prepare(`select count(*) as n from ${table} where ${column}=?`).get(removed.id)?.n).toBe(0);
      expect(app.db.prepare(`select count(*) as n from ${table} where ${column}=?`).get(kept.id)?.n).toBeGreaterThan(0);
    }
  } finally {
    app.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
