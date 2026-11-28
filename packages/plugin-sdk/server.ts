import type { ZodType } from "zod";
export type { CommandJudgeCall, CommandVerdict, CredentialApi, CredentialCommand, CredentialContext, CredentialDef, CredentialOutcome } from "./credential.ts";
import type { PluginConnection } from "./objects.ts";

export type CallContext = {
  userId: string;
  spaceId: string;
  signal: AbortSignal;
  connection(provider: string): Promise<PluginConnection | null>;
};
export type WriteContext = CallContext & { idempotencyKey: string };
export type EventType = "item.status" | "item.created" | "review.finished" | "finding.decision" | "finding.resolution" | "finding.thread";
export type PluginEventV1 = {
  v: 1; id: string; type: EventType; at: string;
  entity: { kind: "item" | "run" | "finding"; id: string };
  spaceId: string; actor: { kind: "user" | "agent" | "host"; id?: string };
  data: Record<string, unknown>;
};
export type Subscription = {
  id: string; events: EventType[];
  handle(ctx: CallContext, event: Readonly<PluginEventV1>): Promise<void>;
};
export type ExternalItem = {
  key: string; url: string; title: string; status: string; kind?: "todo" | "watch";
  assignee?: string; parentKey?: string; revision?: string; updatedAt: string; summary?: string;
};
export type ItemProvider = {
  id: string; label: string; statuses: Record<string, "active" | "done" | "cancelled">;
  /** What a subscription's target is, shown beside the box the person types it in: "仓库，写成 owner/repo". */
  targetHint?: string;
  pull(ctx: CallContext, req: { target: string; cursor?: string }): Promise<{ items: ExternalItem[]; cursor?: string; done: boolean }>;
  setStatus?(ctx: WriteContext, req: { key: string; status: string; expectedRevision?: string }): Promise<{ revision?: string; status: string }>;
};
export type MetricProvider = {
  id: string; label: string; querySchema: ZodType;
  collect(ctx: CallContext, req: { metrics: readonly { id: string; query: unknown }[]; from: string; to: string }): Promise<{
    metricId: string; at: string; value: number; dims?: Record<string, string>; source?: string;
  }[]>;
};
export type DiffAnchor = { path: string; line: number; startLine?: number; side: "LEFT" | "RIGHT"; head: string };
export type CommentRef = { id: string; url: string; revision?: string };
export type ThreadState = { state: "open" | "replied" | "resolved" | "outdated"; reply?: { author: string; at: string; summary: string } };
/** An invalid diff position is reported by throwing an Error with code REVIEW_ANCHOR_OUTDATED. */
export type ReviewProvider = {
  id: string; label: string; objectKind: string;
  publish(ctx: WriteContext, req: { objectKey: string; findingId: number; anchor: DiffAnchor; body: string }): Promise<CommentRef>;
  readThread(ctx: CallContext, ref: CommentRef): Promise<ThreadState>;
  resolve?(ctx: WriteContext, ref: CommentRef, note?: string): Promise<ThreadState>;
};
export type RetrievalKind = "chunk" | "page" | "memory";
export type RetrievalRef = { type: RetrievalKind | "source"; id: string; score?: number };
export type Retriever = {
  id: string; label: string;
  search(ctx: CallContext, req: { query: string; spaces: string[]; kinds: RetrievalKind[]; limit: number }): Promise<RetrievalRef[]>;
};
export type Reranker = {
  id: string; label: string;
  score(ctx: CallContext, req: { query: string; candidates: { id: string; text: string }[] }): Promise<number[]>;
};
/** The host supplies texts in the plugin's authorized spaces. Content may leave this machine. */
export type EmbedderProvider = {
  id: string; name: string;
  model: string; dimensions: number;
  maxBatch?: number; maxChars?: number;
  embed(texts: string[], kind: "query" | "passage", signal: AbortSignal): Promise<number[][] | Float32Array[]>;
};
export type SourceDisplay =
  | { kind: "table"; columns: string[]; rowLines: [number, number][] }
  | { kind: "records"; items: { title: string; lines: [number, number] }[] };
