import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { captureRepositoryMaterials, createReviewKnowledgeRepository } from "../src/review/materials.js";
import { restoreReviewKnowledge, saveReviewAnswerMaterials } from "../src/review/knowledge.js";

it("captures source, deployment configuration and image materials without importing runtime or private config", () => {
  const root = mkdtempSync(join(tmpdir(), "review-materials-"));
  const store = new Store(join(root, ".repo-review/runtime/db"));
  try {
    mkdirSync(join(root, "deploy"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# Purpose\n\nFixed evidence matters.\n");
    writeFileSync(join(root, "deploy/service.example"), "[Service]\nExecStart=node main.js\n");
    writeFileSync(join(root, ".env"), "PRIVATE_FIXTURE=not-captured");
    writeFileSync(join(root, "diagram.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"));
    const first = captureRepositoryMaterials(store, root);
    expect(first.filter(r => r.state === "captured").map(r => r.path).sort()).toEqual(["README.md", "deploy/service.example", "diagram.png"]);
    const repository = createReviewKnowledgeRepository(store);
    expect(repository.materials().find(m => m.path === "diagram.png")!.images).toHaveLength(1);
    const versions = store.db.prepare("SELECT count(*) n FROM revisions").get();
    captureRepositoryMaterials(store, root);
    expect(store.db.prepare("SELECT count(*) n FROM revisions").get()).toEqual(versions);
    expect(repository.materials().some(m => m.path === ".env")).toBe(false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("persists user clarification as original material and restores it without a legacy database", () => {
  const root = mkdtempSync(join(tmpdir(), "review-user-notes-"));
  const first = new Store(join(root, ".repo-review/runtime/first"));
  const second = new Store(join(root, ".repo-review/runtime/second"));
  try {
    first.capture({ source: "manual", externalId: "knowledge-answer:question1", title: "职责确认", parts: [{ type: "text", text: "这个模块只供本地单用户使用。" }], context: { application: "knowledge-reader" }, provenance: { collectorId: "knowledge-reader", actorId: "owner", actorType: "owner", actorVerifiedBy: "local-ui", sourceUri: null, eventId: null, eventAt: "2026-01-01T00:00:00Z", timezone: "Asia/Shanghai", quoted: false, forwarded: false, producerKind: "original" } });
    saveReviewAnswerMaterials(first, root);
    const restored = restoreReviewKnowledge(second, root).repository.materials().find(m => m.key === "manual:knowledge-answer:question1");
    expect(restored).toMatchObject({ text: "这个模块只供本地单用户使用。", actorId: "owner" });
    expect(second.revision(restored!.revisionId)!.provenance?.producerKind).toBe("original");
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});
