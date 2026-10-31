import type { App } from "../core/app.ts";
import type { RoleName } from "../core/config.ts";
import { one } from "../core/db.ts";
import { notify } from "../core/notify.ts";
import { git } from "../core/git.ts";
import { HttpError, truncate } from "../core/util.ts";
import { cancelAsk, createAsk, registerAskHandler, type Ask } from "./asks.ts";
import { codeChainFor, queueNextCodeRound, saveCodeChain, type CodeChain } from "./code-chain.ts";
import { reviewMetrics, worktreesOf } from "./code.ts";
import {
  addTask, getTask, headsAt, listCheckpoints, listTasks, renewBudget, retryTask, revertsCleanly, scheduleRevert, setWorkState, taskForFinding,
  stranded, taskLabel, taskText, updateTask, workOwner, workRootOf, workState, lastRound, TASK_STATE_LABEL, type CodeTask,
} from "./code-tasks.ts";
import { askConfirm, reviewContext, reviewRound, type RoundContext } from "./review-chain.ts";
import { queueStandaloneFix } from "./review-fix.ts";
import { planReview, reviewChecks, roundFindings, type ReviewPlan } from "./review.ts";
import { runRole } from "./runner.ts";
import { getRun, runUser, setRunOutput, type Run } from "./runs.ts";
import { readAgentSpec } from "./specs.ts";
import { workDirOf } from "./workspaces.ts";

/**
 * What happens after a coding round of a delegation driven by tasks (docs/v2/coding-loop.md §4):
 *
 * 1. each finished task that came from a finding goes back to the check that raised it, in that
 *    check's own session, which says fixed / not fixed / broke something / withdrawn;
 * 2. when nothing is left to do, review-lead decides what this stretch of the change needs reviewed
 *    (which checks, what each should look at), the checks review it, and review-lead routes each
 *    finding: a task done without the owner, a question for the owner, or rejected;
 * 3. then the next round takes the tasks still to do, within the budget; owner questions wait
 *    without holding the rest; with nothing left the work is done and waits for the owner's confirm.
 *
 * Nothing here asks the owner to approve a plan or a round.
 */

const roundOf = (r: Run) => Number((r.input as { round?: number }).round ?? 1);

/** A check's session for this work, unless it has grown past the resume limit. */
function sessionOf(app: App, rootId: string, check: string) {
  const s = workState(app, rootId).sessions?.[check];
  if (!s) return undefined;
  return s.used !== undefined && s.used > app.config.sessions.codeResumeMaxTokens ? undefined : s.id;
}
function keepSession(app: App, rootId: string, check: string, id: string | undefined, used: number | undefined) {
  if (!id) return;
  const w = workState(app, rootId);
  setWorkState(app, rootId, { sessions: { ...(w.sessions ?? {}), [check]: { id, ...(used !== undefined ? { used } : {}) } } });
}

export async function taskReview(app: App, codeRunId: string, rc: RoundContext): Promise<{ verdict: string; continuedRunId?: string }> {
  const run = getRun(app, codeRunId);
  const rootId = workRootOf(app, run.id);
  const toVerify = listTasks(app, rootId).filter((t) => t.state === "verify" && t.verifier);
  if (toVerify.length) {
    setRunOutput(app, run.id, { reviewStage: "verify" });
    await verifyTasks(app, run, toVerify, rc);
  }
  const open = listTasks(app, rootId).filter((t) => ["todo", "coding", "verify"].includes(t.state));
  const w = workState(app, rootId);
  const latest = listCheckpoints(app, rootId).at(-1)?.seq ?? 0;
  if (!open.length && !(w.reverts ?? []).length && latest > (w.stageAt ?? 0)) await stageReview(app, run, rc);
  return nextStep(app, getRun(app, run.id), rc);
}

// ---- verification -----------------------------------------------------------------------------

const VERIFY_BRIEF = [
  "# 验证修改项",
  "下面是你之前提的问题，编码 Agent 说已经改了。逐项读这一项的改动（必要时在工作区里看完整的代码），判断问题是不是真的解决了、有没有改出新问题，然后调用一次 `verify_tasks` 给每一项一个结论：",
  "- fixed：解决了；",
  "- not_fixed：没解决或只解决了一部分，note 写还差什么、该怎么改（交回编码 Agent 再改）；",
  "- regressed：这一项的改动本身带来了新问题，note 写清是什么和证据（会先回退这一项再重做）；",
  "- withdrawn：重新看过，问题本身不成立，note 写理由。",
  "编码 Agent 对问题有异议时，说明里会写它的理由：理由成立就 withdrawn，不成立就 not_fixed 并回应它的理由。",
  "只看这些修改项相关的改动；整份改动之后还有阶段评审，别的问题留给那时。",
].join("\n");

