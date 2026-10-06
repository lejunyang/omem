import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiPageBrief } from "../../../packages/contracts/src/knowledge.js";
import { Store } from "../src/store.js";
import { KnowledgeRepository, bindKnowledgeQuotes } from "../src/knowledge/repository.js";
import { KnowledgePageWorker } from "../src/knowledge/page-worker.js";

const plan: WikiPageBrief = {
  key: "workshop", title: "工作坊安排", order: 0, kind: "reference", reader: "参加者",
  goal: "了解当前费用", scenario: "参加工作坊", questions: ["费用是多少？"], entryPaths: [], materialKeys: ["manual:agreement"],
};
const capture = (store: Store, amount: number, externalId = "agreement") => store.capture({
  source: "manual", externalId, title: "费用约定", parts: [{ type: "text", text: `费用 ${amount} 元，含材料费，不含交通费。` }], context: {},
});

it("waits for a quiet interval before automatic work, while explicit requests start immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-page-settle-"));
  const store = new Store(dir), repository = new KnowledgeRepository(store);
  const worker = new KnowledgePageWorker(repository, { settleMs: 12000 });
  vi.useFakeTimers();
  try {
    capture(store, 80); repository.savePlan(plan, true); publish(repository); worker.setEnabled(plan.key, true);
    capture(store, 120); worker.observe();
    vi.advanceTimersByTime(11000); worker.observe();
    expect(worker.busy()).toBe(false);
    capture(store, 160); worker.observe();
    vi.advanceTimersByTime(11000); worker.observe();
    expect(worker.busy()).toBe(false);
    vi.advanceTimersByTime(1000); worker.observe();
    expect(worker.busy()).toBe(true);
    expect(store.jobs.list().filter(j => j.kind === "knowledge:maintain-page")).toHaveLength(1);
    worker.setEnabled(plan.key, false);
    capture(store, 200); worker.request(plan.key);
    expect(worker.busy()).toBe(true);
  } finally { vi.useRealTimers(); await worker.stop(); store.close(); rmSync(dir, {recursive:true,force:true}); }
});
// This publisher tests queue/host behavior, not model understanding.
function publish(repository: KnowledgeRepository) {
  const material = repository.materials().find(m => m.key === "manual:agreement")!;
  return repository.publish({
    version: 1, reading: plan, publication: { role: "reference" },
    document: bindKnowledgeQuotes({ key: plan.key, title: plan.title, summary: material.text, category: "安排",
      sections: [{ key: "cost", title: "费用", body: material.text + " [[source]]" }],
      citations: [{ key: "source", label: "费用约定", reason: "当前约定", relation: "supports", quote: "",
        target: { kind: "material", key: material.key, startLine: 1, endLine: 1 } }], questions: [],
    }, new Map([[material.key, material]])),
    dependencies: [{ kind: "material", key: material.key, digest: material.digest }],
    generation: { model: "fixture", effort: null, at: new Date().toISOString(), trace: {} },
    review: { model: "fixture", at: new Date().toISOString(), trace: {}, verdict: "accepted" },
  });
}

it("coalesces selected-source updates, resumes after restart and keeps readable history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-page-follow-"));
  let store = new Store(dir), repository = new KnowledgeRepository(store);
  let runs = 0;
  const runner = () => new KnowledgePageWorker(repository, { run: async () => { runs++; return publish(repository).revision; } });
  let worker = runner();
  try {
    capture(store, 80); repository.savePlan(plan, true);
    const initial = publish(repository);
    worker.setEnabled(plan.key, true);
    capture(store, 999, "unselected"); worker.observe();
    expect(worker.busy()).toBe(false);
    capture(store, 120); worker.observe();
    capture(store, 160); worker.observe();
    expect(store.jobs.list().filter(j => j.kind === "knowledge:maintain-page")).toHaveLength(1);
    expect(worker.status(plan.key)?.state).toBe("queued");
    await worker.stop(); store.close();
    store = new Store(dir); repository = new KnowledgeRepository(store); worker = runner();
    expect(worker.status(plan.key)?.enabled).toBe(true);
    await worker.processOne(); worker.observe();
    expect(runs).toBe(1);
    expect(repository.get(plan.key)?.document.summary).toContain("160 元");
    expect(repository.get(plan.key, initial.revision)?.document.summary).toContain("80 元");
    expect(worker.status(plan.key)?.state).toBe("published");
    expect(worker.busy()).toBe(false);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("preserves the old page on failure without looping; a retry or new source change can resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-page-retry-"));
  const store = new Store(dir), repository = new KnowledgeRepository(store);
  let fail = true, changeDuringRun = false;
  const worker = new KnowledgePageWorker(repository, { run: async () => {
    if (changeDuringRun) { capture(store, 200); changeDuringRun = false; }
    if (fail) throw Error("模型连接暂不可用");
    return publish(repository).revision;
  } });
  try {
    capture(store, 80); repository.savePlan(plan, true);
    const initial = publish(repository);
    worker.setEnabled(plan.key, true);
    capture(store, 120); worker.observe();
    await worker.processOne(); worker.observe(); worker.observe();
    expect(worker.status(plan.key)).toMatchObject({ state: "failed", error: "模型连接暂不可用" });
    expect(repository.get(plan.key)?.revision).toBe(initial.revision);
    expect(store.jobs.list().filter(j => j.kind === "knowledge:maintain-page")).toHaveLength(1);
    worker.request(plan.key); changeDuringRun = true;
    await worker.processOne(); worker.observe();
    expect(worker.status(plan.key)?.state).toBe("queued");
    fail = false;
    await worker.processOne(); worker.observe();
    expect(repository.get(plan.key)?.document.summary).toContain("200 元");
    expect(worker.busy()).toBe(false);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("stops queued automatic work when disabled while retaining explicitly requested work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omem-page-disable-"));
  const store = new Store(dir), repository = new KnowledgeRepository(store);
  let runs = 0;
  const worker = new KnowledgePageWorker(repository, { run: async () => { runs++; return publish(repository).revision; } });
  try {
    capture(store, 80); repository.savePlan(plan, true); publish(repository);
    worker.setEnabled(plan.key, true);
    capture(store, 120); worker.observe();
    worker.setEnabled(plan.key, false); await worker.processOne();
    expect(runs).toBe(0);
    worker.request(plan.key); worker.setEnabled(plan.key, false);
    await worker.processOne();
    expect(runs).toBe(1);
    capture(store, 160); worker.observe();
    expect(worker.busy()).toBe(false);
  } finally { await worker.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
