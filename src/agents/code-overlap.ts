import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import type { RoleName } from "../core/config.ts";
import { run as sql } from "../core/db.ts";
import { git } from "../core/git.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { checkCommandOf, latestCheck, worktreesOf } from "./code.ts";
import { addRoundFeedback, takeRoundFeedback, type RoundReview } from "./code-steer.ts";
import {
  getTask, headsAt, lastRound, listTasks, setWorkState, tasksFromRuling, isLater, taskLabel, taskList, taskText, updateTask, workRootOf, workState,
  type CodeTask, type LookState,
} from "./code-tasks.ts";
import type { Execution } from "./execution.ts";
import { reviewContext, taskCheckBrief, TASK_RULING } from "./review-chain.ts";
import { checkBrief, checkLabel, isLook, lookBase, lookName, recordReview, reviewChecks, reviewFor, roundFindings, SEVERITY_LABEL, type LeadResult, type ReviewPlan } from "./review.ts";
import { runRole } from "./runner.ts";
import { addRunEvent, createRun, flushRunText, getRun, runUser, setRunOutput, trackAbort, type Run } from "./runs.ts";
import { readAgentSpec } from "./specs.ts";
import { replyOf, type AgentEvent } from "./types.ts";
import { retireRecordedSession } from "./session-cleanup.ts";
import type { WorktreeRef } from "./worktree-index.ts";
import { workDirOf } from "./workspaces.ts";

/**
 * Review overlapping the coding of a task-driven delegation (docs/v2/coding-loop.md §13 第四阶段):
 *
 * - a round's own tasks are verified while its coder codes on: once every task a check raised in
 *   this round is finished, that check verifies them; what is not fixed comes back to the coder in the
 *   same round (at its next omem tool call, or one more turn when its turn has ended);
 * - after a stage review, other models can look at the same stretch again (a second look: the check
 *   under its look name `<check>@复看`, on a model of `review.rotation` chosen once per work, its own
 *   session) while the next round fixes what the first look found; review-lead routes what it adds,
 *   and new tasks join the round coding then.
 *
 * Reviewers read a snapshot (a detached worktree at the commits under review), not the worktrees the
 * coder is editing. A check's session takes one turn at a time (`withCheck`).
 */

// ---- a check's session --------------------------------------------------------------------------

const turns = new Map<string, Promise<unknown>>();

/** One turn at a time in a check's session for this work: verifying, answering the coder, looking again. */
export function withCheck<T>(rootId: string, check: string, fn: () => Promise<T>): Promise<T> {
  const key = `${rootId}\n${check}`;
  const next = (turns.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => {}, () => {});
  turns.set(key, tail);
  void tail.then(() => {
    if (turns.get(key) === tail) turns.delete(key);
  });
  return next;
}

/** A check's session for this work, unless it has grown past the resume limit. */
export function sessionOf(app: App, rootId: string, check: string) {
  const s = workState(app, rootId).sessions?.[check];
  if (!s) return undefined;
  return s.used !== undefined && s.used > app.config.sessions.codeResumeMaxTokens ? undefined : s.id;
}
export function keepSession(app: App, rootId: string, check: string, id: string | undefined, used: number | undefined) {
  if (!id) return;
  const w = workState(app, rootId);
  setWorkState(app, rootId, { sessions: { ...(w.sessions ?? {}), [check]: { id, ...(used !== undefined ? { used } : {}) } } });
  const old = w.sessions?.[check];
  if (old && old.id !== id) void retireRecordedSession(app, old.id, e => addRunEvent(app, rootId, e.type, e))
    .catch(e => console.warn("[omem] 登记旧评审会话清理失败：", (e as Error).message));
}

const aiText = (ai?: { profile: string; model?: string }) => (ai ? [ai.profile, ai.model].filter(Boolean).join(" · ") : "");

/**
 * How a check runs for this work: its role or spec, in its session; the owner's review AI for
 * `reviewer`; a second look on the model chosen for it.
 */
