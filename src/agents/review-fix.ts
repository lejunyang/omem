import { existsSync } from "node:fs";
import type { App } from "../core/app.ts";
import { all, one, run } from "../core/db.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { cancelHostAsks, ROUND_ASKS } from "./asks.ts";
import { isBranchReview, worktreesOf } from "./code.ts";
import { SEVERITY_LABEL, type FindingRow } from "./review.ts";
import { createRun, getRun, type Run } from "./runs.ts";
import type { Execution } from "./execution.ts";
import type { RoundReview } from "./code-steer.ts";
import { OWNER } from "../core/users.ts";

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

/**
 * The owner rewrites a finding's suggestion so the coder does not misread the reviewer's: the
 * original stays, the next round gets the owner's version. An empty text goes back to the original.
 * A finding nobody decided on yet is then one to fix.
 */
export function setFindingSuggestion(app: App, runId: string, findingId: number, text: string) {
  const f = findingOf(app, workRuns(app, runId), findingId);
  if (!f) throw new HttpError(404, `问题 #${findingId} 不属于这次交办或评审`);
  const t = text.trim();
  run(app.db, "update review_findings set owner_suggestion = ? where id = ?", t && t !== f.suggestion.trim() ? t : null, findingId);
  if (t && !f.decision) run(app.db, "update review_findings set decision = 'fix', decision_note = '' where id = ?", findingId);
  const after = one<{ owner_suggestion: string | null; decision: Decision | null }>(app.db, "select owner_suggestion, decision from review_findings where id = ?", findingId)!;
  return { id: findingId, ownerSuggestion: after.owner_suggestion, decision: after.decision };
}

/**
 * A finding re-described (the owner could not follow it): a new title, detail and, when given,
 * suggestion, written after reading the code again. The reviewer's first wording stays in `revised`
 * (kept from the first rewrite on), shown under the new one.
 */
export function reviseFinding(app: App, runId: string, findingId: number, next: { title?: string; detail: string; suggestion?: string }) {
  const f = findingOf(app, workRuns(app, runId), findingId);
  if (!f) throw new HttpError(404, `问题 #${findingId} 不属于这次交办或评审`);
  const original = f.revised ?? JSON.stringify({ title: f.title, detail: f.detail, suggestion: f.suggestion, at: now() });
  const title = next.title?.trim() || f.title;
  const suggestion = next.suggestion?.trim() ? next.suggestion.trim() : f.suggestion;
  run(app.db, "update review_findings set title = ?, detail = ?, suggestion = ?, revised = ? where id = ?", title, next.detail.trim(), suggestion, original, findingId);
  return { id: findingId, title };
}

