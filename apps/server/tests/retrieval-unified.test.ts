import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
} from "../src/knowledge/repository.js";
import { UnifiedRetrieval } from "../src/retrieval/unified.js";
import { markdownPassages } from "../src/retrieval/units.js";
import { querySymbols } from "../src/retrieval/relevance.js";
import type { EmbeddingModel } from "../src/retrieval/embedding.js";
import {
  AssistantRuntime,
  type AssistantModelPort,
} from "../src/assistant/runtime.js";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "omem-unified-")),
    store = new Store(directory);
  const repository = new KnowledgeRepository(store),
    retrieval = new UnifiedRetrieval(store.db);
  const publish = () => {
    const m = repository.materials()[0]!;
    return repository.publish({
      version: 1,
      document: bindKnowledgeQuotes(
        {
          key: "delivery-guide",
          title: "可靠配送",
          summary: "理解重复事件",
          category: "物流",
          topicPath: ["物流", "可靠性"],
          sections: [
            {
              key: "dedup",
              title: "重复包裹通知如何处理",
              body: "重复通知不能触发第二次配送。系统用事件编号识别已经受理的请求，让同一包裹只安排一次运输。[[implementation]]",
            },
          ],
          citations: [
            {
              key: "implementation",
              label: "事件受理",
              reason: "受理时检查事件编号",
              relation: "implements",
              quote: "",
              target: {
                kind: "material",
                key: m.key,
                startLine: 1,
                endLine: 2,
              },
            },
          ],
          questions: [],
        },
        new Map([[m.key, m]]),
      ),
      dependencies: [{ kind: "material", key: m.key, digest: m.digest }],
      generation: {
        model: "fixture",
        effort: null,
        at: "2026-10-02T00:00:00Z",
        trace: {},
      },
      review: {
        model: "fixture-reviewer",
        at: "2026-10-02T00:01:00Z",
        verdict: "accepted",
        trace: {},
      },
    });
  };
  return {
    store,
    repository,
    retrieval,
    publish,
    async close() {
      await retrieval.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("returns the explanation as readable context with its own article and exact original range", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "manual",
      externalId: "arbitrary-implementation",
      title: "event consumer",
      parts: [
        {
          type: "text",
          text: "if (seen(event.id)) return;\nqueue.deliver(event.parcel);",
        },
      ],
      context: {},
    });
    const article = s.publish();
    const hits = await s.retrieval.search({
      text: "重复通知 配送",
      purpose: "concept",
    });
    const explanation = hits.find((h) => h.kind === "knowledge")!;
    expect(explanation.text).toContain("只安排一次运输");
    expect(explanation.target).toEqual({
      kind: "knowledge",
      key: article.document.key,
      revision: article.revision,
      section: "dedup",
    });
    expect(explanation.references[0]).toMatchObject({
      startLine: 1,
      endLine: 2,
      revisionId: s.repository.materials()[0]!.revisionId,
    });
    expect(explanation.citations).toEqual([
      expect.objectContaining({
        key: "implementation",
        label: "事件受理",
        actionable: true,
      }),
    ]);
    const hidden = explanation.references[0]!.fragmentIds[0]!;
    expect(
      await s.retrieval.search({
        text: "重复通知 配送",
        visible: (id) => id !== hidden,
      }),
    ).toEqual([]);
    expect(
      await s.retrieval.search({
        text: "重复通知",
        kinds: ["knowledge"],
        topicPath: ["其他领域"],
      }),
    ).toEqual([]);
  } finally {
    await s.close();
  }
});

it("updates projections on source changes without losing old fixed citations", async () => {
  const s = setup();
  try {
    const input = {
      source: "manual" as const,
      externalId: "worker",
      title: "event consumer",
      context: {},
    };
    s.store.capture({
      ...input,
      parts: [
        {
          type: "text",
          text: "if (seen(event.id)) return;\nqueue.deliver(event.parcel);",
        },
      ],
    });
    const original = s.repository.materials()[0]!,
      article = s.publish();
    expect(
      (await s.retrieval.search({ text: "重复通知" })).some(
        (h) => h.kind === "knowledge",
      ),
    ).toBe(true);
    s.store.capture({
      ...input,
      parts: [{ type: "text", text: "每次重新安排配送。" }],
    });
    expect(
      (await s.retrieval.search({ text: "重复通知" })).some(
        (h) => h.kind === "knowledge",
      ),
    ).toBe(false);
    expect(
      s.repository.get(article.document.key, article.revision),
    ).toBeTruthy();
    expect(
      s.repository.resolveMaterial(original.key, original.digest)?.material
        .text,
    ).toContain("seen(event.id)");
  } finally {
    await s.close();
  }
});

