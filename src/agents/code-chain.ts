import type { Execution } from "./execution.ts";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { getThread } from "./threads.ts";
import type { Run } from "./runs.ts";
import { createRun, getRun, setRunOutput, updateQueuedRun } from "./runs.ts";
import { refreshWork, workForChild } from "./agent-work.ts";
import { markNotesDelivered, notesText, pendingNotes, type RoundReview } from "./code-steer.ts";
import { cancelHostAsks, ROUND_ASKS } from "./asks.ts";
import { goalText, isTaskWork, listTasks, POLISH_STAGES, waitingText, workRootOf, workState } from "./code-tasks.ts";

/**
 * A delegated coding run reports back to the conversation that requested it, and keeps going
 * by itself while the reviewer asks for changes. Rounds share one chain keyed by the original
 * ask run, so they reuse the same coding Agent session (its cwd), the same worktrees and the
 * same progress message instead of stopping after the first round.
 */

export type CodeChain = {
  /** Ask run that started the delegation; rounds of one request share it. */
  askRunId: string;
  /** Conversation the original request came from (the assistant reports here). */
  conversationId: string;
  /** Feishu thread key (chatId or chatId#topic) the progress message belongs to. */
  larkKey: string | null;
  /** The one progress card message for the whole chain, updated as rounds run. */
  larkMessageId: string | null;
  /** owner / budget / paused: a task-driven delegation waits for answers, ran out of rounds, or was paused (code-loop.ts). */
  waitReason?: "auto-limit" | "review" | "no-changes" | "failed" | "plan" | "not-converging" | "stalemate" | "escalated" | "stopped" | "owner" | "assistant" | "budget" | "paused" | "polishing";
  round: number;
  rounds: string[];
  /** The last coding run id; its Agent session is resumed on the next round. */
  lastCodeRunId: string | null;
  /** Set when the owner is asked what to do; no further automatic rounds while pending. */
  awaitingUser: boolean;
  /** Automatic round limit of the review tier the change fell into; the config default otherwise. */
  maxRounds?: number;
};

/** Load the chain a coding run belongs to, building the first round from its parent ask. */
export function codeChainFor(app: App, run: Run): CodeChain | null {
  const existing = (run.output as { codeChain?: CodeChain } | null)?.codeChain;
  if (existing) return existing;
  if (!run.parentId) return null;
  const parent = one<{ input: string; output: string | null }>(app.db, "select input, output from runs where id = ?", run.parentId);
  if (!parent) return null;
  const conversationId = (JSON.parse(parent.input) as { conversationId?: string }).conversationId;
  const prev = parent.output ? (JSON.parse(parent.output) as { codeChain?: CodeChain }).codeChain : undefined;
  if (!conversationId && !prev) return null;
  const larkKey = prev?.larkKey ?? (() => {
    const t = getThread(app, conversationId ?? "");
    return t?.channel === "lark" || t?.channel.startsWith("lark:") ? (t.settings.lastTopicId && t.key ? `${t.key.split("#")[0]}#${t.settings.lastTopicId}` : t.key ?? null) : null;
  })();
  const chain: CodeChain = {
    askRunId: run.parentId,
    conversationId: conversationId ?? prev!.conversationId,
    larkKey,
    larkMessageId: prev?.larkMessageId ?? null,
    round: (run.input as { round?: number }).round ?? 1,
    rounds: [run.id],
    lastCodeRunId: run.id,
    awaitingUser: false,
  };
  saveCodeChain(app, chain, run.id, run.parentId);
  return chain;
}

/** Keep the chain on the ask run and every coding round, so a restart or any round finds it. */
export function saveCodeChain(app: App, chain: CodeChain, ...runIds: string[]) {
  for (const id of new Set(runIds)) {
    run(app.db, "update runs set output=json_set(coalesce(output,'{}'),'$.codeChain',json(?)) where id=?", JSON.stringify(chain), id);
  }
}

/** Rounds a coding delegation runs before the reviewer's requests wait for the owner (config agents.autoAdvance.codeRounds). */
export const maxCodeRounds = (app: App, chain?: CodeChain | null) => chain?.maxRounds ?? app.config.agents.autoAdvance.codeRounds;

/**
 * Queue another coding round in the same chain: same repositories and check commands, the same
 * worktrees (continueFrom) and the same coding Agent session (resumeSessionId), with the
 * reviewer's change request as its task. Returns null while waiting for the owner.
 */
