import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import {
  KnowledgeRepository,
  bindKnowledgeQuotes,
  materialFromRevision,
} from "../src/knowledge/repository.js";
import {
  restoreKnowledgeArticles,
  writeKnowledgeArticle,
} from "../src/knowledge/artifacts.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";
import type { KnowledgeArtifact } from "../../../packages/contracts/src/knowledge.js";
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f()),
);
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-retention-"));
  const store = new Store(dir);
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => store.close(),
  );
  const capture = (
    text: string,
    source: "file" | "manual" | "lark" = "file",
    context: Record<string, unknown> = {},
  ) =>
    store.capture(
      {
        source,
        externalId: "input",
        title: "材料",
        parts: [{ type: "text", text }],
        context,
      },
      { learning: false },
    );
  return { dir, store, capture };
}
function reviewed(
  repository: KnowledgeRepository,
  key = "guide:input",
): KnowledgeArtifact {
  const m = repository.materials()[0]!;
  return {
    version: 1,
    publication: { role: "article" },
    document: bindKnowledgeQuotes(
      {
        key,
        title: "返回值说明",
        summary: "返回值由材料中的常量决定。",
        category: "implementation",
        sections: [
          { key: "return", title: "返回值", body: "函数返回固定值。[[c1]]" },
        ],
        citations: [
          {
            key: "c1",
            label: "返回语句",
            reason: "实现直接返回这个值。",
            relation: "supports",
            target: { kind: "material", key: m.key, startLine: 1, endLine: 1 },
            quote: "",
          },
        ],
        questions: [],
      },
      new Map([[m.key, m]]),
    ),
    dependencies: [{ kind: "material", key: m.key, digest: m.digest }],
    generation: { model: "fixture", at: "2026-01-01T00:00:00Z", trace: {} },
    review: {
      model: "fixture-independent",
      at: "2026-01-01T00:00:01Z",
      trace: {},
      verdict: "accepted",
    },
  };
}
it("keeps only the latest mutable body and reports old references as unavailable", () => {
  const { store, capture } = setup();
  const first = capture("function value(){return OLDVALUE;}");
  expect(materialFromRevision(store, first.revision.id)?.text).toContain(
    "OLDVALUE",
  );
  const second = capture("function value(){return NEWVALUE;}");
  expect(store.history(first.revision.sourceId)).toHaveLength(1);
  expect(store.revision(first.revision.id)).toBeNull();
  expect(store.evidence(first.revision.fragments[0]!.id)).toBeNull();
  expect(materialFromRevision(store, first.revision.id)).toBeNull();
  expect(store.retention.revisionAvailability(first.revision.id)).toMatchObject(
    { available: false, replacementRevisionId: second.revision.id },
  );
  expect(
    store.db
      .prepare("SELECT body FROM revisions WHERE id=?")
      .get(first.revision.id)!.body,
  ).not.toContain("OLDVALUE");
  expect(
    store.db
      .prepare("SELECT text FROM fragments WHERE revision_id=?")
      .get(first.revision.id)!.text,
  ).toBe("");
  expect(
    new KeywordRetrieval(store.db).searchSources({ text: "OLDVALUE" }),
  ).toEqual([]);
  expect(store.revision(second.revision.id)?.fragments[0]?.text).toContain(
    "NEWVALUE",
  );
});
it("retains chat and manual corrections as events while Lark documents replace raw bytes", () => {
  const { store, capture } = setup();
  const manual = capture("原反馈", "manual");
  capture("新反馈", "manual");
  expect(store.revision(manual.revision.id)).not.toBeNull();
  const chat = capture("原消息", "lark", { chat: { messageId: "message" } });
  capture("消息更正", "lark", { chat: { messageId: "message" } });
  expect(store.retention.policy(chat.revision.sourceId).policy).toBe("event");
  expect(store.revision(chat.revision.id)).not.toBeNull();
  const doc = store.capture(
    {
      source: "lark",
      externalId: "doc",
      title: "文档",
      parts: [{ type: "text", text: "文档旧正文" }],
      context: { document: {} },
    },
    { learning: false },
  );
  store.capture(
    {
      source: "lark",
      externalId: "doc",
      title: "文档",
      parts: [{ type: "text", text: "文档新正文" }],
      context: { document: {} },
    },
    { learning: false },
  );
  expect(store.retention.policy(doc.revision.sourceId).policy).toBe("latest");
  expect(store.revision(doc.revision.id)).toBeNull();
});
it("compacts existing mutable history on reopen and performs one asset sweep", () => {
  const { dir, store, capture } = setup();
  const first = capture("old");
  store.retention.setPolicy(first.revision.sourceId, "event");
  capture("new");
  store.db
    .prepare("DELETE FROM source_retention WHERE source_id=?")
    .run(first.revision.sourceId);
  store.close();
  cleanup.pop();
  const reopened = new Store(dir);
  cleanup.push(() => reopened.close());
  expect(reopened.revision(first.revision.id)).toBeNull();
  expect(reopened.history(first.revision.sourceId)).toHaveLength(1);
});
it("reclaims replaced assets but keeps downloaded inputs awaiting parsing", () => {
  const { dir, store, capture } = setup();
  const bytes = Buffer.from("original document bytes"),
    asset = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(dir, "assets", asset), bytes);
  store.db.exec(
    "CREATE TABLE document_imports(id TEXT PRIMARY KEY,original_asset_id TEXT,state TEXT)",
  );
  store.db
    .prepare("INSERT INTO document_imports VALUES('pending',?,'failed')")
    .run(asset);
  capture("old", "file", { document: { originalAssetId: asset } });
  capture("new");
  expect(existsSync(join(dir, "assets", asset))).toBe(true);
  store.db.prepare("DELETE FROM document_imports WHERE id='pending'").run();
  expect(store.retention.sweepAssets().removed).toContain(asset);
  expect(existsSync(join(dir, "assets", asset))).toBe(false);
});
it("clears all old article bodies and blocks stale imports or late publication", () => {
  const { dir, store, capture } = setup();
  capture("return 42;");
  const repository = new KnowledgeRepository(store),
    artifact = reviewed(repository),
    article = repository.publish(artifact);
  const assets = join(dir, "articles");
  writeKnowledgeArticle(assets, article);
  const result = repository.clear(article.document.key);
  expect(result.removedRevisions).toEqual([article.revision]);
  expect(repository.get(article.document.key, article.revision)).toBeNull();
  expect(
    repository.availability(article.document.key, article.revision)?.reason,
  ).toContain("已清除");
  expect(
    store.db.prepare("SELECT count(*) n FROM knowledge_revisions").get()!.n,
  ).toBe(0);
  expect(restoreKnowledgeArticles(repository, assets)[0]?.state).toBe(
    "removed",
  );
  expect(repository.get(article.document.key)).toBeNull();
  expect(() => repository.publish(artifact)).toThrow("已清除");
  const newer = {
    ...artifact,
    generation: {
      ...artifact.generation,
      at: new Date(Date.now() + 1000).toISOString(),
    },
  };
  expect(repository.publish(newer).document.title).toBe(article.document.title);
});
it("clears source learning while preserving manual task edits and expires old leases", () => {
  const { store, capture } = setup();
  const source = capture("需求需要实现");
  const evidenceId = source.revision.fragments[0]!.id;
  const generated = store.createTask({
    title: "模型事项",
    detail: "去实现",
    dueAt: null,
    evidenceId,
  });
  const edited = store.createTask({
    title: "人工事项",
    detail: "已处理",
    dueAt: null,
    evidenceId,
  });
  for (const task of [generated, edited])
    store.db
      .prepare(
        `INSERT INTO application_receipts(id,workspace_id,application_id,proposal_digest,application_generation,request_digest,entity_type,entity_id,entity_version,change_id,created_at) VALUES(?,'personal',?,?,1,?,'task',?,1,?,?)`,
      )
      .run(
        task.id,
        "proposal:" + task.id,
        task.id,
        task.id,
        task.id,
        store.changes()[0]!.id,
        new Date().toISOString(),
      );
  store.setTaskStatus(edited.id, "done", 1);
  const job = store.jobs.enqueue({
    kind: "extract_claims",
    inputRefs: [{ revisionId: source.revision.id }],
    roleVersion: "1",
    policyVersion: "1",
  }).job;
  const result = store.retention.clearDerived(source.revision.sourceId, {
    learning: true,
  });
  expect(result.cleared.tasks).toEqual([generated.id]);
  expect(result.preserved.tasks).toEqual([edited.id]);
  expect(store.tasks()).toMatchObject([
    { id: edited.id, status: "done", evidenceId: null },
  ]);
  expect(store.jobs.get(job.id)).toMatchObject({
    state: "cancelled",
    cancelRequested: true,
    resultRef: null,
  });
  expect(
    store.retention.revisionAvailability(source.revision.id)?.available,
  ).toBe(true);
});
it("source deletion actually clears dependent article prose, raw text, and model outputs", () => {
  const { store, capture } = setup();
  const source = capture("return 42;");
  const repository = new KnowledgeRepository(store),
    article = repository.publish(reviewed(repository));
  const result = store.retention.deleteSource(source.revision.sourceId);
  expect(result.cleared.articles).toEqual([article.document.key]);
  expect(repository.get(article.document.key)).toBeNull();
  expect(store.revision(source.revision.id)).toBeNull();
  expect(
    store.retention.revisionAvailability(source.revision.id)?.reason,
  ).toContain("用户已删除");
  const reimport = capture("return 99;");
  expect(reimport.revision.version).toBe(2);
});