it("finds separate functions in the same file at their own ranges rather than a whole-file fragment", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "file",
      externalId: "neutral-file",
      title: "processor.ts",
      context: { filePath: "processor.ts", captureFormat: "verbatim-v1" },
      parts: [
        {
          type: "text",
          text: "/** Reserve parcel capacity. */\nexport function reserveParcel() {\n  return 1;\n}\n\nexport function releaseParcel() {\n  return 0;\n}",
        },
      ],
    });
    const a = (
      await s.retrieval.search({
        text: "reserveParcel",
        purpose: "implementation",
      })
    )[0]!;
    const b = (
      await s.retrieval.search({
        text: "releaseParcel",
        purpose: "implementation",
      })
    )[0]!;
    expect(a.target).toMatchObject({
      kind: "source",
      startLine: 1,
      endLine: 4,
    });
    expect(b.target).toMatchObject({
      kind: "source",
      startLine: 6,
      endLine: 8,
    });
    expect(a.headingPath).toContain("reserveParcel");
    expect(b.text).not.toContain("reserveParcel");
    expect(
      await s.retrieval.search({ text: "imaginaryParcelHandler" }),
    ).toEqual([]);
  } finally {
    await s.close();
  }
});

it("recalls supported prose as pending review when an uncited research input changes, but respects explicit invalidation", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "manual",
      externalId: "consumer",
      title: "event consumer",
      parts: [
        {
          type: "text",
          text: "if (seen(event.id)) return;\nqueue.deliver(event.parcel);",
        },
      ],
      context: {},
    });
    const article = s.publish();
    const backgroundInput = {
      source: "manual" as const,
      externalId: "background",
      title: "operator notes",
      context: {},
    };
    s.store.capture({
      ...backgroundInput,
      parts: [{ type: "text", text: "值班安排周一。" }],
    });
    const background = s.repository
      .materials()
      .find((m) => m.title === "operator notes")!;
    s.repository.publish({
      ...article,
      dependencies: [
        ...article.dependencies,
        { kind: "material", key: background.key, digest: background.digest },
      ],
    });
    s.store.capture({
      ...backgroundInput,
      parts: [{ type: "text", text: "值班安排周二。" }],
    });
    s.repository.refresh();
    const hit = (
      await s.retrieval.search({ text: "重复通知 配送", kinds: ["knowledge"] })
    )[0]!;
    expect(hit.target).toMatchObject({
      kind: "knowledge",
      reviewState: "needs-review",
    });
    expect(hit.references[0]).toMatchObject({ startLine: 1, endLine: 2 });
    s.store.capture({
      ...backgroundInput,
      parts: [{ type: "text", text: "值班安排周三。" }],
    });
    const visibleIds = new Set(
      s.repository.materials().flatMap((m) => m.fragments.map((f) => f.id)),
    );
    const repeated = await s.retrieval.search({
      text: "重复通知 配送",
      kinds: ["knowledge"],
      visible: (id) => visibleIds.has(id),
    });
    expect(repeated).toHaveLength(1);
    expect(repeated[0]!.target).toMatchObject({ reviewState: "needs-review" });
    expect(
      await s.retrieval.search({
        text: "重复通知",
        kinds: ["knowledge"],
        visible: (id) =>
          id !==
          s.repository.materials().find((m) => m.key === background.key)!
            .fragments[0]!.id,
      }),
    ).toEqual([]);
    s.store.db
      .prepare("INSERT INTO knowledge_invalidations VALUES(?,?)")
      .run(article.document.key, "用户更正了正文结论");
    expect(
      await s.retrieval.search({ text: "重复通知", kinds: ["knowledge"] }),
    ).toEqual([]);
  } finally {
    await s.close();
  }
});