export function checkArgs(app: App, rootId: string, check: string, run: Run) {
  const base = lookBase(check);
  const info = reviewChecks(app).find((c) => c.name === base);
  if (!info || info.missing) throw new HttpError(404, `评审项 ${base} 已经不在了`);
  const ai = isLook(check) ? workState(app, rootId).lookAI?.[base] : undefined;
  if (isLook(check) && !ai) throw new HttpError(409, `${check} 还没有选定模型`);
  const execution: Execution | undefined = ai
    ? { ...ai, source: "user", reason: "评审设置里的轮换模型：换模型复看" }
    : base === "reviewer" ? (run.input as { reviewExecution?: Execution }).reviewExecution : undefined;
  return {
    role: (info.builtin ? base : "reviewer") as RoleName,
    ...(info.builtin ? {} : { spec: readAgentSpec(app, base) }),
    reviewCheck: true,
    ...(isLook(check) ? { checkName: check } : {}),
    ...(execution ? { execution } : { profileId: info.builtin ? app.config.agents.roles[base] : undefined }),
    resumeSessionId: sessionOf(app, rootId, check),
    persistSession: true,
  };
}

type CheckTurn = { run: Run; task: string; cwd?: string; spaces: string[]; indexed: string[]; runId: string; signal: AbortSignal; onEvent: (e: AgentEvent) => void; addTools?: string[] };

/** One turn of a check for this work (checkArgs), its session kept for the next. */
export function runCheck(app: App, rootId: string, check: string, t: CheckTurn) {
  return withCheck(rootId, check, async () => {
    const res = await runRole(app, {
      ...checkArgs(app, rootId, check, t.run),
      ...(t.addTools ? { addTools: t.addTools } : {}),
      spaceId: t.run.spaceId!,
      spaces: t.spaces,
      alsoRead: t.indexed,
      task: t.task,
      runId: t.runId,
      cwd: t.cwd,
      signal: t.signal,
      onEvent: t.onEvent,
    });
    keepSession(app, rootId, check, res.sessionId, res.contextUsage?.used);
    return res;
  });
}

/** What a check of this work may read, without the round's diff (that is reviewContext's). */
export async function checkScope(app: App, run: Run) {
  const rootId = workRootOf(app, run.id);
  const worktrees = worktreesOf(app, rootId);
  const input = run.input as { readSpaces?: string[]; itemId?: string };
  const { materialSpaces } = await import("../items/materials.ts");
  const spaces = [...new Set([run.spaceId!, ...worktrees.map((w) => w.space), ...(input.readSpaces ?? []), ...(input.itemId ? materialSpaces(app, input.itemId, runUser(app, run.id)) : [])])];
  const indexed = (run.output.indexedSpaces ?? getRun(app, rootId).output.indexedSpaces ?? []) as string[];
  const infos = new Map(reviewChecks(app).map((c) => [c.name, c]));
  const multi = worktrees.length > 1;
  return { rootId, worktrees, multi, cwd: multi ? join(app.runsDir, rootId, "work") : worktrees[0] && workDirOf(worktrees[0]), spaces, indexed, infos, label: (n: string) => checkLabel(infos, n) };
}

// ---- snapshots ------------------------------------------------------------------------------------

/**
 * The commits under review checked out where nobody edits them: a detached worktree per repository
 * under `base` (HEAD of each worktree, or `heads`), so a check reads what it judges while the coder
 * goes on in the work's own worktrees. `release` removes them.
 */
export function snapshot(worktrees: WorktreeRef[], base: string, heads?: Record<string, string>) {
  mkdirSync(base, { recursive: true });
  const made: { from: string; path: string }[] = [];
  const dirs: Record<string, string> = {};
  const release = () => {
    for (const m of made.splice(0)) drop(m.from, m.path);
  };
  try {
    for (const wt of worktrees) {
      const from = workDirOf(wt);
      const at = heads?.[wt.space] ?? git(from, ["rev-parse", "HEAD"]).stdout.trim();
      const path = join(base, wt.space);
      if (existsSync(path)) drop(from, path);
      // No hooks: what a post-checkout hook does (installing, building) is not what reading needs.
      const r = git(from, ["-c", `core.hooksPath=${join(base, ".no-hooks")}`, "worktree", "add", "--detach", "--force", path, at]);
      if (!r.ok) throw new Error(`没能取出 ${wt.space} 的快照：${truncate(r.stderr.trim(), 300)}`);
      made.push({ from, path });
      dirs[wt.space] = path;
    }
  } catch (e) {
    release();
    throw e;
  }
  return { dirs, cwd: worktrees.length > 1 ? base : dirs[worktrees[0].space], release };
}

/**
 * Remove a snapshot, never throwing. The check's agent may still be running there (a kept session's
 * process has it as its working directory, which Windows will not delete): tried again a few times later.
 */
