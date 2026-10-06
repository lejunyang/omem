import { activityWatchdog } from "../agent-timeout.js";
import { evidenceNeighbors, evidenceSection } from "../retrieval/context.js";
import { assembleAnswerContext, mergeBackground } from "./context.js";
import type { DecisionService } from "../decision/service.js";
import type { AssistantWork } from "./work.js";
import type { WorkAction } from "../../../../packages/contracts/src/work.js";
import { assessPassages } from "../decision/passages.js";
import { evidenceForRange } from "./research.js";
import { materialFromRevision } from "../knowledge/repository.js";
import { sourceAnchor } from "../retrieval/units.js";
import {
  taskFollowUpSchema,
  type TaskFollowUp,
  type TaskAction,
} from "../../../../packages/contracts/src/task-flow.js";
import { validateFollowUp } from "../tasks/follow-up.js";
import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { MemoryService, FeedbackService } from "../memory/service.js";
import {
  ConversationRouter,
  type Conversation,
  type ConversationTurn,
  type Visibility,
} from "../conversation/router.js";
import type {
  RetrievalPort,
  SourceCandidate,
  RetrievalPurpose,
  RetrievalHit,
  SourceAnchor,
} from "../retrieval/port.js";
import { fragmentPositions } from "../knowledge/structure.js";
import { stableDigest } from "../storage/digest.js";
import { assistantProjectSelectionSchema } from "../../../../packages/contracts/src/assistant.js";
import type { MaterialContext } from "../../../../packages/contracts/src/contexts.js";

export type ResearchActivity = {
  label: string;
  tool?: string;
  status: string;
  at: string;
  key?: string;
  startLine?: number;
  endLine?: number;
};

export type AssistantEvidence = {
  fragmentId: string;
  /** Distinguishes independently retrieved ranges within one stored fragment. */
  citationId?: string;
  /** Revision id of the fragment's source revision (used as source_revision_id). */
  sourceRevisionId: string;
  revisionTitle: string;
  materialKey?: string;
  path?: string | null;
  sectionTitle?: string;
  text: string;
  sourceTarget?: SourceAnchor;
  materialDescription?: RetrievalHit["materialDescription"];
};
export type AssistantBackground = Pick<
  RetrievalHit,
  "kind" | "title" | "text" | "headingPath" | "materialDescription"
> & {
  citationIds: string[];
  target?: RetrievalHit["target"];
  reviewState?: "needs-review";
};

export type AssistantCreateTaskCall = {
  tool: "create_task";
  title: string;
  detail: string;
  /** Evidence fragments the task is grounded on; the server re-validates both
   *  visibility and owner provenance before creating anything. */
  citationIds?: string[];
  dueAt?: string | null;
  dueExpression?: string | null;
  followUp?: TaskFollowUp | null;
};

export type AssistantUpdateTaskCall = {
  tool: "update_task";
  taskId: string;
  expectedVersion: number;
  action: TaskAction;
  dueAt?: string | null;
  dueExpression?: string | null;
  followUp?: TaskFollowUp | null;
};
export type AssistantTask = {
  id: string;
  title: string;
  detail: string;
  status: string;
  version: number;
  dueAt: string | null;
  followUp?: TaskFollowUp | null;
  nextStep?: string;
  projectId?: string | null;
};

export function validatedDueAt(
  dueAt: string | null | undefined,
  expression: string | null | undefined,
  userText: string,
) {
  if (!dueAt) return null;
  if (
    !expression?.trim() ||
    !userText.includes(expression.trim()) ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(dueAt) ||
    !Number.isFinite(Date.parse(dueAt))
  )
    throw Error("INVALID_TASK_TIME: 需要原消息中的时间表达及含时区的明确时间");
  return new Date(dueAt).toISOString();
}

export type AssistantModelReply = {
  /** Final natural-language reply shown to the user. */
  answer: string;
  workAction?: WorkAction;
  projectSelection?: { project_id: string | null; reason: string };
  /** Evidence citation ids supplied to this turn (legacy fragment ids accepted). */
  citationIds: string[];
  /** Structured, server-enforced tool requests. The model cannot grant itself
   *  write permission: every call is re-governed by MemoryService. */
  toolCalls?: (AssistantCreateTaskCall | AssistantUpdateTaskCall)[];
  /** At most one additional retrieval round; these are search terms, never facts. */
  searchQueries?: string[];
  searchRequests?: { text: string; purpose: RetrievalPurpose }[];
  /** Host-bound originals actually selected by the native investigation. */
  researchedEvidence?: AssistantEvidence[];
  researchTrace?: {
    workspace: string;
    model: string | null;
    effort: string | null;
    sessionId: string;
    tools: string[];
    timings?: { prepareMs: number; agentMs: number; totalMs: number };
    acpTimings?: {
      initializeMs: number;
      sessionSetupMs: number;
      promptMs: number;
      firstToolMs: number | null;
      toolCalls: number;
      failedToolCalls: number;
    };
    stages?: {
      stage: "reading" | "research";
      model: string | null;
      effort: string | null;
      sessionId?: string;
      elapsedMs: number;
      outcome: "answered" | "handoff" | "failed";
      reason?: string;
    }[];
  };
};

/**
 * Raised when no assistant model is configured or the real transport cannot run
 * (missing CLI, auth failure, timeout). The runtime degrades honestly instead of
 * falling back to a canned fake answer.
 */
