import { join } from "node:path";
import type { App } from "../core/app.ts";
import type { RoleName } from "../core/config.ts";
import { notify } from "../core/notify.ts";
import { one } from "../core/db.ts";
import { HttpError, truncate } from "../core/util.ts";
import { createAsk, registerAskHandler, type Ask } from "./asks.ts";
import { type CodeChain, queueNextCodeRound, maxCodeRounds, saveCodeChain, setChainAwaitingUser } from "./code-chain.ts";
import { codePatches, isBranchReview, worktreesOf } from "./code.ts";
import {
  blocksAt, checkBrief, recordReview, reviewChecks, reviewFor, reviewTiers, roundFindings, stopReason,
  SEVERITY_LABEL, STOP_LABEL, type ChangePoint, type LeadResult, type ReviewPlan, type Severity, type StopReason,
} from "./review.ts";
import { runRole } from "./runner.ts";
import { createRun, getRun, registerHandler, runUser, setRunOutput, type Run } from "./runs.ts";
import { readAgentSpec } from "./specs.ts";
import { replyOf } from "./types.ts";

/**
 * One review round of a coding delegation (docs/v2/review.md §4): the planned checks run in their
 * own sessions; with a lead, review-lead rules on the findings (merge, accept / reject), writes the
 * change request and names what to re-review; the host then queues the next coding round, or stops
 * and asks the owner (round limit, no convergence, a stalemate, a disagreement on the approach).
 * It runs at the end of the coding run, or later as a `review` run once the owner confirmed the plan.
 * Everything it decides is written on the coding run, which the web page and Feishu card show.
 */

type Out = {
  task?: string;
  repos?: { space: string; diffStat: string; diffBytes: number; check: { command: string; code: number; output: string } | null }[];
  coderSummary?: string;
  coderSessionId?: string;
  indexedSpaces?: string[];
  reviewPlan?: ReviewPlan;
  codeChain?: CodeChain;
  reviewLeadDraft?: Omit<LeadResult, "by" | "stop">;
};
export type RoundContext = { runId: string; signal: AbortSignal; event(type: string, data: unknown): void };

/** The coding run a tool call belongs to: the run itself, or the review run working on it. */
export function codeRunOf(app: App, runId: string | null): Run | null {
  if (!runId) return null;
  const r = getRun(app, runId);
  if (r.kind === "code") return r;
  const id = r.kind === "review" ? (r.input as { codeRunId?: string }).codeRunId : undefined;
  return id ? getRun(app, id) : null;
}

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";
const chainOf = (app: App, r: Run) => {
  const c = (r.output as Out).codeChain;
  return c ? ((getRun(app, c.askRunId).output.codeChain as CodeChain | undefined) ?? c) : null;
};
const roundOf = (r: Run) => (r.input as { round?: number }).round ?? 1;

/**
 * What every reviewer of a delegation reads, and where: the task, the item's materials and the
 * owner's decisions, the checks, the diff; the spaces it may read and the working directory.
 */
async function reviewContext(app: App, codeRunId: string, note?: string) {
  const run = getRun(app, codeRunId);
  const input = run.input as { task: string; reviewExecution?: import("./execution.ts").Execution; repos?: string[]; readSpaces?: string[]; itemId?: string; fromReview?: string };
  const { decisionsBrief, workRuns } = await import("./review-fix.ts");
  const out = run.output as Out;
  const plan = out.reviewPlan;
  const round = roundOf(run);
  const branchReview = isBranchReview(run);
  const root = (run.input as { continueFrom?: string }).continueFrom ?? run.id;
  const worktrees = worktreesOf(app, root);
  const results = out.repos ?? [];
  const multi = results.length > 1;
  const cwd = multi ? join(app.runsDir, root, "work") : worktrees[0]?.path;
  const { materialSpaces, materialsBrief } = await import("../items/materials.ts");
  const owner = runUser(app, run.id);
  const spaces = [...new Set([run.spaceId!, ...results.map((r) => r.space), ...(input.readSpaces ?? []), ...(input.itemId ? materialSpaces(app, input.itemId, owner) : [])])];
  const indexed = out.indexedSpaces ?? [];
  const patches = codePatches(app, run.id);
  const diffs = patches.map((p) => (multi ? `### ${p.space}\n\n${fence("diff", p.patch)}` : fence("diff", p.patch)));
  const statText = results.filter((r) => r.diffStat).map((r) => (multi ? `[${r.space}]\n${r.diffStat}` : r.diffStat)).join("\n\n");
  const infos = new Map(reviewChecks(app).map((c) => [c.name, c]));
  const label = (n: string) => infos.get(n)?.label ?? n;

  const head = (r: { space: string }) => (multi ? `### ${r.space}\n\n` : "");
  const checkText = results.map((r) => (r.check ? `${head(r)}命令：${r.check.command}\n退出码：${r.check.code}\n\n${fence("", r.check.output.slice(-4000))}` : `${head(r)}没有配置检查命令。`)).join("\n\n");
  const reviewTask = [
    `## ${branchReview ? "需求与评审要求" : "原始需求"}\n\n${input.task}`,
    input.itemId ? materialsBrief(app, input.itemId, owner) : "",
    decisionsBrief(app, [...workRuns(app, run.id), ...(input.fromReview ? workRuns(app, input.fromReview) : [])]),
    note ? `## 本人确认评审计划时补充\n\n${note}` : "",
    multi ? `## 涉及的仓库\n\n${worktrees.map((w) => `- ${w.space}：${w.path}`).join("\n")}\n\n工作目录下每个子目录是一个仓库的 worktree；改过的文件也能用 omem 工具查（space: "*"）。` : "",
    `## ${branchReview ? "要评审的分支" : "编码 Agent 的说明"}\n\n${out.coderSummary ?? ""}`,
    `## 检查结果\n\n${checkText}`,
    `## 改动统计\n\n${statText}`,
    `## 完整 diff\n\n${truncate(diffs.join("\n\n"), 80000)}`,
  ].filter(Boolean).join("\n\n");

  return { run, input, out, plan, round, branchReview, root, worktrees, results, multi, cwd, spaces, indexed, infos, label, reviewTask };
}

