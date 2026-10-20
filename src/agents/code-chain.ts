import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, newId, now } from "../core/util.ts";
import { getThread } from "./threads.ts";
import type { Run } from "./runs.ts";
import { createRun, getRun, setRunOutput } from "./runs.ts";

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
  waitReason?: "auto-limit" | "review" | "no-changes" | "failed";
  round: number;
  rounds: string[];
  /** The last coding run id; its Agent session is resumed on the next round. */
  lastCodeRunId: string | null;
  /** Set when the owner is asked what to do; no further automatic rounds while pending. */
  awaitingUser: boolean;
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
    return t?.channel === "lark" ? (t.key ?? null) : null;
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

export const MAX_AUTO_ROUNDS = 3;

/**
 * Queue another coding round in the same chain: same repositories and check commands, the same
 * worktrees (continueFrom) and the same coding Agent session (resumeSessionId), with the
 * reviewer's change request as its task. Returns null while waiting for the owner.
 */
export function queueNextCodeRound(
  app: App,
  chain: CodeChain,
  task: string,
  opts: { resumeSessionId?: string; manual?: boolean } = {},
): { run: Run; chain: CodeChain } | null {
  // Round 1 + at most MAX_AUTO_ROUNDS-1 automatic continuations; further rounds need continue_code_run.
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
    if (!opts.manual && (chain.awaitingUser || chain.round >= MAX_AUTO_ROUNDS)) return null;
    if (!opts.manual && current.id !== expectedLastRunId) return null;
    if (!opts.manual && current.status !== "running" && current.status !== "done") return null;
    const last = one<{ space_id: string | null; input: string }>(app.db, "select space_id, input from runs where id = ?", chain.lastCodeRunId!);
    if (!last) return null;
    const input = JSON.parse(last.input) as { task: string; checkCommand?: string; repos?: string[]; checks?: Record<string, string> };
    const next: CodeChain = { ...chain, round: chain.round + 1, awaitingUser: false, waitReason: undefined, rounds: [...chain.rounds] };
    const r = createRun(app, {
      kind: "code",
      spaceId: last.space_id,
      title: `交办第 ${next.round} 轮：${task.split("\n")[0].slice(0, 60)}`,
      input: {
        task,
        checkCommand: input.checkCommand,
        repos: input.repos,
        checks: input.checks,
        continueFrom: chain.rounds[0],
        resumeSessionId: opts.resumeSessionId,
        round: next.round,
      },
      parentId: chain.askRunId,
    });
    next.rounds.push(r.id);
    next.lastCodeRunId = r.id;
    saveCodeChain(app, next, r.id, chain.askRunId, ...chain.rounds);
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
    if (approved) {
      const next = { ...chain, awaitingUser: false, waitReason: undefined };
      saveCodeChain(app, next, next.askRunId, ...next.rounds);
    } else {
      const next = setChainAwaitingUser(app, chain, true);
      next.waitReason = r.status !== "done" ? "failed" : r.output.verdict === "no-changes" ? "no-changes" : chain.round >= MAX_AUTO_ROUNDS ? "auto-limit" : "review";
      saveCodeChain(app, next, next.askRunId, ...next.rounds);
    }
    // The originating assistant can consume the result on its next turn. Do not wake a
    // tool-enabled assistant here: that would bypass the automatic round budget.
    if (!r.output.codeResultMessageId) {
      const messageId = newId("msg");
      // Internal handoff is a conversation record backed by this run; it is not a
      // new user source and does not invoke source indexing inside this transaction.
      const text = `编码交办第 ${chain.round} 轮 ${r.id} 已结束：${r.status}${r.output.verdict ? `（评审：${r.output.verdict}）` : ""}。${approved ? "" : "等待本人处理；明确继续时用 continue_code_run 复用原任务。"}\n\n${String(r.output.review ?? r.output.coderSummary ?? "").slice(0, 12000)}`;
      run(app.db, "insert into messages(id,conversation_id,role,text,run_id,meta,created_at) values(?,?,?,?,?,?,?)",
        messageId, chain.conversationId, "assistant", text, r.id, JSON.stringify({ codeResult: r.id, record: true }), now());
      run(app.db, "update conversations set updated_at=? where id=?", now(), chain.conversationId);
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
export const CODE_HANDOFF_DENY = ["delegate_code", "continue_code_run", "apply_code_run"];

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
  if (!chain || !messageId || r.output.codeResultHandedOff || chain.lastCodeRunId !== r.id) return;
  // An automatic next round is already queued: nothing to tell yet.
  if (r.status === "done" && r.output.verdict === "changes-requested" && chain.round < MAX_AUTO_ROUNDS && !chain.awaitingUser) return;
  setRunOutput(app, runId, { codeResultHandedOff: true });
  createRun(app, {
    kind: "ask",
    spaceId: getThread(app, chain.conversationId).spaceId,
    title: `编码交办第 ${chain.round} 轮结束：${r.status}${r.output.verdict ? `（${r.output.verdict}）` : ""}`,
    input: { conversationId: chain.conversationId, messageIds: [messageId], handoff: { kind: "code", runId }, denyTools: CODE_HANDOFF_DENY },
    lane: chain.conversationId,
    parentId: chain.askRunId,
  });
}