it("keeps a parent explanation tied to its fixed child revision after the child's citation range changes", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "manual",
      externalId: "consumer",
      title: "event consumer",
      parts: [
        {
          type: "text",
          text: "if (seen(event.id)) return;\nqueue.deliver(event.parcel);",
        },
      ],
      context: {},
    });
    const child = s.publish();
    const parent = s.repository.publish({
      ...child,
      document: {
        ...child.document,
        key: "delivery-overview",
        sections: [
          {
            key: "why",
            title: "配送概念",
            body: "重复通知只安排一次运输。[[child]]",
          },
        ],
        citations: [
          {
            key: "child",
            label: "配送解释",
            reason: "解释事件受理",
            relation: "explains",
            quote: "",
            target: {
              kind: "article",
              key: child.document.key,
              section: "dedup",
            },
          },
        ],
      },
      dependencies: [
        { kind: "article", key: child.document.key, digest: child.revision },
      ],
    });
    const m = s.repository.materials()[0]!;
    s.repository.publish({
      ...child,
      document: bindKnowledgeQuotes(
        {
          ...child.document,
          citations: child.document.citations.map((c) => ({
            ...c,
            target: { kind: "material", key: m.key, startLine: 2, endLine: 2 },
          })),
        },
        new Map([[m.key, m]]),
      ),
    });
    const hit = (
      await s.retrieval.search({ text: "重复通知 配送", kinds: ["knowledge"] })
    ).find(
      (h) =>
        h.target.kind === "knowledge" && h.target.key === parent.document.key,
    )!;
    expect(hit.target).toMatchObject({ reviewState: "needs-review" });
    expect(hit.references[0]).toMatchObject({ startLine: 1, endLine: 2 });
  } finally {
    await s.close();
  }
});

it("lets the assistant cite one of two functions sharing a fragment without selecting the other range", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "file",
      externalId: "functions",
      title: "processor.ts",
      context: { filePath: "processor.ts", captureFormat: "verbatim-v1" },
      parts: [
        {
          type: "text",
          text: "export function reserveParcel() {\n  return 1;\n}\nexport function releaseParcel() {\n  return 0;\n}",
        },
      ],
    });
    const hits = await Promise.all(
      ["reserveParcel", "releaseParcel"].map((text) =>
        s.retrieval.search({ text, purpose: "implementation" }),
      ),
    );
    let received: Parameters<AssistantModelPort["generate"]>[0] | undefined;
    const runtime = new AssistantRuntime(
      s.store,
      {
        generate: async (input) => {
          received = input;
          const chosen = input.evidence.find((e) =>
            e.text.includes("releaseParcel"),
          )!;
          return {
            answer: `释放包裹。[[${chosen.citationId}]]`,
            citationIds: [chosen.citationId!],
          };
        },
      },
      {
        ownerId: "owner",
        retrieval: {
          ...s.retrieval,
          searchSources: () => [],
          search: async () => hits.map((list) => list[0]!),
        },
      },
    );
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "functions",
      visibility: "private",
    });
    const result = await runtime.turn({
      conversationId: conversation.id,
      userText: "这两个函数有什么区别？",
    });
    expect(received?.evidence).toHaveLength(2);
    expect(new Set(received?.evidence.map((e) => e.fragmentId)).size).toBe(1);
    expect(new Set(received?.evidence.map((e) => e.citationId)).size).toBe(2);
    expect(result.turn.selectedEvidence).toHaveLength(1);
    expect((result.turn.selectedEvidence as unknown[])[0]).toMatchObject({
      sourceTarget: { startLine: 4, endLine: 6 },
    });
  } finally {
    await s.close();
  }
});