const SPLIT_BRIEF = [
  "## 你这次只做需求拆分",
  "不评问题，只把需求拆成可以对着代码审阅的变更点，给本人在网页上从需求走到代码：",
  "- 按业务划分（不按文件），编号 C1、C2…，标题一句话说清要做成什么；",
  "- 需求小（十来个点以内、集中在一处）就平铺；涉及几个页面或模块时建成树：先按页面或模块建分组节点（如 M1 退款申请页），再用 `parent` 把变更点挂在下面，必要时再往下分一层，最多 4 层。怎么分组跟着需求材料自己的组织走（需求文档的章节、原型的页面、技术方案的模块）；分组节点也写需求怎么说，状态按下面各项汇总；",
  "- 每个写需求怎么说（带 `src:` 引用，需求文档、群聊、技术方案里的原文）、代码怎么做；",
  "- 状态：done 已实现 / partial 部分实现 / missing 没实现 / extra 需求外的改动；",
  "- 实现位置：文件和改动后的行段（几个仓库时路径前加仓库空间 id），找不准行号就只写文件，不要编；引用的原件 id 要从 search / read_source 的结果里原样抄。",
  "读完材料和 diff 后调用一次 `submit_change_points` 提交，再用一两句话说明拆分的思路。",
].join("\n");

/**
 * The requirement split into change points mapped to the code (the run page's “变更”), on its own:
 * next to the checks when the tier has no business check, or on request for an earlier review.
 * The business reviewer's role does it, reading what the checks read.
 */
