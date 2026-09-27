import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableDigest } from "../storage/digest.js";

type Row = Record<string, unknown>;

export type RuntimeRequest = {
  id: string;
  workspaceId: string;
  jobId: string | null;
  sessionId: string;
  turnId: string | null;
  providerRequestId: string;
  kind: "permission" | "elicitation";
  state: "pending" | "denied" | "expired" | "resolved";
  options: unknown;
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
};

const fromRow = (row: Row): RuntimeRequest => ({
  id: String(row.id),
  workspaceId: String(row.workspace_id),
  jobId: row.job_id ? String(row.job_id) : null,
  sessionId: String(row.session_id),
  turnId: row.turn_id ? String(row.turn_id) : null,
  providerRequestId: String(row.provider_request_id),
  kind: String(row.kind) as "permission" | "elicitation",
  state: String(row.state) as RuntimeRequest["state"],
  options: JSON.parse(String(row.options)),
  expiresAt: String(row.expires_at),
  createdAt: String(row.created_at),
  resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
});

export class RuntimeRequestRepository {
  constructor(private readonly db: DatabaseSync) {}

  recordDenied(input: {
    workspaceId: string;
    jobId?: string | null;
    sessionId: string;
    turnId?: string | null;
    providerRequestId: string;
    kind: "permission" | "elicitation";
    options: unknown;
    now?: Date;
    ttlMs?: number;
  }) {
    const now = input.now ?? new Date();
    const payloadDigest = stableDigest({
      kind: input.kind,
      options: input.options,
      turnId: input.turnId ?? null,
    });
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runtime_requests(
           id,workspace_id,job_id,session_id,turn_id,provider_request_id,kind,
           payload_digest,options,state,expires_at,created_at,resolved_at
         ) VALUES(?,?,?,?,?,?,?,?,?,'denied',?,?,?)`,
      )
      .run(
        randomUUID(),
        input.workspaceId,
        input.jobId ?? null,
        input.sessionId,
        input.turnId ?? null,
        input.providerRequestId,
        input.kind,
        payloadDigest,
        JSON.stringify(input.options),
        new Date(now.getTime() + (input.ttlMs ?? 300_000)).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
    const row = this.db
      .prepare(
        "SELECT * FROM runtime_requests WHERE session_id=? AND provider_request_id=?",
      )
      .get(input.sessionId, input.providerRequestId) as Row;
    if (row.payload_digest !== payloadDigest)
      throw Error("RUNTIME_REQUEST_IDEMPOTENCY_CONFLICT");
    return fromRow(row);
  }

  resolve(input: { id: string; action: "approve" | "reject"; now?: Date }) {
    const row = this.db
      .prepare("SELECT * FROM runtime_requests WHERE id=?")
      .get(input.id) as Row | undefined;
    if (!row) throw Error("RUNTIME_REQUEST_NOT_FOUND");
    const request = fromRow(row);
    const now = input.now ?? new Date();
    if (request.state !== "pending" || request.expiresAt <= now.toISOString())
      throw Error("STALE_RUNTIME_REQUEST");
    this.db
      .prepare(
        "UPDATE runtime_requests SET state='resolved',resolved_at=? WHERE id=? AND state='pending'",
      )
      .run(now.toISOString(), input.id);
    return { state: "resolved", action: input.action };
  }

  list(jobId?: string) {
    const rows = jobId
      ? this.db
          .prepare(
            "SELECT * FROM runtime_requests WHERE job_id=? ORDER BY created_at",
          )
          .all(jobId)
      : this.db
          .prepare("SELECT * FROM runtime_requests ORDER BY created_at")
          .all();
    return (rows as Row[]).map(fromRow);
  }
}