export type ParserInput = { name: string; url?: string; mimeType?: string; bytes: Uint8Array };
export type ParsedSource = { title?: string; text: string; meta?: Record<string, string>; display?: SourceDisplay };
export type SourceParser = {
  id: string; label: string;
  match: { extensions?: string[]; mimeTypes?: string[]; urlPatterns?: string[] };
  parse(ctx: CallContext, input: ParserInput): Promise<ParsedSource>;
};
export type WikiPageKind = {
  kind: string; label: string; describe: string; template: string;
  check?(ctx: CallContext, page: { slug: string; title: string; body: string }): Promise<{ line?: number; message: string }[]>;
  upkeep?: { everyDays?: number; onSourcesChanged?: boolean };
};
export type OutletIdentity = { provider: string; subject: string };
export type OutletRecipient = { id: string; identities: OutletIdentity[] };
export type OutNotification = {
  about?: { title: string; link: string };
  user: OutletRecipient; title: string; body: string; link: string | null;
  urgency: "normal" | "urgent" | "silent" | "later"; dedupKey: string;
};
export type OutAsk = OutNotification & {
  kind: string; options: { label: string }[]; fields: Record<string, unknown>[];
  requiresApproval: boolean; allowText: boolean; expiresAt: string | null;
};
export type Notifier = {
  id: string; name: string;
  resolve?(user: OutletRecipient, signal: AbortSignal): Promise<{ ok: boolean; hint?: string }>;
  deliver(n: OutNotification, signal: AbortSignal): Promise<{ ref?: string }>;
  update?(ref: string, n: OutNotification, signal: AbortSignal): Promise<void>;
  ask?(a: OutAsk, signal: AbortSignal): Promise<{ ref?: string }>;
  retract?(ref: string, signal: AbortSignal): Promise<void>;
};
export type OutletAnswer = {
  notifier: string; ref: string; user: OutletIdentity;
  choice?: number; values?: Record<string, unknown>; text?: string; approved?: boolean;
};
export type FlowEvidence = { text: string; link?: string };
export type FlowContext = {
  item: { id: string; title: string; spaceId: string };
  stage: { id: string; name: string; since: string };
  with: unknown;
  materials: { kind: string; ref: string }[];
};
export type FlowProvider = { id: string; name: string; describe: string; params?: Record<string, unknown> };
export type FlowSignal = FlowProvider & {
  check(ctx: FlowContext, signal: AbortSignal): Promise<{ done: boolean; evidence?: FlowEvidence[]; waitingOn?: string; recheckAfterSec?: number }>;
};
export type RunnerResult = { ref: string; status: "running" | "done" | "failed"; summary?: string; evidence?: FlowEvidence[] };
export type StageRunner = FlowProvider & {
  /** Repeat calls with the same key, including after a host restart, must return the same operation. */
  start(ctx: FlowContext & { attempt: number; idempotencyKey: string; settings: Record<string, unknown> }, signal: AbortSignal): Promise<RunnerResult>;
  check?(ref: string, signal: AbortSignal): Promise<RunnerResult>;
  cancel?(ref: string, signal: AbortSignal): Promise<void>;
};
export type GateScope = { flows?: string[]; stages?: string[] };
export type StageGate = {
  id: string; name: string; describe: string; applies?: GateScope;
  review(ctx: Pick<FlowContext, "item" | "stage"> & { result: { summary: string; evidence: FlowEvidence[] }; by: string },
    signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string; evidence?: FlowEvidence[] }>;
};
export type ProcessApi = {
  stageGate(def: StageGate): void;
  stageRunner(def: StageRunner): void;
  flowSignal(def: FlowSignal): void;
  answerAsk(input: OutletAnswer): Promise<void>;
  notifier(def: Notifier): void;
  retriever(def: Retriever): void;
  reranker(def: Reranker): void;
  embedder(def: EmbedderProvider): void;
  sourceParser(def: SourceParser): void;
  wikiPageKind(def: WikiPageKind): void;
  subscribe(def: Subscription): void;
  reviewProvider(def: ReviewProvider): void;
  itemProvider(def: ItemProvider): void;
  metricProvider(def: MetricProvider): void;
};