function drop(from: string, path: string, tries = 0) {
  git(from, ["worktree", "remove", "--force", path]);
  try {
    rmSync(path, { recursive: true, force: true });
    git(from, ["worktree", "prune"]);
  } catch {
    if (tries < 5) setTimeout(() => drop(from, path, tries + 1), 60_000 * (tries + 1)).unref();
  }
}

// ---- verifying ------------------------------------------------------------------------------------

export const VERIFY_BRIEF = [
  "# 验证修改项",
  "下面是你之前提的问题，编码 Agent 说已经改了。逐项读这一项的改动（必要时在工作区里看完整的代码），判断问题是不是真的解决了、有没有改出新问题，然后调用一次 `verify_tasks` 给每一项一个结论：",
  "- fixed：解决了；",
  "- not_fixed：没解决或只解决了一部分，note 写还差什么、该怎么改（交回编码 Agent 再改）；",
  "- regressed：这一项的改动本身带来了新问题，note 写清是什么和证据（会先回退这一项再重做）；",
  "- withdrawn：重新看过，问题本身不成立，note 写理由。",
  "编码 Agent 对问题有异议时，说明里会写它的理由：理由成立就 withdrawn，不成立就 not_fixed 并回应它的理由。",
  "只看这些修改项相关的改动；整份改动之后还有阶段评审，别的问题留给那时。",
].join("\n");
const SNAPSHOT_NOTE = "工作区是这些提交的快照（只读）；编码 Agent 同时在别处接着改别的项，你看到的是提交了的代码。";

/**
 * What a verification knows about the project's checks for its tasks: the host's last check when it
 * ran on their commits, else that none has yet (the round's own runs when its coding ends, and the
 * stage review reads it). What the coder said it ran is in its notes on each task.
 */
export function verifyChecks(app: App, rootId: string, run: Run, worktrees: WorktreeRef[], tasks: CodeTask[]): string {
  const multi = worktrees.length > 1;
  const lines = worktrees.flatMap((wt) => {
    const shas = tasks.flatMap((t) => t.commits[wt.space]?.slice(-1) ?? []);
    if (multi && !shas.length) return [];
    const head = multi ? `### ${wt.space}\n\n` : "";
    const dir = workDirOf(wt);
    const where = `编码工作区（依赖和构建产物在这里）：${dir}`;
    const command = checkCommandOf(app, run, wt.space);
    if (!command) return [`${head}仓库没有设检查命令：只有编码 Agent 在说明里写的验证，宿主没有复核。\n${where}`];
    const last = latestCheck(app, rootId, wt.space);
    const covers = !!last?.commit && shas.length > 0 && shas.every((s) => git(dir, ["merge-base", "--is-ancestor", s, last.commit!]).ok);
    if (!covers) return [`${head}这些项提交以后宿主还没跑过检查命令（${command}）：这一轮编码结束时会在编码工作区跑，阶段评审核对它的结果。\n${where}`];
    return [`${head}宿主的检查（${command}）跑在提交 ${last!.commit!.slice(0, 8)}，包含这些项的提交：退出码 ${last!.code}\n${where}\n\n\`\`\`\n${last!.output.slice(-3000)}\n\`\`\``];
  });
  return `## 检查结果\n\n${lines.join("\n\n") || "（没有对应的提交）"}`;
}

