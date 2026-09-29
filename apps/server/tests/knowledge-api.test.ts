import Fastify from "fastify";
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { registerKnowledgeRoutes } from "../src/knowledge/api.js";
import { bindKnowledgeQuotes } from "../src/knowledge/repository.js";
import type { KnowledgeDocument } from "../../../packages/contracts/src/knowledge.js";

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