export function queueNextCodeRound(
  app: App,
  chain: CodeChain,
  task: string,
  opts: { resumeSessionId?: string; manual?: boolean; execution?: Execution; reviewExecution?: Execution; reviewOnly?: string[]; roundReview?: RoundReview; extraInput?: Record<string, unknown> } = {},
): { run: Run; chain: CodeChain } | null {
  // Round 1 + automatic continuations up to maxCodeRounds; further rounds need continue_code_run.
  // Reload under a write lock: stale callers and separate MCP processes cannot queue duplicates.
  const expectedLastRunId = chain.lastCodeRunId;
  app.db.exec("BEGIN IMMEDIATE");
  try {
    chain = (getRun(app, chain.askRunId).output.codeChain as CodeChain | undefined) ?? chain;
    const current = getRun(app, chain.lastCodeRunId!);
    if (chain.rounds.some((id) => { const out = getRun(app, id).output; return out.appliedAt || out.discardedAt; }))
      throw new HttpError(409, "原交办已应用或丢弃，工作区已释放，不能续轮");
    if (opts.manual && ["queued", "running"].includes(current.status))
      throw new HttpError(409, `第 ${chain.round} 轮 ${current.id} 仍为 ${current.status}，不能重复启动`);
    if (!opts.manual && (chain.awaitingUser || chain.round >= maxCodeRounds(app, chain))) return null;
    if (!opts.manual && current.id !== expectedLastRunId) return null;
    if (!opts.manual && current.status !== "running" && current.status !== "done") return null;
    const last = one<{ space_id: string | null; input: string }>(app.db, "select space_id, input from runs where id = ?", chain.lastCodeRunId!);
    if (!last) return null;
    const input = JSON.parse(last.input) as { execution?: Execution; reviewExecution?: Execution; task: string; checkCommand?: string; repos?: string[]; checks?: Record<string, string>; reviewTier?: string; reviewChecks?: string[]; roundReview?: RoundReview; readSpaces?: string[]; itemId?: string; fromReview?: string; taskMode?: boolean };
    // What the owner added while the last round ran and nobody delivered yet goes with this round's task.
    const notes = pendingNotes(app, chain.lastCodeRunId!);
    const roundNotes = notes.length ? notesText(notes) : null;
    if (notes.length) {
      task = `${task}\n\n${notesText(notes)}`;
      markNotesDelivered(app, chain.lastCodeRunId!, notes);
    }
    const next: CodeChain = { ...chain, round: chain.round + 1, awaitingUser: false, waitReason: undefined, rounds: [...chain.rounds] };
    const r = createRun(app, {
      kind: "code",
      spaceId: last.space_id,
      title: `交办第 ${next.round} 轮：${task.split("\n")[0].slice(0, 60)}`,
      input: {
        task,
        execution: opts.execution ?? input.execution,
        reviewExecution: opts.reviewExecution ?? input.reviewExecution,
        checkCommand: input.checkCommand,
        repos: input.repos,
        checks: input.checks,
        reviewTier: input.reviewTier,
        reviewChecks: input.reviewChecks,
        // The owner's choice for the review (“从简”) holds for the rounds after it until changed.
        roundReview: opts.roundReview ?? input.roundReview,
        readSpaces: input.readSpaces,
        itemId: input.itemId,
        fromReview: input.fromReview,
        // A task-driven round's brief is its tasks, not `task`: the notes go along on their own.
        ...(input.taskMode ? { taskMode: true, ...(roundNotes ? { roundNotes } : {}) } : {}),
        // review-lead named the checks the fixes touch; the others are not re-run this round.
        ...(opts.reviewOnly?.length ? { reviewOnly: opts.reviewOnly } : {}),
        // A round of Git work (finishing a stopped sync, moving onto the latest target) says so here.
        ...(opts.extraInput ?? {}),
        continueFrom: chain.rounds[0],
        resumeSessionId: opts.execution && ["profile", "model", "effort"].some((key) => opts.execution?.[key as keyof Execution] !== input.execution?.[key as keyof Execution]) ? undefined : opts.resumeSessionId,
        round: next.round,
      },
      parentId: chain.askRunId,
    });
    next.rounds.push(r.id);
    next.lastCodeRunId = r.id;
    saveCodeChain(app, next, r.id, chain.askRunId, ...chain.rounds);
    // The work moved on: what the earlier rounds asked the owner (plan, result, a stop) is answered.
    for (const id of chain.rounds) cancelHostAsks(app, id, ROUND_ASKS);
    return { run: r, chain: next };
  } catch (e) { app.db.exec("ROLLBACK"); throw e; } finally { if (app.db.isTransaction) app.db.exec("COMMIT"); }
}

