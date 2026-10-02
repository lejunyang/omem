import { KeywordRetrieval } from "../src/retrieval/keyword.js";
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { KnowledgeRepository, bindKnowledgeQuotes, validateKnowledgeDocument } from "../src/knowledge/repository.js";
import { writeKnowledgeArticle, restoreKnowledgeArticles } from "../src/knowledge/artifacts.js";
import type { KnowledgeArtifact, KnowledgeDocument } from "../../../packages/contracts/src/knowledge.js";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-knowledge-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, "db")); cleanup.push(() => store.close());
  const repository = new KnowledgeRepository(store);
  const capture = (text: string) => store.capture({ source: "manual", externalId: "a", title: "原始材料", parts: [{ type: "text", text }], context: {} });
  return { dir, store, repository, capture };
}
function document(key = "manual:a"): KnowledgeDocument {
  return { key, title: "模块职责", summary: "解释来自固定材料。", category: "implementation",
    sections: [{ key: "responsibility", title: "职责", body: "这个模块返回一个固定值。[[c1]]" }],
    citations: [{ key: "c1", label: "返回语句", reason: "这里直接给出了返回值，支持附近的职责说明。", relation: "supports", target: { kind: "material", key: "manual:a", startLine: 2, endLine: 2 }, quote: "" }],
    questions: [{ question: "后续是否需要配置返回值？", why: "当前材料只有固定值。", nextStep: "确认产品要求。", blocking: false, citationKeys: ["c1"] }] };
}
function artifact(d: KnowledgeDocument, dependencies: KnowledgeArtifact["dependencies"]): KnowledgeArtifact {
  return { version: 1, document: d, dependencies,
    generation: { model: "fixture-writer", effort: "low", at: "2026-01-01T00:00:00Z", trace: { sessionIds: ["writer-fixture"] } },
    review: { model: "fixture-reviewer", at: "2026-01-01T00:00:01Z", trace: { sessionIds: ["reviewer-fixture"] }, verdict: "accepted" } };
}

it("binds inline citations to exact fixed text, rejects detached/unknown references", () => {
  const { repository, capture } = setup(); capture("export function value() {\n  return 42;\n}");
  const materials = new Map(repository.materials().map(m => [m.key, m]));
  const d = bindKnowledgeQuotes(document(), materials);
  expect(d.citations[0]!.quote).toBe("  return 42;");
  expect(() => validateKnowledgeDocument(d, materials, new Map())).not.toThrow();
  d.sections[0]!.body = "正文没有引用";
  expect(() => validateKnowledgeDocument(d, materials, new Map())).toThrow("inline");
  d.sections[0]!.body = "正文[[unknown]]";
  expect(() => validateKnowledgeDocument(d, materials, new Map())).toThrow("Unknown inline");
  d.sections[0]!.body = "正文[[c1]]"; d.citations[0]!.target.endLine = 100;
  expect(() => bindKnowledgeQuotes(d, materials)).toThrow("Invalid citation range");
});

it("invalidates dependent chapters while preserving old immutable source and knowledge", () => {
  const { repository, capture } = setup(); capture("function value() {\n  return 42;\n}");
  const m = repository.materials()[0]!;
  const child = repository.publish(artifact(bindKnowledgeQuotes(document(), new Map([[m.key, m]])), [{ kind: "material", key: m.key, digest: m.digest }]));
  const parent = document("topic:overview"); parent.citations[0]!.target = { kind: "article", key: child.document.key, section: "responsibility" };
  const overview = repository.publish(artifact(parent, [{ kind: "article", key: child.document.key, digest: child.revision }]));
  expect(overview.current).toBe(true);
  capture("function value() {\n  return 99;\n}"); repository.refresh();
  expect(repository.get(child.document.key)!.current).toBe(false);
  expect(repository.get(parent.key)!.current).toBe(false);
  expect(repository.resolveMaterial(m.key, m.digest)!.material.text).toContain("42");
  expect(repository.get(child.document.key, child.revision)!.document.sections[0]!.body).toContain("[[c1]]");
  expect(() => repository.publish(child)).toThrow("KNOWLEDGE_INPUT_CHANGED");
});

it("restores reviewed knowledge in a fresh DB and preserves question actions", () => {
  const first = setup(); first.capture("function value() {\n  return 42;\n}");
  const m = first.repository.materials()[0]!;
  const a = first.repository.publish(artifact(bindKnowledgeQuotes(document(), new Map([[m.key, m]])), [{ kind: "material", key: m.key, digest: m.digest }]));
  const assets = join(first.dir, "articles"); writeKnowledgeArticle(assets, a);
  const second = setup(); second.capture(m.text);
  expect(restoreKnowledgeArticles(second.repository, assets).map(r => r.state)).toEqual(["restored"]);
  expect(second.repository.get(m.key)!.revision).toBe(a.revision);
  writeFileSync(join(assets, "invalid.json"), "broken");
  expect(restoreKnowledgeArticles(second.repository, assets).find(r => r.file === "invalid.json")!.state).toBe("rejected");
  expect(second.repository.get(m.key)!.revision).toBe(a.revision);
  const q = second.repository.questions()[0]!;
  const task = second.repository.createTask(q.id);
  expect(second.repository.createTask(q.id)).toBe(task);
  expect(second.store.tasks()).toHaveLength(1);
  const answer = second.repository.answer(q.id, "需要配置，默认保持 42。");
  expect(second.store.revision(answer)!.provenance?.producerKind).toBe("original");
  expect(second.repository.questions()[0]!.state).toBe("answered");
});

