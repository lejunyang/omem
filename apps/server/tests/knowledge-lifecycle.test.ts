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
import { parseFile } from "../src/code/parse.js";
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

it("compares complete referenced chapters without pulling in a later report, and keeps nested conditions", async () => {
  const { store, repository, capture, artifact } = setup();
  const original = "# 活动约定\n这是参加者的安排。\n## 预算\n预算是八十元。\n### 费用条件\n费用不含交通。\n## 地点\n地点在图书馆。\n## 筹备记录\n已完成首次核对。";
  capture(original);
  const source = repository.materials()[0]!;
  artifact.dependencies = [{ kind: "material", key: source.key, digest: source.digest }];
  artifact.document.citations[0]!.target = { kind: "material", key: source.key, startLine: 2, endLine: 8 };
  artifact.document.citations[1]!.target = { kind: "material", key: source.key, startLine: 8, endLine: 8 };
  bindKnowledgeQuotes(artifact.document, new Map([[source.key, source]]));
  const page = repository.publish(artifact);
  capture(original.replace("已完成首次核对。", "已完成第二次核对，补充了核对记录。"));
  repository.refresh();
  expect(repository.get(page.document.key)?.current).toBe(true);
  const retrieval = new UnifiedRetrieval(store.db);
  try {
    const hits = await retrieval.search({ text: "春游经费", kinds: ["knowledge"] });
    expect(hits.some(hit => hit.target.kind === "knowledge" && hit.target.section === "budget")).toBe(true);
    expect(hits[0]!.references[0]?.revisionId).toBe(source.revisionId);
    // The cited span still includes whole nested chapters, not just its literal quotes.
    capture(original.replace("费用不含交通。", "费用包含交通。"));
    expect(repository.statusReader()(page)).toMatchObject({ budget: { state: "needs-review" }, venue: { state: "current" } });
    // A new chapter inside the referenced span cannot disappear from comparison.
    capture(original.replace("## 地点", "## 参加条件\n仅限提前报名者。\n## 地点"));
    expect(repository.statusReader()(page).budget?.state).toBe("needs-review");
  } finally { await retrieval.close(); }
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

it("clears a satisfied imported plan change while retaining changed source chapters and reader feedback", () => {
  const { store, repository, capture, artifact } = setup();
  const brief: WikiPageBrief = { key: artifact.document.key, title: "活动安排", order: 0,
    kind: "explanation", reader: "参加者", goal: "了解安排", scenario: "参加活动", questions: ["怎么参加？"], entryPaths: [] };
  artifact.reading = brief;
  const original = repository.publish(artifact);
  repository.reconcileImport("test-import", [{key:brief.key,revision:original.revision}]);
  const updated = { ...brief, goal: "知道预算和集合地点" };
  repository.savePlan(updated);
  capture("# 活动约定\n## 预算\n预算是一百二十元。\n\n## 地点\n地点在图书馆。");
  const imported = { ...artifact, reading: updated };
  repository.restoreHistorical(imported, true, "test-import");
  repository.savePlan(updated);
  const states = repository.statusReader()(repository.get(brief.key)!);
  expect(states.budget?.state).toBe("needs-review");
  expect(states.venue?.state).toBe("current");
  expect(store.db.prepare("SELECT * FROM knowledge_invalidations WHERE document_key=?").get(brief.key)).toBeUndefined();
  store.db.prepare("INSERT INTO knowledge_invalidations VALUES(?,?)").run(brief.key,"用户补充了背景，需要重新核对");
  repository.savePlan(updated);
  expect(repository.statusReader()(repository.get(brief.key)!).venue?.state).toBe("needs-review");
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

it("keeps documented code citations current when an unrelated function moves their lines", () => {
  const { store, repository, artifact } = setup();
  const text = "/** 每人预算八十元。 */\nexport const budget = () => 80;\n\n/** 集合地点在图书馆。 */\nexport function venue() { return '图书馆'; }";
  const capture = (text: string) => store.capture({
    source: "file", externalId: "outing.ts", title: "outing.ts", parts: [{ type: "text", text }], context: {},
  });
  capture(text);
  const source = repository.materials().find(m => m.title === "outing.ts")!;
  artifact.dependencies = [{ kind: "material", key: source.key, digest: source.digest }];
  artifact.document.citations.forEach((citation, i) => {
    citation.target = { kind: "material", key: source.key, startLine: i ? 4 : 1, endLine: i ? 5 : 2 };
  });
  bindKnowledgeQuotes(artifact.document, new Map([[source.key, source]]));
  const page = repository.publish(artifact);
  const moved = "export function unrelated() { return 0; }\n\n" + text;
  capture(moved);
  repository.refresh();
  expect(repository.get(page.document.key)?.current).toBe(true);
  // Code navigation still locates the declaration rather than its comment.
  expect(parseFile("outing.ts", text).symbols.find(s => s.name === "budget")?.rangeStart.line).toBe(2);
  expect(repository.resolveMaterial(source.key, source.digest)?.material.revisionId).toBe(source.revisionId);
  capture(moved.replace("每人预算八十元", "每人预算一百二十元"));
  expect(repository.statusReader()(page)).toMatchObject({
    budget: { state: "needs-review" }, venue: { state: "current" },
  });
});