export async function splitChangePoints(app: App, codeRunId: string, rc: RoundContext, opts: { note?: string; revise?: boolean } = {}) {
  const { run, input, cwd, spaces, indexed, reviewTask } = await reviewContext(app, codeRunId);
  // Reworking an earlier split: the points as they stand and what the owner wants changed.
  const before = opts.revise ? currentPoints(app, run) : [];
  const revise = [
    before.length ? `## 之前的拆分\n\n在它的基础上按本人的要求调整：本人没提到的地方保持原样，编号尽量不变（挪进新的分组也保留原编号）；要求本身就是重拆的，才整个重拆。提交时交完整的一份（整份替换）。\n\n${fence("json", JSON.stringify(before, null, 1))}` : "",
    opts.note?.trim() ? `## 本人这次的要求\n\n${opts.note.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  rc.event("status", { text: before.length ? "按要求重新整理需求拆分" : "拆分需求、对上代码" });
  await runRole(app, {
    role: "review-business",
    reviewCheck: true,
    spaceId: run.spaceId!,
    spaces,
    alsoRead: indexed,
    task: [reviewTask, SPLIT_BRIEF, revise].filter(Boolean).join("\n\n"),
    runId: rc.runId,
    cwd,
    signal: rc.signal,
    onEvent: (e) => rc.event(e.type, { ...e, phase: "reviewer", check: "split" }),
    profileId: app.config.agents.roles["review-business"],
    userId: runUser(app, run.id),
    execution: input.reviewExecution,
  });
  const saved = (getRun(app, run.id).output as { changePoints?: { round: number } }).changePoints;
  if (saved?.round !== roundOf(run)) throw new Error("没有提交变更点");
}

/**
 * A split of its own for a delegation's or branch review's latest round, as a `review` run: for an
 * earlier review that has none, or (`revise`) reworking the points it has by the owner's note.
 */
export async function requestSplit(app: App, runId: string, opts: { note?: string; revise?: boolean; userId: string }) {
  const { workRuns } = await import("./review-fix.ts");
  const last = getRun(app, workRuns(app, runId).at(-1)!);
  if (last.kind !== "code" || !last.output.reviewPlan) throw new HttpError(400, "只有评审过的交办或分支评审能拆分需求");
  const revise = !!opts.revise && currentPoints(app, last).length > 0;
  if (one(app.db, "select 1 from runs where parent_id = ? and kind = 'review' and status in ('queued', 'running')", last.id)) {
    throw new HttpError(409, "这次评审还在进行，等它结束再拆分");
  }
  return createRun(app, {
    kind: "review", spaceId: last.spaceId, title: `${revise ? "重新整理需求拆分" : "需求拆分"}：${last.title.slice(0, 60)}`,
    input: { codeRunId: last.id, splitOnly: true, revise, note: opts.note?.trim() || undefined }, parentId: last.id, userId: opts.userId,
  });
}

/** The change points a round shows now: the split of its own if one ran, else the business check's. */
export function currentPoints(app: App, run: Run): ChangePoint[] {
  const own = (run.output as { changePoints?: { round: number; points: ChangePoint[] } | null }).changePoints;
  if (own?.round === roundOf(run) && own.points.length) return own.points;
  const row = reviewFor(app, run.id, roundOf(run), "review-business");
  return row?.change_points ? (JSON.parse(row.change_points) as ChangePoint[]) : [];
}

export async function reviewRound(app: App, codeRunId: string, rc: RoundContext, opts: { note?: string } = {}): Promise<{ verdict: string; continuedRunId?: string }> {
  const { run, input, out, plan, round, branchReview, root, worktrees, results, multi, cwd, spaces, indexed, infos, label, reviewTask } = await reviewContext(app, codeRunId, opts.note);
  if (!plan) throw new HttpError(409, "这次交办还没有评审计划");
  setRunOutput(app, run.id, { reviewStage: "checks" });
  rc.event("status", { text: `独立评审中：「${plan.tierName}」档，${plan.checks.map(label).join("、")}（${plan.reasons.join("；")}）` });
  // The requirement split into change points comes from the business check; without one in this
  // tier, a split of its own runs next to the checks.
  const split = plan.checks.includes("review-business") ? null : splitChangePoints(app, run.id, rc).catch((e) => rc.event("status", { text: `需求拆分没有完成：${(e as Error).message}` }));

  // Each check is its own session with read-only tools; one failing does not stop the others.
  const runCheck = async (name: string) => {
    const info = infos.get(name)!;
    const res = await runRole(app, {
      role: (info.builtin ? name : "reviewer") as RoleName,
      ...(info.builtin ? {} : { spec: readAgentSpec(app, name) }),
      reviewCheck: true,
      execution: name === "reviewer" ? input.reviewExecution : undefined,
      spaceId: run.spaceId!,
      spaces,
      alsoRead: indexed,
      task: `${reviewTask}\n\n${checkBrief(info, plan)}`,
      runId: rc.runId,
      cwd,
      signal: rc.signal,
      onEvent: (e) => rc.event(e.type, { ...e, phase: "reviewer", check: name }),
      profileId: info.builtin ? app.config.agents.roles[name] : undefined,
    });
    const text = replyOf(res).trim();
    // A check that only wrote text (an older customized prompt) still counts, by its verdict line.
    if (!reviewFor(app, run.id, round, name)) {
      const ok = /结论[：:]\s*通过/.test(text) || (!/结论[：:]/.test(text) && /结论[：:]\s*通过/.test(res.text));
      recordReview(app, { codeRunId: run.id, round, check: name, tier: plan.tier, verdict: ok ? "approved" : "changes_requested", summary: truncate(text, 4000), findings: [], ai: res.ai });
    }
    return { name, text, ai: res.ai, profileId: res.profileId };
  };
  const outcomes = await Promise.allSettled(plan.checks.map(runCheck));
  await split;
  // A review is worth a second try (a stalled backend, a dropped connection); what fails again goes
  // to the owner, who decides whether to try once more.
  const retry = plan.checks.flatMap((name, i) => (outcomes[i].status === "rejected" ? [i] : []));
  if (retry.length && !rc.signal.aborted) {
    rc.event("status", { text: `${retry.map((i) => label(plan.checks[i])).join("、")}没有完成，${REVIEW_RETRY_DELAY_MS / 1000} 秒后自动重试一次` });
    await new Promise((ok) => { const t = setTimeout(ok, REVIEW_RETRY_DELAY_MS); rc.signal.addEventListener("abort", () => { clearTimeout(t); ok(null); }, { once: true }); });
    if (rc.signal.aborted) throw new Error("CANCELLED");
    const again = await Promise.allSettled(retry.map((i) => runCheck(plan.checks[i])));
    retry.forEach((i, k) => { outcomes[i] = again[k]; });
  }
  const failed = outcomes.flatMap((o, i) => (o.status === "rejected" ? [{ name: plan.checks[i], error: (o.reason as Error).message }] : []));
  if (failed.length && !rc.signal.aborted) {
    const ask = askRetry(app, run, chainOf(app, run), failed.map((f) => ({ check: label(f.name), error: f.error })), failed.length === outcomes.length);
    setRunOutput(app, run.id, { reviewAskId: ask.id });
  }
  if (failed.length === outcomes.length) throw new Error(`评审没有完成（已自动重试一次，是否再试已发给本人）：${failed.map((f) => `${label(f.name)}：${f.error}`).join("；")}`);
  for (const f of failed) recordReview(app, { codeRunId: run.id, round, check: f.name, tier: plan.tier, verdict: "failed", summary: f.error, findings: [] });
  const done = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
  const single = plan.checks.length === 1 && done.length === 1;
  const reviewText = single
    ? done[0].text
    : [...done.map((d) => `### ${label(d.name)}（${reviewFor(app, run.id, round, d.name)?.verdict === "approved" ? "通过" : "需要修改"}）\n\n${d.text}`), ...failed.map((f) => `### ${label(f.name)}（没有完成）\n\n${f.error}`)].join("\n\n");
  setRunOutput(app, run.id, { review: reviewText, reviewAI: done[0]?.ai, reviewAgent: done[0]?.profileId });

  // ---- ruling: review-lead, or the host's simple merge ----------------------------------------
  let lead: LeadResult = hostRuling(app, run.id, round, done.map((d) => ({ name: d.name, text: d.text })), single);
  if (plan.lead) {
    setRunOutput(app, run.id, { reviewStage: "lead", reviewLeadDraft: null });
    rc.event("status", { text: "评审负责人汇总各评审项的问题" });
    try {
      await runRole(app, {
        role: "review-lead",
        reviewLead: true,
        spaceId: run.spaceId!,
        spaces,
        alsoRead: indexed,
        task: leadTask(app, run, plan, reviewTask, failed.map((f) => f.name)),
        runId: rc.runId,
        cwd,
        signal: rc.signal,
        onEvent: (e) => rc.event(e.type, { ...e, phase: "lead" }),
        profileId: app.config.agents.roles["review-lead"],
      });
      const draft = (getRun(app, run.id).output as Out).reviewLeadDraft;
      if (draft && draft.round === round) lead = { ...draft, by: "lead" };
      else rc.event("status", { text: "评审负责人没有提交裁决，按各评审项的结论合并" });
    } catch (e) {
      if (rc.signal.aborted) throw e;
      rc.event("status", { text: `评审负责人没有完成（${(e as Error).message}），按各评审项的结论合并` });
    }
  }

  // ---- what next ---------------------------------------------------------------------------
  let chain = chainOf(app, run);
  if (chain && chain.maxRounds !== plan.maxRounds) {
    chain = { ...chain, maxRounds: plan.maxRounds };
    saveCodeChain(app, chain, chain.askRunId, ...chain.rounds);
  }
  const rounds = (chain?.rounds ?? [run.id]).map((id) => getRun(app, id)).filter((r) => roundOf(r) <= round).map((r) => ({ runId: r.id, round: roundOf(r) }));
  const approved = lead.verdict === "approve";
  let stop: StopReason | null = null;
  if (!approved) stop = plan.lead ? stopReason(app, rounds, maxCodeRounds(app, chain), lead.verdict) : round >= maxCodeRounds(app, chain) ? "auto-limit" : null;
  lead = { ...lead, round, ...(stop ? { stop } : {}) };
  setRunOutput(app, run.id, { reviewLead: lead, reviewStage: "done", reviewStop: stop, verdict: approved ? "approved" : "changes-requested" });

  // Reviewing an existing branch ends with the review: nobody here codes on it.
  if (!approved && !stop && chain && !branchReview) {
    // Keep the same delegation going: the coder resumes its session and works the change request.
    const every = app.config.review.rereviewAllEvery;
    const reviewOnly = plan.lead && (round + 1) % every !== 0 && lead.rerun.length ? lead.rerun : undefined;
    const next = queueNextCodeRound(app, chain, `评审要求修改（第 ${round} 轮评审）：\n\n${lead.changeRequest.slice(0, 12000)}`, { resumeSessionId: (run.output as Out).coderSessionId, reviewOnly });
    if (next) {
      rc.event("status", { text: `评审要求修改，已在同一会话安排第 ${next.chain.round} 轮${reviewOnly ? `，下一轮只复审：${reviewOnly.map(label).join("、")}` : ""}` });
      setRunOutput(app, run.id, { codeChain: next.chain });
      return { verdict: "changes-requested", continuedRunId: next.run.id };
    }
    stop = "auto-limit";
    setRunOutput(app, run.id, { reviewStop: stop, reviewLead: { ...lead, stop } });
  }
  const results2 = results.filter((r) => r.check);
  const statLine = results.map((r) => (multi ? `${r.space}：` : "") + (r.diffStat.split("\n").pop()?.trim() ?? "")).join("；");
  const checksLine = results2.length ? `，检查${results2.some((r) => r.check!.code !== 0) ? "没通过" : "通过"}` : "";
  const digest = reviewDigest(app, getRun(app, run.id), round, lead, `${statLine}${checksLine}`);
  const title = branchReview ? `分支评审${approved ? "通过" : "要求修改"}：${run.title}` : `${approved ? "交办完成，评审通过" : stop ? `交办第 ${round} 轮评审停下来等你决定：${STOP_LABEL[stop]}` : "交办评审要求修改"}：${run.title}`;
  // The owner's next step goes out as a card with buttons, in the conversation that asked for the work.
  const ask = stop && plan.lead && chain && !branchReview ? escalate(app, run, chain, { ...lead, stop }, digest) : askDone(app, run, chain, { title, digest, approved, branchReview });
  if (ask) setRunOutput(app, run.id, { reviewAskId: ask.id });
  else {
    const { workForChild } = await import("./agent-work.ts");
    const work = workForChild(app, run);
    notify(app, {
      title,
      body: digest,
      link: `#/runs/${run.id}`,
      // Inside a multi-agent work the nudge belongs to the work's current topic, not a private DM.
      ...(work ? { larkConversationId: work.workConversationId } : {}),
    });
  }
  // The item's timeline records the outcome (an item deleted since then has none).
  if (input.itemId && one(app.db, "select 1 from items where id = ?", input.itemId)) {
    const { addItemEvent } = await import("../items/store.ts");
    addItemEvent(app, input.itemId, "note", `${branchReview ? "分支评审" : `交办第 ${round} 轮评审`}${approved ? "通过" : "要求修改"}（${run.id}）${lead.summary ? `：${truncate(lead.summary, 400)}` : ""}`);
  }
  return { verdict: approved ? "approved" : "changes-requested" };
}

/**
 * Without a lead: every finding at or above its check's blocking level must be fixed; checks
 * that found none pass. The change request lists those, then each asking check's own words.
 */
function hostRuling(app: App, codeRunId: string, round: number, done: { name: string; text: string }[], single: boolean): LeadResult {
  const infos = new Map(reviewChecks(app).map((c) => [c.name, c]));
  const findings = roundFindings(app, codeRunId, round);
  const asking = done.map((d) => {
    const info = infos.get(d.name)!;
    const row = reviewFor(app, codeRunId, round, d.name)!;
    const mine = findings.filter((f) => f.check_name === d.name);
    const blocking = mine.filter((f) => blocksAt(f.severity, info.blocks));
    // Findings below the check's blocking level do not hold the change, whatever the verdict said.
    const ok = !blocking.length && (row.verdict === "approved" || mine.length > 0);
    return { ...d, label: info.label, ok, blocking };
  }).filter((v) => !v.ok);
  const changeRequest = asking.map((v) => [
    single ? "" : `### ${v.label}`,
    v.blocking.map((f, i) => `${i + 1}. [${SEVERITY_LABEL[f.severity as Severity]}] ${f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""} ` : ""}${f.title}${f.suggestion ? `：${f.suggestion}` : ""}`).join("\n"),
    v.text,
  ].filter(Boolean).join("\n\n")).join("\n\n");
  return {
    round,
    verdict: asking.length ? "revise" : "approve",
    summary: asking.length ? `${asking.map((v) => v.label).join("、")}评审要求修改` : "各评审项都通过",
    changeRequest,
    rerun: asking.map((v) => v.name),
    by: "host",
  };
}

/** What review-lead reads: this round's findings by number, earlier rulings, and the change. */
function leadTask(app: App, run: Run, plan: ReviewPlan, reviewTask: string, failed: string[]) {
  const infos = new Map(reviewChecks(app).map((c) => [c.name, c]));
  const round = roundOf(run);
  const fmt = (f: ReturnType<typeof roundFindings>[number]) => {
    const info = infos.get(f.check_name);
    const blocking = info && blocksAt(f.severity, info.blocks);
    return `- #${f.id} [${info?.label ?? f.check_name} · ${SEVERITY_LABEL[f.severity]}${blocking ? " · 达到阻塞级别" : ""}] ${f.file_path ? `${f.file_path}${f.line ? `:${f.line}` : ""} ` : ""}${f.title}${f.detail ? `\n  ${truncate(f.detail, 600)}` : ""}${f.suggestion ? `\n  建议：${truncate(f.suggestion, 400)}` : ""}`;
  };
  const now = roundFindings(app, run.id, round);
  const chain = chainOf(app, run);
  const earlier = (chain?.rounds ?? []).map((id) => getRun(app, id)).filter((r) => roundOf(r) < round).map((r) => {
    const l = (r.output as { reviewLead?: LeadResult }).reviewLead;
    const accepted = roundFindings(app, r.id, roundOf(r)).filter((f) => ["accepted", "open"].includes(f.state));
    return `### 第 ${roundOf(r)} 轮\n\n${l ? `结论：${l.verdict}；${l.summary}` : "（没有负责人裁决）"}\n${accepted.map((f) => `- [${infos.get(f.check_name)?.label ?? f.check_name}] ${f.title}`).join("\n") || "- （没有要改的）"}`;
  });
  const reviews = plan.checks.map((n) => {
    const row = reviewFor(app, run.id, round, n);
    return `- ${infos.get(n)?.label ?? n}（${n}）：${row ? `${row.verdict}；${truncate(row.summary.replace(/\s+/g, " "), 300)}` : "没有结果"}`;
  });
  return [
    `## 你在裁决第 ${round} 轮（「${plan.tierName}」档，最多 ${plan.maxRounds} 轮）`,
    `## 各评审项的结论\n\n${reviews.join("\n")}${failed.length ? `\n\n没有完成的评审项：${failed.join("、")}（不要替它们下结论，在 summary 里说明缺了哪项）` : ""}`,
    `## 这一轮的问题\n\n${now.map(fmt).join("\n") || "（没有问题）"}`,
    earlier.length ? `## 之前的轮次\n\n${earlier.join("\n\n")}\n\n同一个问题修过还在报时，判断是没修好还是评审要求不合理；连续僵持说明该交给本人（escalate）。` : "",
    `## 评审项（下一轮可选择只复审其中受影响的）\n\n${plan.checks.map((n) => `- ${n}（${infos.get(n)?.label ?? n}）：${SEVERITY_LABEL[infos.get(n)?.blocks ?? "major"]}及以上阻塞`).join("\n")}`,
    reviewTask,
  ].filter(Boolean).join("\n\n");
}

// ---- asking the owner ---------------------------------------------------------------------------

/** Plan confirmation before reviews start (tiers with confirmPlan). */
export function askPlan(app: App, run: Run, chain: CodeChain | null, plan: ReviewPlan) {
  const tiers = reviewTiers(app).filter((t) => t.id !== plan.tier);
  const labels = new Map(reviewChecks(app).map((c) => [c.name, c.label]));
  const options = [{ label: "按计划开始评审" }, ...tiers.slice(0, 4).map((t) => ({ label: `改用「${t.name}」档` }))];
  // What the coder did, so the card says more than “done”.
  const out = run.output as Out;
  const change = (out.repos ?? []).map((r) => r.diffStat.split("\n").pop()?.trim()).filter(Boolean).join("；");
  const failedCheck = (out.repos ?? []).some((r) => r.check && r.check.code !== 0);
  const coded = isBranchReview(run) ? "" : [change && `**改动**：${change}${(out.repos ?? []).some((r) => r.check) ? `，检查${failedCheck ? "没通过" : "通过"}` : ""}`, out.coderSummary && `**编码 Agent 的说明**：${truncate(out.coderSummary.trim(), 600)}`].filter(Boolean).join("\n");
  return createAsk(app, {
    runId: run.id,
    conversationId: chain?.conversationId ?? null,
    question: `「${truncate(run.title, 40)}」${isBranchReview(run) ? "分支已检出" : "第 1 轮编码完成"}。${coded ? `\n${coded}\n` : ""}评审计划：「${plan.tierName}」档，${plan.checks.map((c) => labels.get(c) ?? c).join("、")}，最多 ${plan.maxRounds} 轮。\n理由：${plan.reasons.join("；")}\n开始评审吗？也可以直接回一句补充要求。`,
    options,
    context: { handler: "review-plan", codeRunId: run.id, tiers: [plan.tier, ...tiers.slice(0, 4).map((t) => t.id)] },
  });
}

/** How long a failed review check waits before its automatic second try. */
export let REVIEW_RETRY_DELAY_MS = 30_000;
export function setReviewRetryDelayForTests(ms: number) {
  REVIEW_RETRY_DELAY_MS = ms;
}

/** Checks that failed twice: the owner decides whether to run the review again. */
function askRetry(app: App, run: Run, chain: CodeChain | null, failed: { check: string; error: string }[], all: boolean) {
  return createAsk(app, {
    runId: run.id,
    conversationId: chain?.conversationId ?? null,
    question: [
      `「${truncate(run.title, 40)}」的评审${all ? "没有完成" : `有 ${failed.length} 项没有完成，其余已出结论`}，自动重试一次后仍然失败：`,
      failed.map((f) => `- ${f.check}：${truncate(f.error, 160)}`).join("\n"),
      "要再评审一次吗？（会重新跑这一轮的全部评审项）",
    ].join("\n"),
    options: [{ label: "重试评审" }, { label: "不用了" }],
    context: { handler: "review-retry", codeRunId: run.id },
  });
}

async function onRetryAnswer(app: App, ask: Ask, ctx: { codeRunId: string }) {
  if (ask.choice !== 0 && !(ask.choice === null && ask.answer)) return;
  const run = getRun(app, ctx.codeRunId);
  setRunOutput(app, run.id, { verdict: null, reviewStage: "queued" });
  createRun(app, { kind: "review", spaceId: run.spaceId, title: `重新评审：${truncate(run.title, 60)}`, input: { codeRunId: run.id, note: ask.choice === null ? ask.answer ?? undefined : undefined }, parentId: run.id });
}

/**
 * A finished review in a few lines for the owner's card: the ruling, the change, the problems the
 * fix would take up (the serious ones and those review-lead accepted, as the run page preselects them)
 * and the requirement split.
 */
function reviewDigest(app: App, run: Run, round: number, lead: LeadResult, change: string) {
  const findings = roundFindings(app, run.id, round).filter((f) => !["rejected", "merged"].includes(f.state));
  const counts = (["blocker", "major", "minor", "nit"] as const).map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  const toFix = fixCandidates(app, run.id, round);
  const where = (f: { file_path: string | null; line: number | null }) => (f.file_path ? ` — \`${f.file_path}${f.line ? `:${f.line}` : ""}\`` : "");
  const points = (run.output as { changePoints?: { round: number; points: { status: string }[] } }).changePoints;
  const pts = points?.round === round ? points.points : [];
  const POINT: Record<string, string> = { done: "已实现", partial: "部分实现", missing: "没实现", extra: "需求外" };
  return [
    lead.summary ? `**结论**：${truncate(lead.summary, 400)}` : "",
    change ? `**改动**：${change}` : "",
    counts.length ? `**问题**：${counts.map(([s, n]) => `${SEVERITY_LABEL[s]} ${n}`).join(" · ")}${toFix.length ? `，默认要改 ${toFix.length} 个` : ""}` : "**问题**：没有",
    toFix.slice(0, 5).map((f, i) => `${i + 1}. [${SEVERITY_LABEL[f.severity as Severity]}] ${f.title}${where(f)}`).join("\n"),
    toFix.length > 5 ? `……另有 ${toFix.length - 5} 个` : "",
    pts.length ? `**需求拆分**：${pts.length} 个变更点（${Object.keys(POINT).map((s) => [s, pts.filter((p) => p.status === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${POINT[s]} ${n}`).join("、")}）` : "",
  ].filter(Boolean).join("\n");
}

/** The findings a fix takes up without the owner picking: their own “改”, else the accepted and the serious open ones. */
function fixCandidates(app: App, codeRunId: string, round: number) {
  return roundFindings(app, codeRunId, round).filter((f) => {
    const decision = (f as { decision?: string | null }).decision;
    if (decision) return decision === "fix";
    return f.state === "accepted" || (f.state === "open" && (f.severity === "blocker" || f.severity === "major"));
  });
}

const FIX = "按评审修改";
const LATER = "先不改";
const APPLY = "应用到仓库";
const DISCARD = "丢弃改动";

/** The end of a review that needs nothing more from the reviewers: what the owner can do next, as buttons. */
function askDone(app: App, run: Run, chain: CodeChain | null, d: { title: string; digest: string; approved: boolean; branchReview: boolean }) {
  const toFix = fixCandidates(app, run.id, roundOf(run));
  // A passed branch review with nothing to fix leaves nothing to decide.
  const labels = !d.branchReview && chain && d.approved ? [APPLY, DISCARD] : toFix.length || !d.approved ? [FIX, LATER] : null;
  if (!labels) return null;
  const hint = labels[0] === FIX
    ? `点“${FIX}”就改上面默认要改的问题；可以在输入框补充要求（也会一起改）。要逐个挑选，在网页上的“概览”里选。`
    : "改动在独立的工作区里，应用后成为仓库里未提交的修改。";
  return createAsk(app, {
    runId: run.id,
    ...(chain ? { conversationId: chain.conversationId } : {}),
    question: `**${d.title}**\n\n${d.digest}\n\n${hint}`,
    options: labels.map((label) => ({ label })),
    context: { handler: "review-done", codeRunId: run.id, labels },
  });
}

async function onDoneAnswer(app: App, ask: Ask, ctx: { codeRunId: string; labels: string[] }) {
  const run = getRun(app, ctx.codeRunId);
  const picked = ask.choice !== null ? ctx.labels[ask.choice] : null;
  const extra = (picked ? (ask.answer ?? "").slice(picked.length + 1) : ask.answer ?? "").trim();
  try {
    if (picked === FIX || (!picked && extra)) {
      const { startFix } = await import("./review-fix.ts");
      await startFix(app, run.id, { findingIds: fixCandidates(app, run.id, roundOf(run)).map((f) => f.id), text: extra || undefined }, ask.userId);
    } else if (picked === APPLY) {
      const { applyCodeRun } = await import("./code.ts");
      applyCodeRun(app, run.id);
      notify(app, { userId: ask.userId, title: `已应用到仓库：${run.title}`, body: "改动成为仓库工作区里未提交的修改，请在仓库里检查后提交。", link: `#/runs/${run.id}` });
    } else if (picked === DISCARD) {
      const { discardCodeRun } = await import("./code.ts");
      discardCodeRun(app, run.id);
    }
  } catch (e) {
    notify(app, { userId: ask.userId, title: `没能${picked ?? FIX}：${run.title}`, body: (e as Error).message, link: `#/runs/${run.id}` });
  }
}