/** No automatic round while waiting for the owner; their answer resumes the chain. */
export function setChainAwaitingUser(app: App, chain: CodeChain, waiting: boolean) {
  const fresh = getRun(app, chain.askRunId).output.codeChain as CodeChain | undefined;
  const next = { ...(fresh ?? chain), awaitingUser: waiting };
  saveCodeChain(app, next, chain.askRunId, ...chain.rounds);
  return next;
}

/** Coding runs of one chain in order. */
export function codeChainRounds(app: App, askRunId: string): Run[] {
  const out: Run[] = [];
  const walk = (id: string, seen: Set<string>) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of all<{ id: string }>(app.db, "select id from runs where parent_id = ? order by created_at", id)) {
      const r = getRun(app, c.id);
      if (r.kind === "code") out.push(r);
      walk(c.id, seen);
    }
  };
  walk(askRunId, new Set());
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Persist user intervention even with no connected bot; no automatic restart of the chain. */
export function settleCodeChain(app: App, runId: string) {
  const before = getRun(app, runId);
  if (!before.output.codeChain || !["done", "failed", "cancelled"].includes(before.status)) return;
  app.db.exec("BEGIN IMMEDIATE");
  try {
    const r = getRun(app, runId);
    const chain = (r.output.codeChain as CodeChain | undefined);
    if (!chain || chain.lastCodeRunId !== r.id || !["done", "failed", "cancelled"].includes(r.status)) return;
    const approved = r.status === "done" && r.output.verdict === "approved";
    // Coding is done and the review plan waits for the owner: no handoff yet, the plan ask is it.
    if (r.status === "done" && r.output.verdict === "awaiting-plan") {
      const next = setChainAwaitingUser(app, chain, true);
      next.waitReason = "plan";
      saveCodeChain(app, next, next.askRunId, ...next.rounds);
      return;
    }
    if (approved) {
      const next = { ...chain, awaitingUser: false, waitReason: undefined };
      saveCodeChain(app, next, next.askRunId, ...next.rounds);
    } else {
      const next = setChainAwaitingUser(app, chain, true);
      next.waitReason = r.output.stoppedByOwner ? "stopped" : r.status !== "done" ? "failed" : r.output.verdict === "no-changes" ? "no-changes" : (r.output.reviewStop as CodeChain["waitReason"]) ?? (chain.round >= maxCodeRounds(app, chain) ? "auto-limit" : "review");
      saveCodeChain(app, next, next.askRunId, ...next.rounds);
    }
    // The originating assistant can consume the result on its next turn. Do not wake a
    // tool-enabled assistant here: that would bypass the automatic round budget.
    if (!r.output.codeResultMessageId) {
      const messageId = newId("msg");
      // Internal handoff is a conversation record backed by this run; it is not a
      // new user source and does not invoke source indexing inside this transaction.
      const branchReview = !!(r.input as { branches?: unknown }).branches;
      const taskWork = isTaskWork(app, r.id);
      const next = approved ? "" : branchReview ? "只有评审意见，没有改动；本人要按意见修改时用 delegate_code 传 from_branch 基于该分支交办。" : taskWork ? stopText(app, workRootOf(app, r.id), r) : "等待本人处理；明确继续时用 continue_code_run 复用原任务。";
      const waiting = taskWork ? [goalText(app, workRootOf(app, r.id)), waitingText(app, workRootOf(app, r.id))].filter(Boolean).join("\n\n") : "";
      const text = `${branchReview ? `分支评审 ${r.id}` : `编码交办第 ${chain.round} 轮 ${r.id}`} 已结束：${r.status}${r.output.verdict ? `（${r.output.verdict}）` : ""}。${next}\n\n${String(r.output.review ?? r.output.coderSummary ?? "").slice(0, 12000)}${waiting ? `\n\n${waiting}` : ""}`;
      const to = reportConversation(app, chain, r);
      run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)",
        messageId, to, "assistant", text, r.id, JSON.stringify({ codeResult: r.id, record: true }), now());
      run(app.db, "update conversations set updated_at=? where id=?", now(), to);
      setRunOutput(app, r.id, { codeResultMessageId: messageId });
    }
  } catch (e) { app.db.exec("ROLLBACK"); throw e; } finally { if (app.db.isTransaction) app.db.exec("COMMIT"); }
}

