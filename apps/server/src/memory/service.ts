import type { RequirementState } from "../../../../packages/contracts/src/development.js";
import type { TaskAction, TaskFollowUp, TaskStatus } from "../../../../packages/contracts/src/task-flow.js";
import { validateFollowUp } from "../tasks/follow-up.js";
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

export type PolicyOutcome =
  | "auto_apply"
  | "awaiting_decision"
  | "reject"
  | "defer_until_use"
  | "retain_as_source"
  | "ignore_noise";

export type KnowledgeMatch = {
  kind: "duplicate_linked" | "equivalent_linked" | "conflict_recorded";
  memoryId: string | null;
  detail: string;
  /** Problem 5: the concrete existing revision the new claim conflicts with. Never
   *  the first row in the table. Populated for conflict_recorded. */
  conflictingRevisionId?: string;
  /** Why the matcher believes this memory is the real conflict (entity overlap +
   *  opposite predicate polarity), so the association is auditable. */
  matchReason?: string;
  /** Both sides' evidence references, so the dispute can be traced back. */
  evidenceChain?: {
    existingStatement: string;
    existingEvidenceRefs: string[];
    proposedEvidenceRefs: string[];
    sharedTerms: string[];
  };
};

export type EvaluationResult = {
  proposalId: string;
  proposalDigest: string;
  evidenceVerdict: "valid" | "invalid" | "ambiguous";
  policy: PolicyOutcome;
  reasons: string[];
  receipt?: ReturnType<Store["applications"]["applyMemory"]>;
  decisionId?: string;
  /** F5: the create proposal was matched against existing knowledge instead of
   * blindly inserting a new active memory. */
  match?: KnowledgeMatch;
  /** F: this proposal would have auto-applied, but the whole ChangeSet's deduped
   * union impact exceeded the auto budget. It is persisted as awaiting_decision
   * WITHOUT applying; evaluateBatch raises a single batch AttentionCase for all
   * such proposals instead of N separate cards. */
  batchDeferred?: boolean;
};

const now = () => new Date().toISOString();

/** Notification prose describes the applied content, never its storage kind or
 * identifiers. Historical bodies are read for display; authority stays in apply. */
