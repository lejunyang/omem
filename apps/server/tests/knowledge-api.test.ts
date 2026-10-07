import Fastify from "fastify";
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { registerKnowledgeRoutes } from "../src/knowledge/api.js";
import { bindKnowledgeQuotes } from "../src/knowledge/repository.js";
import type { KnowledgeDocument } from "../../../packages/contracts/src/knowledge.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { createRetrieval } from "../src/retrieval/factory.js";
import { KnowledgeOutlineService } from "../src/knowledge/outlines.js";
import { KnowledgePageWorker } from "../src/knowledge/page-worker.js";
import { KnowledgePageService } from "../src/knowledge/page-service.js";

it("serves fixed inline citations and explicit question actions through the same API for manual materials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-api-")), store = new Store(dir), app = Fastify();
  const repository = registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: join(dir, "agents") });
  try {
    store.capture({ source: "manual", externalId: "plan", title: "发布计划", parts: [{ type: "text", text: "发布前必须核对回滚步骤。" }], context: {} });
    const m = repository.materials()[0]!;
    const document: KnowledgeDocument = { key: m.key, title: "发布准备", summary: "发布约束", category: "requirements", sections: [{ key: "release", title: "发布前", body: "先核对回滚步骤。[[source]]" }], citations: [{ key: "source", label: "发布计划原文", reason: "原文直接说明发布条件", relation: "supports", target: { kind: "material", key: m.key, startLine: 1, endLine: 1 }, quote: "" }], questions: [{ question: "由谁核对？", why: "原文没有责任人", nextStep: "确认负责人", blocking: false, citationKeys: ["source"] }] };
    const article = repository.publish({ version: 1, publication: {role:"article"}, document: bindKnowledgeQuotes(document, new Map([[m.key, m]])), dependencies: [{ kind: "material", key: m.key, digest: m.digest }], generation: { model: "fixture", effort: null, at: "2026-01-01T00:00:00Z", trace: {} }, review: { model: "fixture-reviewer", at: "2026-01-01T00:00:01Z", trace: {}, verdict: "accepted" } });
    const read = await app.inject("/api/knowledge/articles/" + encodeURIComponent(m.key));
    expect(read.json().citations[0]).toMatchObject({ actionable: true, label: "发布计划原文", reason: "原文直接说明发布条件" });
    const c = await app.inject("/api/knowledge/citation?" + new URLSearchParams({ document: m.key, revision: article.revision, citation: "source" }));
    expect(c.json().resolved).toMatchObject({ kind: "material", digest: m.digest });
    store.capture({ source: "manual", externalId: "plan", title: "新计划", parts: [{ type: "text", text: "新的发布内容。" }], context: {} }); repository.refresh();
    const original = await app.inject("/api/knowledge/materials/" + encodeURIComponent(m.key) + "?digest=" + m.digest);
    expect(original.json()).toMatchObject({ text: "发布前必须核对回滚步骤。", current: false });
    const q = (await app.inject("/api/knowledge/questions")).json()[0];
    const task = await app.inject({ method: "POST", url: `/api/knowledge/questions/${q.id}/task` });
    expect(task.json().taskId).toBeTruthy(); expect(store.tasks()).toHaveLength(1);
    const noModel = await app.inject({ method: "POST", url: "/api/knowledge/analyze", payload: { revisionIds: [m.revisionId] } });
    expect(noModel.statusCode).toBe(503);
    const image = store.capture({ source: "manual", externalId: "diagram", title: "历史图像", parts: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", label: "原图" }], context: {} });
    const assetId = (image.revision.parts[0] as { assetId: string }).assetId;
    store.capture({ source: "manual", externalId: "diagram", title: "新材料", parts: [{ type: "text", text: "图片已被新版本替代" }], context: {} });
    const historicalImage = await app.inject("/api/knowledge/assets/" + assetId);
    expect(historicalImage.statusCode).toBe(200);
    expect(historicalImage.headers["content-type"]).toContain("image/png");
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("shows a confirmed directory move immediately, searches the new path and retains the fixed old publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-directory-")), store = new Store(dir), app = Fastify();
  const retrieval = createRetrieval(store.db), repository = registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: dir, retrieval: retrieval.retrieval });
  const worker = new KnowledgePageWorker(repository), outlines = new KnowledgeOutlineService(repository, new KnowledgePageService(repository, worker, true));
  try {
    store.capture({ source: "manual", externalId: "activity", title: "费用约定", parts: [{ type: "text", text: "费用八十元，含材料。" }], context: {} }, { learning: false, notify: false });
    const m = repository.materials()[0]!;
    const old = { key: "workshop", title: "工作坊费用", reader: "参加者", goal: "了解费用", scenario: "参加工作坊", kind: "reference" as const, order: 5, questions: ["费用多少？"], entryPaths: [], topicPath: ["旧目录"], materialKeys: [m.key] };
    repository.savePlan(old, true);
    const article = repository.publish({ version: 1, reading: old, publication: { role: "reference" },
      document: bindKnowledgeQuotes({ key: old.key, title: old.title, summary: "了解费用", category: "活动", topicPath: old.topicPath,
        sections: [{ key: "cost", title: "费用", body: "费用八十元，含材料。[[source]]" }],
        citations: [{ key: "source", label: "费用约定", reason: "原文约定", relation: "supports", target: { kind: "material", key: m.key, startLine: 1, endLine: 1 }, quote: "" }], questions: [] }, new Map([[m.key, m]])),
      dependencies: [{ kind: "material", key: m.key, digest: m.digest }], generation: { model: "fixture", effort: null, at: new Date().toISOString(), trace: {} }, review: { model: "fixture", at: new Date().toISOString(), verdict: "accepted", trace: {} } });
    const { key: _key, order: _order, ...content } = old;
    const draft = outlines.create({ title: "活动知识", reader: old.reader, goal: old.goal, topicPath: ["新目录"], materialKeys: [m.key], contextIds: [],
      pages: [{ ...content, id: "existing", existingKey: old.key, title: "参加前的费用准备", topicPath: ["新目录", "工作坊"], contextIds: [] }] });
    // Editing data cannot include formal Wiki identities or ordering fields.
    expect(draft.state).toBe("editing");
    outlines.apply(draft.id, draft.version);
    const catalog = (await app.inject("/api/knowledge/articles")).json();
    expect(catalog.articles[0]).toMatchObject({ title: "参加前的费用准备", publishedTitle: old.title, planChanged: true, topicPath: ["新目录", "工作坊"], reading: { order: 0 } });
    const search = (topic: string) => app.inject("/api/knowledge/search?" + new URLSearchParams({ q: "费用", topic: JSON.stringify([topic]) }));
    expect((await search("新目录")).json().map((hit: { key: string }) => hit.key)).toEqual([old.key]);
    expect((await search("旧目录")).json()).toEqual([]);
    const fixed = (await app.inject("/api/knowledge/articles/" + old.key + "?revision=" + article.revision)).json();
    expect(fixed).toMatchObject({ title: old.title, document: { topicPath: ["旧目录"] } });
    expect(fixed.citations[0].resolved.digest).toBe(m.digest);
  } finally { await app.close(); await outlines.stop(); await worker.stop(); await retrieval.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("persists independent topic paths, scopes discovery and returns one best section per article", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-topics-"));
  let store = new Store(dir), app = Fastify();
  let repository = registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: dir });
  try {
    const add = (key: string, title: string, path: string[], text: string) => {
      const captured = store.capture({ source: "manual", externalId: key, title, parts: [{ type: "text", text }], context: {} });
      const m = repository.materials().find(m => m.revisionId === captured.revision.id)!;
      repository.publish({ version: 1, publication: {role:"article"}, document: bindKnowledgeQuotes({ key, title, topicPath: path, category: path[0]!, summary: text,
        sections: [{ key: "practice", title: "练习", body: text + " [[source]]" }, { key: "review", title: "回顾", body: "记录练习结果。[[source]]" }],
        citations: [{ key: "source", label: title, reason: "练习安排", relation: "supports", target: { kind: "material", key: m.key, startLine: 1, endLine: 1 }, quote: "" }], questions: [] }, new Map([[m.key, m]])),
        dependencies: [{ kind: "material", key: m.key, digest: m.digest }], generation: { model: "fixture", effort: null, at: "2026-10-02", trace: {} }, review: { model: "fixture", at: "2026-10-02", verdict: "accepted", trace: {} } });
    };
    add("arbitrary-english", "跟读练习", ["语言学习", "英语", "听说"], "用录音进行短句练习。");
    add("unrelated-camera", "快门练习", ["摄影", "运动拍摄"], "用不同快门进行拍摄练习。");
    await app.close(); store.close();
    store = new Store(dir); app = Fastify(); repository = registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: dir, repository: new KnowledgeRepository(store) });
    const catalog = (await app.inject("/api/knowledge/articles")).json().articles;
    expect(catalog.find((a: { key: string }) => a.key === "arbitrary-english").topicPath).toEqual(["语言学习", "英语", "听说"]);
    expect(catalog.every((a: object) => !("children" in a))).toBe(true);
    const results = (await app.inject("/api/knowledge/search?q=" + encodeURIComponent("练习"))).json();
    expect(results.map((a: { key: string }) => a.key).sort()).toEqual(["arbitrary-english", "unrelated-camera"]);
    const scoped = (await app.inject("/api/knowledge/search?" + new URLSearchParams({ q: "练习", topic: JSON.stringify(["语言学习"]) }))).json();
    expect(scoped.map((a: { key: string }) => a.key)).toEqual(["arbitrary-english"]);
  } finally { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
