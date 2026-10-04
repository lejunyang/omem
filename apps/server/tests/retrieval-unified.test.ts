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
import { asksForCallers, querySymbols } from "../src/retrieval/relevance.js";
import { rerankPassages } from "../src/retrieval/rerank-passages.js";
import { sourceContextRange } from "../src/retrieval/context.js";
import { sourceAnchor } from "../src/retrieval/units.js";
import { ensureMaterialAliases } from "../src/knowledge/material-identity.js";
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
      publication: {role:"article"},
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

it("recovers semantic indexing after a failed model load while lexical search stays available", async () => {
  const s = setup();
  let attempts = 0;
  const model: EmbeddingModel = {
    id: "recovery-fixture",
    embed: async (texts) => texts.map(() => [1, 0]),
    close: async () => {},
  };
  const retrieval = new UnifiedRetrieval(s.store.db, async () => {
    if (++attempts === 1) throw Error("temporary process spawn failure");
    return model;
  });
  try {
    s.store.capture({ source: "manual", externalId: "delivery-note", title: "配送安排",
      parts: [{ type: "text", text: "包裹每周四发出。" }], context: {} });
    const first = retrieval.indexBatch();
    expect(retrieval.indexBatch()).toBe(first);
    await expect(first).rejects.toThrow("temporary process spawn failure");
    expect(retrieval.health().semantic.state).toBe("degraded");
    expect((await retrieval.search({ text: "包裹" }))[0]?.routes).toContain("bm25");
    await retrieval.indexBatch();
    expect(attempts).toBe(2);
    expect(retrieval.health().semantic).toMatchObject({ state: "ready", pending: 0, error: null });
    expect((await retrieval.search({ text: "发货时间" }))[0]?.routes).toContain("semantic");
  } finally {
    await retrieval.close();
    await s.close();
  }
});

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

it("keeps prose current when incidental research changes, but respects explicit invalidation", async () => {
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
    expect(repeated[0]!.target).not.toHaveProperty("reviewState");
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
    expect(hit.target).not.toHaveProperty("reviewState");
    expect(hit.references[0]).toMatchObject({ startLine: 1, endLine: 2 });
  } finally {
    await s.close();
  }
});