function escalate(app: App, run: Run, chain: CodeChain, lead: LeadResult, digest = "") {
  const options = [
    ...(lead.changeRequest ? [{ label: "按修改单再改一轮" }] : []),
    ...(lead.escalation?.options ?? []).slice(0, 3).map((o) => ({ label: o })),
    { label: "接受现在的改动" },
    { label: "先停下，我来调整" },
  ];
  return createAsk(app, {
    runId: run.id,
    conversationId: chain.conversationId,
    question: [
      `「${truncate(run.title, 40)}」第 ${lead.round} 轮评审后停了下来：${STOP_LABEL[lead.stop!]}。`,
      lead.escalation?.summary ?? lead.summary,
      digest,
      "怎么继续？也可以直接回复新的要求，会作为下一轮的任务。",
    ].filter(Boolean).join("\n\n"),
    options: options.slice(0, 6),
    context: { handler: "review-escalation", codeRunId: run.id, labels: options.map((o) => o.label) },
  });
}

async function onPlanAnswer(app: App, ask: Ask, ctx: { codeRunId: string; tiers: string[] }) {
  const run = getRun(app, ctx.codeRunId);
  const chain = chainOf(app, run);
  const tier = ask.choice !== null ? ctx.tiers[ask.choice] : undefined;
  if (tier && tier !== (run.output as Out).reviewPlan?.tier) {
    const { planReview } = await import("./review.ts");
    const prev = (run.output as Out).reviewPlan!;
    const plan = planReview(app, prev.metrics, { tier });
    setRunOutput(app, run.id, { reviewPlan: { ...plan, reasons: [...plan.reasons, "本人确认计划时改了档位"] } });
  }
  if (chain) setChainAwaitingUser(app, chain, false);
  setRunOutput(app, run.id, { verdict: null, reviewStage: "queued" });
  createRun(app, { kind: "review", spaceId: run.spaceId, title: `评审：${truncate(run.title, 60)}`, input: { codeRunId: run.id, note: ask.choice === null ? ask.answer ?? undefined : undefined }, parentId: run.id });
}

