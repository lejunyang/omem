import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../src/store.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";
import type { SourceProfile } from "../src/source-profile/service.js";
import { captureSchema } from "../../../packages/contracts/src/index.js";

const stores: { store: Store; dir: string }[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-retrieval-"));
  const store = new Store(dir);
  stores.push({ store, dir });
  return store;
}
afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const provenance = {
  collectorId: "retrieval-test",
  actorId: "owner",
  actorType: "owner" as const,
  actorVerifiedBy: "test",
  sourceUri: null,
  eventId: null,
  eventAt: "2026-09-27T00:00:00.000Z",
  timezone: "Asia/Shanghai",
  quoted: false,
  forwarded: false,
  producerKind: "original" as const,
};

const capture = (
  store: Store,
  externalId: string,
  title: string,
  text: string,
) =>
  store.capture(
    captureSchema.parse({
      source: "manual",
      externalId,
      title,
      parts: [{ type: "text", text }],
      provenance,
    }),
  );

const count = (store: Store, sql: string) =>
  Number(Object.values(store.db.prepare(sql).get() as Record<string, unknown>)[0]);

const latestProfile = (store: Store, revisionId: string): SourceProfile => {
  const profile = store.profiles.latest(revisionId);
  if (!profile) throw Error("source profile missing");
  return profile;
};

