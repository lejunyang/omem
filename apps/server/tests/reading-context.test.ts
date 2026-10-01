import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { materialFromRevision } from "../src/knowledge/repository.js";
import { materialSections } from "../src/knowledge/structure.js";
import { evidenceNeighbors } from "../src/retrieval/context.js";
import { buildApp } from "../src/app.js";

it("retrieves a Chinese question through the global API without requiring a literal substring", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reading-search-"));
  const { app, store } = await buildApp({ dataDir: dir, agentCwd: dir, host: "127.0.0.1", port: 4317, captureRoots: [], notifications: { mode: "instant" }, profiles: [] });
  try {
    store.capture({ source: "manual", externalId: "message", title: "消息处理", parts: [{ type: "text", text: "飞书群中的消息先保存，再交给后台任务处理。" }], context: {} });
    const response = await app.inject("/api/search?q=" + encodeURIComponent("飞书 消息 后台"));
    expect(response.statusCode).toBe(200);
    expect(response.json()[0]).toMatchObject({ title: "消息处理", routes: expect.any(Array) });
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("expands a hit within its Markdown section, retaining original anchors and visibility", () => {
  const dir = mkdtempSync(join(tmpdir(), "reading-context-")), store = new Store(dir);
  try {
    const captured = store.capture({ source: "file", externalId: "guide.md", title: "guide.md", parts: [{ type: "text", text: "# Guide\n\n## Sending\n\nSend the pending message.\n\nRetry after failure.\n\n```bash\n# Not a section\necho ok\n```\n\n## Deleting\n\nDelete permanently." }], context: {} });
    const material = materialFromRevision(store, captured.revision.id)!;
    expect(materialSections(material).map(s => s.title)).toEqual(["Guide", "Sending", "Deleting"]);
    const hit = material.fragments.find(f => f.text === "Retry after failure.")!;
    const neighbors = evidenceNeighbors(store, hit.id, () => true);
    expect(neighbors).toContain(material.fragments.find(f => f.text === "## Sending")!.id);
    expect(neighbors).toContain(material.fragments.find(f => f.text === "Send the pending message.")!.id);
    expect(neighbors).not.toContain(material.fragments.find(f => f.text === "Delete permanently.")!.id);
    expect(evidenceNeighbors(store, hit.id, () => false)).toEqual([]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