async function onEscalationAnswer(app: App, ask: Ask, ctx: { codeRunId: string; labels: string[] }) {
  const run = getRun(app, ctx.codeRunId);
  const chain = chainOf(app, run);
  const lead = (run.output as { reviewLead?: LeadResult }).reviewLead;
  const picked = ask.choice !== null ? ctx.labels[ask.choice] : null;
  if (!chain) return;
  if (picked === "接受现在的改动") {
    setRunOutput(app, run.id, { verdict: "approved", acceptedByOwner: true, reviewStop: null });
    saveCodeChain(app, { ...chain, awaitingUser: false, waitReason: undefined }, chain.askRunId, ...chain.rounds);
    return;
  }
  if (picked === "先停下，我来调整") return;
  // Another round: the lead's change request, the option the owner picked, or the owner's own words.
  const task = picked === "按修改单再改一轮" || picked === null && !ask.answer
    ? `评审要求修改（第 ${lead?.round ?? 1} 轮评审，本人确认继续）：\n\n${lead?.changeRequest ?? ""}`
    : `本人决定：${ask.answer ?? picked}\n\n${lead?.changeRequest ? `评审负责人的修改单（按本人的决定取舍）：\n\n${lead.changeRequest}` : ""}`;
  queueNextCodeRound(app, chain, task, { manual: true, resumeSessionId: (run.output as Out).coderSessionId });
}

registerAskHandler("review-plan", (app, ask, ctx) => onPlanAnswer(app, ask, ctx as { codeRunId: string; tiers: string[] }));
registerAskHandler("review-retry", (app, ask, ctx) => onRetryAnswer(app, ask, ctx as { codeRunId: string }));
registerAskHandler("review-done", (app, ask, ctx) => onDoneAnswer(app, ask, ctx as { codeRunId: string; labels: string[] }));
registerAskHandler("review-escalation",(app, ask, ctx) => onEscalationAnswer(app, ask, ctx as { codeRunId: string; labels: string[] }));

// A confirmed plan reviews in a run of its own; the coding run it reviews keeps the results.
registerHandler("review", async (ctx) => {
  const { codeRunId, note, splitOnly, revise } = ctx.run.input as { codeRunId: string; note?: string; splitOnly?: boolean; revise?: boolean };
  if (splitOnly) {
    await splitChangePoints(ctx.app, codeRunId, { runId: ctx.run.id, signal: ctx.signal, event: ctx.event }, { note, revise });
    return { changePoints: true };
  }
  return reviewRound(ctx.app, codeRunId, { runId: ctx.run.id, signal: ctx.signal, event: ctx.event }, { note });
});
