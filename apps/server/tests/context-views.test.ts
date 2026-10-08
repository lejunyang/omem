import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../src/knowledge/repository.js";
import { KnowledgePageWorker } from "../src/knowledge/page-worker.js";
import { KnowledgePageService } from "../src/knowledge/page-service.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("includes and revokes original message corrections without assigning them to unrelated projects", async () => {
  const s = setup();
  const input = s.capture("proposal", "建议小林负责，尚未决定。");
  s.store.db
    .prepare(
      "INSERT INTO personal_lark_messages(id,chat_id,chat_name,digest,raw,revision_id,observed_at,updated_at) VALUES(?,?,?,'test','{}',?,?,?)",
    )
    .run(
      "proposal",
      "oc_view",
      "项目讨论",
      input.revision.id,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const view = s.pages.views.apply(s.context.id, "start");
  await s.worker.processOne();
  const id = randomUUID();
  const correction = s.store.messageFeedback.save("proposal", {
    requestId: id,
    text: "已经确认小周负责，小林只提供说明。",
    scope: "message",
  });
  const plan = s.repository.pages().find((p) => p.key === view.key)!.plan!;
  expect(
    s.repository
      .materialsForPlan(plan)
      .some((m) => m.revisionId === correction.revisionId),
  ).toBe(true);
  expect(s.pages.views.read(s.context.id).current).toBe(false);
  s.store.messageFeedback.revoke(id);
  expect(
    s.repository
      .materialsForPlan(plan)
      .some((m) => m.revisionId === correction.revisionId),
  ).toBe(false);
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-context-view-"));
  let store = new Store(dir),
    repository = new KnowledgeRepository(store);
  let runs = 0,
    fail = false;
  let worker: KnowledgePageWorker, pages: KnowledgePageService;
  const open = () => {
    worker = new KnowledgePageWorker(repository, {
      run: async (plan) => {
        runs++;
        if (fail) throw Error("agent unavailable");
        // Test host lifecycle, not model understanding.
        const materials = repository.materialsForPlan(plan),
          m = materials[0]!;
        const article = repository.publish(
          {
            version: 1,
            reading: plan,
            publication: { role: "article" },
            selection: {
              materialKeys: materials.map((m) => m.key).sort(),
              materialDigests: materials
                .map((m) => ({ key: m.key, digest: m.digest }))
                .sort((a, b) => a.key.localeCompare(b.key)),
            },
            document: bindKnowledgeQuotes(
              {
                key: plan.key,
                title: plan.title,
                summary: m.text,
                category: "项目理解",
                sections: [
                  {
                    key: "now",
                    title: "当前安排",
                    body: m.text + " [[source]]",
                  },
                ],
                citations: [
                  {
                    key: "source",
                    label: m.title,
                    reason: "约定",
                    relation: "supports",
                    quote: "",
                    target: {
                      kind: "material",
                      key: m.key,
                      startLine: 1,
                      endLine: 1,
                    },
                  },
                ],
                questions: [],
              },
              new Map(materials.map((m) => [m.key, m])),
            ),
            dependencies: [{ kind: "material", key: m.key, digest: m.digest }],
            generation: {
              model: "fixture",
              effort: null,
              at: new Date().toISOString(),
              trace: {},
            },
            review: {
              model: "fixture",
              at: new Date().toISOString(),
              trace: {},
              verdict: "accepted",
            },
          },
          plan,
        );
        return article.revision;
      },
    });
    pages = new KnowledgePageService(repository, worker, true);
  };
  open();
  const context = store.contexts.create({
    name: "研讨会",
    kind: "project",
    description: "安排与变化",
  });
  const capture = (id: string, text: string, contextId = context.id) =>
    store.capture(
      {
        source: "manual",
        externalId: id,
        title: id,
        parts: [{ type: "text", text }],
        context: {},
      },
      { contextIds: [contextId], learning: false, notify: false },
    );
  cleanups.push(async () => {
    await worker.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    context,
    capture,
    get store() {
      return store;
    },
    get repository() {
      return repository;
    },
    get worker() {
      return worker;
    },
    get pages() {
      return pages;
    },
    get runs() {
      return runs;
    },
    setFail(value: boolean) {
      fail = value;
    },
    async restart() {
      await worker.stop();
      store.close();
      store = new Store(dir);
      repository = new KnowledgeRepository(store);
      open();
    },
  };
}

it("keeps one view across repeated requests and restart, while read never queues work", async () => {
  const s = setup();
  s.capture("agreement", "周五举行，费用 80 元含材料费。");
  expect(s.pages.views.read(s.context.id).key).toBeNull();
  expect(s.store.jobs.list()).toHaveLength(0);
  const first = s.pages.views.apply(s.context.id, "start");
  expect(s.pages.views.apply(s.context.id, "start").key).toBe(first.key);
  expect(s.store.jobs.list()).toHaveLength(1);
  await s.worker.processOne();
  expect(s.pages.views.read(s.context.id).current).toBe(true);
  const before = s.store.jobs.list().length;
  s.pages.views.read(s.context.id);
  s.pages.views.list();
  s.worker.observe();
  expect(s.store.jobs.list()).toHaveLength(before);
  await s.restart();
  expect(s.pages.views.read(s.context.id).key).toBe(first.key);
  expect(s.pages.views.read(s.context.id).current).toBe(true);
});

it("detects uncited new events immediately, isolates same-name projects and preserves old content on failure", async () => {
  const s = setup();
  s.capture("agreement", "周五举行，费用含材料费。");
  const first = s.pages.views.apply(s.context.id, "start");
  await s.worker.processOne();
  const old = s.pages.views.read(s.context.id).revision;
  const other = s.store.contexts.create({
    name: s.context.name,
    kind: "project",
    description: "其他项目",
  });
  s.capture("other", "周日举行", other.id);
  expect(s.pages.views.read(s.context.id).current).toBe(true);
  s.capture("change", "改到周六，费用条件不变。");
  expect(s.pages.views.read(s.context.id).current).toBe(false);
  // The ordinary reading page must also show old content as awaiting update.
  expect(s.repository.get(first.key!)?.current).toBe(false);
  s.setFail(true);
  s.worker.observe();
  await s.worker.processOne();
  s.worker.observe();
  const failed = s.pages.views.read(s.context.id);
  expect(failed.maintenance?.state).toBe("failed");
  expect(failed.revision).toBe(old);
  expect(failed.document?.summary).toContain("周五");
  const count = s.runs;
  await s.worker.processOne();
  expect(s.runs).toBe(count);
  s.setFail(false);
  s.pages.views.apply(s.context.id, "refresh");
  await s.worker.processOne();
  expect(s.pages.views.read(s.context.id).current).toBe(true);
  expect(s.repository.get(first.key!)?.current).toBe(true);
  expect(s.pages.views.read(s.context.id).key).toBe(first.key);
});

it("pauses automatic work, resumes the latest scope and rolls back unavailable/empty starts", async () => {
  const s = setup();
  s.capture("agreement", "周五举行。");
  s.pages.views.apply(s.context.id, "start");
  await s.worker.processOne();
  s.pages.views.apply(s.context.id, "pause");
  s.capture("change", "改到周六。");
  s.worker.observe();
  expect(s.worker.busy()).toBe(false);
  expect(s.pages.views.read(s.context.id).current).toBe(false);
  s.pages.views.apply(s.context.id, "resume");
  expect(s.worker.busy()).toBe(true);
  await s.worker.processOne();
  expect(s.pages.views.read(s.context.id).current).toBe(true);
  const empty = s.store.contexts.create({
    name: "空项目",
    kind: "project",
    description: "",
  });
  expect(() => s.pages.views.apply(empty.id, "start")).toThrow("先保存材料");
  const unavailable = new KnowledgePageService(s.repository, s.worker, false);
  expect(() => unavailable.views.apply(empty.id, "start")).toThrow(
    "配置 Agent",
  );
  expect(s.pages.views.read(empty.id).key).toBeNull();
});
