import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { FeedbackService, MemoryService } from "../src/memory/service.js";
import type { Proposal } from "../../../packages/contracts/src/index.js";

const resources: { store: Store; directory: string }[] = [];
const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), "omem-policy-"));
  const store = new Store(directory);
  resources.push({ store, directory });
  return {
    store,
    memory: new MemoryService(store, { ownerId: "owner", maxAutoApply: 10 }),
    feedback: new FeedbackService(store),
  };
};
afterEach(() => {
  for (const { store, directory } of resources.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

let sequence = 0;
const capture = (
  store: Store,
  text: string,
  options: {
    externalId?: string;
    actorId?: string | null;
    verifiedBy?: string | null;
    forwarded?: boolean;
  } = {},
) =>
  store.capture({
    source: "manual",
    externalId: options.externalId ?? `source-${++sequence}`,
    title: "Policy evidence",
    parts: [{ type: "text", text }],
    context: {},
    provenance: {
      collectorId: "policy-test",
      actorId: options.actorId === undefined ? "owner" : options.actorId,
      actorType: options.actorId === null ? "unknown" : "owner",
      actorVerifiedBy:
        options.verifiedBy === undefined
          ? "authenticated-test"
          : options.verifiedBy,
      sourceUri: null,
      eventId: null,
      eventAt: "2026-09-22T08:00:00Z",
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: options.forwarded ?? false,
      producerKind: "original",
    },
  }).revision;

const textEvidence = (revision: ReturnType<typeof capture>) => {
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

const taskProposal = (
  revision: ReturnType<typeof capture>,
  patch: Partial<Proposal> = {},
): Proposal =>
  ({
    schema_version: 1,
    proposal_id: `proposal-${++sequence}`,
    kind: "task",
    operation: "create",
    scope: {
      workspace_id: "personal",
      project_id: "payments",
      subject_id: "owner",
    },
    body: {
      title: "补齐支付重试方案",
      owner_id: "owner",
      due_at: "2026-09-25T10:00:00Z",
      due_expression: "本周五18:00前",
      next_step: "核对现有接口",
    },
    evidence: [textEvidence(revision)],
    uncertainties: [],
    reason: "verified owner commitment",
    expected_versions: {},
    origin: {
      job_id: "job-policy",
      role_bundle: "extractor@1",
      producer_kind: "derived",
    },
    ...patch,
  }) as Proposal;

const claimProposal = (
  revision: ReturnType<typeof capture>,
  statement: string,
  patch: Partial<Proposal> = {},
): Proposal =>
  ({
    schema_version: 1,
    proposal_id: `proposal-${++sequence}`,
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
    evidence: [textEvidence(revision)],
    uncertainties: [],
    reason: "direct scoped statement",
    expected_versions: {},
    origin: {
      job_id: "job-policy",
      role_bundle: "extractor@1",
      producer_kind: "derived",
    },
    ...patch,
  }) as Proposal;

const supported = {
  semantic_verdict: "supported" as const,
  reviewer_version: "reviewer@1",
  role_version: "verifier@1",
  reason_code: "direct_support",
  details: "The fixed evidence supports the scoped proposal.",
};

const count = (store: Store, table: string) =>
  Number(
    (
      store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );

describe("B2-04 extraction policy and application acceptance", () => {
  it("saves a supported fact after independent review resolves peripheral doubts, while preserving material uncertainty", () => {
    const { store, memory } = setup();
    const revision = capture(store, "本轮验收截止时间为10月3日18点。");
    const proposal = () => claimProposal(revision, revision.fragments[0]!.text, {
      uncertainties: ["未说明具体完成口径"],
    });
    expect(memory.evaluate(proposal(), supported).policy).toBe("defer_until_use");
    expect(memory.evaluate(proposal(), { ...supported,
      uncertainty_review: { verdict: "unresolved", reason: "尚不能判断该疑问的影响" },
    }).policy).toBe("defer_until_use");
    const review = { verdict: "non_blocking", reason: "完成口径不改变原文明确约定的截止时间，候选不声称已完成。" } as const;
    expect(memory.evaluate(proposal(), { ...supported, uncertainty_review: review,
      missing_context: ["尚未确定这条期限属于哪个项目"],
    }).policy).toBe("defer_until_use");
    expect(memory.memories()).toEqual([]);
    const candidate = proposal();
    const result = memory.evaluate(candidate, { ...supported, uncertainty_review: review, missing_context: [] });
    expect(result).toMatchObject({ policy: "auto_apply", receipt: { entityType: "memory" } });
    expect(memory.memories()).toHaveLength(1);
    expect(memory.proposals().find(p => p.id === candidate.proposal_id)?.uncertainties).toEqual(candidate.uncertainties);
    const rows = store.db.prepare("SELECT details FROM evidence_assessments").all();
    expect(rows.some(row => JSON.parse(String(row.details)).uncertaintyReview?.reason === review.reason)).toBe(true);

    const forwarded = capture(store, "我周五交方案", { actorId: null, verifiedBy: null, forwarded: true });
    expect(memory.evaluate(taskProposal(forwarded, { uncertainties: ["未说明方案格式"] }), {
      ...supported, uncertainty_review: { verdict: "non_blocking", reason: "格式不影响截止时间" },
    }).policy).toBe("retain_as_source");
    expect(store.tasks()).toEqual([]);
  });

  it("A-K01 auto-applies one explicit owner task with evidence, change and notification", () => {
    const { store, memory } = setup();
    const revision = capture(
      store,
      "我负责在本周五18:00前补齐支付重试方案，先核对现有接口。",
    );
    const proposal = taskProposal(revision);
    const result = memory.evaluate(proposal, supported);
    expect(result).toMatchObject({
      evidenceVerdict: "valid",
      policy: "auto_apply",
      receipt: { entityType: "task", entityVersion: 1 },
    });
    expect(store.tasks()).toMatchObject([
      {
        title: "补齐支付重试方案",
        ownerId: "owner",
        dueAt: "2026-09-25T10:00:00.000Z",
        nextStep: "核对现有接口",
      },
    ]);
    expect(count(store, "application_receipts")).toBe(1);
    expect(count(store, "delivery_intents")).toBe(1);
    expect(count(store, "task_revisions")).toBe(1);
    expect(memory.evaluate(proposal, supported).receipt?.duplicate).toBe(true);
    expect(store.tasks()).toHaveLength(1);
  });

  it("A-K02 keeps forwarded/unknown speech as a source lead, never an owner task", () => {
    const { store, memory } = setup();
    const revision = capture(store, "我周五交方案", {
      actorId: null,
      verifiedBy: null,
      forwarded: true,
    });
    const result = memory.evaluate(taskProposal(revision), supported);
    expect(result.policy).toBe("retain_as_source");
    expect(result.reasons).toContain("owner_not_verified");
    expect(store.tasks()).toEqual([]);
    // F2 AttentionGate: do not ask the owner whether to claim a group lead.
    expect(memory.decisions()).toEqual([]);
    expect(result.decisionId).toBeUndefined();
  });

  it("A-K03 defers ambiguous-time owner material until it is actually used", () => {
    const { store, memory } = setup();
    const revision = capture(store, "也许周五能做，下周再看看");
    const proposal = taskProposal(revision, {
      body: {
        title: "再看看方案",
        owner_id: "owner",
        due_at: null,
        due_expression: "也许周五；下周再看看",
        next_step: "补充明确时间",
      },
      uncertainties: ["time_ambiguous"],
    });
    const result = memory.evaluate(proposal, supported);
    expect(result.policy).toBe("defer_until_use");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["uncertainties_present", "due_time_ambiguous"]),
    );
    expect(store.tasks()).toEqual([]);
    expect(memory.decisions()).toEqual([]);
  });

  it("A-K04 rejects missing, mismatched or tampered evidence with zero active effects", () => {
    const { store, memory } = setup();
    const revision = capture(store, "唯一原文");
    const proposal = taskProposal(revision);
    proposal.evidence[0] = {
      ...proposal.evidence[0]!,
      source_revision_id: "tampered-source",
    } as Proposal["evidence"][number];
    const result = memory.evaluate(proposal, supported);
    expect(result).toMatchObject({
      policy: "reject",
      evidenceVerdict: "invalid",
    });
    expect(store.tasks()).toEqual([]);
    expect(memory.memories()).toEqual([]);
    expect(count(store, "application_receipts")).toBe(0);
  });

  it("A-K05 rejects semantic generalization even when the exact quote exists", () => {
    const { store, memory } = setup();
    const revision = capture(store, "仅测试环境允许关闭校验");
    const proposal = claimProposal(revision, "所有环境允许关闭校验");
    const result = memory.evaluate(proposal, {
      ...supported,
      semantic_verdict: "contradicted",
      reason_code: "scope_generalized",
      details: "The proposal removes the test-only condition.",
    });
    expect(result.policy).toBe("reject");
    expect(memory.memories()).toEqual([]);
  });

  it("A-K06 preserves an active claim when a different source proposes a conflict", () => {
    const { store, memory } = setup();
    const firstSource = capture(store, "服务 A 已启用重试", {
      externalId: "authority-one",
    });
    const first = memory.evaluate(
      claimProposal(firstSource, "服务 A 已启用重试"),
      supported,
    );
    const memoryId = first.receipt!.entityId;
    const otherSource = capture(store, "服务 A 未启用重试", {
      externalId: "authority-two",
    });
    const conflict = claimProposal(otherSource, "服务 A 未启用重试", {
      operation: "supersede",
      target_id: memoryId,
      expected_versions: { [memoryId]: 1 },
    });
    const result = memory.evaluate(conflict, supported);
    expect(result.policy).toBe("awaiting_decision");
    expect(result.reasons).toContain("cross_source_conflict");
    expect(memory.memories()).toMatchObject([
      { id: memoryId, version: 1, status: "active" },
    ]);
  });

  it("A-K07 auto-applies a small safe change but gates large batches and procedures", () => {
    const { store, memory } = setup();
    const revision = capture(store, "我负责整理清单");
    expect(memory.evaluate(taskProposal(revision), supported).policy).toBe(
      "auto_apply",
    );
    const large = taskProposal(revision);
    expect(
      memory.evaluate(large, supported, { impactCount: 11 }),
    ).toMatchObject({
      policy: "awaiting_decision",
      reasons: expect.arrayContaining(["impact_limit_exceeded"]),
    });
    const procedure = {
      ...claimProposal(revision, "procedure candidate"),
      proposal_id: `proposal-${++sequence}`,
      kind: "procedure" as const,
      body: {
        trigger: "deployment",
        preconditions: ["approved"],
        steps: ["deploy"],
        verification: ["health check"],
        counterexamples: [],
        not_applicable: ["production without approval"],
      },
    };
    expect(memory.evaluate(procedure, supported)).toMatchObject({
      policy: "retain_as_source",
      reasons: expect.arrayContaining(["procedure_requires_review"]),
    });
    expect(store.tasks()).toHaveLength(1);
  });

  it("A-K08 rejects approval when a source head changes after review", () => {
    const { store, memory } = setup();
    const firstSource = capture(store, "服务 A 已启用重试", {
      externalId: "stale-authority",
    });
    const first = memory.evaluate(
      claimProposal(firstSource, "服务 A 已启用重试"),
      supported,
    );
    const memoryId = first.receipt!.entityId;
    const otherSource = capture(store, "服务 A 未启用重试", {
      externalId: "stale-authority-two",
    });
    const conflict = claimProposal(otherSource, "服务 A 未启用重试", {
      operation: "supersede",
      target_id: memoryId,
      expected_versions: { [memoryId]: 1 },
    });
    const evaluated = memory.evaluate(conflict, supported);
    expect(evaluated.policy).toBe("awaiting_decision");
    // The second source advances after the decision card was recorded.
    store.capture({
      source: "manual",
      externalId: "stale-authority-two",
      title: "Policy evidence",
      parts: [{ type: "text", text: "来源已经更新" }],
      context: {},
    });
    expect(() =>
      memory.decide(evaluated.decisionId!, {
        action: "approve",
        proposalDigest: evaluated.proposalDigest,
        requestId: "stale-approval",
        actorId: "owner",
      }),
    ).toThrow("STALE_DECISION");
    expect(memory.memories()).toMatchObject([
      { id: memoryId, version: 1, status: "active" },
    ]);
    expect(memory.decisions()).toMatchObject([{ state: "stale" }]);
  });

  it("A-K09 keeps inferred image outcomes as a retained source, no decision card", () => {
    const { store, memory } = setup();
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vO8AAAAASUVORK5CYII=";
    const revision = store.capture({
      source: "screen",
      externalId: "image-evidence",
      title: "Image evidence",
      parts: [
        {
          type: "image",
          mimeType: "image/png",
          data: png,
          label: "unclear result",
        },
      ],
      context: {},
    }).revision;
    const image = revision.parts[0];
    if (image?.type !== "image") throw Error("image missing");
    const proposal: Proposal = {
      schema_version: 1,
      proposal_id: `proposal-${++sequence}`,
      kind: "episode",
      operation: "create",
      scope: {
        workspace_id: "personal",
        project_id: "payments",
        subject_id: "owner",
      },
      body: {
        trigger: "screen observation",
        actions: ["tool attempted"],
        verification_refs: [],
        outcome: "success",
      },
      evidence: [
        {
          fragment_revision_id: revision.fragments[0]!.id,
          source_revision_id: revision.id,
          asset_hash: image.assetId,
          inferred: true,
          region: null,
          observation: "unclear text",
        },
      ],
      uncertainties: [],
      reason: "image-only inference",
      expected_versions: {},
      origin: {
        job_id: "job-image",
        role_bundle: "extractor@1",
        producer_kind: "derived",
      },
    };
    const result = memory.evaluate(proposal, supported);
    expect(result).toMatchObject({
      policy: "retain_as_source",
      reasons: expect.arrayContaining([
        "inferred_image_requires_review",
        "unverified_success",
      ]),
    });
    expect(memory.memories()).toEqual([]);
  });

  it("A-K10 refuses stale restore and invalidates dependencies on source refresh", () => {
    const { store, memory } = setup();
    const sourceV1 = capture(store, "旧值", { externalId: "versioned-source" });
    const initial = memory.evaluate(claimProposal(sourceV1, "旧值"), supported);
    const memoryId = initial.receipt!.entityId;
    const sourceV2 = capture(store, "新值", { externalId: "versioned-source" });
    const updated = memory.evaluate(
      claimProposal(sourceV2, "新值", {
        operation: "supersede",
        target_id: memoryId,
        expected_versions: { [memoryId]: 1 },
      }),
      supported,
    );
    expect(updated.policy).toBe("auto_apply");
    expect(memory.memories()).toMatchObject([{ id: memoryId, version: 2 }]);
    expect(() =>
      memory.restoreMemory({
        memoryId,
        expectedVersion: 1,
        targetVersion: 1,
        requestId: "stale-restore",
      }),
    ).toThrow("REBASE_REQUIRED");
    const sourceV3 = capture(store, "第三版", {
      externalId: "versioned-source",
    });
    expect(store.revision(sourceV1.id)?.fragments[0]?.text).toBe("旧值");
    expect(store.revision(sourceV2.id)?.fragments[0]?.text).toBe("新值");
    expect(store.revision(sourceV3.id)?.current).toBe(true);
    expect(memory.memories()).toMatchObject([
      { id: memoryId, version: 2, status: "invalidated" },
    ]);
    expect(() =>
      memory.restoreMemory({
        memoryId,
        expectedVersion: 2,
        targetVersion: 1,
        requestId: "invalid-dependency-restore",
      }),
    ).toThrow("STALE_MEMORY_DEPENDENCY");
    expect(
      store.jobs.list().some((job) => job.kind === "refresh_dependents"),
    ).toBe(true);
  });
});

describe("B2-04 scoped feedback acceptance", () => {
  it("A-F01 recalls an authenticated same-scope owner correction for the next candidate", () => {
    const { store, feedback } = setup();
    const evidence = capture(store, "负责人应从 A 改为 B");
    const recorded = feedback.record({
      producer: "owner-ui",
      eventId: "feedback-owner-change",
      subjectType: "revision",
      subjectId: "task-1",
      actor: { id: "owner", verifiedBy: "authenticated-session" },
      scope: {
        workspace_id: "personal",
        project_id: "payments",
        subject_id: "owner",
      },
      kind: "task_assignment",
      matchKey: "owner:A",
      replacement: "B",
      evidence: [evidence.fragments[0]!.id],
      producerKind: "original",
    });
    expect(recorded).toMatchObject({ duplicate: false, strength: "confirmed" });
    const candidate = taskProposal(evidence, {
      body: {
        title: "跟进支付",
        owner_id: "A",
        due_at: null,
        due_expression: null,
        next_step: "确认负责人",
      },
    });
    const corrected = feedback.applyConfirmedCorrections(candidate);
    expect(corrected.proposal.body.owner_id).toBe("B");
    expect(corrected.constraintIds).toHaveLength(1);
    const baseMetadata = {
      workspaceId: "personal",
      proposalDigest: createHash("sha256")
        .update("feedback-task")
        .digest("hex"),
      generation: 1,
      title: "feedback task",
      details: "preserve task revisions",
      delivery: {
        channelBindingVersion: 1,
        channel: "in_app",
        target: "notification-center",
      },
    };
    const first = store.applications.applyTask({
      metadata: { ...baseMetadata, applicationId: "feedback-task-v1" },
      task: {
        title: "跟进支付",
        detail: "",
        ownerId: "A",
        nextStep: "确认负责人",
        evidenceId: evidence.fragments[0]!.id,
      },
    });
    store.applications.applyTask({
      metadata: {
        ...baseMetadata,
        applicationId: "feedback-task-v2",
        proposalDigest: createHash("sha256")
          .update("feedback-task-v2")
          .digest("hex"),
      },
      task: {
        id: first.entityId,
        expectedVersion: 1,
        title: "跟进支付",
        detail: "",
        ownerId: corrected.proposal.body.owner_id,
        nextStep: "确认负责人",
        evidenceId: evidence.fragments[0]!.id,
      },
    });
    expect(
      store.db
        .prepare(
          "SELECT owner_id AS ownerId FROM task_revisions WHERE task_id=? ORDER BY version",
        )
        .all(first.entityId),
    ).toEqual([{ ownerId: "A" }, { ownerId: "B" }]);
    expect(store.evidence(evidence.fragments[0]!.id)?.fragment.text).toContain(
      "A 改为 B",
    );
  });

  it("A-F02 deduplicates feedback and keeps usefulness/derived summaries non-authoritative", () => {
    const { store, feedback } = setup();
    const evidence = capture(store, "这个结果有用");
    const useful = {
      producer: "owner-ui",
      eventId: "useful-once",
      subjectType: "query" as const,
      subjectId: "query-1",
      actor: { id: "owner", verifiedBy: "authenticated-session" },
      scope: {
        workspace_id: "personal",
        project_id: "payments",
        subject_id: "owner",
      },
      kind: "useful" as const,
      matchKey: "answer:useful",
      replacement: null,
      evidence: [evidence.fragments[0]!.id],
      producerKind: "original" as const,
    };
    expect(feedback.record(useful).strength).toBe("weak");
    expect(feedback.record(useful).duplicate).toBe(true);
    expect(
      feedback.record({
        ...useful,
        eventId: "derived-summary",
        kind: "fact_correction",
        matchKey: "fact:summary",
        replacement: "generated claim",
        producerKind: "derived",
      }).strength,
    ).toBe("weak");
    expect(count(store, "feedback")).toBe(2);
    expect(feedback.recall(useful.scope)).toEqual([]);
  });

  it("A-F03 isolates corrections by scope and leaves ACL/approval suggestions shadow-only", () => {
    const { store, feedback } = setup();
    const evidence = capture(store, "仅适用于项目 A");
    feedback.record({
      producer: "owner-ui",
      eventId: "scope-a",
      subjectType: "revision",
      subjectId: "memory-1",
      actor: { id: "owner", verifiedBy: "authenticated-session" },
      scope: {
        workspace_id: "personal",
        project_id: "project-a",
        subject_id: "owner",
      },
      kind: "fact_correction",
      matchKey: "fact:deployment",
      replacement: "project-a-only",
      evidence: [evidence.fragments[0]!.id],
      producerKind: "original",
    });
    const policy = feedback.record({
      producer: "owner-ui",
      eventId: "policy-shadow",
      subjectType: "proposal",
      subjectId: "policy-1",
      actor: { id: "owner", verifiedBy: "authenticated-session" },
      scope: {
        workspace_id: "personal",
        project_id: "project-a",
        subject_id: "owner",
      },
      kind: "policy_suggestion",
      matchKey: "acl:auto-approve-all",
      replacement: "allow",
      evidence: [evidence.fragments[0]!.id],
      producerKind: "original",
    });
    expect(policy.strength).toBe("shadow");
    expect(
      feedback.recall({
        workspace_id: "personal",
        project_id: "project-a",
        subject_id: "owner",
      }),
    ).toHaveLength(1);
    expect(
      feedback.recall({
        workspace_id: "personal",
        project_id: "project-b",
        subject_id: "owner",
      }),
    ).toEqual([]);
    expect(
      store.db
        .prepare("SELECT active FROM feedback_constraints WHERE match_key=?")
        .get("acl:auto-approve-all"),
    ).toMatchObject({ active: 0 });
  });
});

describe("P0 conflict association and equivalence persistence", () => {
  it("P5: a contradictory create is associated with the real conflicting memory, not the first unrelated row", () => {
    const { store, memory } = setup();
    const unrelatedSrc = capture(store, "订单系统已于周二上线", {
      externalId: "p5-unrelated",
    });
    memory.evaluate(claimProposal(unrelatedSrc, "订单系统已上线"), supported);
    const existingSrc = capture(store, "服务 A 已启用重试", {
      externalId: "p5-existing",
    });
    const existing = memory.evaluate(
      claimProposal(existingSrc, "服务 A 已启用重试"),
      supported,
    );
    const existingId = existing.receipt!.entityId;
    const newSrc = capture(store, "服务 A 未启用重试", { externalId: "p5-new" });
    const result = memory.evaluate(
      claimProposal(newSrc, "服务 A 未启用重试"),
      { ...supported, reason_code: "contradicts_existing" },
    );
    expect(result.match?.kind).toBe("conflict_recorded");
    expect(result.match?.memoryId).toBe(existingId);
    expect(result.match?.conflictingRevisionId).toBeTruthy();
    expect(result.match?.matchReason).toContain("shared entity terms");
    expect(result.match?.evidenceChain?.existingStatement).toContain("已启用");
    expect((result.match?.evidenceChain?.sharedTerms ?? []).length).toBeGreaterThan(0);
    expect((result.match?.evidenceChain?.proposedEvidenceRefs ?? []).length).toBeGreaterThan(0);
    expect(memory.memories()).toHaveLength(2);
  });

  it("P5: identical text in a different project is not linked as duplicate/equivalent across scope", () => {
    const { store, memory } = setup();
    const srcOne = capture(store, "服务 A 已启用重试", { externalId: "p5-scope-one" });
    memory.evaluate(claimProposal(srcOne, "服务 A 已启用重试"), supported);
    const srcTwo = capture(store, "服务 A 已启用重试", { externalId: "p5-scope-two" });
    const second = memory.evaluate(
      claimProposal(srcTwo, "服务 A 已启用重试", {
        scope: {
          workspace_id: "personal",
          project_id: "billing",
          subject_id: "service-a",
        },
      }),
      supported,
    );
    expect(second.policy).toBe("auto_apply");
    expect(second.match).toBeUndefined();
    expect(memory.memories()).toHaveLength(2);
    expect(count(store, "memory_equivalences")).toBe(0);
  });

  it("P5: equivalent_linked persists a queryable relation with the combined evidence set", () => {
    const { store, memory } = setup();
    const srcOne = capture(store, "服务 A 已启用重试", { externalId: "p5-eq-one" });
    const first = memory.evaluate(
      claimProposal(srcOne, "服务 A 已启用重试"),
      supported,
    );
    const idA = first.receipt!.entityId;
    const srcTwo = capture(store, "服务 A 已启用重试", { externalId: "p5-eq-two" });
    const second = memory.evaluate(
      claimProposal(srcTwo, "服务 A 已启用重试"),
      supported,
    );
    expect(second.match?.kind).toBe("equivalent_linked");
    expect(second.match?.memoryId).toBe(idA);
    const idB = second.receipt!.entityId;
    expect(idB).toBeTruthy();
    const fromA = memory.equivalencesOf(idA);
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({ equivalenceType: "equivalent" });
    expect([fromA[0]!.memoryIdA, fromA[0]!.memoryIdB]).toContain(idB);
    expect(fromA[0]!.evidenceRefs.length).toBeGreaterThan(0);
    expect(memory.equivalencesOf(idB)).toHaveLength(1);
    expect(count(store, "memory_equivalences")).toBe(1);
  });
});
