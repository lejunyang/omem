import type { TaskFollowUp } from "../../../packages/contracts/src/task-flow.js";
import type {
  Revision,
  Fragment,
  Change,
  RunEvent,
} from "../../../packages/contracts/src/index";
export type { Revision, Fragment, Change };
export type Source = {
  id: string;
  title: string;
  source: string;
  version: number;
  sourceId: string;
  externalId: string;
  createdAt: string;
};
export type Edge = {
  id: string;
  kind: string;
  targetId: string;
  text: string;
  title: string;
  version: number;
};
export type Evidence = {
  fragment: Fragment;
  revision: Revision;
  outgoing: Edge[];
  backlinks: Edge[];
};
export type Notification = {
  id: string;
  title: string;
  body: string;
  changeId: string | null;
  createdAt: string;
  readAt: string | null;
};
export type Task = {
  id: string;
  title: string;
  detail: string;
  dueAt: string | null;
  evidenceId: string | null;
  status: "open" | "waiting" | "done" | "cancelled";
  followUp?: TaskFollowUp | null;
  version: number;
};
export type Profile = {
  id: string;
  name: string;
  transport: string;
  model?: string;
  effort?: string;
  maxContextChars: number;
};
export type Run = {
  id: string;
  state: "running" | "done" | "error" | "cancelled";
  events: RunEvent[];
  answerId?: string;
};
export type JobAttempt = {
  id: string;
  attempt: number;
  generation: number;
  model: string | null;
  effort: string | null;
  outcome: string | null;
  error: string | null;
  errorKind: string | null;
  startedAt: string;
  endedAt: string | null;
};
export type Job = {
  id: string;
  kind: string;
  inputRefs: Record<string, unknown>[];
  roleVersion: string;
  policyVersion: string;
  state:
    | "queued"
    | "leased"
    | "running"
    | "succeeded"
    | "skipped"
    | "awaiting_decision"
    | "retry_wait"
    | "failed"
    | "cancelled";
  attempt: number;
  generation: number;
  resultRef: string | null;
  lastError: string | null;
  errorKind: string | null;
  finishedAt: string | null;
  cause: string;
  createdAt: string;
  updatedAt: string;
  attempts?: JobAttempt[];
};
export type ProposalEvidence = {
  fragment_revision_id: string;
  source_revision_id: string;
  exact_quote?: string;
  asset_hash?: string;
};
export type Proposal = {
  id: string;
  kind: "task" | "claim" | "episode" | "procedure";
  operation: "create" | "update" | "supersede";
  targetId: string | null;
  body: Record<string, unknown>;
  scope: Record<string, unknown>;
  evidence: ProposalEvidence[];
  uncertainties: string[];
  reason: string;
  origin: { job_id?: string; role_bundle?: string };
  digest: string;
  state: string;
  policyResult: {
    outcome: "auto_apply" | "awaiting_decision" | "reject";
    reasons: string[];
    policyVersion: string;
  } | null;
  impactCount: number;
  assessments: {
    quoteAssetVerdict: string;
    semanticVerdict: string;
    reviewerVersion: string;
    roleVersion: string;
    reasonCode: string;
    details: string;
    createdAt: string;
  }[];
  createdAt: string;
  updatedAt: string;
};
export type Decision = {
  id: string;
  proposalDigest: string;
  expectedVersions: Record<string, unknown>;
  actorId: string;
  expiresAt: string;
  state:
    | "pending"
    | "approved"
    | "rejected"
    | "context_requested"
    | "expired"
    | "stale";
  requestId: string | null;
  action: string | null;
  decidedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  proposal: Proposal;
};
export type NotificationDetail = Notification & {
  changeKind: string | null;
  changeTitle: string | null;
  beforeId: string | null;
  afterId: string | null;
  details: string | null;
  deliveries: {
    id: string;
    channel: string;
    state: string;
    attemptCount: number;
    errorKind: string | null;
    lastError: string | null;
    aggregationMode: "instant" | "window" | "scheduled";
    supersededBy: string | null;
    changeCount: number;
    createdAt: string;
    updatedAt: string;
  }[];
  receipt: {
    id: string;
    proposalId: string | null;
    entityType: string;
    entityId: string;
    entityVersion: number;
    createdAt: string;
  } | null;
  evidenceIds: string[];
};
export type LarkRequestedConfig = {
  source: string;
  appPreset: { name: string; desc: string; avatar?: string | string[] };
  addons: {
    preset: boolean;
    scopes: { tenant: string[]; user: string[] };
    events: { items: { tenant: string[]; user: string[] } };
    callbacks: { items: string[] };
  };
};
export type LarkConnection = {
  id: string;
  appId: string;
  tenantBrand: string | null;
  state: string;
  activeVersion: number | null;
  ownerOpenId: string | null;
  createdAt: string;
  updatedAt: string;
};
export type LarkOnboarding = {
  id: string;
  mode: "new" | "existing";
  requestedAppId: string | null;
  status: string;
  qrUrl: string | null;
  verificationUrl: string | null;
  qrExpiresAt: string | null;
  appId: string | null;
  connectionId: string | null;
  connectionVersion: number | null;
  activeVersion: number | null;
  ownerOpenId: string | null;
  missingCapabilities: string[];
  pairing: {
    id: string;
    expiresAt: string;
    candidateOpenId: string | null;
    candidateChatId: string | null;
    candidateChatType: string | null;
    consumed: boolean;
  } | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
export type ReusableLarkApp = {
  appId: string;
  name: string;
  tenantBrand: "feishu" | "lark";
  source: "botmux";
};
export function headers(): Record<string, string> {
  const token = sessionStorage.getItem("omem-token");
  return token ? { Authorization: "Bearer " + token } : {};
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r.json();
  if (!r.ok) throw Error(value.error || "请求失败");
  return value;
}