async function verifyTasks(app: App, run: Run, tasks: CodeTask[], rc: RoundContext) {
  const rootId = workRootOf(app, run.id);
  const ctx = await reviewContext(app, run.id);
  const groups = new Map<string, CodeTask[]>();
  for (const t of tasks) groups.set(t.verifier!, [...(groups.get(t.verifier!) ?? []), t]);
  rc.event("status", { text: `逐项验证：${[...groups].map(([c, l]) => `${ctx.label(c)} 验证 ${l.map((t) => taskLabel(t.seq)).join("、")}`).join("；")}` });
  await Promise.allSettled([...groups].map(async ([check, list]) => {
    const info = ctx.infos.get(check);
    if (!info || info.missing) {
      for (const t of list) updateTask(app, rootId, t.seq, { state: "done" }, { by: "host", kind: "host", text: `评审项 ${check} 已经不在了，没有逐项验证，交给阶段评审` });
      return;
    }
    const parts = list.map((t) => {
      const said = t.notes.filter((n) => n.kind === "coder").at(-1)?.text;
      const diff = ctx.worktrees.map((wt) => {
        const shas = t.commits[wt.space] ?? [];
        if (!shas.length) return "";
        const dir = workDirOf(wt);
        const first = shas[0];
        const body = git(dir, ["diff", "--no-color", `${first}^`, shas.at(-1)!]).stdout;
        return body.trim() ? `${ctx.multi ? `#### ${wt.space}\n\n` : ""}\`\`\`diff\n${truncate(body, 30000)}\n\`\`\`` : "";
      }).filter(Boolean).join("\n\n");
      return [taskText(app, t), said ? `编码 Agent 的说明：${truncate(said, 2000)}` : "", diff ? `#### 这一项的改动\n\n${diff}` : "（这一项没有找到对应的提交，在工作区里看现在的代码）"].filter(Boolean).join("\n\n");
    });
    try {
      const res = await runRole(app, {
        role: (info.builtin ? check : "reviewer") as RoleName,
        ...(info.builtin ? {} : { spec: readAgentSpec(app, check) }),
        reviewCheck: true,
        addTools: ["verify_tasks"],
        spaceId: run.spaceId!,
        spaces: ctx.spaces,
        alsoRead: ctx.indexed,
        task: `${VERIFY_BRIEF}\n\n${parts.join("\n\n")}`,
        runId: rc.runId,
        cwd: ctx.cwd,
        signal: rc.signal,
        onEvent: (e) => rc.event(e.type, { ...e, phase: "reviewer", check, verify: true }),
        profileId: info.builtin ? app.config.agents.roles[check] : undefined,
        resumeSessionId: sessionOf(app, rootId, check),
        persistSession: true,
      });
      keepSession(app, rootId, check, res.sessionId, res.contextUsage?.used);
    } catch (e) {
      if (rc.signal.aborted) throw e;
      rc.event("status", { text: `${ctx.label(check)}没能完成验证：${(e as Error).message}` });
    }
    // No verdict: the stage review covers it.
    for (const t of list) if (getTask(app, rootId, t.seq).state === "verify") updateTask(app, rootId, t.seq, { state: "done" }, { by: "host", kind: "host", text: `${ctx.label(check)}没有给出验证结论，交给阶段评审` });
  }));
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

async function planStage(app: App, run: Run, rc: RoundContext, since: Record<string, string> | undefined): Promise<ReviewPlan> {
  const rootId = workRootOf(app, run.id);
  const root = getRun(app, rootId);
  const worktrees = worktreesOf(app, rootId);
  const checks = reviewChecks(app).filter((c) => !c.missing);
  const history = checkHistory(app, rootId);
  const facts = worktrees.map((wt) => `${worktrees.length > 1 ? `### ${wt.space}\n\n` : ""}${changeFacts(workDirOf(wt), since?.[wt.space] ?? wt.start ?? wt.base)}`).join("\n\n");
  const tasks = listTasks(app, rootId);
  const input = root.input as { task?: string; reviewTier?: string; reviewChecks?: string[] };
  const ownerSaid = [input.reviewTier ? `本人点名的评审档位：${input.reviewTier}` : "", input.reviewChecks?.length ? `本人要求加上的评审项：${input.reviewChecks.join("、")}（必须选上）` : ""].filter(Boolean).join("\n");
  const task = [
    PLAN_BRIEF,
    `## 这一段改动（${since ? "上次评审以后" : "从开始到现在"}）\n\n${facts}`,
    `## 修改项\n\n${tasks.map((t) => `- ${taskLabel(t.seq)} [${TASK_STATE_LABEL[t.state]}] ${t.title}`).join("\n") || "（没有）"}`,
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
  const draft = getRun(app, run.id).output.reviewPlanDraft as { checks: { name: string; focus: string }[]; skipped?: { name: string; reason: string }[]; summary: string } | null | undefined;
  const metrics = reviewMetrics(worktrees, (getRun(app, run.id).output.repos ?? []) as never, String(input.task ?? ""));
  const w = workState(app, rootId);
  if (draft?.checks.length) {
    const names = [...new Set([...draft.checks.map((c) => c.name), ...(input.reviewChecks ?? [])])].filter((n) => checks.some((c) => c.name === n));
    return {
      tier: "ai", tierName: "按改动定", checks: names, maxRounds: w.until, metrics, lead: true,
      reasons: [draft.summary, ...(draft.skipped ?? []).map((s) => `没选 ${s.name}：${s.reason}`)],
      focus: Object.fromEntries(draft.checks.map((c) => [c.name, c.focus])),
    };
  }
  const fallback = planReview(app, metrics, { tier: input.reviewTier, extraChecks: input.reviewChecks });
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
}

// ---- what next ------------------------------------------------------------------------------------

/** The rounds of auto tasks the last stage reviews asked for did not go down: stop and say so. */
function notConverging(stages: number[]) {
  const last = stages.slice(-3);
  return last.length === 3 && last[0] > 0 && last[1] >= last[0] && last[2] >= last[1];
}

async function nextStep(app: App, run: Run, rc: RoundContext): Promise<{ verdict: string; continuedRunId?: string }> {
  const rootId = workRootOf(app, run.id);
  const tasks = listTasks(app, rootId);
  const w = workState(app, rootId);
  const todo = tasks.filter((t) => t.state === "todo");
  const owner = tasks.filter((t) => t.state === "owner");
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
      return { ...finish("continuing"), continuedRunId: next.id };
    }
    return finish("paused", { reviewStop: "paused" });
  }
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
    return queueStandaloneFix(app, rootId, last.id, title, runUser(app, last.id), {}, { allowRunning: last.id });
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
  const tasks = listTasks(app, rootId);
  if (tasks.some((t) => t.state === "todo" || stranded(app, t)) || (w.reverts ?? []).length) {
    const next = queueRound(app, rootId, last);
    if (next) setRunOutput(app, last.id, { verdict: "continuing", reviewStop: null });
    return next;
  }
  // Nothing to code: what was left were questions the owner has now settled.
  if (!tasks.some((t) => ["owner", "verify", "coding"].includes(t.state)) && last.output.verdict === "awaiting-owner") {
    setRunOutput(app, last.id, { verdict: "approved", reviewStop: null });
    completed(app, rootId, getRun(app, last.id));
  }
  return null;
}

// ---- owner questions --------------------------------------------------------------------------------

const SKIP = "不做这一项";

/** One card per task waiting for the owner, in the conversation the work reports to (or the home page). */
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
      question: `「${truncate(getRun(app, rootId).title, 40)}」的 ${taskLabel(t.seq)}「${t.title}」需要你决定：\n${t.question ?? t.doneWhen}\n其他修改项照常推进；可以在输入框里写你的做法。`,
      options: [...t.options, SKIP].map((label) => ({ label })),
      allowText: true,
      context: { handler: "code-task", workId: rootId, seq: t.seq },
    });
    asks[String(t.seq)] = ask.id;
    changed = true;
  }
  if (changed) setWorkState(app, rootId, { asks });
}

/** The owner's answer to a task's question: done their way, or not at all. Then the work goes on. */
export function answerTask(app: App, rootId: string, seq: number, a: { choice?: string | null; text?: string | null; skip?: boolean }, by: string) {
  const t = getTask(app, rootId, seq);
  if (t.state !== "owner") throw new HttpError(409, `${taskLabel(seq)} 现在是「${TASK_STATE_LABEL[t.state]}」，不在等你决定`);
  const text = [a.choice && a.choice !== SKIP ? a.choice : "", a.text?.trim() ?? ""].filter(Boolean).join("：");
  if (a.skip || a.choice === SKIP) updateTask(app, rootId, seq, { state: "wontdo", answer: text || "不做" }, { by, kind: "owner", text: `本人决定不做${a.text?.trim() ? `：${a.text.trim()}` : ""}` });
  else {
    if (!text) throw new HttpError(400, "选一个做法，或者写下你要怎么做");
    updateTask(app, rootId, seq, { state: "todo", answer: text, attempts: 0 }, { by, kind: "owner", text: `本人决定：${text}` });
  }
  closeTaskAsk(app, rootId, seq);
  return advanceWork(app, rootId, { owner: true });
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
  if (t.state !== "owner") return;
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