/** Bookkeeping must never change a run's outcome or interrupt terminal event delivery. */
export function trySettleCodeChain(app: App, runId: string): boolean {
  try {
    settleCodeChain(app, runId);
  } catch (error) {
    console.warn(`[omem] 编码交办收尾失败 ${runId}：${error instanceof Error ? error.name : "Error"}`);
    return false;
  }
  try {
    wakeAssistantForCodeResult(app, runId);
  } catch (error) {
    console.warn(`[omem] 编码交办结果交给主助手失败 ${runId}：${(error as Error).message}`);
  }
  return true;
}

/** Tools the assistant does not get when it is woken by a coding result: no new rounds behind the owner's back. */
export const CODE_HANDOFF_DENY = ["delegate_code", "review_branch", "continue_code_run", "apply_code_run", "code_branch", "clean_code_runs", "set_code_workspaces", "code_git_action"];

/**
 * Why a task-driven delegation stopped and who it waits on, said by the host for the assistant's
 * turn: the one limit that stopped it (and the setting behind it), or the party the rest waits on.
 */
function stopText(app: App, rootId: string, r: Run): string {
  const w = workState(app, rootId);
  const tasks = listTasks(app, rootId);
  const mine = tasks.filter((t) => t.state === "assistant").length;
  const owner = tasks.filter((t) => t.state === "owner").length;
  const left = tasks.filter((t) => t.state === "todo").length;
  const stop = String(r.output.reviewStop ?? w.paused ?? "");
  const why = r.status !== "done" ? `这一轮${r.status === "failed" ? `失败了（${String(r.error ?? "").slice(0, 300)}）` : "被停下了"}，宿主不会自己重开。`
    : stop === "budget" ? `自动推进的 ${w.until} 轮用完了（还有 ${left} 项待做；预算是交办时的 max_rounds、或编码 Agent 拆分时的估计，上限是设置 → Agent → 自动推进的“编码最多轮数”）。只有本人说继续才再推进一份（${w.budget} 轮）。`
    : stop === "not-converging" ? "最近三次阶段评审要改的问题没有减少，宿主暂停了交办：要本人看一下方案。"
    : stop === "polishing" ? `需求早就做完了，之后 ${POLISH_STAGES} 次阶段评审每次都在提新问题（还剩 ${left} 项），宿主暂停了交办。逐项看剩下的：和原来要的无关、只在现在的用法碰不到的情况下出现的，用 settle_code_task 的 later 记成以后再做；真影响需求的留着。然后告诉本人现在能用什么、你建议先交付还是再改几项。`
    : stop === "paused" || w.paused === "owner" ? "本人暂停了交办。"
    : stop === "assistant" ? "能做的修改项都做完了，剩下的等你处理（下面列着），没有要本人决定的。"
    : stop === "owner" ? "能做的修改项都做完了，剩下的在等本人决定（卡片已经发给本人）。"
    : "";
  const who = [mine ? `${mine} 项等你处理` : "", owner ? `${owner} 项等本人决定` : ""].filter(Boolean).join("，");
  return `${why}${who ? `现在：${who}。` : ""}`;
}

/** The ask run that already takes the assistant's turn for this work (queued or running), if any. */
function assistantTurnFor(app: App, rootId: string) {
  return one<{ id: string; status: string }>(app.db, "select id, status from runs where kind = 'ask' and status in ('queued', 'running') and json_extract(input, '$.handoff.workId') = ? order by created_at desc limit 1", rootId);
}

/**
 * Where the work reports to the owner now: the conversation they last steered it from (followOwner),
 * else the topic it was moved to, else the one it was asked from. Results, handoffs to the assistant
 * and cards all go there; the Feishu progress card stays where it was posted.
 */
export function reportConversation(app: App, chain: CodeChain, r?: Run) {
  const steered = chain.askRunId ? (getRun(app, chain.askRunId).output as { codeReportTo?: string }).codeReportTo : undefined;
  if (steered) return steered;
  const work = (r ? workForChild(app, r) : null) ?? (chain.askRunId ? refreshWork(app, chain.askRunId) : null);
  return work?.workConversationId ?? chain.conversationId;
}

/**
 * The owner steered the work from another conversation of theirs (a later topic of the group, a
 * private chat): from now on it reports there. Kept on the ask run that started it, apart from the
 * chain, so a round saving an older copy of the chain does not undo it. True when it moved.
 */
export function followOwner(app: App, runId: string, conversationId: string | undefined, userId: string): boolean {
  if (!conversationId) return false;
  const chain = codeChainFor(app, getRun(app, runId));
  if (!chain?.askRunId) return false;
  const owner = (id: string) => one<{ user_id: string | null }>(app.db, "select user_id from conversations where id = ?", id)?.user_id ?? null;
  if (owner(conversationId) !== userId || owner(chain.conversationId) !== userId) return false;
  if (reportConversation(app, chain) === conversationId) return false;
  setRunOutput(app, chain.askRunId, { codeReportTo: conversationId });
  return true;
}

