import { randomUUID } from "node:crypto";
import {
  assessmentBatchSchema,
  contextManifestSchema,
  proposalBatchSchema,
  proposalSchema,
  type AgentProfile,
  type ContextManifest,
  type Proposal,
  type ProposalBatch,
} from "../../../../packages/contracts/src/index.js";
import { RoleBundleRegistry } from "../agent-runtime/bundles.js";
import {
  RoleRuntimeGateway,
  type RoleRunTrace,
} from "../agent-runtime/gateway.js";
import { DurableJobWorker, JobExecutionError } from "../jobs/worker.js";
import type { JobLease } from "../jobs/repository.js";
import { FeedbackService, MemoryService } from "../memory/service.js";
import { stableDigest } from "../storage/digest.js";
import type { Store } from "../store.js";

type Row = Record<string, unknown>;

const publicError = (error: unknown) =>
  (error instanceof Error ? error.message : "Learning pipeline failed")
    .replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(
      /\b(authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1000);

const classify = (error: unknown) => {
  if (error instanceof JobExecutionError) return error;
  const message = publicError(error);
  const kind = /ROLE_OUTPUT_|LEARNING_ASSESSMENT_|ZodError|invalid.*json/i.test(
    message,
  )
    ? "bad_output"
    : /auth|unauthorized|forbidden|login|credential/i.test(message)
      ? "auth"
      : /timeout|timed out|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|429/i.test(
            message,
          )
        ? "transient"
        : /PROFILE|UNSUPPORTED|CONFIG|IMAGE_|CONTEXT_BUDGET/i.test(message)
          ? "config"
          : "permanent";
  return new JobExecutionError(message, kind);
};

export type LearningPipelineStatus = {
  running: boolean;
  processed: number;
  lastError: string | null;
};

export class LearningPipeline {
  private readonly gateway: RoleRuntimeGateway;
  private readonly worker: DurableJobWorker;
  private readonly controller = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private processed = 0;
  private lastError: string | null = null;

  constructor(
    private readonly input: {
      store: Store;
      memory: MemoryService;
      feedback: FeedbackService;
      profile: AgentProfile;
      workspaceRoot: string;
      pollMs?: number;
      ownerId?: string;
      workerId?: string;
    },
  ) {
    const registry = new RoleBundleRegistry();
    for (const role of ["extractor", "verifier"] as const) {
      const bundle = registry.load(role);
      if (bundle.manifest.profile_ref !== input.profile.id)
        throw Error(
          `LEARNING_PROFILE_MISMATCH: ${role} requires ${bundle.manifest.profile_ref}`,
        );
    }
    this.gateway = new RoleRuntimeGateway(
      registry,
      input.workspaceRoot,
      input.store.runtimeRequests,
    );
    const fingerprintSeed = {
      pipeline: "learning-pipeline@1",
      profileId: input.profile.id,
      model: input.profile.model ?? null,
      effort: input.profile.effort ?? null,
    };
    this.worker = new DurableJobWorker(
      input.store.jobs,
      input.workerId ?? `learning-${process.pid}-${randomUUID()}`,
      {
        extract_claims: (job, signal) => this.extract(job, signal),
        verify_proposals: (job, signal) => this.verify(job, signal),
        refresh_dependents: async (job) => ({
          resultRef:
            (job.inputRefs[0] as { revisionId?: string } | undefined)
              ?.revisionId ?? null,
        }),
      },
      {
        fingerprint: () => ({
          model: input.profile.model ?? null,
          effort: input.profile.effort ?? null,
          promptHash: stableDigest({ ...fingerprintSeed, stage: "prompt" }),
          skillHash: stableDigest({ ...fingerprintSeed, stage: "skills" }),
          toolHash: stableDigest({ ...fingerprintSeed, stage: "tools" }),
        }),
      },
    );
  }

  private sourceRefs(job: JobLease) {
    return job.inputRefs.flatMap((reference) => {
      if (!reference || typeof reference !== "object") return [];
      const value = reference as {
        revisionId?: unknown;
        sourceId?: unknown;
        validityEpoch?: unknown;
      };
      return typeof value.revisionId === "string"
        ? [
            {
              revisionId: value.revisionId,
              sourceId:
                typeof value.sourceId === "string" ? value.sourceId : null,
              validityEpoch:
                typeof value.validityEpoch === "number"
                  ? value.validityEpoch
                  : null,
            },
          ]
        : [];
    });
  }

  private context(
    job: JobLease,
    roleId: ContextManifest["role_id"],
    candidates?: Record<string, unknown>[],
  ) {
    const refs = this.sourceRefs(job);
    if (!refs.length) throw Error("LEARNING_INPUT_REVISION_MISSING");
    const revisions = refs.map((reference) => {
      const revision = this.input.store.revision(reference.revisionId);
      if (!revision) throw Error("LEARNING_INPUT_REVISION_NOT_FOUND");
      const state = this.input.store.db
        .prepare(
          `SELECT s.head,ss.validity_epoch FROM sources s
           JOIN source_state ss ON ss.source_id=s.id WHERE s.id=?`,
        )
        .get(revision.sourceId) as Row | undefined;
      if (
        !state ||
        state.head !== revision.id ||
        (reference.sourceId && reference.sourceId !== revision.sourceId) ||
        (reference.validityEpoch !== null &&
          reference.validityEpoch !== Number(state.validity_epoch))
      )
        throw Error("STALE_JOB_INPUT");
      return { revision, epoch: Number(state.validity_epoch) };
    });
    const first = revisions[0]!;
    const projectId =
      first.revision.context.conversationId ??
      first.revision.context.runId ??
      first.revision.context.application ??
      null;
    const subjectId = first.revision.provenance?.actorId ?? null;
    const scope = {
      workspace_id: job.workspaceId,
      project_id: projectId,
      subject_id: subjectId,
    };
    const materials = revisions.flatMap(({ revision }) =>
      revision.fragments.map((fragment) => {
        const image = revision.parts.find(
          (part) =>
            part.type === "image" && fragment.text === `[图片] ${part.label}`,
        );
        if (image?.type === "image") {
          const bytes = this.input.store.asset(image.assetId);
          if (!bytes) throw Error("LEARNING_IMAGE_NOT_FOUND");
          return {
            fragment_revision_id: fragment.id,
            source_revision_id: revision.id,
            text: fragment.text,
            image: {
              asset_hash: image.assetId,
              mime_type: image.mimeType,
              data_base64: bytes.toString("base64"),
              label: image.label,
            },
          };
        }
        return {
          fragment_revision_id: fragment.id,
          source_revision_id: revision.id,
          text: fragment.text,
        };
      }),
    );
    return contextManifestSchema.parse({
      schema_version: 1,
      job_id: job.id,
      role_id: roleId,
      trusted_context: {
        workspace_id: job.workspaceId,
        project_id: projectId,
        owner_id: this.input.ownerId ?? "owner",
        observed_at:
          first.revision.provenance?.eventAt ?? first.revision.createdAt,
        timezone: first.revision.provenance?.timezone ?? "UTC",
        actor_binding: {
          id: first.revision.provenance?.actorId ?? null,
          verified_by: first.revision.provenance?.actorVerifiedBy ?? null,
        },
        source_kind: first.revision.source,
        is_forwarded: first.revision.provenance?.forwarded ?? false,
        producer_kind: first.revision.provenance?.producerKind ?? "original",
        source_epoch: first.epoch,
      },
      materials,
      related_memories: [],
      confirmed_corrections: this.input.feedback.recall(scope),
      ...(candidates ? { candidates } : {}),
    });
  }

  private saveRun(
    job: JobLease,
    run: {
      result: unknown;
      trace: RoleRunTrace;
    },
  ) {
    const sessionId = run.trace.sessionIds.at(-1);
    if (!sessionId) throw Error("ROLE_SESSION_ID_MISSING");
    return this.input.store.jobs.saveRoleOutput({
      jobId: job.id,
      leaseToken: job.leaseToken,
      model: run.trace.effectiveModel,
      effort: run.trace.effectiveEffort,
      promptHash: run.trace.promptHash,
      skillHash: run.trace.skillHash,
      toolHash: run.trace.toolHash,
      fingerprint: run.trace.fingerprint,
      roleBundleHash: run.trace.bundleHash,
      contextHash: run.trace.contextHash,
      outputSchema: run.trace.outputSchema,
      sessionId,
      loadedSkills: run.trace.loadedSkills,
      allowedTools: run.trace.allowedTools,
      usage: run.trace.usage,
      output: run.result,
      trace: run.trace,
    });
  }

  private recordObservations(job: JobLease, batch: ProposalBatch) {
    const createdAt = new Date().toISOString();
    batch.observations.forEach((observation, index) => {
      const observationId = `observation-${stableDigest({
        jobId: job.id,
        index,
        observation,
      }).slice(0, 40)}`;
      this.input.store.db
        .prepare(
          `INSERT OR IGNORE INTO observations(
             id,workspace_id,job_id,actor,observed_at,intent,scope,outcome,
             evidence,derived_from,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          observationId,
          job.workspaceId,
          job.id,
          JSON.stringify({ actorId: observation.actor_id }),
          observation.observed_at,
          observation.intent,
          JSON.stringify(observation.scope),
          observation.outcome,
          JSON.stringify(observation.evidence),
          observation.derived_from,
          createdAt,
        );
    });
  }

  private normalizeProposals(
    batch: ProposalBatch,
    extractionJobId: string,
    bundleHash: string,
  ) {
    return batch.proposals.map((candidate, index) => {
      const {
        proposal_id: _proposalId,
        origin: _origin,
        ...content
      } = candidate;
      const normalized = proposalSchema.parse({
        ...content,
        proposal_id: `proposal-${stableDigest({
          extractionJobId,
          index,
          content,
        }).slice(0, 40)}`,
        origin: {
          job_id: extractionJobId,
          role_bundle: bundleHash,
          producer_kind: "derived",
        },
      });
      return this.input.feedback.applyConfirmedCorrections(normalized).proposal;
    });
  }

  private async extract(job: JobLease, signal: AbortSignal) {
    try {
      if (job.roleVersion !== "extractor@1")
        throw Error(`LEARNING_ROLE_VERSION_UNSUPPORTED: ${job.roleVersion}`);
      const context = this.context(job, "extractor");
      const run = await this.gateway.run({
        roleId: "extractor",
        profile: this.input.profile,
        context,
        signal,
      });
      const batch = proposalBatchSchema.parse(run.result);
      const output = this.saveRun(job, run);
      this.recordObservations(job, batch);
      if (batch.proposals.length)
        this.input.store.jobs.enqueue({
          workspaceId: job.workspaceId,
          kind: "verify_proposals",
          inputRefs: [
            { roleOutputId: output.id, extractionJobId: job.id },
            ...job.inputRefs,
          ],
          roleVersion: "verifier@1",
          policyVersion: job.policyVersion,
          parentJobId: job.id,
          cause: "extraction",
        });
      return { resultRef: output.id, usage: run.trace.usage };
    } catch (error) {
      throw classify(error);
    }
  }

  private async verify(job: JobLease, signal: AbortSignal) {
    try {
      if (job.roleVersion !== "verifier@1")
        throw Error(`LEARNING_ROLE_VERSION_UNSUPPORTED: ${job.roleVersion}`);
      const reference = job.inputRefs.find(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as { roleOutputId?: unknown }).roleOutputId ===
            "string",
      ) as { roleOutputId: string; extractionJobId: string } | undefined;
      if (
        !reference ||
        typeof reference.extractionJobId !== "string" ||
        job.parentJobId !== reference.extractionJobId
      )
        throw Error("LEARNING_EXTRACTION_OUTPUT_MISSING");
      const stored = this.input.store.jobs.roleOutput(reference.roleOutputId);
      if (
        !stored ||
        stored.jobId !== reference.extractionJobId ||
        stored.outputSchema !== "ProposalBatch.v1" ||
        stableDigest(stored.output) !== stored.outputDigest
      )
        throw Error("LEARNING_EXTRACTION_OUTPUT_INVALID");
      const batch = proposalBatchSchema.parse(stored.output);
      if (batch.job_id !== reference.extractionJobId)
        throw Error("LEARNING_EXTRACTION_JOB_MISMATCH");
      const bundleHash = String(stored.trace.bundleHash || "");
      if (!/^[a-f0-9]{64}$/.test(bundleHash))
        throw Error("LEARNING_EXTRACTION_TRACE_INVALID");
      const proposals = this.normalizeProposals(
        batch,
        reference.extractionJobId,
        bundleHash,
      );
      const candidates = proposals.map((proposal) => ({
        ...proposal,
        proposal_digest: stableDigest(proposal),
      }));
      const context = this.context(job, "verifier", candidates);
      const run = await this.gateway.run({
        roleId: "verifier",
        profile: this.input.profile,
        context,
        signal,
      });
      const assessments = assessmentBatchSchema.parse(run.result);
      const byProposal = new Map(
        assessments.assessments.map((assessment) => [
          assessment.proposal_id,
          assessment,
        ]),
      );
      if (
        byProposal.size !== proposals.length ||
        assessments.assessments.length !== proposals.length
      )
        throw Error("LEARNING_ASSESSMENT_COVERAGE_MISMATCH");
      for (const proposal of proposals) {
        const assessment = byProposal.get(proposal.proposal_id);
        if (
          !assessment ||
          assessment.proposal_digest !== stableDigest(proposal)
        )
          throw Error("LEARNING_ASSESSMENT_DIGEST_MISMATCH");
      }
      const output = this.saveRun(job, run);
      const evaluations = proposals.map((proposal) => {
        const assessment = byProposal.get(proposal.proposal_id)!;
        return this.input.memory.evaluate(proposal, {
          quote_asset_verdict: assessment.quote_asset_verdict,
          semantic_verdict: assessment.semantic_verdict,
          reviewer_version: run.trace.bundleHash,
          role_version: `${run.trace.roleId}@${run.trace.roleVersion}`,
          reason_code: assessment.reason_code,
          details: assessment.reason,
        });
      });
      return {
        resultRef: output.id,
        usage: {
          ...run.trace.usage,
          evaluated: evaluations.length,
          autoApplied: evaluations.filter(
            (result) => result.policy === "auto_apply",
          ).length,
          awaitingDecision: evaluations.filter(
            (result) => result.policy === "awaiting_decision",
          ).length,
          rejected: evaluations.filter((result) => result.policy === "reject")
            .length,
        },
      };
    } catch (error) {
      throw classify(error);
    }
  }

  async processOne() {
    const result = await this.worker.processOne();
    if (result.processed) this.processed++;
    return result;
  }

  async drain(maxJobs = 100) {
    let count = 0;
    while (count < maxJobs) {
      const result = await this.processOne();
      if (!result.processed) return count;
      count++;
    }
    throw Error("LEARNING_DRAIN_LIMIT_REACHED");
  }

  start() {
    if (this.loopPromise) return;
    this.loopPromise = this.loop();
  }

  private async loop() {
    while (!this.controller.signal.aborted) {
      try {
        const result = await this.processOne();
        this.lastError = null;
        if (result.processed) continue;
      } catch (error) {
        this.lastError = publicError(error);
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.controller.signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, this.input.pollMs ?? 1000);
        timer.unref();
        this.controller.signal.addEventListener("abort", finish, {
          once: true,
        });
      });
    }
  }

  cancel(input: {
    jobId: string;
    expectedGeneration: number;
    requestId: string;
    workspaceId?: string;
  }) {
    return this.worker.cancel(input);
  }

  status(): LearningPipelineStatus {
    return {
      running: Boolean(this.loopPromise) && !this.controller.signal.aborted,
      processed: this.processed,
      lastError: this.lastError,
    };
  }

  async stop() {
    this.controller.abort();
    this.worker.stop();
    await this.loopPromise;
  }
}
