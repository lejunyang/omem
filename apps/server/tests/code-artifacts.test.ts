import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { runReviewSync } from "../src/review/sync.js";
import { runCodeSync } from "../src/code/sync.js";
import { currentSnapshotId, listFiles, snapshotFileBinding, symbolsOfSnapshot } from "../src/code/store.js";
import { generateCodeUnderstanding, listUnderstandings } from "../src/code/understanding-store.js";
import { exportGeneratedUnderstanding, restoreGeneratedUnderstandings, GENERATED_DIR } from "../src/code/artifacts.js";

it("rebuilds fixed code and model knowledge in a fresh DB, rejects changed input and forged locators", async () => {
  const root = mkdtempSync(join(tmpdir(), "omem-artifacts-"));
  const first = new Store(join(root, "db1"));
  const second = new Store(join(root, "db2"));
  const path = "apps/server/src/a.ts";
  const text = "\n/** multiline\n * note */\nexport function alpha() {\n  return '<img>';\n}\n\n";
  mkdirSync(join(root, "apps/server/src"), { recursive: true });
  writeFileSync(join(root, path), text);
  try {
    await runReviewSync(first, root); await runCodeSync(first, root);
    const snap = currentSnapshotId(first)!;
    const file = listFiles(first)[0]!;
    expect(snapshotFileBinding(first, snap, file.fileId)!.contentText).toBe(text);
    expect(first.db.prepare("SELECT content_text FROM code_snapshot_files WHERE file_id=?").get(file.fileId)).toMatchObject({ content_text: null });
    const sym = symbolsOfSnapshot(first, snap).find(s => s.name === "alpha")!;
    expect(first.evidence(sym.fragmentId!)!.fragment.text).toContain("function alpha");
    const result = await generateCodeUnderstanding(first, root, {
      transport: "fixture",
      run: async () => ({ model: "fixture-only", text: JSON.stringify({
        module_responsibilities: ["Returns a string"], boundaries: [], key_flows: [], entry_points: [], exit_points: [],
        risks_and_limits: [], claims: [{ text: "alpha returns a literal", kind: "raw_fact", node_ids: [sym.symbolId], evidence_ids: [] }],
        referenced_node_ids: [sym.symbolId], evidence_refs: [], unknowns: [], confidence: 0.5,
      }) }),
    }, { targetId: path });
    expect(result.ok).toBe(true);
    const dir = join(root, GENERATED_DIR);
    const artifact = exportGeneratedUnderstanding(first, root, result.understandingId, dir);
    await runReviewSync(second, root); await runCodeSync(second, root);
    const restored = listUnderstandings(second).filter(r => r.source === "model-generated");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ seed: 0, verified_by_agent: 0, model: "fixture-only" });
    expect(second.db.prepare("SELECT generation_budget FROM code_understandings WHERE understanding_id=?").get(String(restored[0]!.understanding_id))).toMatchObject({ generation_budget: expect.stringContaining("utf8-bytes/3") });
    restoreGeneratedUnderstandings(second, root);
    expect(listUnderstandings(second).filter(r => r.source === "model-generated")).toHaveLength(1);
    const original = readFileSync(join(dir, artifact), "utf8");
    const forged = JSON.parse(original); forged.nodes[0].qualifiedName = "ghost";
    writeFileSync(join(dir, artifact), JSON.stringify(forged));
    expect(restoreGeneratedUnderstandings(second, root)[0]!.status).toBe("rejected");
    writeFileSync(join(dir, artifact), original);
    writeFileSync(join(root, path), text.replace("'<img>'", "'changed'"));
    // A disk edit alone cannot change the fixed snapshot's evidence.
    await runCodeSync(first, root);
    expect(snapshotFileBinding(first, currentSnapshotId(first)!, file.fileId)!.contentText).toBe(text);
    await runReviewSync(second, root); await runCodeSync(second, root);
    expect(restoreGeneratedUnderstandings(second, root)[0]!.status).toBe("stale");
    expect(listUnderstandings(second).filter(r => r.source === "model-generated")).toHaveLength(0);
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});
