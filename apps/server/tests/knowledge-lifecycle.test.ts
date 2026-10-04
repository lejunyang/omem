import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../src/knowledge/repository.js";
import { UnifiedRetrieval } from "../src/retrieval/unified.js";
import type {
  KnowledgeArtifact,
  WikiPageBrief,
} from "../../../packages/contracts/src/knowledge.js";

const disposers: (() => void)[] = [];
afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-page-lifecycle-"));
  disposers.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  disposers.push(() => store.close());
  const repository = new KnowledgeRepository(store);
  const capture = (text: string) =>
    store.capture({
      source: "manual",
      externalId: "meeting",
      title: "活动约定.md",
      parts: [{ type: "text", text }],
      context: {},
    });
  capture("# 活动约定\n## 预算\n预算是八十元。\n\n## 地点\n地点在图书馆。");
  const source = repository.materials()[0]!;
  const artifact: KnowledgeArtifact = {
    version: 1,
    publication: { role: "article" },
    document: {
      key: "a-topic",
      title: "春游安排",
      summary: "安排说明",
      category: "生活",
      topicPath: ["活动"],
      sections: [
        { key: "budget", title: "费用", body: "春游经费是八十元。[[budget]]" },
        { key: "venue", title: "集合", body: "春游集合在图书馆。[[venue]]" },
      ],
      citations: [
        ...([
          ["budget", 3],
          ["venue", 6],
        ] as const),
      ].map(([key, line]) => ({
        key,
        label: key,
        reason: "活动约定",
        relation: "supports",
        target: {
          kind: "material",
          key: source.key,
          startLine: line,
          endLine: line,
        },
        quote: "",
      })),
      questions: [],
    },
    dependencies: [
      { kind: "material", key: source.key, digest: source.digest },
    ],
    generation: {
      model: "test",
      effort: null,
      at: new Date().toISOString(),
      trace: {},
    },
    review: {
      model: "test-review",
      at: new Date().toISOString(),
      trace: {},
      verdict: "accepted",
    },
  };
  bindKnowledgeQuotes(artifact.document, new Map([[source.key, source]]));
  return { store, repository, capture, source, artifact };
}

it("keeps unaffected chapters searchable and citations pinned when surrounding material moves", async () => {
  const { store, repository, capture, artifact, source } = setup();
  const original = repository.publish(artifact);
  capture(
    "# 活动约定\n\n这里只更新导读。\n## 预算\n预算是八十元。\n\n## 地点\n地点在图书馆。",
  );
  repository.refresh();
  expect(repository.get(artifact.document.key)?.current).toBe(true);
  const retrieval = new UnifiedRetrieval(store.db);
  const hits = await retrieval.search({
    text: "春游集合",
    kinds: ["knowledge"],
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.references[0]?.revisionId).toBe(source.revisionId);
  capture(
    "# 活动约定\n## 预算\n预算改为一百二十元。\n\n## 地点\n地点在图书馆。",
  );
  repository.refresh();
  const page = repository.get(artifact.document.key)!;
  expect(repository.statusReader()(page)).toMatchObject({
    budget: { state: "needs-review" },
    venue: { state: "current" },
  });
  expect(repository.published().map((a) => a.revision)).toContain(
    original.revision,
  );
  const remaining = await retrieval.search({
    text: "春游集合",
    kinds: ["knowledge"],
  });
  expect(
    remaining.some(
      (h) => h.target.kind === "knowledge" && h.target.section === "venue",
    ),
  ).toBe(true);
  expect(
    (await retrieval.search({ text: "春游经费", kinds: ["knowledge"] })).some(
      (h) => h.target.kind === "knowledge" && h.target.section === "budget",
    ),
  ).toBe(false);
  await retrieval.close();
});

it("stores page plans independently and keeps internal file notes out of publication and recall", async () => {
  const { store, repository, artifact } = setup();
  const brief: WikiPageBrief = {
    key: "planned-topic",
    title: "活动如何安排",
    order: 0,
    kind: "explanation",
    reader: "参加者",
    goal: "知道下一步",
    scenario: "筹备活动",
    questions: ["如何安排？"],
    entryPaths: [],
  };
  repository.savePlan(brief);
  repository.pageState(brief.key, "failed", "model unavailable");
  expect(repository.pages()).toContainEqual(
    expect.objectContaining({ key: brief.key, plan: brief, state: "failed" }),
  );
  artifact.publication = { role: "note" };
  repository.publish(artifact);
  expect(repository.published()).toEqual([]);
  expect(repository.get(artifact.document.key)).not.toBeNull();
  const retrieval = new UnifiedRetrieval(store.db);
  expect(
    await retrieval.search({ text: "春游", kinds: ["knowledge"] }),
  ).toEqual([]);
  await retrieval.close();
});

it("reviews only the chapter whose uncited premise changed", async () => {
  const { store, repository, capture, artifact, source } = setup();
  artifact.document.sections[1]!.reviewSources = [
    {
      key: source.key,
      startLine: 3,
      endLine: 3,
      reason: "集合方案以原预算为前提",
    },
  ];
  const page = repository.publish(artifact);
  capture(
    "# 活动约定\n## 预算\n预算改为一百二十元。\n\n## 地点\n地点在图书馆。",
  );
  repository.refresh();
  expect(repository.statusReader()(page).venue).toMatchObject({
    state: "needs-review",
    reason: "背景前提已有变化：集合方案以原预算为前提",
  });
  const retrieval = new UnifiedRetrieval(store.db);
  expect(
    await retrieval.search({ text: "春游集合", kinds: ["knowledge"] }),
  ).toEqual([]);
  await retrieval.close();
});
