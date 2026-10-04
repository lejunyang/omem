import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository, bindKnowledgeQuotes } from "../src/knowledge/repository.js";
import { KnowledgePageWorker } from "../src/knowledge/page-worker.js";
import type { WikiPageBrief } from "../../../packages/contracts/src/knowledge.js";

const material = (externalId: string, text: string) => ({ source: "manual" as const, externalId, title: externalId, parts: [{ type: "text" as const, text }], context: {} });

it("saves explicit membership with capture, preserves it on source updates, and changes it without rewriting originals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-context-api-"));
  const built = await buildApp({ dataDir: dir, agentCwd: dir, host: "127.0.0.1", port: 0, captureRoots: [], notifications: { mode: "instant" }, profiles: [] });
  try {
    const context = (await built.app.inject({ method: "POST", url: "/api/contexts", payload: { name: "读书小组", kind: "project", description: "每月活动安排" } })).json();
    const response = await built.app.inject({ method: "POST", url: "/api/captures", payload: { ...material("meeting", "周五讨论"), contextIds: [context.id] } });
    expect(response.statusCode).toBe(200);
    const original = response.json().revision;
    const changed = (await built.app.inject({ method: "POST", url: "/api/captures", payload: material("meeting", "改为周六讨论") })).json().revision;
    expect(changed.sourceId).toBe(original.sourceId);
    expect(built.store.contexts.forSource(original.sourceId)).toEqual([context.id]);
    expect((await built.app.inject({ method: "PUT", url: `/api/sources/${original.sourceId}/contexts`, payload: { contextIds: [] } })).statusCode).toBe(200);
    expect(built.store.revision(original.id)?.parts[0]).toMatchObject({ text: "周五讨论" });
    expect(built.store.contexts.forSource(original.sourceId)).toEqual([]);
    expect((await built.app.inject({ method: "POST", url: "/api/captures", payload: { ...material("invalid", "不应保存"), contextIds: ["unknown"] } })).statusCode).toBe(400);
    expect(built.store.list().some(s => s.title === "invalid")).toBe(false);
  } finally { await built.app.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("follows new and removed project sources after restart without admitting similar unlinked content or rewriting history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-context-follow-"));
  let store = new Store(dir), repository = new KnowledgeRepository(store);
  const project = store.contexts.create({ name: "活动", kind: "project", description: "报名安排" });
  const first = store.capture(material("agreement", "每人费用 80 元，不含交通费。"), { contextIds: [project.id] });
  const plan: WikiPageBrief = { key: "activity", title: "参加活动", order: 0, kind: "how-to", reader: "参加者", goal: "了解费用和报名", scenario: "报名",
    questions: ["怎样报名"], entryPaths: [], materialKeys: [], contextIds: [project.id] };
  repository.savePlan(plan, true);
  const run = async (brief: WikiPageBrief) => {
    const materials = repository.materialsForPlan(brief);
    const citations = materials.map((m, i) => ({ key: `source${i}`, label: m.title, reason: "安排", relation: "supports" as const, quote: "",
      target: { kind: "material" as const, key: m.key, startLine: 1, endLine: 1 } }));
    return repository.publish({ version: 1, reading: brief, selection: { materialKeys: materials.map(m => m.key).sort() }, publication: { role: "article" },
      document: bindKnowledgeQuotes({ key: brief.key, title: brief.title, summary: "安排", category: "活动", questions: [], citations,
        sections: [{ key: "arrangement", title: "参加方式", body: materials.map((m, i) => `${m.text} [[source${i}]]`).join("\n\n") }] }, new Map(materials.map(m => [m.key, m]))),
      dependencies: materials.map(m => ({ kind: "material" as const, key: m.key, digest: m.digest })),
      generation: { model: "fixture", effort: null, at: new Date().toISOString(), trace: {} },
      review: { model: "fixture", at: new Date().toISOString(), trace: {}, verdict: "accepted" },
    }, brief).revision;
  };
  let worker = new KnowledgePageWorker(repository, { run });
  try {
    const original = await run(plan);
    worker.setEnabled(plan.key, true);
    store.capture(material("similar", "同名活动费用 999 元。"));
    worker.observe(); expect(worker.busy()).toBe(false);
    const added = store.capture(material("deadline", "报名截止周四下午，由小林收集。"), { contextIds: [project.id] });
    worker.observe(); expect(worker.status(plan.key)?.state).toBe("queued");
    await worker.stop(); store.close();
    store = new Store(dir); repository = new KnowledgeRepository(store); worker = new KnowledgePageWorker(repository, { run });
    await worker.processOne(); worker.observe();
    const updated = repository.get(plan.key)!;
    expect(updated.document.sections[0]?.body).toContain("周四下午");
    expect(updated.document.sections[0]?.body).not.toContain("999");
    expect(repository.pages()[0]?.plan?.materialKeys).toEqual([]);
    expect(updated.selection?.materialKeys).toEqual(["manual:agreement", "manual:deadline"]);
    store.tx(() => store.contexts.setForSource(added.revision.sourceId, []));
    expect(() => repository.publish(updated, plan)).toThrow("项目或主题的材料在整理期间发生变化");
    worker.observe(); await worker.processOne(); worker.observe();
    expect(repository.get(plan.key)?.document.sections[0]?.body).not.toContain("周四下午");
    expect(repository.get(plan.key, original)?.document.sections[0]?.body).toContain("80 元");
    expect(store.revision(added.revision.id)).toBeTruthy();
    expect(store.contexts.forSource(first.revision.sourceId)).toEqual([project.id]);
    expect(worker.busy()).toBe(false);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