describe("V3-03 unified retrieval port and lightweight source profile", () => {
  it("G01: importing a business doc profiles it, makes it keyword-searchable, asks zero per-sentence confirmations", () => {
    const store = setup();
    const doc = [
      "# 订单同步说明",
      "",
      "订单同步是核心后台任务，负责把店铺订单同步到仓储系统。",
      "",
      "## 触发方式",
      "",
      "同步支持定时触发和手动触发两种方式。",
      "",
      "## 失败处理",
      "",
      "失败后自动重试，最多三次。",
      "",
      "客服团队需要在订单异常时收到通知。",
      "",
      "## 历史记录",
      "",
      "2024年系统上线，初期只支持全量同步。",
    ].join("\n");
    const { revision } = capture(
      store,
      "business-doc-1",
      "订单同步说明",
      doc,
    );

    const profile = latestProfile(store, revision.id);
    expect(profile.derived).toBe(true);
    expect(profile.carrierType).toBe("markdown");
    expect(profile.titlePath.map((h) => h.text)).toEqual(
      expect.arrayContaining(["订单同步说明", "触发方式", "失败处理"]),
    );
    expect(profile.discourseSegments.length).toBeGreaterThan(0);

    // The original fragments are immediately keyword-searchable.
    const retrieval = new KeywordRetrieval(store.db);
    const hits = retrieval.searchSources({ text: "仓储系统", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain("仓储");

    // Zero per-sentence confirmation: no decisions, no quality datasets, a single receipt.
    expect(count(store, "SELECT count(*) FROM decisions")).toBe(0);
    expect(count(store, "SELECT count(*) FROM quality_datasets")).toBe(0);
    expect(store.notifications().length).toBe(1);
    expect(retrieval.health()).toEqual({
      available: true,
      backend: "sqlite-fts5-relevance@3",
    });
  });

  it("G02: keeps parent context for anaphora and separates present-state from planning discourse", () => {
    const store = setup();
    const doc = [
      "# 订单同步",
      "",
      "当前订单同步每小时执行一次，失败后自动重试。",
      "",
      "未来可能会引入增量同步，减少全量拉取。",
      "",
      "## 重试策略",
      "",
      "上述三种重试方式均已上线运行。",
    ].join("\n");
    const { revision } = capture(store, "biz-tenses", "时态文档", doc);
    const profile = latestProfile(store, revision.id);

    const present = profile.discourseSegments.find((s) =>
      s.snippet.includes("当前订单同步"),
    )!;
    expect(present.tense).toBe("present");

    const planned = profile.discourseSegments.find((s) =>
      s.snippet.includes("未来可能"),
    )!;
    expect(planned.kind).toBe("plan");
    expect(planned.tense).toBe("future");

    const backref = profile.discourseSegments.find((s) =>
      s.snippet.includes("上述三种"),
    )!;
    expect(backref.refParent).toBe(true);
    expect(backref.parentHeading).toBe("重试策略");

    // It is not flattened into a single "explicit verified fact" bucket.
    const kinds = new Set(profile.discourseSegments.map((s) => s.kind));
    expect(kinds.has("plan")).toBe(true);
    expect(profile.temporalNotes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("当前"),
        expect.stringContaining("未来"),
      ]),
    );
  });

  it("G03: code, SQL examples and TODOs are parsed as code examples, not owner instructions", () => {
    const store = setup();
    const doc = [
      "SELECT * FROM orders WHERE status = 'pending';",
      "",
      "// TODO: retry on HTTP 503 before surfacing the error",
      "",
      "const fixture = { expected: true, retries: 3 };",
      "",
      "客服团队需要在订单异常时主动跟进处理。",
    ].join("\n");
    const { revision } = capture(store, "code-sample", "代码片段", doc);
    const profile = latestProfile(store, revision.id);

    const codeSegments = profile.discourseSegments.filter((s) =>
      s.tags.includes("code"),
    );
    expect(codeSegments.length).toBe(3);
    for (const segment of codeSegments)
      expect(segment.kind).toBe("example");
    expect(
      profile.discourseSegments.every((s) => s.kind !== "instruction"),
    ).toBe(true);

    // Code/TODO must not become an owner task.
    expect(store.tasks()).toHaveLength(0);
  });

  it("G12: recalling an already-applied memory by keyword when new material reuses its terms", () => {
    const store = setup();
    const retrieval = new KeywordRetrieval(store.db);

    // Seed an existing active memory about order-sync retries.
    store.applications.applyMemory({
      metadata: {
        workspaceId: "personal",
        applicationId: "seed-memory-1",
        proposalDigest: createHash("sha256")
          .update("seed-memory-1")
          .digest("hex"),
        generation: 1,
        title: "Apply seed memory",
        details: "existing memory",
        delivery: {
          channelBindingVersion: 1,
          channel: "in_app",
          target: "notification-center",
        },
      },
      memory: {
        kind: "claim",
        scope: { workspace_id: "personal" },
        body: { statement: "订单同步重试策略：失败后自动重试最多三次" },
        evidenceSet: [],
      },
    });

    // New material that reuses the same keywords must recall the existing object.
    const hits = retrieval.searchMemories({
      text: "订单同步重试 最多三次",
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.kind).toBe("claim");
    expect(hits[0]!.status).toBe("active");
    expect(hits[0]!.snippet).toContain("订单同步");

    // Unrelated query must not surface the memory.
    expect(retrieval.searchMemories({ text: "飞书入职审批流程", limit: 5 })).toHaveLength(0);
  });

  it("readEvidence returns fixed fragment text and null for unknown ids", () => {
    const store = setup();
    const { revision } = capture(
      store,
      "evidence-read",
      "证据读取",
      "第一段内容\n\n第二段独特内容",
    );
    const retrieval = new KeywordRetrieval(store.db);
    const first = revision.fragments[0]!;
    expect(
      retrieval.readEvidence(revision.id, first.id)?.text,
    ).toBe("第一段内容");
    expect(retrieval.readEvidence(revision.id)).not.toBeNull();
    expect(retrieval.readEvidence("missing-revision")).toBeNull();
    expect(retrieval.readEvidence(revision.id, "missing-fragment")).toBeNull();
  });

  it("profile failure cannot hide the original source", () => {
    const store = setup();
    const { revision } = capture(
      store,
      "partial-profile",
      "含表格的文档",
      "# 标题\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n正常段落。",
    );
    const profile = latestProfile(store, revision.id);
    // Table-like content is flagged as a coverage gap rather than dropped.
    expect(profile.coverageGaps.length).toBeGreaterThan(0);
    expect(profile.status).toBe("partial");
    // Original evidence is still fully readable.
    expect(store.fragments(revision.id).length).toBeGreaterThan(0);
  });
});


it("fuses active memory routes with original evidence and filters before the result limit", () => {
  const store = setup();
  const { revision } = capture(store, "route", "实测记录", "错误码 E42 表示供应商没有回应。");
  store.applications.applyMemory({
    metadata: { workspaceId: "personal", applicationId: "recall-alias", proposalDigest: "alias",
      generation: 1, title: "记住故障别名", details: "fixture",
      delivery: { channelBindingVersion: 1, channel: "in_app", target: "notification-center" } },
    memory: { kind: "claim", scope: { workspace_id: "personal" }, body: { statement: "Aurora timeout" },
      evidenceSet: [{ source_revision_id: revision.id, fragment_revision_id: revision.fragments[0]!.id }] },
  });
  const retrieval = new KeywordRetrieval(store.db);
  const hit = retrieval.searchSources({ text: "Aurora" });
  expect(hit.map(h => h.fragmentId)).toEqual([revision.fragments[0]!.id]);
  expect(hit[0]!.routes).toContain("memory");
  expect(hit[0]!.snippet).toContain("E42");
  expect(retrieval.searchSources({ text: "Aurora", visible: () => false })).toEqual([]);
  expect(retrieval.searchSources({ text: "Aurora", timeRange: { to: "2000-01-01" } })).toEqual([]);
  capture(store, "route", "实测记录", "新版错误码不再有该含义。");
  expect(retrieval.searchSources({ text: "Aurora" })).toEqual([]);
});

it("indexes capture and restore, matches short Chinese and title, and excludes derived answers", () => {
  const store = setup();
  const original = capture(store, "fts", "CircuitBreaker", "熔断机制限制持续失败。").revision;
  const retrieval = new KeywordRetrieval(store.db);
  expect(retrieval.searchSources({ text: "CircuitBreaker" })[0]!.fragmentId).toBe(original.fragments[0]!.id);
  expect(retrieval.searchSources({ text: "熔断" })).toHaveLength(1);
  store.capture({ source: "manual", externalId: "derived", title: "答案", parts: [{ type: "text", text: "ImaginaryEvidence" }], context: { derived: true } });
  expect(retrieval.searchSources({ text: "ImaginaryEvidence" })).toEqual([]);
  for (let i=0; i<25; i++) capture(store, `hidden-${i}`, "CircuitBreaker", "私密 CircuitBreaker");
  expect(retrieval.searchSources({ text: "CircuitBreaker", limit: 1, visible: id => id === original.fragments[0]!.id }).map(h => h.fragmentId)).toEqual([original.fragments[0]!.id]);
});
