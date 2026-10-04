import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { importDevelopmentKnowledge } from "../src/review/development.js";
import { bindKnowledgeQuotes, digest } from "../src/knowledge/repository.js";
import { writeKnowledgeArticle } from "../src/knowledge/artifacts.js";
import type { KnowledgeArtifact } from "../../../packages/contracts/src/knowledge.js";

it("restores repository articles into personal memory without replacing captures and keeps fixed evidence after updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-unified-")), root = join(dir, "repo");
  mkdirSync(root); writeFileSync(join(root, "README.md"), "# 使用指南\n\n统一保存材料与知识。\n");
  const original = new Store(join(dir, "original")), personal = new Store(join(dir, "personal"));
  try {
    const repository = importDevelopmentKnowledge(original, root).repository;
    const material = repository.materials()[0]!;
    const article = repository.publish({ version: 1, publication:{role:"article"}, document: bindKnowledgeQuotes({ key: "topic:overview", title: "统一记忆", summary: "保存与阅读", category: "overview", sections: [{ key: "reading", title: "如何阅读", body: "统一保存材料与知识。参考 [[source]]" }], citations: [{ key: "source", label: "使用指南", reason: "介绍保存范围", relation: "supports", target: { kind: "material", key: material.key, startLine: 1, endLine: 3 }, quote: "" }], questions: [] }, new Map([[material.key, material]])), dependencies: [{ kind: "material", key: material.key, digest: material.digest }], generation: { model: "fixture", at: "2026-10-01", effort: null, trace: {} }, review: { model: "fixture-verifier", at: "2026-10-01", verdict: "accepted", trace: {} } });
    writeKnowledgeArticle(join(root, ".repo-review/knowledge/articles"), article);
    const mine = personal.capture({ source: "manual", title: "我的日记", externalId: "diary", parts: [{ type: "text", text: "今天读了一章。" }], context: {} });
    const imported = importDevelopmentKnowledge(personal, root).repository;
    expect(imported.get("topic:overview")?.current).toBe(true);
    expect(imported.published().map(a=>a.document.key)).toContain("topic:overview");
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
    rmSync(join(root,".repo-review/knowledge/articles",digest(article.document.key)+".json"));
    importDevelopmentKnowledge(personal,root);
    expect(imported.published().map(a=>a.document.key)).not.toContain(article.document.key);
    expect(imported.get(article.document.key,article.revision)).not.toBeNull();
    expect(personal.revision(mine.revision.id)?.title).toBe("我的日记");
  } finally { original.close(); personal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("imports updated parent and child articles in one startup even when the parent asset is visited first", () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-article-updates-")), root = join(dir, "repo");
  mkdirSync(root); writeFileSync(join(root, "README.md"), "# 使用指南\n\n保存材料。\n");
  const original = new Store(join(dir, "original")), personal = new Store(join(dir, "personal"));
  const assets = join(root, ".repo-review/knowledge/articles"); mkdirSync(assets, { recursive: true });
  const provenance = { generation: { model: "fixture", at: "2026-10-01", effort: null, trace: {} }, review: { model: "fixture-verifier", at: "2026-10-01", verdict: "accepted" as const, trace: {} } };
  try {
    const repository = importDevelopmentKnowledge(original, root).repository;
    const material = repository.materials()[0]!;
    const publish = (summary: string) => {
      const child: KnowledgeArtifact = { version: 1, ...provenance, document: bindKnowledgeQuotes({ key: "article:child", title: "保存材料", summary, category: "implementation", sections: [{ key: "saving", title: "保存方式", body: summary + "参考 [[source]]" }], citations: [{ key: "source", label: "使用指南", reason: "说明保存方式", relation: "supports", target: { kind: "material", key: material.key, startLine: 1, endLine: 3 }, quote: "" }], questions: [] }, new Map([[material.key, material]])), dependencies: [{ kind: "material", key: material.key, digest: material.digest }] };
      const published = repository.publish(child);
      const parent: KnowledgeArtifact = { version: 1, ...provenance, document: { key: "topic:overview", title: "系统概览", summary, category: "overview", sections: [{ key: "overview", title: "从材料开始", body: summary + "参考 [[child]]" }], citations: [{ key: "child", label: "保存材料", reason: "说明保存流程", relation: "supports", target: { kind: "article", key: "article:child", section: "saving" }, quote: "" }], questions: [] }, dependencies: [{ kind: "article", key: "article:child", digest: published.revision }] };
      repository.publish(parent);
      writeFileSync(join(assets, "a-child.json"), JSON.stringify(child));
      writeFileSync(join(assets, "z-parent.json"), JSON.stringify(parent));
    };
    publish("旧版说明。");
    importDevelopmentKnowledge(personal, root);
    publish("新版说明。");
    const imported = importDevelopmentKnowledge(personal, root).repository;
    expect(imported.get("topic:overview")?.document.summary).toBe("新版说明。");
    expect(imported.get("topic:overview")?.current).toBe(true);
    expect(imported.get("article:child")?.current).toBe(true);
  } finally { original.close(); personal.close(); rmSync(dir, { recursive: true, force: true }); }
});