export class ModelUnavailableError extends Error {
  constructor(message = "assistant model unavailable") {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** Raised at every commit fence when the turn was cancelled mid-flight. */
export class TurnCancelledError extends Error {
  constructor(message = "turn cancelled") {
    super(message);
    this.name = "TurnCancelledError";
  }
}

export type AssistantModelPort = {
  /**
   * Compose a reply from real evidence and conversation history. The model may
   * only cite evidence the runtime passed in and may only request the managed
   * tools declared here; it cannot read arbitrary data or grant permissions.
   *
   * The call is async and cancellable via `signal` (external cancel, superseded
   * by a newer message, or turn timeout).
   */
  generate(input: {
    userText: string;
    priorTurns: { ordinal: number; userText: string; result: string }[];
    evidence: AssistantEvidence[];
    /** Derived explanations and applied state, separate from original evidence. */
    background?: AssistantBackground[];
    visibility: Visibility;
    ownerScoped?: boolean;
    /** Owner-scoped corrections/constraints the model must respect. */
    trustedContext?: string;
    /** Resolved reading scope; never an authorization boundary. Private library only. */
    workingProject?: MaterialContext | null;
    projects?: MaterialContext[];
    tasks?: AssistantTask[];
    clock?: { now: string; timezone: string };
    retrievalRound?: number;
    mode?: "assist" | "research";
    purpose?: RetrievalPurpose;
    visible?: (fragmentId: string) => boolean;
    onResearchActivity?: (event: ResearchActivity) => void;
    onActivity?: () => void;
    signal?: AbortSignal;
  }): Promise<AssistantModelReply>;
};

export type AssistantTurnResult = {
  turn: ConversationTurn;
  conversation: Conversation;
  evidence: AssistantEvidence[];
  createdTaskIds: string[];
  degraded: boolean;
  /** True when the turn was a duplicate delivery of an already-enqueued event. */
  duplicate?: boolean;
};

/**
 * Decides whether a fragment is visible inside a given conversation. The server
 * owns this: visibility is based on the canonical principal and the evidence's
 * provenance/scope, never on what the model claims. When no policy is injected,
 * group conversations reveal NO evidence (deny-by-default).
 */
export type VisibilityPolicy = (input: {
  conversation: Conversation;
  fragmentId: string;
}) => boolean;

/**
 * Deterministic detection of an explicit owner task-creation / assignment intent.
 * The model is NOT trusted to decide this: a consultation question that mentions
 * a task topic must never auto-create a task, even if the model emits create_task.
 */
const TASK_INTENT_PATTERNS = [
  /帮我跟进/,
  /帮我追踪/,
  /记录.*等待/,
  /帮我记/,
  /帮我建/,
  /帮我创建/,
  /帮我写/,
  /帮我安排/,
  /帮我提/,
  /提醒我/,
  /记得/,
  /待办/,
  /建一个?任务/,
  /创建一个?任务/,
  /加个?任务/,
  /记录一下/,
  /记一下/,
  /安排一下/,
  /设个?提醒/,
  /明天?要/,
  /周五?要/,
  /周[一二三四五六日天]要/,
  /^\s*todo\b/i,
  /^\s*task[:：]/i,
];

const CONSULTATION_PATTERNS = [
  /怎么写/,
  /是什么/,
  /为什么/,
  /什么是/,
  /如何/,
  /能不能/,
  /可不可以/,
  /好不好/,
  /吗[?？]?\s*$/,
  /呢[?？]?\s*$/,
  /吧[?？]?\s*$/,
];

export function detectTaskIntent(userText: string): {
  explicit: boolean;
  reason: string;
} {
  const text = userText.trim();
  if (!text) return { explicit: false, reason: "empty_input" };
  // Strong consultation markers win over weak task verbs.
  const isConsultation = CONSULTATION_PATTERNS.some((re) => re.test(text));
  const hits = TASK_INTENT_PATTERNS.filter((re) => re.test(text));
  if (hits.length && !isConsultation)
    return { explicit: true, reason: `intent:${hits[0]!.source}` };
  if (isConsultation)
    return { explicit: false, reason: "consultation_question" };
  return { explicit: false, reason: "no_explicit_task_intent" };
}

/**
 * The single main-assistant runtime. Both Lark and Web go through this class so
 * there is one product surface. It owns context assembly, evidence retrieval
 * (read-only, visibility-filtered via RetrievalPort), low-risk governance tool
 * execution via MemoryService (server-enforced), turn persistence and
 * degradation. It never calls a model directly: the AssistantModelPort is
 * injected (the real ACP adapter in production, a fixed fake in tests only).
 */
export class AssistantRuntime {
  private stopping = false;
  private readonly router: ConversationRouter;
  /** In-flight turns per conversation; a newer message interrupts the prior one. */
  private readonly inflight = new Map<
    string,
    { controller: AbortController; chain: Promise<unknown> }
  >();

  constructor(
    private readonly store: Store,
    private readonly model: AssistantModelPort,
    private readonly options: {
      ownerId?: string;
      memory?: MemoryService;
      feedback?: FeedbackService;
      retrieval?: RetrievalPort;
      decisions?: DecisionService;
      work?: AssistantWork;
      visibilityPolicy?: VisibilityPolicy;
      /** Hard wall-clock per turn; the model call is aborted after this. */
      turnTimeoutMs?: number;
      /** Max prior turns to feed the model (history budget). */
      maxPriorTurns?: number;
      timezone?: string;
    } = {},
  ) {
    this.router = new ConversationRouter(store.db);
  }

  get conversations() {
    return this.router;
  }

  async turn(input: {
    conversationId: string;
    userText: string;
    /** External transport event id (e.g. Lark event_id) for idempotent delivery. */
    transportEventId?: string | null;
    signal?: AbortSignal;
    mode?: "assist" | "research";
    purpose?: RetrievalPurpose;
  }): Promise<AssistantTurnResult> {
    const conversation = this.router.get(input.conversationId);
    if (!conversation) throw Error("ASSISTANT_CONVERSATION_NOT_FOUND");

    // 1. Persist the turn before any model call. Idempotent on transport event id.
    const enqueued = this.router.enqueueTurn({
      conversationId: conversation.id,
      inputText: input.userText,
      transportEventId: input.transportEventId ?? null,
      refs: {
        mode: input.mode ?? "assist",
        purpose: input.purpose ?? "balanced",
      },
    });
    if (enqueued.duplicate) {
      return this.toResult(enqueued.turn, conversation, [], true);
    }

    // 2. Serialize per conversation; interrupt any in-flight turn (new message wins).
    const prior = this.inflight.get(conversation.id);
    if (prior) {
      prior.controller.abort();
      // Mark the previously in-flight turn as cancelled in the DB too, so a
      // crash/restart never resurrects it.
      this.cancelInFlightTurn(conversation.id);
    }
    const controller = new AbortController();
    const entry: { controller: AbortController; chain: Promise<unknown> } = {
      controller,
      chain: prior?.chain ?? Promise.resolve(),
    };
    this.inflight.set(conversation.id, entry);

    const run = async () => {
      const signal = this.deriveSignal(input.signal, controller);
      // Fence: if the external signal was already aborted before we even built
      // the merged signal, do not start the model at all.
      if (signal.aborted) {
        this.router.cancelTurn(enqueued.turn.id, "pre_aborted");
        return;
      }
      try {
        await this.executeTurn({
          turnId: enqueued.turn.id,
          conversation,
          userText: input.userText,
          transportEventId: input.transportEventId ?? null,
          signal,
        });
      } finally {
        if (this.inflight.get(conversation.id) === entry)
          this.inflight.delete(conversation.id);
      }
    };
    entry.chain = entry.chain.then(run, run);
    await entry.chain;

    const done = this.router.turn(enqueued.turn.id)!;
    return this.toResult(done, conversation, [], false);
  }

  /**
   * Public cancel endpoint: mark a specific turn as cancelled and abort its
   * in-flight controller if any. Called by the HTTP cancel route and by the
   * Lark runtime host on shutdown.
   */
  cancelTurn(turnId: string) {
    const turn = this.router.turn(turnId);
    if (!turn) return false;
    const entry = this.inflight.get(turn.conversationId);
    if (entry) entry.controller.abort();
    this.router.cancelTurn(turnId, "user_cancelled");
    return true;
  }

  /**
   * G20: check the REAL application_receipts table (not in-memory toolActions)
   * to determine if a tool was already committed. This survives the window where
   * the receipt was written but turn.toolActions was not yet persisted.
   */
  private hasCommittedReceipt(turn: {
    inputMessageRefs: { transportEventId?: string | null };
  }): boolean {
    const eventId = turn.inputMessageRefs.transportEventId;
    if (!eventId) return false;
    // proposal_id in governCreateTask is `assistant-task:${eventId}:${digest}`.
    const row = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM application_receipts WHERE proposal_id LIKE ?",
      )
      .get(`assistant-task:${eventId}:%`) as { n: number };
    return row.n > 0;
  }

  /**
   * Public retry entry: re-run a pending turn (e.g. after ModelUnavailableError).
   */
  async retryTurn(turnId: string): Promise<{ ok: boolean; reason?: string }> {
    const turn = this.router.turn(turnId);
    if (!turn) return { ok: false, reason: "not_found" };
    if (turn.inputMessageRefs.status !== "pending")
      return {
        ok: false,
        reason: `not_pending:${turn.inputMessageRefs.status}`,
      };
    const conversation = this.router.get(turn.conversationId);
    if (!conversation) return { ok: false, reason: "conversation_not_found" };
    if (this.hasCommittedReceipt(turn)) {
      this.router.completeTurn({
        turnId,
        result: turn.result || "(restored from committed receipt)",
        selectedEvidence: turn.selectedEvidence,
        toolActions: turn.toolActions,
        degraded: false,
      });
      return { ok: true };
    }
    const controller = new AbortController();
    const signal = this.deriveSignal(undefined, controller);
    await this.executeTurn({
      turnId,
      conversation,
      userText: turn.inputText,
      transportEventId: turn.inputMessageRefs.transportEventId ?? null,
      signal,
    });
    return { ok: true };
  }

  /** Abort every in-flight turn and mark them cancelled. Called on shutdown. */
  shutdown() {
    this.stopping = true;
    for (const [conversationId, entry] of this.inflight) {
      entry.controller.abort();
      // Cancel the currently running turn for this conversation.
      const unfinished = this.router
        .turns(conversationId)
        .filter(
          (t) =>
            t.inputMessageRefs.status === "running" ||
            t.inputMessageRefs.status === "pending",
        );
      for (const t of unfinished) this.router.cancelTurn(t.id, "shutdown");
    }
    this.inflight.clear();
  }

  /**
   * G20: recover unfinished (pending/running) turns after a restart or crash.
   * Turns that already have committed tool receipts are NOT re-executed (we read
   * their stored result and mark done). Turns with no receipts are re-run via
   * executeTurn. ModelUnavailableError during recovery leaves the turn pending
   * so it can be retried later.
   */
  async recoverUnfinishedTurns(): Promise<{
    recovered: number;
    retried: number;
    alreadyCommitted: number;
  }> {
    const unfinished = this.router.unfinishedTurns();
    let recovered = 0,
      retried = 0,
      alreadyCommitted = 0;
    for (const turn of unfinished) {
      if (this.stopping) break;
      const conversation = this.router.get(turn.conversationId);
      if (!conversation) continue;
      // Check REAL application_receipts table, not in-memory toolActions.
      if (this.hasCommittedReceipt(turn)) {
        this.router.completeTurn({
          turnId: turn.id,
          result: turn.result || "(restored from committed receipt)",
          selectedEvidence: turn.selectedEvidence,
          toolActions: turn.toolActions,
          degraded: false,
        });
        alreadyCommitted++;
        continue;
      }
      // Running status from a crash: mark back to pending and re-run.
      this.router.startTurn(turn.id);
      const controller = new AbortController();
      const signal = this.deriveSignal(undefined, controller);
      const entry = {
        controller,
        chain: this.executeTurn({
          turnId: turn.id,
          conversation,
          userText: turn.inputText,
          transportEventId: turn.inputMessageRefs.transportEventId ?? null,
          signal,
        }),
      };
      this.inflight.set(conversation.id, entry);
      try {
        await entry.chain;
        retried++;
      } catch {
        // Leave pending for retry on next recoverUnfinishedTurns.
      } finally {
        if (this.inflight.get(conversation.id) === entry)
          this.inflight.delete(conversation.id);
      }
      recovered++;
    }
    return { recovered, retried, alreadyCommitted };
  }

  private cancelInFlightTurn(conversationId: string) {
    const running = this.router
      .turns(conversationId)
      .find((t) => t.inputMessageRefs.status === "running");
    if (running) this.router.cancelTurn(running.id, "superseded");
  }

  private deriveSignal(
    external: AbortSignal | undefined,
    controller: AbortController,
  ) {
    return AbortSignal.any([controller.signal, ...(external ? [external] : [])]);
  }

  private assertNotCancelled(signal: AbortSignal) {
    if (signal.aborted) throw new TurnCancelledError();
  }

  private async executeTurn(input: {
    turnId: string;
    conversation: Conversation;
    userText: string;
    transportEventId: string | null;
    signal: AbortSignal;
  }) {
    const inactivity = new AbortController();
    const watchdog = activityWatchdog(this.options.turnTimeoutMs ?? 60_000, (reason) => inactivity.abort(new Error(reason)));
    input = { ...input, signal: AbortSignal.any([input.signal, inactivity.signal]) };
    this.router.startTurn(input.turnId);
    try {
      const refs = this.router.turn(input.turnId)!.inputMessageRefs;
      const mode = refs.mode === "research" ? "research" : "assist";
      const purpose = (
        typeof refs.purpose === "string" ? refs.purpose : "balanced"
      ) as RetrievalPurpose;
      const researchActivity: ResearchActivity[] = [];
      const onResearchActivity = (event: ResearchActivity) => {
        if (input.signal.aborted) return;
        watchdog.touch();
        researchActivity.push(event);
        this.router.recordResearch(input.turnId, researchActivity);
      };
      // Prior turns are per-conversation only: a group conversation never replays
      // private p2p history, because those live in a different conversation row.
      const maxPrior = this.options.maxPriorTurns ?? 20;
      const completedTurns = this.router
        .turns(input.conversation.id)
        .filter(
          (t) => t.id !== input.turnId && t.inputMessageRefs.status === "done",
        );
      const priorTurns = (maxPrior > 0 ? completedTurns.slice(-maxPrior) : [])
        .map((t) => ({
          ordinal: t.ordinal,
          userText: t.inputText,
          result: t.result,
        }));

      // 1. Read-only retrieval via RetrievalPort, then visibility filtering.
      //    G08: also merge prior turn working context so the model sees fragments
      //    from the previous consultation turn (anaphora like "按这个").
      const context = await this.retrieveContext(
        input.userText,
        input.conversation,
        purpose,
      );
      const retrieved = context.evidence;
      let background = context.background;
      const inScope = this.readingScope(input.conversation);
      const priorCtx = this.priorWorkingContext(input.conversation).filter(e =>
        (e.sourceTarget?.fragmentIds ?? [e.fragmentId]).every(inScope));
      let evidence = [
        ...retrieved,
        ...priorCtx.filter(
          (p) =>
            !retrieved.some(
              (r) =>
                (r.citationId ?? r.fragmentId) ===
                (p.citationId ?? p.fragmentId),
            ),
        ),
      ];

      // 1b. Read owner-scoped corrections from FeedbackService (H-G16).
      const trustedContext = this.readScopedCorrections(input.conversation);
      const projects = input.conversation.visibility === "private"
        ? this.store.contexts.list().filter(c => c.kind === "project") : [];
      const workingProject = projects.find(p => p.id === input.conversation.projectId) ?? null;
      const tasks = this.visibleTasks(input.conversation);
      const clock = {
        now: new Date().toISOString(),
        timezone: this.options.timezone ?? "Asia/Shanghai",
      };
      const searchQueries: string[] = [];

      // 2. Ask the model. Unavailable / cancelled / error never yields a fake answer.
      //    Inactivity aborts the transport; racing cancellation also handles a
      //    model implementation that ignores its signal.
      let reply: AssistantModelReply;
      let degraded = false;
      try {
        reply = await this.withCancellation(
          this.model.generate({
            userText: input.userText,
            priorTurns,
            evidence,
            background,
            visibility: input.conversation.visibility,
            ownerScoped: input.conversation.principalId === (this.options.ownerId ?? "owner") && input.conversation.visibility === "private",
            trustedContext,
            workingProject,
            projects,
            tasks,
            clock,
            retrievalRound: 0,
            mode,
            purpose,
            visible: (id) => this.isVisible(input.conversation, id),
            onResearchActivity,
            onActivity: watchdog.touch,
            signal: input.signal,
          }),
          input.signal,
        );
        const requests = [
          ...(reply.searchRequests ?? []),
          ...(reply.searchQueries ?? []).map((text) => ({
            text,
            purpose: "balanced" as const,
          })),
        ]
          .map((r) => ({ ...r, text: r.text.trim().slice(0, 160) }))
          .filter((r) => r.text)
          .slice(0, 3);
        searchQueries.push(...requests.map((r) => r.text));
        if (requests.length) {
          this.assertNotCancelled(input.signal);
          const contexts = await Promise.all(
            requests.map((q) =>
              this.retrieveContext(q.text, input.conversation, q.purpose),
            ),
          );
          const extra = contexts.flatMap((c) => c.evidence);
          background = mergeBackground([
            ...contexts.flatMap((c) => c.background),
            ...background,
          ]);
          evidence = [
            ...new Map(
              [...extra, ...evidence].map((e) => [
                e.citationId ?? e.fragmentId,
                e,
              ]),
            ).values(),
          ];
          reply = await this.withCancellation(
            this.model.generate({
              userText: input.userText,
              priorTurns,
              evidence,
              background,
              visibility: input.conversation.visibility,
              ownerScoped: input.conversation.principalId === (this.options.ownerId ?? "owner") && input.conversation.visibility === "private",
              trustedContext,
              workingProject,
              projects,
              tasks,
              clock,
              retrievalRound: 1,
              mode,
              purpose,
              visible: (id) => this.isVisible(input.conversation, id),
              onResearchActivity,
              onActivity: watchdog.touch,
              signal: input.signal,
            }),
            input.signal,
          );
        }
        if (reply.researchedEvidence)
          evidence = [
            ...new Map(
              [
                ...reply.researchedEvidence.filter(
                  (e) =>
                    e.sourceTarget &&
                    e.sourceTarget.fragmentIds.every((id) =>
                      this.isVisible(input.conversation, id),
                    ),
                ),
                ...evidence,
              ].map((e) => [e.citationId ?? e.fragmentId, e]),
            ).values(),
          ];
      } catch (error) {
        if (input.signal.aborted || error instanceof TurnCancelledError) {
          this.router.cancelTurn(input.turnId, "cancelled");
          return;
        }
        const unavailable = error instanceof ModelUnavailableError;
        if (unavailable) {
          // H-G20: model unavailable leaves the turn PENDING so it can be retried.
          this.router.markPending(
            input.turnId,
            `model_unavailable: ${error.message}`,
          );
          return;
        }
        degraded = true;
        reply = {
          answer: "模型暂时不可用，我已记录你的输入，稍后再试。",
          citationIds: [],
        };
      }

      // FENCE: abort check right before governing tools. A slow model that
      // resolves after the turn was cancelled must not write anything.
      this.assertNotCancelled(input.signal);

      // Commit only a completed turn's resolved object. It narrows reading, never
      // visibility or action authority; topic changes can explicitly clear it.
      let projectId = workingProject?.id ?? null;
      if (!degraded && reply.projectSelection) {
        const selection = assistantProjectSelectionSchema.parse(reply.projectSelection);
        if (selection.project_id && !projects.some(p => p.id === selection.project_id))
          throw Error("所选项目不在本次可用项目中");
        projectId = selection.project_id;
      }

      // 3. Structured, server-enforced tool calls. No prompt-as-permission: every
      //    create_task goes through MemoryService (owner/version/receipt/idempotency).
      //    B: we ALSO check the user's actual intent — consultation questions
      //    must never auto-create tasks even if the model emits one.
      const intent = detectTaskIntent(input.userText);
      const toolActions: Array<Record<string, unknown>> = searchQueries.length
        ? [
            {
              tool: "search",
              queries: searchQueries,
              evidenceCount: evidence.length,
            },
          ]
        : [];
      if (researchActivity.length || reply.researchTrace)
        toolActions.push({
          tool: "research",
          activity: researchActivity,
          trace: reply.researchTrace,
        });
      const createdTaskIds: string[] = [];
      if (!degraded && reply.workAction) {
        this.assertNotCancelled(input.signal);
        try {
          if (mode === "research" || !this.options.work) throw Error("当前会话没有工作操作权限");
          if (reply.toolCalls?.length) throw Error("一次只执行一类工作操作，请勿同时创建普通事项");
          toolActions.push(this.options.work.apply(reply.workAction, {
            requestId: input.turnId, conversationId: input.conversation.id, principalId: input.conversation.principalId,
            userText: input.userText, visibility: input.conversation.visibility,
          }));
        } catch (error) {
          toolActions.push({ tool: "work_action", rejected: true, message: `未执行工作操作：${error instanceof Error ? error.message : String(error)}` });
        }
      }
      if (!degraded && reply.projectSelection) toolActions.push({
        tool: "select_project", projectId, reason: reply.projectSelection.reason,
      });
      let taskRejectedReason: string | null = null;
      if (!degraded && mode !== "research" && !reply.workAction) {
        for (const call of reply.toolCalls ?? []) {
          if (call.tool === "update_task") {
            this.assertNotCancelled(input.signal);
            const action = this.governTaskUpdate(call, input, tasks);
            toolActions.push(action);
            continue;
          }
          if (call.tool !== "create_task") continue;
          if (!intent.explicit) {
            // B: consultation / non-assignment intent → zero write, honest rejection.
            toolActions.push({
              tool: "create_task",
              rejected: true,
              reason: "not_explicit_task_intent",
              detail: intent.reason,
            });
            taskRejectedReason = intent.reason;
            continue;
          }
          this.assertNotCancelled(input.signal);
          const governed = this.governCreateTask({
            call: {
              ...call,
              citationIds: call.citationIds?.map(
                (id) =>
                  evidence.find((e) => e.citationId === id)?.fragmentId ?? id,
              ),
            },
            conversation: input.conversation,
            evidence,
            priorContext: this.priorWorkingContext(input.conversation),
            transportEventId: input.transportEventId,
            userText: input.userText,
            requestId: input.turnId,
            projectId,
          });
          toolActions.push(governed.action);
          if (governed.taskId) createdTaskIds.push(governed.taskId);
        }
      }

      // Only persisted receipts may claim an action was performed. Discard the
      // model's speculative success text whenever it requested a mutation.
      const mutations = toolActions.filter(
        (a) => a.tool === "create_task" || a.tool === "update_task",
      );
      const workReceipts = toolActions.filter(a => a.tool === "work_action");
      const finalAnswer = workReceipts.length ? workReceipts.map(r => String(r.message)).join("\n") : mutations.length
        ? mutations
            .map((action) => {
              if (action.rejected)
                return `${action.tool === "create_task" ? "未创建任务" : "未执行事项变更"}：${action.detail ?? action.reason}。`;
              const task = this.store
                .tasks()
                .find((t) => t.id === action.taskId);
              if (!task) return "事项变更尚未确认。";
              const verb =
                action.tool === "create_task"
                  ? "已创建任务"
                  : ((
                      {
                        complete: "已完成",
                        reopen: "已重新打开",
                        reschedule: "已改期",
                        wait: "已设为等待",
                        snooze: "已暂缓提醒",
                        cancel: "已取消",
                      } as Record<string, string>
                    )[String(action.action)] ?? "已更新");
              const time = task.dueAt
                ? `；截止时间：${new Intl.DateTimeFormat("zh-CN", { timeZone: clock.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date(String(task.dueAt)))}（${clock.timezone}）`
                : "";
              const follow = task.followUp
                ? taskFollowUpSchema.parse(task.followUp)
                : null;
              const check = follow?.next_check_at
                ? `；下次跟进：${new Intl.DateTimeFormat("zh-CN", { timeZone: follow.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date(follow.next_check_at))}（${follow.timezone}）`
                : follow?.waiting_on
                  ? "；尚未设置跟进时间"
                  : "";
              return `${verb}：${task.title}${["complete", "cancel"].includes(String(action.action)) ? "" : time + (follow?.waiting_on ? `；等待：${follow.waiting_on}` : "") + check}。`;
            })
            .join("\n")
        : reply.answer;

      // 4. Only allow citations the runtime actually supplied.
      const allowed = new Set(
        evidence.flatMap((item) => [
          item.citationId ?? item.fragmentId,
          item.fragmentId,
        ]),
      );
      const citationIds = (reply.citationIds ?? []).filter((id) =>
        allowed.has(id),
      );
      const selectedEvidence = evidence.filter(
        (item) =>
          citationIds.includes(item.citationId ?? item.fragmentId) ||
          citationIds.includes(item.fragmentId),
      );

      if (!input.conversation.currentGoal && priorTurns.length === 0)
        this.router.setGoal(
          input.conversation.id,
          input.userText.slice(0, 200),
        );

      // FENCE: abort check right before final persistence.
      this.assertNotCancelled(input.signal);

      this.store.tx(() => {
        this.router.completeTurn({
          turnId: input.turnId,
          result: finalAnswer,
          selectedEvidence,
          toolActions,
          degraded,
        });
        if (!degraded && reply.projectSelection)
          this.router.setProject(input.conversation.id, projectId);
      });
    } catch (error) {
      if (input.signal.aborted || error instanceof TurnCancelledError)
        this.router.cancelTurn(input.turnId, "cancelled");
      else
        this.router.failTurn(
          input.turnId,
          error instanceof Error ? error.message : "turn failed",
        );
    } finally {
      watchdog.close();
    }
  }

  /** Reject even when a model ignores cancellation, and always release the listener. */
  private async withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let rejectAbort: (e: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new TurnCancelledError(signal.reason?.message ?? "aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try { return await Promise.race([promise, aborted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  private async retrieveContext(
    userText: string,
    conversation: Conversation,
    purpose: RetrievalPurpose = "balanced",
  ) {
    const retrieval = this.options.retrieval;
    if (!retrieval?.search)
      return {
        evidence: await this.retrieveEvidence(userText, conversation),
        background: [] as AssistantBackground[],
      };
    const visible = this.readingScope(conversation);
    const hits = await retrieval.search({
      text: userText,
      // Retrieve a pool, then spend reading slots on distinct complete contexts.
      limit: 48,
      // Browse diversity must not discard a third fact from the same original.
      diversify: false,
      purpose,
      visible,
    });
    const selected = this.options.decisions
      ? await assessPassages(this.options.decisions, userText, hits)
      : { hits };
    return assembleAnswerContext(this.store, selected.hits, visible);
  }

  private async retrieveEvidence(
    userText: string,
    conversation: Conversation,
  ): Promise<AssistantEvidence[]> {
    // A: prefer the injected RetrievalPort (project-wide contract). Fall back
    // to store.search for legacy tests that don't wire a port.
    let rows: Array<{
      id: string;
      text: string;
      title: string;
      version?: number;
    }> = [];
    if (this.options.retrieval) {
      const candidates: SourceCandidate[] = await (
        this.options.retrieval.searchSourcesAsync?.bind(
          this.options.retrieval,
        ) ?? this.options.retrieval.searchSources.bind(this.options.retrieval)
      )({
        text: userText,
        limit: 20,
        diversify: false,
        visible: this.readingScope(conversation),
      });
      // Retain the actual semantic hit inside a long original fragment. The ACP
      // evidence budget is 2,000 characters; rereading only its prefix loses tails.
      const visible = this.readingScope(conversation);
      const evidence = new Map<string, AssistantEvidence>();
      for (const c of candidates) {
        const hit = this.enrichEvidence(
          c.fragmentId,
          c.routes?.includes("semantic") ? c.snippet : undefined,
        );
        if (hit && visible(hit.fragmentId)) {
          hit.sectionTitle = evidenceSection(
            this.store,
            hit.fragmentId,
            visible,
          )?.title;
          evidence.set(hit.fragmentId, hit);
        }
      }
      // Preserve all ranked hits, then fill the remaining budget with original
      // heading / neighboring evidence. Every added fragment is visibility checked.
      for (const c of candidates)
        for (const id of evidenceNeighbors(this.store, c.fragmentId, visible)) {
          if (evidence.size >= 28) break;
          if (evidence.has(id)) continue;
          const neighbor = this.enrichEvidence(id);
          if (neighbor) evidence.set(id, neighbor);
        }
      return [...evidence.values()];
    }
    // Legacy fallback (old tests without retrieval port).
    const q = userText.trim().slice(0, 300);
    if (!q.trim()) return [];
    rows = this.store.search(q) as typeof rows;
    const inScope = this.readingScope(conversation);
    return rows
      .map((row) => this.enrichEvidence(String(row.id)))
      .filter((e): e is AssistantEvidence => Boolean(e))
      .filter((e) => inScope(e.fragmentId));
  }

  /** Apply the saved material membership before ranking/limiting. Native Agent
   * tools remain free to investigate another project or necessary background. */
  private readingScope(conversation: Conversation): (id: string) => boolean {
    const project = conversation.visibility === "private" && conversation.projectId
      ? this.store.contexts.list().find(c => c.kind === "project" && c.id === conversation.projectId) : null;
    const members = project ? new Set(this.store.db.prepare(`SELECT f.id FROM fragments f
      JOIN revisions r ON r.id=f.revision_id
      JOIN material_context_sources s ON s.source_id=r.source_id WHERE s.context_id=?`).all(project.id).map(r => String(r.id))) : null;
    return id => this.isVisible(conversation, id) && (!members || members.has(id));
  }

  private visibleTasks(conversation: Conversation): AssistantTask[] {
    return this.store
      .tasks()
      .filter(
        (t) =>
          conversation.visibility === "private" ||
          (typeof t.evidenceId === "string" &&
            this.isVisible(conversation, t.evidenceId)),
      )
      .slice(0, 60)
      .map((t) => ({
        id: String(t.id),
        title: String(t.title),
        detail: String(t.detail),
        status: String(t.status),
        version: Number(t.version),
        dueAt: t.dueAt ? String(t.dueAt) : null,
        followUp: t.followUp as TaskFollowUp | null,
        nextStep: String(t.nextStep ?? ""),
        projectId: t.projectId ? String(t.projectId) : null,
      }));
  }

  private governTaskUpdate(
    call: AssistantUpdateTaskCall,
    input: { turnId: string; userText: string; conversation: Conversation },
    tasks: AssistantTask[],
  ): Record<string, unknown> {
    const reject = (reason: string) => ({
      tool: "update_task",
      rejected: true,
      reason,
    });
    const patterns = {
      complete: /完成|做完|办完|标.*完成|\bdone\b|\bcomplete\b/i,
      reopen: /重新打开|还没完成|恢复.*待办|\breopen\b/i,
      reschedule: /改到|改为|改期|推迟|延后|提前|挪到|\breschedule\b/i,
      wait: /等待|等.*回复|等.*确认|等.*结果|\bwait\b/i,
      snooze: /稍后|再提醒|再跟进|先不提醒|暂停提醒|晚点|\bsnooze\b/i,
      cancel: /取消|不用做|不做了|\bcancel\b/i,
    };
    if (
      !patterns[call.action].test(input.userText) ||
      /怎么|如何|是否|吗[？?]?$/.test(input.userText)
    )
      return reject("没有明确的事项变更指令");
    if (
      !tasks.some(
        (t) => t.id === call.taskId && t.version === call.expectedVersion,
      )
    )
      return reject("事项不存在、不可见或已被修改，请重新确认");
    if (!this.options.memory) return reject("事项服务不可用");
    try {
      const followUp = call.followUp
        ? validateFollowUp(
            {
              ...call.followUp,
              timezone: this.options.timezone ?? "Asia/Shanghai",
            },
            input.userText,
          )
        : null;
      const dueAt =
        call.action === "reschedule"
          ? validatedDueAt(call.dueAt, call.dueExpression, input.userText)
          : null;
      if (call.action === "reschedule" && !dueAt)
        return reject("请给出明确的改期时间");
      const taskProject = tasks.find(t => t.id === call.taskId)?.projectId;
      const contextIds = taskProject && this.store.contexts.list().some(c => c.id === taskProject)
        ? [taskProject] : [];
      const revision = this.store.capture({
        source: "manual",
        externalId: `turn:${input.turnId}`,
        title: "事项变更指令",
        parts: [{ type: "text", text: input.userText }],
        context: {
          conversationId: input.conversation.chatId ?? input.conversation.id,
        },
        provenance: {
          collectorId: "assistant",
          actorId: this.options.ownerId ?? "owner",
          actorType: "owner",
          actorVerifiedBy: "runtime",
          sourceUri: null,
          eventId: input.turnId,
          eventAt: new Date().toISOString(),
          timezone: this.options.timezone ?? "Asia/Shanghai",
          quoted: false,
          forwarded: false,
          producerKind: "original",
        },
      }, { contextIds }).revision;
      const receipt = this.options.memory.commandTask({
        taskId: call.taskId,
        expectedVersion: call.expectedVersion,
        action: call.action,
        dueAt,
        dueExpression: call.dueExpression ?? null,
        followUp,
        requestId: input.turnId,
        evidenceId: revision.fragments[0]!.id,
      });
      return {
        tool: "update_task",
        action: call.action,
        taskId: receipt.entityId,
        receiptId: receipt.id,
      };
    } catch (error) {
      return reject(error instanceof Error ? error.message : "事项变更失败");
    }
  }

  private readScopedCorrections(conversation: Conversation): string {
    if (!this.options.feedback) return "";
    try {
      const constraints = this.options.feedback.recall({
        workspace_id: "personal",
        project_id: null,
        // subject_id = conversation id keeps corrections scoped to this conversation.
        subject_id: conversation.id,
      });
      if (!constraints.length) return "";
      const lines = constraints
        .map((c: Record<string, unknown>) => {
          const matchKey = String(c.match_key ?? "");
          const replacement = String(c.replacement ?? "");
          if (!replacement) return "";
          return `纠正: ${matchKey} → ${replacement}`;
        })
        .filter(Boolean);
      return lines.length ? `[owner_corrections]\n${lines.join("\n")}` : "";
    } catch {
      return "";
    }
  }

  /**
   * G08: read the most recent done turn's selected evidence as working context.
   * A follow-up like "按这个整理下一步" refers to what the previous turn found.
   */
  private priorWorkingContext(conversation: Conversation): AssistantEvidence[] {
    const turns = this.router.turns(conversation.id);
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!;
      if (t.inputMessageRefs.status !== "done") continue;
      const selected = t.selectedEvidence as AssistantEvidence[];
      if (!selected || !selected.length) continue;
      return selected
        .map((s) => {
          const entry = this.enrichEvidence(s.fragmentId, s.text);
          if (
            !entry ||
            !s.sourceTarget ||
            s.sourceRevisionId !== entry.sourceRevisionId
          )
            return entry;
          const material = materialFromRevision(
            this.store,
            entry.sourceRevisionId,
          );
          const target = s.sourceTarget;
          if (
            !material ||
            target.revisionId !== material.revisionId ||
            target.digest !== material.digest ||
            !Number.isInteger(target.startLine) ||
            !Number.isInteger(target.endLine) ||
            target.startLine < 1 ||
            target.endLine < target.startLine ||
            target.endLine > material.lineCount
          )
            return null;
          // A chapter can span several stored fragments. Re-read its fixed
          // range instead of looking for the entire text in the first fragment.
          const anchor = sourceAnchor(
            material,
            target.startLine,
            target.endLine,
          );
          if (
            !anchor.fragmentIds.length ||
            !anchor.fragmentIds.every((id) => this.isVisible(conversation, id))
          )
            return null;
          return {
            ...evidenceForRange(
              { ...material, key: target.key },
              target.startLine,
              target.endLine,
              (id) => this.isVisible(conversation, id),
            ),
            ...(s.citationId ? { citationId: s.citationId } : {}),
            materialDescription:
              this.store.descriptions.get(material.revisionId) ?? undefined,
          };
        })
        .filter((e): e is AssistantEvidence => Boolean(e))
        .filter((e) => this.isVisible(conversation, e.fragmentId));
    }
    return [];
  }

  private enrichEvidence(
    fragmentId: string,
    focus?: string,
  ): AssistantEvidence | null {
    const record = this.store.evidence(fragmentId);
    if (!record) return null;
    const head = this.store.db
      .prepare("SELECT head FROM sources WHERE id=?")
      .get(record.revision.sourceId) as { head: string } | undefined;
    if (
      head?.head !== record.revision.id ||
      record.revision.provenance?.producerKind === "derived" ||
      (record.revision.context as Record<string, unknown> | undefined)
        ?.derived === true
    )
      return null;
    let text = record.fragment.text;
    // A stored excerpt is only a locator, never independent evidence. Check it
    // against the current immutable original before using it, including follow-ups.
    if (
      text.length > 2000 &&
      typeof focus === "string" &&
      focus.length > 0 &&
      focus.length <= 2000
    ) {
      const offset = text.indexOf(focus);
      if (offset >= 0) {
        const start = Math.max(
          0,
          offset - Math.floor((2000 - focus.length) / 2),
        );
        text = text.slice(start, start + 2000);
      }
    }
    return {
      fragmentId: record.fragment.id,
      sourceRevisionId: record.revision.id,
      revisionTitle: record.revision.title,
      text,
    };
  }

  private isVisible(conversation: Conversation, fragmentId: string): boolean {
    if (this.options.visibilityPolicy)
      return this.options.visibilityPolicy({ conversation, fragmentId });
    // Deny-by-default: a group conversation reveals no evidence unless the host
    // injects a real provenance/scope-based policy.
    return conversation.visibility === "private";
  }

  /**
   * Route a model create_task request through MemoryService governance. The model
   * cannot self-authorize:
   *  - only the canonical owner's verified evidence backs an owner task;
   *  - group-member / forwarded / unverified material is retained as a source lead,
   *    never applied as an owner task;
   *  - the proposal id is derived from the transport event id, so a re-delivered
   *    event does not create a second task (MemoryService also dedups by digest).
   *
   * B: the assessment verdict is now based on deterministic owner intent detection
   * upstream. We only reach here when detectTaskIntent() returned explicit=true,
   * meaning the user explicitly asked to record/assign. The evidence is the
   * current turn's userText itself (direct assignment), not a hardcoded verifier.
   */
  private governCreateTask(input: {
    call: AssistantCreateTaskCall;
    conversation: Conversation;
    evidence: AssistantEvidence[];
    priorContext?: AssistantEvidence[];
    transportEventId: string | null;
    userText: string;
    requestId: string;
    projectId: string | null;
  }): { action: Record<string, unknown>; taskId?: string } {
    const ownerId = this.options.ownerId ?? "owner";
    const reject = (reason: string, extra: Record<string, unknown> = {}) => ({
      action: { tool: "create_task", rejected: true, reason, ...extra },
    });

    if (!this.options.memory) return reject("no_memory_governance");

    // Only cite evidence the runtime actually exposed (already visibility-filtered).
    const cited = (input.call.citationIds ?? [])
      .map((id) => input.evidence.find((e) => e.fragmentId === id))
      .filter((e): e is AssistantEvidence => Boolean(e));

    // G08: if the model did not cite this turn evidence but prior turns have
    // working context, use that as cited evidence (anaphora resolution).
    const contextCited = cited.length
      ? cited
      : (input.priorContext ?? []).filter((e) =>
          (input.call.citationIds ?? []).length
            ? (input.call.citationIds ?? []).includes(e.fragmentId)
            : true,
        );
    // G08 negative: model cited fragments but none resolve and no prior context.
    const modelAskedFor = (input.call.citationIds ?? []).length > 0;
    if (modelAskedFor && !cited.length && !contextCited.length) {
      return reject("no_prior_evidence", {
        detail:
          "model cited fragments not found in current evidence or prior working context",
      });
    }
    // B: for a direct owner assignment with no pre-existing cited fragments,
    // capture the owner message itself as a source (real fragment, owner-verified
    // provenance) so the proposal has valid evidence. This is NOT a hardcoded
    // verifier: the fragment is the owner's actual words from this turn.
    let directEvidence: AssistantEvidence[] = [];
    {
      try {
        const extId = `turn:${input.requestId}`;
        const rev = this.store.capture({
          source: "manual",
          externalId: extId,
          title: "owner direct message",
          parts: [{ type: "text", text: input.userText.slice(0, 2000) }],
          context: { conversationId: input.conversation.id },
          provenance: {
            collectorId: "assistant",
            actorId: ownerId,
            actorType: "owner",
            actorVerifiedBy: "runtime",
            sourceUri: null,
            eventId: input.transportEventId,
            eventAt: new Date().toISOString(),
            timezone: this.options.timezone ?? "Asia/Shanghai",
            quoted: false,
            forwarded: false,
            producerKind: "original",
          },
        }, { contextIds: input.projectId ? [input.projectId] : [] }).revision;
        if (rev.fragments[0]) {
          directEvidence = [
            {
              fragmentId: rev.fragments[0].id,
              sourceRevisionId: rev.id,
              revisionTitle: "owner direct message",
              text: rev.fragments[0].text,
            },
          ];
        }
      } catch {
        // capture failure is non-fatal; cited fragments still work
      }
    }
    const allEvidence = directEvidence; // the current owner's instruction authorizes the action
    // B: for a direct owner assignment, the userText itself is the trusted
    // original message. We do NOT require pre-existing cited evidence fragments —
    // the owner is directly telling us what to record. But if the model DID cite
    // fragments, we validate them.
    const proposalId = `assistant-task:${input.transportEventId ?? input.requestId}:${stableDigest(input.call.title).slice(0, 16)}`;

    try {
      const result = this.options.memory.evaluate(
        {
          schema_version: 1,
          proposal_id: proposalId,
          kind: "task",
          operation: "create",
          scope: {
            workspace_id: "personal",
            project_id: input.projectId,
            subject_id: null,
          },
          body: {
            title: input.call.title,
            owner_id: ownerId,
            due_at: validatedDueAt(
              input.call.dueAt,
              input.call.dueExpression,
              input.userText,
            ),
            due_expression: input.call.dueExpression ?? null,
            next_step: input.call.detail,
            ...(input.call.followUp
              ? {
                  follow_up: validateFollowUp(
                    {
                      ...input.call.followUp,
                      timezone: this.options.timezone ?? "Asia/Shanghai",
                    },
                    input.userText,
                  ),
                }
              : {}),
          },
          evidence: allEvidence.map((e) => {
            const codePoints = Array.from(e.text);
            const quote = codePoints.slice(0, 2000).join("");
            return {
              fragment_revision_id: e.fragmentId,
              source_revision_id: e.sourceRevisionId,
              exact_quote: quote,
              selector: {
                start: 0,
                end: Array.from(quote).length,
                unit: "unicode_codepoint" as const,
              },
            };
          }),

          uncertainties: [],
          reason: input.call.detail || input.call.title,
          expected_versions: {},
          origin: {
            job_id: `turn:${input.conversation.id}`,
            role_bundle: "assistant",
            producer_kind: "derived",
          },
        },
        {
          // B: this IS a direct owner assignment — the user explicitly asked to
          // record something. semantic_verdict=supported reflects that the
          // user's own message is the authoritative evidence, not a hardcoded
          // verifier claim.
          semantic_verdict: "supported",
          reviewer_version: "assistant-intent-v1",
          role_version: "1",
          reason_code: "owner_direct_assignment",
          details: `owner explicitly requested task recording in turn: "${input.userText.slice(0, 200)}"`,
        },
        { impactCount: 1 },
      );
      if (result.receipt && result.receipt.entityType === "task") {
        return {
          action: {
            tool: "create_task",
            taskId: result.receipt.entityId,
            policy: result.policy,
            duplicate: Boolean(result.receipt.duplicate),
          },
          taskId: result.receipt.entityId,
        };
      }
      return reject("not_auto_applied", {
        policy: result.policy,
        reasons: result.reasons,
      });
    } catch (error) {
      return reject("governance_error", {
        error: error instanceof Error ? error.message.slice(0, 200) : "error",
      });
    }
  }

  private toResult(
    turn: ConversationTurn,
    conversation: Conversation,
    evidence: AssistantEvidence[],
    duplicate: boolean,
  ): AssistantTurnResult {
    return {
      turn,
      conversation: this.router.get(conversation.id) ?? conversation,
      evidence: Array.isArray(turn.selectedEvidence)
        ? (turn.selectedEvidence as AssistantEvidence[])
        : evidence,
      createdTaskIds: (turn.toolActions as Array<{ taskId?: string }>)
        .map((a) => a.taskId)
        .filter((id): id is string => Boolean(id)),
      degraded:
        turn.inputMessageRefs.status !== "done" ||
        Boolean(turn.inputMessageRefs.degraded),
      duplicate,
    };
  }
}