it("removes generated memory prose but keeps a manually maintained memory", () => {
  const { store, capture } = setup(),
    source = capture("用户学习偏好"),
    at = new Date().toISOString();
  for (const [id, application] of [
    ["generated-memory", "proposal:memory"],
    ["edited-memory", "manual:memory"],
  ]) {
    const revisionId = id + ":v1";
    store.db
      .prepare(
        "INSERT INTO memories VALUES(?,'personal','claim','{}',?,1,'active',?,?)",
      )
      .run(id, revisionId, at, at);
    store.db
      .prepare(
        "INSERT INTO memory_revisions VALUES(?,'personal',?,1,?,NULL,NULL,'active',?,NULL,?)",
      )
      .run(
        revisionId,
        id,
        JSON.stringify({ statement: id }),
        JSON.stringify([source.revision.fragments[0]!.id]),
        at,
      );
    store.db
      .prepare("INSERT INTO memory_dependencies VALUES(?,?,?,?, 'current')")
      .run(revisionId, source.revision.sourceId, source.revision.id, 1);
    store.db
      .prepare(
        "INSERT INTO application_receipts(id,workspace_id,application_id,proposal_digest,application_generation,request_digest,entity_type,entity_id,entity_version,change_id,created_at) VALUES(?,'personal',?,?,1,?,'memory',?,1,?,?)",
      )
      .run(id, application, id, id, id, store.changes()[0]!.id, at);
  }
  const result = store.retention.clearDerived(source.revision.sourceId, {
    learning: true,
  });
  expect(result.cleared.memories).toEqual(["generated-memory"]);
  expect(result.preserved.memories).toEqual(["edited-memory"]);
  expect(
    store.db
      .prepare(
        "SELECT body FROM memory_revisions WHERE memory_id='generated-memory'",
      )
      .get(),
  ).toBeUndefined();
  expect(
    store.db
      .prepare(
        "SELECT body FROM memory_revisions WHERE memory_id='edited-memory'",
      )
      .get()!.body,
  ).toContain("edited-memory");
  expect(
    store.db.prepare("SELECT count(*) n FROM memory_dependencies").get()!.n,
  ).toBe(0);
});
