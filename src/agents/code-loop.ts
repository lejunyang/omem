import type { App } from "../core/app.ts";
import { all, one } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { git } from "../core/git.ts";
import { HttpError, truncate } from "../core/util.ts";
import { cancelAsk, createAsk, registerAskHandler, type Ask } from "./asks.ts";
import { codeChainFor, queueNextCodeRound, saveCodeChain, wakeAssistantForTasks, type CodeChain } from "./code-chain.ts";
import { addCodeNote } from "./code-steer.ts";
import { ignoredText, reviewMetrics, worktreesOf, type IgnoredFiles } from "./code.ts";
import {
  addTask, getTask, headsAt, listCheckpoints, listTasks, renewBudget, retryTask, revertsCleanly, scheduleRevert, setWorkState, taskForFinding,
  ownerQuestionText, stranded, taskLabel, toAssistant, hasAssistant, retriesBy, ASSISTANT_RETRIES, taskList, taskText, updateTask, workOwner, workRootOf, workState, lastRound, TASK_STATE_LABEL, type CodeTask,
} from "./code-tasks.ts";
import { checkArgs, checkScope, keepSession, lookRunning, planLook, sessionOf, startLook, verifyGroup, withCheck } from "./code-overlap.ts";
import { askConfirm, reviewContext, reviewRound, type RoundContext } from "./review-chain.ts";
import { queueStandaloneFix } from "./review-fix.ts";
import { checkLabel, planReview, reviewChecks, roundFindings, type ReviewPlan } from "./review.ts";
import { runRole } from "./runner.ts";
import { getRun, runUser, setRunOutput, type Run } from "./runs.ts";
import { workDirOf } from "./workspaces.ts";

/**
 * What happens after a coding round of a delegation driven by tasks (docs/v2/coding-loop.md §4):
 *
 * 1. each finished task that came from a finding goes back to the check that raised it, in that
 *    check's own session, which says fixed / not fixed / broke something / withdrawn — mostly while
 *    the round still codes (code-overlap.ts); here what that did not cover;
 * 2. when nothing is left to do, review-lead decides what this stretch of the change needs reviewed
 *    (which checks, what each should look at), the checks review it, and review-lead routes each
 *    finding: a task done without the owner, a question for the owner, or rejected;
 *    A second look by another model may follow, beside the next round (code-overlap.ts);
 * 3. then the next round takes the tasks still to do, within the budget; owner questions wait
 *    without holding the rest; with nothing left the work is done and waits for the owner's confirm.
 *
 * Nothing here asks the owner to approve a plan or a round.
 */

const roundOf = (r: Run) => Number((r.input as { round?: number }).round ?? 1);

type RepoOut = { space: string; check: { command: string; code: number; output: string } | null; ignored?: IgnoredFiles[] };
const repoResults = (run: Run) => (run.output.repos ?? []) as RepoOut[];
const brokenChecks = (run: Run) => repoResults(run).filter((r) => r.check && r.check.code !== 0);
const checkFailure = (broken: RepoOut[]) => broken.map((r) => `${r.space}：\`${r.check!.command}\` 退出码 ${r.check!.code}\n\n\`\`\`\n${truncate(r.check!.output.slice(-3000), 3000)}\n\`\`\``).join("\n\n");

/**
 * What the host itself finds after a round, as tasks for the coder: files the repository ignores
 * forced into the commits, and — when nothing else is left to do — a check that fails, so the work
 * is not approved red. Each is added once; one the coder handed to the owner or set aside stays so.
 */
function hostFindings(app: App, rootId: string, run: Run) {
  const tasks = listTasks(app, rootId);
  const open = (title: string) => tasks.some((t) => t.title === title && !["done", "reverted"].includes(t.state));
  const ignored = ignoredText(repoResults(run));
  if (ignored && !open(IGNORED_TASK)) addTask(app, rootId, { title: IGNORED_TASK, doneWhen: `仓库的 .gitignore 忽略这些文件，提交里却有它们（多半是 \`git add -f\`）：\n\n${ignored}\n\n用 \`git rm -r --cached <路径>\` 撤回（文件留在工作区），提交生成它们的输入（IDL、生成配置）而不是产物；确实要入库的，用 report_task 交给本人说明理由。`, kind: "fix" }, "host");
  const broken = brokenChecks(run);
  if (broken.length && !tasks.some((t) => t.state === "todo") && !open(CHECK_TASK)) addTask(app, rootId, { title: CHECK_TASK, doneWhen: `${checkFailure(broken)}\n\n修到检查通过；失败和这次的改动无关（环境、外部服务）或检查命令本身要改的，用 report_task 交给本人说明。`, kind: "fix" }, "host");
}
const IGNORED_TASK = "撤回提交了的被忽略文件";
const CHECK_TASK = "检查没通过";

