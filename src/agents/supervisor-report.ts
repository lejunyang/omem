import type { SupervisorReport as Report } from "./supervisor-schema.ts";
import type { App } from "../core/app.ts";
import { one, withinTx } from "../core/db.ts";
import { deliveryPlan, notify } from "../core/notify.ts";
import { HttpError, now, truncate } from "../core/util.ts";
import { cancelAsk, createAsk, registerAskHandler } from "./asks.ts";
import { confirmLongTaskBrief, changeLongTask, getLongTask, saveLongTaskReport, type LongTask } from "./long-tasks.ts";
import { addRunEvent, getRun } from "./runs.ts";
import { patchSupervisorState, scheduleSupervisorTimer, supervisorFacts, supervisorUsage, supervisorState } from "./supervisor.ts";
import { getThread } from "./threads.ts";
import type { UiField } from "./ui-blocks.ts";

const labels: Record<Report["status"], string> = { "on-track": "按计划推进", drifting: "正在纠偏", stuck: "遇到阻塞", "needs-owner": "等你决定", done: "已完成" };

export function supervisorProgressText(app: App, task: LongTask, report: Report) {
  const facts = supervisorFacts(app, task);
  const hours = Math.max(0, Date.now() - Date.parse(task.createdAt)) / 3600_000;
  const usage = supervisorUsage(app, task);
  const section = (name: string, entries: string[]) => entries.length ? `**${name}**\n${entries.map(text => "- " + text).join("\n")}` : "";
  const status = task.status === "paused" ? "已暂停" : task.status === "ended" ? "已结束" : labels[report.status];
  return [task.goal, `${report.stage} · ${status}`,
    `修改项 ${facts.done}/${facts.total} · 工作轮次 ${facts.rounds}/${task.budget.codeRounds} · 用时 ${hours.toFixed(1)}/${task.budget.hours} 小时`,
    usage.length ? "已上报用量：" + usage.map(row => row.kind + " " + row.tokens + " tokens").join(" · ") : "用量待后端上报",
    section("已完成", report.progress.done), section("在做", report.progress.doing), section("下一步", report.progress.next),
    section("目标核对", report.goalCheck), section("决定与依据", report.decisions.map(d => d.what + "：" + d.why)),
    section("纠偏", report.actions), section("要你定", report.askOwner.map(q => q.question + "（倾向：" + q.prefer + "）")),
  ].filter(Boolean).join("\n\n");
}

async function updateCard(app: App, task: LongTask, body: string) {
  const thread = getThread(app, task.threadId);
  if (!thread.channel.startsWith("lark") || !thread.key?.includes("#") || !thread.settings.lastMessageId) return;
  const { botOfChannel, withBot } = await import("../core/bot-context.ts");
  const { buildCard, sendLark, updateLarkCard, recordInteraction } = await import("../channels/lark-send.ts");
  const controls = ["ended", "done"].includes(task.status) ? [] : [{ buttons: [
    { text: task.status === "paused" ? "继续" : "暂停", value: task.status === "paused" ? "继续" : "暂停" },
    { text: "加 3 小时", value: "加 3 小时" }, { text: "换监工", value: "换监工" }, { text: "结束", value: "结束", confirm: "确认结束这件长任务？" },
  ] }];
  const card = buildCard({ title: "长任务进度", color: "wathet", blocks: [{ markdown: body }, ...controls] });
  await withBot(botOfChannel(thread.channel), async () => {
    const saved = supervisorState(app, task.id).cardId;
    if (saved) return updateLarkCard(saved, card);
    const sent = await sendLark({ replyTo: thread.settings.lastMessageId!, inThread: true, purpose: "progress", conversationId: thread.id }, { card });
    recordInteraction(app, { messageId: sent.messageId, chatId: thread.key?.split("#")[0] ?? null, conversationId: thread.id, runId: null,
      purpose: "supervisor", allowed: [], payload: { longTaskId: task.id } });
    patchSupervisorState(app, task.id, { cardId: sent.messageId });
  });
}

export async function refreshSupervisorCard(app: App, task: LongTask) {
  const last = supervisorState(app, task.id).lastReport;
  if (!last) return;
  const report = getRun(app, last).output.supervisorReport as Report;
  if (report) await updateCard(app, task, supervisorProgressText(app, task, report));
}

export function flushSupervisorPush(app: App, task: LongTask) {
  const state = supervisorState(app, task.id);
  if (!state.pendingPush) return;
  const plan = deliveryPlan(app, { outlet: "lark" });
  if (plan.when === "later" && plan.at) return scheduleSupervisorTimer(app, task, "push", plan.at);
  const highlights = state.pendingHighlights?.length ? "\n\n**免打扰期间的进展**\n" + state.pendingHighlights.map(entry => "- " + entry).join("\n") : "";
  notify(app, { graceDone: true, userId: task.userId, entity: "item", entityId: task.itemId, title: "长任务进展", body: state.pendingPush + highlights, link: `#/items/${task.itemId}` });
  patchSupervisorState(app, task.id, { lastPush: now(), pendingPush: null, pendingHighlights: null });
}