export const readableMemory = (kind: string, body: Record<string, unknown>) => {
  const lines = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (kind === "claim") return String(body.statement ?? "");
  if (kind === "episode") {
    const outcomes: Record<string, string> = { unknown: "尚不明确", partial: "部分完成", success: "已完成", failure: "未成功" };
    return [String(body.trigger ?? ""), ...lines(body.actions).map(action => `- ${action}`),
      `结果：${outcomes[String(body.outcome)] ?? "尚不明确"}`].filter(Boolean).join("\n");
  }
  return [String(body.trigger ?? ""),
    ...lines(body.preconditions).map(condition => `使用条件：${condition}`),
    ...lines(body.steps).map((instruction, index) => `${index + 1}. ${instruction}`),
    ...lines(body.verification).map(check => `完成检查：${check}`)].filter(Boolean).join("\n");
};

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

  /** Explicit owner commands reuse the same atomic receipts, revision history
   * and notification outbox as proposals. The model never writes task rows. */
  commandTask(input: { taskId: string; expectedVersion: number; action: TaskAction; followUp?: TaskFollowUp | null;
    dueAt: string | null; dueExpression: string | null; requestId: string; evidenceId: string }) {
    const evidence = this.store.evidence(input.evidenceId);
    const owner = this.options.ownerId ?? "owner";
    if (!evidence || (evidence.revision.provenance?.actorPrincipalId ?? evidence.revision.provenance?.actorId) !== owner ||
      !evidence.revision.provenance?.actorVerifiedBy || evidence.revision.provenance?.quoted || evidence.revision.provenance?.forwarded ||
      evidence.revision.provenance?.producerKind !== "original") throw Error("TASK_OWNER_EVIDENCE_REQUIRED");
    const task = this.db.prepare("SELECT * FROM tasks WHERE id=? AND workspace_id='personal'").get(input.taskId) as Row | undefined;
    if (!task || (task.owner_id && task.owner_id !== owner)) throw Error("TASK_NOT_FOUND");
    if (["done", "cancelled"].includes(String(task.status)) && ["wait", "snooze", "reschedule"].includes(input.action)) throw Error("请先重新打开该事项");
    if (input.action === "reschedule" && (!input.dueAt || !Number.isFinite(Date.parse(input.dueAt)))) throw Error("INVALID_TASK_TIME");
    const followUp = input.followUp ? validateFollowUp(input.followUp, evidence.fragment.text) : null;
    if (input.action === "wait" && !followUp?.waiting_on) throw Error("请说明等待谁或什么结果");
    if (input.action === "snooze" && !followUp?.snoozed_until) throw Error("请说明下次提醒的明确时间");
    const actionName = { complete: "完成", reopen: "重新打开", reschedule: "改期", wait: "等待", snooze: "稍后跟进", cancel: "取消" }[input.action];
    return this.store.applications.applyTask({
      metadata: { workspaceId: "personal", applicationId: `assistant-command:${input.requestId}:${input.taskId}`,
        proposalId: `assistant-task:${input.requestId}:${input.taskId}`, proposalDigest: stableDigest(input), generation: 1,
        title: `${actionName}待办：${task.title}`, details: evidence.fragment.text,
        delivery: { channelBindingVersion: 1, channel: "in_app", target: "notification-center" } },
      task: { id: input.taskId, expectedVersion: input.expectedVersion, title: String(task.title), detail: String(task.detail),
        ownerId: owner, nextStep: String(task.next_step), evidenceId: input.evidenceId,
        status: input.action === "complete" ? "done" : input.action === "cancel" ? "cancelled" : input.action === "reopen" ? "open" : input.action === "wait" ? "waiting" : task.status as TaskStatus,
        followUp: ["complete", "cancel", "reopen"].includes(input.action) ? null : input.action === "wait" ? followUp : input.action === "snooze" ? {
          ...followUp!, waiting_on: task.follow_up ? JSON.parse(String(task.follow_up)).waiting_on : null, next_check_at: followUp!.snoozed_until,
        } : undefined,
        dueAt: input.action === "reschedule" ? input.dueAt : task.due_at ? String(task.due_at) : null,
        dueExpression: input.action === "reschedule" ? input.dueExpression : task.due_expression ? String(task.due_expression) : null },
    });
  }

  /** The subscription is explicit owner intent. Source people remain collaborators;
   * the personal task asks the owner to follow progress, not perform their work. */
  applyRequirementFollowUp(input: {key:string;actionId:string;revision:string;action:RequirementState["actions"][number];
    evidenceId:string;taskId?:string;expectedVersion?:number;projectId?:string|null}) {
    const {action}=input;
    if(action.certainty!=="confirmed"||!this.store.evidence(input.evidenceId))throw Error("REQUIREMENT_ORIGINAL_REQUIRED");
    const link=this.db.prepare("SELECT enabled FROM requirement_tasks WHERE page_key=? AND action_id=?").get(input.key,input.actionId);
    if(link?.enabled!==1)throw Error("REQUIREMENT_FOLLOW_NOT_ENABLED");
    const token=stableDigest({key:input.key,actionId:input.actionId,revision:input.revision,action});
    const detail=[action.detail,action.owner?`材料中的负责人：${action.owner}`:"负责人未明确",`来源需求：${input.key}`].join("\n");
    return this.store.applications.applyTask({
      metadata:{workspaceId:"personal",applicationId:`requirement:${token}`,proposalDigest:token,generation:1,
        title:`需求跟进：${action.title}`,details:detail,delivery:{channelBindingVersion:1,channel:"in_app",target:"notification-center"}},
      task:{id:input.taskId,expectedVersion:input.expectedVersion,title:`跟进：${action.title}`,detail,ownerId:"owner",projectId:input.projectId,
        evidenceId:input.evidenceId,status:action.status,dueAt:action.dueAt,dueExpression:action.dueExpression,nextStep:action.detail,
        followUp:{waiting_on:action.waitingOn,next_check_at:null,snoozed_until:null,time_expression:null,timezone:"Asia/Shanghai"}},
    }, {after: receipt => {
      this.db.prepare(`UPDATE requirement_tasks SET task_id=?,task_version=?,action_digest=?,article_revision=?,error=NULL,updated_at=? WHERE page_key=? AND action_id=?`)
        .run(receipt.entityId,receipt.entityVersion,stableDigest(action),input.revision,new Date().toISOString(),input.key,input.actionId);
    }});
  }

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
      const provenance = revision?.provenance;
      if (!provenance) return false;
      // Canonical principal wins; older inputs without it fall back to actorId.
      const principal = provenance.actorPrincipalId ?? provenance.actorId;
      return Boolean(
        principal === ownerId &&
          provenance.actorVerifiedBy &&
          !provenance.forwarded,
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

  private isReviewedAmendment(proposal: Proposal, assessment: AssessmentInput) {
    if (assessment.update_relation !== "amends" || assessment.semantic_verdict !== "supported" || !proposal.target_id)
      return false;
    const target = this.db.prepare("SELECT scope,version FROM memories WHERE id=?").get(proposal.target_id);
    if (!target || Number(target.version) !== proposal.expected_versions[proposal.target_id]) return false;
    const scope = JSON.parse(String(target.scope));
    return scope.workspace_id === proposal.scope.workspace_id && this.sameProject(scope, proposal);
  }

  private proposalSourceIds(proposalId: string) {
    return new Set(
      this.sourceReads(proposalId).map((row) => String(row.source_id)),
    );
  }

  private memorySourceIds(headRevisionId: string) {
    return new Set(
      (
        this.db
          .prepare(
            "SELECT source_id FROM memory_dependencies WHERE memory_revision_id=?",
          )
          .all(headRevisionId) as Row[]
      ).map((row) => String(row.source_id)),
    );
  }

  private normalizeStatement(statement: string) {
    return statement.replace(/\s+/g, " ").trim();
  }

  /**
   * Deterministic entity-term extraction for conflict / equivalence matching.
   * Latin tokens are kept whole; CJK is reduced to content bigrams after dropping
   * grammatical/stopword characters. Negation markers are deliberately kept out of
   * the term set but detected separately as predicate polarity.
   */
  private contentTokens(statement: string): Set<string> {
    const text = this.normalizeStatement(statement).toLowerCase();
    const tokens = new Set<string>();
    for (const match of text.matchAll(/[a-z0-9]+/g)) tokens.add(match[0]);
    const cjk = text.replace(/[^一-鿿]/g, "");
    const stop = new Set(
      "的了在是我你他它们和与或也都就还已将被把让这那个之于对从不未否没是否有".split(""),
    );
    const chars = [...cjk].filter((char) => !stop.has(char));
    for (let i = 0; i + 1 < chars.length; i++)
      tokens.add(chars[i]! + chars[i + 1]!);
    return tokens;
  }

  /** Predicate polarity: a claim negating the state is the opposite polarity of an
   *  affirmative claim about the same entity. */
  private isNegativePolarity(statement: string): boolean {
    return /[未不没无]|禁用|关闭|下线|失败|停止|取消|不启用/.test(statement);
  }

  /** Fragment ids supporting a memory head revision (its source revisions' fragments). */
  private memoryEvidenceRefs(headRevisionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT source_revision_id FROM memory_dependencies WHERE memory_revision_id=?",
      )
      .all(headRevisionId) as Row[];
    const refs = new Set<string>();
    for (const row of rows)
      for (const fragment of this.store.fragments(String(row.source_revision_id)))
        refs.add(fragment.id);
    return [...refs];
  }

  private sameProject(
    memoryScope: { project_id?: string | null },
    proposal: Proposal,
  ) {
    const a = memoryScope.project_id ?? null;
    const b = proposal.scope.project_id ?? null;
    return a === b;
  }

  /** Two claims only conflict when their stated validity windows can both be true at
   *  once. If the existing memory is already expired before the proposal becomes
   *  valid, they are about different times and must not be associated. */
  private timesOverlap(
    existing: { valid_from: string | null; valid_to: string | null },
    proposal: Extract<Proposal, { kind: "claim" }>,
  ): boolean {
    const proposedFrom = proposal.body.valid_from;
    const proposedTo = proposal.body.valid_to;
    if (existing.valid_to && proposedFrom && existing.valid_to < proposedFrom)
      return false;
    if (existing.valid_from && proposedTo && existing.valid_from > proposedTo)
      return false;
    return true;
  }

  /**
   * F5 / Problem 5: before creating a new claim, recall active knowledge IN SCOPE
   * (same workspace, same project) and decide duplicate / equivalent / conflict.
   * Conflict association is by entity-term overlap plus opposite predicate polarity —
   * never by taking the first row in the table — and returns a verifiable chain.
   */
  private detectCreateMatch(
    proposal: Extract<Proposal, { kind: "claim" }>,
    assessment: AssessmentInput,
  ): KnowledgeMatch | null {
    const statement = this.normalizeStatement(proposal.body.statement);
    const proposedSources = this.proposalSourceIds(proposal.proposal_id);
    // Hard scope filter: a memory in another workspace can never be the match.
    const rows = this.db
      .prepare(
        `SELECT m.id, m.scope, mr.id AS revision_id, mr.body, mr.valid_from, mr.valid_to
         FROM memories m JOIN memory_revisions mr ON mr.id = m.head_revision_id
         WHERE m.status='active' AND m.kind='claim' AND m.workspace_id=?`,
      )
      .all(proposal.scope.workspace_id) as Row[];

    type Candidate = {
      memoryId: string;
      revisionId: string;
      statement: string;
      overlap: boolean;
      validFrom: string | null;
      validTo: string | null;
    };
    const candidates: Candidate[] = [];
    for (const row of rows) {
      const body = JSON.parse(String(row.body)) as { statement?: unknown };
      if (typeof body.statement !== "string") continue;
      const scope = JSON.parse(String(row.scope)) as {
        project_id?: string | null;
      };
      // Cross-project text is not auto-associated as duplicate/equivalent/conflict
      // unless an explicit cross-scope marker exists; the deterministic gate has none.
      if (!this.sameProject(scope, proposal)) continue;
      const existingSources = this.memorySourceIds(String(row.revision_id));
      candidates.push({
        memoryId: String(row.id),
        revisionId: String(row.revision_id),
        statement: body.statement,
        overlap: [...proposedSources].some((source) =>
          existingSources.has(source),
        ),
        validFrom: row.valid_from ? String(row.valid_from) : null,
        validTo: row.valid_to ? String(row.valid_to) : null,
      });
    }

    // Exact duplicate / equivalence: identical normalized statement, same project.
    const exact = candidates.filter(
      (candidate) => this.normalizeStatement(candidate.statement) === statement,
    );
    if (exact.length) {
      const duplicate = exact.find((candidate) => candidate.overlap);
      if (duplicate)
        return {
          kind: "duplicate_linked",
          memoryId: duplicate.memoryId,
          detail: "same statement already applied from an overlapping source",
        };
      return {
        kind: "equivalent_linked",
        memoryId: exact[0]!.memoryId,
        detail:
          "same conclusion from an independent source; equivalence and evidence retained",
      };
    }

    // The verifier flagged a contradiction. Pick the memory that actually shares the
    // entity and asserts the opposite polarity — not rows[0].
    if (assessment.reason_code === "contradicts_existing") {
      const proposedTokens = this.contentTokens(statement);
      const proposedNegative = this.isNegativePolarity(statement);
      let best: (Candidate & { score: number }) | null = null;
      for (const candidate of candidates) {
        if (
          !this.timesOverlap(
            { valid_from: candidate.validFrom, valid_to: candidate.validTo },
            proposal,
          )
        )
          continue;
        const existingTokens = this.contentTokens(candidate.statement);
        const shared = [...proposedTokens].filter((token) =>
          existingTokens.has(token),
        );
        if (shared.length === 0) continue; // unrelated memory: never associated
        if (this.isNegativePolarity(candidate.statement) === proposedNegative)
          continue; // same polarity = restatement, not a contradiction
        if (!best || shared.length > best.score)
          best = { ...candidate, score: shared.length };
      }
      if (best) {
        const sharedTerms = [...proposedTokens].filter((token) =>
          this.contentTokens(best!.statement).has(token),
        );
        return {
          kind: "conflict_recorded",
          memoryId: best.memoryId,
          conflictingRevisionId: best.revisionId,
          matchReason: `shared entity terms [${sharedTerms.join(", ")}] with opposite predicate polarity`,
          detail: `contradicts active claim "${best.statement}"`,
          evidenceChain: {
            existingStatement: best.statement,
            existingEvidenceRefs: this.memoryEvidenceRefs(best.revisionId),
            proposedEvidenceRefs: proposal.evidence.map(
              (evidence) => evidence.fragment_revision_id,
            ),
            sharedTerms,
          },
        };
      }
    }
    return null;
  }

  /**
   * G17: the set of active memory ids a proposal actually touches — the target plus
   * every other active memory in the same workspace that depends on the target's
   * sources. Returned as a SET so a whole ChangeSet can be unioned and de-duplicated
   * instead of being counted as N independent impact=1 operations.
   */
  private affectedMemoryIds(proposal: Proposal): Set<string> {
    const touched = new Set<string>();
    if (proposal.operation === "create" || !proposal.target_id) return touched;
    const target = this.db
      .prepare(
        "SELECT head_revision_id FROM memories WHERE id=? AND workspace_id=?",
      )
      .get(proposal.target_id, proposal.scope.workspace_id) as Row | undefined;
    if (!target) return touched;
    touched.add(proposal.target_id);
    const targetSources = this.memorySourceIds(String(target.head_revision_id));
    if (!targetSources.size) return touched;
    const placeholders = [...targetSources].map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT DISTINCT m.id FROM memories m
         JOIN memory_revisions mr ON mr.id = m.head_revision_id
         JOIN memory_dependencies md ON md.memory_revision_id = mr.id
         WHERE m.status='active' AND m.workspace_id=? AND m.id <> ?
           AND md.source_id IN (${placeholders})`,
      )
      .all(
        proposal.scope.workspace_id,
        proposal.target_id,
        ...[...targetSources],
      ) as Row[];
    for (const row of rows) touched.add(String(row.id));
    return touched;
  }

  private computeInternalImpact(proposal: Proposal): number {
    return this.affectedMemoryIds(proposal).size;
  }

  /**
   * F: a create proposal does not target an existing memory, so affectedMemoryIds
   * is empty — which let N independent creates each smuggle past the budget as
   * impact=0/1. Instead, every create introduces a NEW entity; two creates about
   * the same entity (same scoped statement, or same scoped task) collapse to one
   * entity key so the batch counts them once. Updates/supersedes return null:
   * their impact is the existing-memory ripple from affectedMemoryIds.
   */
  private newEntityKey(proposal: Proposal): string | null {
    if (proposal.operation !== "create") return null;
    const scope = `${proposal.scope.workspace_id}:${proposal.scope.project_id ?? "-"}`;
    if (proposal.kind === "claim")
      return `claim:${scope}:${this.normalizeStatement(proposal.body.statement)}`;
    if (proposal.kind === "task")
      return `task:${scope}:${proposal.body.title}:${proposal.body.owner_id ?? "-"}`;
    if (proposal.kind === "episode")
      return `episode:${scope}:${proposal.body.trigger}`;
    return `procedure:${scope}:${proposal.body.trigger}`;
  }

  private recordDispute(
    proposal: Proposal,
    proposalDigest: string,
    match: KnowledgeMatch,
  ) {
    if (match.kind !== "conflict_recorded" || !match.memoryId) return;
    const existing = this.db
      .prepare(
        `SELECT mr.body, mr.id AS revision_id FROM memories m
         JOIN memory_revisions mr ON mr.id=m.head_revision_id WHERE m.id=?`,
      )
      .get(match.memoryId) as Row | undefined;
    if (!existing) return;
    const existingBody = JSON.parse(String(existing.body)) as {
      statement?: unknown;
    };
    const proposedSources = this.proposalSourceIds(proposal.proposal_id);
    const existingSources = this.memorySourceIds(String(existing.revision_id));
    this.db
      .prepare(
        `INSERT INTO knowledge_disputes(
           id,workspace_id,topic_key,existing_memory_id,proposed_proposal_digest,
           existing_statement,proposed_statement,existing_source_ids,
           proposed_source_ids,status,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,'recorded',?)`,
      )
      .run(
        randomUUID(),
        proposal.scope.workspace_id,
        this.normalizeStatement(
          typeof (proposal.body as { statement?: string }).statement === "string"
            ? (proposal.body as { statement: string }).statement
            : "",
        ),
        match.memoryId,
        proposalDigest,
        String(existingBody.statement ?? ""),
        String((proposal.body as { statement?: string }).statement ?? ""),
        JSON.stringify([...existingSources]),
        JSON.stringify([...proposedSources]),
        now(),
      );
  }

  /**
   * Problem 5: persist a queryable equivalence between the already-applied memory
   * and the newly-applied equivalent memory, with the combined evidence set. Given
   * either memory id, the relation can be looked up and traced back to fragments.
   */
  private recordEquivalence(
    proposal: Proposal,
    existingMemoryId: string,
    newMemoryId: string,
  ) {
    const [a, b] =
      existingMemoryId < newMemoryId
        ? [existingMemoryId, newMemoryId]
        : [newMemoryId, existingMemoryId];
    const existingHead = this.db
      .prepare(
        "SELECT head_revision_id FROM memories WHERE id=?",
      )
      .get(existingMemoryId) as Row | undefined;
    const evidenceRefs = [
      ...proposal.evidence.map((evidence) => evidence.fragment_revision_id),
      ...(existingHead
        ? this.memoryEvidenceRefs(String(existingHead.head_revision_id))
        : []),
    ];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_equivalences(
           id,workspace_id,memory_id_a,memory_id_b,equivalence_type,
           evidence_refs,created_at
         ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        proposal.scope.workspace_id,
        a,
        b,
        "equivalent",
        JSON.stringify(evidenceRefs),
        now(),
      );
  }

  /** Look up every equivalence relation (and its evidence set) touching a memory. */
  equivalencesOf(memoryId: string) {
    return (
      this.db
        .prepare(
          `SELECT id,memory_id_a,memory_id_b,equivalence_type,evidence_refs,created_at
           FROM memory_equivalences
           WHERE memory_id_a=? OR memory_id_b=?`,
        )
        .all(memoryId, memoryId) as Row[]
    ).map((row) => ({
      id: String(row.id),
      memoryIdA: String(row.memory_id_a),
      memoryIdB: String(row.memory_id_b),
      equivalenceType: String(row.equivalence_type),
      evidenceRefs: JSON.parse(String(row.evidence_refs)) as string[],
      createdAt: String(row.created_at),
    }));
  }

  /**
   * AttentionGate (processing-policy.md §5): deterministic validation failure is
   * the machine's own job and never becomes an owner question. Only conditions
   * that genuinely require an owner choice/authorization AND touch current work
   * or existing important knowledge become `awaiting_decision`. Everything else
   * is kept internally — deferred until used, retained as a searchable source,
   * or ignored as noise — without creating a user-visible decision card.
   */
  private policy(
    proposal: Proposal,
    assessment: AssessmentInput,
    evidenceVerdict: "valid" | "invalid" | "ambiguous",
    impactCount: number,
    gate: { blocksCurrentTask: boolean; targetActive: boolean },
  ): { outcome: PolicyOutcome; reasons: string[] } {
    const reasons: string[] = [];
    if (assessment.semantic_verdict !== "supported")
      reasons.push(`semantic_${assessment.semantic_verdict}`);
    // Resolve an extractor's doubts without deleting them. A supported verdict
    // alone says nothing about whether the remaining doubts affect this proposal.
    const uncertaintyResolved =
      assessment.semantic_verdict === "supported" &&
      assessment.uncertainty_review?.verdict === "non_blocking" &&
      !assessment.missing_context?.length;
    if (proposal.uncertainties.length && !uncertaintyResolved)
      reasons.push("uncertainties_present");
    if (assessment.uncertainty_review?.verdict === "unresolved")
      reasons.push("uncertainties_unresolved");
    if (assessment.missing_context?.length) reasons.push("missing_context");
    if (proposal.evidence.some((evidence) => "asset_hash" in evidence))
      reasons.push("inferred_image_requires_review");
    if (
      proposal.kind === "episode" &&
      proposal.body.outcome === "success" &&
      proposal.body.verification_refs.length === 0
    )
      reasons.push("unverified_success");
    if (!this.actorIsVerifiedOwner(proposal)) reasons.push("owner_not_verified");
    if (
      proposal.kind === "task" &&
      proposal.body.due_expression &&
      !proposal.body.due_at
    )
      reasons.push("due_time_ambiguous");
    if (proposal.kind === "procedure")
      reasons.push("procedure_requires_review");
    if (this.hasCrossSourceUpdate(proposal) && !this.isReviewedAmendment(proposal, assessment))
      reasons.push("cross_source_conflict");
    if (impactCount > (this.options.maxAutoApply ?? 10))
      reasons.push("impact_limit_exceeded");

    // Deterministic evidence failure / the proposal contradicts its own quoted
    // evidence: reject. This is validation work, not an owner decision.
    if (
      evidenceVerdict === "invalid" ||
      assessment.semantic_verdict === "contradicted"
    )
      return { outcome: "reject", reasons };

    // Explicit no-durable-value signal from the extractor/verifier: record but
    // never promote and never disturb the owner.
    if (
      assessment.reason_code === "no_durable_value" ||
      assessment.reason_code === "noise"
    )
      return { outcome: "ignore_noise", reasons };

    // AttentionGate (processing-policy.md §5): an owner question is created ONLY
    // when all four conditions hold:
    //   (a) it touches current work / known commitments / important knowledge,
    //   (b) it is a genuine owner choice (not the machine's own parse/evidence gap),
    //   (c) the allowed deterministic resolution has already been attempted,
    //   (d) we can state why now, the options and the effect of choosing.
    // impact_limit_exceeded is always (a): a change rippling past the auto budget
    // touches many existing objects. An unresolved cross-source disagreement is
    // a genuine choice (b); a separately reviewed amendment is not. Escalate if it
    // either overwrites active important knowledge (targetActive) or blocks the
    // owner's current task (blocksCurrentTask). Otherwise it stays internal.
    const impactEscalates = reasons.includes("impact_limit_exceeded");
    const crossSourceEscalates =
      reasons.includes("cross_source_conflict") &&
      (gate.targetActive || gate.blocksCurrentTask);
    if (impactEscalates || crossSourceEscalates)
      return { outcome: "awaiting_decision", reasons };

    // A cross-source disagreement that does NOT touch active important knowledge and
    // does not block the current task is kept internally (processing-policy.md table:
    // "跨源冲突，但当前无任务依赖"): recorded, searchable, never a user card.
    if (reasons.includes("cross_source_conflict"))
      return { outcome: "defer_until_use", reasons };

    // Someone else's commitment (forwarded / unverified actor) is a source lead,
    // never an owner task and never a "do you want to claim this?" question.
    if (proposal.kind === "task" && reasons.includes("owner_not_verified"))
      return { outcome: "retain_as_source", reasons };

    // Image-based inference and methods that are valuable but not promoted to
    // verified knowledge on their own: keep the material, stay searchable.
    if (
      reasons.includes("inferred_image_requires_review") ||
      reasons.includes("procedure_requires_review")
    )
      return { outcome: "retain_as_source", reasons };

    // Low-value uncertainty (insufficient evidence, unknown scope, ambiguous time
    // on non-blocking material): defer until the material is actually used, when
    // the missing context can be clarified against a concrete question (G10).
    const softUncertainty =
      assessment.semantic_verdict === "insufficient" ||
      assessment.semantic_verdict === "needs_scope" ||
      reasons.includes("uncertainties_present") ||
      reasons.includes("uncertainties_unresolved") ||
      reasons.includes("missing_context") ||
      reasons.includes("due_time_ambiguous") ||
      reasons.includes("unverified_success");
    if (softUncertainty) return { outcome: "defer_until_use", reasons };

    return { outcome: "auto_apply", reasons };
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
          updateRelation: assessment.update_relation ?? null,
          uncertaintyReview: assessment.uncertainty_review ?? null,
          missingContext: assessment.missing_context ?? [],
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
    const stateFor = (outcome: PolicyOutcome): string =>
      outcome === "reject"
        ? "rejected"
        : outcome === "awaiting_decision"
          ? "awaiting_decision"
          : outcome === "defer_until_use"
            ? "deferred"
            : outcome === "retain_as_source"
              ? "retained"
              : outcome === "ignore_noise"
                ? "ignored"
                : "approved";
    this.db
      .prepare(
        "UPDATE proposals SET state=?,policy_result=?,updated_at=? WHERE id=?",
      )
      .run(
        stateFor(outcome),
        JSON.stringify({ outcome, reasons, policyVersion }),
        now(),
        proposal.proposal_id,
      );
  }

  private createDecision(
    proposal: Proposal,
    proposalDigest: string,
    reasons: string[],
  ) {
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
      // v3 AttentionCase: a user-visible question must state the topic/entity, why it
      // is asked now, what was already tried, the concrete options and their effects,
      // and the expected versions — not a generic JSON blob.
      const crossSource = reasons.includes("cross_source_conflict");
      const attentionCase = {
        topic:
          proposal.kind === "claim"
            ? String((proposal.body as { statement?: string }).statement ?? "")
            : proposal.kind,
        linkedTask: proposal.target_id ?? null,
        reasonNow: crossSource
          ? "不同来源对同一既有知识给出不同结论，且已尝试对比双方来源版本仍无法自动裁决。"
          : `本次变更去重后影响 ${reasons.includes("impact_limit_exceeded") ? "多个" : "一个"}现行对象，超出自动应用范围。`,
        evidenceRefs: proposal.evidence.map(
          (evidence) => evidence.fragment_revision_id,
        ),
        attemptedResolution:
          "已核对双方来源的当前 head 与 validity epoch；均为现行版本，无一方已被淘汰，故无法自动合并。",
        question: crossSource
          ? "两条来源对同一事实给出相反结论。这次按哪个来源更新既有知识？"
          : "这次变更影响范围较大，是否按提案应用？",
        options: [
          { label: "按提案更新", effect: "采纳新来源/新结论，生成新记忆修订并保留旧版本。" },
          { label: "保留既有结论", effect: "不更新，把新结论作为竞争来源保留在争议记录中。" },
          { label: "先补充背景", effect: "暂不决定，等待更多来源或上下文后再裁决。" },
        ],
        risk: "错误选择会覆盖或保留错误的现行事实，影响后续基于该知识的回答。",
        expectedVersions,
        defaultAction: "保留既有结论",
        dedupeKey: `attention:${proposal.scope.workspace_id}:${proposal.target_id ?? proposal.proposal_id}`,
      };
      this.db
        .prepare(
          `INSERT INTO decisions(
             id,workspace_id,proposal_digest,expected_versions,owner_binding,
             expires_at,state,request_id,decided_at,action,resolved_at,created_at,
             attention_case,dedupe_key
           ) VALUES(?,?,?,?,?,?,'pending',NULL,NULL,NULL,NULL,?,?,?)`,
        )
        .run(
          id,
          proposal.scope.workspace_id,
          proposalDigest,
          expectedVersionsJson,
          JSON.stringify({ actorId: this.options.ownerId ?? "owner" }),
          expiresAt,
          createdAt,
          JSON.stringify(attentionCase),
          attentionCase.dedupeKey,
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
    const updated = proposal.operation !== "create" && Boolean(proposal.target_id);
    const after = proposal.kind === "task"
      ? [proposal.body.title, proposal.body.next_step ? `下一步：${proposal.body.next_step}` : "",
        proposal.body.due_expression ? `截止时间：${proposal.body.due_expression}` : "",
        proposal.body.follow_up?.waiting_on ? `等待：${proposal.body.follow_up.waiting_on}` : "",
        proposal.body.follow_up?.time_expression ? `检查时间：${proposal.body.follow_up.time_expression}` : ""].filter(Boolean).join("\n")
      : readableMemory(proposal.kind, proposal.body);
    const prior = updated && proposal.kind !== "task" ? this.db.prepare(`SELECT m.kind,r.body FROM memories m
      JOIN memory_revisions r ON r.id=m.head_revision_id WHERE m.id=? AND m.workspace_id=?`)
      .get(proposal.target_id!, proposal.scope.workspace_id) as Row | undefined : undefined;
    const before = prior ? readableMemory(String(prior.kind), JSON.parse(String(prior.body))) : null;
    const heading = proposal.kind === "task" ? proposal.body.title :
      proposal.kind === "claim" ? proposal.body.statement : proposal.body.trigger;
    const notificationTitle = `${proposal.kind === "task" ? updated ? "事项已更新" : "事项已记录" : updated ? "记忆已更新" : "已记下"}：${
      Array.from(heading.replace(/\s+/g, " ").trim()).slice(0, 120).join("")
    }`;
    const notificationBody = [before !== null ? `之前：\n${before}` : "",
      before !== null ? `现在：\n${after}` : after,
      proposal.reason.trim() ? `补充说明：${proposal.reason.trim()}` : ""].filter(Boolean).join("\n\n");
    const metadata = {
      workspaceId: proposal.scope.workspace_id,
      applicationId: `proposal:${proposalDigest}:1`,
      proposalId: proposal.proposal_id,
      proposalDigest,
      generation: 1,
      title: notificationTitle,
      details: notificationBody,
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
            ...(proposal.operation === "create" ? { projectId: proposal.scope.project_id } : {}),
            expectedVersion: proposal.target_id
              ? proposal.expected_versions[proposal.target_id]
              : undefined,
            title: proposal.body.title,
            detail: proposal.reason,
            ownerId: proposal.body.owner_id,
            dueAt: proposal.body.due_at,
            dueExpression: proposal.body.due_expression,
            nextStep: proposal.body.next_step,
            ...(proposal.body.follow_up ? { followUp: proposal.body.follow_up,
              ...(proposal.operation === "create" ? { status: proposal.body.follow_up.waiting_on ? "waiting" as const : "open" as const } : {}) } : {}),
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
    options: {
      impactCount?: number;
      relatedTask?: { blocksNow: boolean } | null;
    } = {},
  ): EvaluationResult {
    const proposal = proposalSchema.parse(proposalInput);
    const assessment = proposalAssessmentInputSchema.parse(assessmentInput);
    return this.evaluateCore(proposal, assessment, options, undefined);
  }

  /**
   * Single-proposal evaluation shared by the public evaluate() API (runtime agent
   * governCreateTask) and by evaluateBatch(). When `batch` is supplied, the whole
   * ChangeSet has already been de-duplicated; if the batch is over its impact budget,
   * any proposal that would otherwise auto-apply is instead parked as
   * awaiting_decision (batchDeferred=true) WITHOUT applying and WITHOUT creating its
   * own card — evaluateBatch raises one consolidated AttentionCase for the batch.
   */
  private evaluateCore(
    proposal: Proposal,
    assessment: AssessmentInput,
    options: {
      impactCount?: number;
      relatedTask?: { blocksNow: boolean } | null;
    },
    batch: { gated: boolean; totalImpact: number } | undefined,
  ): EvaluationResult {
    // G17: never trust a bare impactCount=1 when the change really ripples to
    // other active memories sharing its sources.
    const impactCount = Math.max(
      options.impactCount ?? 1,
      this.computeInternalImpact(proposal),
    );
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
    // F5: before creating a new claim, recall active knowledge. Duplicates link
    // to the existing memory; contradictions are recorded as competing source
    // claims instead of being silently applied or hidden.
    if (
      proposal.operation === "create" &&
      proposal.kind === "claim" &&
      deterministic.verdict === "valid"
    ) {
      const match = this.detectCreateMatch(proposal, assessment);
      if (match)
        return this.handleCreateMatch(
          proposal,
          persisted.digest,
          deterministic.verdict,
          impactCount,
          match,
          batch?.gated ?? false,
        );
    }
    const gate = {
      blocksCurrentTask: options.relatedTask?.blocksNow === true,
      targetActive: this.targetIsActiveKnowledge(proposal),
    };
    let policy = this.policy(
      proposal,
      assessment,
      deterministic.verdict,
      impactCount,
      gate,
    );
    // F: batch gate. The whole ChangeSet's de-duplicated union impact exceeded the
    // auto budget. A proposal that would have auto-applied is parked here; it is
    // NOT applied and gets NO per-proposal decision card (evaluateBatch creates one
    // consolidated AttentionCase). Reject / ignore / defer / retain outcomes are
    // left alone — they never materialize new active state anyway.
    let batchDeferred = false;
    if (batch?.gated && policy.outcome === "auto_apply") {
      policy = {
        outcome: "awaiting_decision",
        reasons: policy.reasons.includes("impact_limit_exceeded")
          ? policy.reasons
          : [...policy.reasons, "impact_limit_exceeded"],
      };
      batchDeferred = true;
    }
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
    if (batchDeferred) result.batchDeferred = true;
    if (policy.outcome === "reject") return result;
    if (policy.outcome === "awaiting_decision") {
      // Batch-parked proposals wait for the single consolidated card; do not create
      // N per-proposal decisions here.
      if (!batchDeferred)
        result.decisionId = this.createDecision(
          proposal,
          persisted.digest,
          policy.reasons,
        );
      return result;
    }
    // defer_until_use / retain_as_source / ignore_noise are internal governance:
    // the material stays searchable as a source, but nothing is applied and no
    // user-facing decision card is created.
    if (policy.outcome !== "auto_apply") return result;
    result.receipt = this.apply(proposal, persisted.digest);
    return result;
  }

  /** Whether the proposal targets an active memory in this workspace — i.e. it
   *  would overwrite existing important knowledge (AttentionGate condition (a)). */
  private targetIsActiveKnowledge(proposal: Proposal): boolean {
    if (!proposal.target_id) return false;
    const target = this.db
      .prepare(
        "SELECT status FROM memories WHERE id=? AND workspace_id=?",
      )
      .get(proposal.target_id, proposal.scope.workspace_id) as Row | undefined;
    return Boolean(target && target.status === "active");
  }

  /**
   * G17 / KnowledgePlan: evaluate a whole ChangeSet in one production pass.
   *
   * The total impact is the de-duplicated UNION of:
   *   - affectedMemoryIds: every active memory an update/supersede touches (target
   *     plus siblings sharing its sources), and
   *   - affectedEntities: the new entity each create would materialize (same scoped
   *     statement/task collapses to one key).
   * 12 creates about the same entity count as impact=1; 12 creates on 12 distinct
   * entities count as impact=12. The gate is decided ONCE over this union before
   * anything is applied, so a batch cannot be smuggled past the budget as N
   * independent impact=0/1 operations.
   *
   * Atomicity: the gate decision is computed first (pure reads + deterministic
   * keys). If the batch is over budget, EVERY would-be-auto-apply proposal is parked
   * as awaiting_decision and NONE is applied; a single consolidated AttentionCase
   * is raised. If under budget, each proposal runs the normal single-entry pipeline
   * (which itself is atomic per proposal) — duplicates within the batch are caught
   * by detectCreateMatch once the first one is applied.
   */
  evaluateBatch(entries: {
    proposal: unknown;
    assessment: unknown;
    options?: {
      impactCount?: number;
      relatedTask?: { blocksNow: boolean } | null;
    };
  }[]): {
    totalImpact: number;
    affectedMemoryIds: string[];
    affectedEntities: string[];
    outcome: PolicyOutcome;
    results: EvaluationResult[];
    decisionId?: string;
  } {
    const parsed = entries.map((entry) => ({
      proposal: proposalSchema.parse(entry.proposal),
      assessment: proposalAssessmentInputSchema.parse(entry.assessment),
      options: entry.options ?? {},
    }));
    // Read-only pass: de-duplicated union impact over the whole ChangeSet.
    const memoryIds = new Set<string>();
    const entityKeys = new Set<string>();
    for (const { proposal } of parsed) {
      for (const id of this.affectedMemoryIds(proposal)) memoryIds.add(id);
      const key = this.newEntityKey(proposal);
      if (key) entityKeys.add(key);
    }
    const totalImpact = memoryIds.size + entityKeys.size;
    const gated = totalImpact > (this.options.maxAutoApply ?? 10);
    const batch = { gated, totalImpact };

    // Decision + (possibly) application pass. Under budget this applies per proposal;
    // over budget it parks every would-be-auto-apply proposal and applies nothing.
    const results: EvaluationResult[] = [];
    const parked: Proposal[] = [];
    for (const { proposal, assessment, options } of parsed) {
      const result = this.evaluateCore(proposal, assessment, options, batch);
      results.push(result);
      if (result.batchDeferred) parked.push(proposal);
    }

    let decisionId: string | undefined;
    if (parked.length)
      decisionId = this.createBatchDecision(parked, totalImpact);
    const outcome: PolicyOutcome = gated
      ? parked.length
        ? "awaiting_decision"
        : "auto_apply"
      : "auto_apply";
    return {
      totalImpact,
      affectedMemoryIds: [...memoryIds].sort(),
      affectedEntities: [...entityKeys].sort(),
      outcome,
      results,
      decisionId,
    };
  }

  /**
   * F: raise ONE consolidated AttentionCase for every proposal parked by the batch
   * impact gate. It carries the full v3 AttentionCase fields — topic, why now, what
   * was already tried (deterministic补证), the concrete options and their effects,
   * evidence refs and a batch-scoped dedupe key — instead of N near-duplicate cards.
   */
  private createBatchDecision(parked: Proposal[], totalImpact: number): string | undefined {
    if (!parked.length) return undefined;
    const representative = parked[0]!;
    const workspaceId = representative.scope.workspace_id;
    const proposalDigests = new Set<string>();
    const evidenceRefs = new Set<string>();
    const topics: string[] = [];
    for (const proposal of parked) {
      const digest = stableDigest(proposal);
      proposalDigests.add(digest);
      for (const evidence of proposal.evidence)
        evidenceRefs.add(evidence.fragment_revision_id);
      topics.push(
        proposal.kind === "claim"
          ? String((proposal.body as { statement?: string }).statement ?? "")
          : proposal.kind,
      );
    }
    // The decision row must JOIN to a real proposal (decisions() reads p.digest),
    // so anchor it to the representative proposal's digest; the batch summary lives
    // inside attention_case.
    const anchorDigest = stableDigest(representative);
    const existing = this.db
      .prepare("SELECT id FROM decisions WHERE workspace_id=? AND proposal_digest=?")
      .get(workspaceId, anchorDigest) as Row | undefined;
    if (existing) return String(existing.id);
    const id = randomUUID();
    const createdAt = now();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const dedupeKey = `attention-batch:${workspaceId}:${stableDigest([...proposalDigests].sort()).slice(0, 40)}`;
    const attentionCase = {
      topic: `批量变更（${parked.length} 条提案）：${topics.slice(0, 3).join("；")}${topics.length > 3 ? " 等" : ""}`,
      linkedTask: representative.target_id ?? null,
      reasonNow: `整份变更去重后共影响 ${totalImpact} 个现行/新对象，超过自动应用上限 ${this.options.maxAutoApply ?? 10}；若逐条自动应用将绕过该预算。`,
      evidenceRefs: [...evidenceRefs],
      attemptedResolution:
        "已对整份 ChangeSet 做去重累计影响合并（受影响记忆并集 + 新实体并集），并逐条核对证据引用与现行来源 head/epoch；无法在不超预算的前提下自动裁决，故升级为一次批量确认。",
      question: `本次一次性带来 ${parked.length} 条变更，去重后影响范围超出自动应用预算。是否整体按提案应用？`,
      options: [
        { label: "整体按提案应用", effect: "一次性应用全部 ${n} 条提案，保留各自证据与来源归属。".replace("${n}", String(parked.length)) },
        { label: "逐条审阅", effect: "暂不整体应用，进入后逐条核对再决定。" },
        { label: "先补充背景", effect: "暂不决定，等待更多来源或上下文后再裁决。" },
      ],
      risk: "错误整体放行会一次性引入大量未经逐条确认的记忆/任务，放大错误知识的影响面。",
      expectedVersions: { sources: {}, target: representative.expected_versions },
      defaultAction: "逐条审阅",
      dedupeKey,
      batchProposalDigests: [...proposalDigests],
    };
    this.db
      .prepare(
        `INSERT INTO decisions(
           id,workspace_id,proposal_digest,expected_versions,owner_binding,
           expires_at,state,request_id,decided_at,action,resolved_at,created_at,
           attention_case,dedupe_key
         ) VALUES(?,?,?,?,?,?,'pending',NULL,NULL,NULL,NULL,?,?,?)`,
      )
      .run(
        id,
        workspaceId,
        anchorDigest,
        JSON.stringify(attentionCase.expectedVersions),
        JSON.stringify({ actorId: this.options.ownerId ?? "owner" }),
        expiresAt,
        createdAt,
        JSON.stringify(attentionCase),
        dedupeKey,
      );
    return id;
  }

  private handleCreateMatch(
    proposal: Proposal,
    proposalDigest: string,
    evidenceVerdict: "valid" | "invalid" | "ambiguous",
    impactCount: number,
    match: KnowledgeMatch,
    gated = false,
  ): EvaluationResult {
    const reasons = [`knowledge_${match.kind}`];
    if (match.kind === "conflict_recorded") {
      this.recordDispute(proposal, proposalDigest, match);
      // Both sides keep their source attribution; neither is auto-applied and no
      // decision card is raised unless the conflict blocks a current task.
      this.persistPolicy(
        proposal,
        proposalDigest,
        "defer_until_use",
        reasons,
        impactCount,
      );
      this.db
        .prepare("UPDATE proposals SET state='disputed',updated_at=? WHERE id=?")
        .run(now(), proposal.proposal_id);
      return {
        proposalId: proposal.proposal_id,
        proposalDigest,
        evidenceVerdict,
        policy: "defer_until_use",
        reasons,
        match,
      };
    }
    if (match.kind === "equivalent_linked" && match.memoryId) {
      // F: when the whole batch is over its impact budget, do not promote a new
      // equivalent memory here either — park it with the batch and let the single
      // consolidated AttentionCase carry the decision.
      if (gated) {
        this.persistPolicy(
          proposal,
          proposalDigest,
          "awaiting_decision",
          [...reasons, "impact_limit_exceeded"],
          impactCount,
        );
        return {
          proposalId: proposal.proposal_id,
          proposalDigest,
          evidenceVerdict,
          policy: "awaiting_decision",
          reasons: [...reasons, "impact_limit_exceeded"],
          match,
          batchDeferred: true,
        };
      }
      // Independent source reaching the same conclusion is corroborating evidence:
      // promote it as its own active memory and persist a queryable equivalence edge
      // so the support set can be recalled for either memory.
      this.persistPolicy(
        proposal,
        proposalDigest,
        "auto_apply",
        reasons,
        impactCount,
      );
      const receipt = this.apply(proposal, proposalDigest);
      this.recordEquivalence(proposal, match.memoryId, receipt.entityId);
      return {
        proposalId: proposal.proposal_id,
        proposalDigest,
        evidenceVerdict,
        policy: "auto_apply",
        reasons,
        receipt,
        match,
      };
    }
    // duplicate restatement (same statement, overlapping source): already known
    // knowledge; do not insert a second active memory and do not ask the owner.
    this.persistPolicy(
      proposal,
      proposalDigest,
      "auto_apply",
      reasons,
      impactCount,
    );
    this.db
      .prepare("UPDATE proposals SET state='retained',updated_at=? WHERE id=?")
      .run(now(), proposal.proposal_id);
    return {
      proposalId: proposal.proposal_id,
      proposalDigest,
      evidenceVerdict,
      policy: "auto_apply",
      reasons,
      match,
    };
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
      attentionCase: row.attention_case
        ? JSON.parse(String(row.attention_case))
        : null,
      dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
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