export async function taskReview(app: App, codeRunId: string, rc: RoundContext): Promise<{ verdict: string; continuedRunId?: string }> {
  const run = getRun(app, codeRunId);
  const rootId = workRootOf(app, run.id);
  // A second look that went on beside this round finishes first: what it adds belongs to its stage.
  const look = lookRunning(rootId);
  if (look) {
    setRunOutput(app, run.id, { reviewStage: "look" });
    rc.event("status", { text: "等复看做完" });
    await untilDone(look, rc.signal);
  }
  // Only reverts this round: what was taken back had been reviewed; a check it breaks is a task.
  if (run.output.gitOnly) {
    const broken = brokenChecks(run);
    if (broken.length) addTask(app, rootId, { title: "回退之后检查没通过", doneWhen: checkFailure(broken), kind: "fix" }, "host");
    else setWorkState(app, rootId, { stageAt: listCheckpoints(app, rootId).at(-1)?.seq ?? 0 });
    return nextStep(app, getRun(app, run.id), rc);
  }
  const toVerify = listTasks(app, rootId).filter((t) => t.state === "verify" && t.verifier);
  if (toVerify.length) {
    setRunOutput(app, run.id, { reviewStage: "verify" });
    await verifyTasks(app, run, toVerify, rc);
  }
  const disputed = listTasks(app, rootId).filter((t) => t.state === "disputed");
  if (disputed.length) {
    setRunOutput(app, run.id, { reviewStage: "arbitrate" });
    await arbitrate(app, run, disputed, rc);
  }
  const open = listTasks(app, rootId).filter((t) => ["todo", "coding", "verify", "disputed"].includes(t.state));
  const w = workState(app, rootId);
  const latest = listCheckpoints(app, rootId).at(-1)?.seq ?? 0;
  if (!open.length && !(w.reverts ?? []).length && latest > (w.stageAt ?? 0)) await stageReview(app, run, rc);
  // A second look the stage asked for goes on beside the next round; with nothing to code it is waited for here.
  const after = workState(app, rootId);
  const again = after.paused ? null : startLook(app, rootId);
  if (again && !listTasks(app, rootId).some((t) => t.state === "todo") && !(after.reverts ?? []).length) {
    setRunOutput(app, run.id, { reviewStage: "look" });
    await untilDone(again, rc.signal);
  }
  return nextStep(app, getRun(app, run.id), rc);
}

/** Wait for `p`, unless the round is stopped first. */
function untilDone(p: Promise<void>, signal: AbortSignal) {
  return new Promise<void>((ok, fail) => {
    if (signal.aborted) return fail(new Error("CANCELLED"));
    signal.addEventListener("abort", () => fail(new Error("CANCELLED")), { once: true });
    void p.then(() => ok());
  });
}

// ---- verification -----------------------------------------------------------------------------

/** The finished tasks this round's own verifications did not cover (a helper's, the last ones), each by the check that raised it. */
async function verifyTasks(app: App, run: Run, tasks: CodeTask[], rc: RoundContext) {
  const groups = new Map<string, CodeTask[]>();
  for (const t of tasks) groups.set(t.verifier!, [...(groups.get(t.verifier!) ?? []), t]);
  const { infos } = await checkScope(app, run);
  rc.event("status", { text: `逐项验证：${[...groups].map(([c, l]) => `${checkLabel(infos, c)} 验证 ${l.map((t) => taskLabel(t.seq)).join("、")}`).join("；")}` });
  await Promise.allSettled([...groups].map(([check, list]) => verifyGroup(app, { run, check, tasks: list, runId: rc.runId, signal: rc.signal, event: rc.event })));
  if (rc.signal.aborted) throw new Error("CANCELLED");
}

export type VerifyVerdict = "fixed" | "not_fixed" | "regressed" | "withdrawn";

/** A check's verdicts on the tasks it verifies (verify_tasks). A broken task is reverted and redone once, else fixed going on. */
export function recordVerification(app: App, codeRunId: string, check: string, results: { task: number; verdict: VerifyVerdict; note?: string }[]) {
  const rootId = workRootOf(app, codeRunId);
  const worktrees = worktreesOf(app, rootId);
  const out: string[] = [];
  for (const r of results) {
    const t = getTask(app, rootId, r.task);
    if (t.state !== "verify") throw new HttpError(400, `${taskLabel(t.seq)} 现在是「${TASK_STATE_LABEL[t.state]}」，不在待验证`);
    if (t.verifier && t.verifier !== check) throw new HttpError(400, `${taskLabel(t.seq)} 由 ${t.verifier} 验证，不是 ${check}`);
    if (r.verdict !== "fixed" && !r.note?.trim()) throw new HttpError(400, `${taskLabel(t.seq)}：${r.verdict} 要写 note`);
    const note = { by: check, kind: "verify" as const, text: `${{ fixed: "验证通过", not_fixed: "没改好", regressed: "改出了新问题", withdrawn: "问题撤回" }[r.verdict]}${r.note?.trim() ? `：${r.note.trim()}` : ""}` };
    if (r.verdict === "fixed") updateTask(app, rootId, t.seq, { state: "done" }, note);
    else if (r.verdict === "withdrawn") {
      updateTask(app, rootId, t.seq, { state: "wontdo" }, note);
      for (const id of t.origin.findings ?? []) app.db.prepare("update review_findings set state = 'rejected', triage_note = ? where id = ?").run(`验证时撤回：${truncate(r.note ?? "", 900)}`, id);
    } else if (r.verdict === "regressed" && t.reverts < 1 && revertsCleanly(app, rootId, worktrees, t.seq)) {
      updateTask(app, rootId, t.seq, {}, note);
      scheduleRevert(app, rootId, t.seq, r.note!.trim(), check);
    } else retryTask(app, rootId, t.seq, note);
    out.push(`${taskLabel(t.seq)}：${r.verdict}`);
  }
  return out;
}

// ---- stage review -----------------------------------------------------------------------------------

/** The change since the last stage review, in categories a reviewer plans by (not a verdict on it). */
function changeFacts(dir: string, from: string): string {
  const rows = git(dir, ["diff", "--numstat", "-M", from, "HEAD"]).stdout.split("\n").filter(Boolean);
  const cats = new Map<string, { files: number; lines: number }>();
  const kind = (p: string) =>
    / => |\{.* => .*\}/.test(p) ? "移动或改名" :
    /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[jt]sx?$/.test(p) ? "测试" :
    /(^|\/)mocks?\//i.test(p) ? "mock 与样例数据" :
    /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|zip)$/i.test(p) ? "图片与二进制" :
    /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum|Cargo\.lock)$/.test(p) ? "锁文件" :
    /\.(md|mdx|txt)$/i.test(p) ? "文档" :
    /\.(css|less|scss|sass)$/i.test(p) ? "样式" :
    /\.(json|ya?ml|toml|ini)$|(^|\/)\.[\w.-]*rc(\.\w+)?$|config\.[jt]s$/.test(p) ? "配置" : "源代码";
  for (const r of rows) {
    const [add, del, path] = r.split("\t");
    const k = kind(path);
    const c = cats.get(k) ?? { files: 0, lines: 0 };
    c.files += 1;
    c.lines += (Number(add) || 0) + (Number(del) || 0);
    cats.set(k, c);
  }
  return [...cats].map(([k, c]) => `- ${k}：${c.files} 个文件，${c.lines} 行`).join("\n") || "- 没有改动";
}

