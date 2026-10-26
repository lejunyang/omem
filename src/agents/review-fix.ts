import { existsSync } from "node:fs";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { cancelHostAsks } from "./asks.ts";
import { isBranchReview, worktreesOf } from "./code.ts";
import { SEVERITY_LABEL, type FindingRow } from "./review.ts";
import { createRun, getRun, type Run } from "./runs.ts";

/**
 * What the owner does with a review's findings (docs/v2/review.md §6): each one is fixed now
 * (`fix`), left for later (`later`), or not changed at all (`wontfix`, with the business reason).
 * Later reviews of the same work are told about the last two so they stop raising them, and a
 * `wontfix` reason is a decision on the item's timeline. A fix starts from the chosen findings plus
 * whatever else the owner writes: a round of the same delegation, or coding on a reviewed branch.
 */
export type Decision = "fix" | "later" | "wontfix";
export const DECISION_LABEL: Record<Decision, string> = { fix: "要改", later: "暂不改", wontfix: "不改" };
type Row = FindingRow & { check_name: string; round: number; code_run_id: string; decision: Decision | null; decision_note: string };

/** The first round of the work a run belongs to, and every round since. */
export function workRuns(app: App, runId: string): string[] {
  const r = getRun(app, runId);
  const root = (r.input as { continueFrom?: string; codeRunId?: string }).continueFrom ?? (r.input as { codeRunId?: string }).codeRunId ?? r.id;
  return all<{ id: string }>(app.db, "select id from runs where id = ? or (kind = 'code' and json_extract(input, '$.continueFrom') = ?) order by created_at", root, root).map((x) => x.id);
}

function findingOf(app: App, runIds: string[], id: number) {
  const marks = runIds.map(() => "?").join(",");
  return one<Row>(app.db, `select f.*, r.check_name, r.round, r.code_run_id from review_findings f join reviews r on r.id = f.review_id where f.id = ? and r.code_run_id in (${marks})`, id, ...runIds);
}

export function setFindingDecision(app: App, runId: string, findingId: number, decision: Decision | null, note = "") {
  const f = findingOf(app, workRuns(app, runId), findingId);
  if (!f) throw new HttpError(404, `问题 #${findingId} 不属于这次交办或评审`);
  if (decision === "wontfix" && !note.trim()) throw new HttpError(400, "不改要写一句理由（业务上怎么定的）");
  run(app.db, "update review_findings set decision = ?, decision_note = ? where id = ?", decision, decision ? note.trim() : "", findingId);
  // A business decision outlives this review: it goes on the item, which later work reads.
  const itemId = (getRun(app, f.code_run_id).input as { itemId?: string }).itemId;
  if (decision === "wontfix" && itemId && one(app.db, "select 1 from items where id = ?", itemId)) {
    run(app.db, "insert into item_events(item_id, at, kind, text, source_refs, actor) values(?,?,?,?,?,?)", itemId, now(), "decision", `评审问题「${f.title}」不改：${note.trim()}`, "[]", "user");
  }
  return { id: findingId, decision, note: decision ? note.trim() : "" };
}

/** Findings the owner chose not to change now or at all, across the given work. */
export function ownerDecisions(app: App, runIds: string[]) {
  if (!runIds.length) return [];
  const marks = runIds.map(() => "?").join(",");
  return all<Row>(app.db, `select f.*, r.check_name, r.round, r.code_run_id from review_findings f join reviews r on r.id = f.review_id where r.code_run_id in (${marks}) and f.decision in ('later', 'wontfix') order by f.id`, ...runIds);
}

