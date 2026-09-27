import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../apps/server/src/config.js";
import { RoleBundleRegistry } from "../apps/server/src/agent-runtime/bundles.js";
import { RoleRuntimeGateway } from "../apps/server/src/agent-runtime/gateway.js";
import { MemoryService } from "../apps/server/src/memory/service.js";
import { stableDigest } from "../apps/server/src/storage/digest.js";
import { Store } from "../apps/server/src/store.js";
import { contextManifestSchema } from "../packages/contracts/src/index.js";
import { assertNonAstra, selectNonAstraProfile } from "./live-model.js";

const config = loadConfig();
const base = config.profiles.find((profile) => profile.id === "traex");
if (!base) throw Error("TraeX profile is not configured");
const { profile } = await selectNonAstraProfile(base, config.agentCwd);
const directory = mkdtempSync(join(tmpdir(), "omem-live-learning-"));
const store = new Store(directory);
try {
  const text = "我负责在本周五18:00前补齐支付重试方案，先核对现有接口。";
  const captured = store.capture({
    source: "manual",
    externalId: "live-learning-source",
    title: "支付重试任务",
    observedAt: "2026-09-22T08:00:00Z",
    parts: [{ type: "text", text }],
    context: {},
    provenance: {
      collectorId: "live-learning-smoke",
      actorId: "owner",
      actorType: "owner",
      actorVerifiedBy: "local-live-test",
      sourceUri: null,
      eventId: "live-learning-event-1",
      eventAt: "2026-09-22T08:00:00Z",
      timezone: "Asia/Shanghai",
      quoted: false,
      forwarded: false,
      producerKind: "original",
    },
  });
  const fragment = captured.revision.fragments[0]!;
  const context = contextManifestSchema.parse({
    schema_version: 1,
    job_id: captured.job!.id,
    role_id: "extractor",
    trusted_context: {
      workspace_id: "personal",
      project_id: "payments",
      owner_id: "owner",
      observed_at: "2026-09-22T08:00:00Z",
      timezone: "Asia/Shanghai",
      actor_binding: { id: "owner", verified_by: "local-live-test" },
      source_kind: "manual",
      is_forwarded: false,
      producer_kind: "original",
      source_epoch: 1,
    },
    materials: [
      {
        fragment_revision_id: fragment.id,
        source_revision_id: captured.revision.id,
        text: fragment.text,
      },
    ],
    related_memories: [],
    confirmed_corrections: [],
  });
  const gateway = new RoleRuntimeGateway(
    new RoleBundleRegistry(),
    config.agentCwd,
  );
  const extraction = await gateway.run({
    roleId: "extractor",
    profile,
    context,
  });
  assertNonAstra(extraction.trace.effectiveModel);
  const proposals = (
    extraction.result as { proposals: Record<string, unknown>[] }
  ).proposals;
  if (proposals.length !== 1) throw Error("Expected one live proposal");
  const proposal = proposals[0]!;
  const proposalDigest = stableDigest(proposal);
  const verification = await gateway.run({
    roleId: "verifier",
    profile,
    context: contextManifestSchema.parse({
      ...context,
      job_id: `${captured.job!.id}-verify`,
      role_id: "verifier",
      candidates: [{ ...proposal, proposal_digest: proposalDigest }],
    }),
  });
  assertNonAstra(verification.trace.effectiveModel);
  const assessment = (
    verification.result as {
      assessments: {
        semantic_verdict: string;
        reason_code: string;
        reason: string;
      }[];
    }
  ).assessments[0];
  if (!assessment) throw Error("Verifier returned no assessment");
  const memory = new MemoryService(store, { ownerId: "owner" });
  const evaluation = memory.evaluate(proposal, {
    semantic_verdict: assessment.semantic_verdict,
    reviewer_version: verification.trace.bundleHash,
    role_version: `${verification.trace.roleId}@${verification.trace.roleVersion}`,
    reason_code: assessment.reason_code,
    details: assessment.reason,
  });
  if (evaluation.policy !== "auto_apply" || !evaluation.receipt)
    throw Error(`Live proposal was not safely applied: ${evaluation.policy}`);
  const report = {
    createdAt: new Date().toISOString(),
    extraction: { result: extraction.result, trace: extraction.trace },
    verification: { result: verification.result, trace: verification.trace },
    evaluation,
    tasks: store.tasks(),
  };
  const reportPath = resolve(
    process.env.OMEM_LIVE_LEARNING_REPORT ||
      ".omem/verification/live-learning-smoke.json",
  );
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        reportPath,
        model: extraction.trace.effectiveModel,
        effort: extraction.trace.effectiveEffort,
        proposalCount: proposals.length,
        semanticVerdict: assessment.semantic_verdict,
        policy: evaluation.policy,
        taskCount: store.tasks().length,
        receiptId: evaluation.receipt.id,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