export function sendSupervisorSummary(app: App, task: LongTask) {
  const state = supervisorState(app, task.id);
  const hours = task.notifications.summaryHours;
  if (!hours || !state.lastReport || task.status !== "active") return;
  const report = getRun(app, state.lastReport).output.supervisorReport as Report;
  patchSupervisorState(app, task.id, { pendingPush: supervisorProgressText(app, task, report) });
  flushSupervisorPush(app, task);
  scheduleSupervisorTimer(app, task, "summary", new Date(Date.now() + hours * 3600_000).toISOString());
}

function offerOwnerQuestions(app: App, task: LongTask, runId: string, qs: Report["askOwner"]) {
  createAsk(app, { runId, userId: task.userId, conversationId: task.threadId,
    question: `「${truncate(task.goal, 80)}」有 ${qs.length} 个问题要你定。`,
    allowText: false, ui: { submitLabel: "确认选择", fields: qs.map((q, i) => ({ id: `q${i}`, type: "choice", label: q.question,
      options: q.options, default: q.prefer, required: true, help: `监工建议选「${q.prefer}」。${q.why}` })) },
    context: { handler: "supervisor-questions", longTaskId: task.id, questions: qs, larkApprover: task.userId },
  });
}

registerAskHandler("supervisor-questions", async (app, ask, context) => {
  const task = getLongTask(app, String(context.longTaskId));
  if (["ended","done"].includes(task.status)) throw new HttpError(409, "这件长任务已结束");
  const qs = context.questions as Report["askOwner"];
  const { answerWorkerQuestion } = await import("./supervisor-code.ts");
  const choices: string[] = [];
  for (const [i,q] of qs.entries()) {
    const picked = ask.value?.[`q${i}`];
    if (typeof picked !== "string" || !q.options.includes(picked)) throw new HttpError(400, "请在卡片上逐项选择");
    if (q.questionId) await answerWorkerQuestion(app, task.id, q.questionId, picked);
    choices.push(q.question + "：" + picked);
  }
  await changeLongTask(app, task.id, { action: "supplement", text: choices.join("\n") });
});

export async function submitSupervisorReport(app: App, runId: string, report: Report) {
  const round = getRun(app, runId);
  if (round.kind !== "supervise" || round.status !== "running") throw new HttpError(403, "只有正在推进这一轮的监工能交报告");
  const task = getLongTask(app, String(round.input.longTaskId));
  if (round.output.supervisorReport) throw new HttpError(409, "本轮已经交过报告");
  if (["paused","ended","done"].includes(task.status)) throw new HttpError(409, "本人已暂停或结束长任务");
  if (task.status === "draft" && !report.brief) throw new HttpError(400, "起草轮请在 brief 中交任务书，待本人确认");
  if (task.status === "draft" && report.askOwner.length)
    throw new HttpError(400, "起草轮由宿主发一张任务书确认卡。把需要本人调整的条目写入 brief，askOwner 留空。");
  if (task.status !== "draft" && report.brief?.constraints) throw new HttpError(400, "约束仅由本人修改");
  const { answerWorkerQuestion, checkSupervisorBasis } = await import("./supervisor-code.ts");
  for (const a of report.answers ?? []) {
    checkSupervisorBasis(app, runId, runId, a.basis);
    await answerWorkerQuestion(app, task.id, a.questionId, a.answer);
  }
  const prior = supervisorState(app, task.id);
  const text = supervisorProgressText(app, task, report);
  withinTx(app.db, () => {
    if (report.status === "done") {
      const facts = supervisorFacts(app, task);
      const pending = one(app.db, "select 1 from asks where conversation_id=? and status='pending' and json_extract(context,'$.handler') in ('supervisor-questions','supervisor-brief') limit 1", task.threadId);
      if (report.askOwner.length || report.brief || facts.active || facts.openItems || facts.pendingQuestions || pending)
        throw new HttpError(409, "仍有运行、修改项、任务书提案或问题待处理");
    }
    saveLongTaskReport(app, task.id, runId, report, text);
    patchSupervisorState(app, task.id, { lastReport: runId, stage: report.stage });
    if (report.brief) proposeBrief(app, task, runId, report.brief);
    if (report.askOwner.length) offerOwnerQuestions(app, task, runId, report.askOwner);
  });
  const next = getLongTask(app, task.id);
  await updateCard(app, next, text).catch(error => addRunEvent(app, runId, "warning", { message: `更新长任务飞书进度卡失败：${String(error)}` }));
  const prefs = task.notifications;
  if (prefs.summaryHours && next.status === "active") scheduleSupervisorTimer(app, next, "summary", new Date(Date.now() + prefs.summaryHours * 3600_000).toISOString());
  if ((prefs.milestones && (prior.stage !== report.stage || report.status === "done")) ||
    (prefs.owner && report.askOwner.length) || (prefs.corrections && report.actions.length)) {
    const highlights = deliveryPlan(app, { outlet: "lark" }).when === "later" ?
      [...new Set([...(supervisorState(app, task.id).pendingHighlights ?? []), `${report.stage} · ${labels[report.status]}`,
        ...report.actions, ...report.askOwner.map(q => q.question)])] : undefined;
    patchSupervisorState(app, task.id, { pendingPush: text, pendingHighlights: highlights });
    flushSupervisorPush(app, task);
  }
  if (next.status === "active") scheduleSupervisorTimer(app, next, "check", new Date(Date.now() + app.config.longTasks.checkMinutes * 60_000).toISOString());
  return text;
}

