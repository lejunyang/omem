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

it("serves fixed inline citations and explicit question actions through the same API for manual materials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-api-")), store = new Store(dir), app = Fastify();
  const repository = registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: join(dir, "agents") });
  try {
    store.capture({ source: "manual", externalId: "plan", title: "发布计划", parts: [{ type: "text", text: "发布前必须核对回滚步骤。" }], context: {} });
    const m = repository.materials()[0]!;
    const document: KnowledgeDocument = { key: m.key, title: "发布准备", summary: "发布约束", category: "requirements", sections: [{ key: "release", title: "发布前", body: "先核对回滚步骤。[[source]]" }], citations: [{ key: "source", label: "发布计划原文", reason: "原文直接说明发布条件", relation: "supports", target: { kind: "material", key: m.key, startLine: 1, endLine: 1 }, quote: "" }], questions: [{ question: "由谁核对？", why: "原文没有责任人", nextStep: "确认负责人", blocking: false, citationKeys: ["source"] }] };
    const article = repository.publish({ version: 1, document: bindKnowledgeQuotes(document, new Map([[m.key, m]])), dependencies: [{ kind: "material", key: m.key, digest: m.digest }], generation: { model: "fixture", effort: null, at: "2026-01-01T00:00:00Z", trace: {} }, review: { model: "fixture-reviewer", at: "2026-01-01T00:00:01Z", trace: {}, verdict: "accepted" } });
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

it("persists independent topic paths, scopes discovery and returns one best section per article", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-topics-"));
  let store = new Store(dir), app = Fastify();
  let repository = registerKnowledgeRoutes(app, { store, prefix: "/api/knowledge", workspace: dir });
  try {
    const add = (key: string, title: string, path: string[], text: string) => {
      const captured = store.capture({ source: "manual", externalId: key, title, parts: [{ type: "text", text }], context: {} });
      const m = repository.materials().find(m => m.revisionId === captured.revision.id)!;
      repository.publish({ version: 1, document: bindKnowledgeQuotes({ key, title, topicPath: path, category: path[0]!, summary: text,
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