/** A check verifies its tasks (verify_tasks); one it gives no verdict on is left to the stage review. */
export async function verifyGroup(app: App, o: { run: Run; check: string; tasks: CodeTask[]; runId: string; signal: AbortSignal; event: (type: string, data: unknown) => void; cwd?: string; snapshot?: boolean }) {
  const scope = await checkScope(app, o.run);
  const { rootId } = scope;
  const info = scope.infos.get(lookBase(o.check));
  if (!info || info.missing) {
    for (const t of o.tasks) updateTask(app, rootId, t.seq, { state: "done" }, { by: "host", kind: "host", text: `评审项 ${o.check} 已经不在了，没有逐项验证，交给阶段评审` });
    return;
  }
  const parts = o.tasks.map((t) => {
    const said = t.notes.filter((n) => n.kind === "coder").at(-1)?.text;
    const diff = scope.worktrees.map((wt) => {
      const shas = t.commits[wt.space] ?? [];
      if (!shas.length) return "";
      const body = git(workDirOf(wt), ["diff", "--no-color", `${shas[0]}^`, shas.at(-1)!]).stdout;
      return body.trim() ? `${scope.multi ? `#### ${wt.space}\n\n` : ""}\`\`\`diff\n${truncate(body, 30000)}\n\`\`\`` : "";
    }).filter(Boolean).join("\n\n");
    return [taskText(app, t), said ? `编码 Agent 的说明：${truncate(said, 2000)}` : "", diff ? `#### 这一项的改动\n\n${diff}` : "（这一项没有找到对应的提交，在工作区里看现在的代码）"].filter(Boolean).join("\n\n");
  });
  try {
    await runCheck(app, rootId, o.check, {
      run: o.run,
      task: `${VERIFY_BRIEF}${o.snapshot ? `\n${SNAPSHOT_NOTE}` : ""}\n\n${parts.join("\n\n")}\n\n${verifyChecks(app, rootId, o.run, scope.worktrees, o.tasks)}`,
      cwd: o.cwd ?? scope.cwd,
      spaces: scope.spaces,
      indexed: scope.indexed,
      runId: o.runId,
      signal: o.signal,
      addTools: ["verify_tasks"],
      onEvent: (e) => o.event(e.type, { ...e, phase: "reviewer", check: o.check, verify: true }),
    });
  } catch (e) {
    if (o.signal.aborted) throw e;
    o.event("status", { text: `${scope.label(o.check)}没能完成验证：${(e as Error).message}` });
  }
  for (const t of o.tasks) if (getTask(app, rootId, t.seq).state === "verify") updateTask(app, rootId, t.seq, { state: "done" }, { by: "host", kind: "host", text: `${scope.label(o.check)}没有给出验证结论，交给阶段评审` });
}

/** A round coding now, in this process: what its checks verify meanwhile and what comes back to it. */
type OpenRound = {
  rootId: string;
  event: (type: string, data: unknown) => void;
  signal: AbortSignal;
  /** Tasks not fixed come back to this round (the coder is still at it, or gets one more turn). */
  accepting: boolean;
  /** Per check: the verification running or waiting; `waiting` checks collect their tasks when they start. */
  chains: Map<string, Promise<void>>;
  waiting: Set<string>;
  running: Set<Promise<void>>;
  /** Tasks brought back to this round, with where the branches were then. */
  back: Map<number, Record<string, string>>;
  snaps: number;
};
const open = new Map<string, OpenRound>();

const headsNow = (app: App, rootId: string) => Object.fromEntries(worktreesOf(app, rootId).map((w) => [w.space, git(workDirOf(w), ["rev-parse", "HEAD"]).stdout.trim()]));

/** code.ts, before the coder's first turn of a task-driven round. */
export function openRound(app: App, runId: string, ctx: { event: (type: string, data: unknown) => void; signal: AbortSignal }) {
  open.set(runId, { rootId: workRootOf(app, runId), ...ctx, accepting: true, chains: new Map(), waiting: new Set(), running: new Set(), back: new Map(), snaps: 0 });
}

/**
 * finish_task (or a first objection) by the round's own coder: when none of the tasks this round has
 * from the same check is still being coded, that check verifies them now. True when it started.
 */
export function taskFinished(app: App, roundRunId: string, seq: number): boolean {
  const r = open.get(roundRunId);
  if (!r || !r.accepting) return false;
  const t = getTask(app, r.rootId, seq);
  if (t.state !== "verify" || !t.verifier) return false;
  if (listTasks(app, r.rootId).some((x) => x.coderRun === roundRunId && x.verifier === t.verifier && x.state === "coding")) return false;
  verifyNow(app, roundRunId, r, t.verifier);
  return true;
}

function verifyNow(app: App, runId: string, r: OpenRound, check: string) {
  if (r.waiting.has(check)) return;
  r.waiting.add(check);
  const step = (r.chains.get(check) ?? Promise.resolve()).then(async () => {
    r.waiting.delete(check);
    const tasks = listTasks(app, r.rootId).filter((x) => x.coderRun === runId && x.verifier === check && x.state === "verify");
    if (!tasks.length || r.signal.aborted) return;
    const snap = snapshot(worktreesOf(app, r.rootId), join(app.runsDir, runId, "snap", `v${++r.snaps}`));
    try {
      r.event("status", { text: `${checkLabel(new Map(reviewChecks(app).map((c) => [c.name, c])), check)}验证 ${tasks.map((t) => taskLabel(t.seq)).join("、")}（编码 Agent 接着做别的项）` });
      await verifyGroup(app, { run: getRun(app, runId), check, tasks, runId, signal: r.signal, event: r.event, cwd: snap.cwd, snapshot: true });
    } finally {
      snap.release();
    }
    afterVerify(app, runId, r, tasks);
  }).catch((e) => {
    if (!r.signal.aborted) r.event("status", { text: `${check} 的验证没有完成：${(e as Error).message}` });
  });
  r.chains.set(check, step);
  r.running.add(step);
  void step.finally(() => r.running.delete(step));
}