/** How each check did on this work so far: what it raised and what became of it. */
function checkHistory(app: App, rootId: string) {
  const rows = app.db.prepare(`select r.check_name as check_name, f.state as state, f.task_id as task_id from review_findings f join reviews r on r.id = f.review_id join runs x on x.id = r.code_run_id where x.id = ? or json_extract(x.input, '$.continueFrom') = ?`).all(rootId, rootId) as { check_name: string; state: string; task_id: number | null }[];
  const by = new Map<string, { raised: number; accepted: number; rejected: number }>();
  for (const r of rows) {
    const c = by.get(r.check_name) ?? { raised: 0, accepted: 0, rejected: 0 };
    c.raised++;
    if (r.task_id || r.state === "accepted") c.accepted++;
    if (r.state === "rejected") c.rejected++;
    by.set(r.check_name, c);
  }
  return by;
}

const PLAN_BRIEF = [
  "# 决定这次评审看什么",
  "这次交办按修改项推进，现在待做的项都做完了。你来决定这一段改动要哪些评审项看、各看什么。不按改动行数套档位：看改的是什么——业务逻辑、接口、数据、样式、测试、搬动的资源各需要不同的眼光；之前看过且没再动的地方不用再看；本人在任务里说了要怎么评审的照做。",
  "调用一次 `plan_review`：`checks` 列出参加的评审项和各自的重点（具体到哪些文件、哪类问题，一两句话），`skipped` 写没选的评审项各一句理由，`summary` 一句话说明这样安排的理由。至少选一项。",
].join("\n");
const SECOND_LOOK_BRIEF = "这次还可以请另一个模型复看（`second_look`）：编码 Agent 修这次评审提的问题时，另一个模型同时重新看同一段改动，找第一次没发现的问题。值得复看的是业务逻辑复杂、风险大、第一次可能看不透的部分；改动小、样式、文档、搬资源的不用。复看也花 token，拿不准就不选。";

