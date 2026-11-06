import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSpace, getSpace } from "../src/core/spaces.ts";
import { startServer } from "../src/server/http.ts";
import { importDirectory, syncDirectorySpace } from "../src/sources/import.ts";
import { listSources } from "../src/sources/store.ts";
import { testApp } from "./helpers.ts";

function fixture() {
  const app = testApp();
  const root = mkdtempSync(join(tmpdir(), "omem-import-process-"));
  createSpace(app, { id: "example", name: "示例仓库", kind: "repo", rootPath: root });
  for (let i = 0; i < 120; i++) {
    const text = Array.from({ length: 60 }, (_, n) => `export function sample${n}(value: number) { return value + ${i}; }`).join("\n");
    writeFileSync(join(root, `sample${i}.ts`), text);
  }
  return { app, root };
}

it("keeps HTTP responsive during repository parsing and indexing, then syncs changes and tombstones", async () => {
  const { app, root } = fixture();
  const server = await startServer(app, { port: 0, quiet: true });
  let announce!: () => void;
  const began = new Promise<void>((resolve) => { announce = resolve; });
  let finished = false;
  let changed = 0;
  app.events.on("event", e => { if (e.type === "changed" && e.entity === "source" && e.spaceId === "example") changed++; });
  try {
    const work = syncDirectorySpace(app, "example", () => announce()).then((r) => { finished = true; return r; });
    await began;
    expect(finished).toBe(false);
    const before = performance.now();
    expect((await fetch(`${app.baseUrl}/api/me`)).status).toBe(200);
    expect(performance.now() - before).toBeLessThan(1000);
    expect(finished).toBe(false);
    expect(await work).toMatchObject({ created: 120, updated: 0, removed: 0 });
    expect(changed).toBe(120);
    expect(listSources(app, { spaceId: "example", limit: 200 }).total).toBe(120);
    expect(getSpace(app, "example").settings.lastSync).toBeTruthy();
    writeFileSync(join(root, "sample0.ts"), readFileSync(join(root, "sample0.ts"), "utf8") + "\nexport const changed = true;");
    rmSync(join(root, "sample1.ts"));
    expect(await syncDirectorySpace(app, "example")).toMatchObject({ created: 0, updated: 1, removed: 1 });
    expect(listSources(app, { spaceId: "example", limit: 200 }).total).toBe(119);
  } finally { await server.close(); app.db.close(); }
}, 30_000);

it("imports ordinary directories in the same isolated path and cancels work when the app closes", async () => {
  const { app, root } = fixture();
  let closed = false;
  try {
    const report = await importDirectory(app, "personal", root);
    expect(report.created).toBe(120);
    let announce!: () => void;
    const began = new Promise<void>((resolve) => { announce = resolve; });
    const work = syncDirectorySpace(app, "example", () => announce());
    const rejected = expect(work).rejects.toThrow(/导入取消/);
    await began;
    app.db.close();
    closed = true;
    await rejected;
    await expect(syncDirectorySpace(app, "example")).rejects.toThrow();
  } finally { if (!closed) app.db.close(); }
}, 30_000);