const bareBranch = (b: string) => b.replace(/^refs\/heads\//, "").replace(/^origin\//, "");

/** The branch each repository of a work is on: the reviewed branch, the one it started from, or the one it lands on. */
function workBranches(app: App, rootId: string): Record<string, string> {
  const input = getRun(app, rootId).input as { branches?: Record<string, { branch: string }>; fromBranches?: Record<string, string>; branchNames?: Record<string, string> };
  if (input.branches) return Object.fromEntries(Object.entries(input.branches).map(([s, b]) => [s, bareBranch(b.branch)]));
  const out: Record<string, string> = {};
  for (const w of worktreesOf(app, rootId)) {
    const b = input.fromBranches?.[w.space] ?? input.branchNames?.[w.space] ?? w.targetBranch ?? (w.commits ? w.branch : null);
    if (b) out[w.space] = bareBranch(b);
  }
  for (const [s, b] of Object.entries({ ...input.branchNames, ...input.fromBranches })) out[s] ??= bareBranch(b);
  return out;
}

type BranchWork = { rootId: string; latestId: string; title: string; rootTitle: string; branchReview: boolean; status: string; applied: boolean; appliedAt: string | null; createdAt: string };

/** Every other delegation and branch review of the last 30 days on a branch of this work, newest first (discarded ones left out). */
function branchWork(app: App, runId: string, userId: string): BranchWork[] {
  const rootId = workRuns(app, runId)[0];
  const mine = Object.entries(workBranches(app, rootId));
  if (!mine.length) return [];
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const roots = all<{ id: string }>(app.db, "select id from runs where kind = 'code' and id != ? and json_extract(input, '$.continueFrom') is null and coalesce(user_id, ?) = ? and created_at > ? order by created_at desc limit 100", rootId, OWNER, userId, since);
  const out: BranchWork[] = [];
  for (const { id } of roots) {
    const theirs = workBranches(app, id);
    if (!mine.some(([space, b]) => theirs[space] === b)) continue;
    const rounds = workRuns(app, id).map((x) => getRun(app, x));
    if (rounds.some((r) => r.output.discardedAt)) continue;
    const last = rounds.at(-1)!;
    out.push({ rootId: id, latestId: last.id, title: last.title, rootTitle: rounds[0].title, branchReview: isBranchReview(rounds[0]), status: last.status, applied: rounds.some((r) => r.output.appliedAt), appliedAt: (rounds.map((r) => r.output.appliedAt as string | undefined).filter(Boolean).at(-1)) ?? null, createdAt: rounds[0].createdAt });
  }
  return out;
}

/**
 * The other unfinished delegations and branch reviews on the same branch of the same repositories
 * (two reviews of one branch, by different AIs): their findings can be fixed in one go.
 */
export function sameBranchWork(app: App, runId: string, userId: string) {
  return branchWork(app, runId, userId).filter((w) => !w.applied).map(({ rootId, latestId, title, branchReview }) => ({ rootId, latestId, title, branchReview }));
}

/**
 * The newest code on the branch beyond what this review saw: a delegation started after it, or (for a
 * branch review) one still holding unapplied changes to the branch. Questions and fixes from this
 * older review look at that code. Other branch reviews change no code and do not count.
 */
export function newerWork(app: App, runId: string, userId: string) {
  const root = getRun(app, workRuns(app, runId)[0]);
  const review = isBranchReview(root);
  const w = branchWork(app, runId, userId).find((x) => !x.branchReview && (x.createdAt > root.createdAt || (review && !x.applied)));
  return w ? { rootId: w.rootId, latestId: w.latestId, title: w.rootTitle, branchReview: w.branchReview, status: w.status, applied: w.applied } : null;
}

/** Whether a round has a requirement split: its own (req-split / submit_change_points) or one a check gave. */
function hasSplit(app: App, r: Run) {
  if (((r.output as { changePoints?: { points?: unknown[] } }).changePoints?.points ?? []).length) return true;
  return !!one(app.db, "select 1 from reviews where code_run_id = ? and change_points is not null and change_points not in ('', '[]')", r.id);
}

/**
 * The requirement split to show for a round that has none of its own (a fix round reviewed without
 * one, a delegation that only changes code style): the latest earlier round of the same work with a
 * split, else the latest round with one in other work on the branch (its branch reviews). Shown with
 * that round's code, since the split's locations point there.
 */
export function inheritedSplit(app: App, runId: string, userId: string) {
  const own = workRuns(app, runId);
  const upTo = own.indexOf(runId);
  const earlier = own.slice(0, upTo < 0 ? own.length : upTo).reverse();
  const candidates = [...earlier.map((id) => ({ id, rootId: own[0] })), ...branchWork(app, runId, userId).flatMap((w) => workRuns(app, w.rootId).reverse().map((id) => ({ id, rootId: w.rootId })))];
  for (const c of candidates) {
    const r = getRun(app, c.id);
    if (!hasSplit(app, r)) continue;
    const root = getRun(app, c.rootId);
    return { runId: r.id, rootId: root.id, title: root.title, round: (r.input as { round?: number }).round ?? 1, sameWork: c.rootId === own[0], branchReview: isBranchReview(root) };
  }
  return null;
}

/**
 * Findings of this review that later work on the branch took on (`by`: a round of it) — set when a
 * fix chooses them, or by the owner for work started elsewhere. `by: null` puts them back to open.
 */
export function markFindingsFixed(app: App, runId: string, findingIds: number[], by: string | null, userId: string) {
  const runs = workRuns(app, runId);
  for (const id of findingIds) if (!findingOf(app, runs, id)) throw new HttpError(404, `问题 #${id} 不属于这次交办或评审`);
  if (by) {
    const target = one<{ id: string; kind: string }>(app.db, "select id, kind from runs where id = ?", by);
    const ok = !!target && target.kind === "code" && (runs.includes(by) || branchWork(app, runId, userId).some((w) => workRuns(app, w.rootId).includes(by)));
    if (!ok) throw new HttpError(400, `${by} 不是同一分支上的编码`);
  }
  for (const id of findingIds) run(app.db, "update review_findings set fixed_by = ? where id = ?", by, id);
  return { ids: findingIds, by };
}

/** The rounds findings were handed to, as a review shows them (修改中 / 已修改 / 已应用; a discarded one no longer counts). */
export function fixedByInfo(app: App, runIds: string[]) {
  const out: Record<string, { rootId: string; title: string; status: string; applied: boolean; discarded: boolean }> = {};
  for (const id of new Set(runIds)) {
    if (!one(app.db, "select 1 from runs where id = ?", id)) continue;
    const rounds = workRuns(app, id).map((x) => getRun(app, x));
    const round = rounds.find((x) => x.id === id) ?? rounds.at(-1)!;
    out[id] = { rootId: rounds[0].id, title: rounds[0].title, status: round.status, applied: rounds.some((x) => x.output.appliedAt), discarded: rounds.some((x) => x.output.discardedAt) };
  }
  return out;
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
/**
 * An unapplied delegation that still holds a worktree for one of these repositories and lands on
 * `branch`. New work on that branch continues there instead of opening a second worktree: two
 * delegations changing one branch side by side end with the owner merging them by hand.
 */
export function openDelegationOn(app: App, repos: string[], branch: string | null | undefined, userId: string): Run | null {
  if (!branch) return null;
  const want = branch.replace(/^refs\/heads\//, "").replace(/^origin\//, "");
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const roots = all<{ id: string }>(app.db, "select id from runs where kind = 'code' and json_extract(input, '$.continueFrom') is null and json_extract(input, '$.branches') is null and json_extract(output, '$.appliedAt') is null and json_extract(output, '$.discardedAt') is null and coalesce(user_id, ?) = ? and created_at > ? order by created_at desc limit 50", OWNER, userId, since);
  for (const { id } of roots) {
    if (!worktreesOf(app, id).some((w) => repos.includes(w.space) && w.targetBranch === want && (w.commits || existsSync(w.path)))) continue;
    const rounds = workRuns(app, id).map((x) => getRun(app, x));
    if (rounds.some((x) => x.output.appliedAt || x.output.discardedAt)) continue;
    return rounds.at(-1)!;
  }
  return null;
}

// `withSameBranch`: the owner looked at the other reviews of the same branch too (sameBranchWork); their findings may be chosen, and what is left there waits as well.
export async function startFix(app: App, runId: string, req: { findingIds: number[]; text?: string; review?: RoundReview; reviewExecution?: Execution; applyFirst?: boolean; withSameBranch?: boolean }, userId: string): Promise<Run> {
  const runs = workRuns(app, runId);
  const last = getRun(app, runs.at(-1)!);
  if (!req.findingIds.length && !req.text?.trim()) throw new HttpError(400, "选几个要改的问题，或者写下要改什么");
  const others = req.withSameBranch ? sameBranchWork(app, runId, userId) : [];
  const pool = [...runs, ...others.flatMap((o) => workRuns(app, o.rootId))];
  const chosen = req.findingIds.map((id) => findingOf(app, pool, id) ?? (() => { throw new HttpError(404, `问题 #${id} 不属于这次交办或评审，也不属于同一分支的其他评审`); })());
  const accepted = (next: Run) => {
    // Failed requests must leave the review's actions available for retry. The other reviews of the
    // branch taken up here are answered too: what was not picked from them waits (“暂不改”).
    for (const id of [...runs, ...others.flatMap((o) => workRuns(app, o.rootId))]) cancelHostAsks(app, id, ROUND_ASKS);
    // Each chosen finding remembers the round that takes it on, so its review (when that is another
    // one of the branch, or an older one opened later) shows it as being fixed rather than open.
    for (const f of chosen) run(app.db, "update review_findings set decision = 'fix', decision_note = '', fixed_by = ? where id = ?", next.id, f.id);
    // What the owner left unpicked waits (“暂不改”) and stays in view in the rounds after this one.
    for (const latest of [last.id, ...others.map((o) => o.latestId)])
      run(app.db, `update review_findings set decision = 'later' where decision is null and severity != 'nit' and state in ('open', 'accepted') and review_id in (select id from reviews where code_run_id = ?)${chosen.length ? ` and id not in (${chosen.map(() => "?").join(",")})` : ""}`, latest, ...chosen.map((f) => f.id));
    return next;
  };
  const task = [
    `# 按评审修改：${last.title}`,
    chosen.length ? `本人从评审（运行 ${runs[0]}${others.length ? `，以及同一分支的 ${others.map((o) => o.rootId).join("、")}` : ""}）里选定要改的问题：\n\n${chosen.map((f, i) => [
      `${i + 1}. [${SEVERITY_LABEL[f.severity]}] ${f.title}${where(f) ? ` — ${where(f)}` : ""}`,
      f.detail && `   问题：${truncate(f.detail, 1500)}`,
      f.owner_suggestion?.trim() ? `   建议（本人改写，以此为准）：${truncate(f.owner_suggestion.trim(), 2000)}` : f.suggestion && `   建议：${truncate(f.suggestion, 1000)}`,
      f.triage_note && `   评审负责人：${f.triage_note}`,
    ].filter(Boolean).join("\n")).join("\n")}` : "",
    req.text?.trim() ? `## 本人补充的要求\n\n${req.text.trim()}` : "",
    decisionsBrief(app, pool, req.findingIds).replace("## 本人已经定了的问题", "## 这次不改的问题").replace(/下面这些[^\n]*/, "下面这些本人决定这次不改，不要动它们："),
  ].filter(Boolean).join("\n\n");

  const root = getRun(app, runs[0]);
  const input = root.input as { repos?: string[]; branches?: Record<string, { branch: string }>; readSpaces?: string[]; itemId?: string; reviewTier?: string };
  const branchReview = isBranchReview(root);
  const repos = input.repos ?? worktreesOf(app, root.id).map((w) => w.space);
  // A reviewed branch that a delegation is already changing: the fix is that delegation's next round.
  const into = branchReview ? openDelegationOn(app, repos, Object.values(input.branches ?? {})[0]?.branch, userId) : last;
  if (into && branchReview && ["queued", "running"].includes(into.status))
    throw new HttpError(409, `交办 ${into.id}（${into.title}）正在改同一个分支，等这一轮结束再改；要马上加要求，补充给正在编码的 Agent（运行页“补充”或 message_code_run）`);
  if (req.applyFirst && (!into || into !== last)) throw new HttpError(400, "分支评审没有可应用的改动；先应用要在交办编码上做");
  if (into) {
    if (into.output.appliedAt || into.output.discardedAt) throw new HttpError(409, "这次交办已经应用或丢弃，工作区已释放；请重新交办");
    // “先应用到原分支，再接着改”: the owner gets what is done now; the next round goes on in the same worktree.
    if (req.applyFirst) (await import("./code.ts")).applyCodeRun(app, into.id, { keepWorking: true });
    const { codeChainFor, queueNextCodeRound } = await import("./code-chain.ts");
    const chain = codeChainFor(app, into) ?? (into.output as { codeChain?: import("./code-chain.ts").CodeChain }).codeChain ?? null;
    // Work on the branch that landed after this delegation started (another delegation applied):
    // bring it in before coding, so the fix is made on the latest code.
    const landed = !branchReview && branchWork(app, into.id, userId).some((w) => !!w.appliedAt && w.appliedAt > root.createdAt);
    // The owner starts this round here: this machine's coding and review Agents do it, also when an
    // outside Agent coded or reviewed the rounds before (their peerCoder / peerReviewer stay behind).
    const extraInput = { ...(branchReview ? { fromReview: root.id } : {}), ...(req.reviewExecution ? { reviewExecution: req.reviewExecution } : {}), ...(landed ? { sync: { pull: true } } : {}), peerCoder: undefined, peerReviewer: undefined };
    const intoRuns = workRuns(app, into.id);
    // Fixing chosen findings: the next round re-reviews only the checks that raised them, and every
    // check every `rereviewAllEvery` rounds (as when review-lead names them). The owner's own words,
    // or the checks the owner picked for the next rounds, leave the plan as it is.
    const every = app.config.review.rereviewAllEvery;
    const reviewOnly = chosen.length && !req.text?.trim() && !req.review?.checks?.length && (intoRuns.length + 1) % every !== 0 ? [...new Set(chosen.map((f) => f.check_name))] : undefined;
    if (!chain) return accepted(queueStandaloneFix(app, intoRuns[0], into.id, task, userId, { ...extraInput, ...(req.review ? { roundReview: req.review } : {}), reviewOnly }));
    const sessionId = intoRuns.map((id) => (getRun(app, id).output as { coderSessionId?: string }).coderSessionId).filter(Boolean).at(-1);
    const next = queueNextCodeRound(app, chain, task, { resumeSessionId: sessionId, manual: true, roundReview: req.review, reviewExecution: req.reviewExecution, reviewOnly, extraInput });
    if (!next) throw new HttpError(409, "原交办记录不完整，无法继续");
    return accepted(next.run);
  }
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
      roundReview: req.review,
      reviewExecution: req.reviewExecution,
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

/**
 * Cards about rounds the work has moved past, left open by versions that only closed the result card
 * of the review a fix started from: a later round of the same work, an apply or a discard, or findings
 * other work on the branch took up. Run at start; returns how many were closed.
 */
export function sweepRoundAsks(app: App): number {
  const open = all<{ id: string; run_id: string | null }>(app.db, `select id, run_id from asks where status = 'pending' and json_extract(context, '$.handler') in (${ROUND_ASKS.map(() => "?").join(",")})`, ...ROUND_ASKS);
  const stale = new Set<string>();
  for (const a of open) {
    if (!a.run_id || !one(app.db, "select 1 from runs where id = ? and kind = 'code'", a.run_id)) continue;
    const rounds = workRuns(app, a.run_id).map((id) => getRun(app, id));
    const taken = one(app.db, "select 1 from review_findings f join reviews v on v.id = f.review_id where v.code_run_id = ? and f.fixed_by is not null", a.run_id);
    if (rounds.at(-1)!.id !== a.run_id || rounds.some((r) => r.output.appliedAt || r.output.discardedAt) || taken) stale.add(a.run_id);
  }
  for (const id of stale) cancelHostAsks(app, id, ROUND_ASKS);
  return stale.size;
}

/**
 * A round left waiting for an outside Agent to code (peer-code.ts) that the owner wants done here:
 * the same task as the next round, coded and reviewed by this machine's Agents. Findings handed to
 * the waiting round move to the new one.
 */
export function codeHere(app: App, runId: string, userId: string): Run {
  const r = getRun(app, runId);
  if (r.kind !== "code" || r.output.verdict !== "awaiting-peer-code") throw new HttpError(409, "这一轮不是在等外部 Agent 编码");
  const rootId = String(r.input.continueFrom ?? r.id);
  const next = queueStandaloneFix(app, rootId, r.id, String(r.input.task ?? ""), userId, { reviewOnly: r.input.reviewOnly, peerCoder: undefined, peerReviewer: undefined });
  run(app.db, "update review_findings set fixed_by = ? where fixed_by = ?", next.id, r.id);
  return next;
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
      input: { ...last.input, sync: undefined, syncOnly: undefined, syncResume: undefined, moveToTarget: undefined, reviewOnly: undefined, peerFinished: undefined, ...extraInput, task, continueFrom: rootId, resumeSessionId: sessionId, round: rounds.length + 1 },
      parentId: last.parentId,
    });
    app.db.exec("COMMIT");
    // The work moved on: what the earlier rounds asked the owner (plan, result, a stop) is answered.
    for (const r of rounds) cancelHostAsks(app, r.id, ROUND_ASKS);
    return next;
  } catch (e) { if (app.db.isTransaction) app.db.exec("ROLLBACK"); throw e; }
}
