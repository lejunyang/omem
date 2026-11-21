import type { ZodType } from "zod";
import type { PluginConnection } from "./objects.ts";

export type CallContext = {
  userId: string;
  spaceId: string;
  signal: AbortSignal;
  connection(provider: string): Promise<PluginConnection | null>;
};
export type WriteContext = CallContext & { idempotencyKey: string };
export type EventType = "item.status" | "item.created" | "review.finished" | "finding.decision" | "finding.resolution";
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
export type ProcessApi = {
  subscribe(def: Subscription): void;
  reviewProvider(def: ReviewProvider): void;
  itemProvider(def: ItemProvider): void;
  metricProvider(def: MetricProvider): void;
};