async function planStage(app: App, run: Run, rc: RoundContext, since: Record<string, string> | undefined): Promise<ReviewPlan> {
  const rootId = workRootOf(app, run.id);
  const root = getRun(app, rootId);
  const worktrees = worktreesOf(app, rootId);
  const checks = reviewChecks(app).filter((c) => !c.missing);
  const history = checkHistory(app, rootId);
  const facts = worktrees.map((wt) => `${worktrees.length > 1 ? `### ${wt.space}\n\n` : ""}${changeFacts(workDirOf(wt), since?.[wt.space] ?? wt.start ?? wt.base)}`).join("\n\n");
  const input = root.input as { task?: string; reviewTier?: string; reviewChecks?: string[] };
  // Checks the owner named when delegating, or picked for the rounds since (运行页“之后的评审”).
  const must = [...new Set([...(input.reviewChecks ?? []), ...((run.input as { roundReview?: { checks?: string[] } }).roundReview?.checks ?? [])])];
  const ownerSaid = [input.reviewTier ? `本人点名的评审档位：${input.reviewTier}` : "", must.length ? `本人要求加上的评审项：${must.join("、")}（必须选上）` : ""].filter(Boolean).join("\n");
  // The owner said either way (每轮换模型 / 不换模型), or there is no other model: not review-lead's call.
  const lookable = (app.config.review.rotation ?? []).length > 0 && (run.input as { roundReview?: { rotate?: boolean } }).roundReview?.rotate === undefined;
  const task = [
    PLAN_BRIEF,
    lookable ? SECOND_LOOK_BRIEF : "",
    `## 这一段改动（${since ? "上次评审以后" : "从开始到现在"}）\n\n${facts}`,
    `## 修改项\n\n${taskList(app, rootId) || "（没有）"}`,
    `## 可用的评审项\n\n${checks.map((c) => { const h = history.get(c.name); return `- ${c.name}（${c.label}）：${c.about}${c.guide ? `；本人说：${c.guide}` : ""}${h ? `；这次交办里提过 ${h.raised} 条，采纳 ${h.accepted}，驳回 ${h.rejected}` : ""}`; }).join("\n")}`,
    ownerSaid,
    `## 交办任务（本人的原话）\n\n${truncate(String(input.task ?? ""), 6000)}`,
  ].filter(Boolean).join("\n\n");
  setRunOutput(app, run.id, { reviewPlanDraft: null, reviewStage: "plan" });
  rc.event("status", { text: "评审负责人决定这次评审看什么" });
  try {
    await runRole(app, {
      role: "review-lead",
      reviewLead: true,
      addTools: ["plan_review"],
      spaceId: run.spaceId!,
      spaces: [...new Set([run.spaceId!, ...worktrees.map((w) => w.space)])],
      task,
      runId: rc.runId,
      cwd: worktrees.length > 1 ? undefined : workDirOf(worktrees[0]),
      signal: rc.signal,
      onEvent: (e) => rc.event(e.type, { ...e, phase: "lead" }),
      profileId: app.config.agents.roles["review-lead"],
    });
  } catch (e) {
    if (rc.signal.aborted) throw e;
    rc.event("status", { text: `评审负责人没有完成计划（${(e as Error).message}），按改动大小选评审项` });
  }
  const draft = getRun(app, run.id).output.reviewPlanDraft as { checks: { name: string; focus: string }[]; skipped?: { name: string; reason: string }[]; secondLook?: { name: string; focus: string }[]; summary: string } | null | undefined;
  const metrics = reviewMetrics(worktrees, (getRun(app, run.id).output.repos ?? []) as never, String(input.task ?? ""));
  const w = workState(app, rootId);
  if (draft?.checks.length) {
    const names = [...new Set([...draft.checks.map((c) => c.name), ...must])].filter((n) => checks.some((c) => c.name === n));
    return {
      tier: "ai", tierName: "按改动定", checks: names, maxRounds: w.until, metrics, lead: true,
      reasons: [draft.summary, ...(draft.skipped ?? []).map((s) => `没选 ${s.name}：${s.reason}`)],
      focus: Object.fromEntries(draft.checks.map((c) => [c.name, c.focus])),
      ...(lookable && draft.secondLook?.length ? { second: draft.secondLook.filter((c) => names.includes(c.name)) } : {}),
    };
  }
  const fallback = planReview(app, metrics, { tier: input.reviewTier, extraChecks: must });
  return { ...fallback, maxRounds: w.until, lead: true, confirmPlan: false };
}

async function stageReview(app: App, run: Run, rc: RoundContext) {
  const rootId = workRootOf(app, run.id);
  const worktrees = worktreesOf(app, rootId);
  const w = workState(app, rootId);
  const since = w.stageAt ? headsAt(app, rootId, worktrees, w.stageAt) : undefined;
  const latest = listCheckpoints(app, rootId).at(-1)?.seq ?? 0;
  const plan = await planStage(app, run, rc, since);
  setRunOutput(app, run.id, { reviewPlan: plan });
  rc.event("status", { text: `阶段评审：${plan.checks.join("、")}（${plan.reasons[0] ?? ""}）` });
  // The requirement split once per work (later stages keep it unless the owner asks again).
  const split = !one(app.db, "select 1 from runs where (id = ? or json_extract(input, '$.continueFrom') = ?) and json_extract(output, '$.changePoints') is not null", rootId, rootId);
  const res = await reviewRound(app, run.id, rc, {
    task: {
      since,
      split,
      tasks: () => taskList(app, rootId),
      session: (check) => sessionOf(app, rootId, check),
      onSession: (check, id, used) => keepSession(app, rootId, check, id, used),
    },
  });
  const lead = res.lead!;
  const round = roundOf(run);
  let made = 0;
  for (const f of roundFindings(app, run.id, round)) {
    // A lead's ruling decides; without one (it failed), every finding is worth a task.
    const take = lead.by === "lead" ? f.state === "accepted" : f.state === "open" || f.state === "accepted";
    if (!take) continue;
    const owner = lead.owner?.[String(f.id)];
    taskForFinding(app, rootId, f, "review-lead", owner ? { question: owner.question, options: owner.options } : undefined);
    made++;
  }
  if (lead.verdict === "escalate" && lead.escalation) {
    addTask(app, rootId, { title: "方案上的分歧", doneWhen: lead.escalation.summary, kind: "owner", state: "owner", question: lead.escalation.summary, options: lead.escalation.options }, "review-lead");
  }
  setWorkState(app, rootId, { stageAt: latest, stages: [...(w.stages ?? []), made] });
  const look = planLook(app, rootId, getRun(app, run.id), plan, latest, since);
  if (look) rc.event("status", { text: `另一个模型复看 ${look.checks.map((c) => c.name).join("、")}，和下一轮的修改同时进行` });
}

// ---- what next ------------------------------------------------------------------------------------

/** The rounds of auto tasks the last stage reviews asked for did not go down: stop and say so. */
function notConverging(stages: number[]) {
  const last = stages.slice(-3);
  return last.length === 3 && last[0] > 0 && last[1] >= last[0] && last[2] >= last[1];
}

async function nextStep(app: App, run: Run, rc: RoundContext): Promise<{ verdict: string; continuedRunId?: string }> {
  const rootId = workRootOf(app, run.id);
  hostFindings(app, rootId, run);
  const tasks = listTasks(app, rootId);
  const w = workState(app, rootId);
  const todo = tasks.filter((t) => t.state === "todo");
  const owner = tasks.filter((t) => t.state === "owner");
  const mine = tasks.filter((t) => t.state === "assistant");
  ensureOwnerAsks(app, rootId);
  const finish = (verdict: string, extra: Record<string, unknown> = {}) => {
    setRunOutput(app, run.id, { verdict, reviewStage: "done", ...extra });
    return { verdict };
  };
  if (todo.length || (w.reverts ?? []).length) {
    if (w.paused) return finish("paused", { reviewStop: "paused" });
    if (notConverging(w.stages ?? [])) {
      setWorkState(app, rootId, { paused: "not-converging" });
      notifyOwner(app, rootId, run, "交办暂停：修改没有收敛", `最近三次阶段评审要改的问题没有减少（${(w.stages ?? []).slice(-3).join(" → ")}）。看一下修改项，决定继续、调整方案还是先停下。`);
      return finish("paused", { reviewStop: "not-converging" });
    }
    if (roundOf(run) >= w.until) {
      setWorkState(app, rootId, { paused: "budget" });
      notifyOwner(app, rootId, run, `交办暂停：自动推进到了第 ${roundOf(run)} 轮`, `还有 ${todo.length} 项待做${owner.length ? `、${owner.length} 项等你决定` : ""}。说“继续”再推进 ${w.budget} 轮。`);
      return finish("paused", { reviewStop: "budget" });
    }
    const next = queueRound(app, rootId, run);
    if (next) {
      rc.event("status", { text: `排上第 ${roundOf(next)} 轮：${todo.map((t) => taskLabel(t.seq)).join("、")}` });
      // What the next round cannot move goes to the assistant now, not when the work stops.
      if (mine.length) wakeAssistantForTasks(app, rootId);
      return { ...finish("continuing"), continuedRunId: next.id };
    }
    return finish("paused", { reviewStop: "paused" });
  }
  // The assistant is woken for its tasks when this round's run ends (code-chain.ts): the work waits on it, not on the owner.
  if (mine.length) return finish("awaiting-assistant", { reviewStop: "assistant" });
  if (owner.length) return finish("awaiting-owner", { reviewStop: "owner" });
  const result = finish("approved", { reviewStop: null });
  completed(app, rootId, getRun(app, run.id));
  return result;
}

/** The work is done: what was done and what the owner decided not to, and the confirm card. */
function completed(app: App, rootId: string, run: Run) {
  const tasks = listTasks(app, rootId);
  const count = (s: CodeTask["state"]) => tasks.filter((t) => t.state === s).length;
  const fixes = tasks.filter((t) => t.kind === "fix" && t.state === "done").length;
  const digest = [
    `**修改项**：完成 ${count("done")} 项${fixes ? `（其中评审问题 ${fixes} 个）` : ""}${count("wontdo") ? `，不做 ${count("wontdo")} 项` : ""}${count("reverted") ? `，回退 ${count("reverted")} 项` : ""}`,
    tasks.filter((t) => t.state === "done").slice(0, 8).map((t) => `- ${taskLabel(t.seq)} ${t.title}`).join("\n"),
  ].filter(Boolean).join("\n");
  const chain = (run.output as { codeChain?: CodeChain }).codeChain ?? null;
  // Named after the delegation, not its last round (“交办第 4 轮：修改项 T2”).
  const ask = askConfirm(app, run, chain, `交办完成：${getRun(app, rootId).title}`, digest);
  setRunOutput(app, run.id, { reviewAskId: ask.id });
}

function notifyOwner(app: App, rootId: string, run: Run, title: string, body: string) {
  notify(app, { userId: workOwner(app, rootId), title, body, link: `#/runs/${run.id}` });
}

/**
 * The next round, coding the tasks still to do: in the same chain (the conversation that asked, its
 * progress card) or, for work started on the web, after the last round. The budget was checked by
 * the caller; null when the work cannot go on (applied, discarded, its workspace gone).
 */
function queueRound(app: App, rootId: string, last: Run): Run | null {
  const todo = listTasks(app, rootId).filter((t) => t.state === "todo" || stranded(app, t));
  const title = `修改项 ${todo.map((t) => taskLabel(t.seq)).join("、") || "回退与重做"}`;
  const w = workState(app, rootId);
  const running = ["queued", "running"].includes(last.status);
  const sessionId = last.output.coderSessionId as string | undefined;
  try {
    const chain = codeChainFor(app, last);
    if (chain) {
      const fresh = (getRun(app, chain.askRunId).output.codeChain as CodeChain | undefined) ?? chain;
      const ready = { ...fresh, maxRounds: w.until, awaitingUser: false, waitReason: undefined };
      saveCodeChain(app, ready, ready.askRunId, ...ready.rounds);
      return queueNextCodeRound(app, ready, title, { manual: !running, resumeSessionId: sessionId })?.run ?? null;
    }
    // Coded and reviewed here, also after rounds an outside Agent did (a delegation turned task-driven).
    return queueStandaloneFix(app, rootId, last.id, title, runUser(app, last.id), { peerCoder: undefined, peerReviewer: undefined }, { allowRunning: last.id });
  } catch (e) {
    if (e instanceof HttpError) return null;
    throw e;
  }
}

/**
 * The owner did something (answered, added a task, said go on, reverted): a new budget, and when no
 * round is running, the next one starts now. Returns the round that started, if any.
 */
export function advanceWork(app: App, rootId: string, opts: { owner?: boolean } = {}): Run | null {
  const last = lastRound(app, rootId);
  const rounds = app.db.prepare("select output from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?)").all(rootId, rootId) as { output: string }[];
  if (rounds.some((r) => { const o = JSON.parse(r.output); return o.appliedAt || o.discardedAt; })) throw new HttpError(409, "这次交办已经确认或丢弃了，新的要求请重新交办");
  if (opts.owner) renewBudget(app, rootId, roundOf(last));
  const busy = ["queued", "running"].includes(last.status) || !!one(app.db, "select 1 from runs where kind = 'review' and status in ('queued', 'running') and json_extract(input, '$.codeRunId') = ?", last.id);
  if (busy) return null;
  const w = workState(app, rootId);
  if (w.paused) return null;
  // Only the owner gives more rounds: what the assistant settles waits once the budget is used up.
  if (!opts.owner && roundOf(last) >= w.until) return null;
  const tasks = listTasks(app, rootId);
  if (tasks.some((t) => t.state === "todo" || stranded(app, t)) || (w.reverts ?? []).length) {
    const next = queueRound(app, rootId, last);
    if (next) setRunOutput(app, last.id, { verdict: "continuing", reviewStop: null });
    return next;
  }
  // Nothing to code: what was left were questions now settled.
  if (!tasks.some((t) => ["assistant", "owner", "verify", "coding"].includes(t.state)) && ["awaiting-owner", "awaiting-assistant"].includes(String(last.output.verdict))) {
    setRunOutput(app, last.id, { verdict: "approved", reviewStop: null });
    completed(app, rootId, getRun(app, last.id));
  }
  return null;
}

// ---- review-lead rules on a dispute ----------------------------------------------------------------

const ARBITRATE_BRIEF = [
  "# 裁决异议",
  "编码 Agent 和提出问题的评审项对下面几项有分歧：评审项看过编码 Agent 的异议后仍然坚持，编码 Agent 还是认为问题不成立。你是第三方：读双方的理由、相关代码和需求原文（拿不准就去读，不要凭印象），对每一项用 `rule_dispute` 判一次：",
  "- coder：异议成立，这一项不做。写清依据，之后的评审不再提；",
  "- reviewer：照评审的意见改。写清为什么，编码 Agent 照你写的改，不再争；",
  "- owner：分歧其实来自需求或业务上没定的事，交给本人，写出问题和两三个选项。",
  "你不改代码，也不重新评审别的地方。",
].join("\n");

/** The disputes of this round, ruled by review-lead; one it did not rule on goes to the owner. */
async function arbitrate(app: App, run: Run, tasks: CodeTask[], rc: RoundContext) {
  const rootId = workRootOf(app, run.id);
  const ctx = await reviewContext(app, run.id);
  rc.event("status", { text: `评审负责人裁决异议：${tasks.map((t) => taskLabel(t.seq)).join("、")}` });
  const parts = tasks.map((t) => {
    const history = t.notes.map((n) => `- ${n.by === "coder" ? "编码 Agent" : n.by}：${truncate(n.text, 1500)}`).join("\n");
    const diff = ctx.worktrees.map((wt) => {
      const shas = t.commits[wt.space] ?? [];
      return shas.length ? git(workDirOf(wt), ["diff", "--no-color", `${shas[0]}^`, shas.at(-1)!]).stdout : "";
    }).filter((d) => d.trim()).join("\n");
    return [taskText(app, t), `#### 双方的说法（按时间）\n\n${history}`, diff ? `#### 这一项现在的改动\n\n\`\`\`diff\n${truncate(diff, 20000)}\n\`\`\`` : ""].filter(Boolean).join("\n\n");
  });
  try {
    await runRole(app, {
      role: "review-lead",
      reviewLead: true,
      addTools: ["rule_dispute"],
      spaceId: run.spaceId!,
      spaces: ctx.spaces,
      alsoRead: ctx.indexed,
      task: `${ARBITRATE_BRIEF}\n\n${parts.join("\n\n")}`,
      runId: rc.runId,
      cwd: ctx.cwd,
      signal: rc.signal,
      onEvent: (e) => rc.event(e.type, { ...e, phase: "lead", arbitrate: true }),
      profileId: app.config.agents.roles["review-lead"],
    });
  } catch (e) {
    if (rc.signal.aborted) throw e;
    rc.event("status", { text: `评审负责人没能裁决：${(e as Error).message}` });
  }
  for (const t of tasks) {
    if (getTask(app, rootId, t.seq).state !== "disputed") continue;
    toAssistant(app, rootId, t.seq, "编码 Agent 和评审项有分歧，评审负责人没有给出裁决（双方的说法在“之前的情况”里）。", { by: "host", kind: "host", text: "评审负责人没有裁决" });
  }
}

/** review-lead's ruling on one dispute (rule_dispute). */
export function ruleDispute(app: App, rootId: string, seq: number, a: { decision: "coder" | "reviewer" | "owner"; note: string; question?: string; options?: string[] }) {
  const t = getTask(app, rootId, seq);
  if (t.state !== "disputed") throw new HttpError(400, `${taskLabel(seq)} 现在是「${TASK_STATE_LABEL[t.state]}」，没有要裁决的异议`);
  const note = { by: "review-lead", kind: "lead" as const, text: `裁决：${{ coder: "异议成立，不做", reviewer: "照评审的意见改", owner: "交给本人" }[a.decision]}：${a.note.trim()}` };
  if (a.decision === "coder") {
    updateTask(app, rootId, seq, { state: "wontdo" }, note);
    for (const id of t.origin.findings ?? []) app.db.prepare("update review_findings set state = 'rejected', triage_note = ? where id = ?").run(`评审负责人裁决异议成立：${truncate(a.note, 900)}`, id);
  } else if (a.decision === "reviewer") updateTask(app, rootId, seq, { state: "todo" }, note);
  else updateTask(app, rootId, seq, { state: "owner", question: a.question!.trim(), options: a.options ?? [] }, note);
  return `已裁决 ${taskLabel(seq)}：${note.text.slice(3, 40)}。`;
}

// ---- the coder asks the check that raised a task ------------------------------------------------------

/**
 * The coder is unsure what a finding means or how far to go: it asks the check that raised it, which
 * answers in its own session for this work (it remembers why it raised the finding, and its later
 * verification remembers the exchange). Both sides are noted on the task. The general `ask_agent`
 * consultation underneath (consult.ts); only the target and the session are this work's.
 */
export async function askReviewer(app: App, codeRunId: string, seq: number, question: string, userId?: string): Promise<string> {
  const run = getRun(app, codeRunId);
  const rootId = workRootOf(app, run.id);
  const t = getTask(app, rootId, seq);
  if (!t.verifier) throw new HttpError(400, `${taskLabel(seq)} 不是评审问题，没有提出它的评审项可以问；对需求有疑问用 report_task 交给本人`);
  const ctx = await checkScope(app, run);
  const verifier = t.verifier;
  const { role, spec, ...args } = checkArgs(app, rootId, verifier, run);
  updateTask(app, rootId, seq, {}, { by: "coder", kind: "consult", text: `问${ctx.label(verifier)}：${truncate(question.trim(), 1500)}` });
  const { consultAgent } = await import("./consult.ts");
  let answer = "";
  // Its session takes one turn at a time: an answer waits for a verification it is doing.
  const reply = await withCheck(rootId, verifier, () => consultAgent(app, {
    role,
    ...(spec ? { spec } : {}),
    label: `${ctx.label(verifier)}评审`,
    question: `编码 Agent 在改 ${taskLabel(seq)}（来自你提的问题）时有疑问。回答它的问题：问题在哪、为什么、改到什么程度算解决；只回答，不提交评审结论。\n\n${taskText(app, t)}\n\n## 它的问题\n\n${question.trim()}`,
    askedBy: "编码 Agent",
    parentRunId: run.id,
    spaceId: run.spaceId!,
    userId: userId ?? runUser(app, run.id),
    extra: {
      ...args,
      // Fresh at the call: a verification just before may have moved the session on.
      resumeSessionId: sessionOf(app, rootId, verifier),
      spaces: ctx.spaces,
      alsoRead: ctx.indexed,
      cwd: ctx.cwd,
    },
    onDone: (res) => {
      keepSession(app, rootId, verifier, res.sessionId, res.contextUsage?.used);
      answer = res.reply ?? res.text;
    },
  }));
  if (answer.trim()) updateTask(app, rootId, seq, {}, { by: verifier, kind: "consult", text: `回答：${truncate(answer.trim(), 1500)}` });
  return reply;
}

// ---- owner questions --------------------------------------------------------------------------------

const SKIP = "不做这一项";

/**
 * One card per task waiting for the owner, in the conversation the work reports to (or the home page).
 * Tasks waiting on the assistant never get one: it is woken for them (wakeAssistantForTasks) and
 * passes on to the owner only what it cannot settle, as a question with options (settleTask).
 */
function ensureOwnerAsks(app: App, rootId: string) {
  const w = workState(app, rootId);
  const asks = { ...(w.asks ?? {}) };
  const last = lastRound(app, rootId);
  const chain = (last.output as { codeChain?: CodeChain }).codeChain;
  let changed = false;
  for (const t of listTasks(app, rootId).filter((x) => x.state === "owner")) {
    const id = asks[String(t.seq)];
    if (id && one(app.db, "select 1 from asks where id = ? and status = 'pending'", id)) continue;
    const ask = createAsk(app, {
      runId: last.id,
      conversationId: chain?.conversationId ?? null,
      userId: workOwner(app, rootId),
      question: `「${truncate(getRun(app, rootId).title, 40)}」的 ${taskLabel(t.seq)}「${t.title}」需要你决定：\n\n${ownerQuestionText(app, t)}\n\n其他修改项照常推进；可以在输入框里写你的做法。`,
      options: [...t.options, SKIP].map((label) => ({ label })),
      allowText: true,
      context: { handler: "code-task", workId: rootId, seq: t.seq },
    });
    asks[String(t.seq)] = ask.id;
    changed = true;
  }
  if (changed) setWorkState(app, rootId, { asks });
}

/**
 * The assistant settles a task waiting on it — done again (with what to do differently), not done,
 * or passed on to the owner as a question with options — or relays the owner's answer to one waiting
 * on the owner. What it may do is decided here, not by its instructions:
 * - a task waiting on the owner moves only on the owner's words this turn, or an earlier requirement
 *   or permission the assistant quotes (`authorization`), and only to be done again;
 * - one task goes back to be done at most ASSISTANT_RETRIES times by the assistant alone;
 * - a retry starts the next round only within the budget (advanceWork).
 * A card already sent closes.
 */
export function settleTask(app: App, rootId: string, seq: number, a: { action: "retry" | "skip" | "owner"; text: string; ownerWords: boolean; authorization?: string; question?: string; options?: string[] }, by: string) {
  const t = getTask(app, rootId, seq);
  if (t.state !== "assistant" && t.state !== "owner") throw new HttpError(409, `${taskLabel(seq)} 现在是「${TASK_STATE_LABEL[t.state]}」，不在等处理`);
  const authorizedRetry = a.action === "retry" && !!a.authorization?.trim();
  if (t.state === "owner") {
    if (a.action === "owner") throw new HttpError(409, `${taskLabel(seq)} 已经在等本人`);
    if (!a.ownerWords && !authorizedRetry) throw new HttpError(403, `${taskLabel(seq)} 在等本人决定：本人在这一轮回答了才转达；原需求或本人之前的话已经定了做法的，retry 并在 existing_authorization 写出原话或引用。不能替本人作新的决定，也不能替本人说不做`);
  }
  if (a.action === "retry" && t.state === "assistant" && !a.ownerWords && retriesBy(t) >= ASSISTANT_RETRIES)
    throw new HttpError(409, `${taskLabel(seq)} 你已经让它重做过 ${retriesBy(t)} 次还没好：换一种做法要本人定，用 owner 写清问题和两三个选项；做不了的用 skip 写理由`);
  if (a.action === "owner") {
    const options = (a.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (!a.question?.trim() || options.length < 2) throw new HttpError(400, "交给本人要写 question（本人要定什么、为什么只有本人能定）和两三个 options（各自的做法）；没有可选的做法、只是要人去做事的（补字段、等别的团队），用 skip 写明在等什么");
    updateTask(app, rootId, seq, { state: "owner", question: a.question.trim(), options }, { by, kind: "assistant", text: `交给本人：${a.text}` });
    ensureOwnerAsks(app, rootId);
    return null;
  }
  const note = { by, kind: "assistant" as const, text: `${a.action === "skip" ? "不做" : "重做"}：${a.text}${authorizedRetry ? `\n已有授权依据：${a.authorization!.trim()}` : ""}` };
  // The owner's words are their decision (taskText shows it); the assistant's stay a note on the task.
  const answer = a.ownerWords ? { answer: a.text } : {};
  if (a.action === "skip") updateTask(app, rootId, seq, { state: "wontdo", ...answer }, note);
  else updateTask(app, rootId, seq, { state: "todo", attempts: 0, ...answer }, note);
  closeTaskAsk(app, rootId, seq);
  return advanceWork(app, rootId, { owner: a.ownerWords });
}

/** The owner's answer to a task's question: done their way, or not at all. Then the work goes on. */
export function answerTask(app: App, rootId: string, seq: number, a: { choice?: string | null; text?: string | null; skip?: boolean }, by: string) {
  const t = getTask(app, rootId, seq);
  // The owner may also settle a task the assistant holds: their word comes first.
  if (t.state !== "owner" && t.state !== "assistant") throw new HttpError(409, `${taskLabel(seq)} 现在是「${TASK_STATE_LABEL[t.state]}」，不在等你决定`);
  const text = [a.choice && a.choice !== SKIP ? a.choice : "", a.text?.trim() ?? ""].filter(Boolean).join("：");
  if (a.skip || a.choice === SKIP) updateTask(app, rootId, seq, { state: "wontdo", answer: text || "不做" }, { by, kind: "owner", text: `本人决定不做${a.text?.trim() ? `：${a.text.trim()}` : ""}` });
  else {
    if (!text) throw new HttpError(400, "选一个做法，或者写下你要怎么做");
    updateTask(app, rootId, seq, { state: "todo", answer: text, attempts: 0 }, { by, kind: "owner", text: `本人决定：${text}` });
  }
  closeTaskAsk(app, rootId, seq);
  return advanceWork(app, rootId, { owner: true });
}

/**
 * At start: a card left for a task that no longer waits on the owner (it moved on, or now waits on the
 * assistant) closes, and the assistant is woken for tasks waiting on it that no turn is taking.
 */
export function reconcileWaiting(app: App) {
  let closed = 0;
  let woken = 0;
  let moved = 0;
  for (const a of all<{ id: string; w: string; s: number }>(app.db, "select id, json_extract(context, '$.workId') w, json_extract(context, '$.seq') s from asks where status = 'pending' and json_extract(context, '$.handler') = 'code-task'")) {
    const t = one<{ state: string }>(app.db, "select state from code_tasks where work_id = ? and seq = ?", a.w, a.s);
    if (t?.state === "owner") continue;
    if (t) closeTaskAsk(app, a.w, a.s);
    cancelAsk(app, a.id);
    closed++;
  }
  for (const { work_id } of all<{ work_id: string }>(app.db, "select distinct work_id from code_tasks where state = 'assistant'")) {
    const rounds = all<{ output: string }>(app.db, "select output from runs where kind = 'code' and (id = ? or json_extract(input, '$.continueFrom') = ?)", work_id, work_id);
    if (rounds.some((r) => { const o = JSON.parse(r.output ?? "{}"); return o.appliedAt || o.discardedAt; })) continue;
    if (hasAssistant(app, work_id)) {
      if (wakeAssistantForTasks(app, work_id)) woken++;
      continue;
    }
    // Started without a conversation (the web, another device): nobody but the owner settles them.
    for (const t of listTasks(app, work_id).filter((x) => x.state === "assistant")) toAssistant(app, work_id, t.seq, t.question ?? "");
    ensureOwnerAsks(app, work_id);
    const last = lastRound(app, work_id);
    if (last.output.verdict === "awaiting-assistant") setRunOutput(app, last.id, { verdict: "awaiting-owner", reviewStop: "owner" });
    moved++;
  }
  return { closed, woken, moved };
}

export function closeTaskAsk(app: App, rootId: string, seq: number) {
  const w = workState(app, rootId);
  const id = w.asks?.[String(seq)];
  if (!id) return;
  cancelAsk(app, id);
  const asks = { ...(w.asks ?? {}) };
  delete asks[String(seq)];
  setWorkState(app, rootId, { asks });
}

registerAskHandler("code-task", async (app: App, ask: Ask, ctx) => {
  const { workId, seq } = ctx as { workId: string; seq: number };
  const t = getTask(app, workId, seq);
  if (t.state !== "owner" && t.state !== "assistant") return;
  const choice = ask.choice !== null ? ask.options[ask.choice]?.label ?? null : null;
  const text = choice && ask.answer?.startsWith(choice) ? ask.answer.slice(choice.length).replace(/^[：:]\s*/, "") : ask.choice === null ? ask.answer : "";
  const w = workState(app, workId);
  const asks = { ...(w.asks ?? {}) };
  delete asks[String(seq)];
  setWorkState(app, workId, { asks });
  answerTask(app, workId, seq, { choice, text, skip: choice === SKIP }, ask.answeredBy ?? ask.userId);
});

/**
 * The owner's words for a task-driven delegation (message_code_run, continue_code_run, the run
 * page): while the coder is coding they reach it at once (code-steer.ts) and null is returned;
 * otherwise, or when `asTask`, they become a task, coded in the next round, which starts now when
 * nothing is running.
 */
export function ownerNote(app: App, runId: string, text: string, by: string, opts: { asTask?: boolean } = {}): { task: CodeTask; next: Run | null } | null {
  const rootId = workRootOf(app, runId);
  const last = lastRound(app, rootId);
  const coding = last.status === "queued" || (last.status === "running" && typeof last.output.coderSummary !== "string");
  if (coding && !opts.asTask) return null;
  const first = text.trim().split("\n")[0];
  const task = addTask(app, rootId, { title: truncate(first, 120), doneWhen: text.trim(), kind: "owner", origin: { note: text.trim() } }, by);
  return { task, next: advanceWork(app, rootId, { owner: true }) };
}

/**
 * Words about how a task-driven delegation goes on rather than a change of their own (go on, mind
 * this, the environment works now): they reach the coder as the round's instructions — at once while
 * it codes, else with the next round, which starts now when there are tasks to do. Made a task, such
 * words could never be finished by a commit and would only come back as tries that failed.
 */
export function workNote(app: App, runId: string, text: string, by: string): string {
  const rootId = workRootOf(app, runId);
  const { stage, runId: at } = addCodeNote(app, runId, text, by);
  if (stage === "coding" || stage === "queued") return `已交给正在做的 ${at}：编码 Agent 在这一轮收到。`;
  const next = advanceWork(app, rootId, { owner: true });
  if (next) return `第 ${next.input.round ?? "?"} 轮 ${next.id} 开始做，这段话作为这一轮的交代交给编码 Agent。`;
  const waiting = listTasks(app, rootId).filter((t) => t.state === "owner" || t.state === "assistant");
  const w = workState(app, rootId);
  return [
    `记下了，下一轮开始时交给编码 Agent。${w.paused ? `交办暂停着（${w.paused}），` : roundOf(lastRound(app, rootId)) >= w.until ? `自动推进的 ${w.until} 轮用完了，` : "现在没有待做的修改项，"}所以没有开新的一轮。`,
    waiting.length ? `在等处理的：${waiting.map((t) => `${taskLabel(t.seq)}「${truncate(t.title, 40)}」${t.state === "assistant" ? "（等你处理）" : "（等本人决定）"}`).join("、")}。等你处理的用 settle_code_task 处理；等本人决定的，本人在这一轮回答了才用 settle_code_task（action=retry）转达。` : "",
    "要加一项新的修改，再调用一次并传 new_item=true。",
  ].filter(Boolean).join("\n");
}