it("keeps supported sections after another section changes, including fixed section links and visibility", async () => {
  const s = setup();
  const capture = (id: string, text: string) =>
    s.store.capture({
      source: "manual",
      externalId: id,
      title: id,
      context: {},
      parts: [{ type: "text", text }],
    });
  try {
    capture(
      "consumer",
      "if (seen(event.id)) return;\nqueue.deliver(event.parcel);",
    );
    const original = s.publish();
    capture("capacity", "每次配送最多五件。\n超过限额时等待下次配送。");
    const capacity = s.repository
      .materials()
      .find((m) => m.title === "capacity")!;
    const materials = new Map(s.repository.materials().map((m) => [m.key, m]));
    const article = s.repository.publish({
      ...original,
      document: bindKnowledgeQuotes(
        {
          ...original.document,
          sections: [
            {
              ...original.document.sections[0]!,
              body:
                original.document.sections[0]!.body +
                "\n\n重复通知会共用同一个配送编号，方便查询进度。[[implementation]]",
            },
            {
              key: "capacity",
              title: "配送容量",
              body: "配送每次最多五件。[[capacity]]",
            },
          ],
          citations: [
            ...original.document.citations,
            {
              key: "capacity",
              label: "配送容量",
              reason: "一次配送的限额",
              relation: "explains",
              quote: "",
              target: {
                kind: "material",
                key: capacity.key,
                startLine: 1,
                endLine: 2,
              },
            },
          ],
        },
        materials,
      ),
      dependencies: [
        ...original.dependencies,
        { kind: "material", key: capacity.key, digest: capacity.digest },
      ],
    });
    const publishParent = (key: string, section?: string) =>
      s.repository.publish({
        ...article,
        document: {
          ...article.document,
          key,
          sections: [
            {
              key: "overview",
              title: "配送说明",
              body: "重复通知仍只配送一次。[[guide]]",
            },
          ],
          citations: [
            {
              key: "guide",
              label: "配送指南",
              reason: "配送处理",
              relation: "explains",
              quote: "",
              target: {
                kind: "article",
                key: article.document.key,
                ...(section ? { section } : {}),
              },
            },
          ],
        },
        dependencies: [
          {
            kind: "article",
            key: article.document.key,
            digest: article.revision,
          },
        ],
      });
    const sectionParent = publishParent("section-parent", "dedup");
    const wholeParent = publishParent("whole-parent");
    const query = { text: "重复通知 配送", kinds: ["knowledge" as const] };
    const own = (hits: Awaited<ReturnType<typeof s.retrieval.search>>) =>
      hits.filter(
        (h) =>
          h.target.kind === "knowledge" &&
          h.target.key === article.document.key,
      );
    expect(
      own(await s.retrieval.search(query)).filter(
        (h) => h.target.kind === "knowledge" && h.target.section === "dedup",
      ),
    ).toHaveLength(1);
    expect(
      own(await s.retrieval.search({ ...query, diversify: false })).filter(
        (h) => h.target.kind === "knowledge" && h.target.section === "dedup",
      ),
    ).toHaveLength(2);
    capture("capacity", "每次配送最多十件。\n超过限额时等待下次配送。");
    s.repository.refresh();
    const hits = await s.retrieval.search(query);
    expect(own(hits)[0]?.target).toMatchObject({
      revision: article.revision,
      section: "dedup",
      reviewState: "needs-review",
    });
    expect(own(hits)[0]?.references[0]?.digest).toBe(
      original.dependencies[0]!.digest,
    );
    expect(
      hits.some(
        (h) =>
          h.target.kind === "knowledge" &&
          h.target.key === sectionParent.document.key,
      ),
    ).toBe(true);
    expect(
      hits.some(
        (h) =>
          h.target.kind === "knowledge" &&
          h.target.key === wholeParent.document.key,
      ),
    ).toBe(false);
    expect(
      own(
        await s.retrieval.search({ text: "配送容量", kinds: ["knowledge"] }),
      ).some(
        (h) => h.target.kind === "knowledge" && h.target.section === "capacity",
      ),
    ).toBe(false);
    const hidden = new Set(
      s.repository
        .materials()
        .find((m) => m.key === capacity.key)!
        .fragments.map((f) => f.id),
    );
    expect(
      await s.retrieval.search({ ...query, visible: (id) => !hidden.has(id) }),
    ).toEqual([]);
    capture("consumer", "queue.deliver(event.parcel); // no duplicate guard");
    s.repository.refresh();
    expect(await s.retrieval.search(query)).toEqual([]);
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
    ensureMaterialAliases(s.store.db);
    const material = s.repository.materials()[0]!;
    s.store.db
      .prepare(
        "INSERT INTO knowledge_material_aliases(material_key,source_id) VALUES(?,?)",
      )
      .run("library:parcel-operations", material.sourceId);
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
    expect(
      received?.evidence.every(
        (e) =>
          e.materialKey === "library:parcel-operations" &&
          e.sourceTarget?.key === e.materialKey,
      ),
    ).toBe(true);
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

it("finds captured call sites instead of definitions, imports or comments, preserving scope and revisions", async () => {
  const s = setup();
  const capture = (id: string, text: string) =>
    s.store.capture({
      source: "file",
      externalId: id,
      title: id + ".ts",
      context: { filePath: id + ".ts" },
      parts: [{ type: "text", text }],
    });
  try {
    capture(
      "parcel",
      "export function reserveParcel(id: string) { return id; }",
    );
    capture(
      "checkout",
      [
        'import { reserveParcel } from "./parcel";',
        '// reserveParcel("comment") is only an example.',
        'export function checkout() { return reserveParcel("a"); }',
        'export function retry() { return reserveParcel("b"); }',
        'export function schedule() { return reserveParcel("c"); }',
      ].join("\n"),
    );
    const question = "哪些地方调用 reserveParcel？要找调用方，而不是定义。";
    capture(
      "mobile",
      'export function buyOnPhone() { return reserveParcel("d"); }',
    );
    const hits = await s.retrieval.search({ text: question });
    expect(hits).toHaveLength(4); // File diversity does not discard the other operations.
    expect(new Set(hits.slice(0, 2).map((h) => h.title)).size).toBe(2);
    expect(
      hits.flatMap((h) => h.codeMatches!.flatMap((m) => m.lines)).sort(),
    ).toEqual([1, 3, 4, 5]);
    expect(
      hits.every((h) => h.codeMatches!.every((m) => m.status === "candidate")),
    ).toBe(true);
    expect(hits.every((h) => h.routes.includes("code-call-candidate"))).toBe(
      true,
    );
    const explicit = await s.retrieval.search({
      text: "reserveParcel",
      codeIntent: "callers",
    });
    expect(explicit.map((h) => h.id)).toEqual(hits.map((h) => h.id));
    expect(
      (
        await s.retrieval.search({ text: question, codeIntent: "definition" })
      )[0]?.headingPath.at(-1),
    ).toBe("reserveParcel");
    const visible = new Set(hits[0]!.references.flatMap((r) => r.fragmentIds));
    expect(
      (
        await s.retrieval.search({
          text: question,
          visible: (id) => visible.has(id),
        })
      ).every((h) =>
        h.references.every((r) => r.fragmentIds.every((id) => visible.has(id))),
      ),
    ).toBe(true);
    expect(
      await s.retrieval.search({ text: "AbsentShippingMethod_728 callers" }),
    ).toEqual([]);
    const oldTarget = hits.find((h) => h.title === "checkout.ts")!.target;
    capture(
      "checkout",
      'export function checkout() { return "no reservation"; }',
    );
    expect(
      (await s.retrieval.search({ text: question })).map((h) => h.title),
    ).toEqual(["mobile.ts"]);
    if (oldTarget.kind === "source")
      expect(
        s.retrieval.readEvidence(oldTarget.revisionId, oldTarget.fragmentIds[0])
          ?.text,
      ).toContain("reserveParcel");
  } finally {
    await s.close();
  }
});

it("keeps ordinary recall when a code question mentions calls or navigation has no AST support", async () => {
  const s=setup();
  try {
    s.store.capture({source:"manual",externalId:"shipping-guide",title:"配送接口说明.md",context:{},parts:[{type:"text",text:"schedule_shipment no longer accepts a destination argument. The caller must set shipment.destination before calling schedule_shipment()."}]});
    const errorQuestion="Too many arguments for schedule_shipment()\nThere is a part of my code where it calls schedule_shipment(destination).";
    expect(asksForCallers(errorQuestion)).toBe(false);
    expect((await s.retrieval.search({text:errorQuestion}))[0]?.title).toBe("配送接口说明.md");
    expect((await s.retrieval.search({text:"Who calls schedule_shipment?"}))[0]?.title).toBe("配送接口说明.md");
    expect(await s.retrieval.search({text:"schedule_shipment",codeIntent:"callers"})).toEqual([]);
  } finally {await s.close();}
});

it("keeps a dense match near the end of a named operation and sends local passages to reranking", async () => {
  const s = setup();
  const inputs: string[][] = [];
  const model: EmbeddingModel = {
    id: "window-fixture",
    close: async () => {},
    embed: async (texts, purpose) =>
      texts.map((t) =>
        purpose === "query" || t.includes("TAIL_ACTION") ? [1, 0] : [0, 1],
      ),
  };
  const retrieval = new UnifiedRetrieval(
    s.store.db,
    async () => model,
    async () => ({
      id: "record-inputs",
      close: async () => {},
      score: async (_q, passages) => {
        inputs.push(passages);
        return passages.map((p) => (p.includes("TAIL_ACTION") ? 0.9 : 0.2));
      },
    }),
  );
  try {
    s.store.capture({
      source: "file",
      externalId: "long-operation",
      title: "parcel.ts",
      context: { filePath: "parcel.ts" },
      parts: [
        {
          type: "text",
          text:
            "export function reserveParcel(id: string) {\n" +
            Array.from(
              { length: 90 },
              (_, i) => `  console.log("preparation ${i}");`,
            ).join("\n") +
            "\n  return commitReservation(id); // TAIL_ACTION\n}",
        },
      ],
    });
    while (await retrieval.indexBatch(32)) {}
    const hits = await retrieval.search({
      text: "reserveParcel 最后怎样实际提交预约？",
      purpose: "implementation",
    });
    expect(inputs.flat().some((p) => p.includes("TAIL_ACTION"))).toBe(true);
    expect(inputs.flat().every((p) => p.length <= 961)).toBe(true);
    expect(hits[0]?.text).toContain("commitReservation");
    expect(hits[0]?.target).toMatchObject({ startLine: 1, endLine: 93 });
    expect(hits[0]?.routes).toEqual(
      expect.arrayContaining(["semantic", "code-symbol", "cross-encoder"]),
    );
  } finally {
    await retrieval.close();
    await s.close();
  }
});

it("uses a range-bound Chinese concept to locate English write operations beyond notification prose", () => {
  const text =
    "// 修改记忆、提案与入口的信息提示\n" +
    "prepareNotification();\n".repeat(100) +
    "\napplyTask();\napplyMemory();\n";
  const passages = rerankPassages(
    text,
    "怎样修改有效记忆，提案从什么入口写入？",
    text.slice(0, 400),
    [{ label: "原子写入记忆或事项", aliases: ["applyTask", "applyMemory"] }],
  );
  expect(passages.some((p) => p.includes("applyTask();\napplyMemory();"))).toBe(
    true,
  );
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
    expect(
      received?.background?.find((b) => b.kind === "knowledge")?.target,
    ).toMatchObject({
      kind: "knowledge",
      key: "delivery-guide",
      section: "dedup",
    });
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

it("assembles all three facts from one original and restores a missing chapter condition for answering", async () => {
  const s = setup();
  try {
    s.store.capture({
      source: "manual", externalId: "ferry", title: "出行安排.md",
      parts: [{type: "text", text: [
        "# 出行", "", "以下安排仅适用于提前报名的参加者。", "", "## 渡轮预订时间", "渡轮预订必须提前完成。", "",
        "最后受理时间是周三18点。", "", "## 渡轮预订证件",
        "渡轮预订需要身份证原件。", "", "## 渡轮预订取消",
        "渡轮预订可在周四12点前取消。", "", "## 其他交通", "火车票可以当天购买。",
      ].join("\n")}], context: {},
    });
    const browse = await s.retrieval.search({text: "渡轮预订", kinds: ["source"]});
    expect(browse).toHaveLength(2);
    let received: Parameters<AssistantModelPort["generate"]>[0] | undefined;
    const runtime = new AssistantRuntime(s.store, {generate: async input => {
      received = input;
      return {answer: "已找到预订时间、证件和取消规则。", citationIds: []};
    }}, {ownerId: "owner", retrieval: s.retrieval});
    const conversation = runtime.conversations.open({principalId:"owner",channel:"web",chatId:"ferry",visibility:"private"});
    await runtime.turn({conversationId:conversation.id,userText:"渡轮预订"});
    const text = received!.evidence.map(e => e.text).join("\n");
    expect(text).toContain("仅适用于提前报名的参加者");
    expect(text).toContain("周三18点");
    expect(text).toContain("身份证原件");
    expect(text).toContain("周四12点");
    expect(text).not.toContain("火车票");
    for (const e of received!.evidence) {
      const m = s.repository.materials().find(m => m.revisionId === e.sourceRevisionId)!;
      expect(m.text.split("\n").slice(e.sourceTarget!.startLine - 1, e.sourceTarget!.endLine).join("\n")).toBe(e.text);
    }
  } finally { await s.close(); }
});

it("does not expand a visible hit into a hidden part of its chapter", async () => {
  const s = setup();
  try {
    s.store.capture({source:"manual",externalId:"access",title:"安排.md",context:{},parts:[
      {type:"text",text:"## 预订规则\n\n内部联络号码：12345。"},
      {type:"text",text:"渡轮预订需要身份证。"},
    ]});
    const m = s.repository.materials()[0]!, hit = sourceAnchor(m, m.lineCount, m.lineCount);
    expect(m.fragments.length).toBeGreaterThan(1);
    const visible = (id:string) => hit.fragmentIds.includes(id);
    await s.retrieval.search({text:"渡轮预订",diversify:false});
    const projection = { db: s.store.db, unitId: "fixed-history" };
    expect(sourceContextRange(m, hit, visible, projection)).toEqual(hit);
    expect(sourceContextRange(m, hit, () => true, projection).startLine).toBe(1);
  } finally { await s.close(); }
});