it("opens a named method as a complete operation including its local state and branches", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "file",
      externalId: "parcel-service",
      title: "parcel.ts",
      context: { filePath: "parcel.ts", captureFormat: "verbatim-v1" },
      parts: [
        {
          type: "text",
          text: "export class ParcelService {\n  /** Reserve one parcel. */\n  reserveParcel(id: string) {\n    const available = this.capacity > 0;\n    if (!available) return null;\n    this.capacity -= 1;\n    return { id };\n  }\n  capacity = 3;\n}",
        },
      ],
    });
    const hit = (
      await s.retrieval.search({
        text: "ParcelService.reserveParcel",
        purpose: "implementation",
      })
    )[0]!;
    expect(hit.headingPath.at(-1)).toBe("ParcelService.reserveParcel");
    expect(hit.target).toMatchObject({
      kind: "source",
      startLine: 2,
      endLine: 8,
    });
    expect(hit.text).toContain("const available");
    expect(hit.text).toContain("if (!available) return null");
    expect(hit.text).toContain("return { id }");
    const question = (
      await s.retrieval.search({
        text: "ParcelService.reserveParcel 为什么拒绝？",
        purpose: "implementation",
      })
    )[0]!;
    expect(question.target).toEqual(hit.target);
  } finally {
    await s.close();
  }
});

it("keeps heading context and table structure, ignoring headings inside code fences", () => {
  const blocks = markdownPassages(
    "# 手册\n## 预约\n先确认人数。\n\n| 类型 | 条件 |\n| --- | --- |\n| 团体 | 提前一天 |\n\n```md\n# 这不是章节\n```\n\n下一段仍在预约章节。",
  );
  expect(blocks.at(-1)?.headingPath).toEqual(["手册", "预约"]);
  expect(blocks.find((b) => b.text.includes("提前一天"))?.text).toContain(
    "| 类型 | 条件 |",
  );
});

it("keeps an explicit operation in the hybrid and reranking pools despite whole-question distractors", async () => {
  const s = setup();
  const text =
    "ParcelService.reserveParcel 如何处理配送预约，为什么拒绝请求，输入判断和结果保存在哪里？";
  const model: EmbeddingModel = {
    id: "symbol-cutoff-fixture",
    close: async () => {},
    embed: async (texts, purpose) =>
      texts.map((t) =>
        purpose === "passage" && t.includes("return { id }") ? [0, 1] : [1, 0],
      ),
  };
  const pools: string[][] = [];
  const retrieval = new UnifiedRetrieval(
    s.store.db,
    async () => model,
    async () => ({
      id: "pool-inspection-fixture",
      close: async () => {},
      score: async (_query, passages) => {
        pools.push(passages);
        return passages.map(() => 0.5);
      },
    }),
  );
  try {
    s.store.capture({
      source: "file",
      externalId: "shipping",
      title: "shipping.ts",
      context: { filePath: "shipping.ts" },
      parts: [
        {
          type: "text",
          text: "export class ParcelService {\n  reserveParcel(id: string) {\n    return { id };\n  }\n}",
        },
      ],
    });
    for (let i = 0; i < 130; i++)
      s.store.capture({
        source: "manual",
        externalId: "question-" + i,
        title: "讨论 " + i,
        context: {},
        parts: [
          {
            type: "text",
            text: `第 ${i} 条讨论：${text} 配送预约，拒绝请求，输入判断，结果保存。这里只复述问题，没有实现。`,
          },
        ],
      });
    while (await retrieval.indexBatch(32)) {}
    const hits = await retrieval.search({ text, purpose: "implementation" });
    const definition = hits.find(
      (h) => h.headingPath.at(-1) === "ParcelService.reserveParcel",
    );
    expect(definition?.routes).toContain("code-symbol");
    expect(definition?.target).toMatchObject({
      kind: "source",
      startLine: 2,
      endLine: 4,
    });
    expect(pools[0]?.some((p) => p.includes("return { id }"))).toBe(true);
    expect(hits.filter((h) => h.id === definition?.id)).toHaveLength(1);
    const plain = await s.retrieval.search({ text, purpose: "implementation" });
    expect(
      plain.some((h) => h.headingPath.at(-1) === "ParcelService.reserveParcel"),
    ).toBe(true);
    expect(
      s.retrieval
        .searchSources({ text })
        .some((h) => h.routes.includes("code-symbol")),
    ).toBe(true);
  } finally {
    await retrieval.close();
    await s.close();
  }
});

