import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { HttpError, newId, now, truncate } from "../core/util.ts";
import { addRunEvent, cancelRun, getRun, setRunOutput, type Run } from "./runs.ts";

/**
 * The owner (or the assistant on their word) steering a coding delegation while it runs, the way
 * one talks to a coding agent mid-task: a note to the coding Agent, the review the next rounds get,
 * or stopping it. A note reaches the coder at its next omem tool call; one it has not picked up by
 * the end of its turn is sent as a follow-up in the same session before the checks; a note that
 * comes after the coding goes with the next round's task.
 */

/** The owner's choice for a round's review and the rounds after it: a tier (lighter than before is fine), the exact checks, no requirement split, another model each round. */
export type RoundReview = { tier?: string; checks?: string[]; split?: boolean; rotate?: boolean };
export type CodeNote = { id: string; text: string; at: string; by: string; deliveredAt?: string };

const notesOf = (r: Run) => ((r.output.notes ?? []) as CodeNote[]);
export const pendingNotes = (app: App, runId: string) => notesOf(getRun(app, runId)).filter((n) => !n.deliveredAt);

export function markNotesDelivered(app: App, runId: string, taken: CodeNote[]) {
  const ids = new Set(taken.map((n) => n.id));
  const at = now();
  setRunOutput(app, runId, { notes: notesOf(getRun(app, runId)).map((n) => (ids.has(n.id) && !n.deliveredAt ? { ...n, deliveredAt: at } : n)) });
}

export function notesText(notes: CodeNote[]) {
  return [
    "## 本人在你工作期间补充的要求",
    "",
    ...notes.map((n) => `- ${n.at.slice(11, 16)} ${n.text}`),
    "",
    "结合它们继续，不用停下重来；和原来的要求冲突时以这里为准。最后的说明里逐条交代怎么处理的。",
  ].join("\n");
}

/** The latest round of the delegation `runId` belongs to (any round, or the ask that started it). */
export function latestRound(app: App, runId: string): Run {
  const r = getRun(app, runId);
  if (r.kind === "review" && typeof r.input.codeRunId === "string") return latestRound(app, r.input.codeRunId);
  const chain = (r.output.codeChain ?? null) as { askRunId: string; lastCodeRunId: string | null } | null;
  const fresh = chain ? ((getRun(app, chain.askRunId).output.codeChain ?? chain) as { lastCodeRunId: string | null }) : null;
  if (fresh?.lastCodeRunId) return getRun(app, fresh.lastCodeRunId);
  if (r.kind === "code") {
    const root = String(r.input.continueFrom ?? r.id);
    const last = one<{ id: string }>(app.db, "select id from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?) order by created_at desc limit 1", root, root);
    return getRun(app, last!.id);
  }
  throw new HttpError(400, "这不是一次编码交办");
}

/** Where a round is: coding (a note reaches the coder now), reviewing (the note waits for the next round), or ended. */
export function roundStage(r: Run): "queued" | "coding" | "review" | "ended" {
  if (r.status === "queued") return "queued";
  if (r.status !== "running") return "ended";
  return typeof r.output.coderSummary === "string" ? "review" : "coding";
}

/** Add the owner's words to the delegation's current round. */
export function addCodeNote(app: App, runId: string, text: string, by: string) {
  const r = latestRound(app, runId);
  if ((r.input as { branches?: unknown }).branches) throw new HttpError(400, "分支评审不编码，没有编码 Agent 可以补充；要按评审修改用 fix_review");
  if (r.output.appliedAt || r.output.discardedAt) throw new HttpError(409, "这次交办已经应用或丢弃，工作区已释放；新的要求请重新交办");
  const note: CodeNote = { id: newId("note"), text: text.trim(), at: now(), by };
  if (!note.text) throw new HttpError(400, "补充的内容不能为空");
  setRunOutput(app, r.id, { notes: [...notesOf(r), note] });
  const stage = roundStage(r);
  addRunEvent(app, r.id, "status", { text: `本人补充：${truncate(note.text, 200)}${stage === "coding" ? "" : stage === "queued" ? "（这一轮开始编码时带上）" : "（编码已结束，下一轮带上）"}` });
  return { runId: r.id, stage, note };
}

/** Notes for a running coder, appended to an omem tool result (steer.ts does the same for chat turns). */
export function takeCodeSteering(app: App, runId: string): string | null {
  const r = one<{ kind: string; status: string }>(app.db, "select kind, status from runs where id = ?", runId);
  if (r?.kind !== "code" || r.status !== "running") return null;
  const run = getRun(app, runId);
  if (roundStage(run) !== "coding") return null;
  const notes = pendingNotes(app, runId);
  if (!notes.length) return null;
  markNotesDelivered(app, runId, notes);
  addRunEvent(app, runId, "status", { text: `把 ${notes.length} 条本人补充交给了编码 Agent` });
  return `\n\n---\n${notesText(notes)}`;
}

/**
 * The review the delegation's rounds get from now on. The current round takes it too while its
 * review has not been planned yet; otherwise it starts with the next round.
 */
export function setRoundReview(app: App, runId: string, review: RoundReview) {
  const r = latestRound(app, runId);
  const current = r.status === "queued" || (r.status === "running" && !r.output.reviewPlan);
  const next = { ...((r.input.roundReview ?? {}) as RoundReview), ...review };
  // An empty tier is “back to choosing by the change”.
  if (!next.tier) delete next.tier;
  app.db.prepare("update runs set input = json_set(input, '$.roundReview', json(?)) where id = ?").run(JSON.stringify(next), r.id);
  return { runId: r.id, current, review: next };
}

/** Stop the delegation's running round (coding or review) and anything queued for it; no automatic round follows. */
export function stopCodeWork(app: App, runId: string, reason: string) {
  const r = latestRound(app, runId);
  const reviews = all<{ id: string }>(app.db, "select id from runs where kind = 'review' and status in ('queued', 'running') and json_extract(input, '$.codeRunId') = ?", r.id).map((x) => x.id);
  const live = [r.id, ...reviews].filter((id) => ["queued", "running"].includes(getRun(app, id).status));
  if (!live.length) return { runId: r.id, stopped: [] as string[] };
  setRunOutput(app, r.id, { stoppedByOwner: reason.trim() || "本人要求停下" });
  for (const id of live) cancelRun(app, id);
  return { runId: r.id, stopped: live };
}
