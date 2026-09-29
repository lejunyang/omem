import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  JobAttemptFingerprint,
  JobState,
} from "../../../../packages/contracts/src/index.js";
import { stableDigest } from "../storage/digest.js";

type Row = Record<string, unknown>;

export type JobRecord = {
  id: string;
  workspaceId: string;
  kind: string;
  inputRefs: unknown[];
  inputDigest: string;
  roleVersion: string;
  policyVersion: string;
  state: JobState;
  attempt: number;
  generation: number;
  notBefore: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  cancelRequested: boolean;
  resultRef: string | null;
  maxAttempts: number;
  lastError: string | null;
  errorKind: string | null;
  finishedAt: string | null;
  parentJobId: string | null;
  cause: string;
  createdAt: string;
  updatedAt: string;
};

export type JobAttempt = {
  id: string;
  jobId: string;
  attempt: number;
  generation: number;
  model: string | null;
  effort: string | null;
  promptHash: string;
  skillHash: string;
  toolHash: string;
  fingerprint: string;
  usage: Record<string, unknown>;
  error: string | null;
  errorKind: string | null;
  outcome: string | null;
  startedAt: string;
  endedAt: string | null;
  roleBundleHash: string | null;
  contextHash: string | null;
  outputSchema: string | null;
  sessionId: string | null;
  loadedSkills: unknown[];
  allowedTools: string[];
};

export type RoleOutputRecord = {
  id: string;
  jobId: string;
  attempt: number;
  outputSchema: string;
  outputDigest: string;
  output: unknown;
  trace: Record<string, unknown>;
  createdAt: string;
};

export type JobLease = JobRecord & {
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: string;
  currentAttempt: JobAttempt;
};

export type EnqueueJobInput = {
  workspaceId?: string;
  kind: string;
  inputRefs: unknown[];
  roleVersion: string;
  policyVersion: string;
  notBefore?: string;
  maxAttempts?: number;
  parentJobId?: string | null;
  cause?: string;
};

export type JobFailureKind =
  | "transient"
  | "bad_output"
  | "auth"
  | "config"
  | "permanent"
  | "cancelled";

const iso = (date: Date) => date.toISOString();
const publicError = (message: string) =>
  message
    .replace(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(
      /\b(authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\r\n]+/g, " ")
    .slice(0, 2000);

function fromRow(row: Row): JobRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind),
    inputRefs: JSON.parse(String(row.input_refs)) as unknown[],
    inputDigest: String(row.input_digest),
    roleVersion: String(row.role_version),
    policyVersion: String(row.policy_version),
    state: String(row.state) as JobState,
    attempt: Number(row.attempt),
    generation: Number(row.generation),
    notBefore: String(row.not_before),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseToken: row.lease_token ? String(row.lease_token) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    cancelRequested: Boolean(row.cancel_requested),
    resultRef: row.result_ref ? String(row.result_ref) : null,
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error ? String(row.last_error) : null,
    errorKind: row.error_kind ? String(row.error_kind) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    parentJobId: row.parent_job_id ? String(row.parent_job_id) : null,
    cause: String(row.cause),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function attemptFromRow(row: Row): JobAttempt {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    attempt: Number(row.attempt),
    generation: Number(row.generation),
    model: row.model ? String(row.model) : null,
    effort: row.effort ? String(row.effort) : null,
    promptHash: String(row.prompt_hash),
    skillHash: String(row.skill_hash),
    toolHash: String(row.tool_hash),
    fingerprint: String(row.fingerprint),
    usage: JSON.parse(String(row.usage)) as Record<string, unknown>,
    error: row.error ? String(row.error) : null,
    errorKind: row.error_kind ? String(row.error_kind) : null,
    outcome: row.outcome ? String(row.outcome) : null,
    startedAt: String(row.started_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    roleBundleHash: row.role_bundle_hash ? String(row.role_bundle_hash) : null,
    contextHash: row.context_hash ? String(row.context_hash) : null,
    outputSchema: row.output_schema ? String(row.output_schema) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    loadedSkills: row.loaded_skills
      ? (JSON.parse(String(row.loaded_skills)) as unknown[])
      : [],
    allowedTools: row.allowed_tools
      ? (JSON.parse(String(row.allowed_tools)) as string[])
      : [],
  };
}

