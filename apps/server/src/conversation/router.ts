import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableDigest } from "../storage/digest.js";

type Row = Record<string, unknown>;

export type AssistantChannel = "lark_p2p" | "lark_group" | "web";
export type Visibility = "private" | "group";

export type Conversation = {
  id: string;
  workspaceId: string;
  principalId: string;
  channel: AssistantChannel;
  chatId: string;
  threadId: string;
  visibility: Visibility;
  currentGoal: string | null;
  pendingCaseId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TurnStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

/**
 * Per-turn metadata. Persisted as JSON in input_message_refs so the runtime can
 * queue turns, make them idempotent on an external transport event id, and track
 * delivery state without a schema migration owned elsewhere.
 */
export type TurnMessageRefs = {
  transportEventId?: string | null;
  status: TurnStatus;
  error?: string | null;
  [key: string]: unknown;
};

export type ConversationTurn = {
  id: string;
  conversationId: string;
  ordinal: number;
  inputText: string;
  inputMessageRefs: TurnMessageRefs;
  selectedEvidence: unknown;
  toolActions: unknown;
  result: string;
  replyOutboxId: string | null;
  createdAt: string;
};

const now = () => new Date().toISOString();

const rowToConversation = (row: Row): Conversation => ({
  id: String(row.id),
  workspaceId: String(row.workspace_id),
  principalId: String(row.principal_id),
  channel: String(row.channel) as AssistantChannel,
  chatId: String(row.chat_id),
  threadId: row.thread_id == null ? "" : String(row.thread_id),
  visibility: String(row.visibility) as Visibility,
  currentGoal: row.current_goal ? String(row.current_goal) : null,
  pendingCaseId: row.pending_case_id ? String(row.pending_case_id) : null,
  projectId: row.project_id ? String(row.project_id) : null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

/**
 * Owns conversation identity and persistence. The conversation key is
 * principal + channel + chat + thread; project identity is never inferred from
 * chat_id. A conversation may be private (p2p with the bound owner / web) or
 * group (@-mentioned in a group), which bounds evidence visibility.
 *
 * Turns are enqueued first (persisted as `pending`) and only then executed, so
 * a crash/restart leaves an inspectable, recoverable record. A turn id is
 * derived deterministically from the external transport event id when present,
 * making duplicate delivery of the same Lark event a no-op.
 */
export class ConversationRouter {
  constructor(private readonly db: DatabaseSync) {}

  open(input: {
    principalId: string;
    channel: AssistantChannel;
    chatId: string;
    threadId?: string | null;
    visibility: Visibility;
    workspaceId?: string;
  }): Conversation {
    const workspaceId = input.workspaceId ?? "personal";
    const threadId = input.threadId ?? "";
    const existing = this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE workspace_id=? AND principal_id=? AND channel=? AND chat_id=?
           AND COALESCE(thread_id,'')=?`,
      )
      .get(
        workspaceId,
        input.principalId,
        input.channel,
        input.chatId,
        threadId,
      ) as Row | undefined;
    if (existing) return rowToConversation(existing);
    const id = randomUUID();
    const at = now();
    this.db
      .prepare(
        `INSERT INTO conversations(
           id,workspace_id,principal_id,channel,chat_id,thread_id,visibility,
           current_goal,pending_case_id,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)`,
      )
      .run(
        id,
        workspaceId,
        input.principalId,
        input.channel,
        input.chatId,
        threadId,
        input.visibility,
        at,
        at,
      );
    return this.get(id)!;
  }

  get(conversationId: string): Conversation | null {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id=?")
      .get(conversationId) as Row | undefined;
    return row ? rowToConversation(row) : null;
  }

  setGoal(conversationId: string, goal: string | null) {
    this.db
      .prepare(
        "UPDATE conversations SET current_goal=?,updated_at=? WHERE id=?",
      )
      .run(goal, now(), conversationId);
  }

  /** A resolved discussion object, independent of chat identity and permissions. */
  setProject(conversationId: string, projectId: string | null) {
    this.db.prepare("UPDATE conversations SET project_id=?,updated_at=? WHERE id=?")
      .run(projectId, now(), conversationId);
  }

  nextOrdinal(conversationId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(ordinal),0) AS maxOrdinal FROM conversation_turns WHERE conversation_id=?",
      )
      .get(conversationId) as { maxOrdinal: number };
    return Number(row.maxOrdinal) + 1;
  }

  /**
   * Persist a pending turn before any model call. When `transportEventId` is
   * provided the turn id is derived from it, so re-delivering the same event
   * returns the already-persisted turn (`duplicate: true`) instead of running
   * a second turn or issuing a second reply.
   */
  enqueueTurn(input: {
    conversationId: string;
    inputText: string;
    transportEventId?: string | null;
    refs?: Record<string, unknown>;
  }): { turn: ConversationTurn; duplicate: boolean } {
    const id = input.transportEventId
      ? `turn-${stableDigest(input.transportEventId).slice(0, 32)}`
      : randomUUID();
    const existing = this.turn(id);
    if (existing) return { turn: existing, duplicate: true };
    const ordinal = this.nextOrdinal(input.conversationId);
    const at = now();
    const refs: TurnMessageRefs = {
      status: "pending",
      transportEventId: input.transportEventId ?? null,
      ...input.refs,
    };
    this.db
      .prepare(
        `INSERT INTO conversation_turns(
           id,conversation_id,ordinal,input_text,input_message_refs,
           selected_evidence,tool_actions,result,reply_outbox_id,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.conversationId,
        ordinal,
        input.inputText,
        JSON.stringify(refs),
        "[]",
        "[]",
        "",
        null,
        at,
      );
    this.db
      .prepare("UPDATE conversations SET updated_at=? WHERE id=?")
      .run(at, input.conversationId);
    return { turn: this.turn(id)!, duplicate: false };
  }

  /**
   * One-shot direct recording (enqueue + complete). Kept for callers that
   * already have a fully-formed turn result and do not need the async queue.
   */
  recordTurn(input: {
    conversationId: string;
    inputText: string;
    inputMessageRefs?: Record<string, unknown>;
    selectedEvidence: unknown;
    toolActions: unknown;
    result: string;
  }): ConversationTurn {
    const { turn } = this.enqueueTurn({
      conversationId: input.conversationId,
      inputText: input.inputText,
      refs: input.inputMessageRefs,
    });
    return this.completeTurn({
      turnId: turn.id,
      result: input.result,
      selectedEvidence: input.selectedEvidence,
      toolActions: input.toolActions,
    });
  }

  private patchRefs(turnId: string, patch: Partial<TurnMessageRefs>) {
    const turn = this.turn(turnId);
    if (!turn) return;
    const refs: TurnMessageRefs = { ...turn.inputMessageRefs, ...patch };
    this.db
      .prepare("UPDATE conversation_turns SET input_message_refs=? WHERE id=?")
      .run(JSON.stringify(refs), turnId);
  }

  startTurn(turnId: string) {
    this.patchRefs(turnId, { status: "running", error: null });
  }

  /** Human-readable investigation progress; provider reasoning stays private. */
  recordResearch(turnId: string, activity: unknown[]) {
    this.db
      .prepare("UPDATE conversation_turns SET tool_actions=? WHERE id=?")
      .run(JSON.stringify([{ tool: "research", activity }]), turnId);
  }

  completeTurn(input: {
    turnId: string;
    result: string;
    selectedEvidence: unknown;
    toolActions: unknown;
    replyOutboxId?: string | null;
    degraded?: boolean;
  }): ConversationTurn {
    this.patchRefs(input.turnId, {
      status: "done",
      error: null,
      degraded: Boolean(input.degraded),
    });
    this.db
      .prepare(
        `UPDATE conversation_turns
         SET result=?, selected_evidence=?, tool_actions=?, reply_outbox_id=COALESCE(?, reply_outbox_id)
         WHERE id=?`,
      )
      .run(
        input.result,
        JSON.stringify(input.selectedEvidence),
        JSON.stringify(input.toolActions),
        input.replyOutboxId ?? null,
        input.turnId,
      );
    return this.turn(input.turnId)!;
  }

  failTurn(turnId: string, error: string) {
    this.patchRefs(turnId, { status: "failed", error: error.slice(0, 500) });
  }

  /** H-G20: leave a turn pending (e.g. model unavailable) so it can be retried. */
  markPending(turnId: string, error: string) {
    this.patchRefs(turnId, { status: "pending", error: error.slice(0, 500) });
  }

  /**
   * Mark a turn interrupted (a newer message superseded it, or the caller
   * cancelled). No reply body is written and no outbox is attached, so a
   * cancelled turn never produces a notification or a duplicate delivery.
   */
  cancelTurn(turnId: string, reason = "interrupted") {
    this.patchRefs(turnId, { status: "cancelled", error: reason });
  }

  attachOutbox(turnId: string, outboxId: string) {
    this.db
      .prepare("UPDATE conversation_turns SET reply_outbox_id=? WHERE id=?")
      .run(outboxId, turnId);
  }

  turn(turnId: string): ConversationTurn | null {
    const row = this.db
      .prepare("SELECT * FROM conversation_turns WHERE id=?")
      .get(turnId) as Row | undefined;
    return row ? this.rowToTurn(row) : null;
  }

  turns(conversationId: string): ConversationTurn[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM conversation_turns WHERE conversation_id=? ORDER BY ordinal",
        )
        .all(conversationId) as Row[]
    ).map((row) => this.rowToTurn(row));
  }

  /**
   * Recoverable unfinished turns across all conversations (e.g. after restart):
   * anything still pending/running that never reached a terminal state.
   */
  unfinishedTurns(): ConversationTurn[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM conversation_turns
           WHERE input_message_refs LIKE '%"status":"pending"%'
              OR input_message_refs LIKE '%"status":"running"%'
           ORDER BY created_at`,
        )
        .all() as Row[]
    ).map((row) => this.rowToTurn(row));
  }

  private rowToTurn(row: Row): ConversationTurn {
    const refs = JSON.parse(String(row.input_message_refs)) as TurnMessageRefs;
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      ordinal: Number(row.ordinal),
      inputText: String(row.input_text),
      inputMessageRefs: refs,
      selectedEvidence: JSON.parse(String(row.selected_evidence)),
      toolActions: JSON.parse(String(row.tool_actions)),
      result: String(row.result),
      replyOutboxId: row.reply_outbox_id ? String(row.reply_outbox_id) : null,
      createdAt: String(row.created_at),
    };
  }
}
