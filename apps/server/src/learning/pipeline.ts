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
  type Revision,
  type StoredPart,
} from "../../../../packages/contracts/src/index.js";
import { RoleBundleRegistry } from "../agent-runtime/bundles.js";
import {
  RoleRuntimeGateway,
  type RoleRunTrace,
} from "../agent-runtime/gateway.js";
import { DurableJobWorker, JobExecutionError } from "../jobs/worker.js";
import type { JobLease } from "../jobs/repository.js";
import { FeedbackService, MemoryService } from "../memory/service.js";
import { recordSourceRefresh, reconcileSourceRefresh } from "./refresh.js";
import { stableDigest } from "../storage/digest.js";
import type { Store } from "../store.js";
import { KeywordRetrieval } from "../retrieval/keyword.js";
import type { RetrievalPort } from "../retrieval/port.js";

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
      retrieval?: RetrievalPort;
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
        refresh_dependents: async (job) => this.refreshDependents(job),
      },
      {
        kinds: ["extract_claims", "verify_proposals", "refresh_dependents"],
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

  private async refreshDependents(job: JobLease) {
    const refs = job.inputRefs as { sourceId?: string; previousRevisionId?: string; revisionId?: string }[];
    const result = recordSourceRefresh(this.input.store.db, job.workspaceId, refs);
    if (!result.affectedCount) return { resultRef: result.recordId, usage: { affected: 0 } };
    const ref = refs[0]!;
    const state = this.input.store.db.prepare("SELECT validity_epoch FROM source_state WHERE source_id=? AND head_revision_id=?").get(ref.sourceId!, ref.revisionId!) as Row | undefined;
    if (!state) {
      reconcileSourceRefresh(this.input.store.db, ref.revisionId!, { reason: "source_advanced" });
      return { resultRef: result.recordId, usage: { superseded: result.affectedCount } };
    }
    // Same identity as capture's extraction job, so source updates never launch
    // a second independent extractor that could recreate the same memories.
    const queued = this.input.store.jobs.enqueue({ workspaceId: job.workspaceId, kind: "extract_claims",
      inputRefs: [{ revisionId: ref.revisionId, sourceId: ref.sourceId, validityEpoch: Number(state.validity_epoch) }],
      roleVersion: "extractor@1", policyVersion: job.policyVersion, cause: "source_refresh" });
    this.input.store.db.prepare("UPDATE refresh_records SET status='queued',result_json=? WHERE id=? AND status='needs_review'")
      .run(JSON.stringify({ extractionJobId: queued.job.id }), result.recordId);
    return { resultRef: result.recordId, usage: { queued: result.affectedCount } };
  }

  private refreshMemories(job: JobLease) {
    const db = this.input.store.db;
    return this.sourceRefs(job).flatMap(ref => (db.prepare(`SELECT m.id,m.version,m.kind,m.scope,m.status,mr.body
      FROM memories m JOIN memory_revisions mr ON mr.id=m.head_revision_id
      JOIN memory_dependencies md ON md.memory_revision_id=mr.id
      WHERE md.source_id=? AND md.state='stale' AND m.status='invalidated'`).all(ref.sourceId) as Row[])
      .map(m => ({ memory_id: String(m.id), version: Number(m.version), kind: String(m.kind), scope: JSON.parse(String(m.scope)),
        status: "invalidated", body: JSON.parse(String(m.body)) })));
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
    // Context carriers (application/conversationId/runId) describe WHERE a capture
    // happened, NOT a trusted project. A real project link is a separate confirmed
    // ContextLink, which does not exist yet here. So project_id is unknown until
    // confirmed, and the model is told project_trusted=false rather than being fed a
    // conversationId as if it were a project.
    const projectId: string | null = null;
    const projectTrusted = false;
    const subjectId = first.revision.provenance?.actorId ?? null;
    const scope = {
      workspace_id: job.workspaceId,
      project_id: projectId,
      subject_id: subjectId,
    };
    const materials = revisions.flatMap(({ revision }) => {
      // Align each fixed fragment (by ordinal) back to the stored part it was split
      // from, so per-part provenance (actor/reply/observedAt/quoted/forwarded/
      // producerKind) reaches the model instead of being flattened away.
      const pairs = this.fragmentPairs(revision);
      return revision.fragments.map((fragment) => {
        const part = pairs[fragment.ordinal]?.part;
        const prov = part?.provenance;
        const material: Record<string, unknown> = {
          fragment_revision_id: fragment.id,
          source_revision_id: revision.id,
          text: fragment.text,
          actor_external_id: prov?.actorExternalId ?? null,
          actor_principal_id: prov?.actorPrincipalId ?? null,
          observed_at: prov?.observedAt ?? null,
          reply_to: prov?.replyTo ?? null,
          quoted: prov?.quoted ?? false,
          forwarded: prov?.forwarded ?? false,
          producer_kind: prov?.producerKind ?? "original",
        };
        if (part?.type === "image") {
          const bytes = this.input.store.asset(part.assetId);
          if (!bytes) throw Error("LEARNING_IMAGE_NOT_FOUND");
          material.image = {
            asset_hash: part.assetId,
            mime_type: part.mimeType,
            data_base64: bytes.toString("base64"),
            label: part.label,
          };
          material.asset_ref = part.assetId;
        }
        return material;
      });
    });
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
        project_trusted: projectTrusted,
      },
      materials,
      related_memories: [...this.relatedMemories(first.revision, scope), ...this.refreshMemories(job)],
      task: { mode: "extract_and_refresh",
        daily_message_policy: "For discussion/chat: preserve decisions, per-speaker commitments, open questions and explicit outcomes. Only explicit owner assignment or a verified owner's own commitment can propose an owner task. A waiting promise from someone else is background, not permission to create or complete a task. Distinguish check-in time from deadline; no invented schedule or external outreach.", refreshTargets: this.refreshMemories(job),
        instruction: "Recheck invalidated memories against ONLY current original materials. If still supported or changed, emit an update to the same memory_id with expected_versions[that id]=version, retaining its scope. Do not create a duplicate for an existing target. If no longer supported, abstain with a reason; it stays invalidated. You may create genuinely new memories. Never treat prior derived bodies as evidence." },
      confirmed_corrections: this.input.feedback.recall(scope),
      ...(candidates ? { candidates } : {}),
    });
  }

  private retrieval(): RetrievalPort {
    return this.input.retrieval ?? new KeywordRetrieval(this.input.store.db);
  }

  private relatedMemories(
    revision: { title: string; fragments: { text: string }[]; context: { application?: string; conversationId?: string; runId?: string } },
    scope: { project_id: string | null },
  ) {
    const query =
      revision.title + " " + revision.fragments.map((f) => f.text).join(" ");
    const recalled = this.retrieval().searchMemories({
      text: query,
      scope: "workspace",
      project_id: scope.project_id,
      project_trusted: false,
      limit: 10,
    });
    return recalled.map((memory) => ({
      memory_id: memory.id,
      kind: memory.kind,
      status: memory.status,
      score: memory.score,
      snippet: memory.snippet,
    }));
  }

  /**
   * Reconstruct the part→fragment mapping in the exact order store.capture splits
   * parts into fragments (paragraph text parts, then one fragment per link/image),
   * so a fragment ordinal resolves back to its source part and its per-part
   * provenance. This MUST mirror the flatMap in store.capture.
   */
  private fragmentPairs(revision: Revision): { part: StoredPart; text: string }[] {
    const pairs: { part: StoredPart; text: string }[] = [];
    for (const part of revision.parts) {
      if (part.type === "text") {
        for (const t of part.text.split(/\n\s*\n/).filter((x) => x.trim()))
          pairs.push({ part, text: t });
      } else if (part.type === "link") {
        pairs.push({ part, text: `${part.label}\n${part.url}` });
      } else {
        pairs.push({ part, text: `[图片] ${part.label}` });
      }
    }
    return pairs;
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
      if (!batch.proposals.length) for (const ref of this.sourceRefs(job))
        reconcileSourceRefresh(this.input.store.db, ref.revisionId, { extractionJobId: job.id, abstentions: batch.abstentions });
      return { resultRef: output.id, usage: run.trace.usage };
    } catch (error) {
      for (const ref of this.sourceRefs(job)) reconcileSourceRefresh(this.input.store.db, ref.revisionId,
        { extractionJobId: job.id, error: publicError(error) });
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
      // F: evaluate the WHOLE ChangeSet in one batch call, not N independent
      // per-proposal evaluate() calls. evaluateBatch de-duplicates the union impact
      // across all proposals before applying anything, so a batch cannot be smuggled
      // past the auto budget as N independent impact=0/1 operations; over-budget
      // proposals are parked and a single consolidated AttentionCase is raised.
      const batchResult = this.input.memory.evaluateBatch(
        proposals.map((proposal) => {
          const assessment = byProposal.get(proposal.proposal_id)!;
          return {
            proposal,
            assessment: {
              quote_asset_verdict: assessment.quote_asset_verdict,
              semantic_verdict: assessment.semantic_verdict,
              reviewer_version: run.trace.bundleHash,
              role_version: `${run.trace.roleId}@${run.trace.roleVersion}`,
              reason_code: assessment.reason_code,
              details: assessment.reason,
            },
          };
        }),
      );
      const evaluations = batchResult.results;
      for (const ref of this.sourceRefs(job)) reconcileSourceRefresh(this.input.store.db, ref.revisionId,
        { verificationJobId: job.id, evaluations: evaluations.map(r => ({ policy: r.policy, reasons: r.reasons, receipt: r.receipt ?? null })) });
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
      for (const ref of this.sourceRefs(job)) reconcileSourceRefresh(this.input.store.db, ref.revisionId,
        { verificationJobId: job.id, error: publicError(error) });
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
