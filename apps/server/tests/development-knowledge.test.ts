import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { importDevelopmentKnowledge } from "../src/knowledge/development.js";
import { bindKnowledgeQuotes } from "../src/knowledge/repository.js";
import { writeKnowledgeArticle } from "../src/knowledge/artifacts.js";

it("restores repository articles into personal memory without replacing captures and keeps fixed evidence after updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-unified-")), root = join(dir, "repo");
  mkdirSync(root); writeFileSync(join(root, "README.md"), "# 使用指南\n\n统一保存材料与知识。\n");
  const original = new Store(join(dir, "original")), personal = new Store(join(dir, "personal"));
  try {
    const repository = importDevelopmentKnowledge(original, root).repository;
    const material = repository.materials()[0]!;
    const article = repository.publish({ version: 1, document: bindKnowledgeQuotes({ key: "topic:overview", title: "统一记忆", summary: "保存与阅读", category: "overview", sections: [{ key: "reading", title: "如何阅读", body: "统一保存材料与知识。参考 [[source]]" }], citations: [{ key: "source", label: "使用指南", reason: "介绍保存范围", relation: "supports", target: { kind: "material", key: material.key, startLine: 1, endLine: 3 }, quote: "" }], questions: [] }, new Map([[material.key, material]])), dependencies: [{ kind: "material", key: material.key, digest: material.digest }], generation: { model: "fixture", at: "2026-10-01", effort: null, trace: {} }, review: { model: "fixture-verifier", at: "2026-10-01", verdict: "accepted", trace: {} } });
    writeKnowledgeArticle(join(root, ".repo-review/knowledge/articles"), article);
    const mine = personal.capture({ source: "manual", title: "我的日记", externalId: "diary", parts: [{ type: "text", text: "今天读了一章。" }], context: {} });
    const imported = importDevelopmentKnowledge(personal, root).repository;
    expect(imported.get("topic:overview")?.current).toBe(true);
    expect(imported.resolveMaterial(material.key, material.digest)?.material.text).toContain("统一保存");
    const count = personal.db.prepare("SELECT count(*) n FROM revisions").get()!.n;
    importDevelopmentKnowledge(personal, root);
    expect(personal.db.prepare("SELECT count(*) n FROM revisions").get()!.n).toBe(count);
    expect(personal.revision(mine.revision.id)?.title).toBe("我的日记");
    writeFileSync(join(root, "README.md"), "# 新指南\n\n内容已经更新。\n");
    importDevelopmentKnowledge(personal, root);
    expect(imported.get("topic:overview")?.current).toBe(false);
    expect(imported.resolveMaterial(material.key, material.digest)?.material.text).toContain("统一保存");
    // Importing a reviewed historical artifact preserves its original evidence.
    imported.restoreHistorical(article);
    expect(imported.get("topic:overview")?.current).toBe(false);
  } finally { original.close(); personal.close(); rmSync(dir, { recursive: true, force: true }); }
});