export class JobRepository {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enqueue(input: EnqueueJobInput) {
    return this.transaction(() => this.enqueueInCurrentTransaction(input));
  }

  /** Used by capture so evidence and its first durable job commit together. */
  enqueueInCurrentTransaction(input: EnqueueJobInput) {
    const workspaceId = input.workspaceId ?? "personal";
    const inputDigest = stableDigest(input.inputRefs);
    const createdAt = new Date().toISOString();
    const jobId = randomUUID();
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs(
           id,workspace_id,kind,input_refs,input_digest,role_version,policy_version,
           state,attempt,generation,not_before,lease_owner,lease_token,
           lease_expires_at,cancel_requested,result_ref,created_at,updated_at,
           max_attempts,parent_job_id,cause
         ) VALUES(?,?,?,?,?,?,?,'queued',0,1,?,NULL,NULL,NULL,0,NULL,?,?,?,?,?)`,
      )
      .run(
        jobId,
        workspaceId,
        input.kind,
        JSON.stringify(input.inputRefs),
        inputDigest,
        input.roleVersion,
        input.policyVersion,
        input.notBefore ?? createdAt,
        createdAt,
        createdAt,
        input.maxAttempts ?? 5,
        input.parentJobId ?? null,
        input.cause ?? "capture",
      );
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE workspace_id=? AND kind=? AND input_digest=?
         AND role_version=? AND policy_version=?`,
      )
      .get(
        workspaceId,
        input.kind,
        inputDigest,
        input.roleVersion,
        input.policyVersion,
      ) as Row;
    return { job: fromRow(row), duplicate: Number(inserted.changes) === 0 };
  }

  list(workspaceId = "personal", limit = 200): JobRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?",
        )
        .all(workspaceId, Math.max(1, Math.min(limit, 500))) as Row[]
    ).map(fromRow);
  }

  get(jobId: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as
      | Row
      | undefined;
    return row ? fromRow(row) : null;
  }

  attempts(jobId: string): JobAttempt[] {
    return (
      this.db
        .prepare("SELECT * FROM job_attempts WHERE job_id=? ORDER BY attempt")
        .all(jobId) as Row[]
    ).map(attemptFromRow);
  }

  claimNext(input: {
    workerId: string;
    fingerprint: JobAttemptFingerprint;
    now?: Date;
    leaseMs?: number;
    kinds?: string[];
    jobIds?: string[];
  }): JobLease | null {
    const now = input.now ?? new Date();
    const at = iso(now);
    const leaseMs = Math.max(100, input.leaseMs ?? 60_000);
    return this.transaction(() => {
      while (true) {
        const row = this.db
          .prepare(
            `SELECT * FROM jobs
             WHERE cancel_requested=0 ${input.kinds ? `AND kind IN (${input.kinds.map(() => "?").join(",")})` : ""} ${input.jobIds ? `AND id IN (${input.jobIds.map(() => "?").join(",")})` : ""} AND not_before<=? AND
               (state IN ('queued','retry_wait') OR
                (state IN ('leased','running') AND lease_expires_at<=?))
             ORDER BY not_before,created_at LIMIT 1`,
          )
          .get(...(input.kinds ?? []), ...(input.jobIds ?? []), at, at) as Row | undefined;
        if (!row) return null;
        const job = fromRow(row);
        if (job.state === "leased" || job.state === "running")
          this.db
            .prepare(
              `UPDATE job_attempts SET ended_at=?,outcome='lease_expired',
                 error_kind='transient',error='Lease expired before completion'
               WHERE job_id=? AND attempt=? AND ended_at IS NULL`,
            )
            .run(at, job.id, job.attempt);
        const generationAttempts = Number(
          (
            this.db
              .prepare(
                "SELECT count(*) AS count FROM job_attempts WHERE job_id=? AND generation=?",
              )
              .get(job.id, job.generation) as { count: number }
          ).count,
        );
        if (generationAttempts >= job.maxAttempts) {
          this.db
            .prepare(
              `UPDATE jobs SET state='failed',error_kind='attempt_limit',
                 last_error='Attempt limit reached',finished_at=?,updated_at=?,
                 lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
            )
            .run(at, at, job.id);
          continue;
        }
        const leaseToken = randomUUID();
        const leaseExpiresAt = iso(new Date(now.getTime() + leaseMs));
        const attempt = job.attempt + 1;
        const updated = this.db
          .prepare(
            `UPDATE jobs SET state='leased',attempt=?,lease_owner=?,lease_token=?,
               lease_expires_at=?,updated_at=?,last_error=NULL,error_kind=NULL
             WHERE id=? AND generation=? AND cancel_requested=0 AND
               (state IN ('queued','retry_wait') OR lease_expires_at<=?)`,
          )
          .run(
            attempt,
            input.workerId,
            leaseToken,
            leaseExpiresAt,
            at,
            job.id,
            job.generation,
            at,
          );
        if (Number(updated.changes) !== 1) continue;
        const attemptId = randomUUID();
        const fingerprint = stableDigest(input.fingerprint);
        this.db
          .prepare(
            `INSERT INTO job_attempts(
               id,workspace_id,job_id,attempt,generation,model,effort,prompt_hash,
               skill_hash,tool_hash,usage,error,started_at,ended_at,fingerprint,
               error_kind,outcome
             ) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL,?,NULL,NULL)`,
          )
          .run(
            attemptId,
            job.workspaceId,
            job.id,
            attempt,
            job.generation,
            input.fingerprint.model,
            input.fingerprint.effort,
            input.fingerprint.promptHash,
            input.fingerprint.skillHash,
            input.fingerprint.toolHash,
            "{}",
            at,
            fingerprint,
          );
        const claimed = this.get(job.id)!;
        const currentAttempt = attemptFromRow(
          this.db
            .prepare("SELECT * FROM job_attempts WHERE id=?")
            .get(attemptId) as Row,
        );
        return {
          ...claimed,
          leaseOwner: input.workerId,
          leaseToken,
          leaseExpiresAt,
          currentAttempt,
        };
      }
    });
  }

  markRunning(jobId: string, leaseToken: string, now = new Date()) {
    const changed = this.db
      .prepare(
        `UPDATE jobs SET state='running',updated_at=?
         WHERE id=? AND lease_token=? AND state='leased' AND cancel_requested=0
           AND lease_expires_at>?`,
      )
      .run(iso(now), jobId, leaseToken, iso(now));
    if (Number(changed.changes) !== 1) throw Error("STALE_JOB_LEASE");
  }

  heartbeat(
    jobId: string,
    leaseToken: string,
    now = new Date(),
    leaseMs = 60_000,
  ) {
    const expires = iso(new Date(now.getTime() + Math.max(100, leaseMs)));
    const changed = this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at=?,updated_at=?
         WHERE id=? AND lease_token=? AND state IN ('leased','running')
           AND cancel_requested=0`,
      )
      .run(expires, iso(now), jobId, leaseToken);
    if (Number(changed.changes) !== 1) throw Error("STALE_JOB_LEASE");
    return expires;
  }

  recordRuntimeTrace(input: {
    jobId: string;
    leaseToken: string;
    model: string | null;
    effort: string | null;
    promptHash: string;
    skillHash: string;
    toolHash: string;
    fingerprint: string;
    roleBundleHash: string;
    contextHash: string;
    outputSchema: string;
    sessionId: string;
    loadedSkills: unknown[];
    allowedTools: string[];
    usage?: Record<string, unknown>;
  }) {
    const row = this.db
      .prepare("SELECT attempt FROM jobs WHERE id=? AND lease_token=?")
      .get(input.jobId, input.leaseToken) as { attempt: number } | undefined;
    if (!row) throw Error("STALE_JOB_LEASE");
    const changed = this.db
      .prepare(
        `UPDATE job_attempts SET model=?,effort=?,prompt_hash=?,skill_hash=?,
           tool_hash=?,fingerprint=?,role_bundle_hash=?,context_hash=?,
           output_schema=?,session_id=?,loaded_skills=?,allowed_tools=?,usage=?
         WHERE job_id=? AND attempt=? AND ended_at IS NULL`,
      )
      .run(
        input.model,
        input.effort,
        input.promptHash,
        input.skillHash,
        input.toolHash,
        input.fingerprint,
        input.roleBundleHash,
        input.contextHash,
        input.outputSchema,
        input.sessionId,
        JSON.stringify(input.loadedSkills),
        JSON.stringify(input.allowedTools),
        JSON.stringify(input.usage ?? {}),
        input.jobId,
        row.attempt,
      );
    if (Number(changed.changes) !== 1) throw Error("JOB_ATTEMPT_NOT_ACTIVE");
  }

  saveRoleOutput(input: {
    jobId: string;
    leaseToken: string;
    model: string | null;
    effort: string | null;
    promptHash: string;
    skillHash: string;
    toolHash: string;
    fingerprint: string;
    roleBundleHash: string;
    contextHash: string;
    outputSchema: string;
    sessionId: string;
    loadedSkills: unknown[];
    allowedTools: string[];
    usage?: Record<string, unknown>;
    output: unknown;
    trace: unknown;
    now?: Date;
  }) {
    return this.transaction(() => {
      const job = this.db
        .prepare(
          "SELECT workspace_id,attempt FROM jobs WHERE id=? AND lease_token=? AND state='running'",
        )
        .get(input.jobId, input.leaseToken) as
        | { workspace_id: string; attempt: number }
        | undefined;
      if (!job) throw Error("STALE_JOB_LEASE");
      this.recordRuntimeTrace(input);
      const outputDigest = stableDigest(input.output);
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO role_outputs(
             id,workspace_id,job_id,attempt,output_schema,output_digest,
             output_json,trace_json,created_at
           ) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          job.workspace_id,
          input.jobId,
          job.attempt,
          input.outputSchema,
          outputDigest,
          JSON.stringify(input.output),
          JSON.stringify(input.trace),
          iso(input.now ?? new Date()),
        );
      return { id, outputDigest, attempt: job.attempt };
    });
  }

  roleOutputs(jobId: string) {
    return this.db
      .prepare(
        `SELECT id,job_id AS jobId,attempt,output_schema AS outputSchema,
           output_digest AS outputDigest,output_json AS outputJson,
           trace_json AS traceJson,created_at AS createdAt
         FROM role_outputs WHERE job_id=? ORDER BY attempt`,
      )
      .all(jobId);
  }

  roleOutput(outputId: string): RoleOutputRecord | null {
    const row = this.db
      .prepare(
        `SELECT id,job_id,attempt,output_schema,output_digest,
           output_json,trace_json,created_at FROM role_outputs WHERE id=?`,
      )
      .get(outputId) as Row | undefined;
    return row
      ? {
          id: String(row.id),
          jobId: String(row.job_id),
          attempt: Number(row.attempt),
          outputSchema: String(row.output_schema),
          outputDigest: String(row.output_digest),
          output: JSON.parse(String(row.output_json)),
          trace: JSON.parse(String(row.trace_json)) as Record<string, unknown>,
          createdAt: String(row.created_at),
        }
      : null;
  }

  succeed(input: {
    jobId: string;
    leaseToken: string;
    resultRef?: string | null;
    usage?: Record<string, unknown>;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const at = iso(now);
    return this.transaction(() => {
      const job = this.db
        .prepare("SELECT * FROM jobs WHERE id=?")
        .get(input.jobId) as Row | undefined;
      if (
        !job ||
        job.lease_token !== input.leaseToken ||
        !["leased", "running"].includes(String(job.state)) ||
        String(job.lease_expires_at) <= at
      )
        throw Error("STALE_JOB_LEASE");
      if (Boolean(job.cancel_requested)) throw Error("JOB_CANCELLED");
      this.db
        .prepare(
          `UPDATE job_attempts SET ended_at=?,outcome='succeeded',usage=?
           WHERE job_id=? AND attempt=? AND ended_at IS NULL`,
        )
        .run(
          at,
          JSON.stringify(input.usage ?? {}),
          input.jobId,
          Number(job.attempt),
        );
      this.db
        .prepare(
          `UPDATE jobs SET state='succeeded',result_ref=?,finished_at=?,updated_at=?,
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
           WHERE id=?`,
        )
        .run(input.resultRef ?? null, at, at, input.jobId);
      return this.get(input.jobId)!;
    });
  }

  fail(input: {
    jobId: string;
    leaseToken: string;
    kind: JobFailureKind;
    message: string;
    usage?: Record<string, unknown>;
    now?: Date;
    retryBaseMs?: number;
  }) {
    const now = input.now ?? new Date();
    const at = iso(now);
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id=?")
        .get(input.jobId) as Row | undefined;
      if (
        !row ||
        row.lease_token !== input.leaseToken ||
        !["leased", "running"].includes(String(row.state))
      )
        throw Error("STALE_JOB_LEASE");
      const job = fromRow(row);
      const kind = job.cancelRequested ? "cancelled" : input.kind;
      const message = publicError(input.message);
      this.db
        .prepare(
          `UPDATE job_attempts SET ended_at=?,outcome=?,error_kind=?,error=?,usage=?
           WHERE job_id=? AND attempt=? AND ended_at IS NULL`,
        )
        .run(
          at,
          kind === "cancelled" ? "cancelled" : "failed",
          kind,
          message,
          JSON.stringify(input.usage ?? {}),
          input.jobId,
          job.attempt,
        );
      const kindCount = Number(
        (
          this.db
            .prepare(
              `SELECT count(*) AS count FROM job_attempts
               WHERE job_id=? AND generation=? AND error_kind=?`,
            )
            .get(input.jobId, job.generation, kind) as { count: number }
        ).count,
      );
      const generationCount = Number(
        (
          this.db
            .prepare(
              "SELECT count(*) AS count FROM job_attempts WHERE job_id=? AND generation=?",
            )
            .get(input.jobId, job.generation) as { count: number }
        ).count,
      );
      const retryLimit =
        kind === "bad_output" ? 2 : kind === "transient" ? 3 : 0;
      const retry =
        retryLimit > 0 &&
        kindCount < retryLimit &&
        generationCount < job.maxAttempts;
      const next = retry
        ? "retry_wait"
        : kind === "cancelled"
          ? "cancelled"
          : "failed";
      const delay =
        Math.max(0, input.retryBaseMs ?? 1000) *
        2 ** Math.max(0, kindCount - 1);
      const notBefore = retry ? iso(new Date(now.getTime() + delay)) : at;
      this.db
        .prepare(
          `UPDATE jobs SET state=?,not_before=?,last_error=?,error_kind=?,
             finished_at=?,updated_at=?,lease_owner=NULL,lease_token=NULL,
             lease_expires_at=NULL,cancel_requested=CASE WHEN ?='cancelled' THEN 1 ELSE cancel_requested END
           WHERE id=?`,
        )
        .run(
          next,
          notBefore,
          message,
          kind,
          retry ? null : at,
          at,
          next,
          input.jobId,
        );
      return this.get(input.jobId)!;
    });
  }

  private controlResult(
    workspaceId: string,
    requestId: string,
    payloadDigest: string,
  ): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        "SELECT payload_digest,response FROM job_control_requests WHERE workspace_id=? AND request_id=?",
      )
      .get(workspaceId, requestId) as Row | undefined;
    if (!row) return null;
    if (row.payload_digest !== payloadDigest)
      throw Error("JOB_CONTROL_IDEMPOTENCY_CONFLICT");
    return JSON.parse(String(row.response)) as Record<string, unknown>;
  }

  cancel(input: {
    jobId: string;
    expectedGeneration: number;
    requestId: string;
    workspaceId?: string;
    now?: Date;
  }) {
    const workspaceId = input.workspaceId ?? "personal";
    const payloadDigest = stableDigest({
      action: "cancel",
      jobId: input.jobId,
      expectedGeneration: input.expectedGeneration,
    });
    const at = iso(input.now ?? new Date());
    return this.transaction(() => {
      const replay = this.controlResult(
        workspaceId,
        input.requestId,
        payloadDigest,
      );
      if (replay) return replay;
      const job = this.get(input.jobId);
      if (!job || job.workspaceId !== workspaceId) throw Error("JOB_NOT_FOUND");
      if (job.generation !== input.expectedGeneration)
        throw Error("STALE_JOB_GENERATION");
      let response: Record<string, unknown>;
      if (job.state === "succeeded") {
        response = { mode: "compensation_required", state: job.state };
      } else if (["leased", "running"].includes(job.state)) {
        this.db
          .prepare("UPDATE jobs SET cancel_requested=1,updated_at=? WHERE id=?")
          .run(at, job.id);
        response = { mode: "cancelling", state: job.state };
      } else if (
        ["queued", "retry_wait", "awaiting_decision"].includes(job.state)
      ) {
        this.db
          .prepare(
            `UPDATE jobs SET state='cancelled',cancel_requested=1,finished_at=?,updated_at=?
             WHERE id=?`,
          )
          .run(at, at, job.id);
        response = { mode: "cancelled", state: "cancelled" };
      } else {
        response = { mode: "unchanged", state: job.state };
      }
      this.db
        .prepare(
          `INSERT INTO job_control_requests(
             id,workspace_id,job_id,request_id,action,payload_digest,response,created_at
           ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          workspaceId,
          job.id,
          input.requestId,
          "cancel",
          payloadDigest,
          JSON.stringify(response),
          at,
        );
      return response;
    });
  }

  retry(input: {
    jobId: string;
    expectedGeneration: number;
    requestId: string;
    workspaceId?: string;
    now?: Date;
  }) {
    const workspaceId = input.workspaceId ?? "personal";
    const payloadDigest = stableDigest({
      action: "retry",
      jobId: input.jobId,
      expectedGeneration: input.expectedGeneration,
    });
    const at = iso(input.now ?? new Date());
    return this.transaction(() => {
      const replay = this.controlResult(
        workspaceId,
        input.requestId,
        payloadDigest,
      );
      if (replay) return replay;
      const job = this.get(input.jobId);
      if (!job || job.workspaceId !== workspaceId) throw Error("JOB_NOT_FOUND");
      if (job.generation !== input.expectedGeneration)
        throw Error("STALE_JOB_GENERATION");
      if (job.state === "succeeded") throw Error("COMPENSATION_REQUIRED");
      if (!["failed", "cancelled", "awaiting_decision"].includes(job.state))
        throw Error("JOB_NOT_RETRYABLE");
      const generation = job.generation + 1;
      this.db
        .prepare(
          `UPDATE jobs SET state='queued',generation=?,not_before=?,cancel_requested=0,
             result_ref=NULL,last_error=NULL,error_kind=NULL,finished_at=NULL,
             lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
           WHERE id=?`,
        )
        .run(generation, at, at, job.id);
      const response = { state: "queued", generation };
      this.db
        .prepare(
          `INSERT INTO job_control_requests(
             id,workspace_id,job_id,request_id,action,payload_digest,response,created_at
           ) VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          randomUUID(),
          workspaceId,
          job.id,
          input.requestId,
          "retry",
          payloadDigest,
          JSON.stringify(response),
          at,
        );
      return response;
    });
  }
}
