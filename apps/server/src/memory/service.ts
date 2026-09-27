import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  decisionActionSchema,
  feedbackInputSchema,
  proposalAssessmentInputSchema,
  proposalSchema,
  type Proposal,
} from "../../../../packages/contracts/src/index.js";
import type { Store } from "../store.js";
import { stableDigest } from "../storage/digest.js";

type Row = Record<string, unknown>;
type AssessmentInput = ReturnType<typeof proposalAssessmentInputSchema.parse>;

export type EvaluationResult = {
  proposalId: string;
  proposalDigest: string;
  evidenceVerdict: "valid" | "invalid" | "ambiguous";
  policy: "auto_apply" | "awaiting_decision" | "reject";
  reasons: string[];
  receipt?: ReturnType<Store["applications"]["applyTask"]>;
  decisionId?: string;
};

const now = () => new Date().toISOString();

const occurrences = (text: string, quote: string) => {
  const haystack = Array.from(text);
  const needle = Array.from(quote);
  const found: number[] = [];
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (needle.every((value, offset) => haystack[index + offset] === value))
      found.push(index);
  }
  return found;
};

export class MemoryService {
  constructor(
    private readonly store: Store,
    private readonly options: {
      policyVersion?: string;
      maxAutoApply?: number;
      ownerId?: string;
    } = {},
  ) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  private transaction<T>(work: () => T): T {
    return this.store.tx(work);
  }

  private proposalRow(proposalId: string) {
    return this.db
      .prepare("SELECT * FROM proposals WHERE id=?")
      .get(proposalId) as Row | undefined;
  }

