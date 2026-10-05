import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { KnowledgeRepository } from "../src/knowledge/repository.js";
import { MaterialDescriptionWorker } from "../src/source-profile/description-worker.js";
import { UnifiedRetrieval } from "../src/retrieval/unified.js";
import type { MaterialDescription } from "../../../packages/contracts/src/material-description.js";

const opened: Store[] = [], workers: MaterialDescriptionWorker[] = [], directories: string[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop();
  for (const store of opened.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const description = (role: MaterialDescription["role"] = "plan"): MaterialDescription => ({
  role, status: role === "plan" ? "proposed" : "current", summary: "配送重试", topics: [], scope: null,
  validFrom: null, validUntil: null, concepts: [{ label: "失败重新投递", aliases: ["配送重试"], startLine: 1, endLine: 1 }], basis: "阅读本版正文",
});
function setup(directory?: string) {
  if (!directory) { directory = mkdtempSync(join(tmpdir(), "omem-description-follow-")); directories.push(directory); }
  const store = new Store(directory); opened.push(store);
  return { store, directory, repository: new KnowledgeRepository(store) };
}
const capture = (store: Store, text: string, key = "delivery") => store.capture({
  source: "manual", externalId: key, title: key, parts: [{ type: "text", text }], context: {},
}).revision;
function worker(repository: KnowledgeRepository, options: ConstructorParameters<typeof MaterialDescriptionWorker>[1]) {
  const value = new MaterialDescriptionWorker(repository, options); workers.push(value); return value;
}

it("resumes followed material after restart, coalesces edits, and refreshes searchable metadata without importing old concepts", async () => {
  const first = setup();
  const v1 = capture(first.store, "拟议：配送失败后以后增加重试。");
  first.store.descriptions.save(v1.id, description(), "user", 0);
  const initial = worker(first.repository, {});
  initial.setEnabled(v1.id, true);
  const v2 = capture(first.store, "已经实现失败重试。");
  initial.observe();
  expect(initial.status(v2.id).state).toBe("queued");
  first.store.close(); opened.splice(opened.indexOf(first.store), 1);
  const second = setup(first.directory), read: string[] = [];
  const resumed = worker(second.repository, { run: async material => {
    read.push(material.revisionId);
    expect(second.store.descriptions.previous(material.revisionId)?.author).toBe("user");
    expect(second.store.descriptions.get(material.revisionId)).toBeNull();
    second.store.descriptions.save(material.revisionId, { ...description("implementation"), concepts: [] }, "model", 0);
  } });
  const v3 = capture(second.store, "配送失败后重试已经上线，可主动暂停。");
  const untracked = capture(second.store, "另外一份尚未整理的原件。", "other");
  resumed.observe(); await resumed.processOne(); resumed.observe();
  expect(read).toEqual([v3.id]);
  expect(resumed.status(v3.id)).toMatchObject({ state: "done", enabled: true });
  expect(second.store.descriptions.get(v2.id)).toBeNull();
  expect(second.store.descriptions.get(untracked.id)).toBeNull();
  expect(second.store.descriptions.get(v1.id)?.description.role).toBe("plan");
  const retrieval = new UnifiedRetrieval(second.store.db);
  try {
    const hits = await retrieval.search({ text: "配送失败重试", materialRoles: ["implementation"] });
    expect(hits.some(h => h.target.kind === "source" && h.target.revisionId === v3.id)).toBe(true);
    expect(await retrieval.search({ text: "配送失败重试", materialRoles: ["plan"] })).toEqual([]);
  } finally { await retrieval.close(); }
  expect(await resumed.processOne()).toMatchObject({ processed: false });
});

it("retains failure without retrying forever, supports explicit retry, and preserves a correction made while queued", async () => {
  const { store, repository } = setup();
  const v1 = capture(store, "配送方案。"); store.descriptions.save(v1.id, description(), "model", 0);
  let attempts = 0;
  const runner = worker(repository, { run: async () => { attempts++; throw Error("Agent unavailable"); } });
  runner.setEnabled(v1.id, true);
  const v2 = capture(store, "配送方案修订。"); runner.observe(); await runner.processOne();
  expect(runner.status(v2.id)).toMatchObject({ state: "failed", error: "Agent unavailable" });
  runner.observe(); await runner.processOne(); expect(attempts).toBe(1);
  runner.request(v2.id);
  store.descriptions.save(v2.id, description("reference"), "user", 0);
  await runner.processOne(); expect(attempts).toBe(1);
  expect(store.descriptions.get(v2.id)?.author).toBe("user");
  runner.setEnabled(v2.id, false);
  const v3 = capture(store, "停止自动整理后再换版。"); runner.observe(); await runner.processOne();
  expect(store.descriptions.get(v3.id)).toBeNull();
});

it("does not enroll imported descriptions and continues to the newest revision when a source changes during analysis", async () => {
  const { store, repository } = setup();
  const imported = capture(store, "已有说明。"); store.descriptions.save(imported.id, description(), "model", 0);
  const v2 = capture(store, "拟议调整。");
  let calls = 0, v3 = "";
  const runner = worker(repository, { run: async material => {
    if (++calls === 1) v3 = capture(store, "新方案已实施。").id;
    store.descriptions.save(material.revisionId, description(calls === 1 ? "plan" : "implementation"), "model", 0);
  } });
  runner.observe(); expect(await runner.processOne()).toMatchObject({ processed: false });
  runner.setEnabled(v2.id, true); await runner.processOne();
  runner.observe(); await runner.processOne();
  expect(calls).toBe(2);
  expect(store.descriptions.get(v2.id)?.description.role).toBe("plan");
  expect(store.descriptions.get(v3)?.description.role).toBe("implementation");
});