/**
 * Tasks the round cannot move (held up, failed too often, never reached, no ruling) wait on the
 * assistant that started the work. It is woken for them while the rest of the work goes on — it does
 * not wait for the work to stop — and settles each (settle_code_task); nothing reaches the owner
 * unless it passes a question on. One turn per work at a time: a later one picks up what came since.
 */
export function wakeAssistantForTasks(app: App, rootId: string): string | null {
  const last = one<{ id: string }>(app.db, "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at desc limit 1", rootId, rootId);
  if (!last) return null;
  const r = getRun(app, last.id);
  const chain = r.output.codeChain as CodeChain | undefined;
  if (!chain || !listTasks(app, rootId).some((t) => t.state === "assistant")) return null;
  if (assistantTurnFor(app, rootId)) return null;
  const conversationId = reportConversation(app, chain, r);
  const messageId = newId("msg");
  run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)",
    messageId, conversationId, "assistant", `编码交办 ${rootId} 还在推进，有修改项等你处理。\n\n${waitingText(app, rootId)}`, r.id, JSON.stringify({ codeTasks: rootId, record: true }), now());
  return createRun(app, {
    kind: "ask",
    spaceId: getThread(app, conversationId).spaceId,
    title: `编码交办：修改项等助手处理`,
    input: { conversationId, messageIds: [messageId], handoff: { kind: "code-tasks", runId: r.id, workId: rootId }, denyTools: CODE_HANDOFF_DENY },
    lane: conversationId,
    parentId: chain.askRunId,
  }).id;
}

/**
 * When a delegation stops (approved, out of automatic rounds, failed, no changes), the assistant
 * that started it takes a turn in that conversation: it reads the result, tells the owner what
 * came out and what is left, and does what it can without coding tools (those would bypass the
 * automatic round limit). The progress card still shows the details. Once per final round.
 */
function wakeAssistantForCodeResult(app: App, runId: string) {
  const r = getRun(app, runId);
  const chain = r.output.codeChain as CodeChain | undefined;
  const messageId = r.output.codeResultMessageId as string | undefined;
  if (!chain || !messageId || r.output.codeResultHandedOff || chain.lastCodeRunId !== r.id || r.output.verdict === "awaiting-plan") return;
  // Stopped on the owner's word: whoever stopped it already told them.
  if (r.output.stoppedByOwner) return;
  // An automatic next round is already queued: nothing to tell yet.
  if (r.status === "done" && r.output.verdict === "changes-requested" && chain.round < maxCodeRounds(app, chain) && !chain.awaitingUser) return;
  setRunOutput(app, runId, { codeResultHandedOff: true });
  // The owner moved this work to another conversation (new Feishu topic): the handoff goes there.
  const conversationId = reportConversation(app, chain, r);
  let movedMessageId = messageId;
  const written = one<{ text: string; conversation_id: string }>(app.db, "select text, conversation_id from messages where id = ?", messageId);
  if (written && written.conversation_id !== conversationId) {
    const handoffText = written.text;
    if (handoffText) {
      movedMessageId = newId();
      run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)",
        movedMessageId, conversationId, "assistant", handoffText, r.id, JSON.stringify({ codeResult: r.id, record: true, movedFrom: written.conversation_id }), now());
    }
  }
  const rootId = isTaskWork(app, r.id) ? workRootOf(app, r.id) : chain.rounds[0];
  const handoff = { kind: "code", runId, workId: rootId };
  // A turn for its tasks still waiting takes the result too: one turn, which now also reports.
  const waiting = assistantTurnFor(app, rootId);
  if (waiting?.status === "queued") {
    const q = getRun(app, waiting.id);
    if (updateQueuedRun(app, q.id, { input: { ...q.input, messageIds: [...((q.input.messageIds as string[] | undefined) ?? []), movedMessageId], handoff }, title: `编码交办第 ${chain.round} 轮结束：${r.status}` })) return;
  }
  createRun(app, {
    kind: "ask",
    spaceId: getThread(app, conversationId).spaceId,
    title: `编码交办第 ${chain.round} 轮结束：${r.status}${r.output.verdict ? `（${r.output.verdict}）` : ""}`,
    input: { conversationId, messageIds: [movedMessageId], handoff, denyTools: CODE_HANDOFF_DENY },
    lane: conversationId,
    parentId: chain.askRunId,
  });
}
