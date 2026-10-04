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
import type { RetrievalConfig } from "../retrieval/factory.js";
import { KnowledgeRepository } from "../knowledge/repository.js";
import { prepareAgentResearch } from "../knowledge/agent-research.js";

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
      retrievalConfig?: RetrievalConfig;
      nativeResearch?: boolean;
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
    const refs = job.inputRefs as {
      sourceId?: string;
      previousRevisionId?: string;
      revisionId?: string;
    }[];
    const result = recordSourceRefresh(
      this.input.store.db,
      job.workspaceId,
      refs,
    );
    if (!result.affectedCount)
      return { resultRef: result.recordId, usage: { affected: 0 } };
    const ref = refs[0]!;
    const state = this.input.store.db
      .prepare(
        "SELECT validity_epoch FROM source_state WHERE source_id=? AND head_revision_id=?",
      )
      .get(ref.sourceId!, ref.revisionId!) as Row | undefined;
    if (!state) {
      reconcileSourceRefresh(this.input.store.db, ref.revisionId!, {
        reason: "source_advanced",
      });
      return {
        resultRef: result.recordId,
        usage: { superseded: result.affectedCount },
      };
    }
    // Same identity as capture's extraction job, so source updates never launch
    // a second independent extractor that could recreate the same memories.
    const queued = this.input.store.jobs.enqueue({
      workspaceId: job.workspaceId,
      kind: "extract_claims",
      inputRefs: [
        {
          revisionId: ref.revisionId,
          sourceId: ref.sourceId,
          validityEpoch: Number(state.validity_epoch),
        },
      ],
      roleVersion: "extractor@1",
      policyVersion: job.policyVersion,
      cause: "source_refresh",
    });
    this.input.store.db
      .prepare(
        "UPDATE refresh_records SET status='queued',result_json=? WHERE id=? AND status='needs_review'",
      )
      .run(JSON.stringify({ extractionJobId: queued.job.id }), result.recordId);
    return {
      resultRef: result.recordId,
      usage: { queued: result.affectedCount },
    };
  }

  private refreshMemories(job: JobLease) {
    const db = this.input.store.db;
    return this.sourceRefs(job).flatMap((ref) =>
      (
        db
          .prepare(
            `SELECT m.id,m.version,m.kind,m.scope,m.status,mr.body
      FROM memories m JOIN memory_revisions mr ON mr.id=m.head_revision_id
      JOIN memory_dependencies md ON md.memory_revision_id=mr.id
      WHERE md.source_id=? AND md.state='stale' AND m.status='invalidated'`,
          )
          .all(ref.sourceId) as Row[]
      ).map((m) => ({
        memory_id: String(m.id),
        version: Number(m.version),
        kind: String(m.kind),
        scope: JSON.parse(String(m.scope)),
        status: "invalidated",
        body: JSON.parse(String(m.body)),
      })),
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

  /** The immediate assistant/control path may already have applied this exact
   * original command. Keep it for learning, but do not execute its task intent
   * again merely because background extraction has a different proposal id. */
  private handledTaskActions(job: JobLease) {
    return this.sourceRefs(job).flatMap((ref) => {
      const revision = this.input.store.revision(ref.revisionId);
      const provenance = revision?.provenance;
      if (
        !provenance ||
        provenance.actorId !== (this.input.ownerId ?? "owner") ||
        provenance.actorType !== "owner" ||
        provenance.producerKind !== "original" ||
        provenance.forwarded ||
        provenance.quoted ||
        !(
          (provenance.collectorId === "assistant" &&
            provenance.actorVerifiedBy === "runtime") ||
          (provenance.collectorId === "task-controls" &&
            provenance.actorVerifiedBy === "local-user")
        )
      )
        return [];
      return (
        this.input.store.db
          .prepare(
            `SELECT DISTINCT f.id AS fragmentId,a.id AS receiptId,
        a.entity_id AS taskId,a.entity_version AS appliedVersion,t.version AS currentVersion,
        t.title,t.status,t.follow_up AS followUp
        FROM task_revisions tr JOIN json_each(tr.evidence_set) e
        JOIN fragments f ON f.id=e.value
        JOIN application_receipts a ON a.entity_type='task' AND a.entity_id=tr.task_id
          AND a.entity_version=tr.version AND a.workspace_id=tr.workspace_id
        JOIN tasks t ON t.id=tr.task_id AND t.workspace_id=tr.workspace_id
        WHERE f.revision_id=? AND tr.workspace_id=?`,
          )
          .all(ref.revisionId, job.workspaceId) as Row[]
      ).map((row) => ({
        fragmentId: String(row.fragmentId),
        receiptId: String(row.receiptId),
        taskId: String(row.taskId),
        appliedVersion: Number(row.appliedVersion),
        currentVersion: Number(row.currentVersion),
        title: String(row.title),
        status: String(row.status),
        followUp: row.followUp ? JSON.parse(String(row.followUp)) : null,
      }));
    });
  }

  private pendingTaskCandidate(
    proposal: Proposal,
    handled: ReturnType<LearningPipeline["handledTaskActions"]>,
  ) {
    if (proposal.kind !== "task" || !proposal.evidence.length) return true;
    const appliedFragments = new Set(
      handled.map((action) => action.fragmentId),
    );
    return !proposal.evidence.every((evidence) =>
      appliedFragments.has(evidence.fragment_revision_id),
    );
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
    // Only a single explicit project common to all input sources is a trusted
    // scope. Topics, names, file paths and conversation carriers are not projects.
    const projects = this.input.store.contexts.list().filter(p => p.kind === "project");
    const shared = projects.filter(p => revisions.every(({ revision }) =>
      this.input.store.contexts.forSource(revision.sourceId).includes(p.id)));
    const projectId = shared.length === 1 ? shared[0]!.id : null;
    const projectTrusted = projectId !== null;
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
        if (part?.type === "image" && !this.nativeResearch) {
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
      // Native sessions read complete inputs and images on demand. A first
      // fragment is an entry point, not the entire evidence or a token budget.
      materials: this.nativeResearch ? materials.slice(0, 1) : materials,
      related_memories: [
        ...this.relatedMemories(first.revision, scope),
        ...this.refreshMemories(job),
      ],
      task: {
        mode: "extract_and_refresh",
        nativeResearch: this.nativeResearch,
        input_sources: revisions.map(({ revision }) => ({ source_id: revision.sourceId, revision_id: revision.id, title: revision.title })),
        project: shared.length === 1 ? shared[0] : null,
        already_applied_task_actions: this.handledTaskActions(job),
        daily_message_policy:
          "For discussion/chat: preserve decisions, responsibilities, deadlines, per-speaker commitments and explicit outcomes as scoped facts. A named person's assignment is not a personal task even when reported by the verified owner. Only a verified owner's own commitment or explicit request to track an action can propose a task, with owner_id exactly trusted_context.owner_id. Keep other people's responsibilities and deadlines as claims; unresolved promises may also be attributed observations. Distinguish check-in time from deadline; no invented schedule or external outreach.",
        refreshTargets: this.refreshMemories(job),
        instruction:
          "Investigate what the NEW input sources change. Search existing memories and project originals before creating another memory. Use read_fragments to obtain exact immutable IDs, quotes and provenance; read_memory returns version and body for an update. For a partial change, read the earlier original and preserve unaffected conditions. Update the same memory_id with its current expected_versions and retain scope; this applies to later separate messages as well as source revisions. Do not extract every background document as new input. If scope or support remains ambiguous, abstain with the concrete missing information. Never treat derived bodies as evidence. already_applied_task_actions are host receipts for this exact original owner command: do not recreate or reapply its task, even if completed or cancelled.",
      },
      confirmed_corrections: this.input.feedback.recall(scope),
      ...(candidates ? { candidates } : {}),
    });
  }

  private retrieval(): RetrievalPort {
    return this.input.retrieval ?? new KeywordRetrieval(this.input.store.db);
  }

  private relatedMemories(
    revision: {
      title: string;
      fragments: { text: string }[];
      context: {
        application?: string;
        conversationId?: string;
        runId?: string;
      };
    },
    scope: { project_id: string | null },
  ) {
    const query =
      revision.title + " " + revision.fragments.map((f) => f.text).join(" ");
    const recalled = this.retrieval().searchMemories({
      text: query,
      scope: "workspace",
      project_id: scope.project_id,
      project_trusted: scope.project_id !== null,
      limit: 10,
    });
    return recalled.flatMap((memory) => {
      const row = this.input.store.db.prepare(`SELECT m.id,m.version,m.kind,m.status,m.scope,r.body,r.evidence_set
        FROM memories m JOIN memory_revisions r ON r.id=m.head_revision_id WHERE m.id=?`).get(memory.id);
      return row ? [{ memory_id: String(row.id), version: Number(row.version), kind: String(row.kind),
        status: String(row.status), scope: JSON.parse(String(row.scope)), body: JSON.parse(String(row.body)),
        evidence: JSON.parse(String(row.evidence_set)), derived: true, score: memory.score }] : [];
    });
  }

  private get nativeResearch() { return this.input.nativeResearch ?? this.input.profile.transport === "acp"; }

  private membershipStamp(job: JobLease) {
    return stableDigest(this.sourceRefs(job).map(ref => {
      const revision = this.input.store.revision(ref.revisionId);
      return { revision: ref.revisionId, groups: revision ? this.input.store.contexts.forSource(revision.sourceId) : [] };
    }));
  }

  private validateScope(batch: ProposalBatch, context: ContextManifest) {
    for (const item of [...batch.proposals, ...batch.observations]) {
      if (item.scope.workspace_id !== context.trusted_context.workspace_id ||
        item.scope.project_id !== context.trusted_context.project_id)
        throw Error("ROLE_OUTPUT_SCOPE: use the supplied formal project; do not infer it from names or conversation IDs");
    }
    for (const proposal of batch.proposals) {
      if (proposal.kind === "task" && proposal.body.owner_id !== context.trusted_context.owner_id)
        throw Error("ROLE_OUTPUT_TASK_OWNER: tasks belong to trusted_context.owner_id. Preserve another person's responsibility, deadline or commitment as a scoped claim, not a task. Do not change the owner ID to force acceptance; only an explicit personal tracking request or the owner's own commitment authorizes a personal task.");
      if (proposal.operation === "create") continue;
      const row = this.input.store.db.prepare("SELECT scope FROM memories WHERE id=?").get(proposal.target_id!);
      if (row && (JSON.parse(String(row.scope)).project_id ?? null) !== proposal.scope.project_id)
        throw Error("ROLE_OUTPUT_SCOPE: an update cannot move an existing memory to a different project");
    }
  }

  private async runRole(job: JobLease, context: ContextManifest, signal: AbortSignal, batch?: ProposalBatch) {
    const stamp = this.membershipStamp(job);
    const expected = job.inputRefs.find((r): r is { learningMembership: string } =>
      !!r && typeof r === "object" && typeof (r as { learningMembership?: unknown }).learningMembership === "string");
    if (expected && expected.learningMembership !== stamp) throw Error("STALE_JOB_INPUT: project membership changed");
    if (batch) this.validateScope(batch, context);
    const repository = new KnowledgeRepository(this.input.store);
    const run = await this.gateway.run({
      roleId: context.role_id, profile: this.input.profile, context, signal,
      ...(context.role_id === "extractor" ? { validateOutput: (output: unknown) => {
        const batch = proposalBatchSchema.parse(output); this.validateScope(batch, context); return batch;
      } } : {}),
      ...(this.nativeResearch ? { research: (workspace, schema, validate) => prepareAgentResearch({
        repository, materials: repository.materials(), articles: repository.published(), workspace, schema, validate,
        retrievalConfig: this.input.retrievalConfig,
      }) } satisfies Pick<Parameters<RoleRuntimeGateway["run"]>[0], "research"> : {}),
    });
    // Model investigation is asynchronous. Never reinterpret an old result using
    // membership edited during extraction or between extraction and review.
    if (stamp !== this.membershipStamp(job)) throw Error("STALE_JOB_INPUT: project membership changed");
    return { ...run, membershipStamp: stamp };
  }

  /**
   * Reconstruct the part→fragment mapping in the exact order store.capture splits
   * parts into fragments (paragraph text parts, then one fragment per link/image),
   * so a fragment ordinal resolves back to its source part and its per-part
   * provenance. This MUST mirror the flatMap in store.capture.
   */
  private fragmentPairs(
    revision: Revision,
  ): { part: StoredPart; text: string }[] {
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
      const run = await this.runRole(job, context, signal);
      const batch = proposalBatchSchema.parse(run.result);
      const output = this.saveRun(job, run);
      this.recordObservations(job, batch);
      const handled = this.handledTaskActions(job);
      const pending = batch.proposals.filter((proposal) =>
        this.pendingTaskCandidate(proposal, handled),
      );
      if (pending.length)
        this.input.store.jobs.enqueue({
          workspaceId: job.workspaceId,
          kind: "verify_proposals",
          inputRefs: [
            { roleOutputId: output.id, extractionJobId: job.id },
            { learningMembership: run.membershipStamp },
            ...job.inputRefs,
          ],
          roleVersion: "verifier@1",
          policyVersion: job.policyVersion,
          parentJobId: job.id,
          cause: "extraction",
        });
      if (!pending.length)
        for (const ref of this.sourceRefs(job))
          reconcileSourceRefresh(this.input.store.db, ref.revisionId, {
            extractionJobId: job.id,
            abstentions: batch.abstentions,
          });
      return {
        resultRef: output.id,
        usage: {
          ...run.trace.usage,
          alreadyHandledTaskActions: batch.proposals.length - pending.length,
        },
      };
    } catch (error) {
      for (const ref of this.sourceRefs(job))
        reconcileSourceRefresh(this.input.store.db, ref.revisionId, {
          extractionJobId: job.id,
          error: publicError(error),
        });
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
      const handled = this.handledTaskActions(job);
      const proposals = this.normalizeProposals(
        batch,
        reference.extractionJobId,
        bundleHash,
      ).filter((proposal) => this.pendingTaskCandidate(proposal, handled));
      const candidates = proposals.map((proposal) => ({
        ...proposal,
        proposal_digest: stableDigest(proposal),
      }));
      const context = this.context(job, "verifier", candidates);
      const run = await this.runRole(job, context, signal, { ...batch, proposals });
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
              update_relation: assessment.update_relation,
            },
          };
        }),
      );
      const evaluations = batchResult.results;
      for (const ref of this.sourceRefs(job))
        reconcileSourceRefresh(this.input.store.db, ref.revisionId, {
          verificationJobId: job.id,
          evaluations: evaluations.map((r) => ({
            policy: r.policy,
            reasons: r.reasons,
            receipt: r.receipt ?? null,
          })),
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
      for (const ref of this.sourceRefs(job))
        reconcileSourceRefresh(this.input.store.db, ref.revisionId, {
          verificationJobId: job.id,
          error: publicError(error),
        });
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