const where = (f: Pick<Row, "file_path" | "line">) => (f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""}` : "");

/** For a review's task: what the owner already decided, so the reviewers do not raise it again. */
export function decisionsBrief(app: App, runIds: string[], excludeIds: number[] = []) {
  const list = ownerDecisions(app, runIds).filter(f => !excludeIds.includes(f.id));
  if (!list.length) return "";
  return [
    "## 本人已经定了的问题",
    "下面这些本人看过评审后决定这次不改（“不改”是业务上的决定，附理由）。不要再把它们作为问题提出；只有改动让它们变得更严重、或理由已经不成立时才指出，并说明为什么。",
    ...list.map((f) => `- [${DECISION_LABEL[f.decision!]}] ${f.title}${where(f) ? `（${where(f)}）` : ""}${f.decision_note ? `：${f.decision_note}` : ""}`),
  ].join("\n");
}

/**
 * Start fixing a review's findings: the chosen ones (marked `fix`) and the owner's own text become
 * the task, with the findings left alone listed so the coder does not touch them. A delegation
 * continues as its next round; a reviewed branch is coded on (`fromBranches`), for the same item.
 */
export async function startFix(app: App, runId: string, req: { findingIds: number[]; text?: string }, userId: string): Promise<Run> {
  const runs = workRuns(app, runId);
  const last = getRun(app, runs.at(-1)!);
  if (!req.findingIds.length && !req.text?.trim()) throw new HttpError(400, "选几个要改的问题，或者写下要改什么");
  const chosen = req.findingIds.map((id) => findingOf(app, runs, id) ?? (() => { throw new HttpError(404, `问题 #${id} 不属于这次交办或评审`); })());
  const accepted = (next: Run) => {
    // Failed requests must leave the review's actions available for retry.
    for (const id of runs) cancelHostAsks(app, id, "review-done");
    for (const f of chosen) run(app.db, "update review_findings set decision = 'fix', decision_note = '' where id = ?", f.id);
    return next;
  };
  const task = [
    `# 按评审修改：${last.title}`,
    chosen.length ? `本人从评审（运行 ${runs[0]}）里选定要改的问题：\n\n${chosen.map((f, i) => [
      `${i + 1}. [${SEVERITY_LABEL[f.severity]}] ${f.title}${where(f) ? ` — ${where(f)}` : ""}`,
      f.detail && `   问题：${truncate(f.detail, 1500)}`,
      f.suggestion && `   建议：${truncate(f.suggestion, 1000)}`,
      f.triage_note && `   评审负责人：${f.triage_note}`,
    ].filter(Boolean).join("\n")).join("\n")}` : "",
    req.text?.trim() ? `## 本人补充的要求\n\n${req.text.trim()}` : "",
    decisionsBrief(app, runs, req.findingIds).replace("## 本人已经定了的问题", "## 这次不改的问题").replace(/下面这些[^\n]*/, "下面这些本人决定这次不改，不要动它们："),
  ].filter(Boolean).join("\n\n");

  const root = getRun(app, runs[0]);
  if (!isBranchReview(root)) {
    if (last.output.appliedAt || last.output.discardedAt) throw new HttpError(409, "这次交办已经应用或丢弃，工作区已释放；请重新交办");
    const { codeChainFor, queueNextCodeRound } = await import("./code-chain.ts");
    const chain = codeChainFor(app, last) ?? (last.output as { codeChain?: import("./code-chain.ts").CodeChain }).codeChain ?? null;
    if (!chain) return accepted(queueStandaloneFix(app, root.id, last.id, task, userId));
    const sessionId = runs.map((id) => (getRun(app, id).output as { coderSessionId?: string }).coderSessionId).filter(Boolean).at(-1);
    const next = queueNextCodeRound(app, chain, task, { resumeSessionId: sessionId, manual: true });
    if (!next) throw new HttpError(409, "原交办记录不完整，无法继续");
    return accepted(next.run);
  }
  const input = root.input as { repos?: string[]; branches?: Record<string, { branch: string }>; readSpaces?: string[]; itemId?: string; reviewTier?: string };
  const repos = input.repos ?? worktreesOf(app, root.id).map((w) => w.space);
  const r = createRun(app, {
    kind: "code",
    spaceId: root.spaceId,
    title: truncate(`按评审修改：${root.title}`, 80),
    input: {
      task,
      repos,
      fromBranches: Object.fromEntries(Object.entries(input.branches ?? {}).map(([space, b]) => [space, b.branch])),
      readSpaces: input.readSpaces,
      itemId: input.itemId,
      reviewTier: input.reviewTier,
      fromReview: root.id,
    },
    // Under the conversation that asked for the review, so progress and results go back there.
    parentId: root.parentId,
    userId,
  });
  const { codeChainFor } = await import("./code-chain.ts");
  codeChainFor(app, r);
  if (input.itemId && one(app.db, "select 1 from items where id = ?", input.itemId)) {
    const { linkRunToItem } = await import("../items/materials.ts");
    linkRunToItem(app, r, input.itemId, userId);
  }
  return accepted(r);
}

/** Web/CLI work has no conversation to report to, but still owns reusable worktrees. `extraInput`: a round of Git work (code-sync.ts). */
export function queueStandaloneFix(app: App, rootId: string, expectedLastId: string, task: string, userId: string, extraInput: Record<string, unknown> = {}): Run {
  app.db.exec("BEGIN IMMEDIATE");
  try {
    const rounds = workRuns(app, rootId).map(id => getRun(app, id));
    const last = rounds.at(-1)!;
    if (last.id !== expectedLastId || rounds.some(r => ["queued", "running"].includes(r.status)))
      throw new HttpError(409, `已有修改轮次 ${last.id}，请等待完成后继续`);
    if (rounds.some(r => r.output.appliedAt || r.output.discardedAt))
      throw new HttpError(409, "原交办已应用或丢弃，工作区已释放，不能续轮");
    const worktrees = worktreesOf(app, rootId);
    if (!worktrees.length || worktrees.some(w => !existsSync(w.path)))
      throw new HttpError(409, "原工作区缺失，不能续轮；请重新交办");
    const sessionId = rounds.map(r => r.output.coderSessionId).filter(Boolean).at(-1);
    const next = createRun(app, {
      kind: "code", spaceId: last.spaceId, userId,
      title: truncate(`交办第 ${rounds.length + 1} 轮：${task.split("\n")[0]}`, 80),
      // The last round's Git work is its own; this round does only what it is asked.
      input: { ...last.input, sync: undefined, syncOnly: undefined, syncResume: undefined, moveToTarget: undefined, ...extraInput, task, continueFrom: rootId, resumeSessionId: sessionId, round: rounds.length + 1 },
      parentId: last.parentId,
    });
    app.db.exec("COMMIT");
    return next;
  } catch (e) { if (app.db.isTransaction) app.db.exec("ROLLBACK"); throw e; }
}
