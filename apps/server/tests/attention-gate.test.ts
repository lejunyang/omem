import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { MemoryService } from "../src/memory/service.js";
import { KeywordRetrieval } from "../src/retrieval/keyword.js";
import { recordSourceRefresh } from "../src/learning/refresh.js";
import type { Proposal } from "../../../packages/contracts/src/index.js";

const directories: string[] = [];
const stores: Store[] = [];
const temporary = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

let sequence = 0;
const capture = (
  store: Store,
  text: string,
  options: { externalId?: string; actorId?: string } = {},
) =>
  store.capture({
    source: "manual",
    externalId: options.externalId ?? `ag-source-${++sequence}`,
    title: "Attention gate evidence",
    parts: [{ type: "text", text }],
    context: { application: "attention-gate-test" },
    provenance: {
      collectorId: "ag-test",
      actorId: options.actorId ?? "owner",
      actorType: "owner",
      actorVerifiedBy: "authenticated-test",
      sourceUri: null,
      eventId: null,
      eventAt: "2026-09-27T09:00:00Z",
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  }).revision;

const evidence = (revision: ReturnType<typeof capture>) => {
  const fragment = revision.fragments[0]!;
  return {
    fragment_revision_id: fragment.id,
    source_revision_id: revision.id,
    exact_quote: fragment.text,
    selector: {
      start: 0,
      end: Array.from(fragment.text).length,
      unit: "unicode_codepoint" as const,
    },
  };
};

const claim = (
  revision: ReturnType<typeof capture>,
  statement: string,
  patch: Partial<Proposal> = {},
): Proposal =>
  ({
    schema_version: 1,
    proposal_id: `proposal-ag-${++sequence}`,
    kind: "claim",
    operation: "create",
    scope: {
      workspace_id: "personal",
      project_id: "payments",
      subject_id: "service-a",
    },
    body: {
      statement,
      attribution: "source states",
      valid_from: null,
      valid_to: null,
    },
    evidence: [evidence(revision)],
    uncertainties: [],
    reason: "scoped statement",
    expected_versions: {},
    origin: {
      job_id: "job-ag",
      role_bundle: "verifier@1",
      producer_kind: "derived",
    },
    ...patch,
  }) as Proposal;

const supported = (reasonCode = "direct_support") => ({
  semantic_verdict: "supported" as const,
  reviewer_version: "reviewer@1",
  role_version: "verifier@1",
  reason_code: reasonCode,
  details: "Deterministic injected verdict.",
});

const setup = () => {
  const directory = temporary("omem-attention-");
  const store = new Store(directory);
  stores.push(store);
  return {
    store,
    memory: new MemoryService(store, { ownerId: "owner", maxAutoApply: 10 }),
    retrieval: new KeywordRetrieval(store.db),
  };
};

describe("Batch-2 AttentionGate and on-demand knowledge consolidation", () => {
  it("G10: off-task material with missing time/scope is deferred, retrievable, never a decision card", () => {
    const { store, memory, retrieval } = setup();
    const revision = capture(store, "内部文档提到一个待确认的接口");
    const result = memory.evaluate(
      claim(revision, "接口可能在月底前对齐", { uncertainties: ["scope_unknown"] }),
      { ...supported(), semantic_verdict: "insufficient" },
    );
    expect(result.policy).toBe("defer_until_use");
    expect(result.decisionId).toBeUndefined();
    expect(memory.decisions()).toEqual([]);
    // Nothing promoted to active knowledge...
    expect(memory.memories()).toEqual([]);
    // ...but the source material stays searchable (deferred, not discarded).
    const hits = retrieval.searchSources({ text: "待确认的接口", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("G11: a conflict that overwrites existing knowledge becomes one contextual decision, not a JSON blob", () => {
    const { store, memory } = setup();
    const first = capture(store, "服务 A 已启用重试", { externalId: "ag-authority-one" });
    const applied = memory.evaluate(claim(first, "服务 A 已启用重试"), supported());
    const memoryId = applied.receipt!.entityId;
    const second = capture(store, "服务 A 已切换为熔断", { externalId: "ag-authority-two" });
    const result = memory.evaluate(
      claim(second, "服务 A 已切换为熔断", {
        operation: "supersede",
        target_id: memoryId,
        expected_versions: { [memoryId]: 1 },
      }),
      supported(),
    );
    expect(result.policy).toBe("awaiting_decision");
    expect(result.reasons).toContain("cross_source_conflict");
    expect(result.decisionId).toBeTruthy();
    // The existing knowledge is NOT silently overwritten.
    expect(memory.memories()).toMatchObject([
      { id: memoryId, version: 1, status: "active" },
    ]);
    const decisions = memory.decisions();
    expect(decisions).toHaveLength(1);
    // The card carries real context: the proposal it gates and the workspace.
    expect(decisions[0]).toMatchObject({
      state: "pending",
      proposalDigest: result.proposalDigest,
    });
  });

  it("G12a: the same statement from an overlapping source links to the existing memory, no second active row", () => {
    const { store, memory } = setup();
    const source = capture(store, "服务 A 已启用重试", { externalId: "ag-dup" });
    const first = memory.evaluate(claim(source, "服务 A 已启用重试"), supported());
    expect(first.policy).toBe("auto_apply");
    expect(memory.memories()).toHaveLength(1);
    // Same fact, fresh proposal id, same source evidence.
    const again = memory.evaluate(claim(source, "服务 A 已启用重试"), supported());
    expect(again.match).toMatchObject({
      kind: "duplicate_linked",
      memoryId: first.receipt!.entityId,
    });
    expect(again.decisionId).toBeUndefined();
    expect(memory.decisions()).toEqual([]);
    // Still exactly one active memory.
    expect(memory.memories()).toHaveLength(1);
  });

  it("G12b: two supported but opposite claims keep both source attributions as a recorded dispute", () => {
    const { store, memory, retrieval } = setup();
    const sourceOne = capture(store, "服务 A 已启用重试", { externalId: "ag-conflict-one" });
    memory.evaluate(claim(sourceOne, "服务 A 已启用重试"), supported());
    const sourceTwo = capture(store, "服务 A 已禁用重试", { externalId: "ag-conflict-two" });
    const result = memory.evaluate(
      claim(sourceTwo, "服务 A 已禁用重试"),
      supported("contradicts_existing"),
    );
    expect(result.match?.kind).toBe("conflict_recorded");
    // Neither side is auto-applied; no decision card for a non-blocking conflict.
    expect(result.decisionId).toBeUndefined();
    expect(memory.decisions()).toEqual([]);
    // The original claim stays active; the contradictory new claim is not promoted.
    expect(memory.memories()).toHaveLength(1);
    // The dispute is recorded, not hidden.
    const disputes = store.db
      .prepare("SELECT * FROM knowledge_disputes WHERE status='recorded'")
      .all() as { proposed_statement: string; existing_statement: string }[];
    expect(disputes).toHaveLength(1);
    expect(disputes[0].proposed_statement).toContain("已禁用");
    expect(disputes[0].existing_statement).toContain("已启用");
    // Both sources remain searchable.
    expect(retrieval.searchSources({ text: "重试", limit: 10 }).length).toBeGreaterThan(0);
  });

  it("G13: a source revision update records the affected memories and they stop being active evidence", () => {
    const { store, memory, retrieval } = setup();
    const source = capture(store, "服务 A 已启用重试", { externalId: "ag-refresh" });
    const applied = memory.evaluate(claim(source, "服务 A 已启用重试"), supported());
    const memoryId = applied.receipt!.entityId;
    // Before the update the memory is active evidence.
    expect(
      retrieval.searchMemories({ text: "服务 A 重试", limit: 10 }).map((m) => m.id),
    ).toContain(memoryId);
    // The source advances; capture invalidates dependents deterministically.
    const updated = store.capture({
      source: "manual",
      externalId: "ag-refresh",
      title: "Attention gate evidence",
      parts: [{ type: "text", text: "服务 A 现已下线" }],
      context: { application: "attention-gate-test" },
      provenance: {
        collectorId: "ag-test",
        actorId: "owner",
        actorType: "owner",
        actorVerifiedBy: "authenticated-test",
        sourceUri: null,
        eventId: null,
        eventAt: "2026-09-27T10:00:00Z",
        timezone: "Asia/Shanghai",
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    });
    // Invalidation alone records the blast radius; it must not claim a review
    // before the extractor and independent verifier have run.
    const recorded = recordSourceRefresh(store.db, "personal", [
      {
        sourceId: source.sourceId,
        previousRevisionId: source.id,
        revisionId: updated.revision.id,
      },
    ]);
    expect(recorded).toMatchObject({
      status: "needs_review",
      affectedCount: 1,
    });
    expect(recorded.affectedMemoryIds).toContain(memoryId);
    expect("reviewed" in recorded).toBe(false);
    const row = store.db
      .prepare("SELECT affected_count, status FROM refresh_records WHERE source_id=?")
      .get(source.sourceId) as { affected_count: number; status: string };
    expect(row.affected_count).toBe(1);
    expect(row.status).toBe("needs_review");
    // The invalidated memory is no longer treated as active evidence.
    expect(
      retrieval.searchMemories({ text: "服务 A 重试", limit: 10 }).map((m) => m.id),
    ).not.toContain(memoryId);
  });

  it("G17: a change rippling to many dependent memories is gated even when no batch impact is supplied", () => {
    const { store, memory } = setup();
    const shared = capture(store, "共享来源事实", { externalId: "ag-shared" });
    const target = memory.evaluate(claim(shared, "目标事实"), supported());
    const targetId = target.receipt!.entityId;
    // Ten sibling active memories depend on the same source.
    for (let i = 0; i < 10; i++)
      memory.evaluate(claim(shared, `兄弟事实 ${i}`), supported());
    expect(memory.memories()).toHaveLength(11);
    // Supersede the target from the SAME source (no cross-source conflict), but
    // the real ripple impact is 11. The caller passes no impactCount, so the
    // gate must compute it itself rather than trusting impact=1.
    const result = memory.evaluate(
      claim(shared, "目标事实（修订）", {
        operation: "supersede",
        target_id: targetId,
        expected_versions: { [targetId]: 1 },
      }),
      supported(),
    );
    expect(result.policy).toBe("awaiting_decision");
    expect(result.reasons).toContain("impact_limit_exceeded");
    expect(result.decisionId).toBeTruthy();
  });

  it("P0: a cross-source update on non-active knowledge that does not block the current task is deferred, never asked", () => {
    const { store, memory } = setup();
    const sourceOne = capture(store, "服务 A 已启用重试", { externalId: "p0-defer-one" });
    const applied = memory.evaluate(claim(sourceOne, "服务 A 已启用重试"), supported());
    const memoryId = applied.receipt!.entityId;
    // The existing memory is no longer active important knowledge.
    store.db.prepare("UPDATE memories SET status='superseded' WHERE id=?").run(memoryId);
    const sourceTwo = capture(store, "服务 A 已切换为熔断", { externalId: "p0-defer-two" });
    const result = memory.evaluate(
      claim(sourceTwo, "服务 A 已切换为熔断", {
        operation: "supersede",
        target_id: memoryId,
        expected_versions: { [memoryId]: 1 },
      }),
      supported(),
      // Not related to / not blocking any current task.
      { relatedTask: { blocksNow: false } },
    );
    expect(result.reasons).toContain("cross_source_conflict");
    expect(result.policy).toBe("defer_until_use");
    expect(result.decisionId).toBeUndefined();
    expect(memory.decisions()).toEqual([]);
  });

  it("P0: a blocking conflict produces one AttentionCase with question, options and attempted resolution", () => {
    const { store, memory } = setup();
    const sourceOne = capture(store, "服务 A 已启用重试", { externalId: "p0-case-one" });
    const applied = memory.evaluate(claim(sourceOne, "服务 A 已启用重试"), supported());
    const memoryId = applied.receipt!.entityId;
    const sourceTwo = capture(store, "服务 A 已禁用重试", { externalId: "p0-case-two" });
    const result = memory.evaluate(
      claim(sourceTwo, "服务 A 已禁用重试", {
        operation: "supersede",
        target_id: memoryId,
        expected_versions: { [memoryId]: 1 },
      }),
      supported(),
      { relatedTask: { blocksNow: true } },
    );
    expect(result.policy).toBe("awaiting_decision");
    const decisions = memory.decisions();
    expect(decisions).toHaveLength(1);
    const attentionCase = decisions[0]!.attentionCase;
    expect(attentionCase).toBeTruthy();
    expect(String(attentionCase.question).length).toBeGreaterThan(0);
    expect(Array.isArray(attentionCase.options)).toBe(true);
    expect(attentionCase.options.length).toBeGreaterThan(0);
    expect(String(attentionCase.attemptedResolution).length).toBeGreaterThan(0);
    expect(attentionCase.linkedTask).toBe(memoryId);
  });

  it("P0 G17: evaluateBatch unions deduped impact, gates over-budget batches atomically, raises one AttentionCase", () => {
    const { store, memory } = setup();
    // 12 independent creates, each its own statement backed by its OWN source.
    const entries = Array.from({ length: 12 }, (_, i) => {
      const src = capture(store, `批量原文${i}`, { externalId: `p0-batch-new-${i}` });
      return { proposal: claim(src, `批量新事实 ${i}`), assessment: supported() };
    });
    // Unioned impact = 12 distinct new entities > 10, gated as ONE ChangeSet.
    const result = memory.evaluateBatch(entries);
    expect(result.totalImpact).toBe(12);
    expect(result.affectedMemoryIds).toEqual([]);
    expect(result.affectedEntities).toHaveLength(12);
    expect(result.outcome).toBe("awaiting_decision");
    expect(result.decisionId).toBeTruthy();
    expect(result.results).toHaveLength(12);
    expect(
      result.results.every(
        (row) => row.policy === "awaiting_decision" && row.batchDeferred,
      ),
    ).toBe(true);
    // Atomicity: nothing materialized — no active memories, no receipts.
    expect(
      Number(
        (
          store.db
            .prepare("SELECT count(*) AS c FROM memories WHERE status='active'")
            .get() as { c: number }
        ).c,
      ),
    ).toBe(0);
    // One consolidated card with the full v3 AttentionCase fields.
    const decisions = memory.decisions();
    expect(decisions).toHaveLength(1);
    const ac = decisions[0]!.attentionCase as Record<string, unknown>;
    expect(String(ac.topic)).toContain("批量变更");
    expect(String(ac.question).length).toBeGreaterThan(0);
    expect(Array.isArray(ac.options)).toBe(true);
    expect((ac.options as unknown[]).length).toBeGreaterThan(0);
    expect(String(ac.attemptedResolution).length).toBeGreaterThan(0);
    expect(Array.isArray(ac.evidenceRefs)).toBe(true);
    expect((ac.evidenceRefs as unknown[]).length).toBeGreaterThan(0);
    expect(String(ac.dedupeKey)).toContain("attention-batch");

    // An under-budget single create (impact=1) applies in one pass and raises no
    // additional card.
    const freshSrc = capture(store, "单独原文", { externalId: "p0-batch-fresh" });
    const small = memory.evaluateBatch([
      { proposal: claim(freshSrc, "单独新事实"), assessment: supported() },
    ]);
    expect(small.totalImpact).toBe(1);
    expect(small.outcome).toBe("auto_apply");
    expect(small.decisionId).toBeUndefined();
    expect(small.results[0]!.receipt!.duplicate).not.toBe(true);
    expect(memory.decisions()).toHaveLength(1);
  });
});