/** What the coder hears about tasks a check just verified; not fixed ones come back to this round when it still takes them. */
function afterVerify(app: App, runId: string, r: OpenRound, tasks: CodeTask[]) {
  const reverting = new Set((workState(app, r.rootId).reverts ?? []).map((x) => x.seq));
  for (const before of tasks) {
    const t = getTask(app, r.rootId, before.seq);
    const said = t.notes.filter((n) => n.kind === "verify").at(-1)?.text ?? "";
    const head = `${taskLabel(t.seq)}「${truncate(t.title, 60)}」${said ? `：${truncate(said, 1500)}` : ""}`;
    if (t.state === "todo" && reverting.has(t.seq)) addRoundFeedback(runId, `- ${head}\n  下一轮开始时先回退这一项再重做，这一轮不要再改它。`);
    else if (t.state === "todo" && r.accepting) {
      bringBack(app, runId, r, t.seq, "验证没过，交回这一轮接着改");
      addRoundFeedback(runId, `- ${head}\n  在这一轮接着改，改完照常提交、finish_task。`);
    } else if (t.state === "assistant" || t.state === "owner") addRoundFeedback(runId, `- ${head}\n  试了几次还没改好，交给了${t.state === "assistant" ? "发起交办的助手" : "本人"}，这一轮跳过它。`);
  }
}

function bringBack(app: App, runId: string, r: OpenRound, seq: number, text: string) {
  r.back.set(seq, headsNow(app, r.rootId));
  updateTask(app, r.rootId, seq, { state: "coding", coderRun: runId }, { by: "host", kind: "host", text });
}

/**
 * The coder's turn ended. With `more` (one more turn may follow): its finished tasks not verified yet
 * are verified now and what is not fixed comes back; without: only the verifications running are
 * waited for, and what they send back waits for the next round. Returns what the next turn is told
 * when the round still has tasks to code: ones that came back (not fixed, or new from a second look)
 * and ones it has not got to yet (a coder often stops after one or two of them).
 */
