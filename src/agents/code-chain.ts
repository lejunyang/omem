import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { getThread } from "./threads.ts";
import type { Run } from "./runs.ts";
import { createRun, getRun } from "./runs.ts";

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
    const out = one<{ output: string | null }>(app.db, "select output from runs where id = ?", id)?.output;
    run(app.db, "update runs set output = ? where id = ?", JSON.stringify({ ...(out ? JSON.parse(out) : {}), codeChain: chain }), id);
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
  opts: { resumeSessionId?: string; awaitingUser?: boolean } = {},
): { run: Run; chain: CodeChain } | null {
  // Round 1 + at most MAX_AUTO_ROUNDS-1 automatic continuations; further rounds need continue_code_run.
  if (chain.awaitingUser || chain.round >= MAX_AUTO_ROUNDS) return null;
  const last = one<{ space_id: string | null; input: string }>(app.db, "select space_id, input from runs where id = ?", chain.lastCodeRunId!);
  if (!last) return null;
  const input = JSON.parse(last.input) as { task: string; checkCommand?: string; repos?: string[]; checks?: Record<string, string> };
  const next: CodeChain = { ...chain, round: chain.round + 1, awaitingUser: !!opts.awaitingUser };
  const r = createRun(app, {
    kind: "code",
    spaceId: last.space_id,
    title: `交办第 ${next.round} 轮：${task.split("\n")[0].slice(0, 60)}`,
    input: {
      task,
      checkCommand: input.checkCommand,
      repos: input.repos,
      checks: input.checks,
      continueFrom: chain.lastCodeRunId,
      resumeSessionId: opts.resumeSessionId,
      round: next.round,
    },
    parentId: chain.askRunId,
  });
  next.rounds.push(r.id);
  next.lastCodeRunId = r.id;
  saveCodeChain(app, next, r.id, chain.askRunId, ...chain.rounds);
  return { run: r, chain: next };
}

/** No automatic round while waiting for the owner; their answer resumes the chain. */
export function setChainAwaitingUser(app: App, chain: CodeChain, waiting: boolean) {
  const next = { ...chain, awaitingUser: waiting };
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