it("uses derived knowledge to find original evidence without promoting prose or stale sources", () => {
  const { repository, store, capture } = setup();
  capture("function value() {\n  return 42;\n}");
  const m = repository.materials()[0]!;
  const d = document(); d.title = "Aurora release rationale";
  repository.publish(artifact(bindKnowledgeQuotes(d, new Map([[m.key, m]])), [{ kind: "material", key: m.key, digest: m.digest }]));
  const retrieval = new KeywordRetrieval(store.db);
  const hits = retrieval.searchSources({ text: "Aurora" });
  expect(hits).toHaveLength(1);
  expect(hits[0]!.fragmentId).toBe(m.fragments[0]!.id);
  expect(store.evidence(hits[0]!.fragmentId)!.fragment.text).toContain("return 42");
  // Even before a projection refresh, actual head content prevents stale recall.
  capture("function value() {\n  return 99;\n}");
  expect(retrieval.searchSources({ text: "Aurora" })).toEqual([]);
});

it("routes a paragraph hit to its sources, without expanding the rest of the chapter", () => {
  const { repository, store, capture } = setup();
  capture("function first() { return 42; }");
  store.capture({source:"manual",externalId:"b",title:"另一个实现",parts:[{type:"text",text:"function second() { return 99; }"}],context:{}});
  const materials=new Map(repository.materials().map(m=>[m.key,m]));
  const d=document("guide:journey");
  d.title="旅行安排";
  d.sections[0]!.body="海边渡轮需要提前购买船票。[[c1]]\n\n酒店预订由住宿流程处理。[[c2]]";
  d.citations[0]!.target={kind:"material",key:"manual:a",startLine:1,endLine:1};
  d.citations.push({...d.citations[0]!,key:"c2",label:"住宿实现",target:{kind:"material",key:"manual:b",startLine:1,endLine:1},quote:""});
  d.questions=[];
  repository.publish(artifact(bindKnowledgeQuotes(d,materials),[...materials.values()].map(m=>({kind:"material" as const,key:m.key,digest:m.digest}))));
  const hits=new KeywordRetrieval(store.db).searchSources({text:"海边 渡轮 船票"});
  expect(hits).toHaveLength(1);
  expect(store.evidence(hits[0]!.fragmentId)!.fragment.text).toContain("first()");
});

it("keeps identical external ids from different material carriers distinct", () => {
  const { store, repository } = setup();
  for (const source of ["file", "manual"] as const) store.capture({ source, externalId: "omem:README.md", title: source, parts: [{ type: "text", text: "Same text, different source identity." }], context: {} });
  expect(repository.materials().map(m => m.key).sort()).toEqual(["file:omem:README.md", "manual:omem:README.md"]);
});

it("retires old investigation questions and notifies only for a new knowledge revision", () => {
  const { repository, store, capture } = setup(); capture("function value() {\n  return 42;\n}");
  const m = repository.materials()[0]!;
  const original = artifact(bindKnowledgeQuotes(document(), new Map([[m.key, m]])), [{ kind: "material", key: m.key, digest: m.digest }]);
  repository.publish(original);
  const notifications = store.notifications().length;
  repository.publish(original);
  expect(store.notifications()).toHaveLength(notifications);
  const next = structuredClone(original); next.document.questions = [];
  repository.publish(next);
  expect(repository.questions()[0]!.state).toBe("superseded");
  expect(store.notifications()).toHaveLength(notifications + 1);
});


it("retrieves all original fragments covered by a cross-paragraph citation", () => {
  const { repository, store, capture } = setup();
  capture("第一段解释接口背景。\n\n第二段说明实现原理。\n\n不相关的其他说明。");
  const m = repository.materials()[0]!;
  const d = document(); d.title = "CrossParagraphRationale";
  d.citations[0]!.target.startLine = 1; d.citations[0]!.target.endLine = 3;
  repository.publish(artifact(bindKnowledgeQuotes(d, new Map([[m.key,m]])), [{ kind: "material", key: m.key, digest: m.digest }]));
  const hits = new KeywordRetrieval(store.db).searchSources({ text: "CrossParagraphRationale" });
  expect(hits.map(h => h.fragmentId).sort()).toEqual(m.fragments.slice(0,2).map(f => f.id).sort());
});
