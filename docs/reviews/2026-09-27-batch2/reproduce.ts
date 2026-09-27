/** Audit reproductions for baseline 16d3aa6. These assertions describe known gaps,
 * not desired product behavior. Uses temporary SQLite only; no Agent/Lark calls. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { QualityLarkAnnotationService } from "../../../apps/server/src/quality/lark-annotations.js";
import { EncryptedSecretStore } from "../../../apps/server/src/integrations/lark/secret-store.js";
import {
  LarkDeliveryRepository,
  LarkDeliveryWorker,
} from "../../../apps/server/src/integrations/lark/delivery.js";
import { Store } from "../../../apps/server/src/store.js";
import {
  MemoryService,
  FeedbackService,
} from "../../../apps/server/src/memory/service.js";
import { LearningPipeline } from "../../../apps/server/src/learning/pipeline.js";
import { documentQualitySamples } from "../../../apps/server/src/quality/import.js";
import { evaluateQuality } from "../../../apps/server/src/quality/evaluator.js";
import { QualityRepository } from "../../../apps/server/src/quality/repository.js";
import {
  LarkEventInbox,
  normalizeLarkEvent,
} from "../../../apps/server/src/integrations/lark/realtime.js";
import {
  captureSchema,
  profileSchema,
  type Proposal,
} from "../../../packages/contracts/src/index.js";
const resources: { s: Store; dir: string }[] = [];
const results: Record<string, unknown>[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omem-review-"));
  const s = new Store(dir);
  resources.push({ s, dir });
  return s;
}
function capture(
  s: Store,
  text: string,
  source = "manual",
  actor = "owner",
  context: Record<string, unknown> = {},
) {
  return s.capture(
    captureSchema.parse({
      source,
      externalId: randomUUID(),
      title: "Synthetic audit material",
      parts: [{ type: "text", text }],
      context,
      provenance: {
        collectorId: "audit",
        actorId: actor,
        actorType: "user",
        actorVerifiedBy: "fixture-receipt",
        sourceUri: null,
        eventId: null,
        eventAt: "2026-09-27T01:00:00Z",
        timezone: "Asia/Shanghai",
        quoted: false,
        forwarded: false,
        producerKind: "original",
      },
    }),
  );
}
function proposal(
  r: ReturnType<typeof capture>["revision"],
  statement: string,
  kind = "claim",
): Proposal {
  const f = r.fragments[0]!;
  return {
    schema_version: 1,
    proposal_id: randomUUID(),
    kind,
    operation: "create",
    scope: {
      workspace_id: "personal",
      project_id: "project-a",
      subject_id: "owner",
    },
    body:
      kind === "task"
        ? {
            title: statement,
            owner_id: "owner",
            due_at: null,
            due_expression: null,
            next_step: "核对",
          }
        : {
            statement,
            attribution: "synthetic source",
            valid_from: null,
            valid_to: null,
          },
    evidence: [
      {
        fragment_revision_id: f.id,
        source_revision_id: r.id,
        exact_quote: f.text,
        selector: {
          start: 0,
          end: Array.from(f.text).length,
          unit: "unicode_codepoint",
        },
      },
    ],
    uncertainties: [],
    reason: "Synthetic review fixture",
    expected_versions: {},
    origin: {
      job_id: "audit-job",
      role_bundle: "fixture",
      producer_kind: "derived",
    },
  } as Proposal;
}
const supported = {
  semantic_verdict: "supported",
  reviewer_version: "fixture",
  role_version: "verifier@1",
  reason_code: "synthetic",
  details:
    "Injected verdict for testing deterministic policy, not an LLM conclusion.",
};
try {
  const text = "当前甲系统与乙主体是单一关联关系，未来可能允许多对多绑定。";
  const input = captureSchema.parse({
    source: "lark",
    externalId: "synthetic",
    title: "Synthetic",
    parts: [{ type: "text", text }],
    context: {},
  });
  const draft = documentQualitySamples(input, "https://example.test/source", 1)
    .samples[0]!;
  assert.equal(draft.draftLabel.objects[0]!.statement, text);
  assert.equal(draft.draftLabel.autoApply, true);
  results.push({
    id: "R1",
    observed:
      "Rule-based sample copies mixed present/future sentence as claim, labels explicit + autoApply=true",
    usesAI: false,
  });
  const q = setup();
  const qr = new QualityRepository(q.db);
  const d = qr.createDataset({
    name: "audit",
    split: "dev",
    sourceUri: "https://example.test/source",
    sourceRevisionId: "1",
    sourceDigest: "a".repeat(64),
    targetCount: 1,
  });
  qr.addSamples(d.id, [draft]);
  let sample = qr.samples(d.id)[0]!;
  qr.label({
    sampleId: sample.id,
    action: "confirm",
    reviewerOpenId: "fixture-owner",
    expectedLabelDigest: sample.labelDigest,
  });
  sample = qr.samples(d.id)[0]!;
  const wrong = {
    ...sample.confirmedLabel!,
    objects: [
      {
        kind: "claim",
        statement: "甲系统已经永远支持任意多对多关系。",
        evidenceQuote: text,
      },
    ],
  };
  const metric = evaluateQuality(
    [sample],
    [{ sampleId: sample.id, prediction: wrong }],
  );
  assert.equal(metric.evidenceSupport.precision, 1);
  assert.equal(metric.exactMatches, 0);
  const abstain = evaluateQuality(
    [sample],
    [
      {
        sampleId: sample.id,
        prediction: {
          disposition: "abstain",
          objects: [],
          autoApply: false,
          forbiddenEffects: [],
          notes: "No objects",
        },
      },
    ],
  );
  assert.equal(abstain.evidenceSupport.precision, 1);
  results.push({
    id: "R2",
    wrongStatementEvidenceSupport: metric.evidenceSupport.precision,
    emptyAnswerEvidenceSupport: abstain.evidenceSupport.precision,
    note: "Other metrics fail; this demonstrates the support metric is quote containment, not entailment.",
  });
  const c = setup();
  const m = new MemoryService(c, { ownerId: "owner" });
  const r1 = capture(c, "生产环境明确禁止使用调试开关。").revision;
  const r2 = capture(c, "生产环境明确允许使用调试开关。").revision;
  const a = m.evaluate(proposal(r1, r1.fragments[0]!.text), supported);
  const b = m.evaluate(proposal(r2, r2.fragments[0]!.text), supported);
  const dup = m.evaluate(proposal(r1, r1.fragments[0]!.text), supported);
  assert.equal(a.policy, "auto_apply");
  assert.equal(b.policy, "auto_apply");
  assert.equal(dup.policy, "auto_apply");
  results.push({
    id: "R3",
    conflictingCreatePolicies: [a.policy, b.policy],
    duplicateCreatePolicy: dup.policy,
    activeMemories: c.db
      .prepare("SELECT count(*) AS n FROM memories WHERE status='active'")
      .get(),
    note: "All source quotes are valid; fake supported verdicts expose the missing existing-memory lookup/dedupe, not model quality.",
  });
  const u = setup();
  const um = new MemoryService(u);
  const ur = capture(u, "一种待讨论的方案，尚无适用范围和结论。").revision;
  const deferred = um.evaluate(
    { ...proposal(ur, "尚待讨论"), uncertainties: ["scope_unknown"] },
    { ...supported, semantic_verdict: "insufficient" },
  );
  assert.equal(deferred.policy, "awaiting_decision");
  assert.equal(um.decisions().length, 1);
  results.push({
    id: "R4",
    lowValueUnknownOutcome: deferred.policy,
    decisions: um.decisions().length,
  });
  const o = setup();
  const om = new MemoryService(o, { ownerId: "owner" });
  const or = capture(o, "我负责整理接口说明。", "chat", "ou_actual_owner", {
    conversationId: "chat-a",
  }).revision;
  const owner = om.evaluate(proposal(or, "整理接口说明", "task"), supported);
  assert.equal(owner.policy, "awaiting_decision");
  assert(owner.reasons.includes("owner_not_verified"));
  results.push({
    id: "R5",
    realLarkIdAgainstCanonicalOwner: owner.policy,
    reason: owner.reasons,
    note: "Lark capture code retains ou_*; no canonical mapping is applied before this policy.",
  });
  const s = setup();
  const raw = capture(s, "用户纠正：重试方法必须先确认幂等条件。", "agent");
  assert.equal(raw.job, null);
  results.push({ id: "R6", originalAgentSessionJob: raw.job });
  const ag = setup();
  const start = new Date("2026-09-27T00:00:00Z");
  for (const [i, actor] of ["alice", "bob"].entries()) {
    ag.inputs.ingest(
      captureSchema.parse({
        source: "chat",
        externalId: "e" + i,
        title: "Same chat",
        observedAt: new Date(start.getTime() + i * 1000).toISOString(),
        parts: [{ type: "text", text: i ? "我只负责评审。" : "我负责开发。" }],
        context: { conversationId: "chat-many" },
        provenance: {
          collectorId: "audit-chat",
          actorId: actor,
          actorType: "user",
          actorVerifiedBy: "fixture",
          sourceUri: null,
          eventId: "e" + i,
          eventAt: new Date(start.getTime() + i * 1000).toISOString(),
          timezone: "Asia/Shanghai",
          quoted: false,
          forwarded: false,
          producerKind: "original",
        },
      }),
      new Date(start.getTime() + i * 1000),
    );
  }
  const batches = ag.inputs.flushReady((x) => ag.capture(x), {
    now: new Date(start.getTime() + 60000),
    quietMs: 1000,
  });
  const ar = ag.revision(batches[0]!.revisionId)!;
  assert.equal(ar.provenance!.actorId, null);
  results.push({
    id: "R7",
    aggregatedActor: ar.provenance!.actorId,
    fragmentTexts: ar.fragments.map((f) => f.text),
    fragmentActorMappingPresent: ar.fragments.some((f) => "actorId" in f),
  });
  const l = setup();
  const at = new Date().toISOString();
  l.db
    .prepare(
      "INSERT INTO lark_connections(id,workspace_id,app_id,tenant_brand,tenant_key,state,active_version,owner_open_id,created_at,updated_at) VALUES('c','personal','cli_fixture','feishu','t','active',1,'ou_owner',?,?)",
    )
    .run(at, at);
  l.db
    .prepare(
      "INSERT INTO lark_connection_versions(id,connection_id,version,secret_ref,requested_config,capability_profile,missing_capabilities,state,created_at,updated_at) VALUES('cv','c',1,'unused','{}','{}','[]','active',?,?)",
    )
    .run(at, at);
  l.db
    .prepare(
      "INSERT INTO lark_bindings(id,workspace_id,connection_id,connection_version,binding_version,owner_open_id,target_chat_id,target_type,state,supersedes_binding_id,created_at) VALUES('b','personal','c',1,1,'ou_owner','oc_owner','p2p','active',NULL,?)",
    )
    .run(at);
  const inbox = new LarkEventInbox(l);
  const event = normalizeLarkEvent("cli_fixture", "im.message.receive_v1", {
    event_id: "dm1",
    sender: { sender_id: { open_id: "ou_owner" }, sender_type: "user" },
    message: {
      chat_id: "oc_owner",
      chat_type: "p2p",
      message_id: "m1",
      content: JSON.stringify({
        text: "请帮我查找最近的接口设计，并整理相关知识",
      }),
    },
  });
  const dm = inbox.processMessage(event);
  assert.equal(dm.outcome, "ignored_not_allowed");
  const im = normalizeLarkEvent("cli_fixture", "im.message.receive_v1", {
    event_id: "img1",
    sender: { sender_id: { open_id: "ou_owner" }, sender_type: "user" },
    message: {
      chat_id: "oc_group",
      chat_type: "group",
      message_id: "m2",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_fixture" }),
    },
  });
  inbox.processMessage(im);
  const stored = JSON.parse(
    String(
      l.db
        .prepare(
          "SELECT envelope FROM input_events ORDER BY rowid DESC LIMIT 1",
        )
        .get()!.envelope,
    ),
  );
  assert.equal(stored.parts[0].type, "text");
  assert(stored.parts[0].text.includes("image_key"));
  results.push({
    id: "R8",
    ordinaryOwnerDM: dm.outcome,
    imageCapturePartType: stored.parts[0].type,
    note: "No SDK connection, pairing or outbound delivery was invoked.",
  });
  const secrets = new EncryptedSecretStore(
    join(resources.find((x) => x.s === l)!.dir, "secrets"),
    Buffer.alloc(32, 7),
  );
  const secretRef = secrets.put({
    appId: "cli_fixture",
    clientSecret: "fixture-only",
  });
  l.db
    .prepare("UPDATE lark_connection_versions SET secret_ref=? WHERE id='cv'")
    .run(secretRef);
  l.db
    .prepare(
      "INSERT INTO lark_targets(id,workspace_id,connection_id,binding_version,chat_id,target_type,purpose,capture_enabled,state,created_at,updated_at) VALUES('n','personal','c',1,'oc_owner','p2p','owner_notification',0,'active',?,?)",
    )
    .run(at, at);
  const annotation = new QualityLarkAnnotationService(l, secrets);
  const ld = annotation.repository.createDataset({
    name: "cancel-audit",
    split: "dev",
    sourceUri: "https://example.test/source",
    sourceRevisionId: "1",
    sourceDigest: "b".repeat(64),
    targetCount: 1,
  });
  annotation.repository.addSamples(ld.id, [draft]);
  const session = annotation.start(ld.id, "cli_fixture");
  annotation.cancel(session.id);
  let fakeSends = 0;
  const sender = new LarkDeliveryWorker(
    new LarkDeliveryRepository(l.db),
    secrets,
    {
      async send() {
        fakeSends++;
        return { messageId: "fixture-message" };
      },
      async update() {},
    },
    "audit-sender",
  );
  await sender.processOne();
  assert.equal(fakeSends, 1);
  results.push({
    id: "R10",
    cancelledAnnotationStillSentToFakeAdapter: fakeSends,
    realNetworkCalls: 0,
  });
  const ref = setup();
  const rm = new MemoryService(ref);
  const old = capture(ref, "原始有效规则。");
  const applied = rm.evaluate(
    proposal(old.revision, "原始有效规则。"),
    supported,
  );
  ref.capture(
    captureSchema.parse({
      source: "manual",
      externalId: ref.list()[0]!.externalId,
      title: "Updated",
      parts: [{ type: "text", text: "更新后的规则。" }],
      context: {},
    }),
  );
  ref.db
    .prepare("UPDATE jobs SET state='cancelled' WHERE kind='extract_claims'")
    .run();
  const pipe = new LearningPipeline({
    store: ref,
    memory: rm,
    feedback: new FeedbackService(ref),
    profile: profileSchema.parse({
      id: "traex",
      name: "unused",
      transport: "acp",
      command: "/does-not-exist",
    }),
    workspaceRoot: join(resources.at(-1)!.dir, "unused"),
  });
  await pipe.processOne();
  await pipe.stop();
  const refresh = ref.jobs.list().find((j) => j.kind === "refresh_dependents");
  const state = ref.db
    .prepare("SELECT status FROM memories WHERE id=?")
    .get(applied.receipt!.entityId)!.status;
  assert.equal(refresh?.state, "succeeded");
  assert.equal(state, "invalidated");
  results.push({
    id: "R9",
    refreshJobState: refresh?.state,
    memoryStateAfterRefresh: state,
  });
  console.log(
    JSON.stringify(
      {
        baseline: "16d3aa6",
        isolation: "Temporary SQLite; no external services or live data writes",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const { s, dir } of resources) {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