  private proposalView(row: Row) {
    const assessments = this.db
      .prepare(
        `SELECT quote_asset_verdict AS quoteAssetVerdict,
           semantic_verdict AS semanticVerdict,
           reviewer_version AS reviewerVersion,role_version AS roleVersion,
           reason_code AS reasonCode,details,created_at AS createdAt
         FROM evidence_assessments WHERE workspace_id=? AND proposal_digest=?
         ORDER BY created_at DESC`,
      )
      .all(String(row.workspace_id), String(row.digest)) as Row[];
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      schemaVersion: Number(row.schema_version),
      kind: String(row.kind),
      operation: String(row.operation),
      targetId: row.target_id ? String(row.target_id) : null,
      expectedVersions: JSON.parse(String(row.expected_versions)),
      body: JSON.parse(String(row.body)),
      scope: JSON.parse(String(row.scope)),
      evidence: JSON.parse(String(row.evidence)),
      uncertainties: JSON.parse(String(row.uncertainties)),
      reason: String(row.reason),
      origin: JSON.parse(String(row.origin)),
      digest: String(row.digest),
      state: String(row.state),
      policyResult: row.policy_result
        ? JSON.parse(String(row.policy_result))
        : null,
      impactCount: Number(row.impact_count),
      assessments,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private persistProposal(proposal: Proposal, impactCount: number) {
    const digest = stableDigest(proposal);
    return this.transaction(() => {
      const byId = this.proposalRow(proposal.proposal_id);
      if (byId && byId.digest !== digest) throw Error("PROPOSAL_ID_CONFLICT");
      const byDigest = this.db
        .prepare("SELECT * FROM proposals WHERE workspace_id=? AND digest=?")
        .get(proposal.scope.workspace_id, digest) as Row | undefined;
      if (byDigest) return { id: String(byDigest.id), digest, duplicate: true };
      const at = now();
      this.db
        .prepare(
          `INSERT INTO proposals(
             id,workspace_id,schema_version,kind,operation,target_id,
             expected_versions,body,scope,evidence,uncertainties,reason,origin,
             digest,state,created_at,updated_at,policy_result,impact_count
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'proposed',?,?,NULL,?)`,
        )
        .run(
          proposal.proposal_id,
          proposal.scope.workspace_id,
          proposal.schema_version,
          proposal.kind,
          proposal.operation,
          proposal.target_id ?? null,
          JSON.stringify(proposal.expected_versions),
          JSON.stringify(proposal.body),
          JSON.stringify(proposal.scope),
          JSON.stringify(proposal.evidence),
          JSON.stringify(proposal.uncertainties),
          proposal.reason,
          JSON.stringify(proposal.origin),
          digest,
          at,
          at,
          impactCount,
        );
      for (const evidence of proposal.evidence) {
        const evidenceRecord = this.store.evidence(
          evidence.fragment_revision_id,
        );
        if (
          !evidenceRecord ||
          evidenceRecord.revision.id !== evidence.source_revision_id
        )
          continue;
        const state = this.db
          .prepare("SELECT validity_epoch FROM source_state WHERE source_id=?")
          .get(evidenceRecord.revision.sourceId) as Row | undefined;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO proposal_source_reads(
               proposal_id,source_id,source_revision_id,validity_epoch
             ) VALUES(?,?,?,?)`,
          )
          .run(
            proposal.proposal_id,
            evidenceRecord.revision.sourceId,
            evidence.source_revision_id,
            Number(state?.validity_epoch ?? 1),
          );
      }
      return { id: proposal.proposal_id, digest, duplicate: false };
    });
  }

  validateEvidence(proposal: Proposal) {
    let ambiguous = false;
    const errors: string[] = [];
    for (const evidence of proposal.evidence) {
      const record = this.store.evidence(evidence.fragment_revision_id);
      if (!record) {
        errors.push(`missing fragment ${evidence.fragment_revision_id}`);
        continue;
      }
      if (record.revision.id !== evidence.source_revision_id) {
        errors.push(
          `source revision mismatch for ${evidence.fragment_revision_id}`,
        );
        continue;
      }
      if ("exact_quote" in evidence) {
        const points = Array.from(record.fragment.text);
        const selected = points
          .slice(evidence.selector.start, evidence.selector.end)
          .join("");
        if (selected !== evidence.exact_quote) {
          errors.push(
            `quote selector mismatch for ${evidence.fragment_revision_id}`,
          );
          continue;
        }
        const locations = occurrences(
          record.fragment.text,
          evidence.exact_quote,
        );
        if (!locations.includes(evidence.selector.start))
          errors.push(`quote not found for ${evidence.fragment_revision_id}`);
        if (
          locations.length > 1 &&
          evidence.selector.end <= evidence.selector.start
        )
          ambiguous = true;
      } else {
        const image = record.revision.parts.find(
          (part) =>
            part.type === "image" && part.assetId === evidence.asset_hash,
        );
        if (!image || !this.store.asset(evidence.asset_hash))
          errors.push(
            `image asset mismatch for ${evidence.fragment_revision_id}`,
          );
      }
    }
    return {
      verdict: errors.length ? "invalid" : ambiguous ? "ambiguous" : "valid",
      errors,
    } as const;
  }

  private sourceReads(proposalId: string) {
    return this.db
      .prepare(
        `SELECT r.*,s.head AS current_head,ss.validity_epoch AS current_epoch
         FROM proposal_source_reads r
         JOIN sources s ON s.id=r.source_id
         JOIN source_state ss ON ss.source_id=r.source_id
         WHERE r.proposal_id=?`,
      )
      .all(proposalId) as Row[];
  }

  private assertCurrentReads(proposalId: string) {
    for (const read of this.sourceReads(proposalId))
      if (
        read.current_head !== read.source_revision_id ||
        Number(read.current_epoch) !== Number(read.validity_epoch)
      )
        throw Error("STALE_DECISION");
  }

  private evidenceDependencies(proposalId: string) {
    return this.sourceReads(proposalId).map((read) => ({
      sourceId: String(read.source_id),
      sourceRevisionId: String(read.source_revision_id),
      validityEpoch: Number(read.validity_epoch),
    }));
  }

  private actorIsVerifiedOwner(proposal: Proposal) {
    const ownerId = this.options.ownerId ?? "owner";
    if (proposal.kind !== "task") return true;
    if (proposal.body.owner_id !== ownerId) return false;
    return proposal.evidence.every((evidence) => {
      const revision = this.store.revision(evidence.source_revision_id);
      return Boolean(
        revision?.provenance?.actorId === ownerId &&
          revision.provenance.actorVerifiedBy &&
          !revision.provenance.forwarded,
      );
    });
  }

  private hasCrossSourceUpdate(proposal: Proposal) {
    if (
      proposal.operation === "create" ||
      !proposal.target_id ||
      proposal.kind === "task"
    )
      return false;
    const target = this.db
      .prepare("SELECT head_revision_id FROM memories WHERE id=?")
      .get(proposal.target_id) as Row | undefined;
    if (!target) return false;
    const priorSources = new Set(
      (
        this.db
          .prepare(
            "SELECT source_id FROM memory_dependencies WHERE memory_revision_id=?",
          )
          .all(String(target.head_revision_id)) as Row[]
      ).map((row) => String(row.source_id)),
    );
    const nextSources = new Set(
      this.sourceReads(proposal.proposal_id).map((row) =>
        String(row.source_id),
      ),
    );
    return [...nextSources].some((source) => !priorSources.has(source));
  }

  private policy(
    proposal: Proposal,
    assessment: AssessmentInput,
    evidenceVerdict: "valid" | "invalid" | "ambiguous",
    impactCount: number,
  ) {
    const reasons: string[] = [];
    if (evidenceVerdict !== "valid") reasons.push("evidence_not_valid");
    if (assessment.semantic_verdict !== "supported")
      reasons.push(`semantic_${assessment.semantic_verdict}`);
    if (proposal.uncertainties.length) reasons.push("uncertainties_present");
    if (impactCount > (this.options.maxAutoApply ?? 10))
      reasons.push("impact_limit_exceeded");
    if (proposal.kind === "procedure")
      reasons.push("procedure_requires_review");
    if (proposal.evidence.some((evidence) => "asset_hash" in evidence))
      reasons.push("inferred_image_requires_review");
    if (
      proposal.kind === "episode" &&
      proposal.body.outcome === "success" &&
      proposal.body.verification_refs.length === 0
    )
      reasons.push("unverified_success");
    if (!this.actorIsVerifiedOwner(proposal))
      reasons.push("owner_not_verified");
    if (
      proposal.kind === "task" &&
      proposal.body.due_expression &&
      !proposal.body.due_at
    )
      reasons.push("due_time_ambiguous");
    if (this.hasCrossSourceUpdate(proposal))
      reasons.push("cross_source_conflict");
    const reject =
      evidenceVerdict === "invalid" ||
      assessment.semantic_verdict === "contradicted";
    return {
      outcome: reject
        ? ("reject" as const)
        : reasons.length
          ? ("awaiting_decision" as const)
          : ("auto_apply" as const),
      reasons,
    };
  }

  private persistAssessment(
    proposal: Proposal,
    proposalDigest: string,
    assessment: AssessmentInput,
    evidenceVerdict: "valid" | "invalid" | "ambiguous",
    deterministicErrors: string[],
  ) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO evidence_assessments(
           id,workspace_id,proposal_digest,quote_asset_verdict,semantic_verdict,
           reviewer_version,role_version,reason_code,details,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        proposal.scope.workspace_id,
        proposalDigest,
        evidenceVerdict,
        assessment.semantic_verdict,
        assessment.reviewer_version,
        assessment.role_version,
        assessment.reason_code,
        JSON.stringify({
          semantic: assessment.details,
          deterministicErrors,
        }),
        now(),
      );
  }

  private persistPolicy(
    proposal: Proposal,
    proposalDigest: string,
    outcome: EvaluationResult["policy"],
    reasons: string[],
    impactCount: number,
  ) {
    const policyVersion = this.options.policyVersion ?? "memory-policy@1";
    this.db
      .prepare(
        `INSERT OR REPLACE INTO policy_evaluations(
           id,workspace_id,proposal_digest,policy_version,outcome,reasons,
           impact_count,created_at
         ) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        proposal.scope.workspace_id,
        proposalDigest,
        policyVersion,
        outcome,
        JSON.stringify(reasons),
        impactCount,
        now(),
      );
    this.db
      .prepare(
        "UPDATE proposals SET state=?,policy_result=?,updated_at=? WHERE id=?",
      )
      .run(
        outcome === "reject"
          ? "rejected"
          : outcome === "awaiting_decision"
            ? "awaiting_decision"
            : "approved",
        JSON.stringify({ outcome, reasons, policyVersion }),
        now(),
        proposal.proposal_id,
      );
  }

  private createDecision(proposal: Proposal, proposalDigest: string) {
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          "SELECT id FROM decisions WHERE workspace_id=? AND proposal_digest=?",
        )
        .get(proposal.scope.workspace_id, proposalDigest) as Row | undefined;
      if (existing) return String(existing.id);
      const id = randomUUID();
      const sources = Object.fromEntries(
        this.sourceReads(proposal.proposal_id).map((read) => [
          String(read.source_id),
          {
            revisionId: String(read.source_revision_id),
            validityEpoch: Number(read.validity_epoch),
          },
        ]),
      );
      const expectedVersions = { sources, target: proposal.expected_versions };
      const expectedVersionsJson = JSON.stringify(expectedVersions);
      const expectedVersionsDigest = stableDigest(expectedVersions);
      const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const createdAt = now();
      this.db
        .prepare(
          `INSERT INTO decisions(
             id,workspace_id,proposal_digest,expected_versions,owner_binding,
             expires_at,state,request_id,decided_at,action,resolved_at,created_at
           ) VALUES(?,?,?,?,?,?,'pending',NULL,NULL,NULL,NULL,?)`,
        )
        .run(
          id,
          proposal.scope.workspace_id,
          proposalDigest,
          expectedVersionsJson,
          JSON.stringify({ actorId: this.options.ownerId ?? "owner" }),
          expiresAt,
          createdAt,
        );

      const targets = this.db
        .prepare(
          `SELECT t.chat_id,t.binding_version,b.id AS binding_id,b.owner_open_id
           FROM lark_targets t JOIN lark_bindings b
             ON b.connection_id=t.connection_id
            AND b.binding_version=t.binding_version
           JOIN lark_connections c ON c.id=t.connection_id
           WHERE t.workspace_id=? AND t.purpose='decision'
             AND t.state='active' AND b.state='active' AND c.state='active'`,
        )
        .all(proposal.scope.workspace_id) as Row[];
      if (!targets.length) return id;

      const changeId = randomUUID();
      const title = `需要确认：${
        proposal.kind === "task" ? proposal.body.title : proposal.kind
      }`.slice(0, 200);
      this.db
        .prepare("INSERT INTO changes VALUES(?,?,?,?,?,?,?)")
        .run(changeId, "decision", title, null, id, proposal.reason, createdAt);
      this.db
        .prepare("INSERT INTO notifications VALUES(?,?,?,?,?,?,?)")
        .run(
          randomUUID(),
          changeId,
          title,
          proposal.reason,
          createdAt,
          null,
          `decision:${id}`,
        );
      for (const target of targets) {
        const cardActionId = randomUUID();
        const nonce = randomBytes(32).toString("base64url");
        const nonceHash = stableDigest(nonce);
        const commonValue = {
          protocol: "omem.decision.v1",
          cardActionId,
          nonce,
          proposalDigest,
          expiresAt,
          expectedVersionsDigest,
        };
        const button = (
          action: "approve" | "reject" | "request_context",
          content: string,
          type: "primary" | "danger" | "default",
        ) => ({
          tag: "button",
          type,
          text: { tag: "plain_text", content },
          behaviors: [{ type: "callback", value: { ...commonValue, action } }],
        });
        const card = {
          schema: "2.0",
          config: { width_mode: "default", update_multi: true },
          header: {
            title: { tag: "plain_text", content: title },
            template: "orange",
          },
          body: {
            elements: [
              {
                tag: "markdown",
                content: `${proposal.reason.slice(0, 4000)}\n\n**提案摘要**\n\`${JSON.stringify(
                  proposal.body,
                ).slice(0, 2000)}\``,
              },
              {
                tag: "column_set",
                flex_mode: "flow",
                horizontal_spacing: "8px",
                columns: [
                  {
                    tag: "column",
                    width: "auto",
                    elements: [button("approve", "批准", "primary")],
                  },
                  {
                    tag: "column",
                    width: "auto",
                    elements: [button("reject", "拒绝", "danger")],
                  },
                  {
                    tag: "column",
                    width: "auto",
                    elements: [
                      button("request_context", "补充背景", "default"),
                    ],
                  },
                ],
              },
            ],
          },
        };
        const payloadJson = JSON.stringify(card);
        if (Buffer.byteLength(payloadJson) > 30_000)
          throw Error("LARK_CARD_PAYLOAD_TOO_LARGE");
        this.db
          .prepare(
            `INSERT INTO lark_card_actions(
               id,workspace_id,decision_id,proposal_digest,binding_id,chat_id,
               operator_open_id,message_id,nonce_hash,expires_at,state,
               result_json,created_at,consumed_at
             ) VALUES(?,?,?,?,?,?,?,NULL,?,?,'pending',NULL,?,NULL)`,
          )
          .run(
            cardActionId,
            proposal.scope.workspace_id,
            id,
            proposalDigest,
            String(target.binding_id),
            String(target.chat_id),
            String(target.owner_open_id),
            nonceHash,
            expiresAt,
            createdAt,
          );
        this.db
          .prepare(
            `INSERT INTO delivery_intents(
               id,workspace_id,change_id,channel_binding_version,channel,target,
               payload_digest,provider_uuid,state,created_at,updated_at,
               binding_id,payload_json,next_attempt_at,card_action_id,
               aggregation_mode,aggregate_after
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            proposal.scope.workspace_id,
            changeId,
            Number(target.binding_version),
            "lark",
            String(target.chat_id),
            stableDigest(card),
            stableDigest({
              decisionId: id,
              bindingId: target.binding_id,
            }).slice(0, 50),
            "pending",
            createdAt,
            createdAt,
            String(target.binding_id),
            payloadJson,
            createdAt,
            cardActionId,
            "instant",
            createdAt,
          );
        const intent = this.db
          .prepare(
            `SELECT id FROM delivery_intents
             WHERE workspace_id=? AND change_id=? AND channel='lark'
               AND target=?`,
          )
          .get(
            proposal.scope.workspace_id,
            changeId,
            String(target.chat_id),
          ) as Row;
        this.db
          .prepare(
            `INSERT INTO delivery_intent_changes(intent_id,change_id,ordinal)
             VALUES(?,?,0)`,
          )
          .run(String(intent.id), changeId);
      }
      return id;
    });
  }

  private apply(
    proposal: Proposal,
    proposalDigest: string,
    decision?: { id: string; requestId: string },
    approvedByOwner = false,
  ) {
    const metadata = {
      workspaceId: proposal.scope.workspace_id,
      applicationId: `proposal:${proposalDigest}:1`,
      proposalId: proposal.proposal_id,
      proposalDigest,
      generation: 1,
      title: `应用${proposal.kind}：${
        proposal.kind === "task" ? proposal.body.title : "新记忆"
      }`,
      details: proposal.reason,
      delivery: {
        channelBindingVersion: 1,
        channel: "in_app",
        target: "notification-center",
      },
    };
    const hooks = {
      before: () => {
        this.assertCurrentReads(proposal.proposal_id);
        if (decision) {
          const current = this.db
            .prepare(
              "SELECT state,request_id,proposal_digest FROM decisions WHERE id=?",
            )
            .get(decision.id) as Row | undefined;
          if (
            !current ||
            current.state !== "pending" ||
            current.request_id ||
            current.proposal_digest !== proposalDigest
          )
            throw Error("STALE_DECISION");
        }
      },
      after: () => {
        this.db
          .prepare(
            "UPDATE proposals SET state='applied',updated_at=? WHERE id=?",
          )
          .run(now(), proposal.proposal_id);
        if (decision) {
          const updated = this.db
            .prepare(
              `UPDATE decisions SET state='approved',action='approve',
                 request_id=?,resolved_at=?,decided_at=?
               WHERE id=? AND state='pending'`,
            )
            .run(decision.requestId, now(), now(), decision.id);
          if (Number(updated.changes) !== 1) throw Error("STALE_DECISION");
        }
      },
    };
    if (proposal.kind === "task")
      return this.store.applications.applyTask(
        {
          metadata,
          task: {
            id: proposal.target_id ?? undefined,
            expectedVersion: proposal.target_id
              ? proposal.expected_versions[proposal.target_id]
              : undefined,
            title: proposal.body.title,
            detail: proposal.reason,
            ownerId: proposal.body.owner_id,
            dueAt: proposal.body.due_at,
            dueExpression: proposal.body.due_expression,
            nextStep: proposal.body.next_step,
            evidenceId:
              "exact_quote" in proposal.evidence[0]!
                ? proposal.evidence[0]!.fragment_revision_id
                : null,
          },
        },
        hooks,
      );
    if (proposal.kind === "procedure" && !approvedByOwner)
      throw Error("PROCEDURE_CANNOT_AUTO_APPLY");
    return this.store.applications.applyMemory(
      {
        metadata,
        memory: {
          id: proposal.target_id ?? undefined,
          expectedVersion: proposal.target_id
            ? proposal.expected_versions[proposal.target_id]
            : undefined,
          kind: proposal.kind,
          scope: proposal.scope,
          body: proposal.body,
          validFrom:
            proposal.kind === "claim" ? proposal.body.valid_from : null,
          validTo: proposal.kind === "claim" ? proposal.body.valid_to : null,
          evidenceSet: this.evidenceDependencies(proposal.proposal_id),
        },
      },
      hooks,
    );
  }

  evaluate(
    proposalInput: unknown,
    assessmentInput: unknown,
    options: { impactCount?: number } = {},
  ): EvaluationResult {
    const proposal = proposalSchema.parse(proposalInput);
    const assessment = proposalAssessmentInputSchema.parse(assessmentInput);
    const impactCount = options.impactCount ?? 1;
    const persisted = this.persistProposal(proposal, impactCount);
    const existingReceipt = this.db
      .prepare(
        `SELECT id,entity_type,entity_id,entity_version,change_id
         FROM application_receipts
         WHERE workspace_id=? AND proposal_digest=? AND application_generation=1`,
      )
      .get(proposal.scope.workspace_id, persisted.digest) as Row | undefined;
    if (existingReceipt)
      return {
        proposalId: proposal.proposal_id,
        proposalDigest: persisted.digest,
        evidenceVerdict: "valid",
        policy: "auto_apply",
        reasons: [],
        receipt: {
          id: String(existingReceipt.id),
          entityType: String(existingReceipt.entity_type) as "memory" | "task",
          entityId: String(existingReceipt.entity_id),
          entityVersion: Number(existingReceipt.entity_version),
          changeId: String(existingReceipt.change_id),
          duplicate: true,
        },
      };
    const deterministic = this.validateEvidence(proposal);
    this.persistAssessment(
      proposal,
      persisted.digest,
      assessment,
      deterministic.verdict,
      deterministic.errors,
    );
    const policy = this.policy(
      proposal,
      assessment,
      deterministic.verdict,
      impactCount,
    );
    this.persistPolicy(
      proposal,
      persisted.digest,
      policy.outcome,
      policy.reasons,
      impactCount,
    );
    const result: EvaluationResult = {
      proposalId: proposal.proposal_id,
      proposalDigest: persisted.digest,
      evidenceVerdict: deterministic.verdict,
      policy: policy.outcome,
      reasons: policy.reasons,
    };
    if (policy.outcome === "reject") return result;
    if (policy.outcome === "awaiting_decision") {
      result.decisionId = this.createDecision(proposal, persisted.digest);
      return result;
    }
    result.receipt = this.apply(proposal, persisted.digest);
    return result;
  }

  decide(decisionId: string, input: unknown) {
    const action = decisionActionSchema.parse(input);
    const decision = this.db
      .prepare("SELECT * FROM decisions WHERE id=?")
      .get(decisionId) as Row | undefined;
    if (!decision) throw Error("DECISION_NOT_FOUND");
    if (decision.proposal_digest !== action.proposalDigest)
      throw Error("DECISION_DIGEST_MISMATCH");
    const owner = JSON.parse(String(decision.owner_binding)) as {
      actorId: string;
    };
    if (owner.actorId !== action.actorId)
      throw Error("DECISION_ACTOR_MISMATCH");
    if (decision.request_id) {
      if (decision.request_id !== action.requestId)
        throw Error("DECISION_ALREADY_RESOLVED");
      return { state: String(decision.state), duplicate: true };
    }
    if (decision.state !== "pending") throw Error("DECISION_ALREADY_RESOLVED");
    if (String(decision.expires_at) <= now()) {
      this.db
        .prepare("UPDATE decisions SET state='expired' WHERE id=?")
        .run(decisionId);
      throw Error("STALE_DECISION");
    }
    const proposalRow = this.db
      .prepare("SELECT * FROM proposals WHERE digest=?")
      .get(action.proposalDigest) as Row;
    const proposal = proposalSchema.parse({
      schema_version: Number(proposalRow.schema_version),
      proposal_id: proposalRow.id,
      kind: proposalRow.kind,
      operation: proposalRow.operation,
      target_id: proposalRow.target_id,
      scope: JSON.parse(String(proposalRow.scope)),
      body: JSON.parse(String(proposalRow.body)),
      evidence: JSON.parse(String(proposalRow.evidence)),
      uncertainties: JSON.parse(String(proposalRow.uncertainties)),
      reason: proposalRow.reason,
      expected_versions: JSON.parse(String(proposalRow.expected_versions)),
      origin: JSON.parse(String(proposalRow.origin)),
    });
    try {
      this.assertCurrentReads(proposal.proposal_id);
    } catch (error) {
      this.transaction(() => {
        this.db
          .prepare(
            "UPDATE decisions SET state='stale',action=?,request_id=?,resolved_at=?,decided_at=? WHERE id=?",
          )
          .run(action.action, action.requestId, now(), now(), decisionId);
        this.db
          .prepare("UPDATE proposals SET state='stale',updated_at=? WHERE id=?")
          .run(now(), proposal.proposal_id);
      });
      throw error;
    }
    if (action.action !== "approve") {
      const state =
        action.action === "reject" ? "rejected" : "context_requested";
      this.transaction(() => {
        this.db
          .prepare(
            "UPDATE decisions SET state=?,action=?,request_id=?,resolved_at=?,decided_at=? WHERE id=?",
          )
          .run(
            state,
            action.action,
            action.requestId,
            now(),
            now(),
            decisionId,
          );
        this.db
          .prepare("UPDATE proposals SET state=?,updated_at=? WHERE id=?")
          .run(
            action.action === "reject" ? "rejected" : "awaiting_decision",
            now(),
            proposal.proposal_id,
          );
      });
      return { state, duplicate: false };
    }
    const receipt = this.apply(
      proposal,
      action.proposalDigest,
      { id: decisionId, requestId: action.requestId },
      true,
    );
    return { state: "approved", duplicate: false, receipt };
  }

  restoreMemory(input: {
    memoryId: string;
    expectedVersion: number;
    targetVersion: number;
    requestId: string;
  }) {
    const memory = this.db
      .prepare("SELECT * FROM memories WHERE id=?")
      .get(input.memoryId) as Row | undefined;
    if (!memory) throw Error("MEMORY_NOT_FOUND");
    if (Number(memory.version) !== input.expectedVersion)
      throw Error("REBASE_REQUIRED");
    const target = this.db
      .prepare("SELECT * FROM memory_revisions WHERE memory_id=? AND version=?")
      .get(input.memoryId, input.targetVersion) as Row | undefined;
    if (!target) throw Error("MEMORY_REVISION_NOT_FOUND");
    const dependencies = this.db
      .prepare("SELECT * FROM memory_dependencies WHERE memory_revision_id=?")
      .all(String(target.id)) as Row[];
    if (dependencies.some((dependency) => dependency.state === "stale"))
      throw Error("STALE_MEMORY_DEPENDENCY");
    return this.store.applications.applyMemory(
      {
        metadata: {
          workspaceId: String(memory.workspace_id),
          applicationId: input.requestId,
          proposalDigest: stableDigest(input),
          generation: 1,
          title: "恢复记忆",
          details: "恢复生成新修订，保留历史。",
          delivery: {
            channelBindingVersion: 1,
            channel: "in_app",
            target: "notification-center",
          },
        },
        memory: {
          id: input.memoryId,
          expectedVersion: input.expectedVersion,
          kind: String(memory.kind) as "claim" | "episode" | "procedure",
          scope: JSON.parse(String(memory.scope)),
          body: JSON.parse(String(target.body)),
          validFrom: target.valid_from ? String(target.valid_from) : null,
          validTo: target.valid_to ? String(target.valid_to) : null,
          status: "active",
          evidenceSet: dependencies.map((dependency) => ({
            sourceId: String(dependency.source_id),
            sourceRevisionId: String(dependency.source_revision_id),
            validityEpoch: Number(dependency.validity_epoch),
          })),
        },
      },
      {
        before: () => {
          const stale = this.db
            .prepare(
              `SELECT 1 FROM memory_dependencies
               WHERE memory_revision_id=? AND state='stale' LIMIT 1`,
            )
            .get(String(target.id));
          if (stale) throw Error("STALE_MEMORY_DEPENDENCY");
        },
      },
    );
  }

  proposals() {
    return (
      this.db
        .prepare("SELECT * FROM proposals ORDER BY created_at DESC")
        .all() as Row[]
    ).map((row) => this.proposalView(row));
  }

  proposal(proposalId: string) {
    const row = this.proposalRow(proposalId);
    return row ? this.proposalView(row) : null;
  }

  decisions() {
    const rows = this.db
      .prepare(
        `SELECT d.*,p.id AS proposal_id
         FROM decisions d JOIN proposals p ON p.digest=d.proposal_digest
         ORDER BY d.created_at DESC`,
      )
      .all() as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      proposalDigest: String(row.proposal_digest),
      expectedVersions: JSON.parse(String(row.expected_versions)),
      actorId: String(
        (JSON.parse(String(row.owner_binding)) as { actorId: string }).actorId,
      ),
      expiresAt: String(row.expires_at),
      state: String(row.state),
      requestId: row.request_id ? String(row.request_id) : null,
      action: row.action ? String(row.action) : null,
      decidedAt: row.decided_at ? String(row.decided_at) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      createdAt: String(row.created_at),
      proposal: this.proposal(String(row.proposal_id))!,
    }));
  }

  memories() {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY updated_at DESC")
      .all();
  }
}

export class FeedbackService {
  constructor(private readonly store: Store) {}

  record(value: unknown) {
    const input = feedbackInputSchema.parse(value);
    const payloadDigest = stableDigest(input);
    return this.store.tx(() => {
      const existing = this.store.db
        .prepare(
          "SELECT * FROM feedback WHERE workspace_id=? AND producer=? AND event_id=?",
        )
        .get(input.scope.workspace_id, input.producer, input.eventId) as
        | Row
        | undefined;
      if (existing) {
        if (String(existing.payload_digest) !== payloadDigest)
          throw Error("FEEDBACK_EVENT_CONFLICT");
        return { id: String(existing.id), duplicate: true };
      }
      const id = randomUUID();
      const protectedPolicy = /acl|permission|budget|auto.?approv/i.test(
        input.matchKey,
      );
      const evidenceValid =
        input.evidence.length > 0 &&
        input.evidence.every((evidenceId) => this.store.evidence(evidenceId));
      const confirmed =
        Boolean(input.actor.verifiedBy) &&
        input.producerKind === "original" &&
        evidenceValid;
      const weak = input.kind === "useful" || input.kind === "outcome";
      const strength =
        protectedPolicy || input.kind === "policy_suggestion"
          ? "shadow"
          : confirmed && !weak
            ? "confirmed"
            : "weak";
      const constraintKind =
        input.kind === "useful" || input.kind === "outcome"
          ? "weak_signal"
          : input.kind;
      this.store.db
        .prepare(
          `INSERT INTO feedback(
             id,workspace_id,producer,event_id,subject_type,subject_id,
             actor_provenance,correction,outcome,evidence,scope,created_at,
             payload_digest
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.scope.workspace_id,
          input.producer,
          input.eventId,
          input.subjectType,
          input.subjectId,
          JSON.stringify(input.actor),
          input.replacement,
          input.kind,
          JSON.stringify(input.evidence),
          JSON.stringify(input.scope),
          now(),
          payloadDigest,
        );
      this.store.db
        .prepare(
          `INSERT INTO feedback_constraints(
             id,workspace_id,project_id,subject_id,feedback_id,kind,match_key,
             replacement,strength,active,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          input.scope.workspace_id,
          input.scope.project_id,
          input.scope.subject_id,
          id,
          constraintKind,
          input.matchKey,
          input.replacement,
          strength,
          strength === "confirmed" ? 1 : 0,
          now(),
        );
      return { id, duplicate: false, strength };
    });
  }

  recall(scope: Proposal["scope"]) {
    return this.store.db
      .prepare(
        `SELECT * FROM feedback_constraints
         WHERE workspace_id=? AND project_id IS ? AND subject_id IS ?
           AND active=1 AND strength='confirmed'
         ORDER BY created_at`,
      )
      .all(scope.workspace_id, scope.project_id, scope.subject_id) as Row[];
  }

  applyConfirmedCorrections(proposalInput: unknown) {
    const proposal = proposalSchema.parse(proposalInput);
    if (proposal.kind !== "task") return { proposal, constraintIds: [] };
    const constraints = this.recall(proposal.scope);
    let owner = proposal.body.owner_id;
    const applied: string[] = [];
    for (const constraint of constraints) {
      if (
        constraint.kind === "task_assignment" &&
        constraint.match_key === `owner:${owner}` &&
        constraint.replacement
      ) {
        owner = String(constraint.replacement);
        applied.push(String(constraint.id));
      }
    }
    return {
      proposal: proposalSchema.parse({
        ...proposal,
        body: { ...proposal.body, owner_id: owner },
      }),
      constraintIds: applied,
    };
  }
}