it("retains same-named definitions and source visibility without treating mentions as definitions", async () => {
  const s = setup();
  try {
    for (const id of ["east", "west"])
      s.store.capture({
        source: "file",
        externalId: id,
        title: id + ".ts",
        context: { filePath: id + ".ts" },
        parts: [
          {
            type: "text",
            text: `export function reserveParcel() { return "${id}"; }`,
          },
        ],
      });
    s.store.capture({
      source: "manual",
      externalId: "note",
      title: "背景",
      context: {},
      parts: [{ type: "text", text: "reserveParcel 只是一个讨论中的名字。" }],
    });
    const hits = await s.retrieval.search({ text: "reserveParcel" });
    const definitions = hits.filter((h) => h.routes.includes("code-symbol"));
    expect(definitions).toHaveLength(2);
    const visible = new Set(
      definitions[0]!.references.flatMap((r) => r.fragmentIds),
    );
    const limited = await s.retrieval.search({
      text: "reserveParcel 在未预约时会怎样？",
      visible: (id) => visible.has(id),
    });
    expect(
      limited.filter((h) => h.routes.includes("code-symbol")).map((h) => h.id),
    ).toEqual([definitions[0]!.id]);
    expect(await s.retrieval.search({ text: "AbsentDispatch_2917" })).toEqual(
      [],
    );
    expect(querySymbols("How can I apply the new rule?")).toEqual([]);
    expect(querySymbols("renderArticle 如何处理 Markdown 和 JSON？")).toEqual([
      "renderarticle",
    ]);
    expect(
      querySymbols(
        "不调用 ParcelService.reserveParcel. 而使用 `apply`，会发生什么？",
      ),
    ).toEqual(["parcelservice.reserveparcel", "apply"]);
  } finally {
    await s.close();
  }
});

it("persists contextual semantic units with a separate identity and finds explanations beyond lexical wording", async () => {
  const s = setup();
  let count = 0;
  const model: EmbeddingModel = {
    id: "fixture-embedding-v1",
    close: async () => {},
    embed: async (texts, purpose) =>
      texts.map((text) => {
        if (purpose === "passage") count++;
        return purpose === "query" || text.includes("只安排一次运输")
          ? [1, 0]
          : [0, 1];
      }),
  };
  const retrieval = new UnifiedRetrieval(s.store.db, async () => model);
  try {
    s.store.capture({
      source: "manual",
      externalId: "consumer",
      title: "event consumer",
      parts: [
        {
          type: "text",
          text: "if (seen(event.id)) return;\nqueue.deliver(event.parcel);",
        },
      ],
      context: {},
    });
    s.publish();
    while (await retrieval.indexBatch()) {}
    const hit = (
      await retrieval.search({
        text: "idempotent dispatch explanation",
        kinds: ["knowledge"],
      })
    )[0]!;
    expect(hit.text).toContain("只安排一次运输");
    expect(hit.routes).toContain("semantic");
    expect(
      s.store.db.prepare("SELECT count(*) n FROM fragment_embeddings").get()?.n,
    ).toBe(0);
    expect(await retrieval.indexBatch()).toBe(0);
    expect(count).toBeGreaterThan(0);
  } finally {
    await retrieval.close();
    await s.close();
  }
});

it("passes readable background to the assistant while keeping original bytes and citation ids separate", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "manual",
      externalId: "consumer",
      title: "event consumer",
      parts: [
        {
          type: "text",
          text: "if (seen(event.id)) return;\nqueue.deliver(event.parcel);",
        },
      ],
      context: {},
    });
    s.publish();
    let received: Parameters<AssistantModelPort["generate"]>[0] | undefined;
    const runtime = new AssistantRuntime(
      s.store,
      {
        generate: async (input) => {
          received = input;
          return {
            answer: "同一包裹只安排一次运输。",
            citationIds: input.evidence.map((e) => e.fragmentId),
          };
        },
      },
      { ownerId: "owner", retrieval: s.retrieval },
    );
    const conversation = runtime.conversations.open({
      principalId: "owner",
      channel: "web",
      chatId: "delivery",
      visibility: "private",
    });
    await runtime.turn({
      conversationId: conversation.id,
      userText: "重复通知如何安排配送？",
    });
    expect(
      received?.background?.find((b) => b.kind === "knowledge")?.text,
    ).toContain("只安排一次运输");
    expect(received?.evidence.map((e) => e.text).join("\n")).toContain(
      "seen(event.id)",
    );
    expect(
      received?.evidence.some((e) => e.text.includes("只安排一次运输")),
    ).toBe(false);
  } finally {
    await s.close();
  }
});