export async function settleTurn(app: App, runId: string, more: boolean): Promise<string | null> {
  const r = open.get(runId);
  if (!r) return null;
  r.accepting = more;
  if (more) {
    const checks = new Set(listTasks(app, r.rootId).filter((x) => x.coderRun === runId && x.state === "verify" && x.verifier).map((x) => x.verifier!));
    for (const c of checks) verifyNow(app, runId, r, c);
  }
  while (r.running.size) await Promise.allSettled([...r.running]);
  const said = takeRoundFeedback(runId);
  const left = listTasks(app, r.rootId).filter((t) => t.state === "coding" && t.coderRun === runId);
  if (!more || !left.length) return null;
  const back = left.filter((t) => r.back.has(t.seq));
  const untouched = left.filter((t) => !r.back.has(t.seq));
  return [
    said ?? "",
    back.length ? `## 还在你这一轮的项\n\n逐项改、提交、finish_task；拿不准的照常 ask_reviewer 或 report_task。\n\n${back.map((t) => taskText(app, t)).join("\n\n")}` : "",
    untouched.length ? `## 这一轮还没做的项\n\n这些也是这一轮的，你停下时还没做。接着逐项做：改、验证、提交、finish_task；做不了的用 report_task 说明原因，不要留给下一轮。\n\n${untouched.map((t) => taskText(app, t)).join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/**
 * The round's coding is over (code.ts, before settling its tasks): nothing comes back to it any more.
 * A task brought back and not committed again since waits for the next round.
 */
export async function closeRound(app: App, runId: string) {
  const r = open.get(runId);
  if (!r) return;
  r.accepting = false;
  while (r.running.size) await Promise.allSettled([...r.running]);
  open.delete(runId);
  takeRoundFeedback(runId);
  const worktrees = worktreesOf(app, r.rootId);
  for (const [seq, heads] of r.back) {
    const t = getTask(app, r.rootId, seq);
    if (t.state !== "coding" || t.coderRun !== runId) continue;
    const named = new RegExp(`^Omem-Task:.*\\b${taskLabel(seq)}\\b`, "m");
    const again = worktrees.some((w) => heads[w.space] && named.test(git(workDirOf(w), ["log", "--format=%B", `${heads[w.space]}..HEAD`]).stdout));
    if (!again) updateTask(app, r.rootId, seq, { state: "todo" }, { by: "host", kind: "host", text: "这一轮没来得及再改，下一轮接着改" });
  }
}

// ---- a second look by another model -----------------------------------------------------------------

const looking = new Map<string, Promise<void>>();

/** The model a second look of `check` uses in this work: chosen once from review.rotation, not the first look's. */
function lookAI(app: App, rootId: string, check: string, first: { profile: string | null; model: string | null }) {
  const w = workState(app, rootId);
  const had = w.lookAI?.[check];
  if (had) return had;
  const list = (app.config.review.rotation ?? []).filter((x) => !(x.profile === first.profile && (x.model ?? null) === (first.model ?? null)));
  if (!list.length) return null;
  const taken = Object.values(w.lookAI ?? {});
  const pick = list.find((x) => !taken.some((t) => t.profile === x.profile && t.model === x.model)) ?? list[taken.length % list.length];
  const ai = { profile: pick.profile, ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) };
  setWorkState(app, rootId, { lookAI: { ...(w.lookAI ?? {}), [check]: ai } });
  return ai;
}

/**
 * After a stage review: the checks review-lead (or the owner, “每轮换模型”) wants looked at again by
 * another model, recorded on the work for startLook. The owner's “不换模型” and an empty
 * review.rotation turn it off.
 */
export function planLook(app: App, rootId: string, run: Run, plan: ReviewPlan, stage: number, since: Record<string, string> | undefined): LookState | null {
  const rotate = (run.input as { roundReview?: RoundReview }).roundReview?.rotate;
  if (rotate === false || !(app.config.review.rotation ?? []).length) return null;
  const chosen = rotate === true
    ? plan.checks.map((name) => ({ name, focus: plan.second?.find((c) => c.name === name)?.focus ?? plan.focus?.[name] ?? "" }))
    : plan.second ?? [];
  const round = Number((run.input as { round?: number }).round ?? 1);
  const checks = chosen.filter((c) => {
    const row = reviewFor(app, run.id, round, c.name);
    return row && row.verdict !== "failed" && !!lookAI(app, rootId, c.name, { profile: row.profile_id, model: row.model });
  });
  if (!checks.length) return null;
  const worktrees = worktreesOf(app, rootId);
  // Without `since` the look reads the whole change, as the first stage review did.
  const look: LookState = { run: run.id, round, stage, ...(since ? { since } : {}), heads: headsAt(app, rootId, worktrees, stage), checks };
  setWorkState(app, rootId, { look });
  return look;
}

/** The second look recorded on the work, started unless it runs already; null when there is none. */
export function startLook(app: App, rootId: string): Promise<void> | null {
  const running = looking.get(rootId);
  if (running) return running;
  const look = workState(app, rootId).look;
  if (!look) return null;
  const p = runLook(app, rootId, look).catch((e) => console.warn(`[omem] 复看没有完成：${(e as Error).message}`)).finally(() => looking.delete(rootId));
  looking.set(rootId, p);
  return p;
}
export const lookRunning = (rootId: string) => looking.get(rootId) ?? null;

function lookBrief(label: string, ai: string, first: { title: string; severity: string; file_path: string | null }[], focus: string) {
  return [
    "## 这次是复看",
    `${label}评审已经看过这一段改动${first.length ? "，提了下面这些问题（已经交给编码 Agent 在改）" : "，没有提问题"}。你用另一个模型（${ai}）重新看同一段改动：不要重复这些问题，找它没发现的；第一次的结论你认为不对的也可以指出。工作区是这段改动的快照（只读），编码 Agent 同时在别处改第一次的问题。`,
    first.map((f) => `- [${f.severity}] ${f.file_path ? `${f.file_path} ` : ""}${f.title}`).join("\n"),
    focus.trim() ? `## 这次请重点看\n\n${focus.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

/** One second look: the checks on their models, review-lead's ruling, new tasks to the round coding now. */
async function runLook(app: App, rootId: string, look: LookState) {
  const reviewed = getRun(app, look.run);
  const plan = reviewed.output.reviewPlan as ReviewPlan;
  const infos = new Map(reviewChecks(app).map((c) => [c.name, c]));
  const ais = workState(app, rootId).lookAI ?? {};
  const names = look.checks.map((c) => lookName(c.name));
  const title = `复看：${look.checks.map((c) => `${checkLabel(infos, c.name)}（${aiText(ais[c.name])}）`).join("、")}`;
  const child = createRun(app, {
    kind: "agent",
    spaceId: reviewed.spaceId,
    title: truncate(title, 80),
    input: { role: "reviewer", secondLookOf: reviewed.id, workId: rootId, checks: names, task: title },
    parentId: reviewed.id,
    userId: runUser(app, reviewed.id),
  });
  sql(app.db, "update runs set status = 'running', started_at = ? where id = ? and status = 'queued'", now(), child.id);
  app.emit({ type: "run", runId: child.id, status: "running" });
  const controller = new AbortController();
  const untrack = trackAbort(child.id, controller);
  const event = (type: string, data: unknown) => addRunEvent(app, child.id, type, data);
  const tell = (text: string) => addRunEvent(app, lastRound(app, rootId).id, "status", { text });
  tell(`${title}，和修改同时进行`);
  let snap: ReturnType<typeof snapshot> | null = null;
  try {
    snap = snapshot(worktreesOf(app, rootId), join(app.runsDir, child.id, "snap"), look.heads);
    setRunOutput(app, reviewed.id, { reviewPlan: { ...plan, looks: [...new Set([...(plan.looks ?? []), ...names])] } });
    const ctx = await reviewContext(app, reviewed.id, undefined, { since: look.since, to: look.heads, dirs: snap.dirs, cwd: snap.cwd });
    const round = look.round;
    const outcomes = await Promise.allSettled(look.checks.map(async (c) => {
      const name = lookName(c.name);
      // Already looked (the server restarted after it submitted): its findings may be tasks by now.
      if (reviewFor(app, reviewed.id, round, name)) return;
      const first = roundFindings(app, reviewed.id, round).filter((f) => f.check_name === c.name);
      const res = await runCheck(app, rootId, name, {
        run: reviewed,
        task: [ctx.reviewTask, checkBrief(infos.get(c.name)!, plan), lookBrief(checkLabel(infos, c.name), aiText(ais[c.name]), first, c.focus), taskCheckBrief(taskList(app, rootId))].join("\n\n"),
        cwd: snap!.cwd,
        spaces: ctx.spaces,
        indexed: ctx.indexed,
        runId: child.id,
        signal: controller.signal,
        onEvent: (e) => event(e.type, { ...e, phase: "reviewer", check: name }),
      });
      if (!reviewFor(app, reviewed.id, round, name)) {
        const text = replyOf(res).trim();
        recordReview(app, { codeRunId: reviewed.id, round, check: name, tier: plan.tier, verdict: /结论[：:]\s*通过/.test(text) ? "approved" : "changes_requested", summary: truncate(text, 4000), findings: [], ai: res.ai });
      }
    }));
    flushRunText(app, child.id);
    const failed = outcomes.flatMap((o, i) => (o.status === "rejected" ? [`${checkLabel(infos, names[i])}：${(o.reason as Error).message}`] : []));
    if (failed.length === outcomes.length) throw new Error(failed.join("；"));
    const fresh = roundFindings(app, reviewed.id, round).filter((f) => names.includes(f.check_name) && f.state === "open" && !(f as { task_id?: number | null }).task_id);
    const made: CodeTask[] = [];
    if (fresh.length && !controller.signal.aborted) {
      const lead = await lookRuling(app, rootId, reviewed, round, fresh, ctx.reviewTask, child.id, controller.signal, event);
      const ids = new Set(fresh.map((f) => f.id));
      // Without a ruling only what is still open (never ruled on) becomes a task.
      const ruled = roundFindings(app, reviewed.id, round).filter((x) => ids.has(x.id) && (lead.by === "lead" || x.state === "open"));
      made.push(...tasksFromRuling(app, rootId, ruled, lead).filter((t) => !isLater(t)));
    }
    const joined = joinRound(app, rootId, made.filter((t) => getTask(app, rootId, t.seq).state === "todo"));
    const w = workState(app, rootId);
    const stages = [...(w.stages ?? [])];
    if (stages.length) stages[stages.length - 1] += made.length;
    setWorkState(app, rootId, { look: null, stages });
    const summary = made.length ? `新增 ${made.map((t) => `${taskLabel(t.seq)} ${t.title}`).join("；")}${joined ? "（已交给正在编码的这一轮）" : ""}` : "没有发现新的问题";
    setRunOutput(app, child.id, { answer: `${summary}${failed.length ? `\n\n没完成：${failed.join("；")}` : ""}`, looks: names });
    sql(app.db, "update runs set status = 'done', finished_at = ? where id = ?", now(), child.id);
    app.emit({ type: "run", runId: child.id, status: "done" });
    tell(`复看完成：${summary}`);
  } catch (e) {
    flushRunText(app, child.id);
    const cancelled = controller.signal.aborted;
    // Not tried again by itself: the next stage review may ask for another.
    setWorkState(app, rootId, { look: null });
    sql(app.db, "update runs set status = ?, error = ?, finished_at = ? where id = ?", cancelled ? "cancelled" : "failed", (e as Error).message, now(), child.id);
    addRunEvent(app, child.id, "error", { message: (e as Error).message });
    app.emit({ type: "run", runId: child.id, status: cancelled ? "cancelled" : "failed" });
    tell(`复看没有完成：${truncate((e as Error).message, 300)}`);
  } finally {
    snap?.release();
    untrack();
  }
}

const LOOK_RULING = [
  "# 裁决复看的问题",
  "另一个模型复看了这一段改动，提了下面这些问题。第一次评审的问题已经是修改项（列在下面），和它们重复的按下面的规则并进去。逐条用 `rule_review` 裁决。",
].join("\n");

/** review-lead on what a second look found, next to the tasks the work has. */
async function lookRuling(app: App, rootId: string, reviewed: Run, round: number, fresh: ReturnType<typeof roundFindings>, reviewTask: string, runId: string, signal: AbortSignal, event: (type: string, data: unknown) => void): Promise<LeadResult> {
  const infos = new Map(reviewChecks(app).map((c) => [c.name, c]));
  const fmt = (f: (typeof fresh)[number]) => `- #${f.id} [${checkLabel(infos, f.check_name)} · ${SEVERITY_LABEL[f.severity]}] ${f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""} ` : ""}${f.title}${f.detail ? `\n  ${truncate(f.detail, 600)}` : ""}${f.suggestion ? `\n  建议：${truncate(f.suggestion, 400)}` : ""}`;
  const host: LeadResult = { round, verdict: "revise", summary: "", changeRequest: "", rerun: [], by: "host" };
  setRunOutput(app, reviewed.id, { reviewLeadDraft: null });
  try {
    await runRole(app, {
      role: "review-lead",
      reviewLead: true,
      spaceId: reviewed.spaceId!,
      spaces: (await checkScope(app, reviewed)).spaces,
      task: [LOOK_RULING, `## 已有的修改项\n\n${taskList(app, rootId) || "（没有）"}`, `## 复看提的问题\n\n${fresh.map(fmt).join("\n")}`, TASK_RULING, reviewTask].join("\n\n"),
      runId,
      signal,
      onEvent: (e) => event(e.type, { ...e, phase: "lead" }),
      profileId: app.config.agents.roles["review-lead"],
    });
  } catch (e) {
    if (signal.aborted) throw e;
    event("status", { text: `评审负责人没有裁决复看的问题（${(e as Error).message}），都作为修改项` });
    return host;
  }
  const draft = getRun(app, reviewed.id).output.reviewLeadDraft as (Omit<LeadResult, "by"> | null | undefined);
  return draft && draft.round === round ? { ...draft, by: "lead" } : host;
}

/** New tasks join the round coding now (the coder hears at its next omem tool call); false when none is. */
function joinRound(app: App, rootId: string, tasks: CodeTask[]): boolean {
  if (!tasks.length) return false;
  const last = lastRound(app, rootId);
  const r = open.get(last.id);
  if (!r || !r.accepting) return false;
  for (const t of tasks) bringBack(app, last.id, r, t.seq, "复看新发现，交给正在编码的这一轮");
  addRoundFeedback(last.id, `- 复看（另一个模型）新发现：${tasks.map((t) => `${taskLabel(t.seq)}「${truncate(t.title, 60)}」`).join("、")}，已经加给你这一轮，和别的项一样逐项改、提交、finish_task。`);
  return true;
}