type Proposal = NonNullable<Report["brief"]>;
const briefLabels = { doneWhen: "怎么算完成", outOfScope: "不做的", scope: "范围（每行一个目录或文件）", constraints: "约束" } as const;

function proposeBrief(app: App, task: LongTask, runId: string, proposed: Proposal) {
  const entries = Object.entries(proposed) as [keyof Proposal, string[]][];
  const prior = supervisorState(app, task.id).briefAsk;
  if (prior) cancelAsk(app, prior, "监工已提交新版任务书");
  const fields: UiField[] = entries.map(([key, values]) => ({
    type: "textarea", id: key, label: briefLabels[key], default: values.join("\n"), required: key === "doneWhen",
  }));
  if (task.status === "draft") {
    fields.push({ type: "textarea", id: "mustAsk", label: "必须问本人的事", default: task.brief.mustAsk.join("\n"), required: true });
    if (!proposed.constraints) fields.push({ type: "textarea", id: "constraints", label: "约束", default: task.brief.constraints.join("\n"), required: false });
    fields.push({ type: "number", id: "hours", label: "总时长（小时）", required: true, min: 0.01, default: task.budget.hours },
      { type: "number", id: "codeRounds", label: "工作轮数", required: true, min: 1, default: task.budget.codeRounds },
      { type: "number", id: "dailyWakes", label: "监工每天最多被叫醒几次", required: true, min: 1, default: task.budget.dailyWakes });
  }
  const ask = createAsk(app, { runId, conversationId: task.threadId, userId: task.userId, allowText: false,
    question: `请确认「${task.goal}」的任务书。可以直接修改下面各项。`,
    ui: { submitLabel: "确认任务书", fields },
    context: { handler: "supervisor-brief", longTaskId: task.id, larkApprover: task.userId, proposed },
  });
  patchSupervisorState(app, task.id, { briefAsk: ask.id });
}

registerAskHandler("supervisor-brief", async (app, ask, context) => {
  const task = getLongTask(app, String(context.longTaskId));
  if (supervisorState(app, task.id).briefAsk !== ask.id) throw new HttpError(409, "请使用最新任务书确认卡");
  const proposed = context.proposed as Proposal;
  const changes = Object.fromEntries(Object.keys(proposed).map(key =>
    [key, String(ask.value?.[key] ?? "").split("\n").map(s => s.trim()).filter(Boolean)]));
  withinTx(app.db, () => {
    if (task.status === "draft") {
      const budget = { hours: Number(ask.value?.hours), codeRounds: Number(ask.value?.codeRounds), dailyWakes: Number(ask.value?.dailyWakes) };
      if (budget.hours !== task.budget.hours || budget.codeRounds !== task.budget.codeRounds || budget.dailyWakes !== task.budget.dailyWakes)
        changeLongTask(app, task.id, { action: "budget", budget });
      for (const key of ["constraints", "mustAsk"]) changes[key] = String(ask.value?.[key] ?? "").split("\n").map(s => s.trim()).filter(Boolean);
    }
    confirmLongTaskBrief(app, task.id, changes);
    patchSupervisorState(app, task.id, { briefAsk: null });
  });
});


registerAskHandler("supervisor-ai", async (app, ask, context) => {
  const task = getLongTask(app, String(context.longTaskId));
  const values = ask.value ?? {};
  const profile = String(values.profile ?? "").trim();
  await changeLongTask(app, task.id, { action: "ai", ai: { profile,
    model: String(values.model ?? "").trim() || undefined, effort: String(values.effort ?? "").trim() || undefined } });
});
